/**
 * POST /api/approval — the human review and approval gate.
 *
 * Flow:
 *
 *     Request -> verify Firebase ID token -> validate body -> load config
 *             -> load the caller's Job from Firestore -> confirm it is a canonical Job
 *             -> decide whether the action is legal from the stored approvalStatus
 *             -> require every review precondition (confirm, resume, match, draft)
 *             -> read the selected resume out of the Resume Library server-side
 *             -> persist a three-field patch inside a transaction -> JSON
 *
 * This is Phase 8. It records that a human looked at an application and said yes or no.
 * It never sends mail, never calls Claude, Gmail, or Apps Script, never changes
 * `applicationStatus`, and never touches the match, the suggestions, the draft, or the
 * resume. The UI button that reaches this endpoint is not the security boundary: the
 * transition table and the preconditions in `lib/approval.js` are, and they are evaluated
 * here from the stored document rather than from anything the caller says.
 *
 * The request body is read for exactly two values, `jobId` and `action`. `uid`,
 * `approvalStatus`, `approvedAt`, `approvedBy`, and `applicationStatus` are ignored if
 * present, so a client cannot hand itself an approval and cannot reach another user's
 * documents, whose paths are always built from the verified token.
 *
 * Two failure vocabularies are kept apart on purpose:
 *   - 400/409 describe the caller's own request or the state of their own data, and are
 *     safe to show verbatim.
 *   - 500s are fixed strings. Neither a Firestore nor a Google error message is ever
 *     forwarded — they carry project ids, document paths, and request URLs.
 *
 * This module contains no credentials and holds no module-level state, which is what lets
 * the tests drive it end to end with fakes.
 */

import { authenticate, UnauthenticatedError } from '../lib/auth.js';
import { ConfigError, resumeLibraryConfig } from '../lib/config.js';
import { fetchResumeRows } from '../lib/google.js';
import { loadJobDocument, writeApprovalFields, isMatchableJobDocument } from '../lib/jobs.js';
import { findSelectedRecord } from '../lib/suggestions.js';
import { parseCacheRows, splitHeaderAndRows } from '../lib/resume-cache.js';
import {
  ApprovalConflictError,
  ApprovalRequestError,
  ApprovalStateError,
  approvalMaterial,
  approvalPatchFor,
  parseApprovalRequest,
  planApprovalTransition,
  reviewPreconditionFailure,
} from '../lib/approval.js';

const AUTH_ERROR = 'Authentication required.';
const NOT_CONFIGURED = 'Approval is not configured on the server.';
const JOB_NOT_FOUND = 'Job not found.';
const JOB_LOAD_ERROR = 'Unable to load this job.';
const JOB_SAVE_ERROR = 'Unable to save the approval state.';
const LIBRARY_ERROR = 'The resume library is temporarily unavailable.';

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
    throw new ApprovalRequestError('A JSON request body is required.');
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ApprovalRequestError('The request body was not valid JSON.');
    }
  }
  return raw;
}

/** The success envelope: the three approval fields and nothing else. */
function approvalResult(jobId, action, document) {
  return {
    schemaVersion: 1,
    jobId,
    action,
    approvalStatus: document.approvalStatus ?? null,
    approvedAt: document.approvedAt ?? null,
    approvedBy: document.approvedBy ?? null,
  };
}

