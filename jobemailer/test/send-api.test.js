import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, fakeResponse } from '../api/send.js';
import { sendApplication, callAppsScriptSend } from '../lib/send.js';
import { RESUME_CACHE_HEADERS } from '../lib/resume-cache.js';

const JOB_ID = 'job-1';
const UID = 'verified-user';
const job = (patch = {}) => ({
  schemaVersion: 1, approvalStatus: 'approved', intakeStatus: 'confirmed',
  selectedResumeId: 'resume-1', matchScore: 90, matchBreakdown: [{ criterion: 'must_have' }],
  draftSubject: 'Approved subject', draftMessage: 'Approved body',
  company: 'Example', role: 'Engineer', contactEmail: 'candidate@example.com',
  contactName: 'Candidate', jobUrl: 'https://example.test/role', applicationStatus: 'draft',
  emailSentOn: null, gmailThreadId: null, ...patch,
});

function invoke(options = {}) {
  let configCalls = 0;
  let verifiedToken = null;
  const handler = createHandler({
    verifyIdToken: async (token) => { verifiedToken = token; if (token !== 'valid') throw Error('bad'); return { uid: UID }; },
    loadConfig: () => { configCalls++; return { appsScriptUrl: 'https://server-only.test', appsScriptToken: 'secret' }; },
    sendApplication: options.sendApplication ?? (async () => ({ sentAt: '2026-10-05T10:00:00.000Z', threadId: 'thread-1' })),
    logger: { error() {} },
  });
  const res = fakeResponse();
  const req = { method: 'POST', headers: options.headers ?? { authorization: 'Bearer valid' }, body: options.body ?? { jobId: JOB_ID } };
  return handler(req, res).then(() => ({ res, configCalls, get verifiedToken() { return verifiedToken; } }));
}

test('authentication is required and invalid tokens map to the same 401', async () => {
  assert.equal((await invoke({ headers: {} })).res.statusCode, 401);
  assert.equal((await invoke({ headers: { authorization: 'Bearer bad' } })).res.statusCode, 401);
});

test('auth completes before privileged send configuration loads', async () => {
  const result = await invoke();
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.configCalls, 1);
  assert.equal(result.verifiedToken, 'valid');
});

test('body UID and arbitrary send fields are ignored; verified UID is authoritative', async () => {
  let received;
  const result = await invoke({ body: {
    jobId: JOB_ID, uid: 'attacker', action: 'delete', approvalStatus: 'approved',
    contactEmail: 'attacker@example.com', draftMessage: 'forged',
    approvedResumeFileId: 'attacker-drive-id', driveFileId: 'attacker-drive-id',
  }, sendApplication: async (...args) => { received = args; return { sentAt: '2026-10-05T10:00:00.000Z' }; } });
  assert.equal(result.res.statusCode, 200);
  assert.equal(received[0], UID);
  assert.equal(received[1], JOB_ID);
  assert.equal(received.length, 3);
  assert.equal(JSON.stringify(received[2]).includes('attacker-drive-id'), false);
  assert.deepEqual(Object.keys(result.res.body).sort(), ['jobId', 'message', 'schemaVersion', 'sentAt', 'threadId']);
  assert.equal(JSON.stringify(result.res.body).includes('secret'), false);
  assert.equal(JSON.stringify(result.res.body).includes('server-only'), false);
  assert.equal(JSON.stringify(result.res.body).includes('attacker-drive-id'), false);
});

test('malformed job id is rejected before invoking send', async () => {
  let called = false;
  const result = await invoke({ body: { jobId: '../other' }, sendApplication: async () => { called = true; } });
  assert.equal(result.res.statusCode, 400);
  assert.equal(called, false);
});

