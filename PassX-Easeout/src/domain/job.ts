/**
 * Canonical Job domain model.
 *
 * Rules for this file:
 * - Zero imports. Nothing from React Native, Firebase, Firestore, or Expo.
 * - No Firestore `Timestamp`, `DocumentReference`, or snapshot types. Timestamps are
 *   ISO-8601 strings so the model stays serializable and portable.
 * - Flat field names (no nesting) so documents stay queryable.
 * - Agent-owned data and external-system mirror data are kept in separate interfaces
 *   and only combined in the `Job` intersection.
 *
 * This model describes the *future* Job Pipeline. It is not yet adopted by any screen;
 * `src/screens/features/JobTrackerScreen.tsx` still reads/writes the legacy job shape
 * in the same Firestore collection. See README "Firestore model compatibility".
 */

/** ISO-8601 date-time string, e.g. `2026-10-05T09:30:00.000Z`. */
export type IsoDateTime = string;

/**
 * Bump when the shape of a stored Job changes in a way that older readers cannot
 * handle. Stored per document so a mixed-version collection stays readable.
 */
export const JOB_SCHEMA_VERSION = 1;

/**
 * Version of the `POST /api/intake` response contract.
 *
 * Bumped when the server stops being able to serve this client's expected shape. It is
 * checked on receipt rather than trusted, so a deployment that changes the payload is
 * reported as a clear incompatibility instead of rendering blank fields.
 */
export const JOB_INTAKE_SCHEMA_VERSION = 1;

// ─── Enumerations ──────────────────────────────────────────────────────────────

/**
 * Where the unstructured job text came from — the *capture channel*, not the advertising
 * channel. `Job.source` is a separate, free-text field for where the job was advertised;
 * the two are deliberately not the same vocabulary and neither is derived from the other.
 *
 * Mirrors `INTAKE_SOURCES` in `jobemailer/lib/intake.js`. There is exactly one vocabulary
 * and it lives in both repos: the server rejects anything outside it, so a value that
 * drifted here would fail at the request rather than being silently accepted.
 */
export const JOB_RAW_SOURCES = [
  'paste',
  'share_android',
  'manual',
  'email',
  'linkedin',
  'x',
  'referral',
  'other',
] as const;
export type JobRawSource = (typeof JOB_RAW_SOURCES)[number];

/** Display labels for the capture channels, keyed by the stored value. */
export const JOB_RAW_SOURCE_LABELS: Record<JobRawSource, string> = {
  paste: 'Pasted',
  share_android: 'Shared',
  manual: 'Typed',
  email: 'Email',
  linkedin: 'LinkedIn',
  x: 'X',
  referral: 'Referral',
  other: 'Other',
};

/** Lifecycle of turning raw captured text into a structured, trusted job. */
export const JOB_INTAKE_STATUSES = ['unparsed', 'parsed', 'needs_review', 'confirmed'] as const;
export type JobIntakeStatus = (typeof JOB_INTAKE_STATUSES)[number];

/** Provenance of `deadline`. */
export const JOB_DEADLINE_SOURCES = ['extracted', 'user_entered', 'unknown'] as const;
export type JobDeadlineSource = (typeof JOB_DEADLINE_SOURCES)[number];

/** Provenance of `contactEmail`. */
export const JOB_CONTACT_EMAIL_SOURCES = ['extracted', 'user_entered', 'unknown'] as const;
export type JobContactEmailSource = (typeof JOB_CONTACT_EMAIL_SOURCES)[number];

/**
 * Human approval gate. No outreach may be sent while this is not `approved`.
 * Sending itself is out of scope for this phase.
 */
export const JOB_APPROVAL_STATUSES = ['draft', 'pending_review', 'approved', 'rejected'] as const;
export type JobApprovalStatus = (typeof JOB_APPROVAL_STATUSES)[number];

/** Sync state against the external Google Sheet mirror. */
export const JOB_SHEET_SYNC_STATUSES = ['never', 'pending', 'synced', 'conflict', 'error'] as const;
export type JobSheetSyncStatus = (typeof JOB_SHEET_SYNC_STATUSES)[number];

/**
 * Real-world application lifecycle. The values are not specified by the product spec;
 * this is the minimal set the pipeline needs, chosen to line up with the vocabulary the
 * legacy tracker already uses (Applied / Interview / Offer / Rejected / No Response).
 */
