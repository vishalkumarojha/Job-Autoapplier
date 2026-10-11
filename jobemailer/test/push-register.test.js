import test from 'node:test';
import assert from 'node:assert/strict';
import { createPushRegistrationHandler } from '../api/push/register.js';

function response() { return { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, end() { return this; } }; }

test('push registration authenticates, ignores body uid, and upserts one hashed token record without echoing token', async () => {
  const records = new Map();
  const db = { doc(path) { return { set: async (value) => records.set(path, value) }; } };
  const handler = createPushRegistrationHandler({ config: {}, authenticate: async () => ({ uid: 'verified-user' }), db });
  const res = response();
  await handler({ method: 'POST', body: { uid: 'attacker', token: 'ExpoPushToken[abcdefgh12345678]', platform: 'android' } }, res);
  assert.equal(res.statusCode, 204);
  assert.equal(records.size, 1);
  const [path, stored] = [...records.entries()][0];
  assert.match(path, /^users\/verified-user\/pushTokens\/[a-f0-9]{64}$/);
  assert.equal(stored.uid, 'verified-user');
  assert.equal(stored.token, 'ExpoPushToken[abcdefgh12345678]');
  assert.equal(res.body, null);
  await handler({ method: 'POST', body: { token: 'ExpoPushToken[abcdefgh12345678]', platform: 'android' } }, response());
  assert.equal(records.size, 1);
});

test('push registration rejects unauthenticated and malformed requests without persistence', async () => {
  let writes = 0;
  const db = { doc: () => ({ set: async () => { writes++; } }) };
  const unauthenticated = createPushRegistrationHandler({ config: {}, authenticate: async () => { throw Object.assign(new Error(), { name: 'UnauthenticatedError' }); }, db });
  const unauthorized = response();
  await unauthenticated({ method: 'POST', body: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  const authenticated = createPushRegistrationHandler({ config: {}, authenticate: async () => ({ uid: 'u' }), db });
  const invalid = response();
  await authenticated({ method: 'POST', body: { token: 'bad', platform: 'android' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(writes, 0);
});
