/**
 * Resume Library cache schema, parsing rules, and the public projection.
 *
 * This module is deliberately pure: no Google API calls, no environment reads, no clock.
 * Everything it does is a transformation of values that arrived from somewhere, which is
 * what makes it testable with fixtures and safe to reason about.
 *
 * Data flow:
 *
 *     Drive folder --(sync)--> Sheet tab "Resumes" --(this module)--> ResumeSummary[]
 *
 * The Sheet is a *cache*, not the source of truth. It is a human-editable place to keep
 * metadata that cannot be derived from a PDF (target role, version, default flag,
 * keywords), plus the expensive-to-recompute `extractedText` and `contentHash`.
 *
 * Ownership boundary. These fields are server-only and must never leave the server:
 *
 *     driveFileId, driveFileName, extractedText, contentHash
 *
 * `extractedText` in particular is the resume's full body. It exists so that a future
 * matching step does not have to download and re-parse PDFs on every request, and it is
 * exactly the kind of data that must not be shipped to a device. `projectPublicResume`
 * builds its output field by field for that reason: there is no code path that spreads a
 * raw row into a response.
 */

import { createHash } from 'node:crypto';

/** Version of the Resume Library cache schema written and read by this module. */
export const RESUME_CACHE_SCHEMA_VERSION = 1;

/** Version of the public `ResumeSummary` projection sent to the mobile app. */
export const RESUME_SUMMARY_SCHEMA_VERSION = 1;

/**
 * Header row for the Sheet tab, in order. The sync writes rows in this order, and the
 * reader locates columns by name so a reordered or extended header still parses.
 */
export const RESUME_CACHE_HEADERS = [
  'resumeId',
  'resumeLabel',
  'targetRole',
  'targetRoleFamily',
  'version',
  'isDefault',
  'keywords',
  'driveFileId',
  'driveFileName',
  'extractedText',
  'contentHash',
  'updatedAt',
  'lastUsedAt',
  'schemaVersion',
];

/**
 * Columns a human is expected to maintain by hand. The sync must never overwrite these
 * from the PDF, because a PDF cannot tell you the intended role family or version number.
 */
export const MANUALLY_MAINTAINED_HEADERS = [
  'resumeLabel',
  'targetRole',
  'targetRoleFamily',
  'version',
  'isDefault',
  'keywords',
];

/**
 * Known coarse role families. Advisory rather than enforced: an unrecognized value is
 * passed through rather than rejected, so a cache written by a newer sync is not hidden
 * from an older reader.
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
];

/** Why a cache row was not turned into a record. Reported so bad rows are visible. */
export const SKIP_REASONS = {
  blankRow: 'blank_row',
  missingResumeId: 'missing_resume_id',
  noUsableLabel: 'no_usable_label',
  schemaTooOld: 'schema_version_too_old',
  notAnObject: 'not_an_object',
};

/**
 * Derives a stable public identifier from a Drive file id.
 *
 * Requirements this satisfies:
 * - Stable across Sheet reordering and row deletion, because it depends only on Drive
 *   identity and never on a row number.
 * - Opaque, so the mobile app cannot enumerate Drive file ids or reconstruct Drive URLs.
 *
 * Changing this function would orphan every existing `selectedResumeId`, so it is versioned
 * by the `rsv_` prefix and must stay byte-identical once shipped.
 */
export function deriveResumeId(driveFileId) {
  const digest = createHash('sha256').update(String(driveFileId), 'utf8').digest('hex');
  return `rsv_${digest.slice(0, 24)}`;
}

/** Hash of extracted text, used to detect that a PDF changed without re-reading metadata. */
export function computeContentHash(extractedText) {
  return createHash('sha256').update(String(extractedText ?? ''), 'utf8').digest('hex');
}

/**
 * Collapses PDF text into a stable single-line form.
 *
 * PDF extraction yields hard-wrapped lines, hyphenated breaks, and ragged spacing, so the
 * raw output differs between two extractions of the same document. Normalizing before
 * hashing means `contentHash` reflects the content rather than the layout.
 */
export function normalizeExtractedText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    // Rejoin words split across a line by a hyphen.
    .replace(/([a-z])-\n([a-z])/gi, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Coerces a Sheets boolean-ish cell to a real boolean. Anything unrecognized is false. */
function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return false;
  const text = value.trim().toLowerCase();
  return text === 'true' || text === 'yes' || text === 'y' || text === '1';
}

