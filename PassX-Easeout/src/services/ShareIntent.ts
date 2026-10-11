import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { normalizeIntakeContent } from './shareContent';

const native = NativeModules.ShareIntentModule;
const emitter = native ? new NativeEventEmitter(native) : null;

export async function getInitialSharedText(): Promise<string | null> {
  if (Platform.OS !== 'android' || !native) return null;
  const value = await native.getInitialText();
  return normalizeIntakeContent(value, 'share_android')?.rawText ?? null;
}

export function onSharedText(callback: (text: string) => void): { remove(): void } {
  if (Platform.OS !== 'android' || !emitter) return { remove() {} };
  return emitter.addListener('sharedText', (value: unknown) => {
    const normalized = normalizeIntakeContent(value, 'share_android');
    if (normalized) callback(normalized.rawText);
  });
}
