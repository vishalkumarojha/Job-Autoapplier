/**
 * GET /api/resumes — authenticated Resume Library listing.
 *
 * Flow:
 *
 *     Request -> verify Firebase ID token -> read cache -> validate schema
 *             -> project public ResumeSummary fields -> JSON
 *
 * Unlike the legacy `/api/rpc`, this endpoint authenticates its caller. `/api/rpc` checks a
 * server-side secret that it forwards to Apps Script and accepts any anonymous caller; that
 * pattern must not be copied here, because this route returns the user's resume catalog.
 *
 * This module contains no Google or Firebase credentials and holds no module-level state,
 * which is what lets the tests drive it end to end with fakes.
 */

import { authenticate, UnauthenticatedError } from '../lib/auth.js';
import { ConfigError, resumeLibraryConfig } from '../lib/config.js';
import {
  RESUME_SUMMARY_SCHEMA_VERSION,
  parseCacheRows,
  projectPublicResumes,
  splitHeaderAndRows,
} from '../lib/resume-cache.js';
import { fetchResumeRows } from '../lib/google.js';

/**
 * An error with an intended HTTP status.
 *
 * `publicMessage` is what reaches the client. `detail` stays server-side for logging. Google
 * and Firebase error objects routinely embed request URLs, key hints, and occasionally
 * token fragments, so their messages are never forwarded verbatim.
 */
class HttpError extends Error {
  constructor(status, publicMessage, detail) {
    super(detail ? `${publicMessage} (${detail})` : publicMessage);
    this.name = 'HttpError';
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

function methodNotAllowed(res, method) {
  res.setHeader('Allow', 'GET');
  res.status(405).json({ error: `Method ${method} is not allowed. Use GET.` });
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
 * Assembles the handler.
 *
 * Dependencies are injected so tests can supply a token verifier, a row source, and a config
 * without Firebase or Google credentials. Production passes none of them and gets the real
 * implementations.
 *
 * `loadConfig` is overridable separately from `config` so a test can exercise the
 * *unconfigured* path without depending on whether the developer's own environment happens to
 * have the variables set. Asserting on ambient `process.env` makes a test pass on CI and fail
 * on a laptop, which is worse than having no test.
 */
export function createHandler(overrides = {}) {
  return async function handler(req, res) {
    if (!req || req.method !== 'GET') return methodNotAllowed(res, (req && req.method) || 'unknown');

    // 1. Authenticate. The uid comes from the verified token; any caller-supplied uid in the
    //    query string or body is ignored.
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
        return res.status(404).json({ error: 'The resume service is not configured on the server.' });
      }
      return res.status(500).json({ error: 'Could not verify credentials.' });
    }

    // 2. Read the cache.
    let rows;
    try {
      const loadConfig = overrides.loadConfig ?? resumeLibraryConfig;
      const config = overrides.config ?? loadConfig();
      const values = await fetchResumeRows(config, { sheets: overrides.sheets });
      rows = splitHeaderAndRows(values).rows;
    } catch (error) {
      if (error instanceof ConfigError) {
        return res.status(404).json({ error: 'The resume service is not configured on the server.' });
      }
      // The upstream message is logged, never returned: it can carry the spreadsheet id,
      // permission details, or other provider internals the caller has no business seeing.
      console.error('[resumes] failed to read the cache', error);
      return res.status(500).json({ error: 'The resume library is temporarily unavailable.' });
    }

    // 3. Parse and project. Unusable rows are skipped and counted, never guessed at.
    const { records, skipped } = parseCacheRows(rows);

    return res.status(200).json({
      schemaVersion: RESUME_SUMMARY_SCHEMA_VERSION,
      resumes: projectPublicResumes(records),
      skipped,
    });
  };
}

const handler = createHandler();

export { fakeResponse, HttpError };
export default handler;
