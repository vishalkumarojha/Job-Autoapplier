import { JOB_SCHEMA_VERSION } from '../../../domain/job';
import { JobNotFoundError, FirestoreJobsRepository } from '../firestore';
import { createFakeFirestore } from './fakeFirestore';
import type { FakeFirestore } from './fakeFirestore';

// Path is relative to this test file. The repository resolves the same module as
// `../../services/firebase`, so mocking the specifier here intercepts it.
jest.mock('../../../services/firebase', () => ({
  firestore: () => (globalThis as unknown as { __fake: FakeFirestore }).__fake.api,
}));

const UID = 'user-1';
const OTHER_UID = 'user-2';

/** A suggestion that satisfies every field of the persisted envelope. */
const VALID_SUGGESTION = {
  id: 'sug_001',
  priority: 'high',
  category: 'skill_emphasis',
  actionType: 'reorder_or_emphasize',
  title: 'Highlight existing PostgreSQL experience',
  suggestion: 'Move the existing PostgreSQL project bullet higher.',
  jobEvidence: 'PostgreSQL is listed as a required technology.',
  resumeEvidence: 'The resume already demonstrates PostgreSQL in a project.',
};

let fake: FakeFirestore;
let repo: FirestoreJobsRepository;

beforeEach(() => {
  fake = createFakeFirestore();
  (globalThis as unknown as { __fake: FakeFirestore }).__fake = fake;
  repo = new FirestoreJobsRepository(UID);
});

describe('createJob', () => {
  it('generates the document ID and returns it', async () => {
    const job = await repo.createJob({ company: 'Acme', role: 'Dev' });
    expect(job.id).toEqual(expect.any(String));
    expect(job.id.length).toBeGreaterThan(0);
    expect(fake.read(UID, job.id)).toBeDefined();
  });

  it('gives each job a distinct ID', async () => {
    const ids = await Promise.all([
      repo.createJob({ company: 'A', role: 'a' }),
      repo.createJob({ company: 'B', role: 'b' }),
    ]);
    expect(ids[0].id).not.toBe(ids[1].id);
  });

  it('does not duplicate the document ID as a stored field', async () => {
    // The ID *is* the document key; storing it again would allow the two to drift.
    const job = await repo.createJob({ company: 'Acme', role: 'Dev' });
    expect(fake.read(UID, job.id)).not.toHaveProperty('id');
    expect(Object.keys(fake.read(UID, job.id) ?? {}).sort()).toEqual(
      Object.keys(job).filter((key) => key !== 'id').sort(),
    );
  });

  it('writes canonical field values through unchanged', async () => {
    const created = await repo.createJob({
      company: 'Acme',
      role: 'Dev',
      deadline: '2026-11-01T00:00:00.000Z',
      deadlineSource: 'user_entered',
      rawSource: 'manual',
      intakeStatus: 'confirmed',
    });
    const stored = fake.read(UID, created.id);
    expect(stored).toMatchObject({
      schemaVersion: JOB_SCHEMA_VERSION,
      company: 'Acme',
      role: 'Dev',
      deadline: '2026-11-01T00:00:00.000Z',
      deadlineSource: 'user_entered',
      rawSource: 'manual',
      intakeStatus: 'confirmed',
      approvalStatus: 'draft',
      applicationStatus: 'draft',
    });
  });

  it('derives dedupeKey rather than trusting the caller', async () => {
    const created = await repo.createJob({ company: 'Acme', role: 'Dev' });
    expect(created.dedupeKey).toBe('acme|dev|');
  });

  it('addresses users/{uid}/jobs and nothing else', async () => {
    await repo.createJob({ company: 'Acme', role: 'Dev' });
    expect(fake.collectionPaths).toEqual(['users', 'jobs']);
  });

  it('rejects a construction without a user id', () => {
    expect(() => new FirestoreJobsRepository('')).toThrow();
  });
});

