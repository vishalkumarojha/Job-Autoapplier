import {
  InvalidSuggestionsResponseError,
  generateSuggestions,
  isValidSuggestionsPayload,
  toPersistedSuggestions,
} from '../suggestions';
import { ApiError, NotAuthenticatedError } from '../errors';
import type { FetchLike } from '../client';
import { API_BASE_URL_ENV_VAR } from '../../config/env';
import { RESUME_SUGGESTION_SCHEMA_VERSION, SUGGESTION_MAX } from '../../domain/job';

const BASE = 'https://api.example.test';
const TOKEN = 'tok-abc';

const SUGGESTION = {
  id: 'sug_001',
  priority: 'high',
  category: 'skill_emphasis',
  actionType: 'reorder_or_emphasize',
  title: 'Highlight PostgreSQL work',
  suggestion: 'Reorder the PostgreSQL bullet above the payments summary.',
  jobEvidence: 'PostgreSQL is a required technology.',
  resumeEvidence: 'The resume already demonstrates PostgreSQL.',
};

const VALID = {
  schemaVersion: RESUME_SUGGESTION_SCHEMA_VERSION,
  jobId: 'job-1',
  suggestions: [SUGGESTION],
};

type Fake = { fetchImpl: FetchLike; calls: { url: string; init?: RequestInit }[] };

