import { parseDeadlineInput } from '../JobForm';

describe('parseDeadlineInput', () => {
  it('converts a valid date to an ISO instant at UTC midnight', () => {
    // UTC midnight is deliberate: DeadlineChip formats the stored date portion, so
    // anchoring here keeps the displayed calendar day identical to what was typed.
    expect(parseDeadlineInput('2026-11-01')).toEqual({
      ok: true,
      value: '2026-11-01T00:00:00.000Z',
    });
  });

  it('treats empty and whitespace input as no deadline', () => {
    expect(parseDeadlineInput('')).toEqual({ ok: true, value: null });
    expect(parseDeadlineInput('   ')).toEqual({ ok: true, value: null });
  });

  it('ignores surrounding whitespace on a real value', () => {
    expect(parseDeadlineInput('  2026-11-01  ')).toEqual({
      ok: true,
      value: '2026-11-01T00:00:00.000Z',
    });
  });

  it('rejects a date that does not exist instead of rolling it over', () => {
    // Date.UTC(2026, 1, 31) silently becomes 3 March, which would store a wrong deadline.
    expect(parseDeadlineInput('2026-02-31')).toEqual({
      ok: false,
      error: 'That date does not exist.',
    });
    expect(parseDeadlineInput('2026-04-31')).toMatchObject({ ok: false });
  });

  it('rejects a month outside 1-12', () => {
    expect(parseDeadlineInput('2026-13-01')).toMatchObject({ ok: false });
    expect(parseDeadlineInput('2026-00-10')).toMatchObject({ ok: false });
  });

  it('rejects a day of zero', () => {
    expect(parseDeadlineInput('2026-05-00')).toMatchObject({ ok: false });
  });

  it('requires the YYYY-MM-DD shape', () => {
    expect(parseDeadlineInput('01-11-2026')).toMatchObject({ ok: false });
    expect(parseDeadlineInput('2026/11/01')).toMatchObject({ ok: false });
    expect(parseDeadlineInput('Nov 1 2026')).toMatchObject({ ok: false });
  });

  it('rejects free text rather than guessing', () => {
    // Smart Intake owns ambiguous dates; manual entry must not invent one.
    expect(parseDeadlineInput('tomorrow')).toMatchObject({ ok: false });
    expect(parseDeadlineInput('next friday')).toMatchObject({ ok: false });
    expect(parseDeadlineInput('ASAP')).toMatchObject({ ok: false });
  });

  it('accepts a leap day in a leap year and rejects it otherwise', () => {
    expect(parseDeadlineInput('2028-02-29')).toMatchObject({ ok: true });
    expect(parseDeadlineInput('2026-02-29')).toMatchObject({ ok: false });
  });
});
