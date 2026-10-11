/** Authenticated server-side bridge to the existing Apps Script dashboard API. */
import { randomUUID } from 'node:crypto';
import { approvalMaterial, assertSendApproved, isApprovedForSending, MESSAGES } from './approval.js';
import { claimSend, releaseSendClaim, writeSendFields, loadJobDocument, isMatchableJobDocument } from './jobs.js';
import { findSelectedRecord } from './suggestions.js';
import { fetchResumeRows } from './google.js';
import { parseCacheRows, splitHeaderAndRows } from './resume-cache.js';

export const SEND_FIELDS = ['applicationStatus', 'emailSentOn', 'gmailThreadId'];
const SAFE_SEND_ERROR = 'Unable to confirm that the application was sent.';
const APPS_SCRIPT_FIELDS = ['company', 'contactName', 'contactEmail', 'role', 'jobLink', 'source', 'location', 'notes', 'allowDuplicate', 'approvedSubject', 'approvedMessage', 'approvedResumeFileId'];

function requireApproval(job) {
  try { assertSendApproved(job); }
  catch (error) { error.code = 'PRECONDITION_FAILED'; throw error; }
}

/** The Apps Script `send` action consumes exactly these existing dashboard fields. */
export function mapJobToAppsScriptPayload(job, resume) {
  return {
    company: job.company ?? '',
    contactName: job.contactName ?? '',
    contactEmail: job.contactEmail ?? '',
    role: job.role ?? '',
    jobLink: job.jobUrl ?? '',
    source: job.source ?? 'linkedin',
    location: job.location ?? '',
    notes: job.notes ?? '',
    allowDuplicate: false,
    approvedSubject: job.draftSubject,
    approvedMessage: job.draftMessage,
    ...(typeof resume?.driveFileId === 'string' ? { approvedResumeFileId: resume.driveFileId } : {}),
  };
}

export function sendPreconditionFailure(job, resume) {
  if (!isApprovedForSending(job)) return MESSAGES.sendNotApproved;
  if (job.intakeStatus !== 'confirmed') return 'This job must be confirmed before it can be sent.';
  if (!job.contactEmail || !job.contactEmail.trim()) return 'This job is missing a recipient email.';
  if (!job.company?.trim() || !job.role?.trim()) return 'This job is missing a company or role.';
  if (!job.selectedResumeId?.trim()) return 'This job has no selected resume.';
  if (!Array.isArray(job.matchBreakdown) || job.matchBreakdown.length === 0 || typeof job.matchScore !== 'number') {
    return 'This job has no match result.';
  }
  if (!job.draftSubject?.trim()) return 'This job has no approved draft subject.';
  if (!job.draftMessage?.trim()) return 'This job has no approved draft message.';
  if (!resume) return 'The selected resume is no longer available in the resume library.';
  if (typeof resume.driveFileId !== 'string' || !resume.driveFileId.trim()) {
    return 'The selected resume has no server-side attachment file.';
  }
  if (job.emailSentOn || job.gmailThreadId || job.applicationStatus === 'applied') {
    return 'This application has already been sent.';
  }
  return null;
}

/** One call to the existing endpoint. No client can select the action or supply its token. */
async function postAppsScript(config, action, data, fetchImpl) {
  const safeData = data ? Object.fromEntries(APPS_SCRIPT_FIELDS
    .filter((field) => Object.hasOwn(data, field))
    .map((field) => [field, data[field]])) : undefined;
  const response = await fetchImpl(config.appsScriptUrl, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token: config.appsScriptToken, ...(safeData ? { data: safeData } : {}) }),
    redirect: 'follow',
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Apps Script did not return JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Apps Script did not return JSON.');
  if (!response.ok || parsed.ok !== true) {
    const error = new Error(parsed?.message || parsed?.error || `Apps Script returned HTTP ${response.status}.`);
    error.code = parsed?.code || 'APPS_SCRIPT_ERROR';
    throw error;
  }
  return parsed;
}

/**
 * Calls the existing `send` action, then verifies the resulting Sheet row through its
 * existing `jobs` action. `add_()` can return ok even when the internal mailer marked the
 * row Failed/Blocked, so only a persisted `Sent` row is accepted as success.
 */
export async function callAppsScriptSend(config, payload, fetchImpl = globalThis.fetch) {
  if (!config?.appsScriptUrl || !config?.appsScriptToken) throw new Error('Apps Script is not configured.');
  await postAppsScript(config, 'send', payload, fetchImpl);
  const jobsResponse = await postAppsScript(config, 'jobs', undefined, fetchImpl);
  if (!Array.isArray(jobsResponse.data)) throw new Error('Apps Script returned an unexpected jobs response.');
  const match = jobsResponse.data.find((row) =>
    String(row.company ?? '').trim().toLowerCase() === String(payload.company).trim().toLowerCase() &&
    String(row.role ?? '').trim().toLowerCase() === String(payload.role).trim().toLowerCase() &&
    String(row.contactEmail ?? '').trim().toLowerCase() === String(payload.contactEmail).trim().toLowerCase());
  if (!match || !/^sent\b/i.test(String(match.status ?? ''))) {
    const error = new Error('Apps Script did not confirm a sent application.');
    error.code = 'SEND_NOT_CONFIRMED';
    throw error;
  }
  return { ok: true, message: 'Email processed', threadId: match.threadId || null };
}

