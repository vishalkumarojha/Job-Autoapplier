/**
 * Firebase ID token verification for Vercel endpoints.
 *
 * This is the only caller-facing authentication in the project. The legacy `/api/rpc`
 * endpoint authenticates the *Apps Script* hop with a server-side secret while never
 * authenticating its own caller; this module is the replacement pattern and must not be
 * copied from that endpoint.
 *
 * Rules for this file:
 * - The token is read, used, and discarded. It is never logged, echoed, or returned.
 * - The `uid` always comes from the *verified* token. A `uid` supplied in the query string
 *   or request body is ignored entirely, so a caller cannot read another user's data by
 *   asking for it.
 * - Failures are reported as a single opaque 401. Distinguishing "expired" from "malformed"
 *   in the response body would tell an attacker which part of a forged token was wrong.
 */

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { ConfigError, firebaseCredentialConfig, parseServiceAccount } from './config.js';

/** Thrown when a request cannot be authenticated. Always maps to HTTP 401. */
export class UnauthenticatedError extends Error {
  constructor(detail = 'Authentication required.') {
    super(detail);
    this.name = 'UnauthenticatedError';
  }
}

/** Matches the RFC 6750 Bearer form, tolerating extra internal whitespace. */
const BEARER_PATTERN = /^Bearer[ \t]+(\S+)$/i;

/**
 * Extracts the bearer token from an incoming request.
 *
 * Node lowercases incoming header names, but tests and some runtimes preserve the
 * original casing, so both spellings are checked.
 */
export function readBearerToken(req) {
  const headers = (req && req.headers) || {};
  const raw = headers.authorization ?? headers.Authorization;
  if (typeof raw !== 'string') return null;
  const match = BEARER_PATTERN.exec(raw.trim());
  return match ? match[1] : null;
}

/**
 * Lazily initializes the Firebase Admin app. Reuses an existing app when one is present so
 * the Vercel warm-start path does not re-initialize on every request.
 *
 * Exported because the matching route needs the same Admin app to reach Firestore, and two
 * independent initializers would race on the first request of a cold start — whoever won
 * would decide the process's credential for good.
 */
export function firebaseApp(config) {
  if (getApps().length === 0) {
    const credential = parseServiceAccount(config);
    if (!credential.projectId || !credential.clientEmail || !credential.privateKey) {
      throw new ConfigError([
        'GOOGLE_SERVICE_ACCOUNT_JSON (or FIREBASE_ADMIN_PROJECT_ID + FIREBASE_ADMIN_CLIENT_EMAIL + FIREBASE_ADMIN_PRIVATE_KEY)',
      ]);
    }
    initializeApp({ credential: cert(credential), projectId: credential.projectId });
  }
  return getApps()[0];
}

function firebaseAuth(config) {
  return getAuth(firebaseApp(config));
}

/**
 * Verifies the request's Firebase ID token.
 *
 * `deps.verifyIdToken` is injectable so tests can exercise the header handling and the
 * 401 paths without a live Firebase project.
 *
 * When no verifier is supplied, the credential comes from `deps.config` or from
 * `firebaseCredentialConfig()` — the credential *only*. It deliberately does not read
 * `resumeLibraryConfig()`, because `/api/intake` verifies tokens without touching Drive or
 * Sheets and must not require variables it never uses.
 *
 * Returns the decoded token, whose `uid` is the authenticated identity. Throws
 * `UnauthenticatedError` for a missing, malformed, or invalid token.
 */
export async function authenticate(req, deps = {}) {
  const token = readBearerToken(req);
  if (!token) throw new UnauthenticatedError();

  const verify = deps.verifyIdToken ?? (async (candidate) => {
    const auth = firebaseAuth(deps.config ?? firebaseCredentialConfig());
    return auth.verifyIdToken(candidate);
  });

  let decoded;
  try {
    decoded = await verify(token);
  } catch {
    // Deliberately opaque: an expired token and a forged token are indistinguishable to
    // the caller, and the underlying reason is not theirs to know.
    throw new UnauthenticatedError();
  }

  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) {
    throw new UnauthenticatedError();
  }
  return decoded;
}
