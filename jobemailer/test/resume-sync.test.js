/**
 * Tests for the Drive -> cache merge logic.
 *
 * All side effects are injected, so these run with no Google credentials and no network.
 * The fixtures stand in for Drive listings and PDF buffers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeFileIntoCache, planSync } from '../lib/resume-sync.js';
import { computeContentHash, deriveResumeId, parseCacheRows } from '../lib/resume-cache.js';

const NOW = '2026-10-05T09:00:00.000Z';
const TEXT = 'VISHAL KUMAR OJHA BACKEND ENGINEER Go PostgreSQL Kubernetes';

const FILE = {
  id: '1DriVeFiLeIdOne',
  name: 'Vishal_Backend_2026.pdf',
  modifiedTime: '2026-10-01T10:00:00.000Z',
  md5Checksum: 'aaa',
};

/** Stands in for downloading + parsing a PDF. Records what it was asked to do. */
function fakePdfDeps(overrides = {}) {
  const calls = { downloads: [], extractions: 0 };
  return {
    calls,
    deps: {
      download: async (fileId) => {
        calls.downloads.push(fileId);
        return Buffer.from('fake-pdf-bytes');
      },
      extractText: async () => {
        calls.extractions += 1;
        return { text: TEXT };
      },
      ...overrides,
    },
  };
}

test('a new file becomes an added row with a derived resumeId', async () => {
  const { deps } = fakePdfDeps();
  const result = await mergeFileIntoCache(FILE, null, deps, NOW);
  assert.equal(result.action, 'added');
  assert.equal(result.record.resumeId, deriveResumeId(FILE.id));
  assert.equal(result.record.driveFileId, FILE.id);
  assert.equal(result.record.driveFileName, FILE.name);
  assert.equal(result.record.extractedText, TEXT);
  assert.equal(result.record.contentHash, computeContentHash(TEXT));
  assert.equal(result.record.updatedAt, FILE.modifiedTime);
});

test('target role metadata is left empty for a new row and reported', async () => {
  const { deps } = fakePdfDeps();
  const result = await mergeFileIntoCache(FILE, null, deps, NOW);
  assert.equal(result.record.targetRole, null);
  assert.equal(result.record.targetRoleFamily, null);
  assert.equal(result.record.keywords.length, 0);
  assert.ok(result.notes.some((note) => note.includes('targetRole')));
  assert.ok(result.notes.some((note) => note.includes('targetRoleFamily')));
});

test('target role metadata is never inferred from the PDF text', async () => {
  const { deps } = fakePdfDeps({
    extractText: async () => ({ text: 'SENIOR BACKEND ENGINEER / MACHINE LEARNING SPECIALIST' }),
  });
  const result = await mergeFileIntoCache(FILE, null, deps, NOW);
  assert.equal(result.record.targetRole, null);
  assert.equal(result.record.targetRoleFamily, null);
  assert.equal(result.record.resumeLabel, 'Vishal_Backend_2026');
});

test('a label derived from the file name drops the pdf extension', async () => {
  const { deps } = fakePdfDeps();
  const result = await mergeFileIntoCache(FILE, null, deps, NOW);
  assert.equal(result.record.resumeLabel, 'Vishal_Backend_2026');
});

test('manually maintained metadata survives a resync', async () => {
  const prior = {
    resumeId: deriveResumeId(FILE.id),
    resumeLabel: 'Backend — Go — v3',
    targetRole: 'Backend Engineer',
    targetRoleFamily: 'backend',
    version: 3,
    isDefault: true,
    keywords: ['go', 'postgres'],
    driveFileId: FILE.id,
    driveFileName: FILE.name,
    extractedText: TEXT,
    contentHash: computeContentHash(TEXT),
    updatedAt: '2026-09-01T10:00:00.000Z',
    lastUsedAt: '2026-09-20T08:00:00.000Z',
    schemaVersion: 1,
  };
  const { deps } = fakePdfDeps();
  const result = await mergeFileIntoCache(FILE, prior, deps, NOW);

  assert.equal(result.record.resumeLabel, 'Backend — Go — v3');
  assert.equal(result.record.targetRole, 'Backend Engineer');
  assert.equal(result.record.targetRoleFamily, 'backend');
  assert.equal(result.record.version, 3);
  assert.equal(result.record.isDefault, true);
  assert.deepEqual(result.record.keywords, ['go', 'postgres']);
  assert.equal(result.record.lastUsedAt, '2026-09-20T08:00:00.000Z');
  assert.deepEqual(result.preserved, ['resumeLabel', 'targetRole', 'targetRoleFamily', 'version', 'isDefault', 'keywords']);
});

test('lastUsedAt is left null for a new row and never invented', async () => {
  const { deps } = fakePdfDeps();
  const result = await mergeFileIntoCache(FILE, null, deps, NOW);
  assert.equal(result.record.lastUsedAt, null);
});

test('an unchanged file is not downloaded again', async () => {
  const prior = {
    driveFileId: FILE.id,
    driveFileName: FILE.name,
    contentHash: computeContentHash(TEXT),
    updatedAt: FILE.modifiedTime,
    resumeLabel: 'Backend — Go — v3',
  };
  const { deps, calls } = fakePdfDeps();
  const result = await mergeFileIntoCache(FILE, prior, deps, NOW);

  assert.deepEqual(calls.downloads, [], 'an unchanged file must not be downloaded');
  assert.equal(calls.extractions, 0);
  assert.equal(result.action, 'unchanged');
  assert.equal(result.record.extractedText, '');
});

