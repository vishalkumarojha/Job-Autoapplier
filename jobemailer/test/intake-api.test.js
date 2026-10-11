/**
 * Tests for `POST /api/intake`, focused on the authentication boundary, request
 * validation, and proving that neither Anthropic's error messages nor the model's output
 * can reach a client.
 *
 * Runs on `node:test`. No Firebase project and no Anthropic account is involved: the token
 * verifier, the model call, and the configuration are all injected, so these cases exercise
 * the real handler while contacting nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler, fakeResponse, readJsonBody } from '../api/intake.js';
import { ConfigError } from '../lib/config.js';
import { INTAKE_MAX_RAW_CHARS, INTAKE_SOURCES } from '../lib/intake.js';

/** A posting that contains every field the extraction is asked to find. */
const POSTING = `Senior Backend Engineer — Example Corp
Bangalore / Remote · Posted 2 Oct 2026

We are hiring a Senior Backend Engineer to own our payments platform.
Apply by 12 October 2026. Send your CV to Priya Sharma, priya.sharma@example.com.
Job page: https://example.com/jobs/backend-42

Visa sponsorship available. Two weeks notice preferred.`;

/** A model response that satisfies the schema and traces back to `POSTING`. */
const VALID_OUTPUT = {
  company: 'Example Corp',
  contactName: 'Priya Sharma',
  contactEmail: 'priya.sharma@example.com',
  role: 'Senior Backend Engineer',
  jobUrl: 'https://example.com/jobs/backend-42',
  location: 'Bangalore / Remote',
  notes: 'Visa sponsorship available.',
  deadline: '2026-10-12',
  fieldConfidence: {
    company: 0.98,
    contactName: 0.72,
    contactEmail: 0.93,
    role: 0.99,
    jobUrl: 0.98,
    location: 0.81,
    deadline: 0.88,
  },
};

const CONFIG = { anthropicApiKey: 'test-key', anthropicModel: 'claude-test-model' };

/** Accepts exactly one hardcoded token; anything else throws like Firebase does. */
function strictVerifier(expectedToken, uid = 'user-1') {
  return async (token) => {
    if (token !== expectedToken) throw new Error('Firebase ID token has expired or is invalid.');
    return { uid, sub: uid };
  };
}

/** Records log calls instead of writing to stdout, so a passing run stays quiet. */
function silentLogger() {
  const entries = [];
  return {
    entries,
    error: (...args) => entries.push(args),
  };
}

/**
 * Runs the handler with a valid request unless overridden.
 *
 * `complete` stands in for Anthropic and receives the built prompt, which is how the
 * prompt-shape assertions below can run without a network call.
 */
async function invoke(options = {}) {
  const {
    headers = { authorization: 'Bearer good-token' },
    body = { rawText: POSTING, source: 'linkedin' },
    method = 'POST',
    verifyIdToken = strictVerifier('good-token'),
    complete = async () => JSON.stringify(VALID_OUTPUT),
    config = CONFIG,
    loadConfig,
    logger = silentLogger(),
  } = options;

  const handler = createHandler({ verifyIdToken, complete, config, loadConfig, logger });
  const res = fakeResponse();
  await handler({ method, headers, body }, res);
  return { res, logger };
}

// ─── Authentication ────────────────────────────────────────────────────────────

test('a missing token is 401', async () => {
  const { res } = await invoke({ headers: {} });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Authentication required.' });
});

test('an invalid token is 401', async () => {
  const { res } = await invoke({
    headers: { authorization: 'Bearer forged' },
    verifyIdToken: strictVerifier('good-token'),
  });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Authentication required.' });
});

test('an expired token is 401, and is indistinguishable from a forged one', async () => {
  const expired = async () => {
    const error = new Error('Firebase ID token has expired.');
    error.code = 'auth/id-token-expired';
    throw error;
  };
  const { res: expiredRes } = await invoke({ verifyIdToken: expired });
  const { res: forgedRes } = await invoke({ verifyIdToken: strictVerifier('other') });

  assert.equal(expiredRes.statusCode, 401);
  assert.equal(forgedRes.statusCode, 401);
  assert.deepEqual(expiredRes.body, forgedRes.body);
  assert.ok(!JSON.stringify(expiredRes.body).includes('expired'));
});

test('a header that is not Bearer form is 401', async () => {
  const { res } = await invoke({ headers: { authorization: 'Basic good-token' } });
  assert.equal(res.statusCode, 401);
});

test('a verified token lets the request continue to a 200', async () => {
  const { res } = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.company, 'Example Corp');
});

test('the bearer token never appears in the response', async () => {
  const { res } = await invoke();
  assert.equal(JSON.stringify(res.body).includes('good-token'), false);
});