/** Coerces a version cell to a positive integer, defaulting to 1. */
function toVersion(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.trunc(parsed);
}

/**
 * Reads `schemaVersion`, which must NOT go through `toVersion`.
 *
 * `toVersion` turns anything below 1 into 1, which is right for a human-maintained resume
 * version but catastrophic for a schema version: it would silently upgrade a row written by
 * an older schema into a current one, and the whole point of the column is to catch exactly
 * that. So an explicit numeric value is returned as-is for the caller to compare, and only a
 * genuinely blank cell is backfilled to the current version.
 */
function toSchemaVersion(value) {
  if (value === null || value === undefined || String(value).trim() === '') return RESUME_CACHE_SCHEMA_VERSION;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed)) return RESUME_CACHE_SCHEMA_VERSION;
  return Math.trunc(parsed);
}

/**
 * Parses the keywords cell.
 *
 * JSON text is the canonical form written by the sync. A comma-separated string is also
 * accepted because it is far easier to type into a spreadsheet by hand, which matters when
 * the whole point of a cache is that a person maintains some of it.
 */
export function parseKeywords(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];

  // Input that opens like JSON is treated as JSON, and unparseable JSON yields nothing.
  // Falling back to comma-splitting here would emit junk tokens like `["go"` for `["go",`,
  // which is worse than an empty list: it looks populated while matching nothing.
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry) => typeof entry === 'string')
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean);
      }
    } catch {
      return [];
    }
    return [];
  }

  return text
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Serializes keywords back to the JSON text form the sync writes. */
export function serializeKeywords(keywords) {
  return JSON.stringify(parseKeywords(keywords));
}

/**
 * Accepts an ISO-8601 timestamp, or a Sheets date serial number.
 *
 * Returns `null` rather than `new Date(NaN)` for anything unrecognized: an invalid date
 * in a JSON response is a silent data-quality bug, whereas `null` is visibly unpopulated.
 */
function toIsoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Sheets day 0 is 1899-12-30.
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== 'string') return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Turns one raw cache row into a record, or reports why it cannot.
 *
 * Skip rules (a row is excluded from the response rather than guessed at):
 *   - not an object                  -> `not_an_object`
 *   - every field blank              -> `blank_row`
 *   - no `resumeId`                  -> `missing_resume_id`
 *   - no label and no file name      -> `no_usable_label`
 *   - `schemaVersion` below 1        -> `schema_version_too_old`
 *
 * Coercion rules (a value is defaulted rather than dropping the whole row):
 *   - `version`      blank or invalid -> 1
 *   - `isDefault`    unrecognized    -> false
 *   - `keywords`     unparseable     -> []
 *   - `targetRole`   blank           -> null
 *   - timestamps     unparseable     -> null
 *
 * A `schemaVersion` *newer* than this reader is accepted. The projection only reads named
 * fields it understands, so an unknown future column cannot leak and an unknown future
 * meaning cannot be guessed at.
 */