export const JOB_APPLICATION_STATUSES = [
  'draft',
  'applied',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
  'ghosted',
] as const;
export type JobApplicationStatus = (typeof JOB_APPLICATION_STATUSES)[number];

/** Follow-up state for the external mail workflow. Values chosen for this phase. */
export const JOB_FOLLOW_UP_STATUSES = ['not_started', 'scheduled', 'sent', 'complete', 'disabled'] as const;
export type JobFollowUpStatus = (typeof JOB_FOLLOW_UP_STATUSES)[number];

// ─── Structured field confidence ───────────────────────────────────────────────

/**
 * Fields whose extraction confidence is tracked individually.
 *
 * Derived from the array so the type and the runtime list cannot drift apart — the API
 * layer needs the list to strip unknown keys from a server response, and TypeScript needs
 * the union to type the stored document.
 */
export const JOB_CONFIDENCE_FIELDS = [
  'company',
  'role',
  'jobUrl',
  'location',
  'deadline',
  'contactName',
  'contactEmail',
] as const;
export type JobConfidenceField = (typeof JOB_CONFIDENCE_FIELDS)[number];

/** Field name to confidence in the range 0..1. Missing key means "not assessed". */
export type JobFieldConfidence = Partial<Record<JobConfidenceField, number>>;

// ─── Resume matching ───────────────────────────────────────────────────────────

/** One scored criterion contributing to an overall resume match. */
export interface MatchBreakdownEntry {
  criterion: string;
  /** Criterion score, 0..100. */
  score: number;
  /** Contribution weight, 0..1. */
  weight: number;
  rationale: string | null;
}

export type MatchBreakdown = MatchBreakdownEntry[];

/**
 * Version of the public resume-match projection returned by `POST /api/match`.
 *
 * Mirrors `MATCH_SCHEMA_VERSION` on the server. A payload with a *higher* version is
 * accepted, because unknown fields are dropped and the known ones keep their meaning; a
 * payload with a *lower* version is refused, because its fields may mean something else.
 */
export const JOB_MATCH_SCHEMA_VERSION = 1;

/**
 * The five scored criteria, in the order the server reports them.
 *
 * Mirrors `MATCH_CRITERIA` in the `jobemailer` backend. This is an allow-list, not a
 * suggestion: a breakdown entry naming a criterion this build has never heard of is
 * dropped rather than rendered as a raw snake_case token, so a server that grows a sixth
 * criterion cannot put an unlabelled row in front of a user.
 */
export const MATCH_CRITERIA = [
  'must_have',
  'nice_to_have',
  'seniority',
  'role_alignment',
  'technology_alignment',
] as const;
export type MatchCriterion = (typeof MATCH_CRITERIA)[number];

/** UI copy for each criterion. The wire value is the identifier; this is what it says. */
export const MATCH_CRITERION_LABELS: Record<MatchCriterion, string> = {
  must_have: 'Must-have',
  nice_to_have: 'Nice-to-have',
  seniority: 'Seniority',
  role_alignment: 'Role alignment',
  technology_alignment: 'Technology',
};

export function isMatchCriterion(value: unknown): value is MatchCriterion {
  return typeof value === 'string' && (MATCH_CRITERIA as readonly string[]).includes(value);
}

/**
 * Version of the persisted suggestion payload.
 *
 * Mirrors `SUGGESTION_SCHEMA_VERSION` on the server. A payload with a *higher* version is
 * accepted (unknown fields are dropped and the known ones keep their meaning); a payload
 * with a *lower* version is refused, because its fields may mean something else.
 */
export const RESUME_SUGGESTION_SCHEMA_VERSION = 1;

/** Hard ceiling on generated suggestions. Mirrors `SUGGESTION_MAX` on the server. */
export const SUGGESTION_MAX = 4;

/** How urgent a suggestion is. Order matters: the UI lists high first. */
export const SUGGESTION_PRIORITIES = ['high', 'medium', 'low'] as const;
export type SuggestionPriority = (typeof SUGGESTION_PRIORITIES)[number];

/**
 * What kind of improvement a suggestion is.
 *
 * Every value describes working with evidence the resume *already contains*. There is
 * deliberately no category for inventing experience, because a category is a permission:
 * naming one would make "add a certification you do not hold" a well-formed request.
 */
