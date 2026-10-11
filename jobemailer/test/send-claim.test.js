import test from 'node:test';
import assert from 'node:assert/strict';
import { claimSend, releaseSendClaim, writeSendFields } from '../lib/jobs.js';

const jobPath = 'users/u/jobs/j';
const claimPath = 'users/u/sendClaims/j';

function serialFakeDb() {
  const store = new Map([[jobPath, { schemaVersion: 1, approvalStatus: 'approved', applicationStatus: 'draft' }]]);
  let tail = Promise.resolve();
  const db = {
    store,
    doc(path) {
      return {
        async get() { const value = store.get(path); return { exists: value !== undefined, data: () => value }; },
        async update(patch) { store.set(path, { ...store.get(path), ...patch }); },
      };
    },
    runTransaction(callback) {
      const current = tail;
      let unlock;
      tail = new Promise((resolve) => { unlock = resolve; });
      return current.then(async () => {
        const refPath = (ref) => ref.path;
        const tx = {
          async get(ref) { const value = store.get(refPath(ref)); return { exists: value !== undefined, data: () => value }; },
          async update(ref, patch) { store.set(refPath(ref), { ...store.get(refPath(ref)), ...patch }); },
          set(ref, value) { store.set(refPath(ref), value); },
          delete(ref) { store.delete(refPath(ref)); },
        };
        try { return await callback(tx); } finally { unlock(); }
      });
    },
  };
  const originalDoc = db.doc.bind(db);
  db.doc = (path) => ({ path, ...originalDoc(path) });
  return db;
}

test('transaction claim serializes concurrent sends and releases only its owner claim', async () => {
  const db = serialFakeDb();
  const first = await claimSend('u', 'j', 'claim-a', 1_000, { db });
  const second = await claimSend('u', 'j', 'claim-b', 1_001, { db });
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: 'busy' });
  await releaseSendClaim('u', 'j', 'claim-b', { db });
  assert.equal(db.store.get(claimPath).claimId, 'claim-a');
  await releaseSendClaim('u', 'j', 'claim-a', { db });
  assert.equal(db.store.has(claimPath), false);
});

test('expired claims recover and successful lifecycle writes are limited to send fields', async () => {
  const db = serialFakeDb();
  await claimSend('u', 'j', 'old', 1_000, { db });
  const recovered = await claimSend('u', 'j', 'new', 122_000, { db });
  assert.equal(recovered.ok, true);
  await writeSendFields('u', 'j', {
    applicationStatus: 'applied', emailSentOn: '2026-10-05T00:00:00Z', gmailThreadId: null,
    approvalStatus: 'rejected', contactEmail: 'attacker@example.com',
  }, { db, claimId: 'new' });
  assert.deepEqual(db.store.get(jobPath), {
    schemaVersion: 1, approvalStatus: 'approved', applicationStatus: 'applied',
    emailSentOn: '2026-10-05T00:00:00Z', gmailThreadId: null,
  });
  assert.equal(db.store.has(claimPath), false);
});

test('stale claim cannot persist a send result', async () => {
  const db = serialFakeDb();
  await claimSend('u', 'j', 'mine', 1_000, { db });
  await claimSend('u', 'j', 'new-owner', 122_000, { db });
  await assert.rejects(writeSendFields('u', 'j', {
    applicationStatus: 'applied', emailSentOn: '2026-10-05T00:00:00Z', gmailThreadId: null,
  }, { db, claimId: 'mine' }), { code: 'send-claim-stale' });
});