function fakeFetch(body: unknown, init: { status?: number; rawText?: string } = {}): Fake {
  const status = init.status ?? 200;
  const calls: Fake['calls'] = [];
  const fetchImpl: FetchLike = async (url, reqInit) => {
    calls.push({ url, init: reqInit });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => init.rawText ?? JSON.stringify(body),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

/** Rejects any token, so the default `requireIdToken` path is observable without Firebase. */
const noSession = async (): Promise<string> => {
  throw new NotAuthenticatedError();
};

const getToken = async () => TOKEN;

jest.mock('../../services/firebase', () => ({
  auth: { currentUser: null },
}));

beforeEach(() => {
  process.env[API_BASE_URL_ENV_VAR] = BASE;
});

describe('generateSuggestions transport', () => {
  it('POSTs /api/suggestions with a bearer token and only the jobId in the body', async () => {
    const { fetchImpl, calls } = fakeFetch(VALID);
    await generateSuggestions('job-1', { fetchImpl, getToken });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/suggestions`);
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ jobId: 'job-1' });
  });

  it('never sends a uid, a resume id, or resume text', async () => {
    const { fetchImpl, calls } = fakeFetch(VALID);
    await generateSuggestions('job-1', { fetchImpl, getToken });

    const sent = String(calls[0].init?.body);
    for (const forbidden of ['uid', 'resumeId', 'extractedText', 'driveFileId']) {
      expect(sent).not.toContain(forbidden);
    }
  });

  it('fails as not_authenticated when there is no session', async () => {
    const { fetchImpl } = fakeFetch(VALID);
    await expect(generateSuggestions('job-1', { fetchImpl, getToken: noSession })).rejects.toThrow(ApiError);
    await expect(generateSuggestions('job-1', { fetchImpl, getToken: noSession })).rejects.toMatchObject({
      kind: 'not_authenticated',
    });
  });

  it('maps the server rejections onto ApiError kinds', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'unauthorized', 'Authentication required.'],
      [404, 'not_found', 'Job not found.'],
      [409, 'client', 'This job has no selected resume. Run a match first.'],
      [500, 'server', 'Unable to generate resume suggestions.'],
    ];
    for (const [status, kind, message] of cases) {
      const { fetchImpl } = fakeFetch({ error: message }, { status });
      const error = await generateSuggestions('job-1', { fetchImpl, getToken }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ kind, status, message });
    }
  });

  it('reports a cancellation as benign rather than as a failure', async () => {
    const { fetchImpl } = fakeFetch(VALID, { status: 499 });
    const error = await generateSuggestions('job-1', { fetchImpl, getToken }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('client');
    expect((error as ApiError).isBenign).toBe(false);
  });
});

/** Every payload shape the server could plausibly send that must not be rendered. */
const INVALID: Array<[string, unknown]> = [
  ['a non-object body', 'nope'],
  ['a missing schemaVersion', { jobId: 'job-1', suggestions: [] }],
  ['a schemaVersion older than this build', { ...VALID, schemaVersion: 0 }],
  ['a non-integer schemaVersion', { ...VALID, schemaVersion: 1.5 }],
  ['a missing suggestions array', { schemaVersion: 1, jobId: 'job-1' }],
  ['suggestions as an object', { schemaVersion: 1, jobId: 'job-1', suggestions: {} }],
  ['a missing jobId', { ...VALID, jobId: '' }],
  ['an entry that is not an object', { ...VALID, suggestions: ['nope'] }],
  ['a missing title', { ...VALID, suggestions: [{ ...SUGGESTION, title: '' }] }],
  ['a whitespace-only suggestion', { ...VALID, suggestions: [{ ...SUGGESTION, suggestion: '   ' }] }],
  ['an unknown priority', { ...VALID, suggestions: [{ ...SUGGESTION, priority: 'urgent' }] }],
  ['an unknown category', { ...VALID, suggestions: [{ ...SUGGESTION, category: 'tone' }] }],
  ['an unknown action type', { ...VALID, suggestions: [{ ...SUGGESTION, actionType: 'add_new_skill' }] }],
  ['an action type that implies new experience', { ...VALID, suggestions: [{ ...SUGGESTION, actionType: 'claim_missing_skill' }] }],
  ['an unknown ninth field', { ...VALID, suggestions: [{ ...SUGGESTION, targetSection: 'skills' }] }],
  ['a missing field', { ...VALID, suggestions: [{ ...SUGGESTION, resumeEvidence: undefined }] }],
  ['a duplicate id', { ...VALID, suggestions: [SUGGESTION, { ...SUGGESTION }] }],
  ['more than the ceiling', {
    ...VALID,
    suggestions: Array.from({ length: SUGGESTION_MAX + 1 }, (_, i) => ({ ...SUGGESTION, id: `sug_00${i}` })),
  }],
];

describe('generateSuggestions response validation', () => {
  it('returns the validated suggestions', async () => {
    const { fetchImpl } = fakeFetch(VALID);
    const result = await generateSuggestions('job-1', { fetchImpl, getToken });

    expect(result.schemaVersion).toBe(RESUME_SUGGESTION_SCHEMA_VERSION);
    expect(result.jobId).toBe('job-1');
    expect(result.suggestions).toHaveLength(1);
    expect(Object.keys(result.suggestions[0])).toEqual([
      'id', 'priority', 'category', 'actionType', 'title', 'suggestion', 'jobEvidence', 'resumeEvidence',
    ]);
  });

  it('trims surrounding whitespace rather than rejecting it', async () => {
    const { fetchImpl } = fakeFetch({
      ...VALID,
      suggestions: [{ ...SUGGESTION, title: '  Highlight PostgreSQL work  ' }],
    });
    const result = await generateSuggestions('job-1', { fetchImpl, getToken });
    expect(result.suggestions[0].title).toBe('Highlight PostgreSQL work');
  });

  it('accepts an empty list, because "nothing worth recommending" is an answer', async () => {
    const { fetchImpl } = fakeFetch({ ...VALID, suggestions: [] });
    const result = await generateSuggestions('job-1', { fetchImpl, getToken });
    expect(result.suggestions).toEqual([]);
  });

  it('accepts the ceiling itself', async () => {
    const suggestions = Array.from({ length: SUGGESTION_MAX }, (_, i) => ({ ...SUGGESTION, id: `sug_00${i}` }));
    const { fetchImpl } = fakeFetch({ ...VALID, suggestions });
    const result = await generateSuggestions('job-1', { fetchImpl, getToken });
    expect(result.suggestions).toHaveLength(SUGGESTION_MAX);
  });

  it.each(INVALID)('rejects %s', async (_name, payload) => {
    const { fetchImpl } = fakeFetch(payload);
    await expect(generateSuggestions('job-1', { fetchImpl, getToken })).rejects.toBeInstanceOf(
      InvalidSuggestionsResponseError,
    );
  });

  it('accepts a newer envelope version rather than refusing a future server', async () => {
    const { fetchImpl } = fakeFetch({ ...VALID, schemaVersion: RESUME_SUGGESTION_SCHEMA_VERSION + 1 });
    const result = await generateSuggestions('job-1', { fetchImpl, getToken });
    expect(result.schemaVersion).toBe(RESUME_SUGGESTION_SCHEMA_VERSION + 1);
  });

  it('reports an HTML error page as malformed rather than crashing on JSON.parse', async () => {
    const { fetchImpl } = fakeFetch(null, { rawText: '<html>oops</html>' });
    await expect(generateSuggestions('job-1', { fetchImpl, getToken })).rejects.toMatchObject({
      kind: 'malformed_response',
    });
  });
});

describe('isValidSuggestionsPayload', () => {
  it('accepts a valid payload and an empty list', () => {
    expect(isValidSuggestionsPayload(VALID)).toBe(true);
    expect(isValidSuggestionsPayload({ ...VALID, suggestions: [] })).toBe(true);
    expect(isValidSuggestionsPayload({ ...VALID, schemaVersion: 2 })).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['an old version', { ...VALID, schemaVersion: 0 }],
    ['an unknown priority', { ...VALID, suggestions: [{ ...SUGGESTION, priority: 'urgent' }] }],
    ['a ninth field', { ...VALID, suggestions: [{ ...SUGGESTION, extra: 1 }] }],
    ['too many', { ...VALID, suggestions: Array.from({ length: SUGGESTION_MAX + 1 }, (_, i) => ({ ...SUGGESTION, id: `sug_00${i}` })) }],
  ])('rejects %s', (_name, payload) => {
    expect(isValidSuggestionsPayload(payload)).toBe(false);
  });
});

describe('toPersistedSuggestions', () => {
  it('passes a stored envelope through the same validation as a live one', () => {
    expect(toPersistedSuggestions({ schemaVersion: 1, suggestions: [SUGGESTION] })).toEqual({
      schemaVersion: 1,
      suggestions: [SUGGESTION],
    });
  });

  it('distinguishes never-generated from generated-but-empty', () => {
    expect(toPersistedSuggestions(null)).toBeNull();
    expect(toPersistedSuggestions(undefined)).toBeNull();
    expect(toPersistedSuggestions({ schemaVersion: 1, suggestions: [] })).toEqual({
      schemaVersion: 1,
      suggestions: [],
    });
  });

  it.each([
    ['a bare array', [SUGGESTION]],
    ['a missing version', { suggestions: [] }],
    ['a version this build does not know', { schemaVersion: 0, suggestions: [] }],
    ['a missing suggestions list', { schemaVersion: 1 }],
    ['an entry missing evidence', { schemaVersion: 1, suggestions: [{ ...SUGGESTION, jobEvidence: '' }] }],
    ['an unknown enum value', { schemaVersion: 1, suggestions: [{ ...SUGGESTION, priority: 'urgent' }] }],
    ['an unknown extra field', { schemaVersion: 1, suggestions: [{ ...SUGGESTION, targetSection: 'skills' }] }],
  ])('refuses %s rather than rendering a guess', (_name, payload) => {
    expect(toPersistedSuggestions(payload)).toBeNull();
  });
});
