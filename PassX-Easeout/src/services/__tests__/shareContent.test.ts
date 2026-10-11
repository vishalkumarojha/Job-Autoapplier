import { normalizeIntakeContent } from '../shareContent';

describe('normalizeIntakeContent', () => {
  it('normalizes a shared URL as user input without scraping', () => {
    expect(normalizeIntakeContent(' https://example.com/job ', 'share_android')).toEqual({ rawText: 'https://example.com/job', rawSource: 'share_android' });
  });
  it('normalizes paste/manual input and ignores empty or non-text input', () => {
    expect(normalizeIntakeContent(' Job text ', 'paste')).toEqual({ rawText: 'Job text', rawSource: 'paste' });
    expect(normalizeIntakeContent('  ', 'manual')).toBeNull();
    expect(normalizeIntakeContent({ text: 'bad' }, 'manual')).toBeNull();
  });
});
