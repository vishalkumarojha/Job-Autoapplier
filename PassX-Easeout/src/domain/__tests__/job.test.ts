import {
  JOB_APPLICATION_STATUSES,
  JOB_APPROVAL_STATUSES,
  JOB_CONFIDENCE_FIELDS,
  JOB_DEADLINE_SOURCES,
  JOB_INTAKE_STATUSES,
  JOB_MATCH_SCHEMA_VERSION,
  MATCH_CRITERIA,
  MATCH_CRITERION_LABELS,
  JOB_RAW_SOURCE_LABELS,
  JOB_RAW_SOURCES,
  JOB_SCHEMA_VERSION,
  JOB_SHEET_SYNC_STATUSES,
  computeDedupeKey,
  createJob,
  isCanonicalJob,
  isMatchCriterion,
  isSuggestionActionType,
  isSuggestionCategory,
  isSuggestionPriority,
  RESUME_SUGGESTION_SCHEMA_VERSION,
  SUGGESTION_ACTION_TYPES,
  SUGGESTION_CATEGORIES,
  SUGGESTION_CATEGORY_LABELS,
  SUGGESTION_MAX,
  SUGGESTION_PRIORITIES,
  SUGGESTION_PRIORITY_LABELS,
} from '../job';
import type { Job } from '../job';

const base = { id: 'doc-1', now: '2026-10-05T09:00:00.000Z' };

describe('createJob canonical defaults', () => {
  const job = createJob({ ...base, company: 'Acme', role: 'Dev' });

  it('stamps the current schema version', () => {
    expect(job.schemaVersion).toBe(JOB_SCHEMA_VERSION);
    expect(JOB_SCHEMA_VERSION).toBe(1);
  });

  it('keeps identity and lifecycle fields consistent', () => {
    expect(job.id).toBe('doc-1');
    expect(job.createdAt).toBe('2026-10-05T09:00:00.000Z');
    expect(job.updatedAt).toBe(job.createdAt);
    expect(job.capturedAt).toBe(job.createdAt);
    expect(job.archivedAt).toBeNull();
  });

  it('defaults every agent-owned stage to an explicit, non-final state', () => {
    expect(job.intakeStatus).toBe('unparsed');
    expect(job.approvalStatus).toBe('draft');
    expect(job.applicationStatus).toBe('draft');
    expect(job.rawSource).toBe('manual');
    expect(job.deadlineSource).toBe('unknown');
    expect(job.contactEmailSource).toBe('unknown');
  });

  it('leaves resume, draft, mirror, and reminder state empty', () => {
    // Nothing downstream of manual capture has run yet, so none of this may imply
    // work that did not happen.
    expect(job.selectedResumeId).toBeNull();
    expect(job.matchScore).toBeNull();
    expect(job.matchBreakdown).toBeNull();
    expect(job.resumeSuggestions).toBeNull();
    expect(job.draftMessage).toBeNull();
    expect(job.approvedAt).toBeNull();
    expect(job.approvedBy).toBeNull();
    expect(job.sheetRowId).toBeNull();
    expect(job.sheetSyncStatus).toBe('never');
    expect(job.gmailThreadId).toBeNull();
    expect(job.followUpCount).toBe(0);
    expect(job.followUpStatus).toBe('not_started');
    expect(job.reminderDeadlineNotifId).toBeNull();
  });

  it('stores a null deadline rather than a sentinel string', () => {
    expect(job.deadline).toBeNull();
  });

  it('preserves supplied values', () => {
    const withValues = createJob({
      ...base,
      company: '  Example  Corp ',
      role: 'SRE',
      deadline: '2026-11-01T00:00:00.000Z',
      deadlineSource: 'user_entered',
      rawText: 'pasted text',
      rawSource: 'paste',
      intakeStatus: 'confirmed',
    });
    expect(withValues.company).toBe('  Example  Corp ');
    expect(withValues.deadline).toBe('2026-11-01T00:00:00.000Z');
    expect(withValues.deadlineSource).toBe('user_entered');
    expect(withValues.rawSource).toBe('paste');
    expect(withValues.intakeStatus).toBe('confirmed');
  });
});

