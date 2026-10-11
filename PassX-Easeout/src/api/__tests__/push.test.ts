import { registerPushToken } from '../push';

jest.mock('../authToken', () => ({ requireIdToken: jest.fn(async () => 'fake-token') }));

describe('registerPushToken', () => {
  it('sends the Expo token through authenticated API transport', async () => {
    process.env.EXPO_PUBLIC_JOBEMAILER_API_URL = 'https://backend.example';
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    await registerPushToken('ExpoPushToken[abcdefgh12345678]', 'android', { fetchImpl, getToken: async () => 'firebase-id-token' });
    const [, init] = fetchImpl.mock.calls[0] as any[];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer firebase-id-token');
    expect(JSON.parse(init.body)).toEqual({ token: 'ExpoPushToken[abcdefgh12345678]', platform: 'android' });
  });
});
