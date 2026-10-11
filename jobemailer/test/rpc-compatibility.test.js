import test from 'node:test';
import assert from 'node:assert/strict';

test('legacy /api/rpc preserves dashboard send request and adds its server token', async () => {
  const oldUrl = process.env.APPS_SCRIPT_URL;
  const oldToken = process.env.APPS_SCRIPT_TOKEN;
  const oldFetch = globalThis.fetch;
  process.env.APPS_SCRIPT_URL = 'https://apps-script.example/exec';
  process.env.APPS_SCRIPT_TOKEN = 'server-token';
  let sentRequest;
  globalThis.fetch = async (url, options) => {
    sentRequest = { url, options, body: JSON.parse(options.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, message: 'Email processed by your existing automation.' }) };
  };
  try {
    const { default: handler } = await import('../api/rpc.js');
    const response = {
      statusCode: null, body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    const data = { company: 'Legacy Corp', contactEmail: 'recruiter@example.test', role: 'Engineer' };
    await handler({ method: 'POST', body: { action: 'send', data } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(sentRequest.url, process.env.APPS_SCRIPT_URL);
    assert.deepEqual(sentRequest.body, { action: 'send', data, token: 'server-token' });
    assert.equal(response.body.ok, true);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.APPS_SCRIPT_URL; else process.env.APPS_SCRIPT_URL = oldUrl;
    if (oldToken === undefined) delete process.env.APPS_SCRIPT_TOKEN; else process.env.APPS_SCRIPT_TOKEN = oldToken;
  }
});
