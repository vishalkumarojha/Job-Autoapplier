#!/usr/bin/env node
/**
 * Populates the Resume Library cache from a Google Drive folder.
 *
 *   node scripts/sync-resume-library.js                # report only, change nothing
 *   node scripts/sync-resume-library.js --write        # apply changes to the sheet
 *   node scripts/sync-resume-library.js --write --dry-run
 *
 * Dry-run is the default on purpose. This script writes to a spreadsheet a person also edits
 * by hand, so an accidental invocation must never overwrite curated metadata.
 *
 * The merge decisions live in `lib/resume-sync.js` so they can be tested without Google
 * credentials; this file is only the CLI that wires real clients and does the writing.
 *
 * What it will not do:
 *   - Infer target role, role family, version, or default flag from the PDF text. A resume
 *     rarely states its own role family, and a wrong guess silently biases every later
 *     suggestion. Those columns are reported as empty for a human to fill in.
 *   - Delete cache rows for files that disappeared from Drive. A row is what keeps an existing
 *     `selectedResumeId` resolvable.
 *   - Crawl on a schedule. Drive polling costs quota and is unnecessary for a personal library;
 *     run this by hand or from an external scheduler when wanted.
 *
 * PDF bytes, extracted text, and credentials stay on the server.
 */

import { ConfigError, resumeLibraryConfig } from '../lib/config.js';
import { downloadFile, driveClient, ensureResumeTab, listResumePdfs, sheetsClient, fetchResumeRows } from '../lib/google.js';
import { planSync } from '../lib/resume-sync.js';
import {
  RESUME_CACHE_HEADERS,
  normalizeExtractedText,
  parseCacheRows,
  splitHeaderAndRows,
  toSheetValues,
} from '../lib/resume-cache.js';

function parseArgs(argv) {
  return { write: argv.includes('--write'), dryRun: argv.includes('--dry-run') };
}

/** Extracts plain text from a PDF buffer. Never throws; an unreadable PDF reports failure. */
async function extractText(buffer) {
  // Imported lazily so a metadata-only run does not pay for the parser.
  const { default: pdfParse } = await import('pdf-parse');
  try {
    const parsed = await pdfParse(buffer);
    return { text: normalizeExtractedText(parsed.text) };
  } catch (error) {
    return { failed: true, text: '', reason: error instanceof Error ? error.message : String(error) };
  }
}

async function readExistingCache(config, deps) {
  const values = await fetchResumeRows(config, deps);
  const { rows } = splitHeaderAndRows(values);
  const { records, skipped } = parseCacheRows(rows);
  return { records, skipped, headerPresent: values.length > 0 };
}

/** Rewrites the data region, leaving the header row and any other tab untouched. */
async function writeCache(config, records, deps, headerPresent) {
  const sheets = deps.sheets ?? sheetsClient(config);
  const tab = `'${config.resumeSheetTab}'`;

  // Clearing first keeps stale trailing rows from surviving when rows shrink.
  await sheets.spreadsheets.values.clear({ spreadsheetId: config.resumeSheetId, range: `${tab}!A2:Z` });

  const values = toSheetValues(records);
  if (values.length === 0) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.resumeSheetId,
    range: headerPresent ? `${tab}!A2` : `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: headerPresent ? values : [RESUME_CACHE_HEADERS, ...values] },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nowIso = new Date().toISOString();

  let config;
  try {
    config = resumeLibraryConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('Cannot run the resume sync. Missing server configuration:');
      for (const name of error.missing) console.error(`  - ${name}`);
      console.error('\nSee jobemailer/.env.example for what each variable expects.');
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const deps = { drive: driveClient(config), sheets: sheetsClient(config) };
  const files = await listResumePdfs(config, deps);
  const cache = await readExistingCache(config, deps);

  console.log(`Drive folder:  ${config.resumeFolderId}`);
  console.log(`Sheet:         ${config.resumeSheetId} / tab "${config.resumeSheetTab}"`);
  console.log(`PDFs found:    ${files.length}`);
  console.log(`Cached rows:   ${cache.records.length}`);
  if (Object.keys(cache.skipped).length) {
    console.log(`Rows skipped:  ${JSON.stringify(cache.skipped)}`);
  }

  const plan = await planSync(files, cache.records, {
    download: (fileId) => downloadFile(deps.drive, fileId),
    extractText,
  }, nowIso);

  console.log('');
  for (const { record, action, notes } of plan.results) {
    console.log(`  [${action.padEnd(9)}] ${record.resumeId}  ${record.driveFileName}`);
    console.log(`              label="${record.resumeLabel}" version=${record.version} default=${record.isDefault}`);
    console.log(`              text=${record.extractedText.length} chars keywords=${record.keywords.length}`);
    for (const note of notes) console.log(`              note: ${note}`);
  }
  for (const record of plan.orphans) {
    console.log(`  [orphan   ] ${record.resumeId}  ${record.driveFileName}`);
    console.log('              note: not in the Drive folder; row kept so existing selections still resolve');
  }

  const willWrite = args.write && !args.dryRun;
  console.log('');
  console.log(
    willWrite
      ? `Writing ${plan.changed.length} changed row(s) and preserving ${plan.orphans.length} orphan row(s).`
      : `Dry run: ${plan.changed.length} row(s) would change. Re-run with --write to apply.`,
  );
  if (!willWrite || plan.changed.length === 0) return;

  await ensureResumeTab(config, deps);
  await writeCache(config, plan.rows, deps, cache.headerPresent);
  console.log('Done.');
}

main().catch((error) => {
  console.error('Resume sync failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
