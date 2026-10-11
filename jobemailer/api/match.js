/**
 * POST /api/match — authenticated resume matching.
 *
 * Flow:
 *
 *     Request -> verify Firebase ID token -> validate body -> load config
 *             -> load the caller's Job from Firestore -> check it is a matchable canonical Job
 *             -> read the Resume Library server-side -> pre-filter candidates
 *             -> call Claude -> validate the model's JSON against the candidate set
 *             -> persist the match-owned fields -> JSON
 *
 * Authentication happens before the body is read and before any configuration is loaded,
 * so an anonymous probe learns neither what the endpoint accepts nor which variables are
 * set. The uid comes only from the verified token; a `uid` in the body or the query string
 * is ignored, so a Job outside `users/{verifiedUid}/jobs/{jobId}` is not reachable.
 *
 * What comes back is ids and scores only. The resume text that was compared, the Drive
 * file ids and names behind the Resume Library, the prompt, and the model's own text are
 * all server-side and stay there.
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
import { loadJobDocument, writeMatchFields, isMatchableJobDocument } from '../lib/jobs.js';
import { ProviderError } from '../lib/claude.js';
import { parseCacheRows, splitHeaderAndRows } from '../lib/resume-cache.js';
import {
  MATCH_SCHEMA_VERSION,
  MatchRequestError,
  MatchValidationError,
  extractJobMatch,
  normalizeMatchResult,
  parseMatchRequest,
  selectMatchCandidates,
} from '../lib/match.js';

const AUTH_ERROR = 'Authentication required.';
const NOT_CONFIGURED = 'Resume matching is not configured on the server.';
const JOB_NOT_FOUND = 'Job not found.';
const JOB_NOT_CONFIRMED = 'This job must be confirmed before it can be matched.';
const NO_RESUMES = 'There are no usable resumes to match against.';
const JOB_LOAD_ERROR = 'Unable to load this job.';
const JOB_SAVE_ERROR = 'Unable to save the resume match.';
const LIBRARY_ERROR = 'The resume library is temporarily unavailable.';
const MATCH_FAILED = 'Unable to compute a resume match.';

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
    throw new MatchRequestError('A JSON request body is required.');
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new MatchRequestError('The request body was not valid JSON.');
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
      log.error('[match] token verification failed', error);
      return res.status(500).json({ error: 'Could not verify credentials.' });
    }

    // 2. Validate the caller's input. Only `jobId` is read; everything else in the body
    //    is ignored, which is what stops a caller from supplying matching inputs.
    let input;
    try {
      input = parseMatchRequest(readBody(req.body));
    } catch (error) {
      if (error instanceof MatchRequestError) {
        return res.status(400).json({ error: error.reason });
      }
      log.error('[match] unexpected request failure', error);
      return res.status(500).json({ error: 'Unable to process the request.' });
    }

    // 3. Configuration, read after authentication so an anonymous probe cannot enumerate it.
    let config;
    try {
      const loadConfig = overrides.loadConfig ?? matchConfig;
      config = overrides.config ?? loadConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        log.error('[match] configuration is incomplete', error.message);
        return res.status(404).json({ error: NOT_CONFIGURED });
      }
      log.error('[match] configuration failed', error);
      return res.status(500).json({ error: MATCH_FAILED });
    }

    // Same rule for an injected configuration that is present but incomplete: a missing
    // variable is a deployment problem (404), not a provider failure (500).
    if (!config || !config.anthropicApiKey || !config.resumeSheetId) {
      log.error('[match] configuration is incomplete', !config || !config.anthropicApiKey ? 'ANTHROPIC_API_KEY' : 'GOOGLE_RESUME_SHEET_ID');
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
      log.error('[match] failed to load the job', error);
      return res.status(500).json({ error: JOB_LOAD_ERROR });
    }

    if (!isMatchableJobDocument(document)) {
      return res.status(404).json({ error: JOB_NOT_FOUND });
    }

    // Matching runs against a confirmed job: an unreviewed extraction would score a
    // posting the human has not accepted as the job's real shape.
    if (document.intakeStatus !== 'confirmed') {
      return res.status(409).json({ error: JOB_NOT_CONFIRMED });
    }

    // 5. Read the Resume Library server-side. The rows carry `extractedText`, which never
    //    leaves this function.
    let records;
    try {
      const values = await fetchResumeRows(config, { sheets: overrides.sheets });
      records = parseCacheRows(splitHeaderAndRows(values).rows).records;
    } catch (error) {
      if (error instanceof ConfigError) {
        log.error('[match] configuration is incomplete', error.message);
        return res.status(404).json({ error: NOT_CONFIGURED });
      }
      log.error('[match] failed to read the resume library', error);
      return res.status(500).json({ error: LIBRARY_ERROR });
    }

    const jobText = [document.company, document.role, document.location, document.notes, document.rawText]
      .filter((value) => typeof value === 'string' && value.trim())
      .join('\n');

    const { candidates } = selectMatchCandidates(records, jobText);
    if (candidates.length === 0) {
      return res.status(409).json({ error: NO_RESUMES });
    }

    // 6. Provider call. `ProviderError` is already sanitized: the SDK's own message was
    //    logged inside `extractJobMatch` and discarded.
    let candidate;
    try {
      candidate = await extractJobMatch({ job: document, candidates }, {
        complete: overrides.complete,
        config,
        logger: log,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        log.error('[match] extraction failed', error.message);
        return res.status(500).json({ error: MATCH_FAILED });
      }
      log.error('[match] unexpected provider failure', error);
      return res.status(500).json({ error: MATCH_FAILED });
    }

    // 7. Validate against the candidate set the model was actually given. A schema break
    //    is a server-side failure: the model's text quotes resume bodies, so it is logged
    //    by rule name and never returned.
    let result;
    try {
      result = normalizeMatchResult(candidate, {
        jobId: input.jobId,
        candidateIds: candidates.map((record) => record.resumeId),
      });
    } catch (error) {
      if (error instanceof MatchValidationError) {
        log.error('[match] invalid match result', error.reason);
        return res.status(500).json({ error: MATCH_FAILED });
      }
      log.error('[match] unexpected validation failure', error);
      return res.status(500).json({ error: MATCH_FAILED });
    }

    // 8. Persist only what matching owns. `update` leaves every other field — company,
    //    role, dedupeKey, approvalStatus, draftMessage, resumeSuggestions, updatedAt —
    //    byte-for-byte as it was.
    try {
      await writeMatchFields(uid, input.jobId, {
        selectedResumeId: result.selectedResumeId,
        matchScore: result.matchScore,
        matchBreakdown: result.matchBreakdown,
      }, {
        db: overrides.db,
        config,
      });
    } catch (error) {
      log.error('[match] failed to persist the match', error);
      return res.status(500).json({ error: JOB_SAVE_ERROR });
    }

    return res.status(200).json({ ...result, schemaVersion: MATCH_SCHEMA_VERSION });
  };
}

const handler = createHandler();

export { fakeResponse };
export default handler;
