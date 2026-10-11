import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNormalizedIsoDate, reminderCandidates, reminderText, runReminderSweep, sendExpoPush, sendTelegramReminder, validExpoPushToken } from '../lib/reminders.js';

test('deadline and due follow-up produce canonical deterministic events; archived and malformed jobs do not', () => {
  const now = Date.parse('2026-10-06T09:00:00.000Z');
  const job = { id: 'j1', company: 'Acme', role: 'Engineer', deadline: '2026-10-07T09:00:00.000Z', nextReminderAt: '2026-10-06T08:00:00.000Z', followUpStatus: 'scheduled', emailSentOn: '2026-10-01T09:00:00.000Z' };
  assert.deepEqual(reminderCandidates(job, now).map((e) => e.key), ['j1:deadline:2026-10-07', 'j1:followup:2026-10-06']);
  assert.equal(reminderCandidates({ ...job, archivedAt: '2026-01-01' }, now).length, 0);
  assert.equal(reminderCandidates({ ...job, deadline: 'tomorrow', nextReminderAt: 'bad' }, now).length, 0);
  assert.equal(parseNormalizedIsoDate('2026-02-31T09:00:00.000Z'), null);
  assert.equal(reminderCandidates({ ...job, followUpStatus: 'complete' }, now).length, 1);
});

test('push and Telegram use injected transports and keep payloads limited to reminder metadata', async () => {
  const calls = [];
  const fetch = async (...args) => { calls.push(args); return { ok: true }; };
  const event = { type: 'followup', jobId: 'j1', company: 'Acme', role: 'Engineer', relevantDate: '2026-10-06T08:00:00.000Z' };
  await sendExpoPush('ExpoPushToken[abcdefgh12345678]', event, fetch);
  await sendTelegramReminder(event, { botToken: 'secret', chatId: '42' }, fetch);
  assert.equal(calls.length, 2);
  assert.match(JSON.parse(calls[1][1].body).text, /Acme — Engineer/);
  assert.equal(JSON.stringify(calls).includes('resume'), false);
  await assert.rejects(sendTelegramReminder(event, { botToken: 'secret', chatId: '42' }, async () => ({ ok: false })), /Telegram delivery failed/);
  assert.equal(validExpoPushToken('ExpoPushToken[abcdefgh12345678]'), true);
  assert.equal(validExpoPushToken('not-a-token'), false);
});

test('reminder sweep deduplicates repeat runs with a Firestore event claim', async () => {
  const events = new Map();
  const jobData = { schemaVersion: 1, company: 'Acme', role: 'Engineer', deadline: '2026-10-07T09:00:00.000Z' };
  const jobSnap = { id: 'j1', data: () => jobData, ref: { parent: { parent: { id: 'u1' } } } };
  const db = {
    collectionGroup: () => ({ get: async () => ({ docs: [jobSnap] }) }),
    doc: (path) => ({ path, update: async (patch) => Object.assign(events.get(path), patch), collection: () => ({ get: async () => ({ docs: [{ data: () => ({ token: 'fake-token' }) }] }) }) }),
    runTransaction: async (fn) => fn({ get: async (ref) => ({ exists: events.has(ref.path), data: () => events.get(ref.path) }), create: (ref, data) => events.set(ref.path, data), set: (ref, data) => events.set(ref.path, data) }),
  };
  let sends = 0;
  const deps = { db, config: {}, now: Date.parse('2026-10-06T09:00:00Z'), push: async () => { sends++; } };
  assert.equal((await runReminderSweep(deps)).delivered, 1);
  assert.equal((await runReminderSweep(deps)).skipped, 1);
  assert.equal(sends, 1);
  jobData.applicationStatus = 'interview';
  jobData.updatedAt = '2026-10-06T10:00:00.000Z';
  assert.equal((await runReminderSweep(deps)).delivered, 1);
  assert.equal(sends, 2);
  jobData.followUpStatus = 'sent';
  jobData.followUpLastSentAt = '2026-10-06T11:00:00.000Z';
  jobData.updatedAt = '2026-10-06T11:01:00.000Z';
  assert.equal((await runReminderSweep(deps)).delivered, 1);
  assert.equal(sends, 3);
  assert.match(reminderText({ type: 'deadline', company: 'Acme', role: 'Engineer', relevantDate: '2026-10-07T00:00:00.000Z' }), /Deadline reminder/);
});
