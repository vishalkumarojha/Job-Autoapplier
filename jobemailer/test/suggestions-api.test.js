/**
 * Tests for `POST /api/suggestions`, focused on the authentication and authorization
 * boundary, on the three 409 preconditions that stop a suggestion pass running without an
 * existing match, on proving that only `resumeSuggestions` is ever written, and on proving
 * that resume text, Drive identifiers, and provider errors never reach the client.
 *
 * Runs on `node:test`. No Firebase project, no Google credential, and no Anthropic account
 * is involved: the token verifier, the Firestore handle, the Sheets client, the model
 * response, and the configuration are all injected, so these cases exercise the real
 * handler while contacting nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler, fakeResponse } from '../api/suggestions.js';
import { ConfigError } from '../lib/config.js';
import { SUGGESTION_MAX, SUGGESTION_SCHEMA_VERSION } from '../lib/suggestions.js';
import { RESUME_CACHE_HEADERS, RESUME_CACHE_SCHEMA_VERSION } from '../lib/resume-cache.js';

const UID = 'user-1';
const JOB_ID = 'job-1';
const OWN_PATH = `users/${UID}/jobs/${JOB_ID}`;
const RESUME_ID = 'rsv_alpha';

/**
 * The posting is deliberately richer than the resume: it demands Kubernetes and five
 * years of experience, and the selected resume demonstrates neither. Every fabrication
 * case below depends on that gap.
 */
const POSTING = `Senior Backend Engineer — Example Corp
We are hiring a Senior Backend Engineer to own our payments platform.
Required: Kubernetes, PostgreSQL, and 5 years of experience.
Send your CV to priya.sharma@example.com.`;

/** A complete canonical Job already through matching. Nothing here may change. */
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
      { criterion: 'seniority', score: 90, weight: 0.2, rationale: 'Backend experience fits the senior level.' },
      { criterion: 'role_alignment', score: 95, weight: 0.2, rationale: 'Payments work is comparable.' },
      { criterion: 'technology_alignment', score: 89, weight: 0.1, rationale: 'Go and PostgreSQL appear in experience.' },
    ],
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
const ROW_BETA = cacheRow({
  resumeId: 'rsv_beta',
  resumeLabel: 'AI Engineer — v2',
  targetRole: 'AI Engineer',
  extractedText: 'JANE DOE MACHINE LEARNING ENGINEER Python PyTorch',
});

/** Every field of a suggestion, grounded in the posting or the selected resume. */
const VALID_SUGGESTION = {
  id: 'sug_001',
  priority: 'high',
  category: 'skill_emphasis',
  actionType: 'reorder_or_emphasize',
  title: 'Highlight PostgreSQL work',
  suggestion: 'Reorder the PostgreSQL bullet above the payments summary.',
  jobEvidence: 'Required: Kubernetes, PostgreSQL, and 5 years of experience.',
  resumeEvidence: 'The resume already demonstrates PostgreSQL in the payments platform.',
};

const VALID_OUTPUT = { schemaVersion: SUGGESTION_SCHEMA_VERSION, suggestions: [VALID_SUGGESTION] };

const CONFIG = {
  anthropicApiKey: 'test-key',
  anthropicModel: 'claude-test-model',
  resumeSheetId: 'sheet-for-tests',
  resumeSheetTab: 'Resumes',
};

const RESPONSE_KEYS = ['jobId', 'schemaVersion', 'suggestions'];

/** Fields that suggestions do not own and must never touch. */
const PROTECTED_FIELDS = [
  'company', 'role', 'jobUrl', 'contactEmail', 'deadline', 'rawText', 'rawSource',
  'intakeStatus', 'selectedResumeId', 'matchScore', 'matchBreakdown',
  'approvalStatus', 'applicationStatus', 'draftMessage', 'draftSubject', 'dedupeKey',
  'sheetRowId', 'sheetSyncStatus', 'sheetSyncedAt', 'gmailThreadId', 'emailSentOn',
];

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
 * Returns the response plus the logger, the store, and the recorded writes, so persistence
 * assertions compare the document before and after rather than trusting the handler's own
 * answer.
 */