test('send application rejects unapproved and already sent jobs before the injected sender', async () => {
  let externalCalls = 0;
  const baseDeps = {
    loadJobDocument: async (_uid, _id) => job(),
    loadSelectedResume: async () => ({ resumeId: 'resume-1', driveFileId: 'drive-file-1' }),
    claimSend: async () => ({ ok: true }),
    releaseSendClaim: async () => {},
    callAppsScriptSend: async () => { externalCalls++; return { threadId: 'thread' }; },
    writeSendFields: async () => {},
    now: () => 1_800_000_000_000,
  };
  await assert.rejects(sendApplication(UID, JOB_ID, {
    ...baseDeps, loadJobDocument: async () => job({ approvalStatus: 'pending_review' }),
  }), /not approved/);
  await assert.rejects(sendApplication(UID, JOB_ID, {
    ...baseDeps, loadJobDocument: async () => job({ emailSentOn: '2026-10-01T00:00:00Z' }),
  }), /already been sent/);
  assert.equal(externalCalls, 0);
});

test('approval revoked between initial load and send blocks the external call', async () => {
  let reads = 0;
  let externalCalls = 0;
  await assert.rejects(sendApplication(UID, JOB_ID, {
    loadJobDocument: async () => (++reads === 1 ? job() : job({ approvalStatus: 'pending_review' })),
    loadSelectedResume: async () => ({ resumeId: 'resume-1', driveFileId: 'drive-file-1' }),
    claimSend: async () => ({ ok: true }), releaseSendClaim: async () => {},
    callAppsScriptSend: async () => { externalCalls++; return { threadId: null }; },
    writeSendFields: async () => {}, now: () => 1_800_000_000_000, logger: { error() {} },
  }), /changed|not approved/);
  assert.equal(externalCalls, 0);
});

test('draft or selected resume changes after the first read block Apps Script', async () => {
  for (const changed of [
    { draftMessage: 'different approved content' },
    { selectedResumeId: 'resume-2' },
    { matchScore: 89 },
  ]) {
    let reads = 0;
    let externalCalls = 0;
    await assert.rejects(sendApplication(UID, JOB_ID, {
      loadJobDocument: async () => (++reads === 1 ? job() : job(changed)),
      loadSelectedResume: async (current) => ({ resumeId: current.selectedResumeId, driveFileId: 'drive-file-1' }),
      claimSend: async () => ({ ok: true }), releaseSendClaim: async () => {},
      callAppsScriptSend: async () => { externalCalls++; return { threadId: null }; },
      writeSendFields: async () => {}, now: () => 1_800_000_000_000, logger: { error() {} },
    }), /changed/);
    assert.equal(externalCalls, 0);
  }
});

test('only current Firestore approved draft content is sent; caller content is never forwarded', async () => {
  const canonical = job({ draftSubject: 'Approved ✔ subject ', draftMessage: 'Hello\nApproved exact body.\n' });
  let receivedPayload;
  const result = await sendApplication(UID, JOB_ID, {
    loadJobDocument: async () => canonical,
    loadSelectedResume: async () => ({ resumeId: 'resume-1', driveFileId: 'drive-file-1' }),
    claimSend: async () => ({ ok: true }), releaseSendClaim: async () => {},
    callAppsScriptSend: async (_config, payload) => { receivedPayload = payload; return { threadId: 'thread-1' }; },
    writeSendFields: async () => {}, now: () => 1_800_000_000_000, logger: { error() {} },
  });
  assert.equal(receivedPayload.approvedSubject, canonical.draftSubject);
  assert.equal(receivedPayload.approvedMessage, canonical.draftMessage);
  assert.equal(receivedPayload.approvedResumeFileId, 'drive-file-1');
  assert.equal(result.threadId, 'thread-1');
});

test('server resolves selectedResumeId to the matching private Drive ID from the existing resume cache', async () => {
  const cached = {
    resumeId: 'resume-1', resumeLabel: 'Backend', driveFileId: 'drive-id-from-library',
    driveFileName: 'backend.pdf', extractedText: 'resume text', schemaVersion: 1,
  };
  const sheets = { spreadsheets: { values: { get: async () => ({ data: { values: [
    RESUME_CACHE_HEADERS,
    RESUME_CACHE_HEADERS.map((header) => cached[header] ?? ''),
  ] } }) } } };
  let payload;
  await sendApplication(UID, JOB_ID, {
    loadJobDocument: async () => job(),
    config: { resumeSheetId: 'server-only-sheet', resumeSheetTab: 'Resumes' }, sheets,
    claimSend: async () => ({ ok: true }), releaseSendClaim: async () => {},
    callAppsScriptSend: async (_config, data) => { payload = data; return { threadId: 'thread-1' }; },
    writeSendFields: async () => {}, now: () => 1_800_000_000_000, logger: { error() {} },
  });
  assert.equal(payload.approvedResumeFileId, 'drive-id-from-library');
});

