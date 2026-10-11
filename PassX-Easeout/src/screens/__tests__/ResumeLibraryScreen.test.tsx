import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react-native';
import ResumeLibraryScreen from '../ResumeLibraryScreen';
import { ApiError } from '../../api/errors';
import { RESUME_SCHEMA_VERSION, type ResumeSummary } from '../../domain/resume';

// The screen fetches through `listResumes`; mocking the module keeps these tests offline and
// lets each case choose its outcome. The client itself is covered in `api/__tests__`.
jest.mock('../../api/resumes', () => ({
  listResumes: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listResumes } = require('../../api/resumes') as { listResumes: jest.Mock };

const RESUME: ResumeSummary = {
  resumeId: 'rsv_abc123',
  schemaVersion: RESUME_SCHEMA_VERSION,
  resumeLabel: 'Backend — Go — v3',
  targetRole: 'Backend Engineer',
  targetRoleFamily: 'backend',
  version: 3,
  isDefault: true,
  keywords: ['go', 'postgresql'],
  updatedAt: '2026-02-01T09:00:00.000Z',
  lastUsedAt: null,
};

const SECOND: ResumeSummary = {
  resumeId: 'rsv_def456',
  schemaVersion: RESUME_SCHEMA_VERSION,
  resumeLabel: 'Frontend — React — v1',
  targetRole: 'Frontend Engineer',
  targetRoleFamily: 'frontend',
  version: 1,
  isDefault: false,
  keywords: ['react', 'typescript'],
  updatedAt: '2026-01-10T09:00:00.000Z',
  lastUsedAt: '2026-03-02T09:00:00.000Z',
};

const navigation = {
  goBack: jest.fn(),
  navigate: jest.fn(),
} as unknown as React.ComponentProps<typeof ResumeLibraryScreen>['navigation'];

function route(params?: React.ComponentProps<typeof ResumeLibraryScreen>['route']['params']) {
  return { params, key: 'k', name: 'ResumeLibrary' } as React.ComponentProps<typeof ResumeLibraryScreen>['route'];
}

beforeEach(() => {
  listResumes.mockReset();
  navigation.goBack = jest.fn();
});

describe('ResumeLibraryScreen states', () => {
  it('shows the loading state before the request resolves', async () => {
    let release: (value: ResumeSummary[]) => void = () => {};
    listResumes.mockImplementation(() => new Promise<ResumeSummary[]>((resolve) => { release = resolve; }));

    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    expect(screen.getByTestId('resume-loading')).toBeTruthy();

    await act(async () => { release([]); });
  });

  it('shows the empty state when the library has no resumes', async () => {
    listResumes.mockResolvedValue([]);
    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    await waitFor(() => expect(screen.getByTestId('resume-empty')).toBeTruthy());
    expect(screen.queryByTestId('resume-error')).toBeNull();
  });

  it('shows the error state with a retry affordance', async () => {
    listResumes.mockRejectedValue(new ApiError('network', 'Could not reach the server: offline'));
    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    await waitFor(() => expect(screen.getByTestId('resume-error')).toBeTruthy());
    expect(screen.getByText('Could not load resumes')).toBeTruthy();
  });

  it('explains a signed-out session rather than showing a raw failure', async () => {
    listResumes.mockRejectedValue(new ApiError('not_authenticated', 'Authentication required.'));
    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    await waitFor(() => expect(screen.getByText('Sign in to see your resumes.')).toBeTruthy());
  });

  it('explains a missing server configuration instead of a generic error', async () => {
    listResumes.mockRejectedValue(new ApiError('not_found', 'not configured'));
    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    await waitFor(() =>
      expect(screen.getByText(/not available yet/i)).toBeTruthy(),
    );
  });

  it('retries when the retry button is pressed', async () => {
    listResumes.mockRejectedValueOnce(new ApiError('network', 'offline')).mockResolvedValueOnce([RESUME]);
    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    await waitFor(() => expect(screen.getByTestId('resume-error')).toBeTruthy());

    await act(async () => { fireEvent.press(screen.getByText('Retry')); });
    await waitFor(() => expect(screen.getByText(RESUME.resumeLabel)).toBeTruthy());
    expect(listResumes).toHaveBeenCalledTimes(2);
  });

  it('stays quiet when a request is cancelled rather than showing an error', async () => {
    listResumes.mockRejectedValue(new ApiError('canceled', 'Request cancelled.'));
    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    await waitFor(() => expect(listResumes).toHaveBeenCalled());
    expect(screen.queryByTestId('resume-error')).toBeNull();
  });
});

describe('ResumeLibraryScreen loaded view', () => {
  beforeEach(() => {
    listResumes.mockResolvedValue([RESUME, SECOND]);
  });

  it('renders every documented metadata field', async () => {
    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    await waitFor(() => expect(screen.getByTestId('resume-list')).toBeTruthy());

    expect(screen.getByText('Backend — Go — v3')).toBeTruthy();
    expect(screen.getByText('Backend Engineer · Backend')).toBeTruthy();
    expect(screen.getByText('v3')).toBeTruthy();
    expect(screen.getByText('Updated 1 Feb 2026')).toBeTruthy();
    expect(screen.getByText('go')).toBeTruthy();
    expect(screen.getByText('postgresql')).toBeTruthy();
  });

  it('marks the default resume', async () => {
    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    await waitFor(() => expect(screen.getByText('Default')).toBeTruthy());
  });

  it('shows a last-used date only when one exists', async () => {
    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    await waitFor(() => expect(screen.getByTestId('resume-list')).toBeTruthy());
    expect(screen.getByText('Last used 2 Mar 2026')).toBeTruthy();
    expect(screen.queryByText('Last used —')).toBeNull();
  });

  it('says so plainly when no target role is set, instead of hiding the row', async () => {
    listResumes.mockResolvedValue([{ ...RESUME, targetRole: null, targetRoleFamily: null, keywords: [] }]);
    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    await waitFor(() => expect(screen.getByText('No target role set')).toBeTruthy());
  });

  it('renders never server-private fields, because it cannot receive them', async () => {
    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    await waitFor(() => expect(screen.getByTestId('resume-list')).toBeTruthy());

    expect(screen.queryByText(/rsv_[0-9a-f]{24}/)).toBeNull();
    expect(screen.queryByText(/\.pdf/i)).toBeNull();
    expect(screen.queryByText(/drive/i)).toBeNull();
  });

  it('puts the default resume first in standalone mode', async () => {
    listResumes.mockResolvedValue([SECOND, RESUME]);
    render(<ResumeLibraryScreen navigation={navigation} route={route()} />);
    await waitFor(() => expect(screen.getByTestId('resume-list')).toBeTruthy());
    // RESUME is the default and must sort ahead of SECOND.
    const rendered = screen.getAllByText(/—/).map((node) => node.props.children);
    expect(rendered.length).toBeGreaterThan(0);
    expect(screen.getByTestId('resume-list').props.data[0].resumeId).toBe(RESUME.resumeId);
  });
});

describe('ResumeLibraryScreen selection', () => {
  beforeEach(() => {
    listResumes.mockResolvedValue([RESUME, SECOND]);
  });

  it('reports the choice and closes in picker mode', async () => {
    const onSelect = jest.fn();
    render(
      <ResumeLibraryScreen
        navigation={navigation}
        route={route({ jobId: 'job-1', selectedResumeId: null, onSelect })}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('resume-list')).toBeTruthy());

    await act(async () => { fireEvent.press(screen.getByTestId(`resume-row-${SECOND.resumeId}`)); });

    expect(onSelect).toHaveBeenCalledWith({ resumeId: SECOND.resumeId, label: SECOND.resumeLabel });
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('highlights the resume already attached to the job', async () => {
    render(
      <ResumeLibraryScreen
        navigation={navigation}
        route={route({ jobId: 'job-1', selectedResumeId: RESUME.resumeId })}
      />,
    );
    await waitFor(() => expect(screen.getByTestId(`resume-row-${RESUME.resumeId}`)).toBeTruthy());
    expect(screen.getByTestId(`resume-row-${RESUME.resumeId}`).props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId(`resume-row-${SECOND.resumeId}`).props.accessibilityState.selected).toBe(false);
  });

  it('explains that choosing a resume does not send or score anything', async () => {
    render(
      <ResumeLibraryScreen
        navigation={navigation}
        route={route({ jobId: 'job-1', selectedResumeId: null })}
      />,
    );
    await waitFor(() => expect(screen.getByText(/nothing is sent and no scoring happens yet/i)).toBeTruthy());
  });

  it('is read-only in standalone mode', async () => {
    const onSelect = jest.fn();
    // Even a stray callback must not fire: without a jobId there is nothing to attach it to.
    render(<ResumeLibraryScreen navigation={navigation} route={route({ onSelect })} />);
    await waitFor(() => expect(screen.getByTestId('resume-list')).toBeTruthy());

    await act(async () => { fireEvent.press(screen.getByTestId(`resume-row-${RESUME.resumeId}`)); });

    expect(onSelect).not.toHaveBeenCalled();
    expect(navigation.goBack).not.toHaveBeenCalled();
  });
});
