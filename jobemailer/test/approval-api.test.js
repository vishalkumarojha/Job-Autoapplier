/**
 * Tests for `POST /api/approval`, focused on the authentication and authorization boundary,
 * on the transition table that decides who may approve what, on the review preconditions,
 * on proving that only the three approval-owned fields are ever written, and on proving
 * that nothing else in the document — least of all anything that could send — moves.
 *
 * The endpoint records a human decision and nothing else. Every assertion below that could
 * be satisfied by a feature which also sends mail, or which lets a caller approve its own
 * application, or which approves text that changed after it was approved, is written so
 * that such a feature would fail it.
 *
 * Runs on `node:test`. No Firebase project and no Google credential is involved: the token
 * verifier, the Firestore handle, the Sheets client, the clock, and the configuration are
 * all injected, so these cases exercise the real handler while contacting nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler, fakeResponse } from '../api/approval.js';
import { ConfigError } from '../lib/config.js';
import { writeDraftFields, writeSuggestionFields, writeMatchFields } from '../lib/jobs.js';
import { APPROVAL_FIELDS, MESSAGES } from '../lib/approval.js';
import { RESUME_CACHE_HEADERS, RESUME_CACHE_SCHEMA_VERSION } from '../lib/resume-cache.js';

const UID = 'user-1';
const JOB_ID = 'job-1';
const OWN_PATH = `users/${UID}/jobs/${JOB_ID}`;
const OTHER_PATH = 'users/attacker/jobs/job-1';
const RESUME_ID = 'rsv_alpha';
const NOW = '2026-10-06T12:00:00.000Z';

const POSTING = `Senior Backend Engineer — Example Corp
We are hiring a Senior Backend Engineer to own our payments platform.
Required: Kubernetes, PostgreSQL, and 5 years of experience.
Send your CV to priya.sharma@example.com.`;

/** A canonical Job that passes every review precondition. One field is flipped per case. */
function jobFixture(overrides = {}) {
  return {
    id: JOB_ID,
    schemaVersion: 1,
    dedupeKey: 'example corp|senior backend engineer|',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T11:30:00.000Z',
    archivedAt: null,

    rawText: POSTING,
    rawSource: 'linkedin',
    capturedAt: '2026-10-01T10:00:00.000Z',
    intakeStatus: 'confirmed',
    fieldConfidence: { company: 0.98, role: 0.99 },

    company: 'Example Corp',
    contactName: 'Priya Sharma',
    contactEmail: 'priya.sharma@example.com',
    role: 'Senior Backend Engineer',
    jobUrl: 'https://example.com/jobs/backend-42',
    source: null,
    location: 'Bangalore / Remote',
    notes: 'Visa sponsorship available.',
    deadline: '2026-10-12',
    deadlineSource: 'extracted',
    contactEmailSource: 'extracted',

    selectedResumeId: RESUME_ID,
    matchScore: 91,
    matchBreakdown: [
      { criterion: 'must_have', score: 94, weight: 0.35, rationale: 'Go and PostgreSQL cover the stack.' },
      { criterion: 'nice_to_have', score: 84, weight: 0.15, rationale: 'Kubernetes appears in project work only.' },
    ],
    resumeSuggestions: null,

    draftMessage: 'DRAFT THAT MUST NOT MOVE',
    draftSubject: 'Subject that must not move',
    draftGeneratedAt: '2026-10-03T09:00:00.000Z',
    draftEditedByHuman: true,

    approvalStatus: 'draft',
    approvedAt: null,
    approvedBy: null,
    applicationStatus: 'sourced',

    sheetRowId: 7,
    sheetSyncStatus: 'synced',
    sheetSyncedAt: '2026-10-03T09:05:00.000Z',

    gmailThreadId: 'thread-123',
    emailSentOn: '2026-10-03T09:10:00.000Z',
    followUpStatus: 'scheduled',
    followUpCount: 2,
    followUpLastSentAt: '2026-10-04T09:10:00.000Z',

    reminderDeadlineNotifId: 'notif-1',
    nextReminderAt: '2026-10-11T09:00:00.000Z',
    ...overrides,
  };
}