export const SUGGESTION_CATEGORIES = [
  'skill_gap',
  'skill_emphasis',
  'experience_alignment',
  'project_alignment',
  'keyword_coverage',
  'achievement_quantification',
  'section_order',
  'technology_alignment',
] as const;
export type SuggestionCategory = (typeof SUGGESTION_CATEGORIES)[number];

/**
 * The concrete edit a suggestion proposes.
 *
 * All five act on existing material — reordering, surfacing, rewriting, quantifying,
 * clarifying. None of them asks the user to claim something the resume does not show.
 */
export const SUGGESTION_ACTION_TYPES = [
  'reorder_or_emphasize',
  'add_existing_evidence',
  'rewrite_existing_bullet',
  'quantify_existing_result',
  'clarify_existing_experience',
] as const;
export type SuggestionActionType = (typeof SUGGESTION_ACTION_TYPES)[number];

/** UI copy for a priority. The wire value is the identifier; this is what it says. */
export const SUGGESTION_PRIORITY_LABELS: Record<SuggestionPriority, string> = {
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

/** UI copy for a category. */
export const SUGGESTION_CATEGORY_LABELS: Record<SuggestionCategory, string> = {
  skill_gap: 'Skill gap',
  skill_emphasis: 'Skill emphasis',
  experience_alignment: 'Experience alignment',
  project_alignment: 'Project alignment',
  keyword_coverage: 'Keyword coverage',
  achievement_quantification: 'Achievement quantification',
  section_order: 'Section order',
  technology_alignment: 'Technology alignment',
};

export function isSuggestionPriority(value: unknown): value is SuggestionPriority {
  return typeof value === 'string' && (SUGGESTION_PRIORITIES as readonly string[]).includes(value);
}

export function isSuggestionCategory(value: unknown): value is SuggestionCategory {
  return typeof value === 'string' && (SUGGESTION_CATEGORIES as readonly string[]).includes(value);
}

export function isSuggestionActionType(value: unknown): value is SuggestionActionType {
  return typeof value === 'string' && (SUGGESTION_ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * One evidence-based proposal for improving the already-selected resume for one job.
 *
 * Suggestions are inert: nothing here mutates a resume, and nothing is applied
 * automatically. Every suggestion names the job requirement it answers (`jobEvidence`) and
 * the line of the resume that already supports it (`resumeEvidence`), so the user can check
 * the claim against both documents instead of trusting the model.
 */
export interface ResumeSuggestion {
  id: string;
  priority: SuggestionPriority;
  category: SuggestionCategory;
  actionType: SuggestionActionType;
  title: string;
  suggestion: string;
  jobEvidence: string;
  resumeEvidence: string;
}

/**
 * The versioned suggestion payload stored in `Job.resumeSuggestions`.
 *
 * Three distinct states, and the UI depends on telling them apart:
 *
 * - `null` — suggestions have never been generated for this job.
 * - `{ schemaVersion: 1, suggestions: [] }` — generated, and nothing was worth recommending.
 * - `{ schemaVersion: 1, suggestions: [...] }` — generated with concrete changes to consider.
 *
 * Collapsing the middle case into `null` would make a legitimate "no suggestions" answer
 * look like a failed or unattempted run.
 */
export interface ResumeSuggestions {
  schemaVersion: number;
  suggestions: ResumeSuggestion[];
}

// ─── Agent-owned data ──────────────────────────────────────────────────────────

/** Identity and timestamps. `id` is the stable document ID, never a Sheet row number. */
export interface JobIdentity {
  id: string;
  schemaVersion: number;
  /**
   * Deterministic key derived from company/role/jobUrl, used to detect the same job
   * arriving twice (for example via two different intakes). `null` while there is not
   * enough information to derive one — dedupe must be skipped in that case.
   */
  dedupeKey: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Set when the job is archived. Archived jobs are never hard-deleted. */
  archivedAt: IsoDateTime | null;
}

/** The unstructured capture and how far it has been through parsing. */
export interface JobIntake {
  rawText: string | null;
  rawSource: JobRawSource;
  capturedAt: IsoDateTime | null;
  intakeStatus: JobIntakeStatus;
  fieldConfidence: JobFieldConfidence | null;
}

/** The structured, human-trusted view of the job. */
export interface JobStructured {
  company: string | null;
  contactName: string | null;
  contactEmail: string | null;
  role: string | null;
  jobUrl: string | null;
  /** Where the job was advertised, e.g. `linkedin`, `referral`, `company_site`. */
  source: string | null;
  location: string | null;
  notes: string | null;
  /** ISO-8601 or null. Never a sentinel string such as `"No Deadline"`. */
  deadline: IsoDateTime | null;
  deadlineSource: JobDeadlineSource;
  contactEmailSource: JobContactEmailSource;
}

/**
 * Resume match state, as persisted on the Job.
 *
 * Two writers, two fields each in spirit, and the split matters:
 *
 * - `POST /api/match` writes `selectedResumeId`, `matchScore`, and `matchBreakdown`.
 * - `POST /api/suggestions` writes `resumeSuggestions` and nothing else.
 *
 * Neither is ever written by the client — the app reads these fields and that is all. The
 * per-candidate `rankings` array the match endpoint also returns is *not* stored here: it
 * is a one-off comparison, so it lives in screen state and expires when the screen does.
 */
export interface JobResumeMatch {
  selectedResumeId: string | null;
  /** Overall match, 0..100, or null when not scored. */
  matchScore: number | null;
  matchBreakdown: MatchBreakdown | null;
  resumeSuggestions: ResumeSuggestions | null;
}

/** A drafted outreach message, pending human review. */
export interface JobOutreachDraft {
  draftMessage: string | null;
  draftSubject: string | null;
  draftGeneratedAt: IsoDateTime | null;
  /** True once a human has edited the draft. */
  draftEditedByHuman: boolean;
}

/** The human approval gate. No send may happen unless this is `approved`. */
export interface JobApproval {
  approvalStatus: JobApprovalStatus;
  approvedAt: IsoDateTime | null;
  /** Opaque identifier of the approving human. Single-user for now. */
  approvedBy: string | null;
}

/** Real-world application lifecycle. Agent-owned. */
export interface JobApplicationState {
  applicationStatus: JobApplicationStatus;
}

// ─── External-system mirror data ───────────────────────────────────────────────
//
// Owned by external systems, not by the app. The app may cache and reconcile these,
// but they are never the source of truth for a Job's identity.

/**
 * Cache/reference to the external Google Sheet row.
 *
 * `sheetRowId` is NOT the Job's primary key. Sheet row numbers shift when rows are
 * deleted or reordered, so a row id recorded today may point at a different job
 * tomorrow. Always re-resolve by `dedupeKey` rather than trusting a stored row id.
 */
export interface ExternalSheetMirror {
  sheetRowId: number | null;
  sheetSyncStatus: JobSheetSyncStatus;
  sheetSyncedAt: IsoDateTime | null;
}

/** Cache of what the external Gmail/Apps Script workflow has done. */
export interface ExternalMailboxMirror {
  gmailThreadId: string | null;
  emailSentOn: IsoDateTime | null;
  followUpStatus: JobFollowUpStatus;
  followUpCount: number;
  followUpLastSentAt: IsoDateTime | null;
}

// ─── Reminder metadata ─────────────────────────────────────────────────────────

/**
 * Reminder bookkeeping only. Scheduling and notification delivery are out of scope;
 * `reminderDeadlineNotifId` holds whatever handle the future scheduler assigns.
 */
export interface JobReminderMeta {
  reminderDeadlineNotifId: string | null;
  nextReminderAt: IsoDateTime | null;
}

// ─── The canonical Job ─────────────────────────────────────────────────────────

export type Job = JobIdentity &
  JobIntake &
  JobStructured &
  JobResumeMatch &
  JobOutreachDraft &
  JobApproval &
  JobApplicationState &
  ExternalSheetMirror &
  ExternalMailboxMirror &
  JobReminderMeta;

// ─── Dedupe ────────────────────────────────────────────────────────────────────

export interface JobDedupeInput {
  company?: string | null;
  role?: string | null;
  jobUrl?: string | null;
}

function normalizeDedupeText(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes a job URL for comparison: lowercase, no scheme, no `www.`, no trailing
 * slash. Query strings are preserved, so URLs that differ only by tracking parameters
 * will not dedupe against each other.
 */
function normalizeDedupeUrl(value: string | null | undefined): string {
  const text = normalizeDedupeText(value);
  if (!text) return '';
  const withoutScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const withoutWww = withoutScheme.replace(/^www\./, '');
  return withoutWww.replace(/\/+$/, '');
}

/**
 * Builds a deterministic dedupe key from the identifying job fields, or returns null
 * when none of them carry information. Deterministic means the same input always
 * produces the same key, in any process, on any device — no hashing, no randomness.
 */
export function computeDedupeKey(input: JobDedupeInput): string | null {
  const company = normalizeDedupeText(input.company);
  const role = normalizeDedupeText(input.role);
  const url = normalizeDedupeUrl(input.jobUrl);

  if (!company && !role && !url) return null;

  return [company, role, url].join('|');
}

// ─── Legacy compatibility ───────────────────────────────────────────────────────

/**
 * True when a document was written by the canonical repository.
 *
 * Legacy Job Tracker documents live in the same `users/{uid}/jobs` collection but
 * predate this model, so they carry no `schemaVersion` and deserialize to `0`. Because
 * reading is defensive, such a document yields a structurally valid `Job` whose fields
 * are all null/default — the shape alone cannot distinguish it, only the version can.
 *
 * Consumers must therefore check this before rendering anything as canonical. Without
 * it, legacy records appear as blank jobs, which is both misleading and a silent
 * reinterpretation of someone else's data.
 *
 * The comparison is `>=` rather than `===` so that documents written by a later schema
 * version remain readable by older clients instead of vanishing from the list.
 */
export function isCanonicalJob(job: Pick<Job, 'schemaVersion'>): boolean {
  return job.schemaVersion >= JOB_SCHEMA_VERSION;
}

// ─── Construction ──────────────────────────────────────────────────────────────

/**
 * The fields accepted at creation time. Deliberately narrow: a job is created from an
 * intake capture or a manual entry, and everything else (matching, drafting, approval,
 * mirroring) is set later through an update.
 */
export interface CreateJobInput {
  /** Stable document ID. Supplied by the repository so Firestore owns ID generation. */
  id: string;
  /** Injected clock, so construction stays pure and testable. Defaults to now. */
  now?: IsoDateTime;
  company?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  role?: string | null;
  jobUrl?: string | null;
  source?: string | null;
  location?: string | null;
  notes?: string | null;
  deadline?: IsoDateTime | null;
  deadlineSource?: JobDeadlineSource;
  contactEmailSource?: JobContactEmailSource;
  rawText?: string | null;
  rawSource?: JobRawSource;
  capturedAt?: IsoDateTime | null;
  intakeStatus?: JobIntakeStatus;
  fieldConfidence?: JobFieldConfidence | null;
}

/**
 * Builds a complete, valid `Job` with every optional field at its documented default.
 * Pure: no I/O, no clock read unless `now` is omitted.
 */
export function createJob(input: CreateJobInput): Job {
  const now = input.now ?? new Date().toISOString();

  return {
    id: input.id,
    schemaVersion: JOB_SCHEMA_VERSION,
    dedupeKey: computeDedupeKey({
      company: input.company,
      role: input.role,
      jobUrl: input.jobUrl,
    }),
    createdAt: now,
    updatedAt: now,
    archivedAt: null,

    rawText: input.rawText ?? null,
    rawSource: input.rawSource ?? 'manual',
    capturedAt: input.capturedAt ?? now,
    intakeStatus: input.intakeStatus ?? 'unparsed',
    fieldConfidence: input.fieldConfidence ?? null,

    company: input.company ?? null,
    contactName: input.contactName ?? null,
    contactEmail: input.contactEmail ?? null,
    role: input.role ?? null,
    jobUrl: input.jobUrl ?? null,
    source: input.source ?? null,
    location: input.location ?? null,
    notes: input.notes ?? null,
    deadline: input.deadline ?? null,
    deadlineSource: input.deadlineSource ?? 'unknown',
    contactEmailSource: input.contactEmailSource ?? 'unknown',

    selectedResumeId: null,
    matchScore: null,
    matchBreakdown: null,
    resumeSuggestions: null,

    draftMessage: null,
    draftSubject: null,
    draftGeneratedAt: null,
    draftEditedByHuman: false,

    approvalStatus: 'draft',
    approvedAt: null,
    approvedBy: null,

    applicationStatus: 'draft',

    sheetRowId: null,
    sheetSyncStatus: 'never',
    sheetSyncedAt: null,

    gmailThreadId: null,
    emailSentOn: null,
    followUpStatus: 'not_started',
    followUpCount: 0,
    followUpLastSentAt: null,

    reminderDeadlineNotifId: null,
    nextReminderAt: null,
  };
}
