/**
 * Tests for `lib/approval.js`, the pure half of the human review and approval gate.
 *
 * Everything here is a value in and a value out: no Firestore, no Google, no clock, no
 * network. That is deliberate — the state machine is the security boundary of Phase 8, and
 * a boundary nobody can exercise without a cloud project is a boundary nobody maintains.
 *
 * The matrix in "the transition table" is the load-bearing test. It pins all sixteen
 * action/status pairs, so a future edit that quietly lets `approve` run from `draft`, or
 * that lets `review` walk an approved job backwards, fails here rather than in production.
 *
 * Runs on `node:test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_ACTIONS,
  APPROVAL_FIELDS,
  APPROVAL_INVALIDATING_FIELDS,
  ApprovalConflictError,
  ApprovalRequestError,
  ApprovalStateError,
  MESSAGES,
  approvalMaterial,
  approvalPatchFor,
  assertSendApproved,
  isApprovedForSending,
  isReviewable,
  parseApprovalRequest,
  planApprovalTransition,
  reviewPreconditionFailure,
  revocationPatch,
} from '../lib/approval.js';

const UID = 'user-1';
const NOW = '2026-10-06T12:00:00.000Z';

/** Every field the gate is allowed to write, and nothing else. */
const APPROVAL_ONLY_KEYS = ['approvalStatus', 'approvedAt', 'approvedBy'];

/** The six fields whose change revokes an approval. Part M, in order. */
const INVALIDATING = [
  'draftSubject',
  'draftMessage',
  'selectedResumeId',
  'matchScore',
  'matchBreakdown',
  'resumeSuggestions',
];

/** A Job that passes every review precondition. Individual cases flip exactly one field. */
function reviewable(overrides = {}) {
  return {
    schemaVersion: 1,
    intakeStatus: 'confirmed',
    selectedResumeId: 'rsv_alpha',
    matchScore: 91,
    matchBreakdown: [{ criterion: 'must_have', score: 94, weight: 0.35, rationale: 'Stack fits.' }],
    draftSubject: 'Senior Backend Engineer — Example Corp application',
    draftMessage: 'Hi Priya,\n\nI am reaching out.',
    resumeSuggestions: null,
    approvalStatus: 'draft',
    approvedAt: null,
    approvedBy: null,
    company: 'Example Corp',
    applicationStatus: 'sourced',
    ...overrides,
  };
}

// ─── Request parsing ──────────────────────────────────────────────────────────

test('only jobId and action are read from the body', () => {
  const parsed = parseApprovalRequest({
    jobId: 'job-1',
    action: 'approve',
    approvalStatus: 'approved',
    approvedAt: '2026-01-01T00:00:00.000Z',
    approvedBy: 'attacker',
    applicationStatus: 'applied',
    uid: 'someone-else',
  });
  assert.deepEqual(parsed, { jobId: 'job-1', action: 'approve' });
});

test('a non-object body is a 400 with a fixed message', () => {
  for (const body of ['{"jobId":"job-1"}', 42, null, ['job-1']]) {
    assert.throws(
      () => parseApprovalRequest(body),
      (error) => error instanceof ApprovalRequestError && error.reason === 'The request body must be a JSON object.',
      `${JSON.stringify(body)} must be rejected`,
    );
  }
});

test('a missing or blank jobId is reported as required', () => {
  for (const jobId of [undefined, null, 7, '', '   ']) {
    assert.throws(
      () => parseApprovalRequest({ jobId, action: 'review' }),
      (error) => error instanceof ApprovalRequestError && error.reason === 'A jobId is required.',
      `${JSON.stringify(jobId)} must be reported as required`,
    );
  }
});

test('a jobId that could escape the document path is rejected', () => {
  for (const jobId of ['../secrets', 'users/x/jobs', 'a'.repeat(129), 'job id', 'job/1']) {
    assert.throws(
      () => parseApprovalRequest({ jobId, action: 'review' }),
      (error) => error instanceof ApprovalRequestError && error.reason === 'That jobId is not valid.',
      `${jobId} must be rejected`,
    );
  }
});

test('a missing or unknown action is a 400', () => {
  for (const action of [undefined, null, 7, '', '   ']) {
    assert.throws(
      () => parseApprovalRequest({ jobId: 'job-1', action }),
      (error) => error instanceof ApprovalRequestError && error.reason === 'An action is required.',
      `${JSON.stringify(action)} must be reported as required`,
    );
  }
  for (const action of ['send', 'APPROVE', 'force', 'approved']) {
    assert.throws(
      () => parseApprovalRequest({ jobId: 'job-1', action }),
      (error) => error instanceof ApprovalRequestError && error.reason === 'That action is not supported.',
      `${JSON.stringify(action)} must be rejected`,
    );
  }
});

