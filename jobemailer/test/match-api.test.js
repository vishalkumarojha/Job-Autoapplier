/**
 * Tests for `POST /api/match`, focused on the authentication and authorization boundary,
 * on proving that only the match-owned fields are ever written, and on proving that resume
 * text and provider errors never reach the client.
 *
 * Runs on `node:test`. No Firebase project, no Google credential, and no Anthropic account
 * is involved: the token verifier, the Firestore handle, the Sheets client, the model
 * response, and the configuration are all injected, so these cases exercise the real
 * handler while contacting nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler, fakeResponse } from '../api/match.js';
import { ConfigError } from '../lib/config.js';
import { MATCH_SCHEMA_VERSION } from '../lib/match.js';
import { RESUME_CACHE_HEADERS, RESUME_CACHE_SCHEMA_VERSION } from '../lib/resume-cache.js';

const UID = 'user-1';
const JOB_ID = 'job-1';
const OWN_PATH = `users/${UID}/jobs/${JOB_ID}`;

const POSTING = `Senior Backend Engineer — Example Corp
We are hiring a Senior Backend Engineer to own our payments platform.
Send your CV to priya.sharma@example.com.`;

/** A complete canonical Job, as the repository writes it. Nothing here may change. */
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

    selectedResumeId: null,
    matchScore: null,
    matchBreakdown: null,
    resumeSuggestions: null,

    draftMessage: 'DRAFT THAT MUST NOT MOVE',
    draftSubject: 'Subject that must not move',
    draftGeneratedAt: '2026-10-03T09:00:00.000Z',
    draftEditedByHuman: true,

    approvalStatus: 'pending_review',
    approvedAt: null,
    approvedBy: null,
    applicationStatus: 'applied',

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

/** A cache row carrying server-only columns that must never be echoed. */
function cacheRow(overrides = {}) {
  return {
    resumeId: 'rsv_alpha',
    resumeLabel: 'Backend — Go — v3',
    targetRole: 'Backend Engineer',
    targetRoleFamily: 'backend',
    version: 3,
    isDefault: false,
    keywords: '["Go","PostgreSQL"]',
    driveFileId: '1DriVeFiLeIdDoNotLeak',
    driveFileName: 'Vishal_Kumar_Ojha_Backend.pdf',
    extractedText: 'JANE DOE SENIOR BACKEND ENGINEER Go PostgreSQL Kubernetes payments',
    contentHash: 'deadbeef',
    updatedAt: '2026-10-05T09:00:00.000Z',
    lastUsedAt: null,
    schemaVersion: RESUME_CACHE_SCHEMA_VERSION,
    ...overrides,
  };
}

const ROW_A = cacheRow();
const ROW_B = cacheRow({
  resumeId: 'rsv_beta',
  resumeLabel: 'AI Engineer — v2',
  targetRole: 'AI Engineer',
  targetRoleFamily: 'ml',
  keywords: '["Python","PyTorch"]',
  extractedText: 'JANE DOE MACHINE LEARNING ENGINEER Python PyTorch',
});
const ROW_C = cacheRow({
  resumeId: 'rsv_gamma',
  resumeLabel: 'FDE — v4',
  targetRole: 'Forward Deployed Engineer',
  targetRoleFamily: 'backend',
  keywords: '["Go","Kafka"]',
  extractedText: 'JANE DOE FORWARD DEPLOYED ENGINEER Go Kafka',
});

const VALID_OUTPUT = {
  selectedResumeId: 'rsv_alpha',
  matchScore: 91,
  matchBreakdown: {
    mustHave: 94,
    niceToHave: 84,
    seniority: 90,
    roleAlignment: 95,
    technologyAlignment: 89,
  },
  rationales: {
    mustHave: 'Production Go and PostgreSQL work covers every requirement.',
    niceToHave: 'Kubernetes appears in project work only.',
    seniority: 'Seven years of backend experience fits the senior level.',
    roleAlignment: 'Payments platform work is directly comparable.',
    technologyAlignment: 'Go, PostgreSQL and Kubernetes appear in experience.',
  },
  rankings: [
    { resumeId: 'rsv_alpha', score: 91 },
    { resumeId: 'rsv_beta', score: 82 },
    { resumeId: 'rsv_gamma', score: 74 },
  ],
};

