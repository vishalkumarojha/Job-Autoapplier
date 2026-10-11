import { apiRequest, type FetchLike } from './client';
import { requireIdToken } from './authToken';

export async function registerPushToken(token: string, platform: 'android' | 'ios', options: {
  fetchImpl?: FetchLike; getToken?: () => Promise<string | null>;
} = {}): Promise<void> {
  await apiRequest<void>('/api/push/register', { method: 'POST', body: { token, platform }, getToken: options.getToken ?? requireIdToken }, options.fetchImpl);
}
