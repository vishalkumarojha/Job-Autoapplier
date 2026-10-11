/**
 * Resume improvement suggestions API client.
 *
 * Calls `POST /api/suggestions`, which reads the job's already-confirmed match, sends the
 * selected resume and that job's posting to the model server-side, and returns up to four
 * evidence-based suggestions.
 *
 * What this module deliberately does *not* do:
 *
 * - It never sends a resume. Resume text, `extractedText`, Drive ids, and Drive file names
 *   are server-side only; the request body carries `jobId` and nothing else.
 * - It never sends a uid. The server takes identity from the verified ID token alone, so a
 *   body field named `uid` would be read and ignored — there is no point emitting one.
 * - It never writes. The server persists `job.resumeSuggestions` on the caller's own
 *   document; callers refresh from the repository afterwards, exactly as matching does.
 * - It never re-runs the match. If the server answers 409 the job has no usable match, and
 *   the honest reaction is to tell the user, not to quietly pick a different resume.
 *
 * The payload is validated here rather than cast, and *stricter* than the match client.
 * Matching drops criteria this build does not recognise because a newer criterion is
 * cosmetic; a suggestion whose `priority` was dropped would still render, and would render
 * as a severity the user cannot trust. An unknown enum value here is therefore a contract
 * violation, not something to filter away.
 */

import { apiRequest, type FetchLike } from './client';
import { requireIdToken } from './authToken';
import {
  RESUME_SUGGESTION_SCHEMA_VERSION,
  SUGGESTION_MAX,
  isSuggestionActionType,
  isSuggestionCategory,
  isSuggestionPriority,
  type ResumeSuggestion,
  type ResumeSuggestions,
} from '../domain/job';

const SUGGESTIONS_PATH = '/api/suggestions';

/** The validated projection of a `POST /api/suggestions` response. */
export interface SuggestionsResult {
  schemaVersion: number;
  jobId: string;
  suggestions: ResumeSuggestion[];
}

/** Raised when the server's payload does not match `SuggestionsResult`. */
export class InvalidSuggestionsResponseError extends Error {
  constructor(reason: string) {
    super(`The resume suggestions were not in the expected format: ${reason}`);
    this.name = 'InvalidSuggestionsResponseError';
  }
}

export interface GenerateSuggestionsOptions {
  fetchImpl?: FetchLike;
  getToken?: () => Promise<string | null>;
  /** Cancels the call. A cancelled request is silent: it is not an error the user caused. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The eight fields the domain allows, and no ninth. */
const SUGGESTION_KEYS = [
  'id',
  'priority',
  'category',
  'actionType',
  'title',
  'suggestion',
  'jobEvidence',
  'resumeEvidence',
] as const;

function asObject(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidSuggestionsResponseError(`${field} was not an object`);
  }
  return raw as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvalidSuggestionsResponseError(`${field} is missing`);
  }
  return value.trim();
}

/**
 * Rejects an unknown enum value instead of dropping the entry.
 *
 * Dropping would silently under-report: an entry whose `priority` this build does not know
 * would either vanish or render without a severity, and the user would read "three
 * suggestions" when four were made. A version that understands more than we do is a reason
 * to update the app, not to show a half-truth.
 */
function asEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly string[],
  guard: (value: unknown) => value is T,
): T {
  if (typeof value !== 'string' || !allowed.includes(value) || !guard(value)) {
    throw new InvalidSuggestionsResponseError(`${field} is not a value this version understands`);
  }
  return value;
}

