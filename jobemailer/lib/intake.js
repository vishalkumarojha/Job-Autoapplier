/**
 * Smart Intake request validation and extraction normalization.
 *
 * Two distinct trust boundaries live here, and they are deliberately separated:
 *
 *   1. `parseRequestBody`  — validates what a *client* sent. Failures are the caller's
 *      fault and become HTTP 400 with a message that describes only their own input.
 *   2. `normalizeExtraction` — validates what *Claude* returned. Failures are a provider
 *      contract break and become HTTP 500 with a fixed message that never echoes the
 *      model's output, because model output can quote the posting verbatim.
 *
 * Neither function performs I/O, and neither reads `process.env`, so every rule below is
 * exercised directly by tests with plain objects.
 *
 * Vocabulary note: `INTAKE_SOURCES` is the single source of truth for accepted `source`
 * values on the server, and it mirrors `JOB_RAW_SOURCES` in `PassX-Easeout/src/domain/job.ts`.
 * The two lists must stay identical — there is exactly one vocabulary, not two.
 */

/** Bumped when the response shape changes in a way older clients cannot handle. */
export const INTAKE_SCHEMA_VERSION = 1;

/**
 * Maximum accepted `rawText`, in characters.
 *
 * Rejected rather than truncated: silently cutting a posting would drop the very lines a
 * deadline or contact address might appear on, and a truncated extraction looks identical
 * to a complete one.
 */
export const INTAKE_MAX_RAW_CHARS = 20000;

/** The one source vocabulary, mirrored by `JOB_RAW_SOURCES` on the mobile side. */
export const INTAKE_SOURCES = [
  'paste',
  'share_android',
  'manual',
  'email',
  'linkedin',
  'x',
  'referral',
  'other',
];

/** Fields that carry an individual extraction confidence. */
export const INTAKE_CONFIDENCE_FIELDS = [
  'company',
  'contactName',
  'contactEmail',
  'role',
  'jobUrl',
  'location',
  'deadline',
];

/**
 * Ceiling on `notes`.
 *
 * A summary longer than this is not a summary, it is the posting copied back. Beyond that
 * the value is dropped rather than kept, because the raw text is already stored alongside
 * the job and duplicating it in two fields helps nobody.
 */
export const INTAKE_MAX_NOTES_CHARS = 1200;

/** The caller sent something the endpoint cannot accept. Maps to HTTP 400. */
export class RequestValidationError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'RequestValidationError';
    this.reason = reason;
  }
}

/** Claude returned something that does not satisfy the schema. Maps to HTTP 500. */
export class InvalidExtractionError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'InvalidExtractionError';
    this.reason = reason;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collapses all runs of whitespace, so a value split across lines still compares equal. */
function squash(value) {
  return value.replace(/\s+/g, ' ').trim();
}

// ─── Request validation ────────────────────────────────────────────────────────

/**
 * Validates an already-parsed JSON body for `POST /api/intake`.
 *
 * JSON syntax is checked by the handler, because a body that never parsed is a different
 * failure from a body that parsed into the wrong shape.
 *
 * @returns {{ rawText: string, source: string }} the trimmed, length-checked input
 * @throws {RequestValidationError} with a message safe to return to the caller
 */
export function parseRequestBody(body) {
  if (!isPlainObject(body)) {
    throw new RequestValidationError('The request body must be a JSON object.');
  }

  const { rawText, source } = body;

  if (typeof rawText !== 'string') {
    throw new RequestValidationError('Job posting text is required.');
  }
  const trimmed = rawText.trim();
  if (trimmed === '') {
    throw new RequestValidationError('Paste a job posting before extracting.');
  }
  if (trimmed.length > INTAKE_MAX_RAW_CHARS) {
    throw new RequestValidationError(
      `That job posting is too long (${trimmed.length.toLocaleString('en-US')} characters). ` +
        `The maximum is ${INTAKE_MAX_RAW_CHARS.toLocaleString('en-US')}.`,
    );
  }

  if (typeof source !== 'string' || !INTAKE_SOURCES.includes(source.trim())) {
    throw new RequestValidationError('That source is not supported.');
  }

  return { rawText: trimmed, source: source.trim() };
}

