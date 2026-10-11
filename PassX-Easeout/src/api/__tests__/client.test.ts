import { apiRequest, type FetchLike } from '../client';
import { ApiError, NotAuthenticatedError } from '../errors';
import { API_BASE_URL_ENV_VAR } from '../../config/env';

const BASE = 'https://api.example.test';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function recordingFetch(response: Response | (() => Promise<Response>)): {
  fetchImpl: FetchLike;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response() : response;
  };
  return { fetchImpl, calls };
}

beforeEach(() => {
  process.env[API_BASE_URL_ENV_VAR] = BASE;
});

describe('apiRequest', () => {
  it('calls the configured base URL with the given path', async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({ ok: true }));
    await apiRequest<{ ok: boolean }>('/api/resumes', {}, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/resumes`);
  });

  it('defaults to GET and sends no body', async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({}));
    await apiRequest('/api/resumes', {}, fetchImpl);
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.body).toBeUndefined();
  });

  it('serializes a JSON body and sets the content type', async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({}));
    await apiRequest('/api/x', { method: 'POST', body: { a: 1 } }, fetchImpl);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(calls[0].init?.body).toBe('{"a":1}');
  });

  it('attaches the bearer token returned by getToken', async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({}));
    await apiRequest('/api/resumes', { getToken: async () => 'tok-123' }, fetchImpl);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
  });

  it('sends no Authorization header when getToken returns null', async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({}));
    await apiRequest('/api/resumes', { getToken: async () => null }, fetchImpl);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws not_authenticated when the token function rejects with NotAuthenticatedError', async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({}));
    const getToken = async () => {
      throw new NotAuthenticatedError();
    };
    await expect(apiRequest('/api/resumes', { getToken }, fetchImpl)).rejects.toMatchObject({
      kind: 'not_authenticated',
    });
    // Critically: no unauthenticated request escaped to the network.
    expect(calls).toHaveLength(0);
  });

  it('decodes a JSON body', async () => {
    const { fetchImpl } = recordingFetch(jsonResponse({ resumes: [{ id: 'r1' }] }));
    await expect(apiRequest<{ resumes: { id: string }[] }>('/api/resumes', {}, fetchImpl)).resolves.toEqual({
      resumes: [{ id: 'r1' }],
    });
  });

  it.each([
    [400, 'client'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'server'],
    [503, 'server'],
  ])('maps HTTP %i onto kind %s', async (status, kind) => {
    const { fetchImpl } = recordingFetch(jsonResponse({ error: 'nope' }, { status }));
    await expect(apiRequest('/api/resumes', {}, fetchImpl)).rejects.toMatchObject({ kind, status });
  });

  it('surfaces the server error message when the body is JSON', async () => {
    const { fetchImpl } = recordingFetch(jsonResponse({ error: 'Resume index unavailable.' }, { status: 503 }));
    await expect(apiRequest('/api/resumes', {}, fetchImpl)).rejects.toThrow('Resume index unavailable.');
  });

  it('does not echo an HTML error page into the message', async () => {
    const html = '<html><body><h1>502 Bad Gateway</h1></body></html>';
    const { fetchImpl } = recordingFetch(jsonResponse(html, { status: 502 }));
    const error = await apiRequest('/api/resumes', {}, fetchImpl).catch((e) => e as ApiError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('Request failed with HTTP 502.');
    expect((error as ApiError).message).not.toContain('<html>');
  });

  it('never puts the token in an error message', async () => {
    const { fetchImpl } = recordingFetch(jsonResponse({ error: 'bad token' }, { status: 401 }));
    const getToken = async () => 'super-secret-token';
    const error = await apiRequest('/api/resumes', { getToken }, fetchImpl).catch((e) => e as ApiError);
    expect((error as ApiError).message).not.toContain('super-secret-token');
  });

  it('returns undefined for 204 No Content', async () => {
    const { fetchImpl } = recordingFetch(jsonResponse('', { status: 204 }));
    await expect(apiRequest('/api/x', { method: 'POST' }, fetchImpl)).resolves.toBeUndefined();
  });

  it('reports malformed_response rather than leaking a JSON syntax error', async () => {
    const { fetchImpl } = recordingFetch(jsonResponse('{"resumes": ['));
    const error = await apiRequest('/api/resumes', {}, fetchImpl).catch((e) => e as ApiError);
    expect((error as ApiError).kind).toBe('malformed_response');
    expect((error as ApiError).message).toBe('The server returned a response that was not valid JSON.');
  });

  it('reports network when the request never reaches the server', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('Network request failed');
    };
    await expect(apiRequest('/api/resumes', {}, fetchImpl)).rejects.toMatchObject({ kind: 'network' });
  });

  it('reports timeout when the request is aborted by its own deadline', async () => {
    // A fetch that never settles until its signal aborts, mirroring a dropped connection.
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
      });
    await expect(apiRequest('/api/resumes', { timeoutMs: 5 }, fetchImpl)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('aborts the underlying request when the caller signals', async () => {
    const controller = new AbortController();
    let forwardedSignal: AbortSignal | undefined;
    // Settles only on abort, so the assertion can observe that the abort was forwarded.
    const fetchImpl: FetchLike = (_url, init) => {
      forwardedSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        const settle = () => reject(new Error('Aborted'));
        if (init?.signal?.aborted) settle();
        else init?.signal?.addEventListener('abort', settle);
      });
    };
    const pending = apiRequest('/api/resumes', { signal: controller.signal, timeoutMs: 5_000 }, fetchImpl);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'canceled' });
    expect(forwardedSignal?.aborted).toBe(true);
  });

  it('sends nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = recordingFetch(jsonResponse({}));
    await expect(
      apiRequest('/api/resumes', { signal: controller.signal, timeoutMs: 5_000 }, fetchImpl),
    ).rejects.toMatchObject({ kind: 'canceled' });
    // Never opened a socket for a call the caller had already given up on.
    expect(calls).toHaveLength(0);
  });

  it('reports cancellation as benign so a screen can stay quiet', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl } = recordingFetch(jsonResponse({}));
    const error = await apiRequest('/api/resumes', { signal: controller.signal }, fetchImpl).catch(
      (e) => e as ApiError,
    );
    expect((error as ApiError).isBenign).toBe(true);
    const timeout = await apiRequest('/api/resumes', { timeoutMs: 5 }, async () => {
      throw new Error('boom');
    }).catch((e) => e as ApiError);
    expect((timeout as ApiError).isBenign).toBe(false);
  });

  it('fails with missing-config rather than calling fetch when the base URL is unset', async () => {
    delete process.env[API_BASE_URL_ENV_VAR];
    const { fetchImpl, calls } = recordingFetch(jsonResponse({}));
    await expect(apiRequest('/api/resumes', {}, fetchImpl)).rejects.toThrow(/EXPO_PUBLIC_JOBEMAILER_API_URL/);
    expect(calls).toHaveLength(0);
  });

  it('treats only 401 as an auth problem, since re-auth cannot fix a 403', async () => {
    const check = async (status: number) => {
      const { fetchImpl } = recordingFetch(jsonResponse({ error: 'x' }, { status }));
      return (await apiRequest('/api/resumes', {}, fetchImpl).catch((e) => e as ApiError)) as ApiError;
    };
    expect((await check(401)).isAuthProblem).toBe(true);
    expect((await check(403)).kind).toBe('forbidden');
    expect((await check(403)).isAuthProblem).toBe(false);
    expect((await check(404)).isAuthProblem).toBe(false);
    expect((await check(500)).isAuthProblem).toBe(false);
  });
});