test('the four supported actions are the whole vocabulary', () => {
  assert.deepEqual([...APPROVAL_ACTIONS].sort(), ['approve', 'reject', 'reopen', 'review']);
  for (const action of APPROVAL_ACTIONS) {
    assert.deepEqual(parseApprovalRequest({ jobId: 'job-1', action }), { jobId: 'job-1', action });
  }
});

test('surrounding whitespace on jobId and action is trimmed, not accepted raw', () => {
  assert.deepEqual(parseApprovalRequest({ jobId: '  job-1  ', action: '  approve  ' }), {
    jobId: 'job-1',
    action: 'approve',
  });
});

// ─── Review preconditions ─────────────────────────────────────────────────────

test('a complete application is reviewable', () => {
  assert.equal(reviewPreconditionFailure(reviewable()), null);
  assert.equal(isReviewable(reviewable()), true);
});

test('each unmet precondition is reported on its own, in diagnosis order', () => {
  const cases = [
    [{ intakeStatus: 'drafting' }, MESSAGES.unconfirmed],
    [{ intakeStatus: undefined }, MESSAGES.unconfirmed],
    [{ selectedResumeId: '' }, MESSAGES.noSelectedResume],
    [{ selectedResumeId: null }, MESSAGES.noSelectedResume],
    [{ matchBreakdown: [] }, MESSAGES.noMatch],
    [{ matchScore: undefined }, MESSAGES.noMatch],
    [{ draftSubject: '   ' }, MESSAGES.noDraft],
    [{ draftMessage: '' }, MESSAGES.noDraft],
  ];
  for (const [override, expected] of cases) {
    const failure = reviewPreconditionFailure(reviewable(override));
    assert.equal(failure, expected, `${JSON.stringify(override)} must report ${expected}`);
    assert.equal(isReviewable(reviewable(override)), false);
  }
});

test('a reviewable document that is missing approval fields still reads as reviewable', () => {
  const { approvalStatus, approvedAt, approvedBy, ...withoutApproval } = reviewable();
  assert.equal(reviewPreconditionFailure(withoutApproval), null);
  assert.ok(approvalStatus && approvedAt === null && approvedBy === null);
});

// ─── The transition table ─────────────────────────────────────────────────────

/**
 * All sixteen action/status pairs, pinned.
 *
 * `ok` is the resulting status when the action is legal; `changed: false` marks the
 * idempotent cases that must answer 200 without writing. `error` is the verbatim 409 a
 * caller receives, so the messages users see cannot drift without a test noticing.
 */
const MATRIX = [
  // status: draft
  { status: 'draft', action: 'review', ok: 'pending_review', changed: true },
  { status: 'draft', action: 'approve', error: MESSAGES.notInReview },
  { status: 'draft', action: 'reject', error: MESSAGES.notInReview },
  { status: 'draft', action: 'reopen', error: MESSAGES.nothingToReopen },
  // status: pending_review
  { status: 'pending_review', action: 'review', ok: 'pending_review', changed: false },
  { status: 'pending_review', action: 'approve', ok: 'approved', changed: true },
  { status: 'pending_review', action: 'reject', ok: 'rejected', changed: true },
  { status: 'pending_review', action: 'reopen', ok: 'pending_review', changed: false },
  // status: approved
  { status: 'approved', action: 'review', error: MESSAGES.alreadyApproved },
  { status: 'approved', action: 'approve', ok: 'approved', changed: false },
  { status: 'approved', action: 'reject', error: MESSAGES.alreadyApproved },
  { status: 'approved', action: 'reopen', ok: 'pending_review', changed: true },
  // status: rejected
  { status: 'rejected', action: 'review', ok: 'pending_review', changed: true },
  { status: 'rejected', action: 'approve', error: MESSAGES.rejectedNeedsReopen },
  { status: 'rejected', action: 'reject', ok: 'rejected', changed: false },
  { status: 'rejected', action: 'reopen', ok: 'pending_review', changed: true },
];

