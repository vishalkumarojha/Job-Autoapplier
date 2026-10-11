/**
 * POST /api/draft — authenticated outreach draft generation.
 *
 * Flow:
 *
 *     Request -> verify Firebase ID token -> validate body -> load config
 *             -> load the caller's Job from Firestore -> confirm it is a canonical Job
 *             -> require a confirmed Job with a complete match (selected resume,
 *                breakdown, and score)
 *             -> read the selected resume out of the Resume Library server-side
 *             -> call Claude with the job, the match, the validated suggestions, and the
 *                resume
 *             -> validate the draft against the material that was actually sent
 *             -> persist the four draft-owned fields -> JSON
 *
 * This is Phase 7. It produces a draft and nothing else: it never sends mail, never calls
 * Gmail or Apps Script, never approves anything, never changes an application status, and
 * never touches the match, the suggestions, or the resume. The preconditions are enforced
 * as 409s rather than repaired — a Job with no match has no evidence to draft from, and
 * quietly re-running the match here would answer a different question than the one that was
 * asked.
 *
 * Authentication happens before the body is read and before any configuration is loaded,
 * so an anonymous probe learns neither what the endpoint accepts nor which variables are
 * set. The uid comes only from the verified token; a `uid`, `resumeId`, `draftSubject`, or
 * resume text in the body is ignored, so a Job outside `users/{verifiedUid}/jobs/{jobId}`
 * is not reachable and the caller cannot supply the words that get written.
 *
 * What comes back is a subject, a message, and a timestamp. The full resume text, the Drive
 * file ids and names behind the Resume Library, the match rationale, the prompt, and the
 * model's own text are all server-side and stay there.
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
import { loadJobDocument, writeDraftFields, isMatchableJobDocument } from '../lib/jobs.js';
import { ProviderError } from '../lib/claude.js';
import { findSelectedRecord } from '../lib/suggestions.js';
import { parseCacheRows, splitHeaderAndRows } from '../lib/resume-cache.js';
import {
  DraftRequestError,
  DraftValidationError,
  extractDraft,
  normalizeDraftResult,
  parseDraftRequest,
} from '../lib/draft.js';

const AUTH_ERROR = 'Authentication required.';
const NOT_CONFIGURED = 'Draft generation is not configured on the server.';
const JOB_NOT_FOUND = 'Job not found.';
const JOB_NOT_CONFIRMED = 'This job must be confirmed before a draft can be generated.';
const NO_SELECTED_RESUME = 'This job has no selected resume. Run a match first.';
const NO_MATCH = 'This job has no match result. Run a match first.';
const RESUME_UNAVAILABLE = 'The selected resume is no longer available in the resume library.';
const JOB_LOAD_ERROR = 'Unable to load this job.';
const JOB_SAVE_ERROR = 'Unable to save the outreach draft.';
const LIBRARY_ERROR = 'The resume library is temporarily unavailable.';
const DRAFT_FAILED = 'Unable to generate the outreach draft.';

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
    throw new DraftRequestError('A JSON request body is required.');
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new DraftRequestError('The request body was not valid JSON.');
    }
  }
  return raw;
}

/**
 * Assembles the handler.
 *
 * Dependencies are injected so tests can supply a token verifier, a Job document, a Resume
 * Library, a model response, a clock, and a configuration without Firebase, Google, or
 * Anthropic credentials. Production passes none of them and gets the real implementations.
 *
 * `loadConfig` is overridable separately from `config` so a test can exercise the
 * *unconfigured* path without depending on whether this machine happens to have
 * `ANTHROPIC_API_KEY` set, and `now` is overridable so `draftGeneratedAt` is deterministic.
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
      log.error('[draft] token verification failed', error);
      return res.status(500).json({ error: 'Could not verify credentials.' });
    }

    // 2. Validate the caller's input. Only `jobId` is read; everything else in the body
    //    is ignored, which is what stops a caller from supplying draft inputs.
    let input;
    try {
      input = parseDraftRequest(readBody(req.body));
    } catch (error) {
      if (error instanceof DraftRequestError) {
        return res.status(400).json({ error: error.reason });
      }
      log.error('[draft] unexpected request failure', error);
      return res.status(500).json({ error: 'Unable to process the request.' });
    }

    // 3. Configuration, read after authentication so an anonymous probe cannot enumerate it.
    let config;
    try {
      const loadConfig = overrides.loadConfig ?? matchConfig;
      config = overrides.config ?? loadConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        log.error('[draft] configuration is incomplete', error.message);
        return res.status(404).json({ error: NOT_CONFIGURED });
      }
      log.error('[draft] configuration failed', error);
      return res.status(500).json({ error: DRAFT_FAILED });
    }

    // Same rule for an injected configuration that is present but incomplete: a missing
    // variable is a deployment problem (404), not a provider failure (500).
    if (!config || !config.anthropicApiKey || !config.resumeSheetId) {
      log.error('[draft] configuration is incomplete', !config || !config.anthropicApiKey ? 'ANTHROPIC_API_KEY' : 'GOOGLE_RESUME_SHEET_ID');
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
      log.error('[draft] failed to load the job', error);
      return res.status(500).json({ error: JOB_LOAD_ERROR });
    }

    if (!isMatchableJobDocument(document)) {
      return res.status(404).json({ error: JOB_NOT_FOUND });
    }

    // 5. Preconditions. A draft is written from an existing match, so every one of these
    //    is required and none is repaired here: falling back to an earlier resume, or
    //    re-running the match on the side, would produce an email the user never asked for.
    if (document.intakeStatus !== 'confirmed') {
      return res.status(409).json({ error: JOB_NOT_CONFIRMED });
    }
    if (typeof document.selectedResumeId !== 'string' || !document.selectedResumeId.trim()) {
      return res.status(409).json({ error: NO_SELECTED_RESUME });
    }
    if (
      !Array.isArray(document.matchBreakdown) ||
      document.matchBreakdown.length === 0 ||
      typeof document.matchScore !== 'number'
    ) {
      return res.status(409).json({ error: NO_MATCH });
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
        log.error('[draft] configuration is incomplete', error.message);
        return res.status(404).json({ error: NOT_CONFIGURED });
      }
      log.error('[draft] failed to read the resume library', error);
      return res.status(500).json({ error: LIBRARY_ERROR });
    }

    const resume = findSelectedRecord(records, document.selectedResumeId);
    if (!resume) {
      // The resume was deleted or emptied after the match ran. 409, not 404: the Job is
      // fine, the pairing is what no longer holds, and re-selecting is a human decision.
      return res.status(409).json({ error: RESUME_UNAVAILABLE });
    }

    // Suggestions are optional context, never a precondition: a Job that has never asked
    // for them still has a match and a resume to draft from.
    const suggestions = Array.isArray(document.resumeSuggestions?.suggestions)
      ? document.resumeSuggestions
      : null;

    const materials = {
      job: document,
      resume,
      matchBreakdown: document.matchBreakdown,
      matchScore: document.matchScore,
      suggestions,
    };

    // 7. Provider call. `ProviderError` is already sanitized: the SDK's own message was
    //    logged inside `extractDraft` and discarded.
    let candidate;
    try {
      candidate = await extractDraft(materials, {
        complete: overrides.complete,
        config,
        logger: log,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        log.error('[draft] extraction failed', error.message);
        return res.status(500).json({ error: DRAFT_FAILED });
      }
      log.error('[draft] unexpected provider failure', error);
      return res.status(500).json({ error: DRAFT_FAILED });
    }

    // 8. Validate every claim back against the material the model was actually given. A
    //    schema break or a fabrication guard trip is a server-side failure: the model's
    //    text quotes resume bodies, so it is logged by rule name and never returned.
    let draft;
    try {
      draft = normalizeDraftResult(candidate, materials);
    } catch (error) {
      if (error instanceof DraftValidationError) {
        log.error('[draft] invalid draft result', error.reason);
        return res.status(500).json({ error: DRAFT_FAILED });
      }
      log.error('[draft] unexpected validation failure', error);
      return res.status(500).json({ error: DRAFT_FAILED });
    }

    // The timestamp is the server's clock, never the model's. The model was asked for a
    // subject and a message only, so there is no field here it could have invented.
    const clock = typeof overrides.now === 'function' ? overrides.now : Date.now;
    const generatedAt = new Date(clock()).toISOString();

    // 9. Persist only what drafting owns. The patch carries four keys, so `update` leaves
    //    company, role, contactName, matchScore, matchBreakdown, selectedResumeId,
    //    resumeSuggestions, approvalStatus, applicationStatus, the sheet and Gmail fields,
    //    and `updatedAt` byte-for-byte as they were.
    try {
      await writeDraftFields(uid, input.jobId, {
        draftSubject: draft.draftSubject,
        draftMessage: draft.draftMessage,
        draftGeneratedAt: generatedAt,
        draftEditedByHuman: false,
      }, {
        db: overrides.db,
        config,
      });
    } catch (error) {
      log.error('[draft] failed to persist the draft', error);
      return res.status(500).json({ error: JOB_SAVE_ERROR });
    }

    return res.status(200).json({
      schemaVersion: draft.schemaVersion,
      jobId: input.jobId,
      draftSubject: draft.draftSubject,
      draftMessage: draft.draftMessage,
      generatedAt,
    });
  };
}

const handler = createHandler();

export { fakeResponse };
export default handler;
