/**
 * Tests for `GET /api/resumes`, focused on the authentication boundary and on proving that
 * server-private fields never reach the client.
 *
 * Runs on `node:test`. No Firebase project and no Google credentials are involved: the
 * token verifier and the Sheets client are both injected, so these cases exercise the real
 * handler and the real projection logic while contacting nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler, fakeResponse } from '../api/resumes.js';
import { readBearerToken, UnauthenticatedError } from '../lib/auth.js';
import { ConfigError } from '../lib/config.js';
import { RESUME_CACHE_HEADERS, RESUME_CACHE_SCHEMA_VERSION, RESUME_SUMMARY_SCHEMA_VERSION } from '../lib/resume-cache.js';

/** A cache row that also carries everything the server must keep to itself. */
const CACHE_ROW = {
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

const VALID_UID = 'user-1';

/** Accepts exactly one hardcoded token; everything else is treated as invalid. */
function strictVerifier(expectedToken, uid = VALID_UID) {
  return async (token) => {
    if (token !== expectedToken) {
      // Shape mirrors the real error without importing Firebase in the test process.
      const error = new Error('Firebase ID token has expired or is invalid.');
      error.code = 'auth/id-token-expired';
      throw error;
    }
    return { uid, sub: uid };
  };
}

/** Builds a Sheets double that returns one tab's values. */
function fakeSheets(values) {
  return {
    spreadsheets: {
      values: { get: async () => ({ data: { values } }) },
    },
  };
}

function tabValues(rows) {
  return [RESUME_CACHE_HEADERS, ...rows.map((row) => RESUME_CACHE_HEADERS.map((header) => row[header] ?? ''))];
}

/** Runs the handler with a valid request unless overridden. */
async function invoke(options = {}) {
  const {
    headers = { authorization: 'Bearer good-token' },
    rows = [CACHE_ROW],
    verifyIdToken = strictVerifier('good-token'),
    // Only the fields the handler actually passes through; the Google credential fields are
    // never touched because these tests inject a fake Sheets client.
    config = { resumeSheetId: 'sheet-for-tests', resumeSheetTab: 'Resumes' },
    method = 'GET',
    query,
    body,
  } = options;

  const handler = createHandler({ verifyIdToken, config, sheets: fakeSheets(tabValues(rows)) });
  const res = fakeResponse();
  await handler({ method, headers, query, body }, res);
  return res;
}

// ─── Authentication ────────────────────────────────────────────────────────────

test('a missing Authorization header is rejected with 401', async () => {
  const res = await invoke({ headers: {} });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Authentication required.');
});

test('a malformed Authorization header is rejected with 401', async () => {
  for (const authorization of [
    'good-token',
    'Bearer',
    'Bearer ',
    'Basic good-token',
    'Bearer good-token extra',
    'Bearer\t\t',
    '',
    'Bearer  good-token  extra',
  ]) {
    const res = await invoke({ headers: { authorization } });
    assert.equal(res.statusCode, 401, `"${authorization}" must be rejected`);
  }
});

test('an invalid token is rejected with 401', async () => {
  const res = await invoke({ headers: { authorization: 'Bearer forged-token' } });
  assert.equal(res.statusCode, 401);
});

test('an expired token is rejected with 401', async () => {
  // A verifier that rejects specifically the expired case, as Firebase Admin does.
  const res = await invoke({
    headers: { authorization: 'Bearer expired-token' },
    verifyIdToken: async () => {
      const error = new Error('Firebase ID token has expired.');
      error.code = 'auth/id-token-expired';
      throw error;
    },
  });
  assert.equal(res.statusCode, 401);
});

test('the 401 body does not reveal why the token failed', async () => {
  const res = await invoke({
    headers: { authorization: 'Bearer expired-token' },
    verifyIdToken: async () => {
      throw new Error('Firebase ID token has expired.');
    },
  });
  assert.equal(res.body.error, 'Authentication required.');
  assert.equal(JSON.stringify(res.body).includes('expired'), false);
});

test('the 401 body never contains the token', async () => {
  const res = await invoke({ headers: { authorization: 'Bearer super-secret-token-value' } });
  assert.equal(JSON.stringify(res.body).includes('super-secret-token-value'), false);
});

test('a valid token reaches the handler and returns the list', async () => {
  const res = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.schemaVersion, RESUME_SUMMARY_SCHEMA_VERSION);
  assert.equal(res.body.resumes.length, 1);
  assert.equal(res.body.resumes[0].resumeLabel, 'Backend — Go — v3');
});

