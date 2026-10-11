/**
 * Server-only configuration for the Vercel backend.
 *
 * Covers every authenticated route: `GET /api/resumes`, `POST /api/intake`,
 * `POST /api/match`, and the scripts under `scripts/`. Every value here comes from the
 * environment. Nothing in this file, and nothing it returns, may ever reach the mobile
 * app: it holds service-account material and a third-party model key.
 *
 * `loadEnvFile` is attempted but never required, so local `node scripts/...` runs behave
 * like the deployed Vercel functions (which inject real environment variables).
 */

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file. Expected on Vercel, where variables are configured per deployment.
}

/**
 * Thrown when required configuration is absent. Carries names only, never values.
 *
 * This repository is plain ESM JavaScript with no build step, so types are expressed with
 * JSDoc rather than class fields, which plain Node cannot parse.
 */
export class ConfigError extends Error {
  /** @param {string[]} missing */
  constructor(missing) {
    super(`Missing or unusable server configuration: ${missing.join(', ')}`);
    this.name = 'ConfigError';
    /** @type {string[]} */
    this.missing = missing;
  }
}

function read(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The credential variables shared by every endpoint that verifies a Firebase ID token. */
const CREDENTIAL_HELP =
  'GOOGLE_SERVICE_ACCOUNT_JSON (or FIREBASE_ADMIN_PROJECT_ID + FIREBASE_ADMIN_CLIENT_EMAIL + FIREBASE_ADMIN_PRIVATE_KEY)';

/**
 * Reads the Firebase Admin credential fields, without deciding whether they are complete.
 *
 * Split out so the three configuration functions below agree on exactly which variables
 * constitute a credential instead of each re-reading them.
 */
function credentialFields(env) {
  const privateKeyRaw = read(env, 'FIREBASE_ADMIN_PRIVATE_KEY');
  return {
    projectId: read(env, 'FIREBASE_ADMIN_PROJECT_ID'),
    clientEmail: read(env, 'FIREBASE_ADMIN_CLIENT_EMAIL'),
    // Private keys are usually stored with escaped newlines, because a literal newline
    // cannot survive most copy/paste paths into an environment variable.
    privateKey: privateKeyRaw ? privateKeyRaw.replace(/\\n/g, '\n') : null,
    serviceAccountJson: read(env, 'GOOGLE_SERVICE_ACCOUNT_JSON'),
    hasSplitFields: Boolean(read(env, 'FIREBASE_ADMIN_PROJECT_ID') || read(env, 'FIREBASE_ADMIN_CLIENT_EMAIL') || privateKeyRaw),
  };
}

/**
 * Returns just the Firebase Admin credential, for endpoints that verify tokens but read no
 * Google data.
 *
 * `POST /api/intake` is the reason this exists: it must verify an ID token before it reads
 * anything else, and coupling that to `resumeLibraryConfig()` would make Smart Intake
 * depend on the Drive and Sheets variables it never uses.
 *
 * Either a single JSON credential, or the three split fields. Not both required.
 */
export function firebaseCredentialConfig(env = process.env) {
  const fields = credentialFields(env);
  const present = Boolean(fields.serviceAccountJson) || fields.hasSplitFields;
  if (!present) throw new ConfigError([CREDENTIAL_HELP]);
  return {
    projectId: fields.projectId,
    clientEmail: fields.clientEmail,
    privateKey: fields.privateKey,
    serviceAccountJson: fields.serviceAccountJson,
  };
}

/**
 * Returns the server-side Smart Intake configuration: the credential needed to verify the
 * caller, plus the Anthropic key needed to perform the extraction.
 *
 * `ANTHROPIC_API_KEY` is server-only. It must never be reachable from `PassX-Easeout`, and
 * nothing returned by this function is echoed in a response body.
 *
 * Reads from `env` rather than mutating `process.env`, which keeps it pure and testable.
 */
export function intakeConfig(env = process.env) {
  const missing = [];

  let credential;
  try {
    credential = firebaseCredentialConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // Accumulated rather than rethrown, so a first deploy with nothing set reports both
    // problems at once instead of one variable per attempt.
    missing.push(...error.missing);
  }

  const anthropicApiKey = read(env, 'ANTHROPIC_API_KEY');
  if (!anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) throw new ConfigError(missing);

  return {
    ...credential,
    anthropicApiKey,
    // Left null when unset: the default model is owned by `DEFAULT_ANTHROPIC_MODEL` in
    // `lib/claude.js`, so the magic string exists in exactly one place.
    anthropicModel: read(env, 'ANTHROPIC_MODEL'),
  };
}

/**
 * Returns the Resume Library configuration, or throws `ConfigError` listing every missing
 * variable at once so setup does not have to be iterated one variable per deploy.
 *
 * Reads from `env` rather than mutating `process.env`, which keeps it pure and testable.
 */
export function resumeLibraryConfig(env = process.env) {
  const missing = [];
  const pick = (name) => {
    const value = read(env, name);
    if (!value) missing.push(name);
    return value;
  };

  const credential = credentialFields(env);
  const present = Boolean(credential.serviceAccountJson) || credential.hasSplitFields;
  if (!present) missing.push(CREDENTIAL_HELP);

  const config = {
    projectId: credential.projectId,
    clientEmail: credential.clientEmail,
    privateKey: credential.privateKey,
    serviceAccountJson: credential.serviceAccountJson,
    resumeFolderId: pick('GOOGLE_RESUME_FOLDER_ID'),
    resumeSheetId: pick('GOOGLE_RESUME_SHEET_ID'),
    resumeSheetTab: read(env, 'GOOGLE_RESUME_SHEET_TAB') || 'Resumes',
  };

  if (missing.length) throw new ConfigError(missing);
  return config;
}

/**
 * Returns the Resume Matching configuration: everything `POST /api/match` touches — the
 * credential that verifies the caller and opens Firestore, the Anthropic key that runs the
 * comparison, and the Sheet that holds the Resume Library.
 *
 * Built by composing `intakeConfig` and `resumeLibraryConfig` rather than re-reading
 * variables, so there is exactly one definition of what "the Anthropic key" and what "the
 * Sheets credential" are. Missing variables from both halves are collected and reported
 * together.
 *
 * Reads from `env` rather than mutating `process.env`, which keeps it pure and testable.
 */
export function matchConfig(env = process.env) {
  const missing = [];
  const attempt = (load) => {
    try {
      return load();
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      missing.push(...error.missing);
      return null;
    }
  };

  const intake = attempt(() => intakeConfig(env));
  const library = attempt(() => resumeLibraryConfig(env));
  if (missing.length) throw new ConfigError([...new Set(missing)]);

  // `library` is spread last so a credential expressed two different ways resolves the
  // same way here as it does in `GET /api/resumes`.
  return { ...intake, ...library };
}

/** Server-only Apps Script bridge configuration for POST /api/send. */
export function sendConfig(env = process.env) {
  const base = resumeLibraryConfig(env);
  const appsScriptUrl = read(env, 'APPS_SCRIPT_URL');
  const appsScriptToken = read(env, 'APPS_SCRIPT_TOKEN');
  const missing = [];
  if (!appsScriptUrl) missing.push('APPS_SCRIPT_URL');
  if (!appsScriptToken) missing.push('APPS_SCRIPT_TOKEN');
  if (missing.length) throw new ConfigError(missing);
  return { ...base, appsScriptUrl, appsScriptToken };
}

/** Server-only optional delivery configuration for reminders. */
export function reminderConfig(env = process.env) {
  const firebase = firebaseCredentialConfig(env);
  const missing = [];
  const cronSecret = read(env, 'CRON_SECRET');
  if (!cronSecret) missing.push('CRON_SECRET');
  const telegramBotToken = read(env, 'TELEGRAM_BOT_TOKEN');
  const telegramChatId = read(env, 'TELEGRAM_CHAT_ID');
  const telegramUserUid = read(env, 'TELEGRAM_USER_UID');
  const telegramFieldsConfigured = [telegramBotToken, telegramChatId, telegramUserUid].filter(Boolean).length;
  if (telegramFieldsConfigured !== 0 && telegramFieldsConfigured !== 3) missing.push('TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID + TELEGRAM_USER_UID');
  if (missing.length) throw new ConfigError(missing);
  return {
    ...firebase,
    cronSecret,
    telegramBotToken,
    telegramChatId,
    telegramUserUid,
  };
}

/**
 * Normalizes a service-account credential into the shape both `firebase-admin` and
 * `googleapis` accept.
 *
 * The JSON blob is accepted raw or base64-encoded, because multiline JSON in an
 * environment variable is awkward while base64 round-trips reliably.
 */
export function parseServiceAccount(config) {
  if (config.serviceAccountJson) {
    const raw = config.serviceAccountJson;
    const json = (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      }
    })();
    return {
      projectId: json.project_id,
      clientEmail: json.client_email,
      privateKey: String(json.private_key || '').replace(/\\n/g, '\n'),
    };
  }
  return {
    projectId: config.projectId,
    clientEmail: config.clientEmail,
    privateKey: config.privateKey,
  };
}
