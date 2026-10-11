/**
 * Smart Intake API client.
 *
 * Sends raw job-posting text to `POST /api/intake` and returns the structured extraction
 * for a human to review. It does not save anything: persistence is the screen's call to
 * `JobsRepository.createJob`, which is where provenance, dedupe, and the approval gate all
 * live. Keeping this module transport-only means "extract" and "save" stay separable, so a
 * user can extract, reject the result, and never write a document.
 *
 * The app never talks to Anthropic. The model key lives only on the server; this call is
 * authenticated with the signed-in user's Firebase ID token, exactly like `listResumes`.
 *
 * The payload is validated rather than cast. A shape change should surface as a clear
 * error at the boundary, not as an undefined field three screens later.
 */

import { apiRequest, type FetchLike } from './client';
import { requireIdToken } from './authToken';
import {
  JOB_CONFIDENCE_FIELDS,
  JOB_INTAKE_SCHEMA_VERSION,
  JOB_RAW_SOURCES,
  type JobFieldConfidence,
  type JobRawSource,
} from '../domain/job';

const INTAKE_PATH = '/api/intake';

/**
 * Maximum `rawText` accepted by the server, mirrored for local validation.
 *
 * The server's `INTAKE_MAX_RAW_CHARS` is authoritative — it rejects rather than truncates.
 * This copy exists only so the app can say *why* before spending a request on it.
 */
export const INTAKE_MAX_RAW_CHARS = 20000;

/** Raised when the server's payload does not match the intake contract. */
export class InvalidIntakeResponseError extends Error {
  constructor(reason: string) {
    super(`The extraction was not in the expected format: ${reason}`);
    this.name = 'InvalidIntakeResponseError';
  }
}

/**
 * One field's extraction result.
 *
 * `deadline` is an ISO-8601 instant or null — never a sentinel such as `"No Deadline"`,
 * which the server rejects outright.
 */
export interface JobIntakeResult {
  schemaVersion: number;
  /** Capture channel, echoed from the request. Never chosen by the model. */
  source: JobRawSource;
  company: string | null;
  contactName: string | null;
  contactEmail: string | null;
  role: string | null;
  jobUrl: string | null;
  location: string | null;
  notes: string | null;
  deadline: string | null;
  fieldConfidence: JobFieldConfidence;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new InvalidIntakeResponseError(`${field} is missing`);
  return value;
}

function asStringOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new InvalidIntakeResponseError(`${field} is not a string`);
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidIntakeResponseError(`${field} is not a number`);
  }
  return value;
}

function asRawSource(value: unknown, field: string): JobRawSource {
  const text = asString(value, field);
  if (!(JOB_RAW_SOURCES as readonly string[]).includes(text)) {
    throw new InvalidIntakeResponseError(`${field} is not a known source`);
  }
  return text as JobRawSource;
}

/**
 * Validates the confidence object.
 *
 * Present values must be finite numbers in `[0,1]`; absent ones are left absent, because
 * `JobFieldConfidence` is partial and "not assessed" is a meaningful state. Unknown keys
 * are dropped — a field the app has never heard of must not start rendering somewhere.
 */
function asConfidence(value: unknown): JobFieldConfidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidIntakeResponseError('fieldConfidence is not an object');
  }
  const source = value as Record<string, unknown>;
  const result: JobFieldConfidence = {};
  // Only the known fields are read, so a key this client has never heard of cannot end up
  // rendered somewhere by a server that has grown one.
  for (const key of JOB_CONFIDENCE_FIELDS) {
    const entry = source[key];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > 1) {
      throw new InvalidIntakeResponseError(`fieldConfidence.${key} is not a number between 0 and 1`);
    }
    result[key] = entry;
  }
  return result;
}

/**
 * Validates the response body.
 *
 * Only the known fields are read. Anything else — including `rawText`, which the server
 * deliberately does not echo — is dropped by the return statement rather than passed on.
 */
export function toJobIntakeResult(raw: unknown): JobIntakeResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidIntakeResponseError('the response body was not an object');
  }
  const value = raw as Record<string, unknown>;

  const schemaVersion = asNumber(value.schemaVersion, 'schemaVersion');
  if (schemaVersion < JOB_INTAKE_SCHEMA_VERSION) {
    // Older than this client understands, so its field meanings cannot be trusted.
    throw new InvalidIntakeResponseError(`intake schemaVersion ${schemaVersion} is too old`);
  }

  const deadline = asStringOrNull(value.deadline, 'deadline');
  if (deadline !== null) {
    // The server only ever emits a normalized instant. A non-ISO value reaching the client
    // would be stored verbatim and then displayed as an arbitrary string.
    if (Number.isNaN(Date.parse(deadline))) {
      throw new InvalidIntakeResponseError('deadline is not a valid date');
    }
  }

  return {
    schemaVersion,
    source: asRawSource(value.source, 'source'),
    company: asStringOrNull(value.company, 'company'),
    contactName: asStringOrNull(value.contactName, 'contactName'),
    contactEmail: asStringOrNull(value.contactEmail, 'contactEmail'),
    role: asStringOrNull(value.role, 'role'),
    jobUrl: asStringOrNull(value.jobUrl, 'jobUrl'),
    location: asStringOrNull(value.location, 'location'),
    notes: asStringOrNull(value.notes, 'notes'),
    deadline,
    fieldConfidence: asConfidence(value.fieldConfidence),
  };
}

export interface IntakeJobOptions {
  signal?: AbortSignal;
  /** Overridable for tests. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Overridable for tests. Defaults to the signed-in user's Firebase ID token. */
  getToken?: () => Promise<string>;
}

/**
 * Extracts structured fields from raw posting text, authenticated.
 *
 * Throws `NotAuthenticatedError` when signed out, `ApiError` for transport and HTTP
 * failures (branch on `error.kind`; a cancelled request is `error.isBenign`), and
 * `InvalidIntakeResponseError` when the body does not match the contract.
 *
 * The raw text is sent but not stored here — persistence belongs to the review step.
 */
export async function intakeJob(
  rawText: string,
  source: JobRawSource,
  options: IntakeJobOptions = {},
): Promise<JobIntakeResult> {
  const payload = await apiRequest<unknown>(
    INTAKE_PATH,
    {
      method: 'POST',
      body: { rawText, source },
      getToken: options.getToken ?? (() => requireIdToken()),
      signal: options.signal,
    },
    options.fetchImpl,
  );

  return toJobIntakeResult(payload);
}