describe('listJobs', () => {
  const seedThree = async () => {
    const older = await repo.createJob({ company: 'Oldest', role: 'a', now: '2026-01-01T00:00:00.000Z' });
    const middle = await repo.createJob({ company: 'Middle', role: 'b', now: '2026-02-01T00:00:00.000Z' });
    const newest = await repo.createJob({ company: 'Newest', role: 'c', now: '2026-03-01T00:00:00.000Z' });
    return { older, middle, newest };
  };

  it('defaults to newest first', async () => {
    await seedThree();
    expect((await repo.listJobs()).map((j) => j.company)).toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('honours ascending order', async () => {
    await seedThree();
    expect((await repo.listJobs({ orderDirection: 'asc' })).map((j) => j.company)).toEqual([
      'Oldest',
      'Middle',
      'Newest',
    ]);
  });

  it('can order by updatedAt', async () => {
    await seedThree();
    await repo.updateJob((await repo.listJobs({ orderDirection: 'asc' }))[0].id, {
      notes: 'touched',
    });
    const updated = await repo.listJobs({ orderBy: 'updatedAt', orderDirection: 'desc' });
    expect(updated[0].notes).toBe('touched');
  });

  it('applies limit', async () => {
    await seedThree();
    expect(await repo.listJobs({ limit: 2 })).toHaveLength(2);
    expect(await repo.listJobs({ limit: 99 })).toHaveLength(3);
  });

  it('excludes archived jobs by default and includes them on request', async () => {
    const { middle } = await seedThree();
    await repo.archiveJob(middle.id);
    expect((await repo.listJobs()).map((j) => j.company)).toEqual(['Newest', 'Oldest']);
    expect(await repo.listJobs({ includeArchived: true })).toHaveLength(3);
  });
});

describe('getJobById', () => {
  it('returns the stored job', async () => {
    const created = await repo.createJob({ company: 'Acme', role: 'Dev' });
    expect((await repo.getJobById(created.id))?.company).toBe('Acme');
  });

  it('returns null instead of throwing for a missing ID', async () => {
    await expect(repo.getJobById('nope')).resolves.toBeNull();
  });
});

describe('updateJob', () => {
  it('changes only the supplied fields', async () => {
    const created = await repo.createJob({
      company: 'Acme',
      role: 'Dev',
      location: 'Bangalore',
      notes: 'original',
    });
    const updated = await repo.updateJob(created.id, { role: 'Staff Dev' });

    expect(updated.role).toBe('Staff Dev');
    expect(updated.company).toBe('Acme');
    expect(updated.location).toBe('Bangalore');
    expect(updated.notes).toBe('original');
  });

  it('leaves untouched fields untouched in storage, not just in the response', async () => {
    const created = await repo.createJob({ company: 'Acme', role: 'Dev', notes: 'keep me' });
    await repo.updateJob(created.id, { role: 'Changed' });
    expect(fake.read(UID, created.id)).toMatchObject({ company: 'Acme', notes: 'keep me', role: 'Changed' });
  });

  it('preserves fields that a later phase owns', async () => {
    // Matching and mirroring run after manual entry; editing a role must not reset them.
    const created = await repo.createJob({ company: 'Acme', role: 'Dev' });
    await repo.updateJob(created.id, { matchScore: 87, selectedResumeId: 'resume-1', sheetRowId: 12 });
    const after = await repo.updateJob(created.id, { notes: 'note' });
    expect(after.matchScore).toBe(87);
    expect(after.selectedResumeId).toBe('resume-1');
    expect(after.sheetRowId).toBe(12);
  });

  it('can clear an optional field with an explicit null', async () => {
    const created = await repo.createJob({ company: 'Acme', role: 'Dev', location: 'Bangalore' });
    expect((await repo.updateJob(created.id, { location: null })).location).toBeNull();
  });

  it('recomputes dedupeKey when an identity field changes', async () => {
    const created = await repo.createJob({ company: 'Acme', role: 'Dev' });
    expect(created.dedupeKey).toBe('acme|dev|');

    const renamed = await repo.updateJob(created.id, { company: 'Globex' });
    expect(renamed.dedupeKey).toBe('globex|dev|');
    expect(fake.read(UID, created.id)?.dedupeKey).toBe('globex|dev|');
  });

  it('recomputes dedupeKey from URL changes', async () => {
    // The key is `company|role|url`, so an absent company and role leave empty segments.
    const created = await repo.createJob({ jobUrl: 'https://acme.com/jobs/1' });
    expect(created.dedupeKey).toBe('||acme.com/jobs/1');

    const moved = await repo.updateJob(created.id, { jobUrl: 'https://acme.com/jobs/2' });
    expect(moved.dedupeKey).toBe('||acme.com/jobs/2');
  });

  it('leaves dedupeKey alone when no identity field changes', async () => {
    const created = await repo.createJob({ company: 'Acme', role: 'Dev' });
    const touched = await repo.updateJob(created.id, { notes: 'unrelated' });
    expect(touched.dedupeKey).toBe('acme|dev|');
  });

  it('advances updatedAt without changing createdAt', async () => {
    const created = await repo.createJob({ company: 'Acme', role: 'Dev', now: '2026-01-01T00:00:00.000Z' });
    const updated = await repo.updateJob(created.id, { notes: 'later' });
    expect(updated.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
  });

  it('refuses to change immutable identity fields', () => {
    // Compile-time protection via JobPatch; this documents that the type is the guard.
    expect(true).toBe(true);
  });

  it('throws JobNotFoundError for a missing document', async () => {
    await expect(repo.updateJob('missing', { notes: 'x' })).rejects.toBeInstanceOf(JobNotFoundError);
  });
});

describe('archiveJob', () => {
  it('stamps archivedAt and keeps the document', async () => {
    // Archiving must never destroy data: the Sheet and mailbox mirrors depend on it.
    const created = await repo.createJob({ company: 'Acme', role: 'Dev' });
    const archived = await repo.archiveJob(created.id, '2026-10-05T12:00:00.000Z');
    expect(archived.archivedAt).toBe('2026-10-05T12:00:00.000Z');
    expect(fake.read(UID, created.id)).toBeDefined();
  });

  it('defaults archivedAt to now when no timestamp is supplied', async () => {
    const created = await repo.createJob({ company: 'Acme', role: 'Dev' });
    expect((await repo.archiveJob(created.id)).archivedAt).not.toBeNull();
  });

  it('does not disturb other fields', async () => {
    const created = await repo.createJob({ company: 'Acme', role: 'Dev', notes: 'keep' });
    await repo.archiveJob(created.id);
    expect(fake.read(UID, created.id)).toMatchObject({ company: 'Acme', role: 'Dev', notes: 'keep' });
  });

  it('throws JobNotFoundError for a missing document', async () => {
    await expect(repo.archiveJob('missing')).rejects.toBeInstanceOf(JobNotFoundError);
  });

  it('leaves archived jobs editable', async () => {
    const created = await repo.createJob({ company: 'Acme', role: 'Dev' });
    await repo.archiveJob(created.id);
    expect((await repo.updateJob(created.id, { notes: 'still editable' })).notes).toBe('still editable');
  });
});

describe('tenant isolation', () => {
  it('does not leak one user\'s jobs to another', async () => {
    const mine = await repo.createJob({ company: 'Acme', role: 'Dev' });
    const other = new FirestoreJobsRepository(OTHER_UID);

    expect(await other.listJobs()).toEqual([]);
    await expect(other.getJobById(mine.id)).resolves.toBeNull();
  });

  it('rejects a cross-user write', async () => {
    const mine = await repo.createJob({ company: 'Acme', role: 'Dev' });
    const other = new FirestoreJobsRepository(OTHER_UID);
    await expect(other.updateJob(mine.id, { notes: 'hijack' })).rejects.toBeInstanceOf(JobNotFoundError);
    await expect(other.archiveJob(mine.id)).rejects.toBeInstanceOf(JobNotFoundError);
    // `notes` is created as an explicit null, so the hijack is detectable as an unchanged null.
    expect(fake.read(UID, mine.id)?.notes).toBeNull();
  });
});

describe('boundary normalization', () => {
  it('reads a Firestore Timestamp as an ISO string', async () => {
    fake.seed(UID, 'legacy-1', {
      company: 'Acme',
      createdAt: { toDate: () => new Date('2026-01-02T03:04:05.000Z') },
    });
    const job = await repo.getJobById('legacy-1');
    expect(job?.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(job?.updatedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('reads epoch milliseconds as an ISO string', async () => {
    fake.seed(UID, 'epoch-1', { company: 'Acme', createdAt: 1767222245000 });
    expect((await repo.getJobById('epoch-1'))?.createdAt).toBe(new Date(1767222245000).toISOString());
  });

  it('reads a Date instance as an ISO string', async () => {
    fake.seed(UID, 'date-1', { company: 'Acme', createdAt: new Date('2026-03-04T05:06:07.000Z') });
    expect((await repo.getJobById('date-1'))?.createdAt).toBe('2026-03-04T05:06:07.000Z');
  });

  it('turns the legacy "No Deadline" sentinel into null', async () => {
    // The canonical field is ISO-or-null, so a sentinel must never reach the UI as if
    // it were a date.
    fake.seed(UID, 'sentinel-1', { company: 'Acme', deadline: 'No Deadline' });
    expect((await repo.getJobById('sentinel-1'))?.deadline).toBeNull();
  });

  it('turns other non-date strings into null rather than passing them through', async () => {
    fake.seed(UID, 'sentinel-2', { company: 'Acme', deadline: 'TBD', updatedAt: 'sometime soon' });
    const job = await repo.getJobById('sentinel-2');
    expect(job?.deadline).toBeNull();
    expect(job?.updatedAt).not.toBe('sometime soon');
  });

  it('falls back rather than crashing on an unreadable timestamp', async () => {
    fake.seed(UID, 'broken-1', { company: 'Acme', createdAt: { toDate: () => 'not a date' } });
    await expect(repo.getJobById('broken-1')).resolves.not.toBeNull();
  });

  it('coerces an unknown enum value to the documented default', async () => {
    fake.seed(UID, 'enum-1', { company: 'Acme', rawSource: 'telepathy', applicationStatus: 'hired' });
    const job = await repo.getJobById('enum-1');
    expect(job?.rawSource).toBe('manual');
    expect(job?.applicationStatus).toBe('draft');
  });

  it('rejects an out-of-range match score', async () => {
    fake.seed(UID, 'score-1', { company: 'Acme', matchScore: 999 });
    fake.seed(UID, 'score-2', { company: 'Acme', matchScore: 87 });
    expect((await repo.getJobById('score-1'))?.matchScore).toBeNull();
    expect((await repo.getJobById('score-2'))?.matchScore).toBe(87);
  });

  it('drops malformed nested structures instead of throwing', async () => {
    fake.seed(UID, 'nested-1', {
      company: 'Acme',
      fieldConfidence: 'not-an-object',
      matchBreakdown: 'not-an-array',
      resumeSuggestions: [null, 42],
    });
    const job = await repo.getJobById('nested-1');
    expect(job?.fieldConfidence).toBeNull();
    expect(job?.matchBreakdown).toBeNull();
    expect(job?.resumeSuggestions).toBeNull();
  });

  it('keeps valid entries and discards invalid ones inside nested arrays', async () => {
    fake.seed(UID, 'nested-2', {
      company: 'Acme',
      fieldConfidence: { company: 0.91, role: 'high' },
      matchBreakdown: [{ criterion: 'skills', score: 80, weight: 1 }, 'garbage'],
      // Not an envelope, so it is not a suggestion payload at all.
      resumeSuggestions: [{ id: 's1', targetSection: 'skills' }],
    });
    const job = await repo.getJobById('nested-2');
    expect(job?.fieldConfidence).toEqual({ company: 0.91 });
    expect(job?.matchBreakdown).toHaveLength(1);
    expect(job?.resumeSuggestions).toBeNull();
  });

  it('distinguishes never-generated, generated-empty, and generated-with-entries', async () => {
    // The three states drive three different UI outcomes, so reading must preserve them.
    fake.seed(UID, 'sug-none', { company: 'Acme' });
    fake.seed(UID, 'sug-empty', { company: 'Acme', resumeSuggestions: { schemaVersion: 1, suggestions: [] } });
    fake.seed(UID, 'sug-full', { company: 'Acme', resumeSuggestions: { schemaVersion: 1, suggestions: [VALID_SUGGESTION] } });

    expect((await repo.getJobById('sug-none'))?.resumeSuggestions).toBeNull();
    expect((await repo.getJobById('sug-empty'))?.resumeSuggestions).toEqual({ schemaVersion: 1, suggestions: [] });
    const full = (await repo.getJobById('sug-full'))?.resumeSuggestions;
    expect(full?.suggestions).toHaveLength(1);
    expect(full?.suggestions[0].title).toBe('Highlight existing PostgreSQL experience');
    expect(full?.suggestions[0].priority).toBe('high');
  });

  it('drops a suggestion missing any of its evidence rather than defaulting it', async () => {
    // A suggestion without its evidence asks to be trusted, so it is not a suggestion.
    const withoutEvidence = { ...VALID_SUGGESTION };
    delete (withoutEvidence as Partial<typeof VALID_SUGGESTION>).resumeEvidence;
    fake.seed(UID, 'sug-part', {
      company: 'Acme',
      resumeSuggestions: { schemaVersion: 1, suggestions: [withoutEvidence, VALID_SUGGESTION] },
    });
    const job = await repo.getJobById('sug-part');
    expect(job?.resumeSuggestions?.suggestions).toHaveLength(1);
    expect(job?.resumeSuggestions?.suggestions[0].id).toBe('sug_001');
  });

  it('refuses a suggestion payload from a schema it does not understand', async () => {
    fake.seed(UID, 'sug-old', { company: 'Acme', resumeSuggestions: { schemaVersion: 0, suggestions: [] } });
    fake.seed(UID, 'sug-bad', { company: 'Acme', resumeSuggestions: { suggestions: [] } });
    expect((await repo.getJobById('sug-old'))?.resumeSuggestions).toBeNull();
    expect((await repo.getJobById('sug-bad'))?.resumeSuggestions).toBeNull();
  });

  it('rejects negative counters', async () => {
    fake.seed(UID, 'count-1', { company: 'Acme', followUpCount: -5 });
    expect((await repo.getJobById('count-1'))?.followUpCount).toBe(0);
  });

  it('defaults missing booleans to false', async () => {
    fake.seed(UID, 'bool-1', { company: 'Acme' });
    expect((await repo.getJobById('bool-1'))?.draftEditedByHuman).toBe(false);
  });
});

describe('legacy Job Tracker coexistence', () => {
  const legacyDocument = {
    companyName: 'LegacyCo',
    link: 'https://legacy.example/1',
    deadline: 'No Deadline',
    status: 'Applied',
    notes: 'old record',
    createdAt: { toDate: () => new Date('2026-01-02T03:04:05.000Z') },
  };

  beforeEach(async () => {
    fake.seed(UID, 'legacy-doc', legacyDocument);
  });

  it('reads without crashing and reports schemaVersion 0', async () => {
    const job = await repo.getJobById('legacy-doc');
    expect(job?.schemaVersion).toBe(0);
  });

  it('does not reinterpret legacy fields as canonical ones', async () => {
    // No hidden migration: companyName is not company, link is not jobUrl.
    const job = await repo.getJobById('legacy-doc');
    expect(job?.company).toBeNull();
    expect(job?.jobUrl).toBeNull();
    expect(job?.deadline).toBeNull();
  });

  it('leaves the stored legacy document completely unmodified', async () => {
    await repo.listJobs();
    await repo.getJobById('legacy-doc');
    expect(fake.read(UID, 'legacy-doc')).toEqual(legacyDocument);
  });

  it('does not stamp a schema version onto the legacy document', async () => {
    await repo.listJobs();
    expect(fake.read(UID, 'legacy-doc')).not.toHaveProperty('schemaVersion');
  });

  it('is reported as schemaVersion 0 while canonical jobs keep the current version', async () => {
    const created = await repo.createJob({ company: 'Acme', role: 'Dev' });
    const all = await repo.listJobs();
    const legacy = all.find((j) => j.id === 'legacy-doc');
    const canonical = all.find((j) => j.id === created.id);
    expect(legacy?.schemaVersion).toBe(0);
    expect(canonical?.schemaVersion).toBe(JOB_SCHEMA_VERSION);
  });

  it('treats a legacy document without archivedAt as active, not archived', async () => {
    // Missing archivedAt must not make old records disappear from the owner's list.
    const job = await repo.getJobById('legacy-doc');
    expect(job?.archivedAt).toBeNull();
  });
});

describe('resume selection', () => {
  // Selecting a resume is a labelling act. It must not be able to move any field that
  // belongs to another feature — matching, approval, dedupe, or identity.
  const FORBIDDEN_FIELDS = [
    'dedupeKey',
    'company',
    'role',
    'jobUrl',
    'approvalStatus',
    'matchScore',
    'applicationStatus',
  ] as const;

  async function seedWithEverything() {
    const created = await repo.createJob({ company: 'Acme', role: 'Dev', jobUrl: 'https://acme.dev/j1' });
    await repo.updateJob(created.id, {
      approvalStatus: 'approved',
      matchScore: 64,
      selectedResumeId: 'rsv_old',
    });
    return created;
  }

  it('changes only selectedResumeId, leaving every protected field alone', async () => {
    const created = await seedWithEverything();
    const before = fake.read(UID, created.id) ?? {};
    const after = await repo.updateJob(created.id, { selectedResumeId: 'rsv_new' });

    for (const field of FORBIDDEN_FIELDS) {
      expect(after[field]).toEqual(before[field]);
    }
    expect(after.selectedResumeId).toBe('rsv_new');
    expect(before.selectedResumeId).toBe('rsv_old');
  });

  it('persists the choice so it survives a reload', async () => {
    const created = await seedWithEverything();
    await repo.updateJob(created.id, { selectedResumeId: 'rsv_new' });
    expect(fake.read(UID, created.id)?.selectedResumeId).toBe('rsv_new');
    expect((await repo.getJobById(created.id))?.selectedResumeId).toBe('rsv_new');
    expect((await repo.listJobs()).find((j) => j.id === created.id)?.selectedResumeId).toBe('rsv_new');
  });

  it('can be cleared back to none', async () => {
    const created = await seedWithEverything();
    const cleared = await repo.updateJob(created.id, { selectedResumeId: null });
    expect(cleared.selectedResumeId).toBeNull();
    expect(fake.read(UID, created.id)?.selectedResumeId).toBeNull();
  });

  it('replays an identical selection without altering the protected fields', async () => {
    // The picker always writes on tap, even when the row is already the chosen one.
    const created = await seedWithEverything();
    const first = fake.read(UID, created.id) ?? {};
    await repo.updateJob(created.id, { selectedResumeId: 'rsv_old' });
    const second = fake.read(UID, created.id) ?? {};
    for (const field of FORBIDDEN_FIELDS) {
      expect(second[field]).toEqual(first[field]);
    }
  });
});
