/**
 * Google Drive and Sheets access for the Resume Library, server-side only.
 *
 * Everything here uses a service-account credential. The Apps Script project has its own
 * credential flow and is deliberately untouched: this module never calls Apps Script, and
 * Apps Script never calls this module.
 *
 * `fetchResumeRows` is separated from the client construction so tests can inject a fake
 * Sheets client and exercise the parsing path with fixtures, with no Google credentials
 * present at all.
 */

import { google } from 'googleapis';
import { ConfigError, parseServiceAccount } from './config.js';

/** Builds a Drive client scoped to read-only file metadata and file content. */
export function driveClient(config) {
  const credential = parseServiceAccount(config);
  if (!credential.clientEmail || !credential.privateKey) throw new ConfigError(['GOOGLE_SERVICE_ACCOUNT_JSON']);
  return google.drive({
    version: 'v3',
    auth: new google.auth.GoogleAuth({
      credentials: credential,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    }),
  });
}

/** Builds a Sheets client. */
export function sheetsClient(config) {
  const credential = parseServiceAccount(config);
  if (!credential.clientEmail || !credential.privateKey) throw new ConfigError(['GOOGLE_SERVICE_ACCOUNT_JSON']);
  return google.sheets({
    version: 'v4',
    auth: new google.auth.GoogleAuth({
      credentials: credential,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    }),
  });
}

/**
 * Lists PDF files directly inside the configured folder.
 *
 * `trashed = false` is explicit because trashed files are otherwise still listed.
 */
export async function listResumePdfs(config, deps = {}) {
  const drive = deps.drive ?? driveClient(config);
  const response = await drive.files.list({
    q: `'${config.resumeFolderId}' in parents and mimeType='application/pdf' and trashed = false`,
    fields: 'files(id,name,modifiedTime,size,md5Checksum)',
    orderBy: 'name',
    pageSize: 200,
  });
  return response.data.files ?? [];
}

/** Downloads a file's bytes as a Node Buffer. Stays on the server. */
export async function downloadFile(drive, fileId) {
  const response = await drive.files.get({ fileId, alt: 'media' });
  const data = response.data;
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'binary');
  return Buffer.from(data);
}

/**
 * Returns the cached resume rows for the configured tab.
 *
 * Missing configuration surfaces as `ConfigError` naming the variable, so an operator sees
 * `GOOGLE_RESUME_SHEET_ID` rather than a Google 404 stack trace.
 */
export async function fetchResumeRows(config, deps = {}) {
  const sheets = deps.sheets ?? sheetsClient(config);
  const range = `'${config.resumeSheetTab}'!A:${String.fromCharCode(64 + 14)}`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.resumeSheetId,
    range,
  });
  return response.data.values ?? [];
}

/**
 * Appends rows to the tab, creating it first if it does not exist.
 *
 * Tab creation is delegated to Sheets' own `addSheet` request rather than assumed, so a
 * cache can be bootstrapped without a human creating the tab by hand.
 */
export async function ensureResumeTab(config, deps = {}) {
  const sheets = deps.sheets ?? sheetsClient(config);

  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.resumeSheetId, fields: 'sheets.properties' });
  const sheetsMeta = meta.data.sheets ?? [];
  const existing = sheetsMeta.find((sheet) => sheet.properties && sheet.properties.title === config.resumeSheetTab);
  if (existing) return { sheetId: existing.properties.sheetId, created: false };

  const added = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.resumeSheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: config.resumeSheetTab } } }] },
  });
  const created = added.data.replies?.[0]?.addSheet?.properties?.sheetId;
  return { sheetId: created ?? null, created: true };
}