const CONFIG = {
  anthropicApiKey: 'test-key',
  anthropicModel: 'claude-test-model',
  resumeSheetId: 'sheet-for-tests',
  resumeSheetTab: 'Resumes',
};

const MATCH_KEYS = ['jobId', 'matchBreakdown', 'matchScore', 'rankings', 'schemaVersion', 'selectedResumeId'];

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

function tabValues(rows) {
  return [RESUME_CACHE_HEADERS, ...rows.map((row) => RESUME_CACHE_HEADERS.map((header) => row[header] ?? ''))];
}

/**
 * An in-memory stand-in for Firestore.
 *
 * Path-addressed rather than collection-addressed, because the thing under test is the
 * exact document path the handler derives from the verified uid.
 */
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
    /**
     * The Admin SDK's transaction API is reads-first, then writes. The fakes resolve the
     * reference through the same `doc()` handle, so a transaction sees the same store and
     * records writes in the same `writes` array as the plain `update` path — which is what
     * lets `writes.length` assertions keep working now that every content write runs here.
     */
    async runTransaction(update) {
      return update({
        get: (ref) => ref.get(),
        update: (ref, patch) => ref.update(patch),
      });
    },
  };
}

function defaultStore() {
  return new Map([[OWN_PATH, jobFixture()]]);
}

/**
 * Runs the handler with a valid request unless overridden.
 *
 * Returns the response plus the store and the recorded writes, so persistence assertions
 * compare the document before and after rather than trusting the handler's own answer.
 */
async function invoke(options = {}) {
  const {
    headers = { authorization: 'Bearer good-token' },
    method = 'POST',
    verifyIdToken = strictVerifier('good-token'),
    complete = async () => JSON.stringify(VALID_OUTPUT),
    loadConfig,
    logger = silentLogger(),
    rows = [ROW_A, ROW_B, ROW_C],
    store = defaultStore(),
    db = fakeDb(store),
  } = options;
  // `body` and `config` are read by presence rather than by destructuring default, because
  // several cases need to hand over an explicit `undefined` and mean it.
  const body = 'body' in options ? options.body : { jobId: JOB_ID };
  const config = 'config' in options ? options.config : CONFIG;
  const sheets = 'sheets' in options ? options.sheets : fakeSheets(tabValues(rows));

  const handler = createHandler({
    verifyIdToken,
    complete,
    config,
    loadConfig,
    logger,
    sheets,
    db,
  });
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

// ─── Job authorization ─────────────────────────────────────────────────────────

test('the verified uid decides which document is read and written', async () => {
  const { res, db } = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].path, OWN_PATH, 'the write must land under the verified uid');
});