/**
 * Load, validate, claim, revalidate, send, and persist. A separate expiring claim
 * document serializes concurrent calls without changing the Job/Sheet status vocabulary.
 */
export async function sendApplication(uid, jobId, deps = {}) {
  const loadJob = deps.loadJobDocument ?? loadJobDocument;
  const claim = deps.claimSend ?? claimSend;
  const release = deps.releaseSendClaim ?? releaseSendClaim;
  const loadResume = deps.loadSelectedResume ?? loadSelectedResume;
  const send = deps.callAppsScriptSend ?? callAppsScriptSend;
  const persist = deps.writeSendFields ?? writeSendFields;
  const common = { db: deps.db, config: deps.config };
  const initial = await loadJob(uid, jobId, common);
  if (!isMatchableJobDocument(initial)) {
    const error = new Error('Job not found.'); error.code = 'NOT_FOUND'; throw error;
  }
  requireApproval(initial);
  const approvedMaterial = approvalMaterial(initial);
  let resume = await loadResume(initial, deps);
  const failure = sendPreconditionFailure(initial, resume);
  if (failure) { const error = new Error(failure); error.code = 'PRECONDITION_FAILED'; throw error; }
  const initialResume = resume;

  const claimId = randomUUID();
  const now = (deps.now || Date.now)();
  const claimed = await claim(uid, jobId, claimId, now, common);
  if (!claimed.ok) {
    const error = new Error(claimed.reason === 'sent'
      ? 'This application has already been sent.'
      : claimed.reason === 'approval' ? MESSAGES.sendNotApproved : 'A send is already in progress.');
    error.code = claimed.reason === 'sent' ? 'DUPLICATE' : 'SEND_CONFLICT';
    throw error;
  }

  try {
    const job = await loadJob(uid, jobId, common);
    if (!isMatchableJobDocument(job)) { const error = new Error('Job not found.'); error.code = 'NOT_FOUND'; throw error; }
    if (approvalMaterial(job) !== approvedMaterial) {
      const error = new Error('The approved application changed. Review and approve it again before sending.');
      error.code = 'PRECONDITION_FAILED'; throw error;
    }
    // Keep this check directly adjacent to the external side effect.
    requireApproval(job);
    resume = await loadResume(job, deps);
    const currentFailure = sendPreconditionFailure(job, resume);
    if (currentFailure) { const error = new Error(currentFailure); error.code = 'PRECONDITION_FAILED'; throw error; }
    if (resume.driveFileId !== initialResume.driveFileId) {
      const error = new Error('The selected resume file changed. Review and approve the job again before sending.');
      error.code = 'PRECONDITION_FAILED'; throw error;
    }
    const payload = mapJobToAppsScriptPayload(job, resume);
    requireApproval(job);
    const result = await send(deps.config, payload, deps.fetch);
    const sentAt = new Date((deps.now || Date.now)()).toISOString();
    await persist(uid, jobId, {
      applicationStatus: 'applied', emailSentOn: sentAt, gmailThreadId: result.threadId,
    }, { ...common, claimId });
    try { await release(uid, jobId, claimId, common); }
    catch (releaseError) { (deps.logger || console).error('[send] unable to release completed send claim', releaseError); }
    return { ok: true, jobId, message: 'Application sent.', threadId: result.threadId, sentAt };
  } catch (error) {
    try { await release(uid, jobId, claimId, common); } catch (releaseError) {
      (deps.logger || console).error('[send] unable to release send claim', releaseError);
    }
    if (error.code === 'PRECONDITION_FAILED' || error.code === 'DUPLICATE' || error.code === 'SEND_CONFLICT' || error.code === 'NOT_FOUND') throw error;
    (deps.logger || console).error('[send] external send failed or could not be confirmed', error);
    const safe = new Error(SAFE_SEND_ERROR); safe.code = 'SEND_FAILED'; throw safe;
  }
}

async function loadSelectedResume(job, deps) {
  if (typeof job.selectedResumeId !== 'string' || !job.selectedResumeId.trim()) return null;
  const values = await fetchResumeRows(deps.config, { sheets: deps.sheets });
  const records = parseCacheRows(splitHeaderAndRows(values).rows).records;
  const record = findSelectedRecord(records, job.selectedResumeId);
  return record && typeof record.driveFileId === 'string' && record.driveFileId.trim() ? record : null;
}
