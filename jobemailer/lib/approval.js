/**
 * The human-review and approval gate.
 *
 * Phase 8 introduces the only thing that stands between a drafted application and a sent
 * one: a human who has looked at the resume, the match, the suggestions, and the exact
 * words in the draft, and who has said so explicitly. Everything here is pure — no
 * Firestore, no Google, no clock — which is what lets `test/approval.test.js` exercise the
 * whole state machine without a project.
 *
 * Two ideas carry the design:
 *
 * - **The transition table is the law.** `planApprovalTransition` decides whether an action
 *   is legal from the stored status; the handler never second-guesses it and the client
 *   never gets a vote. `approve` is reachable only from `pending_review`, so a caller that
 *   skips review gets a 409 rather than an approved job.
 * - **Approval is a fact about specific bytes.** A human approved *this* subject and
 *   *this* message and *this* resume. Any change to those materials revokes the approval,
 *   because otherwise the thing that gets sent later would not be the thing that was
 *   approved. `approvalMaterial` is the projection compared to detect exactly that.
 *
 * `assertSendApproved` is the Phase 9 hand-off: a pure predicate that will sit in front of
 * the Gmail/Apps Script bridge. Nothing here calls it, and nothing here sends.
 */

// ─── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * The four actions a client may ask for. Nothing else is recognised, so the surface for
 * inventing a transition is one list.
 */
export const APPROVAL_ACTIONS = ['review', 'approve', 'reject', 'reopen'];

/** Mirrors `JOB_APPROVAL_STATUSES` in `src/domain/job.ts`. */
export const APPROVAL_STATUSES = ['draft', 'pending_review', 'approved', 'rejected'];

/** The only three fields any approval action is ever allowed to write. */
export const APPROVAL_FIELDS = ['approvalStatus', 'approvedAt', 'approvedBy'];

/**
 * Fields whose change means an existing approval no longer describes the application.
 *
 * Six keys, matching Part M exactly: the two draft strings, the resume the human chose,
 * the score and breakdown that justified it, and the suggestions derived from it.
 */
export const APPROVAL_INVALIDATING_FIELDS = [
  'draftSubject',
  'draftMessage',
  'selectedResumeId',
  'matchScore',
  'matchBreakdown',
  'resumeSuggestions',
];

/** The version of the `POST /api/approval` response envelope. */
export const APPROVAL_SCHEMA_VERSION = 1;

// ─── Messages ─────────────────────────────────────────────────────────────────
//
// Every string here is safe to show a user verbatim: none of them quotes a document, a
// path, a credential, or a provider error.

export const MESSAGES = {
  unconfirmed: 'This job must be confirmed before it can be reviewed.',
  noSelectedResume: 'This job has no selected resume. Run a match first.',
  noMatch: 'This job has no match result. Run a match first.',
  noDraft: 'This job has no outreach draft. Generate a draft first.',
  resumeUnavailable: 'The selected resume is no longer available in the resume library.',

  notInReview: 'This application is not in review. Start the review first.',
  rejectedNeedsReopen: 'This application was rejected. Reopen the review before approving.',
  alreadyApproved: 'This application is already approved. Reopen the review to change it.',
  nothingToReopen: 'This application has not been reviewed yet. Start the review first.',

  conflict: 'The application review state changed. Refresh and review again.',
  sendNotApproved: 'This application is not approved for sending.',
};

// ─── Errors ───────────────────────────────────────────────────────────────────

/** A malformed request body. Maps to 400. */
export class ApprovalRequestError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ApprovalRequestError';
    this.reason = reason;
  }
}

/** An illegal transition or an unmet precondition. Maps to 409, message shown verbatim. */
export class ApprovalStateError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ApprovalStateError';
    this.reason = reason;
  }
}

/**
 * The stored job moved between the handler's read and its write.
 *
 * Deliberately a separate class from `ApprovalStateError`: a stale write is the caller's
 * *UI* being out of date, and it deserves the "refresh and review again" sentence rather
 * than a message about the transition they were attempting.
 */
export class ApprovalConflictError extends Error {
  constructor(reason = MESSAGES.conflict) {
    super(reason);
    this.name = 'ApprovalConflictError';
    this.reason = reason;
  }
}

// ─── Request parsing ──────────────────────────────────────────────────────────

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads `jobId` and `action`, and nothing else.
 *
 * Every other caller-supplied key — `uid`, `approvalStatus`, `approvedAt`, `approvedBy`,
 * `applicationStatus`, `selectedResumeId`, `draftSubject`, `draftMessage` — is ignored
 * rather than rejected, so a newer client sending extra fields is not an error while a
 * client trying to hand us an approval still gets no vote.
 */
