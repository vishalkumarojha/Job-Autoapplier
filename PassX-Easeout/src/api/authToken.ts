/**
 * Firebase ID token acquisition for outbound HTTP calls.
 *
 * Kept separate from `src/context/AuthContext.tsx` on purpose. That context owns the
 * session for rendering; this module owns the credential for transport. Conflating them
 * would mean changing a shared, sensitive file to serve a narrow need.
 *
 * Tokens are fetched per request and never stored, logged, or persisted. Firebase ID
 * tokens expire roughly an hour out, so a cached copy would silently start failing; the
 * SDK also caches internally and refreshes when the cached token is near expiry, which
 * is why this asks the SDK rather than tracking expiry itself.
 */

import { auth } from '../services/firebase';
import { NotAuthenticatedError } from './errors';

export { NotAuthenticatedError };

/**
 * Returns a fresh-enough Firebase ID token for the current user, or `null` when nobody
 * is signed in.
 *
 * `forceRefresh` is for the 401 retry path: if the server rejected a token we believed
 * was valid, the cached copy was probably stale, so re-issue rather than replay it.
 */
export async function getIdToken(forceRefresh = false): Promise<string | null> {
  // `auth` is the callable namespace (`auth()` returns the Auth instance) in
  // @react-native-firebase v23, matching AuthContext's usage.
  const user = auth().currentUser;
  if (!user) return null;
  return user.getIdToken(forceRefresh);
}

/**
 * Returns an ID token or throws `NotAuthenticatedError`.
 *
 * Use this for endpoints that are authenticated by design. Returning `null` and letting
 * the request go out unauthenticated would turn an auth bug into a confusing 401 from the
 * server, and risks a route silently behaving as anonymous if it is ever loosened.
 */
export async function requireIdToken(forceRefresh = false): Promise<string> {
  const token = await getIdToken(forceRefresh);
  if (!token) throw new NotAuthenticatedError();
  return token;
}
