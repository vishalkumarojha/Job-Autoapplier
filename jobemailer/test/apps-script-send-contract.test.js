import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const CODE = await readFile(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

function scriptHarness(options = {}) {
  const captures = { drafts: [], templateCalls: 0, sentCount: 0, properties: new Map() };
  const header = Array(15).fill('');
  const rows = [header];
  const sheet = {
    getLastRow: () => rows.length,
    appendRow(row) { rows.push([...row]); },
    getDataRange() { return { getDisplayValues: () => rows.map((row) => row.map((cell) => String(cell ?? ''))) }; },
    getRange(rowIndex, column, rowCount, columnCount) {
      if (rowCount !== undefined && columnCount !== undefined) {
        return { getValues: () => rows.slice(rowIndex - 1, rowIndex - 1 + rowCount).map((row) => row.slice(column - 1, column - 1 + columnCount)) };
      }
      return {
        setValue(value) { if (rows[rowIndex - 1]) rows[rowIndex - 1][column - 1] = value; return this; },
        setNumberFormat() { return this; }, setBackground() { return this; }, setFontColor() { return this; },
      };
    },
  };
  const context = vm.createContext({
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }), flush() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => key === 'DASHBOARD_API_TOKEN' ? 'test-script-token' : captures.properties.get(key) ?? null,
      setProperty: (key, value) => captures.properties.set(key, value),
    }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput(text) { return { text, setMimeType() { return this; } }; } },
    MailApp: { getRemainingDailyQuota: () => 100 },
    Utilities: { formatDate: () => '2026-10-06' },
    Session: { getScriptTimeZone: () => 'Asia/Kolkata', getActiveUser: () => ({ getEmail: () => 'sender@example.test' }) },
    DriveApp: { getFileById: (id) => {
      if (id === options.unavailableFileId) throw new Error('private Drive lookup failure');
      return { getBlob: () => ({ id }) };
    } },
    HtmlService: { createTemplateFromFile: () => {
      captures.templateCalls++;
      return { evaluate: () => ({ getContent: () => '<p>Legacy template body</p>' }) };
    } },
    GmailApp: { createDraft: (...args) => {
      captures.drafts.push(args);
      return { send: () => {
        captures.sentCount++;
        return { getThread: () => ({ getId: () => 'gmail-thread-1' }) };
      } };
    } },
    Logger: { log() {} },
  });
  vm.runInContext(CODE, context, { filename: 'Code.gs' });
  return { context, captures, rows };
}

function postSend(context, data) {
  const result = context.doPost({ postData: { contents: JSON.stringify({
    token: 'test-script-token', action: 'send', data,
  }) } });
  return JSON.parse(result.text);
}

const DATA = {
  company: 'Example Corp', contactName: 'Recruiter', contactEmail: 'recruiter@example.test',
  role: 'Engineer', jobLink: 'https://example.test/job', source: 'Referral', location: 'Remote', notes: '',
};

test('legacy dashboard send with no approved fields retains the existing template behavior', () => {
  const { context, captures, rows } = scriptHarness();
  context.RESUME_FILE_ID = 'legacy-resume-file';
  const response = postSend(context, DATA);
  assert.equal(response.ok, true);
  assert.equal(captures.templateCalls, 1);
  assert.equal(captures.drafts[0][1], 'Application — Engineer | Vishal Kumar Ojha');
  assert.equal(captures.drafts[0][2], 'Legacy template body');
  assert.ok(captures.drafts[0][3].htmlBody);
  assert.equal(captures.drafts[0][3].attachments[0].id, 'legacy-resume-file');
  assert.equal(rows[1][10], 'Sent');
  assert.equal(rows[1][14], 'gmail-thread-1');
});

test('approved send delivers the exact subject/body and selected resume attachment', () => {
  const { context, captures, rows } = scriptHarness();
  context.RESUME_FILE_ID = 'legacy-resume-file';
  const approvedSubject = '  Approved Subject ✓  ';
  const approvedMessage = 'Hello Recruiter,\n\nExact reviewed text.\n';
  const response = postSend(context, {
    ...DATA, approvedSubject, approvedMessage, approvedResumeFileId: 'selected-resume-file',
  });
  assert.equal(response.ok, true);
  assert.equal(captures.templateCalls, 0);
  assert.equal(captures.drafts[0][1], approvedSubject);
  assert.equal(captures.drafts[0][2], approvedMessage);
  assert.equal(captures.drafts[0][3].htmlBody, undefined);
  assert.equal(captures.drafts[0][3].attachments.length, 1);
  assert.equal(captures.drafts[0][3].attachments[0].id, 'selected-resume-file');
  assert.equal(rows[1][10], 'Sent');
  assert.equal(rows[1][14], 'gmail-thread-1');
});

test('invalid approved resume fails closed without falling back to the legacy configured resume', () => {
  const { context, captures, rows } = scriptHarness();
  context.RESUME_FILE_ID = 'legacy-resume-file';
  const response = postSend(context, {
    ...DATA, approvedSubject: 'Approved Subject', approvedMessage: 'Approved body', approvedResumeFileId: '',
  });
  assert.equal(response.ok, true); // Existing Apps Script envelope; Sheet status carries the outcome.
  assert.equal(captures.drafts.length, 0);
  assert.equal(rows[1][10], 'Failed: approved resume unavailable');
});

test('unavailable approved resume fails closed without exposing Drive errors or using the legacy resume', () => {
  const { context, captures, rows } = scriptHarness({ unavailableFileId: 'deleted-selected-resume' });
  context.RESUME_FILE_ID = 'legacy-resume-file';
  const response = postSend(context, {
    ...DATA, approvedSubject: 'Approved Subject', approvedMessage: 'Approved body',
    approvedResumeFileId: 'deleted-selected-resume',
  });
  assert.equal(response.ok, true);
  assert.equal(captures.drafts.length, 0);
  assert.equal(rows[1][10], 'Failed: approved resume unavailable');
  assert.equal(rows[1][10].includes('private Drive'), false);
});

test('partial approved content fails closed without calling Gmail', () => {
  const { context, captures, rows } = scriptHarness();
  const response = postSend(context, { ...DATA, approvedSubject: 'Subject only' });
  assert.equal(response.ok, true); // Existing Apps Script envelope; Sheet status carries the outcome.
  assert.equal(captures.drafts.length, 0);
  assert.match(rows[1][10], /^Failed:/);
});
