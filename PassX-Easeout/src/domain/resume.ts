/**
 * Canonical Resume domain model (metadata only).
 *
 * Rules mirror `src/domain/job.ts`: zero imports, no Firebase/React Native types,
 * ISO-8601 date-time strings, flat field names.
 *
 * The scope limit is deliberate and is the whole point of this file. A `ResumeSummary`
 * carries only what the mobile app needs to render a resume picker: what to call it, what it
 * is aimed at, whether it is the default, and when it was last touched. It deliberately does
 * NOT carry:
 *
 * - a PDF body, byte size, or page count;
 * - a Drive or Google Docs URL, or the `driveFileId` used to fetch one;
 * - `extractedText`, the resume's full parsed body;
 * - `contentHash`, the server's change-detection value;
 * - an API key or any other credential.
 *
 * Those are server-side or Drive-side concerns. A metadata shape that reaches the device is
 * also a shape that can end up in a crash report, a log line, or a backup, so the safe move
 * is to never send them at all rather than to send them and promise not to use them.
 *
 * Field names match `GET /api/resumes` in the `jobemailer` backend exactly. They are not
 * renamed for local taste: renaming a wire field buys nothing and creates a translation layer
 * whose only job is to hide a contract mismatch.
 */

/** ISO-8601 date-time string, e.g. `2026-10-05T09:30:00.000Z`. */
export type IsoDateTime = string;

/**
 * Version of the public ResumeSummary projection.
 *
 * Mirrors `RESUME_SUMMARY_SCHEMA_VERSION` on the server. A payload with a *higher* version is
 * accepted, because unknown extra fields are dropped and the known ones keep their meaning; a
 * payload with a *lower* version is refused, because its fields may mean something else.
 */
export const RESUME_SCHEMA_VERSION = 1;

/**
 * Coarse role families. Mirrors `RESUME_ROLE_FAMILIES` in the server's cache module.
 *
 * Advisory rather than enforced: an unrecognized value from the server is preserved as-is
 * rather than rejected, so a cache written by a newer sync does not make the whole list
 * unusable.
 */
export const RESUME_ROLE_FAMILIES = [
  'backend',
  'frontend',
  'full_stack',
  'data',
  'ml',
  'design',
  'product',
  'marketing',
  'operations',
  'other',
] as const;
export type ResumeRoleFamily = (typeof RESUME_ROLE_FAMILIES)[number];

/**
 * Metadata about one resume version, safe to hold on the device.
 *
 * `resumeId` is an opaque server-assigned identifier derived from the Drive file's identity.
 * It is deliberately NOT the Drive file id, so a resume can be selected
 * (`Job.selectedResumeId`) and later resolved server-side without the client ever knowing
 * where the file lives.
 */
export interface ResumeSummary {
  /** Opaque, stable, server-assigned identifier. Safe to persist on a Job. */
  resumeId: string;
  schemaVersion: number;
  /** Display name, e.g. `"Backend — Go — v3"`. */
  resumeLabel: string;
  /** Fine-grained target title, e.g. `"Backend Engineer"`. Free text, may be unset. */
  targetRole: string | null;
  /** Coarse family used for filtering, e.g. `"backend"`. May be unset. */
  targetRoleFamily: ResumeRoleFamily | string | null;
  /** Monotonic human-facing version number, e.g. `3`. Never assumed to be contiguous. */
  version: number;
  /** True for at most one resume; a starting suggestion for a new job, never an auto-choice. */
  isDefault: boolean;
  /** Short lowercase tags for filtering, e.g. `["go", "postgres"]`. */
  keywords: string[];
  /** When the server last synced the file's contents. */
  updatedAt: IsoDateTime | null;
  /** When this resume was last attached to an application. `null` until one is sent. */
  lastUsedAt: IsoDateTime | null;
}
