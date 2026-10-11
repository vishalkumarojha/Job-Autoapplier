import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react-native';
import JobIntakeScreen from '../JobIntakeScreen';
import { ApiError } from '../../api/errors';
import type { JobIntakeResult } from '../../api/intake';

// The screen talks to the backend only through `intakeJob`. Mocking the module keeps these
// tests offline and lets each case choose its outcome. The client itself is covered in
// `api/__tests__/intake.test.ts`.
jest.mock('../../api/intake', () => ({
  intakeJob: jest.fn(),
  INTAKE_MAX_RAW_CHARS: 20000,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { intakeJob } = require('../../api/intake') as { intakeJob: jest.Mock };

const EXTRACTION: JobIntakeResult = {
  schemaVersion: 1,
  source: 'linkedin',
  company: 'Example Corp',
  contactName: 'Priya Sharma',
  contactEmail: 'priya.sharma@example.com',
  role: 'Senior Backend Engineer',
  jobUrl: 'https://example.com/jobs/backend-42',
  location: 'Bangalore / Remote',
  notes: 'Visa sponsorship available.',
  deadline: '2026-10-12T00:00:00.000Z',
  fieldConfidence: { company: 0.98, role: 0.99 },
};

const POSTING = 'Senior Backend Engineer — Example Corp';

type ScreenProps = React.ComponentProps<typeof JobIntakeScreen>;

function route(params?: ScreenProps['route']['params']): ScreenProps['route'] {
  return { params, key: 'k', name: 'JobIntake' } as ScreenProps['route'];
}

const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as ScreenProps['navigation'];

function renderScreen(params?: ScreenProps['route']['params']) {
  return render(<JobIntakeScreen navigation={navigation} route={route(params)} />);
}

function typePosting(text: string = POSTING) {
  fireEvent.changeText(screen.getByTestId('intake-raw-text'), text);
}

beforeEach(() => {
  intakeJob.mockReset();
  navigation.goBack = jest.fn();
  navigation.navigate = jest.fn();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('JobIntakeScreen states', () => {
  it('starts in the empty state with nothing to submit', () => {
    renderScreen();
    expect(screen.getByTestId('intake-submit')).toBeTruthy();
    expect(screen.getByTestId('intake-submit').props.accessibilityState.disabled).toBe(true);
    expect(String(screen.getByTestId('intake-char-count').props.children)).toContain('20,000');
  });

  it('treats a whitespace-only posting as empty and spends no request', () => {
    renderScreen();
    typePosting('     \n   ');

    expect(screen.getByTestId('intake-submit').props.accessibilityState.disabled).toBe(true);
    fireEvent.press(screen.getByTestId('intake-submit'));
    expect(intakeJob).not.toHaveBeenCalled();
  });

  it('rejects an overlong posting locally and says how long it is', async () => {
    renderScreen();
    typePosting('x'.repeat(20001));
    fireEvent.press(screen.getByTestId('intake-submit'));

    expect(await screen.findByTestId('intake-error')).toBeTruthy();
    expect(screen.getByText(/too long/)).toBeTruthy();
    expect(intakeJob).not.toHaveBeenCalled();
  });

  it('shows the processing state while the request is in flight', async () => {
    let release: (value: JobIntakeResult) => void = () => {};
    intakeJob.mockImplementation(() => new Promise<JobIntakeResult>((resolve) => { release = resolve; }));

    renderScreen();
    typePosting();
    fireEvent.press(screen.getByTestId('intake-submit'));

    expect(await screen.findByText('Reading the posting. This takes a few seconds.')).toBeTruthy();
    expect(screen.getByTestId('intake-submit').props.accessibilityState.busy).toBe(true);

    await act(async () => { release(EXTRACTION); });
  });

  it('extracts the posting and hands the result to the review screen', async () => {
    intakeJob.mockResolvedValue(EXTRACTION);
    const onSaved = jest.fn();

    renderScreen({ onSaved });
    typePosting();
    fireEvent.press(screen.getByTestId('intake-submit'));

    await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith('JobIntakeReview', {
      rawText: POSTING,
      extraction: EXTRACTION,
      onSaved,
    }));
    expect(intakeJob).toHaveBeenCalledWith(POSTING, 'paste', expect.objectContaining({ signal: expect.anything() }));
  });

  it('returns to the idle state when the request succeeds', async () => {
    intakeJob.mockResolvedValue(EXTRACTION);
    renderScreen();
    typePosting();
    fireEvent.press(screen.getByTestId('intake-submit'));

    await waitFor(() => expect(intakeJob).toHaveBeenCalled());
    expect(screen.queryByTestId('intake-error')).toBeNull();
    expect(screen.queryByText('Reading the posting. This takes a few seconds.')).toBeNull();
  });
});

describe('JobIntakeScreen source picker', () => {
  it('prepopulates Android-shared text and submits it through the same human-review intake path', async () => {
    intakeJob.mockResolvedValue(EXTRACTION);
    const shared = 'https://example.com/jobs/123';
    renderScreen({ initialText: shared, initialSource: 'share_android' });
    expect(screen.getByTestId('intake-raw-text').props.value).toBe(shared);
    fireEvent.press(screen.getByTestId('intake-submit'));
    await waitFor(() => expect(intakeJob).toHaveBeenCalledWith(shared, 'share_android', expect.anything()));
    expect(navigation.navigate).toHaveBeenCalledWith('JobIntakeReview', expect.objectContaining({ rawText: shared }));
  });

  it('offers every capture channel and defaults to paste', () => {
    renderScreen();
    for (const source of ['paste', 'share_android', 'manual', 'email', 'linkedin', 'x', 'referral', 'other']) {
      expect(screen.getByTestId(`intake-source-${source}`)).toBeTruthy();
    }
    expect(screen.getByTestId('intake-source-paste').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('intake-source-linkedin').props.accessibilityState.selected).toBe(false);
  });

  it('sends the selected channel with the request', async () => {
    intakeJob.mockResolvedValue(EXTRACTION);
    renderScreen();
    typePosting();
    fireEvent.press(screen.getByTestId('intake-source-referral'));
    fireEvent.press(screen.getByTestId('intake-submit'));

    await waitFor(() => expect(intakeJob).toHaveBeenCalled());
    expect(intakeJob).toHaveBeenCalledWith(POSTING, 'referral', expect.anything());
  });
});

describe('JobIntakeScreen errors', () => {
  it('shows the server\'s own 400 message, which describes the request', async () => {
    intakeJob.mockRejectedValue(new ApiError('client', 'That job posting is too long (20,001 characters).', 400));
    renderScreen();
    typePosting();
    fireEvent.press(screen.getByTestId('intake-submit'));

    expect(await screen.findByTestId('intake-error')).toBeTruthy();
    expect(screen.getByText(/too long/)).toBeTruthy();
  });

  it('explains an unconfigured deployment without a stack trace', async () => {
    intakeJob.mockRejectedValue(
      new ApiError('not_found', 'Job intake is not configured on the server.', 404),
    );
    renderScreen();
    typePosting();
    fireEvent.press(screen.getByTestId('intake-submit'));

    expect(await screen.findByText('Smart Intake is not available on this account yet.')).toBeTruthy();
  });

  it('reports a signed-out session as a sign-in problem', async () => {
    intakeJob.mockRejectedValue(new ApiError('not_authenticated', 'Not signed in.', null));
    renderScreen();
    typePosting();
    fireEvent.press(screen.getByTestId('intake-submit'));

    expect(await screen.findByText('Sign in again to use Smart Intake.')).toBeTruthy();
  });

  it('stays quiet when the request is cancelled', async () => {
    intakeJob.mockRejectedValue(new ApiError('canceled', 'Request cancelled.', null));
    renderScreen();
    typePosting();
    fireEvent.press(screen.getByTestId('intake-submit'));

    await waitFor(() => expect(intakeJob).toHaveBeenCalled());
    expect(screen.queryByTestId('intake-error')).toBeNull();
  });

  it('reports an unreachable server in plain language', async () => {
    intakeJob.mockRejectedValue(new ApiError('network', 'Could not reach the server: Network request failed', null));
    renderScreen();
    typePosting();
    fireEvent.press(screen.getByTestId('intake-submit'));

    expect(await screen.findByText('Could not reach the server. Check your connection and try again.')).toBeTruthy();
  });

  it('reports a 5xx without leaking provider detail', async () => {
    intakeJob.mockRejectedValue(new ApiError('server', 'Unable to process job posting', 500));
    renderScreen();
    typePosting();
    fireEvent.press(screen.getByTestId('intake-submit'));

    expect(
      await screen.findByText('Something went wrong while extracting. Please try again in a moment.'),
    ).toBeTruthy();
    expect(screen.queryByText(/anthropic/i)).toBeNull();
  });

  it('falls back to a generic message for an unrecognised throw', async () => {
    intakeJob.mockRejectedValue(new Error('boom'));
    renderScreen();
    typePosting();
    fireEvent.press(screen.getByTestId('intake-submit'));

    expect(await screen.findByText('boom')).toBeTruthy();
  });

  it('clears the previous error on a retry that succeeds', async () => {
    intakeJob.mockRejectedValueOnce(new ApiError('server', 'Unable to process job posting', 500));
    intakeJob.mockResolvedValueOnce(EXTRACTION);

    renderScreen();
    typePosting();
    fireEvent.press(screen.getByTestId('intake-submit'));
    expect(await screen.findByTestId('intake-error')).toBeTruthy();

    fireEvent.press(screen.getByTestId('intake-submit'));
    await waitFor(() => expect(navigation.navigate).toHaveBeenCalled());
    expect(screen.queryByTestId('intake-error')).toBeNull();
  });
});