async function invoke(options = {}) {
  const {
    headers = { authorization: 'Bearer good-token' },
    method = 'POST',
    verifyIdToken = strictVerifier('good-token'),
    complete = async () => JSON.stringify(VALID_OUTPUT),
    loadConfig,
    logger = silentLogger(),
    rows = [ROW_ALPHA, ROW_BETA],
    store = defaultStore(),
    db = fakeDb(store),
  } = options;
  const body = 'body' in options ? options.body : { jobId: JOB_ID };
  const config = 'config' in options ? options.config : CONFIG;
  const sheets = 'sheets' in options ? options.sheets : fakeSheets(tabValues(rows));

  const handler = createHandler({ verifyIdToken, complete, config, loadConfig, logger, sheets, db });
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

test('a uid or resumeId supplied in the body is ignored', async () => {
  const store = new Map([
    [OWN_PATH, jobFixture()],
    ['users/attacker/jobs/job-1', jobFixture({ company: 'Not Ours Inc' })],
  ]);
  const { res, db } = await invoke({
    store,
    body: { jobId: JOB_ID, uid: 'attacker', resumeId: 'rsv_beta', extractedText: 'IGNORED' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(db.writes[0].path, OWN_PATH);
  assert.equal(db.store.get('users/attacker/jobs/job-1').company, 'Not Ours Inc');
  assert.equal(db.store.get('users/attacker/jobs/job-1').resumeSuggestions, null);
  assert.equal(
    db.store.get(OWN_PATH).selectedResumeId,
    RESUME_ID,
    'the caller-supplied resume id must never take effect',
  );
});

test("another user's job is reported as not found, not as forbidden", async () => {
  const store = new Map([['users/other/jobs/job-1', jobFixture()]]);
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

test('a legacy, unversioned tracker document is not suggestable', async () => {
  const store = new Map([[OWN_PATH, { company: 'Legacy Co', role: 'Developer' }]]);
  const { res, db } = await invoke({ store });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Job not found.' });
  assert.equal(db.writes.length, 0, 'a legacy document must never be written to');
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

// ─── Preconditions: suggestions are derived from an existing match ─────────────

test('an unconfirmed job is refused with 409', async () => {
  const store = new Map([[OWN_PATH, jobFixture({ intakeStatus: 'parsed' })]]);
  const { res, db } = await invoke({ store });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'This job must be confirmed before suggestions can be generated.' });
  assert.equal(db.writes.length, 0);
});

test('a job with no selected resume is 409 and never reaches the model', async () => {
  let called = false;
  const store = new Map([[OWN_PATH, jobFixture({ selectedResumeId: null })]]);
  const { res, db } = await invoke({
    store,
    complete: async () => {
      called = true;
      return JSON.stringify(VALID_OUTPUT);
    },
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'This job has no selected resume. Run a match first.' });
  assert.equal(called, false);
  assert.equal(db.writes.length, 0);
});

test('a selected resume with no match breakdown is 409 and never reaches the model', async () => {
  for (const matchBreakdown of [null, undefined, [], 'not-an-array']) {
    let called = false;
    const store = new Map([[OWN_PATH, jobFixture({ matchBreakdown })]]);
    const { res, db } = await invoke({
      store,
      complete: async () => {
        called = true;
        return JSON.stringify(VALID_OUTPUT);
      },
    });
    assert.equal(res.statusCode, 409, `${JSON.stringify(matchBreakdown)} must be refused`);
    assert.deepEqual(res.body, { error: 'This job has no match breakdown. Run a match first.' });
    assert.equal(called, false);
    assert.equal(db.writes.length, 0);
  }
});

test('no fallback runs when the match is incomplete: no re-match, no earlier resume', async () => {
  // The Job points at a resume the library no longer holds. The tempting repair is to
  // pick whichever resume is nearest, which would produce advice about the wrong document.
  let called = false;
  const store = new Map([[OWN_PATH, jobFixture({ selectedResumeId: 'rsv_gone' })]]);
  const { res, db } = await invoke({
    store,
    rows: [ROW_ALPHA, ROW_BETA],
    complete: async () => {
      called = true;
      return JSON.stringify(VALID_OUTPUT);
    },
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'The selected resume is no longer available in the resume library.' });
  assert.equal(called, false);
  assert.equal(db.writes.length, 0);
});

test('a selected resume whose text has been emptied is the same 409', async () => {
  const { res } = await invoke({ rows: [cacheRow({ extractedText: '   ' })] });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'The selected resume is no longer available in the resume library.' });
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
  assert.equal(res.body.error, 'Resume suggestions are not configured on the server.');
});

test('an injected configuration that is missing a variable is a 404, not a 500', async () => {
  const { res } = await invoke({ config: { resumeSheetId: 'sheet-for-tests' } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Resume suggestions are not configured on the server.');
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

// ─── What is sent to the model ─────────────────────────────────────────────────

test('only the selected resume is sent, and only its text', async () => {
  const prompts = [];
  const { res } = await invoke({
    complete: async (args) => {
      prompts.push(args.user);
      return JSON.stringify(VALID_OUTPUT);
    },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(prompts[0].includes(`<resume id="${RESUME_ID}"`), 'the selected resume must be sent');
  assert.ok(!prompts[0].includes('rsv_beta'), 'no other resume may be sent');
  assert.ok(prompts[0].includes('<match>'), 'the existing breakdown must be sent as context');
});

test('the prompt never carries Drive identifiers, file names, or credential material', async () => {
  let prompt = '';
  const { res } = await invoke({
    complete: async (args) => {
      prompt = args.user;
      return JSON.stringify(VALID_OUTPUT);
    },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(!prompt.includes('1DriVeFiLeIdDoNotLeak'), 'the Drive file id must never be sent');
  assert.ok(!prompt.includes('Vishal_Kumar_Ojha_Backend.pdf'), 'the Drive file name must never be sent');
  assert.ok(!prompt.includes('test-key'), 'the Anthropic key must never be sent');
  assert.ok(!prompt.includes('sheet-for-tests'), 'the sheet id must never be sent');
});

test('an empty library cannot satisfy the selected-resume precondition', async () => {
  let called = false;
  const { res } = await invoke({
    rows: [],
    complete: async () => {
      called = true;
      return JSON.stringify(VALID_OUTPUT);
    },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(called, false);
});

// ─── Claude output validation ──────────────────────────────────────────────────

test('a valid model response is accepted and mapped into the envelope', async () => {
  const { res } = await invoke();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), RESPONSE_KEYS);
  assert.equal(res.body.schemaVersion, SUGGESTION_SCHEMA_VERSION);
  assert.equal(res.body.jobId, JOB_ID);
  assert.equal(res.body.suggestions.length, 1);
  assert.deepEqual(Object.keys(res.body.suggestions[0]).sort(), [
    'actionType', 'category', 'id', 'jobEvidence', 'priority', 'resumeEvidence', 'suggestion', 'title',
  ]);
});

test('an empty suggestions array is a first-class answer and is persisted as empty, not null', async () => {
  const store = defaultStore();
  const { res } = await invoke({
    store,
    complete: async () => JSON.stringify({ schemaVersion: SUGGESTION_SCHEMA_VERSION, suggestions: [] }),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.suggestions, []);
  assert.deepEqual(store.get(OWN_PATH).resumeSuggestions, {
    schemaVersion: SUGGESTION_SCHEMA_VERSION,
    suggestions: [],
  });
});

/** Structural violations. None may be repaired, defaulted, or silently truncated. */
const INVALID_OUTPUTS = [
  ['suggestions is not an array', { suggestions: 'nope' }],
  ['suggestions is an object', { suggestions: {} }],
  ['more than the maximum', {
    suggestions: Array.from({ length: SUGGESTION_MAX + 1 }, (_, i) => ({ ...VALID_SUGGESTION, id: `sug_${i}` })),
  }],
  ['an entry that is not an object', { suggestions: ['nope'] }],
  ['a missing field', { suggestions: [{ ...VALID_SUGGESTION, jobEvidence: undefined }] }],
  ['an unknown field', { suggestions: [{ ...VALID_SUGGESTION, targetSection: 'skills' }] }],
  ['an unknown priority', { suggestions: [{ ...VALID_SUGGESTION, priority: 'urgent' }] }],
  ['an unknown category', { suggestions: [{ ...VALID_SUGGESTION, category: 'tone' }] }],
  ['an unknown action type', { suggestions: [{ ...VALID_SUGGESTION, actionType: 'add_new_skill' }] }],
  ['an empty title', { suggestions: [{ ...VALID_SUGGESTION, title: '   ' }] }],
  ['an empty suggestion', { suggestions: [{ ...VALID_SUGGESTION, suggestion: '' }] }],
  ['an id with disallowed characters', { suggestions: [{ ...VALID_SUGGESTION, id: 'sug 001!' }] }],
  ['duplicate ids', { suggestions: [VALID_SUGGESTION, { ...VALID_SUGGESTION }] }],
  ['a future schema version', { schemaVersion: 2, suggestions: [VALID_SUGGESTION] }],
  ['a non-object payload', { nope: true }],
];

test('every structurally invalid model response is a fixed 500', async () => {
  for (const [name, output] of INVALID_OUTPUTS) {
    const { res, db } = await invoke({ complete: async () => JSON.stringify(output) });
    assert.equal(res.statusCode, 500, name);
    assert.deepEqual(res.body, { error: 'Unable to generate resume suggestions.' }, name);
    assert.equal(db.writes.length, 0, `${name} must not be persisted`);
  }
});

test('model output that is not JSON at all is a fixed 500', async () => {
  const { res, db } = await invoke({ complete: async () => 'I could not do that.' });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to generate resume suggestions.' });
  assert.equal(db.writes.length, 0);
});

// ─── Fabrication safeguards ────────────────────────────────────────────────────

/**
 * Every claim the model could invent that neither the posting nor the resume supports.
 *
 * Each case changes exactly one field of an otherwise valid answer, so a rejection proves
 * the guard caught the fabrication rather than a structural problem with the fixture.
 */
const FABRICATIONS = [
  ['an invented percentage', { resumeEvidence: 'Improved throughput by 40%.' }],
  ['an invented duration', { resumeEvidence: 'Three years of PostgreSQL work.' }],
  ['an invented employer', { resumeEvidence: 'The payments platform is built at Google.' }],
  ['an invented project', { resumeEvidence: 'Led the Atlas project end to end.' }],
  ['an invented certification', { resumeEvidence: 'The resume lists a certification in payments.' }],
  ['an invented metric in the advice', { suggestion: 'Quantify the work by adding a 40% throughput figure.' }],
  ['adding a requirement the resume does not meet', {
    suggestion: 'Add Kubernetes experience to the summary.',
    title: 'Add Kubernetes experience',
  }],
];

test('every fabrication is refused with the same fixed 500 and is never persisted', async () => {
  for (const [name, patch] of FABRICATIONS) {
    const output = { schemaVersion: SUGGESTION_SCHEMA_VERSION, suggestions: [{ ...VALID_SUGGESTION, ...patch }] };
    const { res, db, logger } = await invoke({ complete: async () => JSON.stringify(output) });

    assert.equal(res.statusCode, 500, name);
    assert.deepEqual(res.body, { error: 'Unable to generate resume suggestions.' }, name);
    assert.equal(db.writes.length, 0, `${name} must not be persisted`);
    assert.equal(db.store.get(OWN_PATH).resumeSuggestions, null, `${name} must leave the Job untouched`);

    const logged = JSON.stringify(logger.entries);
    assert.ok(logged.includes('fabrication guard:'), `${name} must name the rule that failed in the server log`);
    assert.ok(!JSON.stringify(res.body).includes('40'), `${name} must not echo the model's text back`);
  }
});

test('the offending model text is logged by rule name but never returned', async () => {
  const output = { schemaVersion: SUGGESTION_SCHEMA_VERSION, suggestions: [{ ...VALID_SUGGESTION, resumeEvidence: 'The payments platform is built at Google.' }] };
  const { res, logger } = await invoke({ complete: async () => JSON.stringify(output) });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to generate resume suggestions.' });
  const logged = JSON.stringify(logger.entries);
  assert.ok(logged.includes('Google'), 'the server log must name what failed so the pattern is visible');
  assert.ok(!JSON.stringify(res.body).includes('Google'), 'the client must never see it');
});

test('a legitimate paraphrase of the two sources is accepted', async () => {
  // Not a quote: reordered, reworded, and no number or name the sources lack. If this were
  // rejected, the guards would be blocking exactly the advice the feature exists to give.
  const output = {
    schemaVersion: SUGGESTION_SCHEMA_VERSION,
    suggestions: [{
      ...VALID_SUGGESTION,
      id: 'sug_002',
      priority: 'medium',
      category: 'keyword_coverage',
      actionType: 'rewrite_existing_bullet',
      title: 'Name PostgreSQL in the summary',
      suggestion: 'Rewrite the opening summary so PostgreSQL and payments both appear in the first two lines.',
      jobEvidence: 'We are hiring a Senior Backend Engineer to own our payments platform.',
      resumeEvidence: 'Go PostgreSQL payments platform',
    }],
  };
  const { res, db } = await invoke({ complete: async () => JSON.stringify(output) });

  assert.equal(res.statusCode, 200);
  assert.equal(db.store.get(OWN_PATH).resumeSuggestions.suggestions[0].title, 'Name PostgreSQL in the summary');
});

// ─── Persistence ───────────────────────────────────────────────────────────────

test('only resumeSuggestions is written', async () => {
  const before = { ...jobFixture() };
  const { res, db, store } = await invoke();

  assert.equal(res.statusCode, 200);
  assert.equal(db.writes.length, 1);
  assert.deepEqual(Object.keys(db.writes[0].patch), ['resumeSuggestions']);

  const after = store.get(OWN_PATH);
  for (const field of PROTECTED_FIELDS) {
    assert.deepEqual(after[field], before[field], `${field} must be byte-for-byte unchanged`);
  }
  assert.equal(after.company, 'Example Corp');
  assert.equal(after.matchScore, 91);
  assert.equal(after.matchBreakdown.length, 5);
  assert.equal(after.selectedResumeId, RESUME_ID);
  assert.equal(after.draftMessage, 'DRAFT THAT MUST NOT MOVE');
});

test('regenerating replaces resumeSuggestions and still touches nothing else', async () => {
  const store = new Map([[OWN_PATH, jobFixture({
    resumeSuggestions: {
      schemaVersion: SUGGESTION_SCHEMA_VERSION,
      suggestions: [{ ...VALID_SUGGESTION, id: 'sug_old', title: 'An earlier recommendation' }],
    },
  })]]);
  const { res, db } = await invoke({ store });

  assert.equal(res.statusCode, 200);
  assert.equal(db.writes.length, 1);
  assert.deepEqual(Object.keys(db.writes[0].patch), ['resumeSuggestions']);
  const saved = store.get(OWN_PATH).resumeSuggestions;
  assert.equal(saved.suggestions[0].id, 'sug_001');
  assert.notEqual(saved.suggestions[0].title, 'An earlier recommendation');
  assert.equal(store.get(OWN_PATH).matchScore, 91, 'the match must survive a regeneration untouched');
});

test('a failed save is a fixed 500 that says nothing about Firestore', async () => {
  const store = defaultStore();
  const failing = {
    ...store,
    doc(path) {
      return {
        async get() {
          const data = store.get(path);
          return { exists: data !== undefined, data: () => data };
        },
        async update() {
          const error = new Error('PERMISSION_DENIED: Missing or insufficient permissions.');
          error.code = 'permission-denied';
          throw error;
        },
      };
    },
  };
  const { res, logger } = await invoke({ db: failing });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to save the resume suggestions.' });
  assert.ok(!JSON.stringify(res.body).includes('PERMISSION_DENIED'));
  assert.ok(!JSON.stringify(res.body).includes('users/'));
  assert.ok(logger.entries.length > 0, 'the failure must still be logged server-side');
});

// ─── Provider failures ─────────────────────────────────────────────────────────

test('a provider failure is a fixed 500 with no provider detail', async () => {
  const { res, db, logger } = await invoke({
    complete: async () => {
      throw Object.assign(new Error('the provider request failed'), { name: 'ProviderError' });
    },
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to generate resume suggestions.' });
  assert.equal(db.writes.length, 0);
  assert.ok(!JSON.stringify(res.body).includes('anthropic.com'));
  assert.ok(JSON.stringify(logger.entries).includes('Anthropic request failed'));
});

test('an unset Anthropic key is a fixed 500, never a configuration dump', async () => {
  const { res } = await invoke({
    config: { anthropicApiKey: '', resumeSheetId: 'sheet-for-tests' },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Resume suggestions are not configured on the server.' });
});

// ─── What the client sees ──────────────────────────────────────────────────────

test('the response never carries resume text, Drive identifiers, or the prompt', async () => {
  const { res } = await invoke();
  const body = JSON.stringify(res.body);

  assert.ok(!body.includes('JANE DOE'), 'the resume body must never be echoed');
  assert.ok(!body.includes('1DriVeFiLeIdDoNotLeak'), 'the Drive file id must never be echoed');
  assert.ok(!body.includes('Vishal_Kumar_Ojha_Backend.pdf'), 'the Drive file name must never be echoed');
  assert.ok(!body.includes('test-key'), 'the Anthropic key must never be echoed');
  assert.ok(!body.includes('sheet-for-tests'), 'the sheet id must never be echoed');
  assert.ok(!body.includes('You are suggesting'), 'the prompt must never be echoed');
  assert.ok(!body.includes('matchBreakdown'), 'the match payload is not part of this response');
});