/** Everything an approval must leave byte-for-byte alone. */
const PROTECTED_FIELDS = [
  'company', 'role', 'jobUrl', 'contactName', 'contactEmail', 'deadline', 'notes', 'location',
  'rawText', 'rawSource', 'intakeStatus', 'selectedResumeId', 'matchScore', 'matchBreakdown',
  'resumeSuggestions', 'draftSubject', 'draftMessage', 'draftGeneratedAt', 'draftEditedByHuman',
  'applicationStatus', 'dedupeKey', 'sheetRowId', 'sheetSyncStatus', 'sheetSyncedAt',
  'gmailThreadId', 'emailSentOn', 'followUpStatus', 'followUpCount', 'createdAt', 'updatedAt',
  'schemaVersion',
];

/** The response never carries more than the approval outcome. */
const RESPONSE_KEYS = ['action', 'approvalStatus', 'approvedAt', 'approvedBy', 'jobId', 'schemaVersion'];

function cacheRow(overrides = {}) {
  return {
    resumeId: RESUME_ID,
    resumeLabel: 'Backend — Go — v3',
    targetRole: 'Backend Engineer',
    targetRoleFamily: 'backend',
    version: 3,
    isDefault: false,
    keywords: '["Go","PostgreSQL"]',
    driveFileId: '1DriVeFiLeIdDoNotLeak',
    driveFileName: 'Vishal_Kumar_Ojha_Backend.pdf',
    extractedText: 'JANE DOE SENIOR BACKEND ENGINEER Go PostgreSQL payments platform',
    contentHash: 'deadbeef',
    updatedAt: '2026-10-05T09:00:00.000Z',
    lastUsedAt: null,
    schemaVersion: RESUME_CACHE_SCHEMA_VERSION,
    ...overrides,
  };
}

const ROW_ALPHA = cacheRow();
const ROW_BETA = cacheRow({ resumeId: 'rsv_beta', resumeLabel: 'AI Engineer — v2' });

const CONFIG = { resumeSheetId: 'sheet-for-tests', resumeSheetTab: 'Resumes' };

/** A request that succeeds unless a test overrides something. */
function defaultStore() {
  return new Map([[OWN_PATH, jobFixture()]]);
}

/** A store holding one job, in the shape the invoke helper expects. */
function storeWith(document) {
  return new Map([[OWN_PATH, document]]);
}

function tabValues(rows) {
  return [RESUME_CACHE_HEADERS, ...rows.map((row) => RESUME_CACHE_HEADERS.map((header) => row[header] ?? ''))];
}

/** An in-memory stand-in for Firestore, path-addressed like the real document path. */
function fakeDb(store) {
  const writes = [];
  return {
    writes,
    store,
    doc(path) {
      return {
        async get() {
          const data = store.get(path);
          return { exists: data !== undefined, data: () => data };
        },
        async update(patch) {
          const current = store.get(path);
          if (current === undefined) {
            const error = new Error(`NOT_FOUND: No document to update: ${path}`);
            error.code = 'not-found';
            throw error;
          }
          writes.push({ path, patch });
          store.set(path, { ...current, ...patch });
        },
      };
    },
    async runTransaction(update) {
      return update({
        get: (ref) => ref.get(),
        update: (ref, patch) => ref.update(patch),
      });
    },
  };
}

/**
 * A database whose contents change *between* the handler's read and its transaction.
 *
 * This is the whole point of Part G: the handler validated one document and the write
 * lands on another. `mutate` runs after the handler has already loaded and prevalidated,
 * so the transaction sees the drift and must refuse.
 */
function racingDb(store, mutate) {
  const db = fakeDb(store);
  const runTransaction = db.runTransaction.bind(db);
  db.runTransaction = async (update) => {
    mutate(store);
    return runTransaction(update);
  };
  return db;
}

/** Accepts exactly one hardcoded token; everything else is treated as invalid. */
function strictVerifier(expectedToken, uid = UID) {
  return async (token) => {
    if (token !== expectedToken) {
      const error = new Error('Firebase ID token has expired or is invalid.');
      error.code = 'auth/id-token-expired';
      throw error;
    }
    return { uid, sub: uid };
  };
}

function silentLogger() {
  const entries = [];
  return { entries, error: (...args) => entries.push(args) };
}

function fakeSheets(values) {
  return { spreadsheets: { values: { get: async () => ({ data: { values } }) } } };
}

