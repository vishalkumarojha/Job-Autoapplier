import { sendApplication, InvalidSendResponseError } from '../send';
import type { FetchLike } from '../client';
import { API_BASE_URL_ENV_VAR } from '../../config/env';

beforeEach(() => { process.env[API_BASE_URL_ENV_VAR] = 'https://api.example.test'; });

jest.mock('../../services/firebase', () => ({ auth: () => ({ currentUser: null }) }));

function response(status: number, payload: unknown): Response {
  return {
    status, ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload),
  } as Response;
}

it('posts only the job id with the Firebase bearer token and validates the response', async () => {
  const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockResolvedValue(response(200, {
    schemaVersion: 1, jobId: 'job-1', message: 'Application sent.', threadId: 'thread-1', sentAt: '2026-10-05T10:00:00.000Z',
  }));
  const result = await sendApplication('job-1', { fetchImpl, getToken: async () => 'firebase-id-token' });
  expect(result.threadId).toBe('thread-1');
  expect(fetchImpl.mock.calls[0][0]).toContain('/api/send');
  const init = fetchImpl.mock.calls[0][1] as RequestInit;
  expect(init.headers).toMatchObject({ Authorization: 'Bearer firebase-id-token' });
  expect(JSON.parse(String(init.body))).toEqual({ jobId: 'job-1' });
});

it('rejects a response for a different job id and invalid response shapes', async () => {
  await expect(sendApplication('job-1', {
    getToken: async () => 't', fetchImpl: async () => response(200, {
      schemaVersion: 1, jobId: 'job-2', message: 'ok', threadId: null, sentAt: '2026-10-05T10:00:00Z',
    }),
  })).rejects.toBeInstanceOf(InvalidSendResponseError);
  await expect(sendApplication('job-1', {
    getToken: async () => 't', fetchImpl: async () => response(200, { schemaVersion: 1 }),
  })).rejects.toBeInstanceOf(InvalidSendResponseError);
});

it.each([
  [401, 'unauthorized'],
  [404, 'not_found'],
  [409, 'client'],
  [500, 'server'],
  ] as const)('maps HTTP %s to the established API error', async (status, kind) => {
  await expect(sendApplication('job-1', {
    getToken: async () => 't', fetchImpl: async () => response(status, { error: 'Safe failure.' }),
  })).rejects.toMatchObject({ kind });
});

it('forwards cancellation to the HTTP client', async () => {
  const controller = new AbortController();
  const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>().mockImplementation(async (_url, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    return response(200, { schemaVersion: 1, jobId: 'job-1', message: 'ok', threadId: null, sentAt: '2026-10-05T10:00:00Z' });
  });
  await sendApplication('job-1', { fetchImpl, getToken: async () => 't', signal: controller.signal });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
