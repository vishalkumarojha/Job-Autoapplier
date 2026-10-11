import { InvalidResumesResponseError, listResumes } from '../resumes';
import { ApiError, NotAuthenticatedError } from '../errors';
import type { FetchLike } from '../client';
import { API_BASE_URL_ENV_VAR } from '../../config/env';
import { RESUME_SCHEMA_VERSION } from '../../domain/resume';

const BASE = 'https://api.example.test';
const TOKEN = 'tok-abc';

// The Vercel route returns a flat `{ resumes }` body. The legacy Apps Script envelope
// (`{ ok, data }`) is deliberately not adopted here; that is a different transport.
function payload(resumes: unknown[]) {
  return { resumes };
}

// Mirrors the exact field names `GET /api/resumes` returns in the jobemailer backend.
const VALID = {
  resumeId: 'rsv_abc123',
  schemaVersion: RESUME_SCHEMA_VERSION,
  resumeLabel: 'Backend — Go — v3',
  targetRole: 'Backend Engineer',
  targetRoleFamily: 'backend',
  version: 3,
  isDefault: true,
  keywords: ['Go', 'PostgreSQL'],
  updatedAt: '2026-02-01T09:00:00.000Z',
  lastUsedAt: null,
};

function fakeFetch(body: unknown, init: { status?: number } = {}): { fetchImpl: FetchLike; calls: { url: string; init?: RequestInit }[] } {
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

// `listResumes` defaults its token function to `requireIdToken`, which reaches Firebase.
// Mocking the specifier keeps the real ESM bundle out of this run; the default-token
// behaviour itself is covered in `authToken.test.ts`.
jest.mock('../../services/firebase', () => ({
  auth: { currentUser: null },
}));

beforeEach(() => {
  process.env[API_BASE_URL_ENV_VAR] = BASE;
});

describe('listResumes', () => {
  it('GETs /api/resumes with a bearer token', async () => {
    const { fetchImpl, calls } = fakeFetch(payload([VALID]));
    await listResumes({ fetchImpl, getToken });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/resumes`);
    expect(calls[0].init?.method).toBe('GET');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('maps a well-formed payload onto ResumeSummary', async () => {
    const { fetchImpl } = fakeFetch(payload([VALID]));
    const [resume] = await listResumes({ fetchImpl, getToken });
    expect(resume).toEqual({ ...VALID, keywords: ['go', 'postgresql'] });
  });

  it('lowercases keywords so filtering is case-insensitive', async () => {
    const { fetchImpl } = fakeFetch(payload([{ ...VALID, keywords: ['Go', 'AWS', 'Kubernetes'] }]));
    const [resume] = await listResumes({ fetchImpl, getToken });
    expect(resume.keywords).toEqual(['go', 'aws', 'kubernetes']);
  });

  it('returns an empty list for an empty catalog', async () => {
    const { fetchImpl } = fakeFetch(payload([]));
    await expect(listResumes({ fetchImpl, getToken })).resolves.toEqual([]);
  });

  it('accepts a null targetRole, targetRoleFamily, and lastUsedAt', async () => {
    const { fetchImpl } = fakeFetch(
      payload([{ ...VALID, targetRole: null, targetRoleFamily: null, lastUsedAt: null }]),
    );
    const [resume] = await listResumes({ fetchImpl, getToken });
    expect(resume.targetRole).toBeNull();
    expect(resume.targetRoleFamily).toBeNull();
    expect(resume.lastUsedAt).toBeNull();
  });

  it('defaults missing keywords to an empty list', async () => {
    const { fetchImpl } = fakeFetch(payload([{ ...VALID, keywords: undefined }]));
    const [resume] = await listResumes({ fetchImpl, getToken });
    expect(resume.keywords).toEqual([]);
  });

  it('preserves an unknown role family rather than hiding the resume', async () => {
    const { fetchImpl } = fakeFetch(payload([{ ...VALID, targetRoleFamily: 'hardware' }]));
    const [resume] = await listResumes({ fetchImpl, getToken });
    expect(resume.targetRoleFamily).toBe('hardware');
  });

  it('drops unexpected fields so server-only data cannot reach the device', async () => {
    const { fetchImpl } = fakeFetch(
      payload([
        {
          ...VALID,
          driveFileId: '1Abc-drive-id',
          driveFileName: 'resume.pdf',
          pdfUrl: 'https://drive.google.com/x',
          extractedText: 'JANE DOE BACKEND ENGINEER',
          contentHash: 'deadbeef',
          anthropicApiKey: 'FAKE-CREDENTIAL-FOR-TEST',
        },
      ]),
    );
    const [resume] = await listResumes({ fetchImpl, getToken });
    const serialized = JSON.stringify(resume);
    for (const forbidden of [
      'driveFileId',
      '1Abc-drive-id',
      'driveFileName',
      'pdfUrl',
      'extractedText',
      'JANE DOE',
      'contentHash',
      'deadbeef',
      'anthropicApiKey',
      'FAKE-CREDENTIAL-FOR-TEST',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(resume).sort()).toEqual(
      [
        'isDefault',
        'keywords',
        'lastUsedAt',
        'resumeId',
        'resumeLabel',
        'schemaVersion',
        'targetRole',
        'targetRoleFamily',
        'updatedAt',
        'version',
      ].sort(),
    );
  });

  it('surfaces a 401 as an auth problem', async () => {
    const { fetchImpl } = fakeFetch({ error: 'Invalid token' }, { status: 401 });
    const error = await listResumes({ fetchImpl, getToken }).catch((e) => e as ApiError);
    expect((error as ApiError).kind).toBe('unauthorized');
    expect((error as ApiError).isAuthProblem).toBe(true);
  });

  it('never sends an unauthenticated request when signed out', async () => {
    const { fetchImpl, calls } = fakeFetch(payload([VALID]));
    // Omit getToken so the real requireIdToken default applies.
    const signedOut = async () => {
      throw new NotAuthenticatedError();
    };
    const error = await listResumes({ fetchImpl, getToken: signedOut as unknown as () => Promise<string> }).catch(
      (e) => e as ApiError,
    );
    expect((error as ApiError).kind).toBe('not_authenticated');
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['resumes missing', { ok: true }],
    ['resumes not an array', { resumes: 'nope' }],
    ['entry not an object', { resumes: ['plain string'] }],
  ])('rejects %s', async (_label, body) => {
    const { fetchImpl } = fakeFetch(body);
    await expect(listResumes({ fetchImpl, getToken })).rejects.toBeInstanceOf(InvalidResumesResponseError);
  });

  it.each([
    ['resumeId', { resumeId: undefined }],
    ['resumeLabel', { resumeLabel: '' }],
    ['version', { version: 'three' }],
    ['isDefault', { isDefault: 'yes' }],
    ['updatedAt', { updatedAt: 12345 }],
    ['keywords', { keywords: [1, 2] }],
  ])('rejects an entry with a bad %s', async (field, override) => {
    const { fetchImpl } = fakeFetch(payload([{ ...VALID, ...override }]));
    await expect(listResumes({ fetchImpl, getToken })).rejects.toBeInstanceOf(InvalidResumesResponseError);
  });

  it('rejects an entry whose schemaVersion predates this client', async () => {
    const { fetchImpl } = fakeFetch(payload([{ ...VALID, schemaVersion: RESUME_SCHEMA_VERSION - 1 }]));
    const error = await listResumes({ fetchImpl, getToken }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(InvalidResumesResponseError);
    expect((error as Error).message).toContain('too old');
  });

  it('accepts a newer schemaVersion rather than hiding the record', async () => {
    const { fetchImpl } = fakeFetch(payload([{ ...VALID, schemaVersion: RESUME_SCHEMA_VERSION + 1 }]));
    const [resume] = await listResumes({ fetchImpl, getToken });
    expect(resume.schemaVersion).toBe(RESUME_SCHEMA_VERSION + 1);
  });
});
