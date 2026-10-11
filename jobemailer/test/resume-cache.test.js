/**
 * Tests for the Resume Library cache transformation layer.
 *
 * Runs on `node:test`, which is built into Node 20+, so the server needs no test-runner
 * dependency. No Google credentials are involved: every case is a pure transformation of a
 * fixture.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESUME_CACHE_HEADERS,
  RESUME_CACHE_SCHEMA_VERSION,
  RESUME_SUMMARY_HEADERS,
  SKIP_REASONS,
  computeContentHash,
  deriveResumeId,
  normalizeExtractedText,
  parseCacheRow,
  parseCacheRows,
  parseKeywords,
  projectPublicResume,
  projectPublicResumes,
  serializeKeywords,
  splitHeaderAndRows,
  toSheetValues,
} from '../lib/resume-cache.js';

const VALID_ROW = {
  resumeId: 'rsv_abc123',
  resumeLabel: 'Backend — Go — v3',
  targetRole: 'Backend Engineer',
  targetRoleFamily: 'backend',
  version: 3,
  isDefault: false,
  keywords: '["Go","Python","PostgreSQL"]',
  driveFileId: '1DriVeFiLeIdDoNotLeak',
  driveFileName: 'Vishal_Kumar_Ojha_Backend.pdf',
  extractedText: 'JANE DOE SENIOR BACKEND ENGINEER Go PostgreSQL Kubernetes',
  contentHash: 'deadbeef',
  updatedAt: '2026-10-05T09:00:00.000Z',
  lastUsedAt: null,
  schemaVersion: RESUME_CACHE_SCHEMA_VERSION,
};

const keys = (object) => Object.keys(object).sort();
const SERIALIZED = (object) => JSON.stringify(object);

test('a valid cache row becomes a record', () => {
  const result = parseCacheRow(VALID_ROW);
  assert.equal(result.ok, true);
  assert.equal(result.record.resumeId, 'rsv_abc123');
  assert.equal(result.record.resumeLabel, 'Backend — Go — v3');
  assert.equal(result.record.targetRole, 'Backend Engineer');
  assert.equal(result.record.targetRoleFamily, 'backend');
  assert.equal(result.record.version, 3);
  assert.equal(result.record.isDefault, false);
  assert.deepEqual(result.record.keywords, ['go', 'python', 'postgresql']);
  assert.equal(result.record.updatedAt, '2026-10-05T09:00:00.000Z');
  assert.equal(result.record.lastUsedAt, null);
});

test('the public projection carries exactly the agreed fields', () => {
  const { record } = parseCacheRow(VALID_ROW);
  const summary = projectPublicResume(record);
  assert.deepEqual(keys(summary), [...RESUME_SUMMARY_HEADERS, 'schemaVersion'].sort());
});

test('driveFileId never appears in the projection', () => {
  const { record } = parseCacheRow(VALID_ROW);
  const serialized = SERIALIZED(projectPublicResume(record));
  assert.equal(serialized.includes('driveFileId'), false);
  assert.equal(serialized.includes('1DriVeFiLeIdDoNotLeak'), false);
});

test('driveFileName never appears in the projection', () => {
  const { record } = parseCacheRow(VALID_ROW);
  assert.equal(SERIALIZED(projectPublicResume(record)).includes('Vishal_Kumar_Ojha_Backend.pdf'), false);
});

test('extractedText never appears in the projection', () => {
  const { record } = parseCacheRow(VALID_ROW);
  const serialized = SERIALIZED(projectPublicResume(record));
  assert.equal(serialized.includes('extractedText'), false);
  assert.equal(serialized.includes('JANE DOE'), false);
});

test('contentHash never appears in the projection', () => {
  const { record } = parseCacheRow(VALID_ROW);
  assert.equal(SERIALIZED(projectPublicResume(record)).includes('deadbeef'), false);
});

test('no credential-shaped value can survive the projection', () => {
  // Even if a cache row is polluted with credential-looking fields, an allow-list
  // projection cannot publish them.
  // Values are deliberately non-secret-shaped so a repository-wide credential scan does not
  // have to distinguish a fixture from a leak. What matters is that the field NAMES cannot
  // appear in the output, which is what the allow-list projection guarantees.
  const polluted = {
    ...VALID_ROW,
    clientEmail: 'robot@example.invalid',
    privateKey: 'not-a-real-key',
    serviceAccountJson: '{"type":"service_account"}',
  };
  const { record } = parseCacheRow(polluted);
  const serialized = SERIALIZED(projectPublicResume(record));
  for (const forbidden of ['clientEmail', 'privateKey', 'serviceAccountJson', 'not-a-real-key', 'example.invalid']) {
    assert.equal(serialized.includes(forbidden), false, `projection leaked ${forbidden}`);
  }
});

test('a row missing resumeId is skipped with a documented reason', () => {
  const result = parseCacheRow({ ...VALID_ROW, resumeId: '' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, SKIP_REASONS.missingResumeId);
});

test('a blank row is skipped', () => {
  const result = parseCacheRow({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, SKIP_REASONS.blankRow);
});

test('a non-object row is skipped', () => {
  for (const value of [null, undefined, 'a string', 42]) {
    const result = parseCacheRow(value);
    assert.equal(result.ok, false);
    assert.equal(result.reason, SKIP_REASONS.notAnObject);
  }
});

test('a row with no label and no file name is skipped rather than given a fake label', () => {
  const result = parseCacheRow({ ...VALID_ROW, resumeLabel: '', driveFileName: '' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, SKIP_REASONS.noUsableLabel);
});

test('a label falls back to the file name, which is derived rather than invented', () => {
  const result = parseCacheRow({ ...VALID_ROW, resumeLabel: '', driveFileName: 'My_CV_2026.pdf' });
  assert.equal(result.ok, true);
  assert.equal(result.record.resumeLabel, 'My_CV_2026');
});

test('targetRole is never inferred from extractedText', () => {
  const result = parseCacheRow({
    ...VALID_ROW,
    targetRole: '',
    targetRoleFamily: '',
    extractedText: 'SENIOR BACKEND ENGINEER with 8 years of Go experience',
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.targetRole, null);
  assert.equal(result.record.targetRoleFamily, null);
});

test('an old schemaVersion is rejected', () => {
  const result = parseCacheRow({ ...VALID_ROW, schemaVersion: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, SKIP_REASONS.schemaTooOld);
});

test('an explicit old schemaVersion is never laundered into the current one', () => {
  // Regression: a lenient coercer would turn 0 into 1 and accept a row it must reject.
  for (const schemaVersion of [0, '0', -1]) {
    const result = parseCacheRow({ ...VALID_ROW, schemaVersion });
    assert.equal(result.ok, false, `schemaVersion ${schemaVersion} must be rejected`);
    assert.equal(result.reason, SKIP_REASONS.schemaTooOld);
  }
});

test('a blank schemaVersion is backfilled for hand-created rows', () => {
  const result = parseCacheRow({ ...VALID_ROW, schemaVersion: '' });
  assert.equal(result.ok, true);
  assert.equal(result.record.schemaVersion, RESUME_CACHE_SCHEMA_VERSION);
});

test('a newer schemaVersion is accepted rather than hidden', () => {
  const result = parseCacheRow({ ...VALID_ROW, schemaVersion: RESUME_CACHE_SCHEMA_VERSION + 1, futureColumn: 'x' });
  assert.equal(result.ok, true);
  assert.equal(result.record.resumeId, 'rsv_abc123');
});

test('version defaults to 1 when blank or invalid', () => {
  for (const version of ['', null, 'abc', 0, -3, undefined]) {
    const result = parseCacheRow({ ...VALID_ROW, version });
    assert.equal(result.ok, true);
    assert.equal(result.record.version, 1);
  }
});

test('version is coerced from a numeric string', () => {
  assert.equal(parseCacheRow({ ...VALID_ROW, version: '7' }).record.version, 7);
});

test('isDefault recognizes the spellings a human would type', () => {
  for (const value of [true, 'true', 'TRUE', 'yes', 'Y', '1', 1]) {
    assert.equal(parseCacheRow({ ...VALID_ROW, isDefault: value }).record.isDefault, true);
  }
  for (const value of [false, 'false', 'no', '', 'maybe', 0, null, undefined, {}]) {
    assert.equal(parseCacheRow({ ...VALID_ROW, isDefault: value }).record.isDefault, false);
  }
});

test('keywords accept JSON text and comma-separated text', () => {
  assert.deepEqual(parseKeywords('["Go","PostgreSQL"]'), ['go', 'postgresql']);
  assert.deepEqual(parseKeywords('Go, PostgreSQL , Kubernetes'), ['go', 'postgresql', 'kubernetes']);
  assert.deepEqual(parseKeywords(['Go', 'AWS']), ['go', 'aws']);
});

test('malformed keyword JSON yields nothing rather than junk tokens', () => {
  // `["go",` must not fall through to comma-splitting and emit the token `["go"`.
  assert.deepEqual(parseKeywords('["Go",'), []);
  assert.deepEqual(parseKeywords('{"a":1}'), []);
  assert.deepEqual(parseKeywords(''), []);
  assert.deepEqual(parseKeywords(null), []);
  assert.deepEqual(parseKeywords(42), []);
});

test('keywords round-trip through the sheet serialization', () => {
  const keywords = ['go', 'postgresql'];
  assert.deepEqual(parseKeywords(serializeKeywords(keywords)), keywords);
});

test('an unparseable timestamp becomes null rather than an invalid date', () => {
  const result = parseCacheRow({ ...VALID_ROW, updatedAt: 'not-a-date' });
  assert.equal(result.record.updatedAt, null);
});

test('a Sheets date serial is converted to ISO', () => {
  // Sheets day 0 is 1899-12-30, so day 46000 is 2025-12-09. An exact match proves the
  // serial was converted rather than passed through.
  const result = parseCacheRow({ ...VALID_ROW, updatedAt: 46000 });
  assert.equal(result.record.updatedAt, '2025-12-09T00:00:00.000Z');
});

test('parseCacheRows keeps good rows and counts the skipped ones', () => {
  const { records, skipped } = parseCacheRows([
    VALID_ROW,
    { ...VALID_ROW, resumeId: '' },
    { ...VALID_ROW, resumeLabel: '', driveFileName: '' },
    {},
  ]);
  assert.equal(records.length, 1);
  assert.equal(skipped[SKIP_REASONS.missingResumeId], 1);
  assert.equal(skipped[SKIP_REASONS.noUsableLabel], 1);
  assert.equal(skipped[SKIP_REASONS.blankRow], 1);
});

test('one bad row does not take down the list', () => {
  // Row 2 has real content but no resumeId, which is the realistic shape of a bad row:
  // a partly-filled sheet cell. A wholly empty row is a different (blank) case.
  const rows = Array.from({ length: 5 }, (_, index) =>
    index === 2 ? { ...VALID_ROW, resumeId: '' } : { ...VALID_ROW, resumeId: `rsv_${index}` },
  );
  const { records, skipped } = parseCacheRows(rows);
  assert.equal(records.length, 4);
  assert.equal(skipped[SKIP_REASONS.missingResumeId], 1);
});

test('deriveResumeId is deterministic, opaque, and hides the Drive id', () => {
  const driveFileId = '1DriVeFiLeIdDoNotLeak';
  const first = deriveResumeId(driveFileId);
  assert.equal(first, deriveResumeId(driveFileId));
  assert.match(first, /^rsv_[0-9a-f]{24}$/);
  assert.equal(first.includes(driveFileId), false);
});

test('deriveResumeId does not collide on a shared prefix', () => {
  assert.notEqual(deriveResumeId('file-a'), deriveResumeId('file-b'));
});

test('contentHash ignores layout differences in extracted text', () => {
  const wrapped = 'Jane Doe\nSenior Backend\nEngineer';
  const flowed = 'Jane Doe Senior Backend Engineer';
  assert.equal(computeContentHash(normalizeExtractedText(wrapped)), computeContentHash(normalizeExtractedText(flowed)));
});

test('contentHash changes when the content changes', () => {
  assert.notEqual(
    computeContentHash(normalizeExtractedText('Jane Doe Backend')),
    computeContentHash(normalizeExtractedText('Jane Doe Frontend')),
  );
});

test('normalizeExtractedText rejoins hyphenated line breaks and collapses whitespace', () => {
  assert.equal(normalizeExtractedText('distri-\nbuted systems'), 'distributed systems');
  assert.equal(normalizeExtractedText('  a \n\n  b  '), 'a b');
  assert.equal(normalizeExtractedText(undefined), '');
});

test('a reordered header does not shift values into the wrong field', () => {
  // Reversing key order changes nothing about which value belongs to which column.
  const reordered = [...RESUME_CACHE_HEADERS].reverse();
  const row = Object.fromEntries(reordered.map((header) => [header, VALID_ROW[header]]));
  const result = parseCacheRow(row);
  assert.equal(result.ok, true);
  assert.equal(result.record.resumeLabel, VALID_ROW.resumeLabel);
  assert.equal(result.record.version, 3);
  assert.equal(result.record.driveFileId, VALID_ROW.driveFileId);
});

test('a reversed header row in the sheet still parses by name', () => {
  const reversed = [...RESUME_CACHE_HEADERS].reverse();
  const values = [reversed, reversed.map((header) => VALID_ROW[header])];
  const { rows } = splitHeaderAndRows(values);
  const { records } = parseCacheRows(rows);
  assert.equal(records.length, 1);
  assert.equal(records[0].resumeLabel, VALID_ROW.resumeLabel);
  assert.equal(records[0].version, 3);
});

test('splitHeaderAndRows ignores blank body rows', () => {
  const { headers, rows } = splitHeaderAndRows([
    RESUME_CACHE_HEADERS,
    [VALID_ROW.resumeId, VALID_ROW.resumeLabel],
    ['', '', ''],
  ]);
  assert.deepEqual(headers, RESUME_CACHE_HEADERS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resumeLabel, VALID_ROW.resumeLabel);
});

test('splitHeaderAndRows handles a completely empty tab', () => {
  assert.deepEqual(splitHeaderAndRows([]), { headers: [], rows: [] });
  assert.deepEqual(splitHeaderAndRows(undefined), { headers: [], rows: [] });
});

test('toSheetValues writes the header order and serializes keywords', () => {
  const { record } = parseCacheRow(VALID_ROW);
  const [row] = toSheetValues([record]);
  assert.equal(row.length, RESUME_CACHE_HEADERS.length);
  assert.equal(row[RESUME_CACHE_HEADERS.indexOf('resumeId')], 'rsv_abc123');
  assert.deepEqual(JSON.parse(row[RESUME_CACHE_HEADERS.indexOf('keywords')]), ['go', 'python', 'postgresql']);
});

test('a sheet round-trip preserves the public projection', () => {
  const { record } = parseCacheRow(VALID_ROW);
  const values = [RESUME_CACHE_HEADERS, ...toSheetValues([record])];
  const { rows } = splitHeaderAndRows(values);
  const { records } = parseCacheRows(rows);
  assert.deepEqual(projectPublicResumes(records), projectPublicResumes([record]));
});

test('projectPublicResumes tolerates a non-array input', () => {
  assert.deepEqual(projectPublicResumes(undefined), []);
  assert.deepEqual(projectPublicResumes(null), []);
});
