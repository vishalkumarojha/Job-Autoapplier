/**
 * POST /api/suggestions — authenticated resume improvement suggestions.
 *
 * Flow:
 *
 *     Request -> verify Firebase ID token -> validate body -> load config
 *             -> load the caller's Job from Firestore -> confirm it is a canonical Job
 *             -> require an existing match (selected resume + breakdown)
 *             -> read the selected resume out of the Resume Library server-side
 *             -> call Claude -> validate the suggestions against the two source texts
 *             -> persist `resumeSuggestions` -> JSON
 *
 * This is Phase 6. It never re-matches, never edits a resume, and never touches the match
 * fields: it produces advice about *one already-chosen* resume for *one already-confirmed*
 * job. The preconditions are enforced as 409s rather than repaired — a Job with no
 * selected resume has no subject to give advice about, and quietly re-running the match
 * here would answer a different question than the one that was asked.
 *
 * Authentication happens before the body is read and before any configuration is loaded,
 * so an anonymous probe learns neither what the endpoint accepts nor which variables are
 * set. The uid comes only from the verified token; a `uid`, `resumeId`, or resume text in
 * the body is ignored, so a Job outside `users/{verifiedUid}/jobs/{jobId}` is not
 * reachable and the caller cannot supply the material being judged.
 *
 * What comes back is titles, advice, and short evidence sentences. The full resume text,
 * the Drive file ids and names behind the Resume Library, the prompt, and the model's own
 * text are all server-side and stay there.
 *
 * Two failure vocabularies are kept apart on purpose:
 *   - 400/409 describe the caller's own request or the state of their own data, and are
 *     safe to show verbatim.
 *   - 500s are fixed strings. Neither Claude's output nor a Google or Firebase error
 *     message is ever forwarded — model output quotes resume bodies, and provider errors
 *     carry project ids, document paths, and request URLs.
 *
 * This module contains no credentials and holds no module-level state, which is what lets
 * the tests drive it end to end with fakes.
 */

import { authenticate, UnauthenticatedError } from '../lib/auth.js';
import { ConfigError, matchConfig } from '../lib/config.js';
import { fetchResumeRows } from '../lib/google.js';
import { loadJobDocument, writeSuggestionFields, isMatchableJobDocument } from '../lib/jobs.js';
import { ProviderError } from '../lib/claude.js';
import { parseCacheRows, splitHeaderAndRows } from '../lib/resume-cache.js';
import {
  SuggestionRequestError,
  SuggestionValidationError,
  extractJobSuggestions,
  findSelectedRecord,
  normalizeSuggestionResult,
  parseSuggestionRequest,
} from '../lib/suggestions.js';

const AUTH_ERROR = 'Authentication required.';
const NOT_CONFIGURED = 'Resume suggestions are not configured on the server.';
const JOB_NOT_FOUND = 'Job not found.';
const JOB_NOT_CONFIRMED = 'This job must be confirmed before suggestions can be generated.';
const NO_SELECTED_RESUME = 'This job has no selected resume. Run a match first.';
const NO_BREAKDOWN = 'This job has no match breakdown. Run a match first.';
const RESUME_UNAVAILABLE = 'The selected resume is no longer available in the resume library.';
const JOB_LOAD_ERROR = 'Unable to load this job.';
const JOB_SAVE_ERROR = 'Unable to save the resume suggestions.';
const LIBRARY_ERROR = 'The resume library is temporarily unavailable.';
const SUGGESTIONS_FAILED = 'Unable to generate resume suggestions.';

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
 * arrives as text (wrong content type) must be parsed here — and a body that is not valid
 * JSON is a 400 about the caller's request, not a 500 about the server.
 */
function readBody(raw) {
  if (raw === undefined || raw === null || raw === '') {
    throw new SuggestionRequestError('A JSON request body is required.');
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new SuggestionRequestError('The request body was not valid JSON.');
    }
  }
  return raw;
}

