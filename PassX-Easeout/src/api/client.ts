/**
 * Typed HTTP client for the `jobemailer` Vercel backend.
 *
 * This is the single place the app talks to the network. Every later phase (intake,
 * matching, drafting, send) goes through here, so the auth, error, and timeout
 * behaviour is defined once instead of being re-invented per screen.
 *
 * Rules for this file:
 * - `fetch` is injected rather than referenced from `globalThis` at call time, so tests
 *   supply a fake without patching globals and so a future caller can add cancellation.
 * - The bearer token is attached by the caller-supplied token function, never stored.
 * - No credential, token, or full request URL is ever included in a thrown message.
 *   These strings end up in crash reports and user-facing copy.
 * - JSON is not assumed. A misconfigured or failing deployment can return an HTML error
 *   page, and parsing that as JSON produces a confusing `SyntaxError` instead of a
 *   useful message.
 */

import { apiBaseUrl } from '../config/env';
import { ApiError, NotAuthenticatedError, kindForStatus } from './errors';

/** Extracts the server's own message when it sent JSON, otherwise reports the status. */
async function messageFromResponse(response: Response): Promise<string> {
  const fallback = `Request failed with HTTP ${response.status}.`;
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return fallback;
  }
  if (!raw.trim()) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON. Fall through: an HTML error page is the usual case, and echoing it
    // verbatim would dump markup into the UI.
  }
  return fallback;
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST';
  /** Serialized as JSON. Omit for GET. */
  body?: unknown;
  /**
   * Returns the bearer token, or `null` to send the request unauthenticated. Omit only
   * for genuinely public routes; see `requireIdToken` for the authenticated default.
   */
  getToken?: () => Promise<string | null>;
  /** Milliseconds before the request is abandoned. Defaults to 15s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Performs one JSON request against the backend and returns the decoded body.
 *
 * Throws `ApiError` for every failure mode, including network and timeout, so callers
 * have exactly one error type to handle.
 */
export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
  fetchImpl: FetchLike = (...args) => fetch(...args),
): Promise<T> {
  const { method = 'GET', body, getToken, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;
  const url = `${apiBaseUrl()}${path}`;

  // Bail before opening a socket: an already-cancelled call should cost nothing.
  if (signal?.aborted) throw new ApiError('canceled', 'Request cancelled before it was sent.');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (getToken) {
    let token: string | null;
    try {
      token = await getToken();
    } catch (error) {
      // Fail before the request rather than letting an unauthenticated call escape; a
      // signed-out bug should surface as `not_authenticated`, not as a server 401.
      if (error instanceof NotAuthenticatedError) throw new ApiError('not_authenticated', error.message);
      throw error;
    }
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  // React Native's fetch has no timeout of its own; without this a dropped connection
  // leaves a screen spinning forever.
  const controller = new AbortController();
  // Tracked explicitly: a caller-initiated cancel and a deadline both abort the same
  // controller, and they mean different things to the UI.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort);
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw timedOut
        ? new ApiError('timeout', `Request timed out after ${timeoutMs}ms.`)
        : new ApiError('canceled', 'Request cancelled.');
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApiError('network', `Could not reach the server: ${detail}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }

  if (!response.ok) {
    throw new ApiError(kindForStatus(response.status), await messageFromResponse(response), response.status);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(
      'malformed_response',
      'The server returned a response that was not valid JSON.',
      response.status,
    );
  }
}