test('the Bearer scheme is matched case-insensitively', async () => {
  for (const authorization of ['Bearer good-token', 'bearer good-token', 'BEARER good-token']) {
    const res = await invoke({ headers: { authorization } });
    assert.equal(res.statusCode, 200, `"${authorization}" must be accepted`);
  }
});

test('a capitalized header name is still read', async () => {
  const res = await invoke({ headers: { Authorization: 'Bearer good-token' } });
  assert.equal(res.statusCode, 200);
});

test('a caller-supplied uid is ignored', async () => {
  let verifiedUid = null;
  const res = await invoke({
    query: { uid: 'attacker-user' },
    body: { uid: 'attacker-user' },
    verifyIdToken: async () => {
      verifiedUid = VALID_UID;
      return { uid: VALID_UID };
    },
  });
  assert.equal(res.statusCode, 200);
  // The authenticated identity came from the token, not from the request.
  assert.equal(verifiedUid, VALID_UID);
  assert.equal(JSON.stringify(res.body).includes('attacker-user'), false);
});

test('a token whose decoded payload lacks a uid is rejected', async () => {
  const res = await invoke({ verifyIdToken: async () => ({}) });
  assert.equal(res.statusCode, 401);
});

test('a non-GET method is rejected with 405 and an Allow header', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await invoke({ method });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.Allow, 'GET');
  }
});

// ─── Projection and privacy ─────────────────────────────────────────────────────

test('the response contains only public ResumeSummary fields', async () => {
  const res = await invoke();
  const allowed = new Set([
    'resumeId',
    'resumeLabel',
    'targetRole',
    'targetRoleFamily',
    'version',
    'isDefault',
    'keywords',
    'updatedAt',
    'lastUsedAt',
    'schemaVersion',
  ]);
  for (const entry of res.body.resumes) {
    for (const key of Object.keys(entry)) {
      assert.equal(allowed.has(key), true, `unexpected field in response: ${key}`);
    }
  }
});

test('driveFileId is absent from the response', async () => {
  const res = await invoke();
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes('driveFileId'), false);
  assert.equal(serialized.includes('1DriVeFiLeIdDoNotLeak'), false);
});

test('driveFileName is absent from the response', async () => {
  const res = await invoke();
  assert.equal(JSON.stringify(res.body).includes('Vishal_Kumar_Ojha_Backend.pdf'), false);
});

test('extractedText is absent from the response', async () => {
  const res = await invoke();
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes('extractedText'), false);
  assert.equal(serialized.includes('JANE DOE'), false);
  assert.equal(serialized.includes('Kubernetes'), false);
});

test('contentHash is absent from the response', async () => {
  const res = await invoke();
  assert.equal(JSON.stringify(res.body).includes('deadbeef'), false);
});

test('the expected response shape matches the agreed contract', async () => {
  const res = await invoke();
  assert.deepEqual(res.body.resumes[0], {
    resumeId: 'rsv_abc123',
    resumeLabel: 'Backend — Go — v3',
    targetRole: 'Backend Engineer',
    targetRoleFamily: 'backend',
    version: 3,
    isDefault: false,
    keywords: ['go', 'python', 'postgresql'],
    updatedAt: '2026-10-05T09:00:00.000Z',
    lastUsedAt: null,
    schemaVersion: RESUME_SUMMARY_SCHEMA_VERSION,
  });
});