test('a uid supplied in the body is ignored', async () => {
  // A document exists under somebody else's path. If the body were trusted, this would
  // succeed by reading and writing it.
  const store = new Map([
    [OWN_PATH, jobFixture()],
    [`users/attacker/jobs/${JOB_ID}`, jobFixture({ company: 'Not Ours Inc' })],
  ]);
  const { res, db } = await invoke({
    store,
    body: { jobId: JOB_ID, uid: 'attacker', selectedResumeId: 'rsv_fake' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(db.writes[0].path, OWN_PATH);
  assert.equal(db.store.get(`users/attacker/jobs/${JOB_ID}`).company, 'Not Ours Inc');
  assert.equal(db.store.get(`users/attacker/jobs/${JOB_ID}`).selectedResumeId, null);
  assert.equal(
    db.store.get(OWN_PATH).selectedResumeId,
    'rsv_alpha',
    'the caller-supplied resume id must never be written',
  );
});

test("another user's job is reported as not found, not as forbidden", async () => {
  // The document only exists under a different uid, so the verified caller's path is empty.
  const store = new Map([[`users/other/jobs/${JOB_ID}`, jobFixture()]]);
  const { res, db } = await invoke({ store });

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Job not found.' });
  assert.equal(db.writes.length, 0);
});

test('a non-existent job is a safe 404', async () => {
  const { res, db } = await invoke({ store: new Map() });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Job not found.' });
  assert.equal(db.writes.length, 0);
});

test('a legacy, unversioned tracker document is not matchable', async () => {
  const store = new Map([[OWN_PATH, { company: 'Legacy Co', role: 'Developer' }]]);
  const { res, db } = await invoke({ store });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Job not found.' });
  assert.equal(db.writes.length, 0, 'a legacy document must never be written to');
});

test('an unconfirmed job is refused with 409', async () => {
  const store = new Map([[OWN_PATH, jobFixture({ intakeStatus: 'parsed' })]]);
  const { res, db } = await invoke({ store });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'This job must be confirmed before it can be matched.' });
  assert.equal(db.writes.length, 0);
});

test('a job id that cannot address a document is a 400', async () => {
  for (const jobId of ['', null, 42, 'a/b', '../../etc/passwd']) {
    const { res } = await invoke({ body: { jobId } });
    assert.equal(res.statusCode, 400, `${JSON.stringify(jobId)} must be rejected`);
    assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
  }
  const { res: noBody } = await invoke({ body: undefined });
  assert.equal(noBody.statusCode, 400);
});

test('a body that is not valid JSON is a 400, not a 500', async () => {
  const { res } = await invoke({ body: '{not json' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'The request body was not valid JSON.');
});

// ─── Configuration ─────────────────────────────────────────────────────────────

test('an unconfigured server reports a safe 404 after authentication', async () => {
  const { res } = await invoke({
    loadConfig: () => {
      throw new ConfigError(['ANTHROPIC_API_KEY']);
    },
    config: undefined,
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Resume matching is not configured on the server.');
});

test('an injected configuration that is missing a variable is a 404, not a 500', async () => {
  const { res } = await invoke({ config: { resumeSheetId: 'sheet-for-tests' } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Resume matching is not configured on the server.');
});

test('configuration is not read before the token is verified', async () => {
  let read = false;
  const { res } = await invoke({
    headers: {},
    config: undefined,
    loadConfig: () => {
      read = true;
      return CONFIG;
    },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(read, false, 'an anonymous probe must not trigger configuration loading');
});

// ─── Resume input ──────────────────────────────────────────────────────────────

test('the whole Resume Library becomes the candidate set', async () => {
  const prompts = [];
  const { res } = await invoke({
    complete: async (args) => {
      prompts.push(args.user);
      return JSON.stringify(VALID_OUTPUT);
    },
  });

  assert.equal(res.statusCode, 200);
  for (const id of ['rsv_alpha', 'rsv_beta', 'rsv_gamma']) {
    assert.ok(prompts[0].includes(`<candidate id="${id}">`), `${id} must be sent to the model`);
  }
});

test('an empty resume library is a 409 and never reaches the model', async () => {
  let called = false;
  const { res } = await invoke({
    rows: [],
    complete: async () => {
      called = true;
      return JSON.stringify(VALID_OUTPUT);
    },
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'There are no usable resumes to match against.' });
  assert.equal(called, false);
});

test('rows with no usable label or id are skipped rather than guessed at', async () => {
  const rows = [
    cacheRow({ resumeId: '', resumeLabel: '' }),
    cacheRow({ resumeLabel: '', driveFileName: '' }),
    cacheRow({ schemaVersion: 0 }),
  ];
  const { res } = await invoke({ rows });
  assert.equal(res.statusCode, 409, 'nothing usable means nothing to match against');
});

test('a resume with no extracted text is never sent to the model', async () => {
  let prompt = '';
  const { res } = await invoke({
    rows: [cacheRow({ extractedText: '' }), ROW_B],
    complete: async (args) => {
      prompt = args.user;
      return JSON.stringify({ ...VALID_OUTPUT, selectedResumeId: 'rsv_beta', matchScore: 82, rankings: [{ resumeId: 'rsv_beta', score: 82 }] });
    },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(!prompt.includes('rsv_alpha'), 'a resume with no text must be excluded');
  assert.ok(prompt.includes('<candidate id="rsv_beta">'));
  assert.equal(res.body.selectedResumeId, 'rsv_beta');
});

// ─── Claude output validation ──────────────────────────────────────────────────

test('a valid model response is accepted and mapped into the domain shape', async () => {
  const { res } = await invoke();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), MATCH_KEYS);
  assert.equal(res.body.schemaVersion, MATCH_SCHEMA_VERSION);
  assert.equal(res.body.jobId, JOB_ID);
  assert.equal(res.body.selectedResumeId, 'rsv_alpha');
  assert.equal(res.body.matchScore, 91);
  assert.equal(res.body.rankings.length, 3);
  assert.deepEqual(
    res.body.matchBreakdown.map((entry) => entry.criterion),
    ['must_have', 'nice_to_have', 'seniority', 'role_alignment', 'technology_alignment'],
  );
  const mustHave = res.body.matchBreakdown.find((entry) => entry.criterion === 'must_have');
  assert.equal(mustHave.score, 94);
  assert.equal(mustHave.rationale, 'Production Go and PostgreSQL work covers every requirement.');
});

/**
 * Every shape the model could plausibly produce that must be rejected, and the reason it
 * must be rejected. None of these may be repaired, clamped, or defaulted: a number that is
 * wrong is an error, not a hint.
 */
const INVALID_OUTPUTS = [
  ['matchScore below range', { matchScore: -1 }],
  ['matchScore above range', { matchScore: 101 }],
  ['matchScore not an integer', { matchScore: 91.5 }],
  ['matchScore as a string', { matchScore: '91' }],
  ['mustHave below range', { matchBreakdown: { ...VALID_OUTPUT.matchBreakdown, mustHave: -5 } }],
  ['mustHave above range', { matchBreakdown: { ...VALID_OUTPUT.matchBreakdown, mustHave: 1000 } }],
  ['breakdown value not an integer', { matchBreakdown: { ...VALID_OUTPUT.matchBreakdown, seniority: 70.5 } }],
  ['a missing breakdown key', { matchBreakdown: { ...VALID_OUTPUT.matchBreakdown, technologyAlignment: undefined } }],
  ['a ranking below range', { rankings: [{ resumeId: 'rsv_alpha', score: -1 }] }],
  ['a ranking above range', { rankings: [{ resumeId: 'rsv_alpha', score: 900 }] }],
  ['unknown resume id selected', { selectedResumeId: 'rsv_nope' }],
  ['unknown resume id ranked', { rankings: [{ resumeId: 'rsv_nope', score: 91 }] }],
  ['duplicate ranking ids', { rankings: [{ resumeId: 'rsv_alpha', score: 91 }, { resumeId: 'rsv_alpha', score: 90 }] }],
  ['selected resume absent from rankings', { rankings: [{ resumeId: 'rsv_beta', score: 82 }, { resumeId: 'rsv_gamma', score: 74 }] }],
  ['selected resume absent from candidate set', { selectedResumeId: 'rsv_zzz' }],
  ['an empty rankings list', { rankings: [] }],
  ['rankings as a list of scalars', { rankings: ['rsv_alpha'] }],
  ['rankings unsorted', { rankings: [{ resumeId: 'rsv_alpha', score: 82 }, { resumeId: 'rsv_beta', score: 91 }] }],
  ['ranking score disagreeing with matchScore', { matchScore: 77 }],
];

for (const [label, patch] of INVALID_OUTPUTS) {
  test(`rejects ${label} with a fixed 500`, async () => {
    const { res, db } = await invoke({
      complete: async () => JSON.stringify({ ...VALID_OUTPUT, ...patch }),
    });
    assert.equal(res.statusCode, 500, label);
    assert.deepEqual(res.body, { error: 'Unable to compute a resume match.' }, label);
    assert.equal(db.writes.length, 0, `${label} must never be persisted`);
  });
}

test('malformed JSON from the model is a fixed 500', async () => {
  for (const raw of ['{not json', '{"selectedResumeId":', '']) {
    const { res, db } = await invoke({ complete: async () => raw });
    assert.equal(res.statusCode, 500, JSON.stringify(raw));
    assert.deepEqual(res.body, { error: 'Unable to compute a resume match.' });
    assert.equal(db.writes.length, 0);
  }
});

test('a non-JSON model response is a fixed 500', async () => {
  for (const raw of ['Here is the best resume: rsv_alpha with 91 points.', '[]', '"rsv_alpha"', '42', 'null']) {
    const { res, db } = await invoke({ complete: async () => raw });
    assert.equal(res.statusCode, 500, JSON.stringify(raw));
    assert.deepEqual(res.body, { error: 'Unable to compute a resume match.' });
    assert.equal(db.writes.length, 0);
  }
});

test('prose around the JSON is not silently accepted', async () => {
  const { res, db } = await invoke({
    complete: async () => `Sure! ${JSON.stringify(VALID_OUTPUT)} Hope that helps.`,
  });
  assert.equal(res.statusCode, 500);
  assert.equal(db.writes.length, 0);
});

// ─── Persistence ───────────────────────────────────────────────────────────────

test('only the three match-owned fields are ever written', async () => {
  const before = jobFixture();
  const { res, db } = await invoke();
  assert.equal(res.statusCode, 200);

  assert.equal(db.writes.length, 1, 'exactly one update must be issued');
  assert.deepEqual(
    Object.keys(db.writes[0].patch).sort(),
    ['matchBreakdown', 'matchScore', 'selectedResumeId'],
    'the update must carry only match-owned fields',
  );

  const after = db.store.get(OWN_PATH);
  const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
  assert.deepEqual(changed.sort(), ['matchBreakdown', 'matchScore', 'selectedResumeId']);
});

test('approval, application, drafting, contact and sheet fields are untouched', async () => {
  const before = jobFixture();
  const { res, db } = await invoke();
  assert.equal(res.statusCode, 200);
  const after = db.store.get(OWN_PATH);

  const owned = new Set(['selectedResumeId', 'matchScore', 'matchBreakdown']);
  for (const key of Object.keys(before)) {
    if (owned.has(key)) continue;
    assert.deepEqual(after[key], before[key], `field "${key}" must not change`);
  }
});

test('matchScore is never written as anything but an integer', async () => {
  const { res, db } = await invoke();
  assert.equal(res.statusCode, 200);
  const written = db.writes[0].patch.matchScore;
  assert.equal(typeof written, 'number');
  assert.ok(Number.isInteger(written));
  assert.ok(written >= 0 && written <= 100);
  assert.equal(written, db.store.get(OWN_PATH).matchScore);
});

test('re-running the match replaces only the match-owned fields', async () => {
  const store = defaultStore();
  const first = await invoke({ store });
  assert.equal(first.res.statusCode, 200);

  const draftBefore = store.get(OWN_PATH).draftMessage;
  const approvalBefore = store.get(OWN_PATH).approvalStatus;

  const second = await invoke({
    store,
    complete: async () =>
      JSON.stringify({
        ...VALID_OUTPUT,
        selectedResumeId: 'rsv_gamma',
        matchScore: 64,
        rankings: [
          { resumeId: 'rsv_gamma', score: 64 },
          { resumeId: 'rsv_alpha', score: 40 },
        ],
      }),
  });
  assert.equal(second.res.statusCode, 200);

  const after = store.get(OWN_PATH);
  assert.equal(after.selectedResumeId, 'rsv_gamma');
  assert.equal(after.matchScore, 64);
  assert.equal(after.draftMessage, draftBefore, 'a re-match must not touch the draft');
  assert.equal(after.approvalStatus, approvalBefore, 'a re-match must not touch approval');
  assert.deepEqual(second.db.writes.map((write) => Object.keys(write.patch).sort()), [
    ['matchBreakdown', 'matchScore', 'selectedResumeId'],
  ]);
});

// ─── Security ──────────────────────────────────────────────────────────────────

test('the response never carries resume text or Drive metadata', async () => {
  const { res } = await invoke();
  const serialised = JSON.stringify(res.body);

  assert.ok(!serialised.includes('extractedText'), 'extracted text must not be echoed');
  assert.ok(!serialised.includes('1DriVeFiLeIdDoNotLeak'), 'the Drive file id must not be echoed');
  assert.ok(!serialised.includes('Vishal_Kumar_Ojha_Backend.pdf'), 'the Drive file name must not be echoed');
  assert.ok(!serialised.includes('JANE DOE'), 'no part of any resume corpus may reach the client');
  for (const key of Object.keys(res.body)) {
    assert.ok(!key.includes('drive'), `unexpected field ${key}`);
  }
});

test('the response carries no field outside the published contract', async () => {
  const { res } = await invoke();
  assert.deepEqual(Object.keys(res.body).sort(), MATCH_KEYS);
  assert.deepEqual(Object.keys(res.body).sort(), ['jobId', 'matchBreakdown', 'matchScore', 'rankings', 'schemaVersion', 'selectedResumeId']);
  for (const entry of res.body.matchBreakdown) {
    assert.deepEqual(Object.keys(entry).sort(), ['criterion', 'rationale', 'score', 'weight']);
  }
  for (const ranking of res.body.rankings) {
    assert.deepEqual(Object.keys(ranking).sort(), ['resumeId', 'score']);
  }
});

test('provider failure detail never reaches the client or the log', async () => {
  const secret = 'provider-api-key-value-DO-NOT-LEAK';
  const failing = async () => {
    throw new Error(`https://api.anthropic.com/v1/messages ${secret}`);
  };
  const { res, logger } = await invoke({ complete: failing });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to compute a resume match.' });
  assert.ok(!JSON.stringify(res.body).includes('anthropic'));
  assert.ok(!JSON.stringify(res.body).includes(secret));
  assert.ok(!JSON.stringify(logger.entries).includes(secret), 'the provider error must not be logged verbatim');
});

test('a persistence failure is a fixed 500 that leaks no storage detail', async () => {
  const { res } = await invoke({
    store: new Map(),
    // The read path sees a document, the write path does not: the job disappears under us.
    db: {
      doc(path) {
        return {
          async get() {
            return { exists: true, data: () => jobFixture() };
          },
          async update() {
            const error = new Error('PERMISSION_DENIED: missing or insufficient permissions');
            error.code = 'permission-denied';
            throw error;
          },
        };
      },
    },
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to save the resume match.' });
  assert.ok(!JSON.stringify(res.body).includes('PERMISSION_DENIED'));
});

test('a Sheets failure is a fixed 500 that leaks no spreadsheet detail', async () => {
  const { res } = await invoke({
    sheets: {
      spreadsheets: {
        values: {
          get: async () => {
            throw new Error('Unable to parse range "Resumes!A:Z" for sheet-for-tests');
          },
        },
      },
    },
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'The resume library is temporarily unavailable.' });
  assert.ok(!JSON.stringify(res.body).includes('sheet-for-tests'));
});

test('a job read failure is a fixed 500 that leaks no document path', async () => {
  const { res } = await invoke({
    db: {
      doc() {
        return {
          async get() {
            throw new Error('PERMISSION_DENIED: users/user-1/jobs/job-1');
          },
          async update() {},
        };
      },
    },
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to load this job.' });
  assert.ok(!JSON.stringify(res.body).includes('users/user-1'));
});