test('the transition table', () => {
  assert.equal(MATRIX.length, 16, 'every action must be pinned against every status');
  for (const entry of MATRIX) {
    const label = `${entry.action} from ${entry.status}`;
    if (entry.error) {
      assert.throws(
        () => planApprovalTransition(entry.status, entry.action),
        (error) => error instanceof ApprovalStateError && error.reason === entry.error,
        `${label} must be refused with "${entry.error}"`,
      );
      continue;
    }
    const plan = planApprovalTransition(entry.status, entry.action);
    assert.equal(plan.status, entry.ok, `${label} must land on ${entry.ok}`);
    assert.equal(plan.changed, entry.changed, `${label} changed flag`);
  }
});

test('approve never transitions to approved except from pending_review', () => {
  // `approved` is the one exception: it is idempotent, not an error, so a double-tap
  // answers 200 instead of surprising the user. `draft` and `rejected` are hard stops.
  assert.deepEqual(planApprovalTransition('approved', 'approve'), { status: 'approved', changed: false });
  for (const status of ['draft', 'rejected']) {
    assert.throws(
      () => planApprovalTransition(status, 'approve'),
      ApprovalStateError,
      `approve must never succeed from ${status}`,
    );
  }
  assert.deepEqual(planApprovalTransition('pending_review', 'approve'), { status: 'approved', changed: true });
});

test('approved is terminal: only an explicit reopen walks it backwards', () => {
  assert.throws(
    () => planApprovalTransition('approved', 'review'),
    (error) => error.reason === MESSAGES.alreadyApproved,
  );
  assert.deepEqual(planApprovalTransition('approved', 'reopen'), { status: 'pending_review', changed: true });
});

test('a missing or unrecognised approvalStatus is treated as draft, the safe reading', () => {
  for (const status of [undefined, null, '', 'APPROVED', 'in_review', 42]) {
    assert.throws(
      () => planApprovalTransition(status, 'approve'),
      (error) => error instanceof ApprovalStateError && error.reason === MESSAGES.notInReview,
      `${JSON.stringify(status)} must not be approvable`,
    );
    assert.deepEqual(
      planApprovalTransition(status, 'review'),
      { status: 'pending_review', changed: true },
      `${JSON.stringify(status)} must be reviewable`,
    );
  }
});

test('an unknown action is a request error, not a state error', () => {
  assert.throws(
    () => planApprovalTransition('pending_review', 'send'),
    (error) => error instanceof ApprovalRequestError && error.reason === 'That action is not supported.',
  );
});

test('every idempotent plan reports changed: false so nothing is written', () => {
  const idempotent = MATRIX.filter((entry) => entry.ok && entry.changed === false);
  assert.equal(idempotent.length, 4, 'one per action');
  for (const entry of idempotent) {
    assert.deepEqual(
      planApprovalTransition(entry.status, entry.action),
      { status: entry.status, changed: false },
      `${entry.action} from ${entry.status} must be a no-op`,
    );
  }
});

// ─── Patch shapes ─────────────────────────────────────────────────────────────

test('every action writes exactly the three approval fields', () => {
  for (const action of APPROVAL_ACTIONS) {
    const patch = approvalPatchFor(action, { uid: UID, now: NOW });
    assert.deepEqual(
      Object.keys(patch).sort(),
      APPROVAL_ONLY_KEYS,
      `${action} must write only ${APPROVAL_ONLY_KEYS.join(', ')}`,
    );
  }
});

test('approve stamps the server clock and the verified uid', () => {
  const patch = approvalPatchFor('approve', { uid: UID, now: NOW });
  assert.deepEqual(patch, { approvalStatus: 'approved', approvedAt: NOW, approvedBy: UID });
});

test('review, reject, and reopen all clear both stamps', () => {
  for (const action of ['review', 'reject', 'reopen']) {
    assert.deepEqual(
      approvalPatchFor(action, { uid: UID, now: NOW }),
      { approvalStatus: action === 'reject' ? 'rejected' : 'pending_review', approvedAt: null, approvedBy: null },
      `${action} must leave no approval behind`,
    );
  }
});

test('no action patch can reach content, match, or application fields', () => {
  const forbidden = [
    'company', 'role', 'contactName', 'jobUrl', 'intakeStatus', 'selectedResumeId',
    'matchScore', 'matchBreakdown', 'resumeSuggestions', 'draftSubject', 'draftMessage',
    'applicationStatus', 'emailSentOn', 'gmailThreadId', 'sheetRowId', 'updatedAt',
    'followUpStatus', 'dedupeKey',
  ];
  for (const action of APPROVAL_ACTIONS) {
    const patch = approvalPatchFor(action, { uid: UID, now: NOW });
    for (const field of forbidden) {
      assert.equal(field in patch, false, `${action} must never write ${field}`);
    }
  }
});

