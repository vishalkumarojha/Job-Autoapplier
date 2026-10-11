import React from 'react';
import { render, screen } from '@testing-library/react-native';
import DeadlineChip from '../DeadlineChip';

// `now` is injected by the component, so deadline behaviour is testable without
// depending on the wall clock.
const NOW = Date.parse('2026-10-20T12:00:00.000Z');

describe('DeadlineChip', () => {
  it('renders a formatted calendar date', () => {
    render(<DeadlineChip deadline="2026-11-01T00:00:00.000Z" now={NOW} />);
    expect(screen.getByText('1 Nov 2026')).toBeTruthy();
  });

  it('renders the stored calendar day regardless of the device timezone', () => {
    // The value is an instant, but a deadline is a calendar day. Formatting the stored
    // date portion rather than local getters keeps 1 Nov from sliding to 31 Oct.
    render(<DeadlineChip deadline="2026-01-01T00:00:00.000Z" now={NOW} />);
    expect(screen.getByText(/^1 Jan 2026/)).toBeTruthy();
    expect(screen.queryByText(/31 Dec 2025/)).toBeNull();
  });

  it('marks a past deadline as passed', () => {
    render(<DeadlineChip deadline="2026-10-18T00:00:00.000Z" now={NOW} />);
    expect(screen.getByText(/18 Oct 2026 · passed/)).toBeTruthy();
  });

  it('treats a deadline inside three days as imminent without marking it passed', () => {
    render(<DeadlineChip deadline="2026-10-22T00:00:00.000Z" now={NOW} />);
    expect(screen.getByText('22 Oct 2026')).toBeTruthy();
    expect(screen.queryByText(/passed/)).toBeNull();
  });

  it('says "No deadline" instead of rendering blank space', () => {
    // The legacy "No Deadline" sentinel reaches the UI as null, so the chip must have
    // something meaningful to show rather than an invisible row.
    render(<DeadlineChip deadline={null} now={NOW} />);
    expect(screen.getByText('No deadline')).toBeTruthy();
  });

  it('falls back to the raw value if it is not an ISO timestamp', () => {
    render(<DeadlineChip deadline="whenever" now={NOW} />);
    expect(screen.getByText('whenever')).toBeTruthy();
  });

  it('pads single-digit days and abbreviates the month', () => {
    render(<DeadlineChip deadline="2026-03-05T00:00:00.000Z" now={NOW} />);
    expect(screen.getByText(/^5 Mar 2026/)).toBeTruthy();
  });
});
