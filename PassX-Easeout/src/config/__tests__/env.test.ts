import { API_BASE_URL_ENV_VAR, MissingApiBaseUrlError, apiBaseUrl } from '../env';

const original = process.env[API_BASE_URL_ENV_VAR];

afterEach(() => {
  if (original === undefined) delete process.env[API_BASE_URL_ENV_VAR];
  else process.env[API_BASE_URL_ENV_VAR] = original;
});

describe('apiBaseUrl', () => {
  it('returns the configured origin', () => {
    process.env[API_BASE_URL_ENV_VAR] = 'https://example.vercel.app';
    expect(apiBaseUrl()).toBe('https://example.vercel.app');
  });

  it('strips trailing slashes so paths never double up', () => {
    process.env[API_BASE_URL_ENV_VAR] = 'https://example.vercel.app///';
    expect(apiBaseUrl()).toBe('https://example.vercel.app');
  });

  it('trims surrounding whitespace from a pasted value', () => {
    process.env[API_BASE_URL_ENV_VAR] = '  https://example.vercel.app  ';
    expect(apiBaseUrl()).toBe('https://example.vercel.app');
  });

  it('throws a directed error when unset rather than returning a placeholder', () => {
    delete process.env[API_BASE_URL_ENV_VAR];
    expect(() => apiBaseUrl()).toThrow(MissingApiBaseUrlError);
  });

  it('treats an empty or whitespace-only value as unset', () => {
    process.env[API_BASE_URL_ENV_VAR] = '   ';
    expect(() => apiBaseUrl()).toThrow(MissingApiBaseUrlError);
  });

  it('names the exact variable in the error so setup is obvious', () => {
    delete process.env[API_BASE_URL_ENV_VAR];
    expect(() => apiBaseUrl()).toThrow(API_BASE_URL_ENV_VAR);
  });

  it('reads lazily so a value set after import is still picked up', () => {
    delete process.env[API_BASE_URL_ENV_VAR];
    expect(() => apiBaseUrl()).toThrow();
    process.env[API_BASE_URL_ENV_VAR] = 'https://late.example.com';
    expect(apiBaseUrl()).toBe('https://late.example.com');
  });
});
