import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import JobIntakeReviewScreen from '../JobIntakeReviewScreen';
import type { JobIntakeResult } from '../../api/intake';
import type { Job } from '../../domain/job';

// The screen reaches Firebase in two places: the session and the job repository. Both are
// replaced so these tests exercise only the review-and-save logic.
jest.mock('../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../../data/jobs/firestore', () => ({
  createFirestoreJobsRepository: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useAuth } = require('../../context/AuthContext') as { useAuth: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createFirestoreJobsRepository } = require('../../data/jobs/firestore') as {
  createFirestoreJobsRepository: jest.Mock;
};

const RAW = `Senior Backend Engineer — Example Corp
Apply by 12 Oct 2026. Send your CV to priya.sharma@example.com
Job page: https://example.com/jobs/backend-42`;

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
  fieldConfidence: {
    company: 0.98,
    role: 0.4,
    jobUrl: 0.98,
    location: 0.81,
    deadline: 0.7,
    contactName: 0.72,
    contactEmail: 0.93,
  },
};

/** The key `computeDedupeKey` derives from `EXTRACTION`, pinned rather than recomputed. */
const DEDUPE_KEY = 'example corp|senior backend engineer|example.com/jobs/backend-42';

type ScreenProps = React.ComponentProps<typeof JobIntakeReviewScreen>;

function route(params?: ScreenProps['route']['params']): ScreenProps['route'] {
  return { params, key: 'k', name: 'JobIntakeReview' } as ScreenProps['route'];
}

const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as ScreenProps['navigation'];

const repository = {
  listJobs: jest.fn(),
  createJob: jest.fn(),
  getJobById: jest.fn(),
  updateJob: jest.fn(),
  archiveJob: jest.fn(),
};

function renderScreen(params?: ScreenProps['route']['params']) {
  return render(<JobIntakeReviewScreen navigation={navigation} route={route(params)} />);
}

function defaultParams(overrides: Partial<NonNullable<ScreenProps['route']['params']>> = {}) {
  return { rawText: RAW, extraction: EXTRACTION, ...overrides };
}

/** The arguments most recently passed to `repository.createJob`. */
function savedInput() {
  return repository.createJob.mock.calls[repository.createJob.mock.calls.length - 1][0];
}

function changeField(testID: string, value: string) {
  fireEvent.changeText(screen.getByTestId(testID), value);
}

beforeEach(() => {
  useAuth.mockReturnValue({ user: { uid: 'user-1' } });
  createFirestoreJobsRepository.mockReturnValue(repository);
  repository.listJobs.mockResolvedValue([]);
  repository.createJob.mockResolvedValue({ id: 'job-1' });
  navigation.navigate = jest.fn();
  navigation.goBack = jest.fn();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('JobIntakeReviewScreen rendering', () => {
  it('prefills every field from the extraction', async () => {
    renderScreen(defaultParams());

    expect(await screen.findByDisplayValue('Example Corp')).toBeTruthy();
    expect(screen.getByDisplayValue('Senior Backend Engineer')).toBeTruthy();
    expect(screen.getByDisplayValue('Bangalore / Remote')).toBeTruthy();
    expect(screen.getByDisplayValue('https://example.com/jobs/backend-42')).toBeTruthy();
    expect(screen.getByDisplayValue('2026-10-12')).toBeTruthy();
    expect(screen.getByDisplayValue('Priya Sharma')).toBeTruthy();
    expect(screen.getByDisplayValue('priya.sharma@example.com')).toBeTruthy();
    expect(screen.getByDisplayValue('Visa sponsorship available.')).toBeTruthy();
  });

  it('shows the raw posting for verification', async () => {
    renderScreen(defaultParams());
    expect(await screen.findByTestId('intake-raw-text')).toBeTruthy();
    expect(screen.getByText(/Send your CV to priya\.sharma@example\.com/)).toBeTruthy();
  });

  it('flags a low-confidence field and labels a confident one', async () => {
    renderScreen(defaultParams());

    expect(await screen.findByTestId('intake-confidence-role')).toBeTruthy();
    expect(screen.getByText('Check this — extraction was 40% confident')).toBeTruthy();
    expect(String(screen.getByTestId('intake-confidence-company').props.children)).toContain(
      'Extraction confidence 98%',
    );
    expect(screen.getByTestId('intake-confidence-contactEmail')).toBeTruthy();
    expect(screen.getByTestId('intake-confidence-deadline')).toBeTruthy();
  });

  it('offers no confidence marker for a field the extraction did not assess', async () => {
    renderScreen(defaultParams());
    await screen.findByTestId('intake-confidence-company');
    expect(screen.queryByTestId('intake-confidence-notes')).toBeNull();
  });

  it('says there is nothing to review when the route carries no extraction', () => {
    // Reached by a state restore rather than by navigating from the intake screen, so the
    // params are deliberately malformed for the type.
    renderScreen({ rawText: '', extraction: undefined } as unknown as ScreenProps['route']['params']);
    expect(screen.getByText('Nothing to review')).toBeTruthy();
    expect(screen.queryByTestId('intake-review-submit')).toBeNull();
  });

  it('blocks saving when nobody is signed in', async () => {
    useAuth.mockReturnValue({ user: null });
    renderScreen(defaultParams());
    expect(await screen.findByText('Sign in to save')).toBeTruthy();
    expect(screen.queryByTestId('intake-review-submit')).toBeNull();
  });
});

describe('JobIntakeReviewScreen persistence', () => {
  it('creates a canonical job with the extraction proven intact', async () => {
    renderScreen(defaultParams());
    fireEvent.press(await screen.findByTestId('intake-review-submit'));

    await waitFor(() => expect(repository.createJob).toHaveBeenCalledTimes(1));
    expect(savedInput()).toMatchObject({
      company: 'Example Corp',
      role: 'Senior Backend Engineer',
      location: 'Bangalore / Remote',
      jobUrl: 'https://example.com/jobs/backend-42',
      contactName: 'Priya Sharma',
      contactEmail: 'priya.sharma@example.com',
      notes: 'Visa sponsorship available.',
      deadline: '2026-10-12T00:00:00.000Z',
      rawText: RAW,
      rawSource: 'linkedin',
      intakeStatus: 'confirmed',
      fieldConfidence: EXTRACTION.fieldConfidence,
    });
  });

  it('records provenance as extracted when nothing was changed', async () => {
    renderScreen(defaultParams());
    fireEvent.press(await screen.findByTestId('intake-review-submit'));

    await waitFor(() => expect(repository.createJob).toHaveBeenCalled());
    expect(savedInput().deadlineSource).toBe('extracted');
    expect(savedInput().contactEmailSource).toBe('extracted');
  });

  it('records provenance as user_entered when the reviewer overrides a value', async () => {
    renderScreen(defaultParams());
    await screen.findByTestId('intake-review-deadline');
    changeField('intake-review-deadline', '2026-11-01');
    changeField('intake-review-contactEmail', 'Priya.Sharma@Elsewhere.example');
    fireEvent.press(screen.getByTestId('intake-review-submit'));

    await waitFor(() => expect(repository.createJob).toHaveBeenCalled());
    expect(savedInput().deadline).toBe('2026-11-01T00:00:00.000Z');
    expect(savedInput().deadlineSource).toBe('user_entered');
    expect(savedInput().contactEmailSource).toBe('user_entered');
  });

  it('records provenance as unknown when the reviewer clears a value', async () => {
    renderScreen(defaultParams());
    await screen.findByTestId('intake-review-deadline');
    changeField('intake-review-deadline', '');
    changeField('intake-review-contactEmail', '');
    fireEvent.press(screen.getByTestId('intake-review-submit'));

    await waitFor(() => expect(repository.createJob).toHaveBeenCalled());
    expect(savedInput().deadline).toBeNull();
    expect(savedInput().deadlineSource).toBe('unknown');
    expect(savedInput().contactEmail).toBeNull();
    expect(savedInput().contactEmailSource).toBe('unknown');
  });

  it('never sets fields that belong to other features', async () => {
    renderScreen(defaultParams());
    fireEvent.press(await screen.findByTestId('intake-review-submit'));

    await waitFor(() => expect(repository.createJob).toHaveBeenCalled());
    const input = savedInput();
    // Dedupe is derived by the repository; approval, matching, resume selection, sheet
    // sync, and Gmail state are separate features with their own gates, and an intake
    // must not be able to move any of them as a side effect.
    for (const forbidden of [
      'dedupeKey',
      'approvalStatus',
      'approvedAt',
      'selectedResumeId',
      'matchScore',
      'matchBreakdown',
      'resumeSuggestions',
      'sheetRowId',
      'sheetSyncStatus',
      'gmailThreadId',
      'emailSentOn',
      'applicationStatus',
      'id',
      'schemaVersion',
      'createdAt',
    ]) {
      expect(input).not.toHaveProperty(forbidden);
    }
    // The advertising channel is a different question from the capture channel and is
    // left for a human rather than inferred from how the text arrived.
    expect(input).not.toHaveProperty('source');
  });

  it('notifies the pipeline and navigates back once saved', async () => {
    const onSaved = jest.fn();
    renderScreen(defaultParams({ onSaved }));
    fireEvent.press(await screen.findByTestId('intake-review-submit'));

    await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith('JobPipeline'));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(repository.createJob).toHaveBeenCalledTimes(1);
  });

  it('stores an empty optional field as null rather than an empty string', async () => {
    renderScreen(defaultParams());
    await screen.findByTestId('intake-review-location');
    changeField('intake-review-location', '   ');
    fireEvent.press(screen.getByTestId('intake-review-submit'));

    await waitFor(() => expect(repository.createJob).toHaveBeenCalled());
    expect(savedInput().location).toBeNull();
    expect(savedInput().notes).toBe('Visa sponsorship available.');
  });
});

describe('JobIntakeReviewScreen validation', () => {
  it('requires a company', async () => {
    renderScreen(defaultParams());
    await screen.findByTestId('intake-review-company');
    changeField('intake-review-company', '   ');
    fireEvent.press(screen.getByTestId('intake-review-submit'));

    expect(await screen.findByText('Company is required.')).toBeTruthy();
    expect(repository.createJob).not.toHaveBeenCalled();
  });

  it('requires a role', async () => {
    renderScreen(defaultParams());
    await screen.findByTestId('intake-review-role');
    changeField('intake-review-role', '');
    fireEvent.press(screen.getByTestId('intake-review-submit'));

    expect(await screen.findByText('Role is required.')).toBeTruthy();
    expect(repository.createJob).not.toHaveBeenCalled();
  });

  it('rejects an impossible deadline', async () => {
    renderScreen(defaultParams());
    await screen.findByTestId('intake-review-deadline');
    changeField('intake-review-deadline', '2026-02-31');
    fireEvent.press(screen.getByTestId('intake-review-submit'));

    expect(await screen.findByText('That date does not exist.')).toBeTruthy();
    expect(repository.createJob).not.toHaveBeenCalled();
  });

  it('rejects a malformed deadline', async () => {
    renderScreen(defaultParams());
    await screen.findByTestId('intake-review-deadline');
    changeField('intake-review-deadline', 'tomorrow');
    fireEvent.press(screen.getByTestId('intake-review-submit'));

    expect(await screen.findByText('Use the format YYYY-MM-DD.')).toBeTruthy();
    expect(repository.createJob).not.toHaveBeenCalled();
  });

  it('rejects a malformed email', async () => {
    renderScreen(defaultParams());
    await screen.findByTestId('intake-review-contactEmail');
    changeField('intake-review-contactEmail', 'not-an-email');
    fireEvent.press(screen.getByTestId('intake-review-submit'));

    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(repository.createJob).not.toHaveBeenCalled();
  });

  it('rejects a job URL that is not a full URL', async () => {
    renderScreen(defaultParams());
    await screen.findByTestId('intake-review-jobUrl');
    changeField('intake-review-jobUrl', 'example.com/jobs');
    fireEvent.press(screen.getByTestId('intake-review-submit'));

    expect(await screen.findByText('Enter a full URL starting with http:// or https://.')).toBeTruthy();
    expect(repository.createJob).not.toHaveBeenCalled();
  });
});

describe('JobIntakeReviewScreen duplicate handling', () => {
  function existingJob(overrides: Partial<Job> = {}): Job {
    return {
      id: 'job-existing',
      dedupeKey: DEDUPE_KEY,
      archivedAt: null,
      company: 'Example Corp',
      role: 'Senior Backend Engineer',
      jobUrl: 'https://example.com/jobs/backend-42',
      ...overrides,
    } as Job;
  }

  it('warns when the same job is already in the pipeline and relabels the button', async () => {
    repository.listJobs.mockResolvedValue([existingJob()]);
    renderScreen(defaultParams());

    expect(await screen.findByTestId('intake-duplicate')).toBeTruthy();
    expect(screen.getByText(/already in your pipeline/)).toBeTruthy();
    expect(screen.getByText('Save Anyway')).toBeTruthy();
    expect(screen.queryByText('Save Job')).toBeNull();
  });

  it('says so when the duplicate was archived rather than kept', async () => {
    repository.listJobs.mockResolvedValue([existingJob({ archivedAt: '2026-09-01T00:00:00.000Z' })]);
    renderScreen(defaultParams());

    expect(await screen.findByTestId('intake-duplicate')).toBeTruthy();
    expect(screen.getByText(/archived a job with these details/)).toBeTruthy();
    expect(screen.getByText('Save Anyway')).toBeTruthy();
  });

  it('stays silent when nothing matches', async () => {
    repository.listJobs.mockResolvedValue([existingJob({ dedupeKey: 'other|role|null' })]);
    renderScreen(defaultParams());

    await screen.findByTestId('intake-review-submit');
    expect(screen.queryByTestId('intake-duplicate')).toBeNull();
    expect(screen.getByText('Save Job')).toBeTruthy();
  });

  it('drops the warning when the reviewer edits away the match', async () => {
    repository.listJobs.mockResolvedValue([existingJob()]);
    renderScreen(defaultParams());
    await screen.findByTestId('intake-duplicate');

    changeField('intake-review-company', 'A Different Company');
    await waitFor(() => expect(screen.queryByTestId('intake-duplicate')).toBeNull());
    expect(screen.getByText('Save Job')).toBeTruthy();
  });

  it('still saves when the duplicate check itself fails', async () => {
    repository.listJobs.mockRejectedValue(new Error('permission denied'));
    renderScreen(defaultParams());

    fireEvent.press(await screen.findByTestId('intake-review-submit'));
    await waitFor(() => expect(repository.createJob).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('intake-duplicate')).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('saves anyway when the user accepts the duplicate warning', async () => {
    repository.listJobs.mockResolvedValue([existingJob()]);
    renderScreen(defaultParams());
    fireEvent.press(await screen.findByTestId('intake-review-submit'));

    await waitFor(() => expect(repository.createJob).toHaveBeenCalledTimes(1));
    expect(navigation.navigate).toHaveBeenCalledWith('JobPipeline');
  });
});

describe('JobIntakeReviewScreen save errors', () => {
  it('shows a repository failure inline instead of swallowing it', async () => {
    repository.createJob.mockRejectedValue(new Error('Permission denied.'));
    renderScreen(defaultParams());
    fireEvent.press(await screen.findByTestId('intake-review-submit'));

    expect(await screen.findByTestId('intake-review-error')).toBeTruthy();
    expect(screen.getByText('Permission denied.')).toBeTruthy();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('does not navigate away after a failed save', async () => {
    repository.createJob.mockRejectedValue(new Error('nope'));
    renderScreen(defaultParams());
    fireEvent.press(await screen.findByTestId('intake-review-submit'));

    expect(await screen.findByTestId('intake-review-error')).toBeTruthy();
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.goBack).not.toHaveBeenCalled();
  });

  it('reports a sign-in problem in plain language', async () => {
    repository.createJob.mockRejectedValue(
      Object.assign(new Error('Not signed in. Sign in before calling the API.'), {
        name: 'NotAuthenticatedError',
      }),
    );
    renderScreen(defaultParams());
    fireEvent.press(await screen.findByTestId('intake-review-submit'));

    expect(await screen.findByTestId('intake-review-error')).toBeTruthy();
    expect(screen.getByText(/Not signed in/)).toBeTruthy();
  });
});
