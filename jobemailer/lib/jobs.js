/**
 * Server-side access to canonical Job documents.
 *
 * The mobile app reads and writes Jobs through `JobsRepository`; this module is the Admin
 * SDK counterpart used by `POST /api/match` and `POST /api/suggestions`, which must load a
 * Job under the *verified* caller's own path and then write back only the fields their own
 * feature owns.
 *
 * Rules for this file:
 * - The document path is always `users/{uid}/jobs/{jobId}` where `uid` comes from a
 *   verified ID token. There is no code path that builds a path from a caller-supplied
 *   uid, so reading another user's Job by guessing a document id is not expressible.
 * - Writes are whole-field patches of an explicit allow-list. Nothing here spreads a Job
 *   or a model response into Firestore, so an unexpected key cannot be persisted.
 * - Writes run in a transaction, because two of them read the document first: content
 *   writes decide whether an existing approval must be revoked, and approval writes refuse
 *   to land on a document that moved since they were validated. Both decisions would be
 *   racy as plain `update` calls.
 * - Firestore error messages are never returned to a client: they name the project, the
 *   document, and the permission that failed.
 *
 * `db` is injectable so the handler's tests exercise the real path construction and the
 * real patch shape without a Firebase project. That includes `runTransaction`, so the fake
 * databases in the API tests implement it too.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { firebaseApp } from './auth.js';
import { ApprovalConflictError, approvalMaterial, revocationPatch } from './approval.js';

const SEND_FIELDS = ['applicationStatus', 'emailSentOn', 'gmailThreadId'];
const SEND_CLAIM_LEASE_MS = 2 * 60 * 1000;

/**
 * Lowest `schemaVersion` that is a canonical Job.
 *
 * Legacy Job Tracker documents live in the same collection and carry no version field, so
 * they read back as `0`. They use a different shape, and matching one would silently
 * produce a score computed from the wrong fields.
 */
export const CANONICAL_JOB_SCHEMA_VERSION = 1;

/** The only document this module may touch: `users/{uid}/jobs/{jobId}`. */
export function jobDocumentPath(uid, jobId) {
  return `users/${uid}/jobs/${jobId}`;
}

function database(deps) {
  if (deps.db) return deps.db;
  return getFirestore(firebaseApp(deps.config));
}

/**
 * Loads a Job document, or returns `null` when it does not exist.
 *
 * Ownership is structural: the path already contains the verified uid, so a document that
 * belongs to somebody else is simply not on the path being read. Callers cannot tell
 * "someone else's job" from "no such job" because both arrive as `null`.
 *
 * @returns {Promise<object | null>} the raw document body
 */
export async function loadJobDocument(uid, jobId, deps = {}) {
  const snapshot = await database(deps).doc(jobDocumentPath(uid, jobId)).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  return data && typeof data === 'object' ? data : null;
}

/**
 * True when a document is a canonical Job this feature is allowed to match.
 *
 * Combined on purpose: an unversioned legacy record and a missing document both mean
 * "there is no job to match here", and reporting them differently would leak which
 * document ids exist in somebody else's collection.
 */
export function isMatchableJobDocument(data) {
  if (!data || typeof data !== 'object') return false;
  const version = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;
  return version >= CANONICAL_JOB_SCHEMA_VERSION;
}

/**
 * Writes a content field patch, revoking an approval in the same atomic step if it no
 * longer describes the document.
 *
 * Every content write in the server (`match`, `suggestions`, `draft`) goes through here.
 * The read-modify-write runs inside a transaction so the revocation decision is made
 * against the document the write actually lands on, not against a snapshot taken a moment
 * earlier: without it, an approve racing a draft regeneration could stamp `approved` onto
 * text that was replaced a millisecond before, and the approval would survive the change
 * that should have revoked it.
 *
 * `revocationPatch` returns `null` unless the stored status is `approved`, so jobs in
 * `draft`, `pending_review`, and `rejected` are written exactly as before — only the three
 * fields listed there can change, and only as a side effect that the caller never asked for.
 */
export async function writeContentFields(uid, jobId, patch, deps = {}) {
  const path = jobDocumentPath(uid, jobId);
  await database(deps).runTransaction(async (transaction) => {
    const ref = database(deps).doc(path);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      const error = new Error(`NOT_FOUND: No document to update: ${path}`);
      error.code = 'not-found';
      throw error;
    }
    const current = snapshot.data() || {};
    const revocation = revocationPatch(current);
    await transaction.update(ref, revocation ? { ...patch, ...revocation } : patch);
  });
}

/**
 * Writes the match-owned fields and nothing else.
 *
 * The patch is assembled by the caller from a validated result; this function's job is to
 * apply exactly those keys, which leaves every other field in the document untouched —
 * including `updatedAt`, which this feature does not own.
 *
 * A document that vanished between the read and the write throws, which is correct: the
 * caller should learn the Job is gone rather than believe a score was saved.
 */
export async function writeMatchFields(uid, jobId, patch, deps = {}) {
  await writeContentFields(uid, jobId, patch, deps);
}

/**
 * Writes the suggestion-owned field and nothing else.
 *
 * Phase 6 owns exactly one key: `resumeSuggestions`. It does not own `selectedResumeId`,
 * `matchScore`, `matchBreakdown`, or anything else matching wrote, so regenerating advice
 * cannot disturb the match it was derived from — the patch carries a single key and the
 * rest of the document is left byte-for-byte as it was.
 *
 * Because `resumeSuggestions` is an approval-invalidating field, regenerating suggestions
 * on an approved job also withdraws the approval, via `writeContentFields`.
 */
export async function writeSuggestionFields(uid, jobId, patch, deps = {}) {
  await writeContentFields(uid, jobId, patch, deps);
}

