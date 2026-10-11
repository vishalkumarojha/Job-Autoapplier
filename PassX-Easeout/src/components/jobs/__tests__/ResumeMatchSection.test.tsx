import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ResumeMatchSection from '../ResumeMatchSection';
import { ApiError } from '../../../api/errors';
import type { JobMatchResult } from '../../../api/match';
import { createJob, type MatchBreakdown } from '../../../domain/job';
import type { ResumeSummary } from '../../../domain/resume';

// The Resume Library client reaches Firebase for its token, and Firebase's web build is ESM
// that Jest cannot transform. Every test here injects `loadResumesImpl`, so the real client
// is never used; this keeps the module out of the run.
jest.mock('../../../services/firebase', () => ({
  auth: { currentUser: null },
}));

const BASE = { id: 'job-1', now: '2026-10-05T09:00:00.000Z', company: 'Acme', role: 'Dev' };

const BREAKDOWN: MatchBreakdown = [
  { criterion: 'technology_alignment', score: 89, weight: 0.1, rationale: 'Go, PostgreSQL.' },
  { criterion: 'must_have', score: 94, weight: 0.35, rationale: 'Every requirement covered.' },
  { criterion: 'seniority', score: 90, weight: 0.2, rationale: 'Senior level.' },
];

const MATCHED = createJob(BASE);
const MATCHED_JOB = {
  ...MATCHED,
  selectedResumeId: 'rsv_alpha',
  matchScore: 91,
  matchBreakdown: BREAKDOWN,
};

const UNMATCHED_JOB = { ...createJob(BASE), selectedResumeId: null, matchScore: null, matchBreakdown: null };

const RESULT: JobMatchResult = {
  schemaVersion: 1,
  jobId: 'job-1',
  selectedResumeId: 'rsv_alpha',
  matchScore: 91,
  matchBreakdown: BREAKDOWN,
  rankings: [
    { resumeId: 'rsv_alpha', score: 91 },
    { resumeId: 'rsv_beta', score: 74 },
  ],
};

const RESUMES = [
  { resumeId: 'rsv_alpha', resumeLabel: 'Backend — Go — v3' },
  { resumeId: 'rsv_beta', resumeLabel: 'AI Engineer — v2' },
] as ResumeSummary[];

const loadResumesImpl = jest.fn(async () => RESUMES);
const onOpenResumeLibrary = jest.fn();
const onMatched = jest.fn();

/**
 * Renders and lets the label request settle inside `act`, so every assertion below sees a
 * stable tree instead of racing the one network call this component makes on mount.
 */
