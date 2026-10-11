import { InvalidMatchResponseError, matchJob } from '../match';
import { ApiError, NotAuthenticatedError } from '../errors';
import type { FetchLike } from '../client';
import { API_BASE_URL_ENV_VAR } from '../../config/env';
import { JOB_MATCH_SCHEMA_VERSION, MATCH_CRITERIA } from '../../domain/job';

const BASE = 'https://api.example.test';
const TOKEN = 'tok-abc';

const VALID = {
  schemaVersion: JOB_MATCH_SCHEMA_VERSION,
  jobId: 'job-1',
  selectedResumeId: 'rsv_alpha',
  matchScore: 91,
  matchBreakdown: [
    { criterion: 'must_have', score: 94, weight: 0.35, rationale: 'Go and PostgreSQL throughout.' },
    { criterion: 'nice_to_have', score: 84, weight: 0.15, rationale: 'Kubernetes in project work.' },
    { criterion: 'seniority', score: 90, weight: 0.2, rationale: 'Seven years, senior level.' },
    { criterion: 'role_alignment', score: 95, weight: 0.2, rationale: 'Comparable payments role.' },
    { criterion: 'technology_alignment', score: 89, weight: 0.1, rationale: 'Go, PostgreSQL, Kubernetes.' },
  ],
  rankings: [
    { resumeId: 'rsv_alpha', score: 91 },
    { resumeId: 'rsv_beta', score: 82 },
    { resumeId: 'rsv_gamma', score: 74 },
  ],
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

describe('matchJob transport', () => {
  it('POSTs /api/match with a bearer token and only the jobId in the body', async () => {
    const { fetchImpl, calls } = fakeFetch(VALID);
    await matchJob('job-1', { fetchImpl, getToken });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/match`);
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ jobId: 'job-1' });
  });

  it('never puts a uid in the request body', async () => {
    const { fetchImpl, calls } = fakeFetch(VALID);
    await matchJob('job-1', { fetchImpl, getToken });
    expect(Object.keys(JSON.parse(String(calls[0].init?.body)))).toEqual(['jobId']);
  });

  it('fails before the request when nobody is signed in', async () => {
    const { fetchImpl, calls } = fakeFetch(VALID);
    await expect(matchJob('job-1', { fetchImpl, getToken: noSession })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
  });

  it('maps status codes onto ApiError kinds', async () => {
    const cases: Array<[number, string]> = [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'client'],
      [500, 'server'],
    ];
    for (const [status, kind] of cases) {
      const { fetchImpl } = fakeFetch({ error: 'nope' }, { status });
      const error = await matchJob('job-1', { fetchImpl, getToken }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).kind).toBe(kind);
      expect((error as ApiError).status).toBe(status);
    }
  });

  it('reports an HTML error page as a server error rather than a parse failure', async () => {
    const { fetchImpl } = fakeFetch(null, { status: 502, rawText: '<html>Bad Gateway</html>' });
    const error = await matchJob('job-1', { fetchImpl, getToken }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('server');
    expect(String((error as ApiError).message)).not.toContain('<html>');
  });

  it('surfaces a cancelled call as a benign error', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl } = fakeFetch(VALID);
    const error = await matchJob('job-1', { fetchImpl, getToken, signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('canceled');
    expect((error as ApiError).isBenign).toBe(true);
  });
});

describe('matchJob payload validation', () => {
  /** Runs a mutated copy of the happy payload and returns the rejection. */
  async function rejects(mutate: (draft: Record<string, unknown>) => void): Promise<unknown> {
    const draft: Record<string, unknown> = JSON.parse(JSON.stringify(VALID));
    mutate(draft);
    const { fetchImpl } = fakeFetch(draft);
    return matchJob('job-1', { fetchImpl, getToken }).catch((e: unknown) => e);
  }

  it('accepts a valid payload and returns only the allow-listed fields', async () => {
    const { fetchImpl } = fakeFetch({ ...VALID, anythingElse: 'drop me' });
    const result = await matchJob('job-1', { fetchImpl, getToken });

    expect(Object.keys(result).sort()).toEqual([
      'jobId',
      'matchBreakdown',
      'matchScore',
      'rankings',
      'schemaVersion',
      'selectedResumeId',
    ]);
    expect(result.selectedResumeId).toBe('rsv_alpha');
    expect(result.matchScore).toBe(91);
    expect(result.matchBreakdown).toHaveLength(MATCH_CRITERIA.length);
    expect(result.matchBreakdown.map((entry) => entry.criterion)).toEqual([...MATCH_CRITERIA]);
    expect(result.rankings).toHaveLength(3);
  });

  it('accepts a schemaVersion newer than this build understands', async () => {
    const { fetchImpl } = fakeFetch({ ...VALID, schemaVersion: JOB_MATCH_SCHEMA_VERSION + 7 });
    await expect(matchJob('job-1', { fetchImpl, getToken })).resolves.toMatchObject({ schemaVersion: 8 });
  });

  it('refuses a schemaVersion older than this build understands', async () => {
    const error = await rejects((draft) => {
      draft.schemaVersion = 0;
    });
    expect(error).toBeInstanceOf(InvalidMatchResponseError);
    expect(String(error)).toContain('too old');
  });

  it('drops a criterion this version does not know about', async () => {
    const { fetchImpl } = fakeFetch({
      ...VALID,
      matchBreakdown: [...VALID.matchBreakdown, { criterion: 'visa_sponsorship', score: 10, weight: 0.05 }],
    });
    const result = await matchJob('job-1', { fetchImpl, getToken });
    expect(result.matchBreakdown).toHaveLength(5);
    expect(result.matchBreakdown.some((entry) => entry.criterion === 'visa_sponsorship')).toBe(false);
  });

  it('refuses a breakdown that contains no known criterion', async () => {
    const error = await rejects((draft) => {
      draft.matchBreakdown = [{ criterion: 'visa_sponsorship', score: 10, weight: 0.05 }];
    });
    expect(error).toBeInstanceOf(InvalidMatchResponseError);
    expect(String(error)).toContain('no criterion this version understands');
  });

  it.each<[string, number]>([
    ['below range', -1],
    ['above range', 101],
    ['not an integer', 91.5],
  ])('refuses matchScore %s', async (_label, score) => {
    const error = await rejects((draft) => {
      draft.matchScore = score;
    });
    expect(error).toBeInstanceOf(InvalidMatchResponseError);
    expect(String(error)).toContain('matchScore is not an integer between 0 and 100');
  });

  it('refuses a breakdown score outside 0..100', async () => {
    const error = await rejects((draft) => {
      (draft.matchBreakdown as Array<Record<string, unknown>>)[0].score = 140;
    });
    expect(error).toBeInstanceOf(InvalidMatchResponseError);
  });

  it('refuses a missing weight rather than defaulting it', async () => {
    const error = await rejects((draft) => {
      delete (draft.matchBreakdown as Array<Record<string, unknown>>)[0].weight;
    });
    expect(error).toBeInstanceOf(InvalidMatchResponseError);
    expect(String(error)).toContain('weight');
  });

  it('allows a null rationale', async () => {
    const { fetchImpl } = fakeFetch({
      ...VALID,
      matchBreakdown: VALID.matchBreakdown.map((entry) => ({ ...entry, rationale: null })),
    });
    const result = await matchJob('job-1', { fetchImpl, getToken });
    expect(result.matchBreakdown.every((entry) => entry.rationale === null)).toBe(true);
  });

  it('refuses duplicate ranking ids', async () => {
    const error = await rejects((draft) => {
      draft.rankings = [{ resumeId: 'rsv_alpha', score: 91 }, { resumeId: 'rsv_alpha', score: 90 }];
    });
    expect(error).toBeInstanceOf(InvalidMatchResponseError);
    expect(String(error)).toContain('appears twice');
  });

  it('refuses rankings that are not ordered highest first', async () => {
    const error = await rejects((draft) => {
      draft.rankings = [{ resumeId: 'rsv_alpha', score: 40 }, { resumeId: 'rsv_beta', score: 99 }];
    });
    expect(error).toBeInstanceOf(InvalidMatchResponseError);
    expect(String(error)).toContain('not ordered');
  });

  it('tolerates a tie, which is a legitimate outcome', async () => {
    const { fetchImpl } = fakeFetch({
      ...VALID,
      matchScore: 91,
      rankings: [{ resumeId: 'rsv_alpha', score: 91 }, { resumeId: 'rsv_beta', score: 91 }],
    });
    await expect(matchJob('job-1', { fetchImpl, getToken })).resolves.toBeTruthy();
  });

  it('refuses an empty rankings list', async () => {
    const error = await rejects((draft) => {
      draft.rankings = [];
    });
    expect(error).toBeInstanceOf(InvalidMatchResponseError);
    expect(String(error)).toContain('rankings was empty');
  });

  it('refuses a selected resume that is not in the rankings', async () => {
    const error = await rejects((draft) => {
      draft.selectedResumeId = 'rsv_zzz';
    });
    expect(error).toBeInstanceOf(InvalidMatchResponseError);
    expect(String(error)).toContain('not in rankings');
  });

  it('refuses a response that is not an object', async () => {
    for (const raw of ['[]', '"score"', 42, null]) {
      const { fetchImpl } = fakeFetch(raw);
      const error = await matchJob('job-1', { fetchImpl, getToken }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidMatchResponseError);
    }
  });

  it('reports malformed JSON as a transport failure, not a validation failure', async () => {
    const { fetchImpl } = fakeFetch(null, { rawText: 'Here is the match: rsv_alpha scored 91.' });
    const error = await matchJob('job-1', { fetchImpl, getToken }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('malformed_response');
    expect(error).not.toBeInstanceOf(InvalidMatchResponseError);
  });
});
