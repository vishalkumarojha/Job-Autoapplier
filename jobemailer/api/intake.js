/**
 * POST /api/intake — authenticated Smart Intake extraction.
 *
 * Flow:
 *
 *     Request -> verify Firebase ID token -> validate body -> call Claude
 *             -> validate the model's JSON -> normalize -> project -> JSON
 *
 * Authentication happens before the body is even read, so an anonymous probe learns
 * nothing about what the endpoint accepts, and before any configuration is loaded, so an
 * anonymous probe cannot discover whether `ANTHROPIC_API_KEY` is set.
 *
 * The raw posting is *not* returned. The client already owns the text it sent, and echoing
 * it back would double the response size for no benefit. It is persisted by the mobile app
 * when the user confirms the job, from the copy the user still holds.
 *
 * Two failure vocabularies are kept apart on purpose:
 *   - 400s describe the caller's own input and are safe to show verbatim.
 *   - 500s are fixed strings. Neither Claude's output nor Anthropic's error message is
 *     ever forwarded — the model quotes the posting (which holds strangers' email
 *     addresses) and SDK errors can carry request URLs and account identifiers.
 *
 * This module contains no credentials and holds no module-level state, which is what lets
 * the tests drive it end to end with fakes.
 */

import { authenticate, UnauthenticatedError } from '../lib/auth.js';
import { ConfigError, intakeConfig } from '../lib/config.js';
import { ProviderError, extractJobPosting } from '../lib/claude.js';
import {
  INTAKE_SCHEMA_VERSION,
  InvalidExtractionError,
  RequestValidationError,
  normalizeExtraction,
  parseRequestBody,
} from '../lib/intake.js';

const PUBLIC_SERVER_ERROR = 'Unable to process job posting';

function methodNotAllowed(res, method) {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: `Method ${method} is not allowed. Use POST.` });
}

/** Minimal response double, so tests can assert on what was sent without a real server. */
function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

/**
 * Reads `req.body` into a parsed JSON value.
 *
 * Vercel parses a JSON body into an object before the handler runs, but a request that
 * arrives as text (wrong content type, or a raw paste) must be parsed here — and a body
 * that is not valid JSON is a 400 about the caller's request, not a 500 about the server.
 *
 * @returns {unknown}
 * @throws {RequestValidationError}
 */
export function readJsonBody(raw) {
  if (raw === undefined || raw === null || raw === '') {
    throw new RequestValidationError('A JSON request body is required.');
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new RequestValidationError('The request body was not valid JSON.');
    }
  }
  return raw;
}

/**
 * Assembles the handler.
 *
 * Dependencies are injected so tests can supply a token verifier, a model response, and a
 * configuration without Firebase or Anthropic credentials. Production passes none of them
 * and gets the real implementations.
 *
 * `loadConfig` is overridable separately from `config` so a test can exercise the
 * *unconfigured* path without depending on whether this machine happens to have
 * `ANTHROPIC_API_KEY` set.
 */
export function createHandler(overrides = {}) {
  const log = overrides.logger ?? {
    error: (...args) => console.error(...args),
  };

  return async function handler(req, res) {
    if (!req || req.method !== 'POST') {
      return methodNotAllowed(res, (req && req.method) || 'unknown');
    }

    // 1. Authenticate. The uid comes from the verified token; a caller-supplied uid in the
    //    query string or body is ignored, and nothing else is read until this succeeds.
    try {
      await authenticate(req, {
        verifyIdToken: overrides.verifyIdToken,
        config: overrides.config,
      });
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      if (error instanceof ConfigError) {
        return res.status(404).json({ error: 'Job intake is not configured on the server.' });
      }
      log.error('[intake] token verification failed', error);
      return res.status(500).json({ error: 'Could not verify credentials.' });
    }

    // 2. Validate the caller's input. Every message here describes only their own request.
    let input;
    try {
      input = parseRequestBody(readJsonBody(req.body));
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status(400).json({ error: error.reason });
      }
      log.error('[intake] unexpected request failure', error);
      return res.status(500).json({ error: 'Unable to process the request.' });
    }

    // 3. Configuration, read after authentication so an anonymous probe cannot enumerate it.
    let config;
    try {
      const loadConfig = overrides.loadConfig ?? intakeConfig;
      config = overrides.config ?? loadConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        // Which variable is missing stays server-side; the client is told only that the
        // feature is unavailable.
        log.error('[intake] configuration is incomplete', error.message);
        return res.status(404).json({ error: 'Job intake is not configured on the server.' });
      }
      log.error('[intake] configuration failed', error);
      return res.status(500).json({ error: 'Unable to process job posting' });
    }

    // Same rule for an injected configuration that is present but incomplete: a missing key
    // is a deployment problem (404), not a provider failure (500).
    if (!config || !config.anthropicApiKey) {
      log.error('[intake] configuration is incomplete', 'ANTHROPIC_API_KEY');
      return res.status(404).json({ error: 'Job intake is not configured on the server.' });
    }

    // 4. Provider call. ProviderError is already sanitized: the SDK's own message was
    //    logged inside `extractJobPosting` and discarded.
    let candidate;
    try {
      candidate = await extractJobPosting(input, {
        complete: overrides.complete,
        config,
        logger: log,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        log.error('[intake] extraction failed', error.message);
        return res.status(500).json({ error: PUBLIC_SERVER_ERROR });
      }
      log.error('[intake] unexpected provider failure', error);
      return res.status(500).json({ error: PUBLIC_SERVER_ERROR });
    }

    // 5. Validate what the model returned. A schema break is a server-side failure: the
    //    client is never shown the model's text, because it quotes the posting.
    let extraction;
    try {
      extraction = normalizeExtraction(candidate, input);
    } catch (error) {
      if (error instanceof InvalidExtractionError) {
        log.error('[intake] invalid extraction', error.reason);
        return res.status(500).json({ error: PUBLIC_SERVER_ERROR });
      }
      log.error('[intake] unexpected normalization failure', error);
      return res.status(500).json({ error: PUBLIC_SERVER_ERROR });
    }

    return res.status(200).json({ schemaVersion: INTAKE_SCHEMA_VERSION, ...extraction });
  };
}

const handler = createHandler();

export { fakeResponse };
export default handler;