export function parseApprovalRequest(body) {
  if (!isPlainObject(body)) throw new ApprovalRequestError('The request body must be a JSON object.');

  const rawJobId = body.jobId;
  if (typeof rawJobId !== 'string') throw new ApprovalRequestError('A jobId is required.');
  const jobId = rawJobId.trim();
  if (!jobId) throw new ApprovalRequestError('A jobId is required.');
  // Firestore document ids cannot contain "/", and the id is interpolated into
  // `users/{uid}/jobs/{jobId}`, so this is also the path-traversal guard.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new ApprovalRequestError('That jobId is not valid.');

  const rawAction = body.action;
  if (typeof rawAction !== 'string') throw new ApprovalRequestError('An action is required.');
  const action = rawAction.trim();
  if (!action) throw new ApprovalRequestError('An action is required.');
  if (!APPROVAL_ACTIONS.includes(action)) throw new ApprovalRequestError('That action is not supported.');

  return { jobId, action };
}

// ─── Review preconditions ─────────────────────────────────────────────────────

/**
 * Returns the reason this Job cannot enter (or stay eligible for) review, or `null`.
 *
 * The order is the order a human would diagnose the problem in: confirm the intake, then
 * pick a resume, then match it, then write the draft. `schemaVersion` is not checked here
 * because a legacy document never reaches this module — `isMatchableJobDocument` turns it
 * into a 404 first, and reporting a precondition for a document that is not canonical
 * would confirm that it exists.
 */
export function reviewPreconditionFailure(document) {
  if (!isPlainObject(document)) return MESSAGES.unconfirmed;
  if (document.intakeStatus !== 'confirmed') return MESSAGES.unconfirmed;
  if (typeof document.selectedResumeId !== 'string' || !document.selectedResumeId.trim()) {
    return MESSAGES.noSelectedResume;
  }
  if (
    !Array.isArray(document.matchBreakdown) ||
    document.matchBreakdown.length === 0 ||
    typeof document.matchScore !== 'number'
  ) {
    return MESSAGES.noMatch;
  }
  if (typeof document.draftSubject !== 'string' || !document.draftSubject.trim()) return MESSAGES.noDraft;
  if (typeof document.draftMessage !== 'string' || !document.draftMessage.trim()) return MESSAGES.noDraft;
  return null;
}

/** True when every review precondition holds. */
export function isReviewable(document) {
  return reviewPreconditionFailure(document) === null;
}

// ─── State machine ────────────────────────────────────────────────────────────

function readStatus(document) {
  const value = isPlainObject(document) ? document.approvalStatus : undefined;
  return APPROVAL_STATUSES.includes(value) ? value : 'draft';
}

/**
 * Decides whether `action` is legal from `current`, and what it becomes.
 *
 * Returns `{ status, changed }`. `changed === false` means the document is already in the
 * requested state, and the caller should answer 200 without writing: re-approving an
 * already-approved job must not restamp `approvedAt`, and re-reviewing an already
 * pending job must not churn the document.
 *
 * A missing or unrecognised `approvalStatus` reads as `draft`, which is the safe
 * interpretation — it makes every privileged action fail rather than succeed.
 */
export function planApprovalTransition(current, action) {
  const status = readStatus({ approvalStatus: current });

  switch (action) {
    case 'review':
      // `approved` is terminal until somebody explicitly reopens it. Quietly walking the
      // status backwards here is exactly the "approve, then un-approve by pressing the
      // wrong button" failure the gate exists to prevent.
      if (status === 'approved') throw new ApprovalStateError(MESSAGES.alreadyApproved);
      if (status === 'pending_review') return { status, changed: false };
      return { status: 'pending_review', changed: true };

    case 'approve':
      if (status === 'pending_review') return { status: 'approved', changed: true };
      if (status === 'approved') return { status, changed: false };
      if (status === 'rejected') throw new ApprovalStateError(MESSAGES.rejectedNeedsReopen);
      throw new ApprovalStateError(MESSAGES.notInReview);

    case 'reject':
      if (status === 'pending_review') return { status: 'rejected', changed: true };
      if (status === 'rejected') return { status, changed: false };
      if (status === 'approved') throw new ApprovalStateError(MESSAGES.alreadyApproved);
      throw new ApprovalStateError(MESSAGES.notInReview);

    case 'reopen':
      if (status === 'approved' || status === 'rejected') return { status: 'pending_review', changed: true };
      if (status === 'pending_review') return { status, changed: false };
      throw new ApprovalStateError(MESSAGES.nothingToReopen);

    default:
      throw new ApprovalRequestError('That action is not supported.');
  }
}

