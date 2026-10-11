/**
 * Approval API client.
 *
 * Calls `POST /api/approval`, which records a human's review decision on an application.
 * The server is the authority: it validates preconditions, enforces the state machine,
 * and persists only the three approval-owned fields.
 *
 * What this module deliberately does *not* do:
 *
 * - It never sends a mail. There is no send call anywhere in the Phase 8 surface.
 * - It never lets the client manufacture an approval. The server response is authoritative.
 * - It never changes `applicationStatus`. That remains the application lifecycle state,
 *   separate from the approval gate.
 */

import { apiRequest, type FetchLike } from './client';
import { requireIdToken } from './authToken';
import { ApiError } from './errors';

const APPROVAL_PATH = '/api/approval';

export const APPROVAL_SCHEMA_VERSION = 1;

export type ApprovalAction = 'review' | 'approve' | 'reject' | 'reopen';

export interface ApprovalResult {
  schemaVersion: number;
  jobId: string;
  action: ApprovalAction;
  approvalStatus: string;
  approvedAt: string | null;
  approvedBy: string | null;
}

export class InvalidApprovalResponseError extends Error {
  constructor(reason: string) {
    super(`The approval response was not in the expected format: ${reason}`);
    this.name = 'InvalidApprovalResponseError';
  }
}

export interface ApprovalOptions {
  fetchImpl?: FetchLike;
  getToken?: () => Promise<string | null>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function asObject(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidApprovalResponseError(`${field} was not an object`);
  }
  return raw as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvalidApprovalResponseError(`${field} is missing`);
  }
  return value.trim();
}

function asApprovalAction(value: unknown): ApprovalAction {
  const allowed: ApprovalAction[] = ['review', 'approve', 'reject', 'reopen'];
  if (typeof value !== 'string' || !allowed.includes(value as ApprovalAction)) {
    throw new InvalidApprovalResponseError(`action is not a value this version understands`);
  }
  return value as ApprovalAction;
}

function toApprovalResult(raw: unknown): ApprovalResult {
  const value = asObject(raw, 'the response');

  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw new InvalidApprovalResponseError('schemaVersion is missing');
  }
  if (schemaVersion < APPROVAL_SCHEMA_VERSION) {
    throw new InvalidApprovalResponseError(`approval schemaVersion ${schemaVersion} is too old`);
  }

  return {
    schemaVersion,
    jobId: asNonEmptyString(value.jobId, 'jobId'),
    action: asApprovalAction(value.action),
    approvalStatus: asNonEmptyString(value.approvalStatus, 'approvalStatus'),
    approvedAt: value.approvedAt === null ? null : asNonEmptyString(value.approvedAt, 'approvedAt'),
    approvedBy: value.approvedBy === null ? null : asNonEmptyString(value.approvedBy, 'approvedBy'),
  };
}

export function isValidApprovalPayload(raw: unknown): raw is ApprovalResult {
  try {
    toApprovalResult(raw);
    return true;
  } catch {
    return false;
  }
}

async function runApprovalAction(
  jobId: string,
  action: ApprovalAction,
  options: ApprovalOptions = {},
): Promise<ApprovalResult> {
  const { fetchImpl, getToken = requireIdToken, signal, timeoutMs } = options;
  const raw = await apiRequest<unknown>(
    APPROVAL_PATH,
    { method: 'POST', body: { jobId, action }, getToken, signal, timeoutMs },
    fetchImpl,
  );
  return toApprovalResult(raw);
}

export async function startReview(jobId: string, options: ApprovalOptions = {}): Promise<ApprovalResult> {
  return runApprovalAction(jobId, 'review', options);
}

export async function approveJob(jobId: string, options: ApprovalOptions = {}): Promise<ApprovalResult> {
  return runApprovalAction(jobId, 'approve', options);
}

export async function rejectJob(jobId: string, options: ApprovalOptions = {}): Promise<ApprovalResult> {
  return runApprovalAction(jobId, 'reject', options);
}

export async function reopenJob(jobId: string, options: ApprovalOptions = {}): Promise<ApprovalResult> {
  return runApprovalAction(jobId, 'reopen', options);
}