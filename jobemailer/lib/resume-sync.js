/**
 * Drive -> Resume Library cache merge logic.
 *
 * Kept separate from `scripts/sync-resume-library.js` so it can be tested with fixtures and
 * no Google credentials: the script is the CLI that wires real clients, this module is the
 * decision-making that decides what a row should become.
 *
 * Every side effect arrives as an injected dependency (`download`, `extractText`), so the
 * whole merge runs offline in tests.
 */

import {
  MANUALLY_MAINTAINED_HEADERS,
  RESUME_CACHE_SCHEMA_VERSION,
  computeContentHash,
  deriveResumeId,
  parseKeywords,
} from './resume-cache.js';

/**
 * Decides whether a Drive file needs its text re-extracted.
 *
 * Drive's `modifiedTime` is the cheap signal: when it matches the cached `updatedAt`, nothing
 * was re-uploaded, so no download and no parse.
 *
 * Drive also returns `md5Checksum`, which is not usable here: the cached `contentHash` is a
 * hash of the *extracted text*, not of the file bytes, so the two can never be compared. Using
 * it would mean either re-downloading every file to check, or storing a second hash column for
 * a marginal gain.
 */
function needsRefresh(file, prior) {
  if (!prior) return true;
  if (!file.modifiedTime || !prior.updatedAt) return true;
  return new Date(file.modifiedTime).getTime() !== new Date(prior.updatedAt).getTime();
}

/**
 * Merges one Drive file into its cache row.
 *
 * Manually maintained fields (label, target role, role family, version, default flag,
 * keywords) are carried over from an existing row and never derived from the PDF. A new row
 * leaves them empty and reports them, because a resume does not reliably state its own role
 * family and an invented value would silently bias every later suggestion.
 *
 * @returns {{record: object, action: 'added'|'updated'|'unchanged', notes: string[], preserved: string[]}}
 */
export async function mergeFileIntoCache(file, prior, deps, nowIso) {
  const driveFileId = String(file.id ?? '');
  const resumeId = deriveResumeId(driveFileId);
  const driveFileName = file.name ?? '';
  const notes = [];

  let extractedText = prior?.extractedText ?? '';
  let contentHash = prior?.contentHash ?? '';

  if (needsRefresh(file, prior)) {
    if (deps.download && deps.extractText) {
      const buffer = await deps.download(driveFileId);
      const result = await deps.extractText(buffer);
      if (result && result.failed) {
        // Leave any previously extracted text in place rather than replacing good text with
        // nothing because one parse attempt failed.
        notes.push(`could not extract text (${result.reason}); previous text kept`);
      } else {
        extractedText = result?.text ?? '';
        contentHash = computeContentHash(extractedText);
        if (!extractedText) notes.push('no text layer found; the PDF may be a scanned image');
      }
    } else {
      extractedText = '';
      contentHash = '';
    }
  }

  const targetRole = prior?.targetRole ?? null;
  const targetRoleFamily = prior?.targetRoleFamily ?? null;

  if (!targetRole) notes.push('targetRole is empty; set it by hand');
  if (!targetRoleFamily) notes.push('targetRoleFamily is empty; set it by hand');
  if (prior && !prior.keywords?.length) notes.push('keywords are empty; set them by hand');

  const record = {
    resumeId,
    // A label derived from the file name is factual, not invented.
    resumeLabel: prior?.resumeLabel || driveFileName.replace(/\.pdf$/i, ''),
    targetRole,
    targetRoleFamily,
    version: prior?.version ?? 1,
    isDefault: prior?.isDefault ?? false,
    keywords: parseKeywords(prior?.keywords),
    driveFileId,
    driveFileName,
    extractedText,
    contentHash,
    updatedAt: file.modifiedTime ?? nowIso,
    lastUsedAt: prior?.lastUsedAt ?? null,
    schemaVersion: RESUME_CACHE_SCHEMA_VERSION,
  };

  const changed =
    !prior ||
    prior.driveFileName !== driveFileName ||
    prior.contentHash !== contentHash ||
    prior.updatedAt !== record.updatedAt ||
    prior.resumeLabel !== record.resumeLabel;

  return {
    record,
    action: changed ? (prior ? 'updated' : 'added') : 'unchanged',
    notes,
    preserved: prior ? MANUALLY_MAINTAINED_HEADERS.slice() : [],
  };
}

/**
 * Builds the full write plan for a sync run.
 *
 * Cached rows whose Drive file is absent from the folder are returned as `orphans` rather than
 * dropped: a row is what keeps an existing `selectedResumeId` resolvable, so deleting it would
 * break a selection the user already made.
 *
 * @param files Drive file listings
 * @param existingRecords records already in the cache
 * @param deps {{download?: (id: string) => Promise<Buffer>, extractText?: (buffer: Buffer) => Promise<{text: string, failed?: boolean, reason?: string}>}}
 */
export async function planSync(files, existingRecords, deps = {}, nowIso = new Date().toISOString()) {
  const byDriveFileId = new Map();
  for (const record of existingRecords ?? []) {
    if (record.driveFileId) byDriveFileId.set(record.driveFileId, record);
  }

  const results = [];
  for (const file of files ?? []) {
    results.push(await mergeFileIntoCache(file, byDriveFileId.get(String(file.id ?? '')), deps, nowIso));
  }

  const seen = new Set(results.map((entry) => entry.record.driveFileId));
  const orphans = (existingRecords ?? []).filter((record) => record.driveFileId && !seen.has(record.driveFileId));

  return {
    results,
    orphans,
    changed: results.filter((entry) => entry.action !== 'unchanged'),
    rows: [...results.map((entry) => entry.record), ...orphans],
  };
}