test('missing or unavailable selected resume refuses the send with a controlled conflict', async () => {
  let externalCalls = 0;
  const base = {
    loadJobDocument: async () => job(),
    config: { resumeSheetId: 'server-only-sheet', resumeSheetTab: 'Resumes' },
    sheets: { spreadsheets: { values: { get: async () => ({ data: { values: [RESUME_CACHE_HEADERS] } }) } } },
    claimSend: async () => ({ ok: true }), releaseSendClaim: async () => {},
    callAppsScriptSend: async () => { externalCalls++; return { threadId: 'thread-1' }; },
    writeSendFields: async () => {}, now: () => 1_800_000_000_000, logger: { error() {} },
  };
  await assert.rejects(sendApplication(UID, JOB_ID, base), (error) => error.code === 'PRECONDITION_FAILED');
  await assert.rejects(sendApplication(UID, JOB_ID, {
    ...base, loadJobDocument: async () => job({ selectedResumeId: '' }),
  }), (error) => error.code === 'PRECONDITION_FAILED');
  assert.equal(externalCalls, 0);
});

test('resume cache mapping changes after the first read block Apps Script', async () => {
  let reads = 0;
  let externalCalls = 0;
  await assert.rejects(sendApplication(UID, JOB_ID, {
    loadJobDocument: async () => job(),
    loadSelectedResume: async () => ({ resumeId: 'resume-1', driveFileId: ++reads === 1 ? 'drive-file-1' : 'drive-file-2' }),
    claimSend: async () => ({ ok: true }), releaseSendClaim: async () => {},
    callAppsScriptSend: async () => { externalCalls++; return { threadId: 'thread-1' }; },
    writeSendFields: async () => {}, now: () => 1_800_000_000_000, logger: { error() {} },
  }), /selected resume file changed/);
  assert.equal(externalCalls, 0);
});

test('two simultaneous calls permit only one external send and persistence', async () => {
  let claimed = false;
  let calls = 0;
  let persisted = 0;
  const deps = {
    loadJobDocument: async () => job(),
    loadSelectedResume: async () => ({ resumeId: 'resume-1', driveFileId: 'drive-file-1' }),
    claimSend: async () => {
      if (claimed) return { ok: false, reason: 'busy' };
      claimed = true; return { ok: true };
    },
    releaseSendClaim: async () => { claimed = false; },
    callAppsScriptSend: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 10)); return { threadId: 'thread-1' }; },
    writeSendFields: async () => { persisted++; },
    now: () => 1_800_000_000_000,
    logger: { error() {} },
  };
  const outcomes = await Promise.allSettled([
    sendApplication(UID, JOB_ID, deps), sendApplication(UID, JOB_ID, deps),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((item) => item.status === 'rejected' && item.reason.code === 'SEND_CONFLICT').length, 1);
  assert.equal(calls, 1);
  assert.equal(persisted, 1);
});

test('successful send followed by a second attempt is rejected without another external call', async () => {
  let currentJob = job();
  let calls = 0;
  const deps = {
    loadJobDocument: async () => currentJob,
    loadSelectedResume: async () => ({ resumeId: 'resume-1', driveFileId: 'drive-file-1' }),
    claimSend: async () => ({ ok: true }), releaseSendClaim: async () => {},
    callAppsScriptSend: async () => { calls++; return { threadId: 'thread-1' }; },
    writeSendFields: async (_uid, _id, fields) => { currentJob = { ...currentJob, ...fields }; },
    now: () => 1_800_000_000_000, logger: { error() {} },
  };
  await sendApplication(UID, JOB_ID, deps);
  await assert.rejects(sendApplication(UID, JOB_ID, deps), /already been sent/);
  assert.equal(calls, 1);
});