/**
 * Assembles the handler.
 *
 * Dependencies are injected so tests can supply a token verifier, a Job document, a
 * Resume Library, a model response, and a configuration without Firebase, Google, or
 * Anthropic credentials. Production passes none of them and gets the real implementations.
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

    // 1. Authenticate. The uid comes from the verified token and is used nowhere else.
    let uid;
    try {
      const decoded = await authenticate(req, {
        verifyIdToken: overrides.verifyIdToken,
        config: overrides.config,
      });
      uid = decoded.uid;
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        return res.status(401).json({ error: AUTH_ERROR });
      }
      if (error instanceof ConfigError) {
        return res.status(404).json({ error: NOT_CONFIGURED });
      }
      log.error('[suggestions] token verification failed', error);
      return res.status(500).json({ error: 'Could not verify credentials.' });
    }

    // 2. Validate the caller's input. Only `jobId` is read; everything else in the body
    //    is ignored, which is what stops a caller from supplying suggestion inputs.
    let input;
    try {
      input = parseSuggestionRequest(readBody(req.body));
    } catch (error) {
      if (error instanceof SuggestionRequestError) {
        return res.status(400).json({ error: error.reason });
      }
      log.error('[suggestions] unexpected request failure', error);
      return res.status(500).json({ error: 'Unable to process the request.' });
    }

    // 3. Configuration, read after authentication so an anonymous probe cannot enumerate it.
    let config;
    try {
      const loadConfig = overrides.loadConfig ?? matchConfig;
      config = overrides.config ?? loadConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        log.error('[suggestions] configuration is incomplete', error.message);
        return res.status(404).json({ error: NOT_CONFIGURED });
      }
      log.error('[suggestions] configuration failed', error);
      return res.status(500).json({ error: SUGGESTIONS_FAILED });
    }

    // Same rule for an injected configuration that is present but incomplete: a missing
    // variable is a deployment problem (404), not a provider failure (500).
    if (!config || !config.anthropicApiKey || !config.resumeSheetId) {
      log.error('[suggestions] configuration is incomplete', !config || !config.anthropicApiKey ? 'ANTHROPIC_API_KEY' : 'GOOGLE_RESUME_SHEET_ID');
      return res.status(404).json({ error: NOT_CONFIGURED });
    }

    // 4. Load the Job under the verified uid's own path. A missing document and somebody
    //    else's document both arrive as null and get the same answer, so a caller cannot
    //    probe for ids outside their own collection.
    let document;
    try {
      document = await loadJobDocument(uid, input.jobId, {
        db: overrides.db,
        config,
      });
    } catch (error) {
      log.error('[suggestions] failed to load the job', error);
      return res.status(500).json({ error: JOB_LOAD_ERROR });
    }

    if (!isMatchableJobDocument(document)) {
      return res.status(404).json({ error: JOB_NOT_FOUND });
    }

    // 5. Preconditions. Suggestions are derived from an existing match, so all three are
    //    required and none is repaired here: falling back to an earlier resume, or
    //    re-running the match on the side, would produce advice the user never asked for.
    if (document.intakeStatus !== 'confirmed') {
      return res.status(409).json({ error: JOB_NOT_CONFIRMED });
    }
    if (typeof document.selectedResumeId !== 'string' || !document.selectedResumeId.trim()) {
      return res.status(409).json({ error: NO_SELECTED_RESUME });
    }
    if (!Array.isArray(document.matchBreakdown) || document.matchBreakdown.length === 0) {
      return res.status(409).json({ error: NO_BREAKDOWN });
    }

    // 6. Read the Resume Library server-side. The rows carry `extractedText`, which never
    //    leaves this function — only the one matching row is used, and only its text is
    //    sent to the model.
    let records;
    try {
      const values = await fetchResumeRows(config, { sheets: overrides.sheets });
      records = parseCacheRows(splitHeaderAndRows(values).rows).records;
    } catch (error) {
      if (error instanceof ConfigError) {
        log.error('[suggestions] configuration is incomplete', error.message);
        return res.status(404).json({ error: NOT_CONFIGURED });
      }
      log.error('[suggestions] failed to read the resume library', error);
      return res.status(500).json({ error: LIBRARY_ERROR });
    }

    const resume = findSelectedRecord(records, document.selectedResumeId);
    if (!resume) {
      // The resume was deleted or emptied after the match ran. 409, not 404: the Job is
      // fine, the pairing is what no longer holds, and re-selecting is a human decision.
      return res.status(409).json({ error: RESUME_UNAVAILABLE });
    }

    const jobText = [document.company, document.role, document.location, document.notes, document.rawText]
      .filter((value) => typeof value === 'string' && value.trim())
      .join('\n');

    // 7. Provider call. `ProviderError` is already sanitized: the SDK's own message was
    //    logged inside `extractJobSuggestions` and discarded.
    let candidate;
    try {
      candidate = await extractJobSuggestions(
        { job: document, resume, matchBreakdown: document.matchBreakdown },
        {
          complete: overrides.complete,
          config,
          logger: log,
        },
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        log.error('[suggestions] extraction failed', error.message);
        return res.status(500).json({ error: SUGGESTIONS_FAILED });
      }
      log.error('[suggestions] unexpected provider failure', error);
      return res.status(500).json({ error: SUGGESTIONS_FAILED });
    }

    // 8. Validate every field back against the two texts it cites. A schema break or a
    //    fabrication guard trip is a server-side failure: the model's text quotes resume
    //    bodies, so it is logged by rule name and never returned.
    let result;
    try {
      result = normalizeSuggestionResult(candidate, {
        jobText,
        resumeText: resume.extractedText,
      });
    } catch (error) {
      if (error instanceof SuggestionValidationError) {
        log.error('[suggestions] invalid suggestion result', error.reason);
        return res.status(500).json({ error: SUGGESTIONS_FAILED });
      }
      log.error('[suggestions] unexpected validation failure', error);
      return res.status(500).json({ error: SUGGESTIONS_FAILED });
    }

    // 9. Persist only what suggestions own. The patch is a single key, so `update` leaves
    //    company, role, matchScore, matchBreakdown, selectedResumeId, approvalStatus,
    //    draftMessage, and every other field byte-for-byte as it was.
    try {
      await writeSuggestionFields(uid, input.jobId, { resumeSuggestions: result }, {
        db: overrides.db,
        config,
      });
    } catch (error) {
      log.error('[suggestions] failed to persist the suggestions', error);
      return res.status(500).json({ error: JOB_SAVE_ERROR });
    }

    return res.status(200).json({
      schemaVersion: result.schemaVersion,
      jobId: input.jobId,
      suggestions: result.suggestions,
    });
  };
}

const handler = createHandler();

export { fakeResponse };
export default handler;