describe('computeDedupeKey', () => {
  it('is deterministic for the same input', () => {
    const input = { company: 'Acme', role: 'Dev', jobUrl: 'https://acme.com/jobs/1' };
    expect(computeDedupeKey(input)).toBe(computeDedupeKey(input));
  });

  it('normalizes case and collapsed whitespace', () => {
    expect(computeDedupeKey({ company: '  ACME   Corp ' })).toBe(
      computeDedupeKey({ company: 'acme corp' }),
    );
  });

  it('normalizes scheme, www, and trailing slash in URLs', () => {
    expect(computeDedupeKey({ jobUrl: 'https://WWW.Example.com/jobs/1/' })).toBe(
      computeDedupeKey({ jobUrl: 'http://example.com/jobs/1' }),
    );
  });

  it('returns null when no identifying field carries information', () => {
    // A null key means "cannot dedupe", which is different from "these are equal".
    expect(computeDedupeKey({})).toBeNull();
    expect(computeDedupeKey({ company: null, role: '   ', jobUrl: '' })).toBeNull();
  });

  it('combines all three identifying fields', () => {
    expect(computeDedupeKey({ company: 'Acme', role: 'Dev' })).toBe('acme|dev|');
  });

  it('is derived by createJob, not supplied by the caller', () => {
    const job = createJob({ ...base, company: 'Acme', role: 'Dev' });
    expect(job.dedupeKey).toBe('acme|dev|');
  });
});

describe('isCanonicalJob', () => {
  it('accepts documents written at the current schema version', () => {
    expect(isCanonicalJob({ schemaVersion: JOB_SCHEMA_VERSION })).toBe(true);
  });

  it('rejects legacy documents, which deserialize to version 0', () => {
    // This is the guard that keeps old Job Tracker records from being rendered as
    // blank canonical jobs.
    expect(isCanonicalJob({ schemaVersion: 0 })).toBe(false);
  });

  it('accepts a newer schema version so future records stay readable', () => {
    expect(isCanonicalJob({ schemaVersion: JOB_SCHEMA_VERSION + 1 })).toBe(true);
  });

  it('classifies a job built by createJob as canonical', () => {
    expect(isCanonicalJob(createJob(base))).toBe(true);
  });
});