test('retry after ambiguous Apps Script timeout is stopped by Apps Script duplicate confirmation', async () => {
  let gmailAlreadySent = false;
  let attempts = 0;
  const deps = {
    loadJobDocument: async () => job(),
    loadSelectedResume: async () => ({ resumeId: 'resume-1', driveFileId: 'drive-file-1' }),
    claimSend: async () => ({ ok: true }), releaseSendClaim: async () => {},
    callAppsScriptSend: async () => {
      attempts++;
      if (!gmailAlreadySent) {
        gmailAlreadySent = true; // Fake Apps Script/Gmail performed the first send before its response timed out.
        throw new Error('simulated Apps Script timeout');
      }
      throw new Error('Apps Script duplicateRow_ reports already sent');
    },
    writeSendFields: async () => { throw new Error('ambiguous send must not persist success'); },
    now: () => 1_800_000_000_000, logger: { error() {} },
  };
  await assert.rejects(sendApplication(UID, JOB_ID, deps), /Unable to confirm/);
  await assert.rejects(sendApplication(UID, JOB_ID, deps), /Unable to confirm/);
  assert.equal(gmailAlreadySent, true);
  assert.equal(attempts, 2);
});

test('Apps Script bridge uses only hardcoded send and jobs actions and confirms Sent', async () => {
  const actions = [];
  const result = await callAppsScriptSend({ appsScriptUrl: 'https://example.test/exec', appsScriptToken: 'server-secret' }, {
    company: 'Example', role: 'Engineer', contactEmail: 'candidate@example.com',
    action: 'delete', token: 'attacker', approvedResumeFileId: 'selected-drive-id',
  }, async (_url, init) => {
    const body = JSON.parse(init.body); actions.push(body);
    return { ok: true, status: 200, text: async () => JSON.stringify(body.action === 'send'
      ? { ok: true, message: 'processed' }
      : { ok: true, data: [{ company: 'Example', role: 'Engineer', contactEmail: 'candidate@example.com', status: 'Sent', threadId: 'gmail-thread' }] }) };
  });
  assert.equal(result.threadId, 'gmail-thread');
  assert.deepEqual(actions.map((entry) => entry.action), ['send', 'jobs']);
  assert.equal(actions[0].token, 'server-secret');
  assert.equal(actions[0].data.approvedResumeFileId, 'selected-drive-id');
  assert.equal(Object.hasOwn(actions[0].data, 'action'), false);
  assert.equal(Object.hasOwn(actions[0].data, 'token'), false);
});

test('Apps Script ambiguous/failure response is not accepted as success', async () => {
  let count = 0;
  await assert.rejects(callAppsScriptSend({ appsScriptUrl: 'https://example.test', appsScriptToken: 'x' }, {
    company: 'Example', role: 'Engineer', contactEmail: 'candidate@example.com',
  }, async () => ({ ok: true, status: 200, text: async () => JSON.stringify(++count === 1
    ? { ok: true }
    : { ok: true, data: [{ company: 'Example', role: 'Engineer', contactEmail: 'candidate@example.com', status: 'Failed: quota' }] }) })), /did not confirm/);
});

test('provider details are not returned to the client and failures do not persist success', async () => {
  let writes = 0;
  let releases = 0;
  const error = new Error('private provider response with token abc');
  await assert.rejects(sendApplication(UID, JOB_ID, {
    loadJobDocument: async () => job(), loadSelectedResume: async () => ({ resumeId: 'resume-1', driveFileId: 'drive-file-1' }),
    claimSend: async () => ({ ok: true }), releaseSendClaim: async () => { releases++; },
    callAppsScriptSend: async () => { throw error; }, writeSendFields: async () => { writes++; },
    now: () => 1_800_000_000_000, logger: { error() {} },
  }), (caught) => caught.message === 'Unable to confirm that the application was sent.' && !caught.message.includes('abc'));
  assert.equal(writes, 0);
  assert.equal(releases, 1);
});

test('API uses the fixed safe response for backend and provider errors', async () => {
  const result = await invoke({ sendApplication: async () => { throw new Error('APPS_SCRIPT_TOKEN=secret'); } });
  assert.equal(result.res.statusCode, 500);
  assert.deepEqual(result.res.body, { error: 'Unable to confirm that the application was sent.' });
});