/**
 * Assembles the handler.
 *
 * Dependencies are injected so tests can supply a token verifier, a Job document, a Resume
 * Library, a clock, and a configuration without Firebase or Google credentials. Production
 * passes none of them and gets the real implementations.
 *
 * `loadConfig` defaults to `resumeLibraryConfig` rather than `matchConfig`: approval reads
 * the credential and the Resume Sheet and nothing else, so it stays working — and stays
 * able to say *no* — on a deployment that has no `ANTHROPIC_API_KEY`. Making a human
 * decision depend on an unrelated model key would be a poor failure to explain.
 *
 * `now` is overridable so `approvedAt` is deterministic in tests.
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
      log.error('[approval] token verification failed', error);
      return res.status(500).json({ error: 'Could not verify credentials.' });
    }

    // 2. Validate the caller's input. `jobId` and `action` are read; every other key in
    //    the body is ignored, which is what stops a caller from supplying its own outcome.
    let input;
    try {
      input = parseApprovalRequest(readBody(req.body));
    } catch (error) {
      if (error instanceof ApprovalRequestError) {
        return res.status(400).json({ error: error.reason });
      }
      log.error('[approval] unexpected request failure', error);
      return res.status(500).json({ error: 'Unable to process the request.' });
    }

    // 3. Configuration, read after authentication so an anonymous probe cannot enumerate it.
    let config;
    try {
      const loadConfig = overrides.loadConfig ?? resumeLibraryConfig;
      config = overrides.config ?? loadConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        log.error('[approval] configuration is incomplete', error.message);
        return res.status(404).json({ error: NOT_CONFIGURED });
      }
      log.error('[approval] configuration failed', error);
      return res.status(500).json({ error: 'Unable to process the request.' });
    }

    // Same rule for an injected configuration that is present but incomplete.
    if (!config || !config.resumeSheetId) {
      log.error('[approval] configuration is incomplete', 'GOOGLE_RESUME_SHEET_ID');
      return res.status(404).json({ error: NOT_CONFIGURED });
    }

    // 4. Load the Job under the verified uid's own path. A missing document and somebody
    //    else's document both arrive as null and get the same answer, so a caller cannot
    //    probe for ids outside their own collection. Legacy documents are answered the
    //    same way, so the endpoint never confirms that an unversioned record exists.
    let document;
    try {
      document = await loadJobDocument(uid, input.jobId, {
        db: overrides.db,
        config,
      });
    } catch (error) {
      log.error('[approval] failed to load the job', error);
      return res.status(500).json({ error: JOB_LOAD_ERROR });
    }

    if (!isMatchableJobDocument(document)) {
      return res.status(404).json({ error: JOB_NOT_FOUND });
    }

    // 5. The state machine decides, from the stored status, whether this action is legal.
    //    An illegal transition is a 409 about the caller's own data, so its message is
    //    returned verbatim — none of these strings quote a document or a path.
    let plan;
    try {
      plan = planApprovalTransition(document.approvalStatus, input.action);
    } catch (error) {
      if (error instanceof ApprovalStateError) {
        return res.status(409).json({ error: error.reason });
      }
      if (error instanceof ApprovalRequestError) {
        return res.status(400).json({ error: error.reason });
      }
      log.error('[approval] unexpected transition failure', error);
      return res.status(500).json({ error: 'Unable to process the request.' });
    }

    // Already in the requested state. Answer 200 and write nothing: re-approving must not
    // restamp `approvedAt`, and re-reviewing must not churn a document nobody changed.
    if (!plan.changed) {
      return res.status(200).json(approvalResult(input.jobId, input.action, document));
    }

    // 6. Preconditions. Rejection is the one action that does not need them — a human must
    //    always be able to stop a broken application, and demanding a valid draft before
    //    accepting "no" would make the gate harder to close than to open.
    if (input.action !== 'reject') {
      const failure = reviewPreconditionFailure(document);
      if (failure) {
        return res.status(409).json({ error: failure });
      }

      // The Resume Library is read server-side, after the Job, and only to confirm the
      // pairing still holds. Its rows carry `extractedText`, which never leaves this
      // function and is never written anywhere.
      let records;
      try {
        const values = await fetchResumeRows(config, { sheets: overrides.sheets });
        records = parseCacheRows(splitHeaderAndRows(values).rows).records;
      } catch (error) {
        if (error instanceof ConfigError) {
          log.error('[approval] configuration is incomplete', error.message);
          return res.status(404).json({ error: NOT_CONFIGURED });
        }
        log.error('[approval] failed to read the resume library', error);
        return res.status(500).json({ error: LIBRARY_ERROR });
      }

      if (!findSelectedRecord(records, document.selectedResumeId)) {
        // The resume was deleted after the match ran. 409, not 404: the Job is fine, the
        // pairing is what no longer holds, and re-selecting is a human decision. The job
        // is deliberately left in its current status rather than being quietly rejected.
        return res.status(409).json({ error: 'The selected resume is no longer available in the resume library.' });
      }
    }

    // 7. Persist. The patch is built here from a fixed action, never from the body, and
    //    the transaction refuses to land if the document moved since step 4 — so a stale
    //    approval cannot survive a concurrent edit, and two humans tapping approve and
    //    reject at once cannot both win.
    const clock = typeof overrides.now === 'function' ? overrides.now : Date.now;
    const patch = approvalPatchFor(input.action, { uid, now: new Date(clock()).toISOString() });

    try {
      await writeApprovalFields(uid, input.jobId, {
        material: approvalMaterial(document),
        patch,
      }, {
        db: overrides.db,
        config,
      });
    } catch (error) {
      if (error instanceof ApprovalConflictError) {
        return res.status(409).json({ error: error.reason });
      }
      log.error('[approval] failed to persist the approval state', error);
      return res.status(500).json({ error: JOB_SAVE_ERROR });
    }

    return res.status(200).json(approvalResult(input.jobId, input.action, {
      approvalStatus: patch.approvalStatus,
      approvedAt: patch.approvedAt,
      approvedBy: patch.approvedBy,
    }));
  };
}

const handler = createHandler();

export { fakeResponse };
export default handler;
