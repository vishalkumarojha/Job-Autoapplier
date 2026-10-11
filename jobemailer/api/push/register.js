import { createHash } from 'node:crypto';
import { authenticate, firebaseApp } from '../../lib/auth.js';
import { firebaseCredentialConfig } from '../../lib/config.js';
import { getFirestore } from 'firebase-admin/firestore';
import { validExpoPushToken } from '../../lib/reminders.js';

export function createPushRegistrationHandler(deps = {}) {
 return async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const suppliedConfig = deps.config ?? (deps.getConfig ? deps.getConfig() : null);
    const identity = await (deps.authenticate ?? authenticate)(req, suppliedConfig ? { config: suppliedConfig } : {});
    const config = suppliedConfig ?? firebaseCredentialConfig();
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    if (!validExpoPushToken(body.token) || !['android', 'ios'].includes(body.platform)) return res.status(400).json({ error: 'Invalid push registration.' });
    const db = deps.db ?? getFirestore(firebaseApp(config));
    const id = createHash('sha256').update(body.token).digest('hex');
    await db.doc(`users/${identity.uid}/pushTokens/${id}`).set({ uid: identity.uid, token: body.token, platform: body.platform, updatedAt: new Date().toISOString() }, { merge: true });
    return res.status(204).end();
  } catch (error) {
    if (error?.name === 'UnauthenticatedError') return res.status(401).json({ error: 'Authentication required.' });
    return res.status(500).json({ error: 'Push registration is unavailable.' });
  }
 };
}

export default createPushRegistrationHandler();