function toSuggestion(raw: unknown, index: number): ResumeSuggestion {
  const value = asObject(raw, `suggestions[${index}]`);
  const field = `suggestions[${index}]`;

  for (const key of Object.keys(value)) {
    if (!(SUGGESTION_KEYS as readonly string[]).includes(key)) {
      throw new InvalidSuggestionsResponseError(`${field} carries "${key}", which this version does not understand`);
    }
  }

  return {
    id: asNonEmptyString(value.id, `${field}.id`),
    priority: asEnum(value.priority, `${field}.priority`, ['high', 'medium', 'low'], isSuggestionPriority),
    category: asEnum(
      value.category,
      `${field}.category`,
      ['skill_gap', 'skill_emphasis', 'experience_alignment', 'project_alignment', 'keyword_coverage', 'achievement_quantification', 'section_order', 'technology_alignment'],
      isSuggestionCategory,
    ),
    actionType: asEnum(
      value.actionType,
      `${field}.actionType`,
      ['reorder_or_emphasize', 'add_existing_evidence', 'rewrite_existing_bullet', 'quantify_existing_result', 'clarify_existing_experience'],
      isSuggestionActionType,
    ),
    title: asNonEmptyString(value.title, `${field}.title`),
    suggestion: asNonEmptyString(value.suggestion, `${field}.suggestion`),
    jobEvidence: asNonEmptyString(value.jobEvidence, `${field}.jobEvidence`),
    resumeEvidence: asNonEmptyString(value.resumeEvidence, `${field}.resumeEvidence`),
  };
}

/**
 * Validates the envelope.
 *
 * `schemaVersion` is forward-tolerant — a newer server may version the envelope again, and
 * the four suggestions inside it are unchanged by definition of being the same contract —
 * but a version older than this build is refused rather than reinterpreted, because we
 * cannot know what the fields used to mean.
 */
function toSuggestions(raw: unknown): SuggestionsResult {
  const value = asObject(raw, 'the response');

  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw new InvalidSuggestionsResponseError('schemaVersion is missing');
  }
  if (schemaVersion < RESUME_SUGGESTION_SCHEMA_VERSION) {
    throw new InvalidSuggestionsResponseError(`suggestion schemaVersion ${schemaVersion} is too old`);
  }

  const raw2 = value.suggestions;
  if (!Array.isArray(raw2)) throw new InvalidSuggestionsResponseError('suggestions was not an array');
  if (raw2.length > SUGGESTION_MAX) {
    throw new InvalidSuggestionsResponseError(`the server sent more than ${SUGGESTION_MAX} suggestions`);
  }

  const suggestions = raw2.map(toSuggestion);
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    if (seen.has(suggestion.id)) {
      throw new InvalidSuggestionsResponseError(`${suggestion.id} appears twice`);
    }
    seen.add(suggestion.id);
  }

  return {
    schemaVersion,
    jobId: asNonEmptyString(value.jobId, 'jobId'),
    suggestions,
  };
}

/** True when the payload is an envelope this build can render, without throwing. */
export function isValidSuggestionsPayload(raw: unknown): raw is SuggestionsResult {
  try {
    toSuggestions(raw);
    return true;
  } catch {
    return false;
  }
}

/** True when a persisted envelope on a job document should be rendered as-is. */
export function toPersistedSuggestions(raw: unknown): ResumeSuggestions | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<ResumeSuggestions>;
  if (typeof value.schemaVersion !== 'number' || !Number.isInteger(value.schemaVersion)) return null;
  if (value.schemaVersion < RESUME_SUGGESTION_SCHEMA_VERSION) return null;
  if (!Array.isArray(value.suggestions)) return null;
  if (value.suggestions.length > SUGGESTION_MAX) return null;
  try {
    const suggestions = value.suggestions.map((entry, index) => toSuggestion(entry, index));
    return { schemaVersion: value.schemaVersion, suggestions };
  } catch {
    return null;
  }
}

/**
 * Asks the server to generate suggestions for one job.
 *
 * The server persists them; this returns the same list so the caller can render without
 * waiting for a repository round-trip. Callers should still refresh, so the screen shows
 * the state a reload would produce.
 */
export async function generateSuggestions(
  jobId: string,
  options: GenerateSuggestionsOptions = {},
): Promise<SuggestionsResult> {
  const { fetchImpl, getToken = requireIdToken, signal, timeoutMs } = options;
  const raw = await apiRequest<unknown>(
    SUGGESTIONS_PATH,
    { method: 'POST', body: { jobId }, getToken, signal, timeoutMs },
    fetchImpl,
  );
  return toSuggestions(raw);
}