test('configuration is read after authentication, so an anonymous probe cannot enumerate it', async () => {
  let configRead = false;
  const { res } = await invoke({
    headers: {},
    config: undefined,
    loadConfig: () => {
      configRead = true;
      return CONFIG;
    },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(configRead, false);
});

// ─── Method ────────────────────────────────────────────────────────────────────

test('a GET is 405 and advertises POST', async () => {
  const { res } = await invoke({ method: 'GET' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'POST');
  assert.match(res.body.error, /Use POST/);
});

// ─── Request validation ────────────────────────────────────────────────────────

test('empty rawText is 400', async () => {
  const { res } = await invoke({ body: { rawText: '', source: 'paste' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Paste a job posting before extracting.');
});

test('whitespace-only rawText is 400', async () => {
  const { res } = await invoke({ body: { rawText: '   \n\t  \n ', source: 'paste' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Paste a job posting before extracting.');
});

test('rawText that is not a string is 400', async () => {
  const { res } = await invoke({ body: { rawText: 12345, source: 'paste' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Job posting text is required.');
});

test('a missing source is 400', async () => {
  const { res } = await invoke({ body: { rawText: POSTING } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'That source is not supported.');
});

test('an unsupported source is 400', async () => {
  const { res } = await invoke({ body: { rawText: POSTING, source: 'telepathy' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'That source is not supported.');
});

test('every value in the agreed source vocabulary is accepted', async () => {
  assert.deepEqual(INTAKE_SOURCES, [
    'paste',
    'share_android',
    'manual',
    'email',
    'linkedin',
    'x',
    'referral',
    'other',
  ]);
  for (const source of INTAKE_SOURCES) {
    const { res } = await invoke({ body: { rawText: POSTING, source } });
    assert.equal(res.statusCode, 200, `source ${source} was rejected`);
    assert.equal(res.body.source, source);
  }
});

test('oversized rawText is 400 rather than being sent to the provider', async () => {
  let called = false;
  const { res } = await invoke({
    body: { rawText: 'x'.repeat(INTAKE_MAX_RAW_CHARS + 1), source: 'paste' },
    complete: async () => {
      called = true;
      return JSON.stringify(VALID_OUTPUT);
    },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /too long/);
  assert.equal(called, false);
});

test('a body at the size limit is accepted', async () => {
  const { res } = await invoke({
    body: { rawText: `job ${'x'.repeat(INTAKE_MAX_RAW_CHARS - 4)}`, source: 'paste' },
    complete: async () => JSON.stringify({ ...VALID_OUTPUT, jobUrl: null }),
  });
  assert.equal(res.statusCode, 200);
});

test('malformed JSON text is 400, not 500', async () => {
  const handler = createHandler({
    verifyIdToken: strictVerifier('good-token'),
    complete: async () => JSON.stringify(VALID_OUTPUT),
    config: CONFIG,
    logger: silentLogger(),
  });
  const res = fakeResponse();
  await handler({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: '{not json' }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'The request body was not valid JSON.');
});

test('a missing body is 400', async () => {
  const handler = createHandler({
    verifyIdToken: strictVerifier('good-token'),
    complete: async () => JSON.stringify(VALID_OUTPUT),
    config: CONFIG,
    logger: silentLogger(),
  });
  const res = fakeResponse();
  await handler({ method: 'POST', headers: { authorization: 'Bearer good-token' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'A JSON request body is required.');
});

test('a body that is a JSON array is 400', async () => {
  const { res } = await invoke({ body: ['rawText'] });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'The request body must be a JSON object.');
});

test('a JSON-string body is parsed, not stringified a second time', async () => {
  const { res } = await invoke({ body: JSON.stringify({ rawText: POSTING, source: 'referral' }) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, 'referral');
});

// ─── Claude / provider ─────────────────────────────────────────────────────────

test('valid structured output is returned as a 200 with the agreed shape', async () => {
  const { res } = await invoke();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [
    'company',
    'contactEmail',
    'contactName',
    'deadline',
    'fieldConfidence',
    'jobUrl',
    'location',
    'notes',
    'role',
    'schemaVersion',
    'source',
  ]);
  assert.equal(res.body.schemaVersion, 1);
  assert.equal(res.body.source, 'linkedin');
  assert.equal(res.body.company, 'Example Corp');
  assert.equal(res.body.deadline, '2026-10-12T00:00:00.000Z');
  assert.equal(res.body.contactEmail, 'priya.sharma@example.com');
  assert.equal(res.body.fieldConfidence.contactEmail, 0.93);
});

test('the provider is never asked to guess the source', async () => {
  let seenPrompt = '';
  const { res } = await invoke({
    body: { rawText: POSTING, source: 'referral' },
    complete: async ({ system, user }) => {
      seenPrompt = `${system}\n${user}`;
      return JSON.stringify({ ...VALID_OUTPUT, source: 'something_else' });
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, 'referral');
  // The source is passed as metadata, never as a field to produce.
  assert.match(seenPrompt, /^Source: referral$/m);
  assert.equal(seenPrompt.includes('"source"'), false);
});

test('malformed JSON from the model is a controlled 500', async () => {
  const { res, logger } = await invoke({ complete: async () => '{"company": "Example",}' });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to process job posting' });
  assert.ok(logger.entries.length > 0);
});

test('a fenced JSON response is accepted', async () => {
  const { res } = await invoke({ complete: async () => '```json\n' + JSON.stringify(VALID_OUTPUT) + '\n```' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.company, 'Example Corp');
});

test('prose wrapped around the object is rejected rather than guessed at', async () => {
  const { res } = await invoke({
    complete: async () => `Here is the extraction:\n${JSON.stringify(VALID_OUTPUT)}`,
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to process job posting' });
});

test('schema-invalid output is a controlled 500', async () => {
  const { res } = await invoke({
    complete: async () => JSON.stringify({ ...VALID_OUTPUT, company: 42 }),
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to process job posting' });
});

test('an empty model response is a controlled 500', async () => {
  const { res } = await invoke({ complete: async () => '   ' });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to process job posting' });
});

test('a JSON array from the model is a controlled 500', async () => {
  const { res } = await invoke({ complete: async () => '[]' });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to process job posting' });
});

test('a provider failure is a controlled 500', async () => {
  const { res } = await invoke({
    complete: async () => {
      throw new Error('401 Unauthorized: https://api.anthropic.com/v1/messages');
    },
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Unable to process job posting' });
});

test('provider error detail never leaks to the client', async () => {
  const modelText = 'contact me at secret-candidate@example.org or call +91 99999 99999';
  const { res, logger } = await invoke({
    complete: async () => {
      throw new Error(`429 rate limited at https://api.anthropic.com/v1/messages: ${modelText}`);
    },
  });

  const serialized = JSON.stringify(res.body);
  assert.deepEqual(Object.keys(res.body), ['error']);
  assert.equal(serialized.includes('429'), false);
  assert.equal(serialized.includes('anthropic.com'), false);
  assert.equal(serialized.includes('ANTHROPIC'), false);
  assert.equal(serialized.includes('secret-candidate@example.org'), false);
  assert.equal(serialized.includes('99999'), false);

  // ...but it is still visible to whoever is reading the server logs, which is the only
  // place an operator could diagnose it. Errors stringify to "{}" in JSON, so the message
  // is inspected on the object itself.
  const logged = logger.entries.flat().filter((entry) => entry instanceof Error);
  assert.equal(logged.length > 0, true);
  assert.ok(logged.some((entry) => entry.message.includes('rate limited')));
});

test('the model output itself never reaches the client when validation fails', async () => {
  const leaky = { ...VALID_OUTPUT, contactEmail: 'unverified-person@example.net' };
  delete leaky.fieldConfidence;
  const { res } = await invoke({ complete: async () => JSON.stringify(leaky) });

  assert.equal(res.statusCode, 500);
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes('unverified-person@example.net'), false);
  assert.equal(serialized.includes('Example Corp'), false);
  assert.deepEqual(res.body, { error: 'Unable to process job posting' });
});

test('the prompt sent to the model is a completed extraction, and the posting is inside tags', async () => {
  let prompt = '';
  await invoke({
    complete: async ({ system, user }) => {
      prompt = `${system}\n<<<\n${user}`;
      return JSON.stringify(VALID_OUTPUT);
    },
  });
  assert.match(prompt, /<job_posting>/);
  assert.match(prompt, /<\/job_posting>/);
  assert.ok(prompt.includes('Senior Backend Engineer'));
  assert.match(prompt, /untrusted/i);
});

// ─── Configuration ─────────────────────────────────────────────────────────────

test('missing server configuration is a 404, not a stack trace', async () => {
  const handler = createHandler({
    verifyIdToken: strictVerifier('good-token'),
    config: undefined,
    loadConfig: () => {
      throw new ConfigError(['ANTHROPIC_API_KEY']);
    },
    logger: silentLogger(),
  });
  const res = fakeResponse();
  await handler({ method: 'POST', headers: { authorization: 'Bearer good-token' }, body: { rawText: POSTING, source: 'paste' } }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Job intake is not configured on the server.');
  assert.equal(JSON.stringify(res.body).includes('ANTHROPIC_API_KEY'), false);
});

test('an injected configuration without an API key is a 404', async () => {
  const { res } = await invoke({ config: { projectId: 'p' } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Job intake is not configured on the server.');
});

test('the raw posting is never echoed back to the client', async () => {
  const { res } = await invoke();
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes('Send your CV to'), false);
  assert.equal(serialized.includes('Visa sponsorship available. Two weeks notice preferred'), false);
});

test('the server-side source vocabulary is exactly the documented one', () => {
  assert.deepEqual(INTAKE_SOURCES, [
    'paste',
    'share_android',
    'manual',
    'email',
    'linkedin',
    'x',
    'referral',
    'other',
  ]);
});

test('readJsonBody parses text, accepts objects, and rejects non-JSON', () => {
  assert.deepEqual(readJsonBody('{"a":1}'), { a: 1 });
  assert.deepEqual(readJsonBody({ a: 1 }), { a: 1 });
  assert.throws(() => readJsonBody('{nope'), { name: 'RequestValidationError' });
  // A syntactically valid but wrong-shaped value falls through to `parseRequestBody`.
  assert.equal(readJsonBody('"just a string"'), 'just a string');
});
