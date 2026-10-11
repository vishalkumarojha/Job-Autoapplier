/**
 * The error vocabulary shared by the API layer.
 *
 * Rules for this file:
 * - Zero imports. Kept dependency-free so `client.ts`, `authToken.ts`, and their tests can
 *   all share it without any of them pulling in Firebase or React Native.
 * - No credential, token, or full request URL appears in any message. These strings reach
 *   crash reports and user-facing copy, where a leaked token would outlive the session.
 */

/** Machine-readable failure categories, so callers can branch without string matching. */
export type ApiErrorKind =
  | 'not_authenticated' // no local session; the token was never attached
  | 'unauthorized' // token attached but rejected (expired, wrong project, wrong audience)
  | 'forbidden'
  | 'not_found'
  | 'server' // 5xx
  | 'malformed_response' // reached the server, could not read the body
  | 'network' // never reached the server
  | 'timeout'
  | 'canceled' // the caller's AbortSignal fired, e.g. the screen unmounted
  | 'client'; // other 4xx

/** A failed API call. Branch on `kind`; `message` is for humans. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;

  constructor(kind: ApiErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }

  /** True when re-authenticating could plausibly fix this. */
  get isAuthProblem(): boolean {
    return this.kind === 'not_authenticated' || this.kind === 'unauthorized';
  }

  /**
   * True for outcomes that are expected during normal use, so a screen can stay quiet
   * instead of surfacing an error the user did not cause.
   */
  get isBenign(): boolean {
    return this.kind === 'canceled';
  }
}

/**
 * Raised when a request needs a credential but nobody is signed in.
 *
 * Defined here rather than in `authToken.ts` so the client can recognise it without
 * importing the module that talks to Firebase.
 */
export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not signed in. Sign in before calling the API.');
    this.name = 'NotAuthenticatedError';
  }
}

/** Maps an HTTP status onto a failure kind. */
export function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'client';
}
