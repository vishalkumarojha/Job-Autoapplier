import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ResumeSuggestions from '../ResumeSuggestions';
import { ApiError } from '../../../api/errors';
import { createJob, type ResumeSuggestions as Envelope } from '../../../domain/job';

// The suggestion client reaches Firebase for its token, and Firebase's web build is ESM
// that Jest cannot transform. Every test here injects `generateImpl`, so the real client is
// never used; this keeps the module out of the run.
jest.mock('../../../services/firebase', () => ({
  auth: { currentUser: null },
}));

const BASE = { id: 'job-1', now: '2026-10-05T09:00:00.000Z', company: 'Acme', role: 'Dev' };

const SUGGESTION = {
  id: 'sug_001',
  priority: 'high' as const,
  category: 'skill_emphasis' as const,
  actionType: 'reorder_or_emphasize' as const,
  title: 'Highlight PostgreSQL work',
  suggestion: 'Reorder the PostgreSQL bullet above the payments summary.',
  jobEvidence: 'PostgreSQL is a required technology.',
  resumeEvidence: 'The resume already demonstrates PostgreSQL.',
};

const NEVER_GENERATED = createJob(BASE);

const WITH_SUGGESTIONS = {
  ...createJob(BASE),
  resumeSuggestions: { schemaVersion: 1, suggestions: [SUGGESTION] } as Envelope,
};

const GENERATED_EMPTY = {
  ...createJob(BASE),
  resumeSuggestions: { schemaVersion: 1, suggestions: [] } as Envelope,
};

const generateImpl = jest.fn(async () => ({ schemaVersion: 1, jobId: 'job-1', suggestions: [SUGGESTION] }));
const onGenerated = jest.fn();

/** Lets the mount effect settle, so no assertion races the abort-controller setup. */
async function renderBlock(overrides: Partial<Parameters<typeof ResumeSuggestions>[0]> = {}) {
  const props = {
    job: NEVER_GENERATED,
    onGenerated,
    generateImpl,
    ...overrides,
  };
  const view = render(<ResumeSuggestions {...props} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { view, props };
}

beforeEach(() => {
  jest.clearAllMocks();
  generateImpl.mockResolvedValue({ schemaVersion: 1, jobId: 'job-1', suggestions: [SUGGESTION] });
  onGenerated.mockResolvedValue(undefined);
});

describe('the three persisted states', () => {
  it('offers the action when nobody has asked yet', async () => {
    await renderBlock();

    expect(screen.getByText(/specific, evidence-based ways/)).toBeTruthy();
    expect(screen.getByLabelText('Generate resume suggestions')).toBeTruthy();
    expect(screen.queryByTestId('suggestions-empty')).toBeNull();
    expect(generateImpl).not.toHaveBeenCalled();
  });

  it('shows an empty generated list as an answer, not as a failure', async () => {
    await renderBlock({ job: GENERATED_EMPTY });

    expect(screen.getByTestId('suggestions-empty')).toBeTruthy();
    expect(screen.getByText(/already covers the posting/)).toBeTruthy();
    expect(screen.getByLabelText('Regenerate resume suggestions')).toBeTruthy();
    expect(screen.queryByText(/evidence-based ways/)).toBeNull();
  });

  it('renders the stored advice without calling the endpoint', async () => {
    await renderBlock({ job: WITH_SUGGESTIONS });

    expect(screen.getByText('Highlight PostgreSQL work')).toBeTruthy();
    expect(screen.getByText(SUGGESTION.suggestion)).toBeTruthy();
    expect(screen.getByText('JOB SAYS')).toBeTruthy();
    expect(screen.getByText('RESUME SHOWS')).toBeTruthy();
    expect(screen.getByText('PostgreSQL is a required technology.')).toBeTruthy();
    expect(screen.getByText('The resume already demonstrates PostgreSQL.')).toBeTruthy();
    expect(generateImpl).not.toHaveBeenCalled();
  });

  it('labels severity and category from the domain tables', async () => {
    await renderBlock({ job: WITH_SUGGESTIONS });
    expect(screen.getByText('HIGH')).toBeTruthy();
    expect(screen.getByText('Skill emphasis')).toBeTruthy();
  });

  it('states that nothing is edited automatically', async () => {
    await renderBlock({ job: WITH_SUGGESTIONS });
    expect(screen.getByText(/not modified automatically/)).toBeTruthy();
  });
});

describe('generating', () => {
  it('calls the endpoint for this job and asks the screen to refresh', async () => {
    await renderBlock();

    fireEvent.press(screen.getByLabelText('Generate resume suggestions'));

    await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(1));
    expect(generateImpl).toHaveBeenCalledWith('job-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('shows a spinner while the request is in flight', async () => {
    let release: (() => void) | undefined;
    generateImpl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ schemaVersion: 1, jobId: 'job-1', suggestions: [] });
        }),
    );
    await renderBlock();

    fireEvent.press(screen.getByLabelText('Generate resume suggestions'));

    await waitFor(() => expect(screen.getByTestId('suggestions-spinner')).toBeTruthy());
    expect(screen.queryByText('Generate Suggestions')).toBeNull();

    await act(async () => {
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByTestId('suggestions-spinner')).toBeNull();
  });

  it('relabels the action once advice already exists', async () => {
    await renderBlock({ job: WITH_SUGGESTIONS });
    expect(screen.getByLabelText('Regenerate resume suggestions')).toBeTruthy();
  });

  it('surfaces a failure from the refresh rather than swallowing it', async () => {
    onGenerated.mockRejectedValueOnce(new Error('Could not reload this job.'));
    await renderBlock();

    fireEvent.press(screen.getByLabelText('Generate resume suggestions'));

    expect(await screen.findByText('Could not reload this job.')).toBeTruthy();
  });
});

