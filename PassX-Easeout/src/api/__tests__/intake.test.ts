import { INTAKE_MAX_RAW_CHARS, intakeJob, toJobIntakeResult, InvalidIntakeResponseError } from '../intake';
import { ApiError, NotAuthenticatedError } from '../errors';
import type { FetchLike } from '../client';
import { API_BASE_URL_ENV_VAR } from '../../config/env';
import { JOB_INTAKE_SCHEMA_VERSION, JOB_RAW_SOURCES, type JobRawSource } from '../../domain/job';

const BASE = 'https://api.example.test';
const TOKEN = 'tok-abc';
const RAW = 'Senior Backend Engineer — Example Corp\nApply at jobs@bigcorp.example';

// Mirrors the exact field names `POST /api/intake` returns in the jobemailer backend.
const VALID = {
  schemaVersion: JOB_INTAKE_SCHEMA_VERSION,
  source: 'linkedin',
  company: 'Example Corp',
  contactName: 'Priya Sharma',
  contactEmail: 'priya.sharma@example.com',
  role: 'Senior Backend Engineer',
  jobUrl: 'https://example.com/jobs/backend-42',
  location: 'Bangalore / Remote',
  notes: 'Visa sponsorship available.',
  deadline: '2026-10-12T00:00:00.000Z',
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

function fakeFetch(
  body: unknown,
  init: { status?: number } = {},
): { fetchImpl: FetchLike; calls: { url: string; init?: RequestInit }[] } {
  const status = init.status ?? 200;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, reqInit) => {
    calls.push({ url, init: reqInit });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

const getToken = async () => TOKEN;

// `intakeJob` defaults its token function to `requireIdToken`, which reaches Firebase.
// Mocking the specifier keeps the real ESM bundle out of this run; the default-token
// behaviour itself is covered in `authToken.test.ts`.
jest.mock('../../services/firebase', () => ({
  auth: { currentUser: null },
}));

beforeEach(() => {
  process.env[API_BASE_URL_ENV_VAR] = BASE;
});

describe('intakeJob transport', () => {
  it('POSTs /api/intake with a bearer token and the posting', async () => {
    const { fetchImpl, calls } = fakeFetch(VALID);
    await intakeJob(RAW, 'linkedin', { fetchImpl, getToken });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/intake`);
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ rawText: RAW, source: 'linkedin' });
  });

  it('sends every value from the agreed capture-channel vocabulary', async () => {
    for (const source of JOB_RAW_SOURCES) {
      const { fetchImpl, calls } = fakeFetch({ ...VALID, source });
      const result = await intakeJob(RAW, source, { fetchImpl, getToken });
      expect(result.source).toBe(source);
      expect(JSON.parse(calls[0].init?.body as string)).toEqual({ rawText: RAW, source });
    }
  });

  it('turns a caller-initiated abort into a benign `canceled` error', async () => {
    // The screen unmounts (or the user backs out) mid-extraction; that is an expected
    // outcome, and it must arrive as `isBenign` rather than an error banner.
    const controller = new AbortController();
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const fail = () => reject(new Error('The operation was aborted.'));
        if (signal?.aborted) fail();
        else signal?.addEventListener('abort', fail);
      });

    const pending = intakeJob(RAW, 'paste', { fetchImpl, getToken, signal: controller.signal });
    controller.abort();

    const error = (await pending.catch((caught) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe('canceled');
    expect(error.isBenign).toBe(true);
  });

  it('never sends an unauthenticated request when signed out', async () => {
    const { fetchImpl, calls } = fakeFetch(VALID);
    // Omit getToken so the real requireIdToken default applies.
    const signedOut = async () => {
      throw new NotAuthenticatedError();
    };
    const error = (await intakeJob(RAW, 'paste', { fetchImpl, getToken: signedOut as unknown as () => Promise<string> }).catch(
      (caught) => caught,
    )) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe('not_authenticated');
    expect(calls).toHaveLength(0);
  });

  it('maps HTTP statuses onto ApiError kinds', async () => {
    const cases: Array<[number, string]> = [
      [400, 'client'],
      [401, 'unauthorized'],
      [404, 'not_found'],
      [500, 'server'],
    ];
    for (const [status, kind] of cases) {
      const { fetchImpl } = fakeFetch({ error: 'nope' }, { status });
      const error = await intakeJob(RAW, 'paste', { fetchImpl, getToken }).catch((caught) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).kind).toBe(kind);
      expect((error as ApiError).status).toBe(status);
    }
  });

  it('surfaces the server\'s own 400 message, which describes the caller\'s request', async () => {
    const { fetchImpl } = fakeFetch({ error: 'Paste a job posting before extracting.' }, { status: 400 });
    const error = (await intakeJob(RAW, 'paste', { fetchImpl, getToken }).catch((caught) => caught)) as ApiError;
    expect(error.message).toBe('Paste a job posting before extracting.');
    expect(error.isBenign).toBe(false);
  });
});

describe('toJobIntakeResult', () => {
  it('maps a well-formed payload onto JobIntakeResult', () => {
    expect(toJobIntakeResult(VALID)).toEqual(VALID);
  });

  it('keeps every documented field', () => {
    expect(Object.keys(toJobIntakeResult(VALID)).sort()).toEqual([
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
  });

  it.each([
    ['a non-object body', 'nonsense'],
    ['an array body', [VALID]],
    ['a null body', null],
  ])('rejects %s', (_name, body) => {
    expect(() => toJobIntakeResult(body)).toThrow(InvalidIntakeResponseError);
  });

  it('rejects a schemaVersion older than this client understands', () => {
    expect(() => toJobIntakeResult({ ...VALID, schemaVersion: 0 })).toThrow(/schemaVersion 0 is too old/);
  });

  it('accepts a newer schemaVersion so an upgraded server still renders', () => {
    expect(() => toJobIntakeResult({ ...VALID, schemaVersion: 2 })).not.toThrow();
  });

  it('rejects a source outside the capture-channel vocabulary', () => {
    expect(() => toJobIntakeResult({ ...VALID, source: 'telepathy' })).toThrow(/not a known source/);
    expect(() => toJobIntakeResult({ ...VALID, source: 42 })).toThrow(InvalidIntakeResponseError);
  });

  it.each([
    ['company', { company: 42 }],
    ['role', { role: ['a'] }],
    ['contactEmail', { contactEmail: 7 }],
    ['notes', { notes: true }],
    ['jobUrl', { jobUrl: 12 }],
    ['location', { location: {} }],
    ['contactName', { contactName: [] }],
  ])('rejects a non-string %s', (field, override) => {
    expect(() => toJobIntakeResult({ ...VALID, ...override })).toThrow(`${field} is not a string`);
  });

  it('accepts null for every optional string field', () => {
    const result = toJobIntakeResult({
      ...VALID,
      company: null,
      contactName: null,
      contactEmail: null,
      role: null,
      jobUrl: null,
      location: null,
      notes: null,
      deadline: null,
    });
    expect(result.company).toBeNull();
    expect(result.deadline).toBeNull();
  });

  it('rejects a deadline that is not a real date', () => {
    expect(() => toJobIntakeResult({ ...VALID, deadline: 'tomorrow' })).toThrow(/deadline is not a valid date/);
    expect(() => toJobIntakeResult({ ...VALID, deadline: 'No Deadline' })).toThrow(/deadline is not a valid date/);
    expect(() => toJobIntakeResult({ ...VALID, deadline: 42 })).toThrow(/deadline is not a string/);
  });

  describe('fieldConfidence', () => {
    it('keeps values in range', () => {
      expect(toJobIntakeResult(VALID).fieldConfidence).toEqual(VALID.fieldConfidence);
    });

    it('drops keys the app has never heard of', () => {
      const result = toJobIntakeResult({
        ...VALID,
        fieldConfidence: { ...VALID.fieldConfidence, salary: 0.5, 'candidate-fit': 1 },
      });
      expect(result.fieldConfidence).not.toHaveProperty('salary');
      expect(result.fieldConfidence).not.toHaveProperty('candidate-fit');
    });

    it('leaves an absent key absent rather than inventing a zero', () => {
      const { deadline: _dropped, ...partial } = VALID.fieldConfidence;
      const result = toJobIntakeResult({ ...VALID, fieldConfidence: partial });
      expect(result.fieldConfidence).not.toHaveProperty('deadline');
      expect(result.fieldConfidence.company).toBe(0.98);
    });

    it('rejects out-of-range and non-numeric values', () => {
      expect(() =>
        toJobIntakeResult({ ...VALID, fieldConfidence: { company: 1.5 } }),
      ).toThrow(/not a number between 0 and 1/);
      expect(() =>
        toJobIntakeResult({ ...VALID, fieldConfidence: { company: -0.1 } }),
      ).toThrow(/not a number between 0 and 1/);
      expect(() =>
        toJobIntakeResult({ ...VALID, fieldConfidence: { company: 'high' } }),
      ).toThrow(/not a number between 0 and 1/);
      expect(() => toJobIntakeResult({ ...VALID, fieldConfidence: [] })).toThrow(/not an object/);
      expect(() => toJobIntakeResult({ ...VALID, fieldConfidence: 'high' })).toThrow(/not an object/);
    });
  });

  it('drops unknown keys rather than forwarding them to a screen', () => {
    const result = toJobIntakeResult({ ...VALID, rawText: 'should not travel back', salary: '$120k' });
    expect(result).not.toHaveProperty('rawText');
    expect(result).not.toHaveProperty('salary');
  });

  it('is the same parser intakeJob applies to a live response', async () => {
    const { fetchImpl } = fakeFetch({ ...VALID, bogus: true });
    const result = await intakeJob(RAW, 'linkedin', { fetchImpl, getToken });
    expect(result).toEqual(toJobIntakeResult(VALID));
  });
});

describe('intake vocabulary', () => {
  it('matches the server-side source list exactly', () => {
    // One vocabulary lives in both repos; a drift here would show up as a 400 in
    // production rather than at compile time, so the list is pinned.
    expect([...JOB_RAW_SOURCES]).toEqual([
      'paste',
      'share_android',
      'manual',
      'email',
      'linkedin',
      'x',
      'referral',
      'other',
    ]);
    const sources: JobRawSource[] = [...JOB_RAW_SOURCES];
    expect(sources).toHaveLength(8);
  });

  it('mirrors the server-side length limit so the screen can reject before spending a request', () => {
    expect(INTAKE_MAX_RAW_CHARS).toBe(20000);
  });
});