export function parseCacheRow(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: SKIP_REASONS.notAnObject };

  const row = raw;
  const hasAnyValue = RESUME_CACHE_HEADERS.some((header) => {
    const value = row[header];
    return value !== null && value !== undefined && String(value).trim() !== '';
  });
  if (!hasAnyValue) return { ok: false, reason: SKIP_REASONS.blankRow };

  const resumeId = typeof row.resumeId === 'string' ? row.resumeId.trim() : '';
  if (!resumeId) return { ok: false, reason: SKIP_REASONS.missingResumeId };

  const schemaVersion = toSchemaVersion(row.schemaVersion);
  if (schemaVersion < RESUME_CACHE_SCHEMA_VERSION) {
    return { ok: false, reason: SKIP_REASONS.schemaTooOld, resumeId };
  }

  const driveFileName = typeof row.driveFileName === 'string' ? row.driveFileName.trim() : '';

  // A label is required for the list to be usable. Falling back to the file name is
  // derived from real data rather than invented, unlike guessing a role from the text.
  const labelFromCell = typeof row.resumeLabel === 'string' ? row.resumeLabel.trim() : '';
  const labelFromFile = driveFileName.replace(/\.pdf$/i, '').trim();
  const resumeLabel = labelFromCell || labelFromFile;
  if (!resumeLabel) return { ok: false, reason: SKIP_REASONS.noUsableLabel, resumeId };

  return {
    ok: true,
    record: {
      resumeId,
      resumeLabel,
      targetRole: typeof row.targetRole === 'string' && row.targetRole.trim() ? row.targetRole.trim() : null,
      targetRoleFamily:
        typeof row.targetRoleFamily === 'string' && row.targetRoleFamily.trim() ? row.targetRoleFamily.trim() : null,
      version: toVersion(row.version),
      isDefault: toBoolean(row.isDefault),
      keywords: parseKeywords(row.keywords),
      // Server-only from here down.
      driveFileId: typeof row.driveFileId === 'string' ? row.driveFileId.trim() : '',
      driveFileName,
      extractedText: typeof row.extractedText === 'string' ? row.extractedText : '',
      contentHash: typeof row.contentHash === 'string' ? row.contentHash.trim() : '',
      updatedAt: toIsoOrNull(row.updatedAt),
      lastUsedAt: toIsoOrNull(row.lastUsedAt),
      schemaVersion,
    },
  };
}

/**
 * Parses every row of a Sheet range into records, collecting skip reasons alongside them.
 *
 * Skip counts are returned rather than thrown: one bad row in a hand-maintained cache must
 * not take down the whole list, but it must still be visible to the operator.
 */
export function parseCacheRows(rows) {
  const records = [];
  const skipped = {};
  for (const raw of Array.isArray(rows) ? rows : []) {
    const result = parseCacheRow(raw);
    if (result.ok) {
      records.push(result.record);
      continue;
    }
    skipped[result.reason] = (skipped[result.reason] || 0) + 1;
  }
  return { records, skipped };
}

/**
 * Builds the exact object sent to the mobile app.
 *
 * Every field is listed explicitly. There is deliberately no spread of the cached record,
 * no `delete` of private keys after the fact, and no generic serializer: those patterns all
 * fail the moment someone adds a column. Adding a server-only column here is impossible to
 * leak by accident, and adding one to `RESUME_SUMMARY_HEADERS` is the only way to publish it.
 */
export const RESUME_SUMMARY_HEADERS = [
  'resumeId',
  'resumeLabel',
  'targetRole',
  'targetRoleFamily',
  'version',
  'isDefault',
  'keywords',
  'updatedAt',
  'lastUsedAt',
];

export function projectPublicResume(record) {
  const summary = {
    resumeId: record.resumeId,
    resumeLabel: record.resumeLabel,
    targetRole: record.targetRole ?? null,
    targetRoleFamily: record.targetRoleFamily ?? null,
    version: record.version,
    isDefault: record.isDefault,
    keywords: parseKeywords(record.keywords),
    updatedAt: record.updatedAt ?? null,
    lastUsedAt: record.lastUsedAt ?? null,
  };
  summary.schemaVersion = RESUME_SUMMARY_SCHEMA_VERSION;
  return summary;
}

/** Projects a list, preserving input order. */
export function projectPublicResumes(records) {
  return (Array.isArray(records) ? records : []).map(projectPublicResume);
}

/**
 * Splits a Sheets range into the header row and body rows.
 *
 * Columns are located by header name rather than position, so a column inserted for
 * human convenience does not silently shift every value into the wrong field.
 */
export function splitHeaderAndRows(values) {
  const grid = Array.isArray(values) ? values : [];
  if (grid.length === 0) return { headers: [], rows: [] };

  const [headerRow, ...bodyRows] = grid;
  const headers = (Array.isArray(headerRow) ? headerRow : []).map((cell) => String(cell ?? '').trim());

  const rows = bodyRows
    .filter((row) => Array.isArray(row) && row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== ''))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));

  return { headers, rows };
}

/** Converts records back into a header-aligned 2D array for writing to the Sheet. */
export function toSheetValues(records) {
  return records.map((record) =>
    RESUME_CACHE_HEADERS.map((header) => {
      if (header === 'keywords') return serializeKeywords(record.keywords);
      return record[header] ?? '';
    }),
  );
}