/**
 * Runs the handler with a valid request unless overridden.
 *
 * Returns the response plus the logger, the store, and the recorded writes, so persistence
 * assertions compare the document before and after rather than trusting the handler's own
 * answer. The clock is fixed so `approvedAt` is deterministic.
 */
async function invoke(options = {}) {
  const {
    headers = { authorization: 'Bearer good-token' },
    method = 'POST',
    verifyIdToken = strictVerifier('good-token'),
    loadConfig,
    logger = silentLogger(),
    rows = [ROW_ALPHA, ROW_BETA],
    now = () => NOW,
  } = options;
  const store = 'store' in options ? options.store : defaultStore();
  const db = 'db' in options ? options.db : fakeDb(store);
  const body = 'body' in options ? options.body : { jobId: JOB_ID, action: options.action ?? 'review' };
  const config = 'config' in options ? options.config : CONFIG;
  const sheets = 'sheets' in options ? options.sheets : fakeSheets(tabValues(rows));

  const handler = createHandler({ verifyIdToken, config, loadConfig, logger, sheets, db, now });
  const res = fakeResponse();
  await handler({ method, headers, body }, res);
  return { res, logger, db, store };
}

// ─── Method ────────────────────────────────────────────────────────────────────

test('only POST is allowed', async () => {
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    const { res } = await invoke({ method });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.Allow, 'POST');
    assert.equal(res.body.error, `Method ${method} is not allowed. Use POST.`);
  }
});

// ─── Authentication ────────────────────────────────────────────────────────────

test('a missing Authorization header is 401', async () => {
  const { res } = await invoke({ headers: {} });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Authentication required.' });
});

test('a malformed Authorization header is 401', async () => {
  for (const authorization of ['good-token', 'Bearer', 'Basic good-token', 'Bearer good-token extra', '']) {
    const { res } = await invoke({ headers: { authorization } });
    assert.equal(res.statusCode, 401, `"${authorization}" must be rejected`);
  }
});

test('an expired token is 401 and indistinguishable from a forged one', async () => {
  const expired = async () => {
    const error = new Error('Firebase ID token has expired.');
    error.code = 'auth/id-token-expired';
    throw error;
  };
  const { res: expiredRes } = await invoke({ verifyIdToken: expired });
  const { res: forgedRes } = await invoke({ headers: { authorization: 'Bearer forged' } });
  assert.equal(expiredRes.statusCode, 401);
  assert.equal(forgedRes.statusCode, 401);
  assert.deepEqual(expiredRes.body, forgedRes.body);
});

test('the token is never logged', async () => {
  const { logger } = await invoke();
  const logged = JSON.stringify(logger.entries);
  assert.ok(!logged.includes('good-token'), 'the ID token must never reach a log line');
});

test('a verifier that returns no uid is 401', async () => {
  const { res } = await invoke({ verifyIdToken: async () => ({ sub: 'user-1' }) });
  assert.equal(res.statusCode, 401);
});

// ─── Request body ──────────────────────────────────────────────────────────────

test('a body that is not a JSON object is a 400', async () => {
  for (const body of [42, true, ['job-1']]) {
    const { res } = await invoke({ body });
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)} must be rejected`);
    assert.equal(res.body.error, 'The request body must be a JSON object.');
  }
});

test('an empty body is a 400', async () => {
  for (const body of ['', undefined, null]) {
    const { res } = await invoke({ body });
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)} must be rejected`);
    assert.equal(res.body.error, 'A JSON request body is required.');
  }
});

test('a body that is not valid JSON is a 400, not a 500', async () => {
  for (const body of ['{"jobId":', 'not json at all']) {
    const { res } = await invoke({ body });
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)} must be rejected`);
    assert.equal(res.body.error, 'The request body was not valid JSON.');
  }
});

test('a missing, blank, or unparseable jobId is a 400', async () => {
  const cases = [
    [{ action: 'review' }, 'A jobId is required.'],
    [{ jobId: '', action: 'review' }, 'A jobId is required.'],
    [{ jobId: '   ', action: 'review' }, 'A jobId is required.'],
    [{ jobId: '../../etc', action: 'review' }, 'That jobId is not valid.'],
    [{ jobId: 'a'.repeat(129), action: 'review' }, 'That jobId is not valid.'],
    [{ jobId: 7, action: 'review' }, 'A jobId is required.'],
  ];
  for (const [body, expected] of cases) {
    const { res } = await invoke({ body });
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)} must be rejected`);
    assert.equal(res.body.error, expected);
  }
});