test('an empty cache returns an empty list rather than an error', async () => {
  const res = await invoke({ rows: [] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.resumes, []);
});

test('a tab with only a header row returns an empty list', async () => {
  const handler = createHandler({
    verifyIdToken: strictVerifier('good-token'),
    config: { projectId: 'p' },
    sheets: fakeSheets([RESUME_CACHE_HEADERS]),
  });
  const res = fakeResponse();
  await handler({ method: 'GET', headers: { authorization: 'Bearer good-token' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.resumes, []);
});

test('a completely empty tab returns an empty list', async () => {
  const handler = createHandler({
    verifyIdToken: strictVerifier('good-token'),
    config: { projectId: 'p' },
    sheets: fakeSheets(undefined),
  });
  const res = fakeResponse();
  await handler({ method: 'GET', headers: { authorization: 'Bearer good-token' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.resumes, []);
});

// ─── Malformed cache handling ───────────────────────────────────────────────────

test('a malformed row is skipped and the rest of the list survives', async () => {
  const res = await invoke({
    rows: [CACHE_ROW, { ...CACHE_ROW, resumeId: '' }, { ...CACHE_ROW, resumeId: 'rsv_second' }],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.resumes.length, 2);
  assert.equal(res.body.skipped.missing_resume_id, 1);
});

test('an old schemaVersion is skipped and reported', async () => {
  const res = await invoke({ rows: [CACHE_ROW, { ...CACHE_ROW, resumeId: 'rsv_old', schemaVersion: 0 }] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.resumes.length, 1);
  assert.equal(res.body.skipped.schema_version_too_old, 1);
});

test('a newer schemaVersion is served rather than hidden', async () => {
  const res = await invoke({
    rows: [{ ...CACHE_ROW, schemaVersion: RESUME_CACHE_SCHEMA_VERSION + 1, someFutureColumn: 'ignored' }],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.resumes.length, 1);
  assert.equal(JSON.stringify(res.body).includes('someFutureColumn'), false);
});

// ─── Configuration and failure modes ────────────────────────────────────────────

test('missing server configuration is a 404, not a stack trace', async () => {
  // Injected rather than relying on this process lacking the variables, so the result is
  // identical on a developer machine that has a populated .env.
  const handler = createHandler({
    verifyIdToken: strictVerifier('good-token'),
    loadConfig: () => {
      throw new ConfigError(['GOOGLE_RESUME_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON']);
    },
  });
  const res = fakeResponse();
  await handler({ method: 'GET', headers: { authorization: 'Bearer good-token' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'The resume service is not configured on the server.');
  assert.equal(res.body.detail, undefined);
  // The client is told what is wrong, but not which internal variables are missing.
  assert.equal(JSON.stringify(res.body).includes('GOOGLE_RESUME_SHEET_ID'), false);
});

test('configuration is read after authentication, so an anonymous probe cannot enumerate it', async () => {
  let configRead = false;
  const handler = createHandler({
    verifyIdToken: strictVerifier('good-token'),
    loadConfig: () => {
      configRead = true;
      return { projectId: 'p', resumeSheetId: 's', resumeSheetTab: 'Resumes' };
    },
    sheets: fakeSheets(tabValues([CACHE_ROW])),
  });
  await handler({ method: 'GET', headers: {} }, fakeResponse());
  assert.equal(configRead, false);
});

test('a Google failure returns 500 without leaking the provider message to the client', async () => {
  const handler = createHandler({
    verifyIdToken: strictVerifier('good-token'),
    config: { projectId: 'p', resumeSheetId: 'sheet', resumeSheetTab: 'Resumes' },
    sheets: {
      spreadsheets: {
        values: {
          get: async () => {
            const error = new Error('Google Sheets API error: 403 PERMISSION_DENIED for sheet abc123');
            error.code = 403;
            throw error;
          },
        },
      },
    },
  });
  const res = fakeResponse();
  await handler({ method: 'GET', headers: { authorization: 'Bearer good-token' } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'The resume library is temporarily unavailable.');
  // The whole body is the contract: no `detail`, no spreadsheet id, no Google wording.
  assert.deepEqual(Object.keys(res.body), ['error']);
  assert.ok(!JSON.stringify(res.body).includes('PERMISSION_DENIED'));
  assert.ok(!JSON.stringify(res.body).includes('abc123'));
});

test('every error response is JSON, never HTML', async () => {
  const responses = [
    await invoke({ headers: {} }),
    await invoke({ headers: { authorization: 'Bearer bad' } }),
    await invoke({ method: 'POST' }),
  ];
  for (const res of responses) {
    assert.equal(typeof res.body, 'object');
    assert.equal(typeof res.body.error, 'string');
  }
});

// ─── Bearer parsing unit coverage ───────────────────────────────────────────────

test('readBearerToken returns the raw token', () => {
  assert.equal(readBearerToken({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
});

test('readBearerToken returns null for anything that is not a Bearer token', () => {
  for (const req of [{}, { headers: {} }, { headers: { authorization: 'abc' } }, { headers: { authorization: null } }, undefined]) {
    assert.equal(readBearerToken(req), null);
  }
});

test('UnauthenticatedError is distinguishable by name', () => {
  const error = new UnauthenticatedError();
  assert.equal(error.name, 'UnauthenticatedError');
  assert.ok(error instanceof Error);
});
