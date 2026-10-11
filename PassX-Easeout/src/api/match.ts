/**
 * Resume matching API client.
 *
 * Calls `POST /api/match`, which scores every resume in the library against one confirmed
 * job and returns the winner, an overall score, a per-criterion breakdown, and the full
 * ranking.
 *
 * What this module deliberately does *not* do:
 *
 * - It never sends a resume. Resume text, `extractedText`, Drive ids, and Drive file names
 *   are server-side only; the request body carries `jobId` and nothing else.
 * - It never sends a uid. The server takes identity from the verified ID token alone, so a
 *   body field named `uid` would be read and ignored — there is no point emitting one.
 * - It never writes. Selection, approval, and application status are separate features with
 *   their own gates; a match only ever *reports*, and the persisted patch happens server-side
 *   against the caller's own document.
 *
 * The payload is validated here rather than cast. A shape change should surface as a clear
 * error at the boundary, not as an undefined score three screens later.
 */

import { apiRequest, type FetchLike } from './client';
import { requireIdToken } from './authToken';
import {
  JOB_MATCH_SCHEMA_VERSION,
  isMatchCriterion,
  type MatchBreakdown,
  type MatchBreakdownEntry,
} from '../domain/job';

const MATCH_PATH = '/api/match';

/** One candidate's position in the full ranking, highest first. */
export interface MatchRanking {
  resumeId: string;
  score: number;
}

/** The validated, allow-listed projection of a match result. */
export interface JobMatchResult {
  schemaVersion: number;
  jobId: string;
  selectedResumeId: string;
  /** Overall match, 0..100. */
  matchScore: number;
  matchBreakdown: MatchBreakdown;
  /** Every candidate the server sent, ordered best first. Never persisted. */
  rankings: MatchRanking[];
}

/** Raised when the server's payload does not match `JobMatchResult`. */
export class InvalidMatchResponseError extends Error {
  constructor(reason: string) {
    super(`The resume match was not in the expected format: ${reason}`);
    this.name = 'InvalidMatchResponseError';
  }
}

export interface MatchJobOptions {
  fetchImpl?: FetchLike;
  getToken?: () => Promise<string | null>;
  /** Cancels the call. A cancelled match is silent: it is not an error the user caused. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

function asObject(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidMatchResponseError(`${field} was not an object`);
  }
  return raw as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new InvalidMatchResponseError(`${field} is missing`);
  return value;
}

/**
 * Accepts an integer in 0..100 and nothing else.
 *
 * Deliberately no clamping and no rounding: a score the server sent outside the range is a
 * contract violation, and quietly turning 140 into 100 would hide it.
 */
function asScore(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new InvalidMatchResponseError(`${field} is not an integer between 0 and 100`);
  }
  return value;
}

/** Contribution weight, 0..1. Required by the contract, so a bad value is an error. */
function asWeight(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new InvalidMatchResponseError(`${field} is not a weight between 0 and 1`);
  }
  return value;
}

function toRanking(raw: unknown, index: number): MatchRanking {
  const value = asObject(raw, `rankings[${index}]`);
  return {
    resumeId: asString(value.resumeId, `rankings[${index}].resumeId`),
    score: asScore(value.score, `rankings[${index}].score`),
  };
}

/**
 * Keeps the criteria this build knows about and drops the rest.
 *
 * Forward compatibility runs through here: a newer server may add a criterion, and showing
 * its raw identifier would be worse than not showing it. At least one known criterion must
 * survive, otherwise the breakdown is not a breakdown.
 */
function toBreakdown(raw: unknown): MatchBreakdown {
  if (!Array.isArray(raw)) throw new InvalidMatchResponseError('matchBreakdown was not an array');
  const entries: MatchBreakdown[] = raw.map((item, index) => {
    const value = asObject(item, `matchBreakdown[${index}]`);
    const criterion = value.criterion;
    if (!isMatchCriterion(criterion)) return [];
    const entry: MatchBreakdownEntry = {
      criterion,
      score: asScore(value.score, `matchBreakdown[${index}].score`),
      weight: asWeight(value.weight, `matchBreakdown[${index}].weight`),
      rationale: typeof value.rationale === 'string' && value.rationale ? value.rationale : null,
    };
    return [entry];
  });
  const breakdown = entries.flat();
  if (breakdown.length === 0) {
    throw new InvalidMatchResponseError('matchBreakdown contained no criterion this version understands');
  }
  return breakdown;
}

function toJobMatch(raw: unknown): JobMatchResult {
  const value = asObject(raw, 'the response');

  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw new InvalidMatchResponseError('schemaVersion is missing');
  }
  if (schemaVersion < JOB_MATCH_SCHEMA_VERSION) {
    throw new InvalidMatchResponseError(`match schemaVersion ${schemaVersion} is too old`);
  }

  const rankingsRaw = value.rankings;
  if (!Array.isArray(rankingsRaw) || rankingsRaw.length === 0) {
    throw new InvalidMatchResponseError('rankings was empty');
  }
  const rankings = rankingsRaw.map(toRanking);

  const seen = new Set<string>();
  for (const ranking of rankings) {
    if (seen.has(ranking.resumeId)) {
      throw new InvalidMatchResponseError(`${ranking.resumeId} appears twice in rankings`);
    }
    seen.add(ranking.resumeId);
  }
  // The server presents rankings descending. If that ever stops being true the ordering on
  // screen would disagree with the scores the user can see, so refuse rather than re-sort.
  for (let i = 1; i < rankings.length; i += 1) {
    if (rankings[i].score > rankings[i - 1].score) {
      throw new InvalidMatchResponseError('rankings were not ordered highest first');
    }
  }

  const selectedResumeId = asString(value.selectedResumeId, 'selectedResumeId');
  if (!seen.has(selectedResumeId)) {
    throw new InvalidMatchResponseError('the selected resume was not in rankings');
  }

  return {
    schemaVersion,
    jobId: asString(value.jobId, 'jobId'),
    selectedResumeId,
    matchScore: asScore(value.matchScore, 'matchScore'),
    matchBreakdown: toBreakdown(value.matchBreakdown),
    rankings,
  };
}

/**
 * Runs the match for one job and returns the result.
 *
 * The server persists `selectedResumeId`, `matchScore`, and `matchBreakdown` on the job
 * document; nothing here writes to Firestore. Callers refresh from the repository afterwards
 * so the screen shows the persisted state rather than a copy held in memory.
 */
export async function matchJob(jobId: string, options: MatchJobOptions = {}): Promise<JobMatchResult> {
  const { fetchImpl, getToken = requireIdToken, signal, timeoutMs } = options;
  const raw = await apiRequest<unknown>(
    MATCH_PATH,
    { method: 'POST', body: { jobId }, getToken, signal, timeoutMs },
    fetchImpl,
  );
  return toJobMatch(raw);
}