test('a missing or unsupported action is a 400', async () => {
  const cases = [
    [{ jobId: JOB_ID }, 'An action is required.'],
    [{ jobId: JOB_ID, action: '' }, 'An action is required.'],
    [{ jobId: JOB_ID, action: 'send' }, 'That action is not supported.'],
    [{ jobId: JOB_ID, action: 'force-approve' }, 'That action is not supported.'],
    [{ jobId: JOB_ID, action: 1 }, 'An action is required.'],
  ];
  for (const [body, expected] of cases) {
    const { res } = await invoke({ body });
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)} must be rejected`);
    assert.equal(res.body.error, expected);
  }
});

test('a bad body is rejected before the job is read', async () => {
  const { res, db } = await invoke({ body: { action: 'approve' } });
  assert.equal(res.statusCode, 400);
  assert.equal(db.writes.length, 0);
});

// ─── Configuration ─────────────────────────────────────────────────────────────

test('an incomplete configuration is a 404 that says nothing about the variables', async () => {
  const { res, logger } = await invoke({
    config: undefined,
    loadConfig: () => { throw new ConfigError(['GOOGLE_RESUME_SHEET_ID']); },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Approval is not configured on the server.');
  assert.ok(!JSON.stringify(res.body).includes('GOOGLE_RESUME_SHEET_ID'));
  assert.ok(logger.entries.length > 0, 'the operator still gets the variable name in the log');
});

test('an injected configuration without a Resume Sheet is a 404', async () => {
  const { res } = await invoke({ config: { resumeSheetTab: 'Resumes' } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Approval is not configured on the server.');
});

test('configuration is read only after authentication', async () => {
  let read = false;
  const { res } = await invoke({
    headers: {},
    config: undefined,
    loadConfig: () => { read = true; return CONFIG; },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(read, false, 'an anonymous probe must not trigger a configuration read');
});

// ─── Job authorization ─────────────────────────────────────────────────────────

test('a missing job is a 404 and nothing is written', async () => {
  const store = new Map();
  const { res, db } = await invoke({ store, body: { jobId: JOB_ID, action: 'review' } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Job not found.');
  assert.equal(db.writes.length, 0);
});

test('a job belonging to another uid is indistinguishable from a missing one', async () => {
  const store = new Map([[OTHER_PATH, jobFixture()]]);
  const { res: missing } = await invoke({ store: new Map() });
  const { res: foreign } = await invoke({ store, body: { jobId: JOB_ID, action: 'review' } });
  assert.equal(foreign.statusCode, 404);
  assert.deepEqual(foreign.body, missing.body, 'both answers must be identical');
});

test('a legacy, unversioned document is a 404 and is never written to', async () => {
  const store = storeWith({ company: 'Legacy Co', role: 'Old Role', intakeStatus: 'confirmed' });
  const { res, db } = await invoke({ store, body: { jobId: JOB_ID, action: 'review' } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Job not found.');
  assert.equal(db.writes.length, 0, 'a legacy document must never be written to');
});

test('the verified uid decides which document is read and written', async () => {
  const store = new Map([
    [OWN_PATH, jobFixture()],
    [OTHER_PATH, jobFixture({ company: 'Not Ours Inc', approvalStatus: 'approved' })],
  ]);
  const { res, db } = await invoke({ store, action: 'review' });
  assert.equal(res.statusCode, 200);
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].path, OWN_PATH, 'the write must land under the verified uid');
  assert.equal(store.get(OTHER_PATH).approvalStatus, 'approved', "another user's job must be untouched");
});

test('a uid supplied in the body is ignored', async () => {
  const { res, db } = await invoke({ body: { jobId: JOB_ID, action: 'review', uid: 'attacker' } });
  assert.equal(res.statusCode, 200);
  assert.equal(db.writes[0].path, OWN_PATH);
});

// ─── Illegal transitions ───────────────────────────────────────────────────────

test('approving from draft is refused without writing', async () => {
  const { res, db } = await invoke({ action: 'approve' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, MESSAGES.notInReview);
  assert.equal(db.writes.length, 0);
});

test('rejecting from draft is refused without writing', async () => {
  const { res, db } = await invoke({ action: 'reject' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, MESSAGES.notInReview);
  assert.equal(db.writes.length, 0);
});

test('reopening something never reviewed is refused', async () => {
  const { res, db } = await invoke({ action: 'reopen' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, MESSAGES.nothingToReopen);
  assert.equal(db.writes.length, 0);
});

test('approving a rejected application demands an explicit reopen first', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'rejected' }));
  const { res, db } = await invoke({ store, action: 'approve' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, MESSAGES.rejectedNeedsReopen);
  assert.equal(db.writes.length, 0);
  assert.equal(store.get(OWN_PATH).approvalStatus, 'rejected');
});

test('an approved application cannot be walked backwards by reviewing it', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'approved', approvedAt: NOW, approvedBy: UID }));
  const { res, db } = await invoke({ store, action: 'review' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, MESSAGES.alreadyApproved);
  assert.equal(db.writes.length, 0);
});

test('an approved application cannot be rejected directly', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'approved', approvedAt: NOW, approvedBy: UID }));
  const { res, db } = await invoke({ store, action: 'reject' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, MESSAGES.alreadyApproved);
  assert.equal(db.writes.length, 0);
  assert.equal(store.get(OWN_PATH).approvalStatus, 'approved');
});

// ─── Idempotence ───────────────────────────────────────────────────────────────

test('an action that is already true answers 200 and writes nothing', async () => {
  const cases = [
    { status: 'pending_review', action: 'review' },
    { status: 'approved', action: 'approve' },
    { status: 'rejected', action: 'reject' },
    { status: 'pending_review', action: 'reopen' },
  ];
  for (const { status, action } of cases) {
    const store = storeWith(jobFixture({ approvalStatus: status, approvedAt: NOW, approvedBy: UID }));
    const { res, db } = await invoke({ store, action });
    assert.equal(res.statusCode, 200, `${action} from ${status} must answer 200`);
    assert.equal(db.writes.length, 0, `${action} from ${status} must not write`);
    assert.equal(store.get(OWN_PATH).approvedAt, NOW, `${action} from ${status} must not restamp`);
    assert.equal(store.get(OWN_PATH).approvalStatus, status);
  }
});

// ─── Review preconditions ──────────────────────────────────────────────────────

test('an unconfirmed application cannot be put into review', async () => {
  const store = storeWith(jobFixture({ intakeStatus: 'drafting' }));
  const { res, db } = await invoke({ store, action: 'review' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, MESSAGES.unconfirmed);
  assert.equal(db.writes.length, 0);
});

test('an application with no selected resume cannot be put into review', async () => {
  const store = storeWith(jobFixture({ selectedResumeId: '' }));
  const { res, db } = await invoke({ store, action: 'review' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, MESSAGES.noSelectedResume);
  assert.equal(db.writes.length, 0);
});

test('an application with no match cannot be put into review', async () => {
  for (const override of [{ matchBreakdown: [] }, { matchScore: undefined }]) {
    const store = storeWith(jobFixture(override));
    const { res, db } = await invoke({ store, action: 'review' });
    assert.equal(res.statusCode, 409, `${JSON.stringify(override)} must be refused`);
    assert.equal(res.body.error, MESSAGES.noMatch);
    assert.equal(db.writes.length, 0);
  }
});

test('an application with no outreach draft cannot be put into review', async () => {
  for (const override of [{ draftSubject: '' }, { draftMessage: '   ' }]) {
    const store = storeWith(jobFixture(override));
    const { res, db } = await invoke({ store, action: 'review' });
    assert.equal(res.statusCode, 409, `${JSON.stringify(override)} must be refused`);
    assert.equal(res.body.error, MESSAGES.noDraft);
    assert.equal(db.writes.length, 0);
  }
});

test('an application whose resume vanished from the library cannot be reviewed', async () => {
  const { res, db, store } = await invoke({ rows: [ROW_BETA], action: 'review' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, MESSAGES.resumeUnavailable);
  assert.equal(db.writes.length, 0, 'the application must be left where it was, not rejected');
  assert.equal(store.get(OWN_PATH).approvalStatus, 'draft');
});

test('approving an application whose resume vanished from the library is refused', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'pending_review' }));
  const { res, db } = await invoke({ store, rows: [ROW_BETA], action: 'approve' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, MESSAGES.resumeUnavailable);
  assert.equal(db.writes.length, 0);
  assert.equal(store.get(OWN_PATH).approvalStatus, 'pending_review', 'a refused approval must not approve');
});

test('rejection is always available, even on an application that fails review', async () => {
  const store = storeWith(jobFixture({ intakeStatus: 'drafting', approvalStatus: 'pending_review' }));
  const { res, db } = await invoke({ store, action: 'reject' });
  assert.equal(res.statusCode, 200);
  assert.equal(db.writes.length, 1);
  assert.equal(store.get(OWN_PATH).approvalStatus, 'rejected');
});

test('an application that fails review still requires review first, on every precondition', async () => {
  const failures = [
    { intakeStatus: 'drafting', error: MESSAGES.unconfirmed },
    { selectedResumeId: null, error: MESSAGES.noSelectedResume },
    { matchScore: null, error: MESSAGES.noMatch },
    { draftSubject: null, error: MESSAGES.noDraft },
  ];
  for (const { error, ...override } of failures) {
    const store = storeWith(jobFixture(override));
    const { res } = await invoke({ store, action: 'review' });
    assert.equal(res.statusCode, 409, `${error} must be reported`);
    assert.equal(res.body.error, error);
  }
});

// ─── The three legal transitions ──────────────────────────────────────────────

test('review moves a draft application into pending_review and clears both stamps', async () => {
  const { res, db } = await invoke({ action: 'review' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(db.writes, [{ path: OWN_PATH, patch: {
    approvalStatus: 'pending_review',
    approvedAt: null,
    approvedBy: null,
  } }]);
  assert.deepEqual(res.body, {
    schemaVersion: 1,
    jobId: JOB_ID,
    action: 'review',
    approvalStatus: 'pending_review',
    approvedAt: null,
    approvedBy: null,
  });
});

test('approve stamps the server clock and the verified uid', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'pending_review' }));
  const { res, db } = await invoke({ store, action: 'approve' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(db.writes, [{ path: OWN_PATH, patch: {
    approvalStatus: 'approved',
    approvedAt: NOW,
    approvedBy: UID,
  } }]);
  assert.deepEqual(res.body, {
    schemaVersion: 1,
    jobId: JOB_ID,
    action: 'approve',
    approvalStatus: 'approved',
    approvedAt: NOW,
    approvedBy: UID,
  });
});

test('reject clears both stamps so no approval survives the rejection', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'pending_review' }));
  const { res, db } = await invoke({ store, action: 'reject' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(db.writes, [{ path: OWN_PATH, patch: {
    approvalStatus: 'rejected',
    approvedAt: null,
    approvedBy: null,
  } }]);
  assert.equal(res.body.approvedAt, null);
  assert.equal(res.body.approvedBy, null);
});

test('reopen withdraws an approval and returns the application to pending_review', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'approved', approvedAt: '2026-10-05T08:00:00.000Z', approvedBy: 'someone-else' }));
  const { res, db } = await invoke({ store, action: 'reopen' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(db.writes, [{ path: OWN_PATH, patch: {
    approvalStatus: 'pending_review',
    approvedAt: null,
    approvedBy: null,
  } }]);
  assert.equal(res.body.approvedAt, null);
  assert.equal(res.body.approvedBy, null);
});

// ─── The write is narrow ───────────────────────────────────────────────────────

test('an approval writes exactly the three approval fields and nothing else', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'pending_review' }));
  const before = { ...store.get(OWN_PATH) };
  const { db } = await invoke({ store, action: 'approve' });

  assert.deepEqual(Object.keys(db.writes[0].patch).sort(), [...APPROVAL_FIELDS].sort());

  const after = store.get(OWN_PATH);
  assert.deepEqual(Object.keys(db.writes[0].patch).sort(), ['approvalStatus', 'approvedAt', 'approvedBy']);
  for (const field of PROTECTED_FIELDS) {
    assert.deepEqual(after[field], before[field], `${field} must not move`);
  }
});

test('every action leaves the match, the draft, the sheet, and the mailbox untouched', async () => {
  for (const status of ['draft', 'pending_review', 'approved', 'rejected']) {
    for (const action of ['review', 'approve', 'reject', 'reopen']) {
      const store = storeWith(jobFixture({ approvalStatus: status }));
      const before = { ...store.get(OWN_PATH) };
      await invoke({ store, action });
      const after = store.get(OWN_PATH);
      for (const field of PROTECTED_FIELDS) {
        assert.deepEqual(after[field], before[field], `${action} from ${status} must not move ${field}`);
      }
    }
  }
});

// ─── A caller cannot supply its own approval ───────────────────────────────────

test('a body claiming approvalStatus is ignored, and cannot approve a draft application', async () => {
  const store = storeWith(jobFixture());
  const { res, db } = await invoke({
    store,
    body: { jobId: JOB_ID, action: 'approve', approvalStatus: 'approved', approvedAt: NOW, approvedBy: 'attacker' },
  });
  assert.equal(res.statusCode, 409, 'the transition table, not the body, decides');
  assert.equal(db.writes.length, 0);
  assert.equal(store.get(OWN_PATH).approvalStatus, 'draft');
  assert.equal(store.get(OWN_PATH).approvedBy, null);
});

test('a body claiming applicationStatus cannot change it', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'pending_review' }));
  const { res } = await invoke({
    store,
    body: { jobId: JOB_ID, action: 'approve', applicationStatus: 'applied', emailSentOn: NOW },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(store.get(OWN_PATH).applicationStatus, 'sourced');
  assert.equal(store.get(OWN_PATH).emailSentOn, '2026-10-03T09:10:00.000Z');
});

// ─── Concurrency ───────────────────────────────────────────────────────────────

test('an approval that raced a content change is refused with a 409 and writes nothing', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'pending_review' }));
  const db = racingDb(store, (target) => {
    const current = target.get(OWN_PATH);
    target.set(OWN_PATH, { ...current, draftSubject: 'Edited while approving' });
  });

  const { res } = await invoke({ store, db, action: 'approve' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, MESSAGES.conflict);
  assert.equal(db.writes.length, 0, 'a stale approval must not land');
  assert.equal(store.get(OWN_PATH).approvalStatus, 'pending_review');
  assert.equal(store.get(OWN_PATH).draftSubject, 'Edited while approving');
});

test('an approval that raced a concurrent rejection is refused', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'pending_review' }));
  const db = racingDb(store, (target) => {
    target.set(OWN_PATH, { ...target.get(OWN_PATH), approvalStatus: 'rejected' });
  });

  const { res } = await invoke({ store, db, action: 'approve' });
  assert.equal(res.statusCode, 409);
  assert.equal(db.writes.length, 0);
  assert.equal(store.get(OWN_PATH).approvalStatus, 'rejected');
});

// ─── Revocation when approved content changes ─────────────────────────────────

test('regenerating the draft withdraws an existing approval in the same write', async () => {
  const store = storeWith(jobFixture({
    approvalStatus: 'approved',
    approvedAt: '2026-10-05T08:00:00.000Z',
    approvedBy: 'someone-else',
  }));
  const db = fakeDb(store);

  await writeDraftFields(UID, JOB_ID, {
    draftSubject: 'A brand new subject',
    draftMessage: 'A brand new message',
    draftGeneratedAt: NOW,
    draftEditedByHuman: false,
  }, { db });

  const doc = store.get(OWN_PATH);
  assert.equal(doc.approvalStatus, 'pending_review');
  assert.equal(doc.approvedAt, null);
  assert.equal(doc.approvedBy, null);
  assert.equal(doc.draftSubject, 'A brand new subject');
  assert.equal(doc.applicationStatus, 'sourced', 'revocation is not a send and not a status change');
});

test('regenerating suggestions withdraws an existing approval', async () => {
  const store = storeWith(jobFixture({
    approvalStatus: 'approved',
    approvedAt: '2026-10-05T08:00:00.000Z',
    approvedBy: 'someone-else',
  }));
  const db = fakeDb(store);

  await writeSuggestionFields(UID, JOB_ID, {
    resumeSuggestions: { suggestions: [{ title: 'Add Kubernetes' }] },
  }, { db });

  const doc = store.get(OWN_PATH);
  assert.equal(doc.approvalStatus, 'pending_review');
  assert.equal(doc.approvedAt, null);
  assert.equal(doc.approvedBy, null);
});

test('regenerating a match withdraws an existing approval', async () => {
  const store = storeWith(jobFixture({
    approvalStatus: 'approved',
    approvedAt: '2026-10-05T08:00:00.000Z',
    approvedBy: 'someone-else',
  }));
  const db = fakeDb(store);

  await writeMatchFields(UID, JOB_ID, { matchScore: 44, matchBreakdown: [] }, { db });

  const doc = store.get(OWN_PATH);
  assert.equal(doc.approvalStatus, 'pending_review');
  assert.equal(doc.approvedAt, null);
  assert.equal(doc.approvedBy, null);
});

test('content changes on an application that is not approved revoke nothing', async () => {
  for (const status of ['draft', 'pending_review', 'rejected']) {
    const store = storeWith(jobFixture({ approvalStatus: status }));
    const db = fakeDb(store);

    await writeDraftFields(UID, JOB_ID, {
      draftSubject: 'New subject',
      draftMessage: 'New message',
      draftGeneratedAt: NOW,
      draftEditedByHuman: false,
    }, { db });

    const doc = store.get(OWN_PATH);
    assert.equal(doc.approvalStatus, status, `${status} must be left alone`);
    assert.equal(doc.approvedAt, null);
    assert.equal(doc.draftSubject, 'New subject');
  }
});

test('content written to a document that no longer exists still fails loudly', async () => {
  const store = new Map();
  const db = fakeDb(store);
  await assert.rejects(
    () => writeDraftFields(UID, JOB_ID, { draftSubject: 'x', draftMessage: 'y' }, { db }),
    (error) => error.code === 'not-found',
  );
});

// ─── Response shape and leakage ────────────────────────────────────────────────

test('the response carries the approval outcome and nothing else', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'pending_review' }));
  const { res } = await invoke({ store, action: 'approve' });
  assert.deepEqual(Object.keys(res.body).sort(), RESPONSE_KEYS);
});

test('resume text, Drive identifiers, and the match rationale never reach the client', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'pending_review' }));
  const { res } = await invoke({ store, action: 'approve' });
  const payload = JSON.stringify(res.body);
  for (const secret of ['JANE DOE', '1DriVeFiLeIdDoNotLeak', 'Vishal_Kumar_Ojha_Backend.pdf', 'Go and PostgreSQL cover the stack.']) {
    assert.ok(!payload.includes(secret), `"${secret}" must never be returned`);
  }
});

test('a Firestore error is reported as a fixed string, never the provider message', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'pending_review' }));
  const db = fakeDb(store);
  db.runTransaction = async () => {
    const error = new Error('PERMISSION_DENIED: Missing or insufficient permissions for users/user-1/jobs/job-1');
    throw error;
  };
  const { res, logger } = await invoke({ store, db, action: 'approve' });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Unable to save the approval state.');
  assert.ok(!JSON.stringify(res.body).includes('PERMISSION_DENIED'));
  assert.ok(logger.entries.length > 0, 'the operator still sees the real error');
});

// ─── No sending ────────────────────────────────────────────────────────────────

test('an approved application is still exactly where it was, unsent', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'pending_review' }));
  const { res } = await invoke({ store, action: 'approve' });
  assert.equal(res.statusCode, 200);

  const doc = store.get(OWN_PATH);
  assert.equal(doc.approvalStatus, 'approved');
  assert.equal(doc.applicationStatus, 'sourced', 'approval does not advance the application');
  assert.equal(doc.emailSentOn, '2026-10-03T09:10:00.000Z', 'approval does not send');
  assert.equal(doc.gmailThreadId, 'thread-123', 'approval does not open a thread');
  assert.equal(doc.followUpStatus, 'scheduled', 'approval does not schedule a follow-up');
  assert.equal(doc.sheetRowId, 7, 'approval does not touch the sheet');
});

test('no approval path exists that could reach a mailbox', async () => {
  const store = storeWith(jobFixture({ approvalStatus: 'pending_review' }));
  const { db } = await invoke({ store, action: 'approve' });
  const written = JSON.stringify(db.writes);
  for (const field of ['emailSentOn', 'gmailThreadId', 'gmailDraftId', 'draftId', 'followUpStatus', 'body', 'to']) {
    assert.ok(!written.includes(`"${field}"`), `${field} must never be written by an approval`);
  }
});
