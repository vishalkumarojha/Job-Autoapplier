/**
 * Send API client.
 *
 * Calls `POST /api/send`, which verifies the application is approved, validates
 * preconditions, and delegates to the existing Apps Script Gmail automation.
 *
 * What this module deliberately does *not* do:
 *
 * - It never calls Apps Script directly. The server is the only bridge.
 * - It never exposes Apps Script URLs, tokens, or response details.
 * - It never sends mail itself. The server calls the existing automation.
 * - It never changes approval state. Approval remains `approved` after sending.
 */

import { apiRequest, type FetchLike } from './client';
import { requireIdToken } from './authToken';
import { ApiError } from './errors';

const SEND_PATH = '/api/send';

export const SEND_SCHEMA_VERSION = 1;

/** The validated projection of a `POST /api/send` response. */
export interface SendResult {
  schemaVersion: number;
  jobId: string;
  message: string;
  threadId: string | null;
  /** Server clock at send. */
  sentAt: string;
}

/** Raised when the server's payload does not match `SendResult`. */
export class InvalidSendResponseError extends Error {
  constructor(reason: string) {
    super(`The send response was not in the expected format: ${reason}`);
    this.name = 'InvalidSendResponseError';
  }
}

export interface SendOptions {
  fetchImpl?: FetchLike;
  getToken?: () => Promise<string | null>;
  /** Cancels the call. A cancelled request is silent: it is not an error the user caused. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

function asObject(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidSendResponseError(`${field} was not an object`);
  }
  return raw as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvalidSendResponseError(`${field} is missing`);
  }
  return value.trim();
}

function toSendResult(raw: unknown, expectedJobId?: string): SendResult {
  const value = asObject(raw, 'the response');

  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw new InvalidSendResponseError('schemaVersion is missing');
  }
  if (schemaVersion < SEND_SCHEMA_VERSION) {
    throw new InvalidSendResponseError(`send schemaVersion ${schemaVersion} is too old`);
  }

  const sentAt = asNonEmptyString(value.sentAt, 'sentAt');
  if (Number.isNaN(Date.parse(sentAt))) {
    throw new InvalidSendResponseError('sentAt is not a timestamp');
  }

  const jobId = asNonEmptyString(value.jobId, 'jobId');
  if (expectedJobId !== undefined && jobId !== expectedJobId) {
    throw new InvalidSendResponseError('jobId did not match the request');
  }
  return {
    schemaVersion,
    jobId,
    message: asNonEmptyString(value.message, 'message'),
    threadId: value.threadId === null ? null : asNonEmptyString(value.threadId, 'threadId'),
    sentAt,
  };
}

/** True when the payload is an envelope this build can render, without throwing. */
export function isValidSendPayload(raw: unknown): raw is SendResult {
  try {
    toSendResult(raw, undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks the server to send an approved application.
 *
 * The server verifies approval, validates preconditions, calls Apps Script,
 * and persists the lifecycle fields. This returns the send result so the
 * caller can render without waiting for a repository round-trip.
 */
export async function sendApplication(
  jobId: string,
  options: SendOptions = {},
): Promise<SendResult> {
  const { fetchImpl, getToken = requireIdToken, signal, timeoutMs } = options;
  const raw = await apiRequest<unknown>(
    SEND_PATH,
    { method: 'POST', body: { jobId }, getToken, signal, timeoutMs },
    fetchImpl,
  );
  return toSendResult(raw, jobId);
}
