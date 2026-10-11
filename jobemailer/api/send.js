/** POST /api/send — Firebase-authenticated send bridge to the existing Apps Script. */
import { authenticate, UnauthenticatedError } from '../lib/auth.js';
import { ConfigError, sendConfig } from '../lib/config.js';
import { sendApplication } from '../lib/send.js';

const AUTH_ERROR = 'Authentication required.';
const NOT_CONFIGURED = 'Send is not configured on the server.';
const SEND_FAILED = 'Unable to confirm that the application was sent.';

function methodNotAllowed(res, method) {
  res.setHeader('Allow', 'POST');
  return res.status(405).json({ error: `Method ${method} is not allowed. Use POST.` });
}

export function fakeResponse() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function requestBody(raw) {
  if (raw === undefined || raw === null || raw === '') throw new SendRequestError('A JSON request body is required.');
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { throw new SendRequestError('The request body was not valid JSON.'); }
  }
  return raw;
}

class SendRequestError extends Error {}

function parseSendRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SendRequestError('The request body must be a JSON object.');
  if (typeof body.jobId !== 'string' || !body.jobId.trim()) throw new SendRequestError('A jobId is required.');
  const jobId = body.jobId.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new SendRequestError('That jobId is not valid.');
  return { jobId };
}

export function createHandler(overrides = {}) {
  const logger = overrides.logger ?? console;
  return async function handler(req, res) {
    if (!req || req.method !== 'POST') return methodNotAllowed(res, req?.method || 'unknown');

    let uid;
    try {
      const decoded = await authenticate(req, { verifyIdToken: overrides.verifyIdToken, config: overrides.authConfig ?? overrides.config });
      uid = decoded.uid;
    } catch (error) {
      if (error instanceof UnauthenticatedError) return res.status(401).json({ error: AUTH_ERROR });
      if (error instanceof ConfigError) return res.status(404).json({ error: NOT_CONFIGURED });
      logger.error?.('[send] token verification failed', error);
      return res.status(500).json({ error: 'Could not verify credentials.' });
    }

    let input;
    try { input = parseSendRequest(requestBody(req.body)); }
    catch (error) {
      if (error instanceof SendRequestError) return res.status(400).json({ error: error.message });
      logger.error?.('[send] invalid request body', error);
      return res.status(400).json({ error: 'Invalid request body.' });
    }

    let config;
    try { config = overrides.config ?? (overrides.loadConfig ?? sendConfig)(); }
    catch (error) {
      if (error instanceof ConfigError) {
        logger.error?.('[send] configuration is incomplete', error.message);
        return res.status(404).json({ error: NOT_CONFIGURED });
      }
      logger.error?.('[send] configuration failed', error);
      return res.status(500).json({ error: SEND_FAILED });
    }

    try {
      const result = await (overrides.sendApplication ?? sendApplication)(uid, input.jobId, {
        db: overrides.db, config, fetch: overrides.fetch, sheets: overrides.sheets,
        now: overrides.now, logger,
      });
      return res.status(200).json({
        schemaVersion: 1,
        jobId: input.jobId,
        message: 'Application sent.',
        threadId: result.threadId ?? null,
        sentAt: result.sentAt,
      });
    } catch (error) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'Job not found.' });
      if (error.code === 'PRECONDITION_FAILED' || error.code === 'DUPLICATE' || error.code === 'SEND_CONFLICT') {
        return res.status(409).json({ error: error.message });
      }
      logger.error?.('[send] send operation failed', error);
      return res.status(500).json({ error: SEND_FAILED });
    }
  };
}

export default createHandler();
