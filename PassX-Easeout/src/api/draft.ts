/**
 * Outreach draft API client.
 *
 * Calls `POST /api/draft`, which reads the job's confirmed intake, its selected resume, and
 * the match that chose it, sends those to the model server-side, and returns one concise
 * outreach email as a subject and a message body. The server persists the four draft fields
 * on the caller's own job document; this client returns the same values so the screen can
 * render without waiting for a repository round-trip.
 *
 * What this module deliberately does *not* do:
 *
 * - It never sends a mail. There is no send, approve, or status-change call anywhere in the
 *   Phase 7 surface, and none belongs in here later without a spec that asks for it.
 * - It never sends a resume. `extractedText`, Drive ids, and Drive file names are server-side
 *   only; the request body carries `jobId` and nothing else.
 * - It never sends a uid. Identity comes from the verified ID token, so a body field named
 *   `uid` would be read and ignored — there is no point emitting one.
 * - It never invents the persistence contract. `draftEditedByHuman` is written by the server
 *   when it generates, and by the screen when a human types. This module only transports.
 *
 * The response is validated rather than cast, and strictly: a draft is prose the user is
 * about to put their name on, so a subject of `42` or a body that is not a string is a
 * contract violation, not something to render and let them notice.
 */

import { apiRequest, type FetchLike } from './client';
import { requireIdToken } from './authToken';

const DRAFT_PATH = '/api/draft';

/**
 * The version of the `POST /api/draft` response envelope this build understands.
 *
 * Deliberately a local constant rather than an import from `domain/job`: the domain type
 * describes the four *persisted* fields, whereas this is the shape of the transport
 * response, which also carries `schemaVersion` and `generatedAt`. They move independently —
 * adding a persisted field would not change this contract.
 */
export const DRAFT_SCHEMA_VERSION = 1;

/** Mirrors the server's `DRAFT_MAX_SUBJECT_CHARS`. A longer subject is rejected, not clipped. */
export const DRAFT_MAX_SUBJECT_CHARS = 200;

/** Mirrors the server's `DRAFT_MAX_MESSAGE_CHARS`. */
export const DRAFT_MAX_MESSAGE_CHARS = 4000;

/** The validated projection of a `POST /api/draft` response. */
export interface DraftResult {
  schemaVersion: number;
  jobId: string;
  draftSubject: string;
  draftMessage: string;
  /** Server clock at generation. Never model-supplied; see the server's `generatedAt` rule. */
  generatedAt: string;
}

/** Raised when the server's payload does not match `DraftResult`. */
export class InvalidDraftResponseError extends Error {
  constructor(reason: string) {
    super(`The outreach draft was not in the expected format: ${reason}`);
    this.name = 'InvalidDraftResponseError';
  }
}

export interface GenerateDraftOptions {
  fetchImpl?: FetchLike;
  getToken?: () => Promise<string | null>;
  /** Cancels the call. A cancelled request is silent: it is not an error the user caused. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

function asObject(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidDraftResponseError(`${field} was not an object`);
  }
  return raw as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvalidDraftResponseError(`${field} is missing`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new InvalidDraftResponseError(`${field} is longer than ${max} characters`);
  }
  return trimmed;
}

/**
 * Validates the envelope.
 *
 * `schemaVersion` is forward-tolerant — a newer server may version the response again while
 * the subject and body inside it mean the same thing — but a version older than this build
 * is refused rather than reinterpreted, because we cannot know what the fields used to mean.
 */
function toDraftResult(raw: unknown): DraftResult {
  const value = asObject(raw, 'the response');

  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw new InvalidDraftResponseError('schemaVersion is missing');
  }
  if (schemaVersion < DRAFT_SCHEMA_VERSION) {
    throw new InvalidDraftResponseError(`draft schemaVersion ${schemaVersion} is too old`);
  }

  const generatedAt = asNonEmptyString(value.generatedAt, 'generatedAt', 64);
  // The stamp is displayed as "Generated …". A value the platform cannot parse would show
  // as an Invalid Date, which is worse than refusing the payload outright.
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new InvalidDraftResponseError('generatedAt is not a timestamp');
  }

  return {
    schemaVersion,
    jobId: asNonEmptyString(value.jobId, 'jobId', 128),
    draftSubject: asNonEmptyString(value.draftSubject, 'draftSubject', DRAFT_MAX_SUBJECT_CHARS),
    draftMessage: asNonEmptyString(value.draftMessage, 'draftMessage', DRAFT_MAX_MESSAGE_CHARS),
    generatedAt,
  };
}

/** True when the payload is an envelope this build can render, without throwing. */
export function isValidDraftPayload(raw: unknown): raw is DraftResult {
  try {
    toDraftResult(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks the server to generate an outreach draft for one job.
 *
 * The server persists `draftSubject`, `draftMessage`, `draftGeneratedAt`, and resets
 * `draftEditedByHuman`; this returns the same subject and body so the caller can render
 * without waiting. Callers should still refresh, so the screen shows the state a reload
 * would produce — including the reset edit flag.
 */
export async function generateDraft(
  jobId: string,
  options: GenerateDraftOptions = {},
): Promise<DraftResult> {
  const { fetchImpl, getToken = requireIdToken, signal, timeoutMs } = options;
  const raw = await apiRequest<unknown>(
    DRAFT_PATH,
    { method: 'POST', body: { jobId }, getToken, signal, timeoutMs },
    fetchImpl,
  );
  return toDraftResult(raw);
}