// ─── Field normalization ───────────────────────────────────────────────────────

/** Trims, and turns empty/whitespace-only into null. Non-strings are a schema break. */
function optionalString(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new InvalidExtractionError(`${field} must be a string or null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The email must be syntactically valid. Anything else is a schema break, not a null. */
function normalizeEmail(value, field) {
  const text = optionalString(value, field);
  if (text === null) return null;
  const lower = text.toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(lower)) {
    throw new InvalidExtractionError(`${field} is not a valid email address`);
  }
  return lower;
}

/**
 * Turns a job URL into a canonical `http(s)` URL, or throws when it cannot be one.
 *
 * A missing scheme is added rather than rejected: `linkedin.com/jobs/123` and
 * `https://linkedin.com/jobs/123` are the same address, and failing the whole extraction
 * over a prefix the model omitted would be a worse outcome than normalizing it. Anything
 * that still is not a usable http(s) URL after normalization is rejected.
 */
function normalizeUrl(value, field) {
  const text = optionalString(value, field);
  if (text === null) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new InvalidExtractionError(`${field} is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidExtractionError(`${field} is not a valid URL`);
  }
  if (!parsed.hostname.includes('.')) {
    throw new InvalidExtractionError(`${field} is not a valid URL`);
  }
  return parsed.toString();
}

/** How a URL is compared against the source text: scheme, `www.`, and case are noise. */
function comparableUrl(value) {
  return value
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/**
 * Accepts only a real ISO-8601 date or date-time, normalized to a UTC instant.
 *
 * This is intentionally strict. `new Date('tomorrow')` is invalid, but `new Date('Oct 12
 * 2026')` is not, so pattern-matching first is what stops "31 Feb", "ASAP", or a
 * locale-formatted date from being silently accepted as a real deadline.
 *
 * @returns {string|null} ISO-8601 UTC instant, or null when there is no deadline
 * @throws {InvalidExtractionError} when the value is neither null nor a valid ISO date
 */
export function normalizeDeadline(value, field = 'deadline') {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new InvalidExtractionError(`${field} must be a string or null`);

  const text = value.trim();
  if (text === '') return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (!match) throw new InvalidExtractionError(`${field} is not an ISO-8601 date`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Round-trip check: `new Date(Date.UTC(2026, 1, 31))` becomes 3 March, so a date that
  // does not exist would otherwise survive as a real but wrong deadline.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new InvalidExtractionError(`${field} is not a real date`);
  }

  // Date-only and zone-less values are interpreted as UTC: a deadline is a calendar day,
  // and `new Date('2026-10-12T09:30:00')` would otherwise be read in whatever timezone the
  // server happens to run in, which makes the same posting yield a different instant on a
  // developer laptop than in production.
  if (match[4] === undefined) return `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;

  const hasOffset = match[8] !== undefined;
  const normalizedText = hasOffset ? text.replace(/[zZ]$/, 'Z') : `${text}Z`;
  const asDate = new Date(normalizedText);
  if (Number.isNaN(asDate.getTime())) throw new InvalidExtractionError(`${field} is not an ISO-8601 date`);
  return asDate.toISOString();
}

/**
 * Validates the per-field confidence object.
 *
 * Out-of-range and non-numeric values are rejected rather than clamped. Clamping would
 * silently repair a provider that has stopped honouring the contract, and the first sign of
 * that would otherwise be a screen quietly showing 1.0 for everything it was unsure about.
 *
 * Missing keys become 0 — "not assessed" reads as no confidence, which is the safe
 * direction. Unknown keys are dropped, so a model inventing a confidence for a field that
 * does not exist cannot reach a client.
 */
export function normalizeConfidence(value) {
  if (!isPlainObject(value)) throw new InvalidExtractionError('fieldConfidence must be an object');

  const result = {};
  for (const field of INTAKE_CONFIDENCE_FIELDS) {
    const entry = value[field];
    if (entry === undefined || entry === null) {
      result[field] = 0;
      continue;
    }
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new InvalidExtractionError(`fieldConfidence.${field} must be a number`);
    }
    if (entry < 0 || entry > 1) {
      throw new InvalidExtractionError(`fieldConfidence.${field} must be between 0 and 1`);
    }
    result[field] = entry;
  }
  return result;
}

// ─── Extraction normalization ──────────────────────────────────────────────────

/**
 * Validates and normalizes the object Claude returned.
 *
 * The rules that matter most are the two *verification* checks, because they are the only
 * server-side defence against a hallucination reaching a human:
 *
 * - `contactEmail` must literally appear in `rawText`. An invented recruiter address is
 *   the worst outcome this feature can produce — it is a real mailbox someone might write
 *   to — so a value that cannot be traced back to the source is dropped to null.
 * - `jobUrl` must appear in `rawText` once scheme, `www.` and case are ignored, for the
 *   same reason: a fabricated link is a phishing-shaped failure.
 *
 * Text fields (`company`, `role`, `contactName`, `location`) are not substring-checked.
 * They are reviewed by a human before anything is saved, and rejecting a legitimate
 * reformatting of "sr. software engineer" would cost more than it protects.
 *
 * `source` is not read from the model at all — it is the caller's own value, passed in.
 * If the model returned one anyway it is stripped here.
 *
 * @param {unknown} candidate the parsed model output
 * @param {{ rawText: string, source: string }} context
 * @returns the response payload, minus `source` duplication handled by the handler
 * @throws {InvalidExtractionError}
 */
export function normalizeExtraction(candidate, { rawText, source }) {
  if (!isPlainObject(candidate)) {
    throw new InvalidExtractionError('the model output was not a JSON object');
  }

  const fieldConfidence = normalizeConfidence(candidate.fieldConfidence);

  const company = optionalString(candidate.company, 'company');
  const role = optionalString(candidate.role, 'role');
  const contactName = optionalString(candidate.contactName, 'contactName');
  const location = optionalString(candidate.location, 'location');
  const deadline = normalizeDeadline(candidate.deadline);

  // Email: syntax first, then traceability against the source text.
  let contactEmail = normalizeEmail(candidate.contactEmail, 'contactEmail');
  if (contactEmail !== null && !squash(rawText).toLowerCase().includes(contactEmail)) {
    contactEmail = null;
    fieldConfidence.contactEmail = 0;
  }

  // URL: syntax first, then traceability.
  let jobUrl = normalizeUrl(candidate.jobUrl, 'jobUrl');
  if (jobUrl !== null && !squash(rawText).toLowerCase().includes(comparableUrl(jobUrl))) {
    jobUrl = null;
    fieldConfidence.jobUrl = 0;
  }

  // Notes: a summary, never a copy of the posting.
  let notes = optionalString(candidate.notes, 'notes');
  if (notes !== null) {
    const sameAsSource = squash(notes).toLowerCase() === squash(rawText).toLowerCase();
    if (sameAsSource || notes.length > INTAKE_MAX_NOTES_CHARS) notes = null;
  }

  // Confidence in a value that does not exist is nonsense, so null forces 0. The prompt
  // already asks the model for this; enforcing it catches the case where it reports 0.7
  // for a field it returned as null, which would otherwise read as "sure there is no
  // email" on the review screen.
  const values = { company, contactName, contactEmail, role, jobUrl, location, deadline };
  for (const field of INTAKE_CONFIDENCE_FIELDS) {
    if (values[field] === null) fieldConfidence[field] = 0;
  }

  return {
    source,
    company,
    contactName,
    contactEmail,
    role,
    jobUrl,
    location,
    notes,
    deadline,
    fieldConfidence,
  };
}
