import type { JobRawSource } from '../domain/job';

export type IntakeSource = JobRawSource;

export function normalizeIntakeContent(value: unknown, source: IntakeSource): { rawText: string; rawSource: IntakeSource } | null {
  if (typeof value !== 'string') return null;
  const rawText = value.trim();
  return rawText ? { rawText, rawSource: source } : null;
}
