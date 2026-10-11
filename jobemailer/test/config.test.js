/**
 * Tests for server configuration.
 *
 * Every function here takes `env` as a parameter rather than reading `process.env` on the
 * fly, which is what makes these cases possible at all: they run against plain objects, so
 * a deployment's real variables are never needed to assert which names are required.
 *
 * The case that matters most is `intakeConfig` rejecting a setup that has credentials but
 * no `ANTHROPIC_API_KEY`, while *not* asking for the Drive and Sheets variables. That
 * separation is the reason `firebaseCredentialConfig` exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfigError,
  firebaseCredentialConfig,
  intakeConfig,
  parseServiceAccount,
  resumeLibraryConfig,
  reminderConfig,
  sendConfig,
} from '../lib/config.js';

const CREDENTIALS = {
  FIREBASE_ADMIN_PROJECT_ID: 'proj-123',
  FIREBASE_ADMIN_CLIENT_EMAIL: 'svc@proj-123.iam.gserviceaccount.com',
  FIREBASE_ADMIN_PRIVATE_KEY: '-----BEGIN KEY-----\\nabc\\n-----END KEY-----',
};

const RESUME_LIBRARY = {
  ...CREDENTIALS,
  GOOGLE_RESUME_FOLDER_ID: 'folder-1',
  GOOGLE_RESUME_SHEET_ID: 'sheet-1',
};

test('reminder configuration requires cron authentication and binds Telegram to one Firebase UID', () => {
  assert.throws(() => reminderConfig(CREDENTIALS), (error) => error instanceof ConfigError && error.message.includes('CRON_SECRET'));
  assert.throws(() => reminderConfig({ ...CREDENTIALS, CRON_SECRET: 'cron' , TELEGRAM_BOT_TOKEN: 'bot' }), (error) => error instanceof ConfigError && error.message.includes('TELEGRAM_USER_UID'));
  const config = reminderConfig({ ...CREDENTIALS, CRON_SECRET: 'cron', TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: 'chat', TELEGRAM_USER_UID: 'user-1' });
  assert.equal(config.telegramUserUid, 'user-1');
});

function withKey(extra = {}) {
  return { ...CREDENTIALS, ANTHROPIC_API_KEY: 'test-key', ...extra };
}

// ─── firebaseCredentialConfig ──────────────────────────────────────────────────

test('accepts a single JSON credential in place of the three split fields', () => {
  const config = firebaseCredentialConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"project_id":"p"}' });
  assert.equal(config.serviceAccountJson, '{"project_id":"p"}');
  assert.equal(config.projectId, null);
});

test('accepts the split fields, unescaping escaped newlines in the private key', () => {
  const config = firebaseCredentialConfig(CREDENTIALS);
  assert.equal(config.projectId, 'proj-123');
  assert.equal(config.clientEmail, 'svc@proj-123.iam.gserviceaccount.com');
  assert.equal(config.privateKey.includes('\n'), true);
  assert.equal(config.privateKey.includes('\\n'), false);
});

test('names only the variables when no credential is present', () => {
  assert.throws(
    () => firebaseCredentialConfig({}),
    (error) => {
      assert.equal(error instanceof ConfigError, true);
      assert.equal(error.missing.length, 1);
      assert.ok(error.missing[0].includes('GOOGLE_SERVICE_ACCOUNT_JSON'));
      assert.equal(error.message.includes('proj-123'), false);
      return true;
    },
  );
});

test('sendConfig composes server-only Apps Script settings with Firebase and resume config', () => {
  const config = sendConfig({
    ...RESUME_LIBRARY,
    APPS_SCRIPT_URL: 'https://script.example/exec',
    APPS_SCRIPT_TOKEN: 'secret-server-token',
  });
  assert.equal(config.appsScriptUrl, 'https://script.example/exec');
  assert.equal(config.appsScriptToken, 'secret-server-token');
  assert.equal(config.anthropicApiKey, undefined);
});

test('sendConfig reports absent bridge variables by name and never their values', () => {
  assert.throws(() => sendConfig(RESUME_LIBRARY), (error) => {
    assert.deepEqual(error.missing, ['APPS_SCRIPT_URL', 'APPS_SCRIPT_TOKEN']);
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
});

test('treats whitespace-only values as absent', () => {
  assert.throws(() => firebaseCredentialConfig({ FIREBASE_ADMIN_PROJECT_ID: '   ' }), ConfigError);
});

// ─── intakeConfig ──────────────────────────────────────────────────────────────

test('needs credentials and the model key, and nothing else', () => {
  const config = intakeConfig(withKey());
  assert.equal(config.anthropicApiKey, 'test-key');
  assert.equal(config.projectId, 'proj-123');
  // Deliberately absent: Smart Intake never reads Drive or Sheets, so requiring their
  // variables here would make the feature fail on a deployment that has no resume cache.
  assert.equal(config.resumeFolderId, undefined);
  assert.equal(config.resumeSheetId, undefined);
});

test('leaves the model unset so the default in lib/claude.js applies', () => {
  assert.equal(intakeConfig(withKey()).anthropicModel, null);
  assert.equal(intakeConfig(withKey({ ANTHROPIC_MODEL: 'claude-custom' })).anthropicModel, 'claude-custom');
});

test('reports a missing model key even when credentials are complete', () => {
  assert.throws(
    () => intakeConfig(CREDENTIALS),
    (error) => {
      assert.equal(error instanceof ConfigError, true);
      assert.deepEqual(error.missing, ['ANTHROPIC_API_KEY']);
      return true;
    },
  );
});

test('reports credentials and the model key together rather than one deploy at a time', () => {
  assert.throws(
    () => intakeConfig({}),
    (error) => {
      assert.equal(error instanceof ConfigError, true);
      assert.equal(error.missing.includes('ANTHROPIC_API_KEY'), true);
      assert.equal(error.missing.length, 2);
      return true;
    },
  );
});

test('never puts the model key into the error message', () => {
  try {
    intakeConfig(withKey({ ANTHROPIC_API_KEY: '   ' }));
    assert.fail('expected a throw');
  } catch (error) {
    assert.equal(error.message.includes('test-key'), false);
    assert.equal(error.message.includes('ANTHROPIC_MODEL'), false);
  }
});

// ─── resumeLibraryConfig ───────────────────────────────────────────────────────

test('still requires the Drive folder and the Sheet, and lists them all at once', () => {
  const config = resumeLibraryConfig(RESUME_LIBRARY);
  assert.equal(config.resumeFolderId, 'folder-1');
  assert.equal(config.resumeSheetId, 'sheet-1');
  assert.equal(config.resumeSheetTab, 'Resumes');

  assert.throws(
    () => resumeLibraryConfig(CREDENTIALS),
    (error) => {
      assert.equal(error instanceof ConfigError, true);
      assert.equal(error.missing.includes('GOOGLE_RESUME_FOLDER_ID'), true);
      assert.equal(error.missing.includes('GOOGLE_RESUME_SHEET_ID'), true);
      assert.equal(error.missing.includes('ANTHROPIC_API_KEY'), false);
      return true;
    },
  );
});

test('defaults the sheet tab and honours an override', () => {
  assert.equal(resumeLibraryConfig(RESUME_LIBRARY).resumeSheetTab, 'Resumes');
  assert.equal(
    resumeLibraryConfig({ ...RESUME_LIBRARY, GOOGLE_RESUME_SHEET_TAB: 'Resumes2' }).resumeSheetTab,
    'Resumes2',
  );
});

// ─── parseServiceAccount ───────────────────────────────────────────────────────

test('accepts raw JSON, base64 JSON, or the split fields', () => {
  const json = { project_id: 'p', client_email: 'e@x.iam.gserviceaccount.com', private_key: 'KEY' };

  const raw = parseServiceAccount({ serviceAccountJson: JSON.stringify(json) });
  assert.equal(raw.projectId, 'p');
  assert.equal(raw.clientEmail, 'e@x.iam.gserviceaccount.com');

  const encoded = Buffer.from(JSON.stringify(json), 'utf8').toString('base64');
  assert.deepEqual(parseServiceAccount({ serviceAccountJson: encoded }), raw);

  const split = parseServiceAccount({ projectId: 'p2', clientEmail: 'e2', privateKey: 'k2' });
  assert.equal(split.projectId, 'p2');
  assert.equal(split.privateKey, 'k2');
});

test('unescapes escaped newlines inside an embedded private key', () => {
  const json = { project_id: 'p', client_email: 'e@x', private_key: '-----\\nline\\n-----' };
  const parsed = parseServiceAccount({ serviceAccountJson: JSON.stringify(json) });
  assert.equal(parsed.privateKey, '-----\nline\n-----');
});