async function renderSection(overrides: Partial<Parameters<typeof ResumeMatchSection>[0]> = {}) {
  const runMatchImpl = overrides.runMatchImpl ?? jest.fn(async () => RESULT);
  const props = {
    job: MATCHED_JOB,
    onOpenResumeLibrary,
    onMatched,
    loadResumesImpl,
    runMatchImpl,
    ...overrides,
  };
  const view = render(<ResumeMatchSection {...props} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { view, runMatchImpl: props.runMatchImpl as jest.Mock, loadResumesImpl: props.loadResumesImpl as jest.Mock };
}

beforeEach(() => {
  jest.clearAllMocks();
  loadResumesImpl.mockResolvedValue(RESUMES);
  onMatched.mockResolvedValue(undefined);
});

describe('persisted match state', () => {
  it('renders the stored score, breakdown and selected label without calling the endpoint', async () => {
    const { runMatchImpl } = await renderSection();

    expect(screen.getByText('91 / 100')).toBeTruthy();
    // Labels arrive in their own request, so this waits for them rather than racing it.
    await waitFor(() => expect(screen.getByText('Backend — Go — v3')).toBeTruthy());
    expect(runMatchImpl).not.toHaveBeenCalled();
  });

  it('orders the breakdown canonically regardless of what the server sent', async () => {
    await renderSection();
    const labels = screen.getAllByText(/Must-have|Seniority|Technology/).map((node) => node.props.children);
    expect(labels).toEqual(['Must-have', 'Seniority', 'Technology']);
  });

  it('shows the rationale, the score, and the weight for each criterion', async () => {
    await renderSection();
    expect(screen.getByText('Every requirement covered.')).toBeTruthy();
    expect(screen.getByText('94 / 100')).toBeTruthy();
    expect(screen.getByText('weight 35%')).toBeTruthy();
  });

  it('offers a first-run call to action when nothing has been matched', async () => {
    await renderSection({ job: UNMATCHED_JOB });
    expect(screen.getByText('Not matched yet')).toBeTruthy();
    expect(screen.getByText(/compare every resume in your library/)).toBeTruthy();
    expect(screen.getByLabelText('Re-run resume match')).toBeTruthy();
    expect(screen.queryByText('91 / 100')).toBeNull();
  });

  it('relabels the action once a match already exists', async () => {
    await renderSection();
    expect(screen.getByText('Re-run Match')).toBeTruthy();
    await renderSection({ job: UNMATCHED_JOB });
    expect(screen.getByText('Run Match')).toBeTruthy();
  });

  it('never renders a criterion this version does not understand', async () => {
    await renderSection({
      job: {
        ...MATCHED_JOB,
        matchBreakdown: [...BREAKDOWN, { criterion: 'visa_sponsorship', score: 10, weight: 0.05, rationale: null }],
      },
    });
    expect(screen.queryByText('visa_sponsorship')).toBeNull();
  });
});

describe('running a match', () => {
  it('calls the endpoint for this job, shows the ranking, and asks the screen to refresh', async () => {
    const { runMatchImpl } = await renderSection();

    fireEvent.press(screen.getByLabelText('Re-run resume match'));

    await waitFor(() => expect(onMatched).toHaveBeenCalledTimes(1));
    expect(runMatchImpl).toHaveBeenCalledWith('job-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await screen.findByText('THIS RUN')).toBeTruthy();
    // The winner is named twice: once as the stored selection, once as rank 1.
    expect(screen.getAllByText('Backend — Go — v3').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('91')).toBeTruthy();
  });

  it('reports a real failure and does not claim a refresh', async () => {
    const { runMatchImpl } = await renderSection({
      runMatchImpl: jest.fn(async () => {
        throw new ApiError('server', 'Unable to compute a resume match.', 500);
      }),
    });

    fireEvent.press(screen.getByLabelText('Re-run resume match'));

    await waitFor(() => expect(screen.getByText('Unable to compute a resume match.')).toBeTruthy());
    expect(onMatched).not.toHaveBeenCalled();
    expect(runMatchImpl).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('THIS RUN')).toBeNull();
  });

  it('stays silent when the call was cancelled', async () => {
    await renderSection({
      runMatchImpl: jest.fn(async () => {
        throw new ApiError('canceled', 'Request cancelled.');
      }),
    });

    fireEvent.press(screen.getByLabelText('Re-run resume match'));

    await waitFor(() => expect(screen.getByText('Re-run Match')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onMatched).not.toHaveBeenCalled();
  });

  it('stops showing the spinner once the call settles', async () => {
    await renderSection();
    fireEvent.press(screen.getByLabelText('Re-run resume match'));
    expect(screen.getByTestId('match-spinner')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Re-run Match')).toBeTruthy());
    expect(screen.queryByTestId('match-spinner')).toBeNull();
  });

  it('abandons an in-flight match when the section unmounts', async () => {
    let captured: AbortSignal | undefined;
    const { view } = await renderSection({
      runMatchImpl: jest.fn(async (_jobId: string, options?: { signal?: AbortSignal }) => {
        captured = options?.signal;
        return RESULT;
      }),
    });

    fireEvent.press(screen.getByLabelText('Re-run resume match'));
    await waitFor(() => expect(captured).toBeDefined());
    view.unmount();

    expect(captured?.aborted).toBe(true);
  });
});

describe('resume labels', () => {
  it('falls back to the opaque id when the library cannot be read', async () => {
    loadResumesImpl.mockRejectedValueOnce(new ApiError('network', 'Could not reach the server.'));
    await renderSection();

    // The label request is cosmetic: the score and the id must still render.
    await waitFor(() => expect(screen.getByText('rsv_alpha')).toBeTruthy());
    expect(screen.getByText('91 / 100')).toBeTruthy();
  });

  it('falls back to the opaque id for a resume missing from the library', async () => {
    await renderSection({ job: { ...MATCHED_JOB, selectedResumeId: 'rsv_removed' } });
    expect(screen.getByText('rsv_removed')).toBeTruthy();
  });
});

describe('navigation', () => {
  it('opens the Resume Library rather than selecting a resume itself', async () => {
    await renderSection();
    fireEvent.press(screen.getByLabelText('View resume library'));
    expect(onOpenResumeLibrary).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Choose resume')).toBeNull();
  });
});

describe('resume suggestions gate', () => {
  it('offers suggestions once a job has both a selected resume and a breakdown', async () => {
    await renderSection();
    expect(screen.getByTestId('resume-suggestions')).toBeTruthy();
    expect(screen.getByLabelText('Generate resume suggestions')).toBeTruthy();
  });

  it('never offers suggestions for a job with no match to derive them from', async () => {
    await renderSection({ job: UNMATCHED_JOB });
    expect(screen.queryByTestId('resume-suggestions')).toBeNull();
  });

  it('never offers suggestions for a match that has no breakdown', async () => {
    await renderSection({ job: { ...MATCHED_JOB, matchBreakdown: null } });
    expect(screen.queryByTestId('resume-suggestions')).toBeNull();
  });
});
