/**
 * Runtime configuration for outbound HTTP calls.
 *
 * Rules for this file:
 * - Read configuration lazily, at call time, never at module load. Expo inlines
 *   `EXPO_PUBLIC_*` variables during bundling, and reading them lazily keeps the value
 *   observable to tests, which can set `process.env` between assertions.
 * - Only `EXPO_PUBLIC_*` values belong here. Anything without that prefix is stripped
 *   from the app bundle by Expo and is therefore unreadable on the client.
 * - Never store an API token, shared secret, or service-account credential in this file.
 *   It is compiled into a JavaScript bundle that can be extracted from a device. The one
 *   credential this app sends is a short-lived Firebase ID token obtained per request
 *   from `src/api/authToken.ts`.
 *
 * There is deliberately no default. A missing base URL is a deployment mistake, and
 * silently falling back to a placeholder would send requests somewhere unintended.
 */

/** Name of the `EXPO_PUBLIC_` variable holding the backend origin. */
export const API_BASE_URL_ENV_VAR = 'EXPO_PUBLIC_JOBEMAILER_API_URL';

/** Raised when the backend origin is not configured. */
export class MissingApiBaseUrlError extends Error {
  constructor() {
    super(
      `${API_BASE_URL_ENV_VAR} is not set. Add it to .env (see .env.example) and restart the dev server; ` +
        'Expo only inlines EXPO_PUBLIC_* values at bundle time.',
    );
    this.name = 'MissingApiBaseUrlError';
  }
}

/**
 * The backend origin, normalized with no trailing slash so callers can concatenate
 * paths as `${baseUrl()}/api/resumes` without producing a double slash.
 *
 * Throws `MissingApiBaseUrlError` when unset.
 */
export function apiBaseUrl(): string {
  const raw = process.env[API_BASE_URL_ENV_VAR];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) throw new MissingApiBaseUrlError();
  return trimmed.replace(/\/+$/, '');
}