test('a changed file is re-downloaded and re-hashed', async () => {
  const prior = {
    driveFileId: FILE.id,
    driveFileName: FILE.name,
    contentHash: 'stale-hash',
    updatedAt: '2026-09-01T10:00:00.000Z',
    extractedText: 'old text',
  };
  const { deps, calls } = fakePdfDeps();
  const result = await mergeFileIntoCache(FILE, prior, deps, NOW);

  assert.deepEqual(calls.downloads, [FILE.id]);
  assert.equal(result.action, 'updated');
  assert.equal(result.record.extractedText, TEXT);
  assert.equal(result.record.contentHash, computeContentHash(TEXT));
});

test('a renamed file keeps its metadata and is marked updated', async () => {
  const prior = {
    driveFileId: FILE.id,
    driveFileName: 'Old_Name.pdf',
    contentHash: computeContentHash(TEXT),
    updatedAt: FILE.modifiedTime,
    resumeLabel: 'Backend — Go — v3',
    targetRole: 'Backend Engineer',
    version: 2,
  };
  const { deps } = fakePdfDeps();
  const result = await mergeFileIntoCache({ ...FILE, name: 'New_Name.pdf' }, prior, deps, NOW);
  assert.equal(result.action, 'updated');
  assert.equal(result.record.driveFileName, 'New_Name.pdf');
  assert.equal(result.record.resumeLabel, 'Backend — Go — v3');
  assert.equal(result.record.targetRole, 'Backend Engineer');
  assert.equal(result.record.version, 2);
});

test('a failed extraction keeps the previous text instead of blanking it', async () => {
  const prior = {
    driveFileId: FILE.id,
    driveFileName: FILE.name,
    contentHash: computeContentHash('good previous text'),
    updatedAt: '2026-09-01T10:00:00.000Z',
    extractedText: 'good previous text',
  };
  const { deps } = fakePdfDeps({
    extractText: async () => ({ failed: true, text: '', reason: 'invalid PDF structure' }),
  });
  const result = await mergeFileIntoCache(FILE, prior, deps, NOW);
  assert.equal(result.record.extractedText, 'good previous text');
  assert.equal(result.record.contentHash, computeContentHash('good previous text'));
  assert.ok(result.notes.some((note) => note.includes('invalid PDF structure')));
});

test('a scanned PDF with no text layer is reported', async () => {
  const { deps } = fakePdfDeps({ extractText: async () => ({ text: '' }) });
  const result = await mergeFileIntoCache(FILE, null, deps, NOW);
  assert.ok(result.notes.some((note) => note.includes('scanned image')));
  assert.equal(result.record.contentHash, computeContentHash(''));
});

test('a file with no modifiedTime falls back to the run clock', async () => {
  const { deps } = fakePdfDeps();
  const result = await mergeFileIntoCache({ id: 'abc', name: 'X.pdf' }, null, deps, NOW);
  assert.equal(result.record.updatedAt, NOW);
});

// ─── planSync ───────────────────────────────────────────────────────────────────

test('planSync pairs each Drive file with its existing row', async () => {
  const existing = [
    { resumeId: deriveResumeId(FILE.id), driveFileId: FILE.id, driveFileName: FILE.name, updatedAt: FILE.modifiedTime, contentHash: computeContentHash(TEXT), resumeLabel: 'Backend — Go' },
  ];
  const { deps } = fakePdfDeps();
  const plan = await planSync([FILE], existing, deps, NOW);

  assert.equal(plan.results.length, 1);
  assert.equal(plan.results[0].record.resumeLabel, 'Backend — Go');
  assert.deepEqual(plan.orphans, []);
});

test('planSync keeps a cached row whose file is gone from the folder', async () => {
  const orphan = {
    resumeId: 'rsv_gone',
    driveFileId: 'deletedFileId',
    driveFileName: 'Old_Resume.pdf',
    resumeLabel: 'Old — kept',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const { deps } = fakePdfDeps();
  const plan = await planSync([FILE], [orphan], deps, NOW);

  assert.equal(plan.orphans.length, 1);
  assert.equal(plan.orphans[0].resumeId, 'rsv_gone');
  // The orphan is still part of the rows to write, so an existing selection keeps resolving.
  assert.equal(plan.rows.length, 2);
  assert.ok(plan.rows.some((row) => row.resumeId === 'rsv_gone'));
});

test('planSync reports only the rows that actually changed', async () => {
  const unchanged = {
    resumeId: deriveResumeId(FILE.id),
    driveFileId: FILE.id,
    driveFileName: FILE.name,
    updatedAt: FILE.modifiedTime,
    contentHash: computeContentHash(TEXT),
    resumeLabel: 'Stable',
  };
  const { deps } = fakePdfDeps();
  const plan = await planSync([FILE], [unchanged], deps, NOW);
  assert.equal(plan.changed.length, 0);
  assert.equal(plan.rows.length, 1);
});

test('planSync handles an empty Drive folder and an empty cache', async () => {
  const empty = await planSync([], [], {}, NOW);
  assert.deepEqual(empty.results, []);
  assert.deepEqual(empty.orphans, []);
  assert.deepEqual(empty.rows, []);
});

test('a plan row survives the cache parser and projects without private fields', async () => {
  const { deps } = fakePdfDeps();
  const plan = await planSync([FILE], [], deps, NOW);

  // Round-trip through the reader the endpoint uses.
  const rows = plan.rows.map((row) => ({ ...row, keywords: JSON.stringify(row.keywords) }));
  const { records } = parseCacheRows(rows);
  assert.equal(records.length, 1);
  assert.equal(records[0].extractedText, TEXT);
  assert.equal(records[0].driveFileId, FILE.id);
});
