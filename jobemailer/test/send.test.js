/**
 * Tests for `lib/send.js`, the pure half of the send bridge.
 *
 * Runs on `node:test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sendPreconditionFailure,
  mapJobToAppsScriptPayload,
  callAppsScriptSend,
  SEND_FIELDS,
} from '../lib/send.js';
import { MESSAGES } from '../lib/approval.js';

const UID = 'user-1';
const JOB_ID = 'job-1';
const NOW = '2026-10-06T12:00:00.000Z';

function approvedJob(overrides = {}) {
  return {
    schemaVersion: 1,
    intakeStatus: 'confirmed',
    selectedResumeId: 'rsv_alpha',
    matchScore: 91,
    matchBreakdown: [{ criterion: 'must_have', score: 94, weight: 0.35, rationale: 'Stack fits.' }],
    draftSubject: 'Application — Role | Name',
    draftMessage: 'Hi,\n\nI am applying.',
    approvalStatus: 'approved',
    approvedAt: '2026-10-05T08:00:00.000Z',
    approvedBy: 'someone-else',
    contactEmail: 'recruiter@example.com',
    company: 'Example Corp',
    role: 'Backend Engineer',
    jobUrl: 'https://example.com/job',
    source: 'linkedin',
    location: 'Remote',
    notes: '',
    emailSentOn: null,
    gmailThreadId: null,
    applicationStatus: 'sourced',
    ...overrides,
  };
}

function resumeRecord() {
  return {
    resumeId: 'rsv_alpha',
    driveFileId: 'drive-file-backend-v3',
    resumeLabel: 'Backend — Go — v3',
    extractedText: 'JANE DOE SENIOR BACKEND ENGINEER Go PostgreSQL',
  };
}

// ─── Payload mapping ──────────────────────────────────────────────────────────

test('maps a canonical Job to the Apps Script send payload', () => {
  const job = approvedJob();
  const resume = resumeRecord();
  const payload = mapJobToAppsScriptPayload(job, resume);

  assert.deepEqual(payload, {
    company: 'Example Corp',
    contactName: '',
    contactEmail: 'recruiter@example.com',
    role: 'Backend Engineer',
    jobLink: 'https://example.com/job',
    source: 'linkedin',
    location: 'Remote',
    notes: '',
    allowDuplicate: false,
    approvedSubject: 'Application — Role | Name',
    approvedMessage: 'Hi,\n\nI am applying.',
    approvedResumeFileId: 'drive-file-backend-v3',
  });
});

test('omits undefined fields in payload', () => {
  const job = approvedJob({ contactEmail: null, jobUrl: null, source: null });
  const resume = resumeRecord();
  const payload = mapJobToAppsScriptPayload(job, resume);

  assert.equal(payload.contactEmail, '');
  assert.equal(payload.jobLink, '');
  assert.equal(payload.source, 'linkedin');
});

test('maps the exact canonical approved subject and message into the server bridge payload', () => {
  const canonical = approvedJob({ draftSubject: ' Subject  \n', draftMessage: ' Body\nline two  ' });
  const payload = mapJobToAppsScriptPayload(canonical);
  assert.equal(payload.approvedSubject, canonical.draftSubject);
  assert.equal(payload.approvedMessage, canonical.draftMessage);
});

// ─── Precondition failures ────────────────────────────────────────────────────

test('returns null when all preconditions pass', () => {
  const job = approvedJob();
  const resume = resumeRecord();
  assert.equal(sendPreconditionFailure(job, resume), null);
});

test('fails when not approved', () => {
  const job = approvedJob({ approvalStatus: 'pending_review' });
  const resume = resumeRecord();
  assert.equal(sendPreconditionFailure(job, resume), MESSAGES.sendNotApproved);
});

test('fails when intake not confirmed', () => {
  const job = approvedJob({ intakeStatus: 'drafting' });
  const resume = resumeRecord();
  assert.equal(sendPreconditionFailure(job, resume), 'This job must be confirmed before it can be sent.');
});

test('fails when contact email missing', () => {
  const job = approvedJob({ contactEmail: '' });
  const resume = resumeRecord();
  assert.equal(sendPreconditionFailure(job, resume), 'This job is missing a recipient email.');
});

test('fails when selected resume missing', () => {
  const job = approvedJob({ selectedResumeId: '' });
  const resume = resumeRecord();
  assert.equal(sendPreconditionFailure(job, resume), 'This job has no selected resume.');
});

test('fails when match missing', () => {
  for (const override of [{ matchBreakdown: [] }, { matchScore: null }]) {
    const job = approvedJob(override);
    const resume = resumeRecord();
    assert.equal(sendPreconditionFailure(job, resume), 'This job has no match result.');
  }
});

test('fails when draft subject missing', () => {
  const job = approvedJob({ draftSubject: '' });
  const resume = resumeRecord();
  assert.equal(sendPreconditionFailure(job, resume), 'This job has no approved draft subject.');
});

test('fails when draft message missing', () => {
  const job = approvedJob({ draftMessage: '   ' });
  const resume = resumeRecord();
  assert.equal(sendPreconditionFailure(job, resume), 'This job has no approved draft message.');
});

test('fails when resume unavailable in library', () => {
  const job = approvedJob();
  assert.equal(sendPreconditionFailure(job, null), 'The selected resume is no longer available in the resume library.');
});

test('fails closed when selected resume has no server-side Drive file id', () => {
  const job = approvedJob();
  assert.equal(sendPreconditionFailure(job, { ...resumeRecord(), driveFileId: '' }), 'The selected resume has no server-side attachment file.');
});

test('fails when already sent (emailSentOn)', () => {
  const job = approvedJob({ emailSentOn: '2026-10-05T08:00:00.000Z' });
  const resume = resumeRecord();
  assert.equal(sendPreconditionFailure(job, resume), 'This application has already been sent.');
});

test('fails when already sent (gmailThreadId)', () => {
  const job = approvedJob({ gmailThreadId: 'thread-123' });
  const resume = resumeRecord();
  assert.equal(sendPreconditionFailure(job, resume), 'This application has already been sent.');
});

test('fails when already sent (applicationStatus)', () => {
  const job = approvedJob({ applicationStatus: 'applied' });
  const resume = resumeRecord();
  assert.equal(sendPreconditionFailure(job, resume), 'This application has already been sent.');
});

// ─── Apps Script call ─────────────────────────────────────────────────────────

test('callAppsScriptSend throws when config missing', async () => {
  await assert.rejects(
    () => callAppsScriptSend({}, {}),
    (error) => error.message.includes('not configured'),
  );
});

test('callAppsScriptSend throws on non-JSON response', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => 'not json at all',
  });
  await assert.rejects(
    () => callAppsScriptSend({ appsScriptUrl: 'https://example.com', appsScriptToken: 'token' }, {}, fetchImpl),
    (error) => error.message.includes('did not return JSON'),
  );
});

test('callAppsScriptSend throws on Apps Script error response', async () => {
  const fetchImpl = async () => ({
    ok: false,
    text: async () => JSON.stringify({ ok: false, code: 'DUPLICATE', message: 'Similar job already exists.' }),
  });
  await assert.rejects(
    () => callAppsScriptSend({ appsScriptUrl: 'https://example.com', appsScriptToken: 'token' }, {}, fetchImpl),
    (error) => error.code === 'DUPLICATE' && error.message.includes('already exists'),
  );
});

test('callAppsScriptSend uses the existing send/jobs actions and confirms the Sheet status', async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return {
      ok: true,
      text: async () => JSON.stringify(body.action === 'send'
        ? { ok: true, message: 'Email processed' }
        : { ok: true, data: [{ company: 'Test', role: 'Engineer', contactEmail: 'test@example.com', status: 'Sent', threadId: 'thread-123' }] }),
    };
  };
  const result = await callAppsScriptSend(
    { appsScriptUrl: 'https://example.com', appsScriptToken: 'token' },
    { company: 'Test', role: 'Engineer', contactEmail: 'test@example.com' },
    fetchImpl,
  );
  assert.deepEqual(result, { ok: true, message: 'Email processed', threadId: 'thread-123' });
  assert.deepEqual(requests.map((request) => request.action), ['send', 'jobs']);
  assert.equal(requests[0].token, 'token');
  assert.equal(requests[0].data.allowDuplicate, undefined);
});

// ─── Send fields ──────────────────────────────────────────────────────────────

test('SEND_FIELDS contains exactly the three lifecycle fields', () => {
  assert.deepEqual(SEND_FIELDS, ['applicationStatus', 'emailSentOn', 'gmailThreadId']);
});