/**
 * Writes the draft-owned fields and nothing else.
 *
 * Phase 7 owns exactly four keys: `draftSubject`, `draftMessage`, `draftGeneratedAt`, and
 * `draftEditedByHuman`. It does not own `intakeStatus`, `selectedResumeId`, `matchScore`,
 * `matchBreakdown`, `resumeSuggestions`, `approvalStatus`, or `applicationStatus`, so
 * generating an email draft cannot confirm, approve, or apply for anything.
 *
 * `draftEditedByHuman` is part of the write rather than a separate call so a fresh
 * generation and the flag that says "nobody has touched this yet" are one atomic update;
 * nothing can observe a new draft that still claims to be hand-edited.
 *
 * The two draft strings are approval-invalidating, so this is the write most likely to
 * revoke: regenerating a draft on an approved job moves it back to `pending_review`.
 */
export async function writeDraftFields(uid, jobId, patch, deps = {}) {
  await writeContentFields(uid, jobId, patch, deps);
}

/**
 * Persists the result of an approval action.
 *
 * `material` is the `approvalMaterial` projection taken when the handler loaded and
 * validated the Job. The transaction re-reads the document and refuses to write if that
 * projection has moved, which collapses Part G's three staleness checks — the status, the
 * preconditions, and the draft the human was reading — into a single comparison against
 * the exact document being written.
 *
 * `patch` is built by `approvalPatchFor` and carries at most three keys, so approval can
 * never reach company, role, the match, the draft, `applicationStatus`, or the mailbox
 * fields even if a caller were to pass something else: the handler does not expose this
 * function to a request body.
 *
 * @throws {ApprovalConflictError} when the document moved underneath the caller.
 */
export async function writeApprovalFields(uid, jobId, { material, patch }, deps = {}) {
  const path = jobDocumentPath(uid, jobId);
  await database(deps).runTransaction(async (transaction) => {
    const ref = database(deps).doc(path);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      const error = new Error(`NOT_FOUND: No document to update: ${path}`);
      error.code = 'not-found';
      throw error;
    }
    const current = snapshot.data() || {};
    if (approvalMaterial(current) !== material) {
      throw new ApprovalConflictError();
    }
    await transaction.update(ref, patch);
  });
}

/**
 * Persists the application lifecycle fields after a successful send.
 *
 * This write does NOT revoke approval — the approval state should remain `approved`
 * after sending, as per the existing lifecycle semantics. The approval gate is a
 * one-time prerequisite; sending does not reset it.
 *
 * Writes exactly three fields: `applicationStatus`, `emailSentOn`, `gmailThreadId`.
 * All other fields are preserved byte-for-byte.
 */
export async function writeSendFields(uid, jobId, patch, deps = {}) {
  const path = jobDocumentPath(uid, jobId);
  await database(deps).runTransaction(async (transaction) => {
    const ref = database(deps).doc(path);
    const claimRef = deps.claimId ? database(deps).doc(`users/${uid}/sendClaims/${jobId}`) : null;
    const snapshot = await transaction.get(ref);
    const claimSnapshot = claimRef ? await transaction.get(claimRef) : null;
    if (!snapshot.exists) {
      const error = new Error(`NOT_FOUND: No document to update: ${path}`);
      error.code = 'not-found';
      throw error;
    }
    if (claimRef && (!claimSnapshot?.exists || claimSnapshot.data()?.claimId !== deps.claimId)) {
      const error = new Error('The send claim is no longer current.');
      error.code = 'send-claim-stale';
      throw error;
    }
    // Only allow the three send-owned fields
    const writeData = {};
    for (const field of SEND_FIELDS) {
      if (field in patch) writeData[field] = patch[field];
    }
    if (Object.keys(writeData).length === 0) return;
    await transaction.update(ref, writeData);
    if (claimRef) transaction.delete(claimRef);
  });
}

/**
 * Claims a short-lived, per-job send slot. The separate document avoids adding an
 * unsupported lifecycle value to the canonical Job or Sheet mirror. Expired claims
 * are replaceable, so a crashed function does not lock a Job permanently.
 */
export async function claimSend(uid, jobId, claimId, now = Date.now(), deps = {}) {
  const db = database(deps);
  const jobRef = db.doc(jobDocumentPath(uid, jobId));
  const claimRef = db.doc(`users/${uid}/sendClaims/${jobId}`);
  return db.runTransaction(async (transaction) => {
    const [jobSnapshot, claimSnapshot] = await Promise.all([
      transaction.get(jobRef),
      transaction.get(claimRef),
    ]);
    if (!jobSnapshot.exists) return { ok: false, reason: 'missing' };
    const job = jobSnapshot.data() || {};
    if (job.approvalStatus !== 'approved') return { ok: false, reason: 'approval' };
    if (job.emailSentOn || job.gmailThreadId || job.applicationStatus === 'applied') {
      return { ok: false, reason: 'sent' };
    }
    const currentClaim = claimSnapshot.exists ? claimSnapshot.data() || {} : null;
    if (currentClaim && currentClaim.expiresAt > now) return { ok: false, reason: 'busy' };
    transaction.set(claimRef, { claimId, expiresAt: now + SEND_CLAIM_LEASE_MS });
    return { ok: true, expiresAt: now + SEND_CLAIM_LEASE_MS };
  });
}

/** Releases only this request's claim, including after a provider failure. */
export async function releaseSendClaim(uid, jobId, claimId, deps = {}) {
  const db = database(deps);
  const ref = db.doc(`users/${uid}/sendClaims/${jobId}`);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data()?.claimId !== claimId) return;
    transaction.delete(ref);
  });
}
