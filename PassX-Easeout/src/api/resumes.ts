/**
 * Resume Library API client.
 *
 * Read-only. This module lists resume metadata and nothing else: there is deliberately no
 * upload, no update, no delete, and no download. Selection is a write against the *Job*
 * (`JobsRepository.updateJob({ selectedResumeId })`), not against the resume, so choosing a
 * resume never needs write access to the catalog.
 *
 * The endpoint is `GET /api/resumes` on the `jobemailer` backend, authenticated with a
 * Firebase ID token, returning `{ schemaVersion, resumes, skipped }`.
 *
 * The payload is validated here rather than cast. A shape change should surface as a clear
 * error at the boundary, not as a blank list or an undefined field three screens later.
 */

import { apiRequest, type FetchLike } from './client';
import { requireIdToken } from './authToken';
import { RESUME_SCHEMA_VERSION, type ResumeSummary } from '../domain/resume';

const RESUMES_PATH = '/api/resumes';

/** Raised when the server's payload does not match `ResumeSummary`. */
export class InvalidResumesResponseError extends Error {
  constructor(reason: string) {
    super(`The resume list was not in the expected format: ${reason}`);
    this.name = 'InvalidResumesResponseError';
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new InvalidResumesResponseError(`${field} is missing`);
  return value;
}

function asStringOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new InvalidResumesResponseError(`${field} is not a string`);
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidResumesResponseError(`${field} is not a number`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new InvalidResumesResponseError(`${field} is not a boolean`);
  return value;
}

function asKeywords(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new InvalidResumesResponseError('keywords is not a string array');
  }
  return [...(value as string[])].map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

/**
 * Validates one record into a `ResumeSummary`.
 *
 * Only the known fields are read. Unknown keys are dropped rather than forwarded: the mobile
 * app should not start depending on a field it has never heard of, and passing extra keys
 * through is how server-only data such as a Drive id or the extracted resume text would end
 * up on a device by accident. The return statement is the allow-list.
 */
function toResumeSummary(raw: unknown): ResumeSummary {
  if (!raw || typeof raw !== 'object') throw new InvalidResumesResponseError('a resume entry was not an object');
  const value = raw as Record<string, unknown>;

  const schemaVersion = asNumber(value.schemaVersion, 'schemaVersion');
  if (schemaVersion < RESUME_SCHEMA_VERSION) {
    // Older than this client understands, so its field meanings cannot be trusted.
    throw new InvalidResumesResponseError(`resume schemaVersion ${schemaVersion} is too old`);
  }

  return {
    resumeId: asString(value.resumeId, 'resumeId'),
    schemaVersion,
    resumeLabel: asString(value.resumeLabel, 'resumeLabel'),
    targetRole: asStringOrNull(value.targetRole, 'targetRole'),
    // Preserved verbatim rather than checked against RESUME_ROLE_FAMILIES: rejecting an
    // unknown family would hide the resume instead of rendering it.
    targetRoleFamily: asStringOrNull(value.targetRoleFamily, 'targetRoleFamily'),
    version: asNumber(value.version, 'version'),
    isDefault: asBoolean(value.isDefault, 'isDefault'),
    keywords: asKeywords(value.keywords),
    updatedAt: asStringOrNull(value.updatedAt, 'updatedAt'),
    lastUsedAt: asStringOrNull(value.lastUsedAt, 'lastUsedAt'),
  };
}

export interface ListResumesOptions {
  signal?: AbortSignal;
  /** Overridable for tests. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Overridable for tests. Defaults to the signed-in user's Firebase ID token. */
  getToken?: () => Promise<string>;
}

/**
 * Fetches all resume metadata, authenticated.
 *
 * Throws `NotAuthenticatedError` when signed out, and `ApiError` for transport failures.
 *
 * In-memory only: this list is never persisted, so an offline launch yields an error rather
 * than stale selections.
 */
export async function listResumes(options: ListResumesOptions = {}): Promise<ResumeSummary[]> {
  const payload = await apiRequest<unknown>(
    RESUMES_PATH,
    {
      method: 'GET',
      getToken: options.getToken ?? (() => requireIdToken()),
      signal: options.signal,
    },
    options.fetchImpl,
  );

  if (!payload || typeof payload !== 'object') {
    throw new InvalidResumesResponseError('the response body was not an object');
  }
  const { resumes } = payload as { resumes?: unknown };
  if (!Array.isArray(resumes)) throw new InvalidResumesResponseError('resumes was not an array');

  return resumes.map(toResumeSummary);
}
