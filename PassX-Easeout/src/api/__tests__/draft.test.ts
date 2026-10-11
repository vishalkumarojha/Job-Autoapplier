import {
  DRAFT_MAX_MESSAGE_CHARS,
  DRAFT_MAX_SUBJECT_CHARS,
  DRAFT_SCHEMA_VERSION,
  InvalidDraftResponseError,
  generateDraft,
  isValidDraftPayload,
} from '../draft';
import { ApiError, NotAuthenticatedError } from '../errors';
import type { FetchLike } from '../client';
import { API_BASE_URL_ENV_VAR } from '../../config/env';

const BASE = 'https://api.example.test';
const TOKEN = 'tok-abc';

const VALID = {
  schemaVersion: DRAFT_SCHEMA_VERSION,
  jobId: 'job-1',
  draftSubject: 'Senior Backend Engineer at Acme — application',
  draftMessage: 'Hello, I am writing about the Senior Backend Engineer role at Acme.',
  generatedAt: '2026-10-05T09:00:00.000Z',
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

describe('generateDraft transport', () => {
  it('POSTs /api/draft with a bearer token and only the jobId in the body', async () => {
    const { fetchImpl, calls } = fakeFetch(VALID);
    await generateDraft('job-1', { fetchImpl, getToken });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/draft`);
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ jobId: 'job-1' });
  });

  it('never sends a uid, a resume id, or resume text', async () => {
    const { fetchImpl, calls } = fakeFetch(VALID);
    await generateDraft('job-1', { fetchImpl, getToken });

    const sent = String(calls[0].init?.body);
    for (const forbidden of ['uid', 'resumeId', 'extractedText', 'driveFileId', 'selectedResumeId']) {
      expect(sent).not.toContain(forbidden);
    }
  });

  it('never offers a send, approve, or status field alongside the jobId', async () => {
    const { fetchImpl, calls } = fakeFetch(VALID);
    await generateDraft('job-1', { fetchImpl, getToken });

    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['jobId']);
    for (const forbidden of ['send', 'approve', 'applicationStatus', 'draftSubject', 'draftMessage']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('fails as not_authenticated when there is no session', async () => {
    const { fetchImpl } = fakeFetch(VALID);
    await expect(generateDraft('job-1', { fetchImpl, getToken: noSession })).rejects.toThrow(ApiError);
    await expect(generateDraft('job-1', { fetchImpl, getToken: noSession })).rejects.toMatchObject({
      kind: 'not_authenticated',
    });
  });

  it('maps the server rejections onto ApiError kinds', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'unauthorized', 'Authentication required.'],
      [404, 'not_found', 'Job not found.'],
      [409, 'client', 'This job must be confirmed before a draft can be generated.'],
      [409, 'client', 'This job has no selected resume. Run a match first.'],
      [409, 'client', 'This job has no match result. Run a match first.'],
      [409, 'client', 'The selected resume is no longer available in the resume library.'],
      [405, 'client', 'Method GET is not allowed. Use POST.'],
      [500, 'server', 'Unable to generate the outreach draft.'],
      [500, 'server', 'Unable to save the outreach draft.'],
    ];
    for (const [status, kind, message] of cases) {
      const { fetchImpl } = fakeFetch({ error: message }, { status });
      const error = await generateDraft('job-1', { fetchImpl, getToken }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ kind, status, message });
    }
  });

  it('reports a cancellation as a client error rather than a success', async () => {
    const { fetchImpl } = fakeFetch(VALID, { status: 499 });
    const error = await generateDraft('job-1', { fetchImpl, getToken }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('client');
    expect((error as ApiError).isBenign).toBe(false);
  });
});

/** Every payload shape the server could plausibly send that must not be rendered. */
const INVALID: Array<[string, unknown]> = [
  ['a non-object body', 'nope'],
  ['a null body', null],
  ['a missing schemaVersion', { jobId: 'job-1', draftSubject: 's', draftMessage: 'm', generatedAt: VALID.generatedAt }],
  ['a schemaVersion older than this build', { ...VALID, schemaVersion: 0 }],
  ['a non-integer schemaVersion', { ...VALID, schemaVersion: 1.5 }],
  ['a missing jobId', { ...VALID, jobId: '' }],
  ['a whitespace-only jobId', { ...VALID, jobId: '   ' }],
  ['a missing subject', { ...VALID, draftSubject: '' }],
  ['a whitespace-only subject', { ...VALID, draftSubject: '   ' }],
  ['a subject that is not a string', { ...VALID, draftSubject: 42 }],
  ['a missing body', { ...VALID, draftMessage: undefined }],
  ['a body that is not a string', { ...VALID, draftMessage: ['line one'] }],
  ['a subject over the ceiling', { ...VALID, draftSubject: 'x'.repeat(DRAFT_MAX_SUBJECT_CHARS + 1) }],
  ['a body over the ceiling', { ...VALID, draftMessage: 'x'.repeat(DRAFT_MAX_MESSAGE_CHARS + 1) }],
  ['a missing generatedAt', { ...VALID, generatedAt: undefined }],
  ['a generatedAt that is not a timestamp', { ...VALID, generatedAt: 'whenever' }],
  ['a generatedAt that is a number', { ...VALID, generatedAt: 1759645200000 }],
];

describe('generateDraft response validation', () => {
  it('returns the validated draft', async () => {
    const { fetchImpl } = fakeFetch(VALID);
    const result = await generateDraft('job-1', { fetchImpl, getToken });

    expect(result.schemaVersion).toBe(DRAFT_SCHEMA_VERSION);
    expect(result.jobId).toBe('job-1');
    expect(result.draftSubject).toBe(VALID.draftSubject);
    expect(result.draftMessage).toBe(VALID.draftMessage);
    expect(result.generatedAt).toBe(VALID.generatedAt);
    expect(Object.keys(result).sort()).toEqual([
      'draftMessage',
      'draftSubject',
      'generatedAt',
      'jobId',
      'schemaVersion',
    ]);
  });

  it('trims surrounding whitespace rather than rejecting it', async () => {
    const { fetchImpl } = fakeFetch({
      ...VALID,
      draftSubject: `  ${VALID.draftSubject}  `,
      draftMessage: `\n${VALID.draftMessage}\n`,
    });
    const result = await generateDraft('job-1', { fetchImpl, getToken });
    expect(result.draftSubject).toBe(VALID.draftSubject);
    expect(result.draftMessage).toBe(VALID.draftMessage);
  });

  it('accepts the subject and body ceilings themselves', async () => {
    const { fetchImpl } = fakeFetch({
      ...VALID,
      draftSubject: 'x'.repeat(DRAFT_MAX_SUBJECT_CHARS),
      draftMessage: 'x'.repeat(DRAFT_MAX_MESSAGE_CHARS),
    });
    const result = await generateDraft('job-1', { fetchImpl, getToken });
    expect(result.draftSubject).toHaveLength(DRAFT_MAX_SUBJECT_CHARS);
    expect(result.draftMessage).toHaveLength(DRAFT_MAX_MESSAGE_CHARS);
  });

  it.each(INVALID)('rejects %s', async (_name, payload) => {
    const { fetchImpl } = fakeFetch(payload);
    await expect(generateDraft('job-1', { fetchImpl, getToken })).rejects.toBeInstanceOf(
      InvalidDraftResponseError,
    );
  });

  it('accepts a newer envelope version rather than refusing a future server', async () => {
    const { fetchImpl } = fakeFetch({ ...VALID, schemaVersion: DRAFT_SCHEMA_VERSION + 1 });
    const result = await generateDraft('job-1', { fetchImpl, getToken });
    expect(result.schemaVersion).toBe(DRAFT_SCHEMA_VERSION + 1);
  });

  it('ignores envelope fields this build does not know rather than rejecting them', async () => {
    const { fetchImpl } = fakeFetch({ ...VALID, leadEmail: 'someone@example.test' });
    const result = await generateDraft('job-1', { fetchImpl, getToken });
    expect(result).not.toHaveProperty('leadEmail');
    expect(result.draftSubject).toBe(VALID.draftSubject);
  });

  it('reports an HTML error page as malformed rather than crashing on JSON.parse', async () => {
    const { fetchImpl } = fakeFetch(null, { rawText: '<html>oops</html>' });
    await expect(generateDraft('job-1', { fetchImpl, getToken })).rejects.toMatchObject({
      kind: 'malformed_response',
    });
  });
});

describe('isValidDraftPayload', () => {
  it('accepts a valid payload and a future version', () => {
    expect(isValidDraftPayload(VALID)).toBe(true);
    expect(isValidDraftPayload({ ...VALID, schemaVersion: DRAFT_SCHEMA_VERSION + 1 })).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['an old version', { ...VALID, schemaVersion: 0 }],
    ['a missing subject', { ...VALID, draftSubject: '' }],
    ['a non-string body', { ...VALID, draftMessage: 7 }],
    ['an unparseable timestamp', { ...VALID, generatedAt: 'soon' }],
    ['a body over the ceiling', { ...VALID, draftMessage: 'x'.repeat(DRAFT_MAX_MESSAGE_CHARS + 1) }],
  ])('rejects %s', (_name, payload) => {
    expect(isValidDraftPayload(payload)).toBe(false);
  });
});