/**
 * The narrow patch an action is allowed to write.
 *
 * Exactly three keys, always. `approve` is the only action that stamps a value; the other
 * three clear both stamps, because "there is no active approval" is what starting a
 * review, rejecting, and reopening all mean. Company, role, the match, the draft,
 * `applicationStatus`, and every mailbox field are untouched by construction — there is no
 * way to reach them from this code path, which is the point of putting the patch here
 * rather than in the handler.
 */
export function approvalPatchFor(action, { uid, now }) {
  if (action === 'approve') {
    return { approvalStatus: 'approved', approvedAt: now, approvedBy: uid };
  }
  if (action === 'reject') {
    return { approvalStatus: 'rejected', approvedAt: null, approvedBy: null };
  }
  // `review` and `reopen` are the same write: back under human eyes, no approval.
  return { approvalStatus: 'pending_review', approvedAt: null, approvedBy: null };
}

// ─── Revocation on content change ─────────────────────────────────────────────

/**
 * The patch that withdraws an approval, or `null` when there is nothing to withdraw.
 *
 * Only `approved` is revoked. A job sitting in `pending_review` whose draft is edited is
 * still awaiting a human, and `draft`/`rejected` have no approval to lose.
 *
 * The target is always `pending_review`, never `draft`: the human still has to look at the
 * new material, but the review they already started has not been discarded.
 */
export function revocationPatch(document) {
  if (!isPlainObject(document) || document.approvalStatus !== 'approved') return null;
  return { approvalStatus: 'pending_review', approvedAt: null, approvedBy: null };
}

// ─── Stale-material detection ─────────────────────────────────────────────────

/**
 * Projects everything an approver was looking at onto a comparable value.
 *
 * Two snapshots compared for equality answer precisely the question Part G asks: *is the
 * job the client validated the same job the server is about to write to?* It holds the
 * stored status (so a concurrent reject wins over a stale approve), every precondition
 * review depends on (`intakeStatus`, the selected resume, the score and breakdown, the two
 * draft strings), and the suggestions those were derived from — which is every field in
 * `APPROVAL_INVALIDATING_FIELDS` plus the ones the preconditions read.
 *
 * The projection is deliberately explicit rather than "everything but timestamps": a field
 * added later that a human does not review should not silently invalidate approvals, and
 * a field a human *does* review cannot be left out without reopening the race this exists
 * to close.
 */
export function approvalMaterial(document) {
  const value = isPlainObject(document) ? document : {};
  return JSON.stringify({
    approvalStatus: APPROVAL_STATUSES.includes(value.approvalStatus) ? value.approvalStatus : 'draft',
    intakeStatus: typeof value.intakeStatus === 'string' ? value.intakeStatus : null,
    selectedResumeId: typeof value.selectedResumeId === 'string' ? value.selectedResumeId : null,
    matchScore: typeof value.matchScore === 'number' ? value.matchScore : null,
    matchBreakdown: Array.isArray(value.matchBreakdown) ? value.matchBreakdown : null,
    draftSubject: typeof value.draftSubject === 'string' ? value.draftSubject : null,
    draftMessage: typeof value.draftMessage === 'string' ? value.draftMessage : null,
    resumeSuggestions: value.resumeSuggestions ?? null,
  });
}

// ─── The Phase 9 invariant ────────────────────────────────────────────────────

/**
 * The single rule Phase 9 must call before it delegates to Gmail or Apps Script.
 *
 * Pure and unconnected on purpose: Phase 8 establishes the invariant and proves it, and
 * the sending bridge arrives later and calls it. It checks exactly the condition the spec
 * names — `approvalStatus === 'approved'` — and nothing else, so loosening it in future
 * would be a one-line, greppable change rather than a hunt through branching logic.
 *
 * @throws {ApprovalStateError} when the job is not approved.
 */
export function assertSendApproved(job) {
  if (!isPlainObject(job) || job.approvalStatus !== 'approved') {
    throw new ApprovalStateError(MESSAGES.sendNotApproved);
  }
  return true;
}

/** True when `assertSendApproved` would pass. */
export function isApprovedForSending(job) {
  try {
    assertSendApproved(job);
    return true;
  } catch {
    return false;
  }
}