describe('failure copy', () => {
  async function failWith(error: unknown) {
    generateImpl.mockRejectedValueOnce(error);
    await renderBlock();
    fireEvent.press(screen.getByLabelText('Generate resume suggestions'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('names an expired session rather than blaming the server', async () => {
    await failWith(new ApiError('unauthorized', 'Authentication required.', 401));
    expect(await screen.findByText('Sign in again to generate suggestions.')).toBeTruthy();
  });

  it('names a missing local session the same way', async () => {
    await failWith(new ApiError('not_authenticated', 'Not signed in.', null));
    expect(await screen.findByText('Sign in again to generate suggestions.')).toBeTruthy();
  });

  it('names a timeout rather than echoing it', async () => {
    await failWith(new ApiError('timeout', 'Request timed out after 15000ms.', null));
    expect(await screen.findByText('That took too long. Try again.')).toBeTruthy();
  });

  it('explains an unreadable payload as a version problem', async () => {
    const error = new Error('not in the expected format');
    error.name = 'InvalidSuggestionsResponseError';
    await failWith(error);
    expect(await screen.findByText(/cannot read. Update the app/)).toBeTruthy();
  });

  it("shows the server's own 409, which is written for a human", async () => {
    await failWith(new ApiError('client', 'The selected resume is no longer available in the resume library.', 409));
    expect(await screen.findByText('The selected resume is no longer available in the resume library.')).toBeTruthy();
  });

  it('stays quiet when the sheet closed and the request was cancelled', async () => {
    await failWith(new ApiError('canceled', 'Request cancelled.', null));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onGenerated).not.toHaveBeenCalled();
  });
});

describe('what is never rendered', () => {
  it('refuses a stored envelope this version does not understand', async () => {
    await renderBlock({
      job: {
        ...createJob(BASE),
        resumeSuggestions: {
          schemaVersion: 1,
          suggestions: [{ ...SUGGESTION, priority: 'urgent', targetSection: 'skills' }],
        } as unknown as Envelope,
      },
    });

    expect(screen.queryByTestId('suggestion-sug_001')).toBeNull();
    expect(screen.getByText(/specific, evidence-based ways/)).toBeTruthy();
  });

  it('refuses a stored envelope from a version it cannot interpret', async () => {
    await renderBlock({
      job: { ...createJob(BASE), resumeSuggestions: { schemaVersion: 0, suggestions: [] } as unknown as Envelope },
    });
    expect(screen.queryByTestId('suggestions-empty')).toBeNull();
    expect(screen.getByLabelText('Generate resume suggestions')).toBeTruthy();
  });
});