test('the action vocabulary and the writeable fields are pinned', () => {
  assert.deepEqual([...APPROVAL_FIELDS].sort(), APPROVAL_ONLY_KEYS);
  assert.deepEqual(APPROVAL_INVALIDATING_FIELDS, INVALIDATING);
});

// ─── Revocation on content change ─────────────────────────────────────────────

test('an approved application loses its approval when its material changes', () => {
  const patch = revocationPatch(reviewable({ approvalStatus: 'approved', approvedAt: NOW, approvedBy: UID }));
  assert.deepEqual(patch, { approvalStatus: 'pending_review', approvedAt: null, approvedBy: null });
});

test('nothing is revoked unless the application is approved', () => {
  for (const status of ['draft', 'pending_review', 'rejected']) {
    assert.equal(
      revocationPatch(reviewable({ approvalStatus: status })),
      null,
      `${status} has no approval to revoke`,
    );
  }
});

test('revocation is null for a missing or malformed document', () => {
  assert.equal(revocationPatch(null), null);
  assert.equal(revocationPatch(undefined), null);
  assert.equal(revocationPatch('approved'), null);
});

// ─── Stale-material detection ─────────────────────────────────────────────────

test('approvalMaterial covers the stored status and every review precondition', () => {
  const material = approvalMaterial(reviewable({ approvalStatus: 'pending_review' }));
  assert.equal(typeof material, 'string', 'a string so it can be compared with ===');

  const sensitive = [
    ['approvalStatus', 'approved'],
    ['intakeStatus', 'drafting'],
    ['selectedResumeId', 'rsv_other'],
    ['matchScore', 42],
    ['matchBreakdown', []],
    ['draftSubject', 'A different subject'],
    ['draftMessage', 'A different message'],
    ['resumeSuggestions', { suggestions: [{ title: 'Add Kubernetes' }] }],
  ];
  for (const [field, value] of sensitive) {
    assert.notEqual(
      approvalMaterial(reviewable({ approvalStatus: 'pending_review', [field]: value })),
      material,
      `changing ${field} must invalidate the material`,
    );
  }
});

test('approvalMaterial ignores fields a human does not review', () => {
  const base = approvalMaterial(reviewable({ approvalStatus: 'pending_review' }));
  const unrelated = [
    { company: 'Renamed Corp' },
    { updatedAt: '2026-10-09T00:00:00.000Z' },
    { applicationStatus: 'applied' },
    { emailSentOn: '2026-10-09T00:00:00.000Z' },
    { draftGeneratedAt: '2026-10-09T00:00:00.000Z' },
    { draftEditedByHuman: false },
    { sheetRowId: 99 },
    { approvedAt: '2026-10-09T00:00:00.000Z' },
    { approvedBy: 'someone-else' },
  ];
  for (const extra of unrelated) {
    assert.equal(
      approvalMaterial(reviewable({ approvalStatus: 'pending_review', ...extra })),
      base,
      `${Object.keys(extra)[0]} must not affect the material`,
    );
  }
});

test('an unrecognised approvalStatus reads as draft so a stale privileged status cannot win', () => {
  assert.equal(
    approvalMaterial(reviewable({ approvalStatus: 'APPROVED' })),
    approvalMaterial(reviewable({ approvalStatus: 'draft' })),
  );
});

test('the conflict error carries the refresh message, not a provider message', () => {
  const error = new ApprovalConflictError();
  assert.equal(error.reason, MESSAGES.conflict);
  assert.equal(error.message, MESSAGES.conflict);
});

// ─── The Phase 9 send invariant ───────────────────────────────────────────────

test('assertSendApproved passes only on an approved application', () => {
  assert.equal(assertSendApproved(reviewable({ approvalStatus: 'approved' })), true);
  for (const status of ['draft', 'pending_review', 'rejected']) {
    assert.throws(
      () => assertSendApproved(reviewable({ approvalStatus: status })),
      (error) => error instanceof ApprovalStateError && error.reason === MESSAGES.sendNotApproved,
      `${status} must not be sendable`,
    );
  }
});

test('assertSendApproved fails closed on anything that is not a Job', () => {
  for (const value of [null, undefined, 'approved', 42, [], {}]) {
    assert.equal(isApprovedForSending(value), false, `${JSON.stringify(value)} must not be sendable`);
  }
});

test('a missing approvalStatus is not an approval', () => {
  const { approvalStatus, ...withoutIt } = reviewable();
  assert.equal(isApprovedForSending(withoutIt), false);
  assert.equal(approvalStatus, 'draft');
});