describe('canonical enum vocabulary', () => {
  it.each([
    [
      'JOB_RAW_SOURCES',
      JOB_RAW_SOURCES,
      ['paste', 'share_android', 'manual', 'email', 'linkedin', 'x', 'referral', 'other'],
    ],
    ['JOB_INTAKE_STATUSES', JOB_INTAKE_STATUSES, ['unparsed', 'parsed', 'needs_review', 'confirmed']],
    ['JOB_DEADLINE_SOURCES', JOB_DEADLINE_SOURCES, ['extracted', 'user_entered', 'unknown']],
    ['JOB_APPROVAL_STATUSES', JOB_APPROVAL_STATUSES, ['draft', 'pending_review', 'approved', 'rejected']],
    ['JOB_SHEET_SYNC_STATUSES', JOB_SHEET_SYNC_STATUSES, ['never', 'pending', 'synced', 'conflict', 'error']],
    [
      'JOB_APPLICATION_STATUSES',
      JOB_APPLICATION_STATUSES,
      ['draft', 'applied', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted'],
    ],
  ])('%s keeps its documented members', (_name, actual, expected) => {
    // Guards against a value being dropped while adding another; the stored documents
    // depend on this vocabulary staying stable.
    expect([...actual]).toEqual(expected);
  });

  it('keeps exactly the seven tracked confidence fields', () => {
    // The API layer strips anything outside this list, and the stored document is typed
    // from it, so a field added or dropped here changes both.
    expect([...JOB_CONFIDENCE_FIELDS]).toEqual([
      'company',
      'role',
      'jobUrl',
      'location',
      'deadline',
      'contactName',
      'contactEmail',
    ]);
  });

  it('has a display label for every capture channel', () => {
    // A missing label would render "undefined" in the source picker, which is a worse
    // outcome than an unknown source value — so the map is checked exhaustively rather
    // than by sampling.
    expect(Object.keys(JOB_RAW_SOURCE_LABELS).sort()).toEqual([...JOB_RAW_SOURCES].sort());
    for (const label of Object.values(JOB_RAW_SOURCE_LABELS)) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  it('derives every Job stage field from the exported vocabulary', () => {
    const job: Job = createJob(base);
    expect(JOB_INTAKE_STATUSES).toContain(job.intakeStatus);
    expect(JOB_RAW_SOURCES).toContain(job.rawSource);
    expect(JOB_APPROVAL_STATUSES).toContain(job.approvalStatus);
    expect(JOB_APPLICATION_STATUSES).toContain(job.applicationStatus);
    expect(JOB_SHEET_SYNC_STATUSES).toContain(job.sheetSyncStatus);
    expect(JOB_DEADLINE_SOURCES).toContain(job.deadlineSource);
  });
});

describe('resume match vocabulary', () => {
  it('keeps the five criteria in the order the server reports them', () => {
    // The breakdown is rendered in this order, and the server writes its array in the
    // same order, so a silent reordering would shuffle the rows on screen.
    expect([...MATCH_CRITERIA]).toEqual([
      'must_have',
      'nice_to_have',
      'seniority',
      'role_alignment',
      'technology_alignment',
    ]);
  });

  it('is pinned to the server contract version', () => {
    // Bumping this without a matching server change makes every response look too old.
    expect(JOB_MATCH_SCHEMA_VERSION).toBe(1);
  });

  it('has a display label for every criterion', () => {
    expect(Object.keys(MATCH_CRITERION_LABELS).sort()).toEqual([...MATCH_CRITERIA].sort());
    const labels = Object.values(MATCH_CRITERION_LABELS);
    for (const label of labels) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
    // Two criteria sharing a label would make two rows indistinguishable on screen.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each([...MATCH_CRITERIA])('recognises %s as a known criterion', (criterion) => {
    expect(isMatchCriterion(criterion)).toBe(true);
  });

  it.each([
    ['an unknown criterion', 'visa_sponsorship'],
    ['an empty string', ''],
    ['a null', null],
    ['a number', 7],
    ['an array', ['must_have']],
    ['an undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isMatchCriterion(value)).toBe(false);
  });

  it('keeps a stored breakdown entry type-compatible with the new vocabulary', () => {
    // `MatchBreakdownEntry.criterion` stays a plain string so a document written before
    // this vocabulary existed still loads; the API layer is what narrows it.
    const entry = { criterion: 'must_have', score: 94, weight: 0.35, rationale: null };
    expect(isMatchCriterion(entry.criterion)).toBe(true);
  });
});

describe('resume suggestion vocabulary', () => {
  it('agrees with the server contract on version and ceiling', () => {
    expect(RESUME_SUGGESTION_SCHEMA_VERSION).toBe(1);
    expect(SUGGESTION_MAX).toBe(4);
  });

  it('offers exactly three priorities in display order', () => {
    expect(SUGGESTION_PRIORITIES).toEqual(['high', 'medium', 'low']);
    expect(Object.keys(SUGGESTION_PRIORITY_LABELS)).toEqual([...SUGGESTION_PRIORITIES]);
    expect(SUGGESTION_PRIORITY_LABELS.high).toBe('HIGH');
  });

  it('labels every category and nothing else', () => {
    expect(SUGGESTION_CATEGORIES).toHaveLength(8);
    expect(Object.keys(SUGGESTION_CATEGORY_LABELS).sort()).toEqual([...SUGGESTION_CATEGORIES].sort());
    for (const label of Object.values(SUGGESTION_CATEGORY_LABELS)) {
      expect(label).not.toMatch(/_/);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('permits no action type that would claim something new', () => {
    expect(SUGGESTION_ACTION_TYPES).toEqual([
      'reorder_or_emphasize',
      'add_existing_evidence',
      'rewrite_existing_bullet',
      'quantify_existing_result',
      'clarify_existing_experience',
    ]);
    for (const actionType of SUGGESTION_ACTION_TYPES) {
      expect(actionType).toMatch(/existing|reorder|rewrite|quantify|clarify/);
    }
    expect(isSuggestionActionType('add_new_skill')).toBe(false);
    expect(isSuggestionActionType('claim_certification')).toBe(false);
    expect(isSuggestionActionType('invent_experience')).toBe(false);
  });

  it.each([
    ['a null', null],
    ['a number', 1],
    ['an array', ['high']],
    ['an unknown value', 'urgent'],
    ['an undefined', undefined],
  ])('priority guard rejects %s', (_label, value) => {
    expect(isSuggestionPriority(value)).toBe(false);
    expect(isSuggestionCategory(value)).toBe(false);
    expect(isSuggestionActionType(value)).toBe(false);
  });

  it('accepts every value of its own vocabulary', () => {
    for (const value of SUGGESTION_PRIORITIES) expect(isSuggestionPriority(value)).toBe(true);
    for (const value of SUGGESTION_CATEGORIES) expect(isSuggestionCategory(value)).toBe(true);
    for (const value of SUGGESTION_ACTION_TYPES) expect(isSuggestionActionType(value)).toBe(true);
  });

  it('starts a job with no suggestions at all, not with an empty list', () => {
    expect(createJob(base).resumeSuggestions).toBeNull();
  });
});
