import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import OutreachDraftSection, { type DraftEditPatch } from '../OutreachDraftSection';
import { ApiError } from '../../../api/errors';
import { createJob, type Job } from '../../../domain/job';

// The draft client reaches Firebase for its token, and Firebase's web build is ESM that
// Jest cannot transform. Every test here injects `generateImpl`, so the real client is
// never used; this keeps the module out of the run.
jest.mock('../../../services/firebase', () => ({
  auth: { currentUser: null },
}));

const BASE = { id: 'job-1', now: '2026-10-05T09:00:00.000Z', company: 'Acme', role: 'Dev' };

/** Everything the server's four preconditions ask for. */
const ELIGIBLE = {
  ...createJob({ ...BASE, intakeStatus: 'confirmed' as const }),
  selectedResumeId: 'res-1',
  matchScore: 78,
  matchBreakdown: [
    { criterion: 'skills', score: 80, weight: 1, rationale: 'Covers the required skills.' },
  ],
};

const WITH_DRAFT: Job = {
  ...ELIGIBLE,
  draftSubject: 'Senior Dev at Acme — application',
  draftMessage: 'Hello, I am writing about the Senior Dev role.',
  draftGeneratedAt: '2026-10-05T09:05:00.000Z',
  draftEditedByHuman: false,
};

const EDITED_DRAFT: Job = { ...WITH_DRAFT, draftEditedByHuman: true };

const NEVER_GENERATED = ELIGIBLE;

const NOT_CONFIRMED: Job = { ...WITH_DRAFT, intakeStatus: 'needs_review' };

const NO_RESUME: Job = { ...WITH_DRAFT, selectedResumeId: null };

const NO_MATCH: Job = { ...WITH_DRAFT, matchScore: null, matchBreakdown: null };

/** Unparsed, unmatched, undrafted: fails every precondition and has nothing to show. */
const BARE: Job = createJob({ ...BASE, intakeStatus: 'parsed' });

const EMPTY_BREAKDOWN: Job = { ...WITH_DRAFT, matchBreakdown: [] };

const RESULT = {
  schemaVersion: 1,
  jobId: 'job-1',
  draftSubject: 'Fresh subject',
  draftMessage: 'Fresh body.',
  generatedAt: '2026-10-05T10:00:00.000Z',
};

const generateImpl = jest.fn();
const onGenerated = jest.fn();
const onSaveDraft = jest.fn();
const confirmRegenerate = jest.fn();

type Props = Parameters<typeof OutreachDraftSection>[0];

/** Lets the mount effects settle, so no assertion races the sync of local state. */
async function renderBlock(overrides: Partial<Props> = {}) {
  const props: Props = {
    job: NEVER_GENERATED,
    onGenerated,
    onSaveDraft,
    generateImpl,
    confirmRegenerate,
    ...overrides,
  };
  const view = render(<OutreachDraftSection {...props} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { view, props };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  generateImpl.mockResolvedValue(RESULT);
  onGenerated.mockResolvedValue(undefined);
  onSaveDraft.mockImplementation(async (patch: DraftEditPatch) => ({
    ...WITH_DRAFT,
    ...patch,
  }));
  confirmRegenerate.mockResolvedValue(true);
});

describe('what the section decides to show', () => {
  it('renders nothing for a job with neither a draft nor the preconditions', async () => {
    const view = render(<OutreachDraftSection job={BARE} onSaveDraft={onSaveDraft} />);
    expect(view.toJSON()).toBeNull();
  });

  it('offers the action when nothing has been generated yet', async () => {
    await renderBlock();
    expect(screen.getByText(/Draft a short outreach email/)).toBeTruthy();
    expect(screen.getByLabelText('Generate outreach draft')).toBeTruthy();
    // No draft on the document, so there is deliberately no text to edit yet.
    expect(screen.queryByTestId('draft-subject')).toBeNull();
    expect(generateImpl).not.toHaveBeenCalled();
  });

  it('renders a stored draft without calling the endpoint', async () => {
    await renderBlock({ job: WITH_DRAFT });
    expect(screen.getByDisplayValue(WITH_DRAFT.draftSubject!)).toBeTruthy();
    expect(screen.getByDisplayValue(WITH_DRAFT.draftMessage!)).toBeTruthy();
    expect(screen.getByLabelText('Regenerate outreach draft')).toBeTruthy();
    expect(generateImpl).not.toHaveBeenCalled();
  });

  it('states plainly that nothing is sent from here', async () => {
    await renderBlock({ job: WITH_DRAFT });
    expect(screen.getByTestId('draft-disclaimer')).toHaveTextContent(
      'AI-generated draft — review before sending. Nothing is sent from this screen.',
    );
  });

  it('offers no action until the job is confirmed', async () => {
    await renderBlock({ job: NOT_CONFIRMED });
    expect(screen.getByTestId('draft-subject')).toBeTruthy();
    expect(screen.queryByLabelText('Generate outreach draft')).toBeNull();
    expect(screen.queryByLabelText('Regenerate outreach draft')).toBeNull();
  });

  it.each([
    ['no selected resume', NO_RESUME],
    ['no match score', NO_MATCH],
    ['an empty breakdown', EMPTY_BREAKDOWN],
  ])('offers no action when the job has %s', async (_name, job) => {
    await renderBlock({ job });
    expect(screen.queryByLabelText(/outreach draft$/i)).toBeNull();
    expect(screen.getByTestId('draft-subject')).toBeTruthy();
  });

  it('hides the whole block for an unconfirmed job that has never been drafted', async () => {
    const view = render(
      <OutreachDraftSection job={{ ...ELIGIBLE, intakeStatus: 'parsed' }} onSaveDraft={onSaveDraft} />,
    );
    expect(view.toJSON()).toBeNull();
  });
});

describe('generating', () => {
  it('calls the endpoint for this job and asks the screen to refresh', async () => {
    await renderBlock();
    fireEvent.press(screen.getByLabelText('Generate outreach draft'));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(1));
    expect(generateImpl).toHaveBeenCalledWith('job-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('shows a spinner while the request is in flight', async () => {
    let release: (() => void) | undefined;
    generateImpl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(RESULT);
        }),
    );
    await renderBlock();

    fireEvent.press(screen.getByLabelText('Generate outreach draft'));
    await waitFor(() => expect(screen.getByTestId('draft-spinner')).toBeTruthy());
    expect(screen.queryByText('Generate Draft')).toBeNull();

    await act(async () => {
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByTestId('draft-spinner')).toBeNull();
  });

  it('renders the returned subject and body immediately, without waiting for a reload', async () => {
    await renderBlock();
    fireEvent.press(screen.getByLabelText('Generate outreach draft'));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(1));

    expect(screen.getByDisplayValue('Fresh subject')).toBeTruthy();
    expect(screen.getByDisplayValue('Fresh body.')).toBeTruthy();
    expect(screen.queryByTestId('draft-edited')).toBeNull();
  });

  it('relabels the action once a draft exists', async () => {
    await renderBlock({ job: WITH_DRAFT });
    expect(screen.getByLabelText('Regenerate outreach draft')).toBeTruthy();
  });

  it('adopts a draft that arrives from a repository refresh', async () => {
    const { view, props } = await renderBlock({ job: WITH_DRAFT });
    view.rerender(
      <OutreachDraftSection
        {...props}
        job={{
          ...WITH_DRAFT,
          draftSubject: 'Regenerated elsewhere',
          draftMessage: 'Regenerated body.',
          draftGeneratedAt: '2026-10-05T11:00:00.000Z',
        }}
      />,
    );
    await settle();

    expect(screen.getByDisplayValue('Regenerated elsewhere')).toBeTruthy();
    expect(screen.getByDisplayValue('Regenerated body.')).toBeTruthy();
  });

  it('surfaces a failure from the refresh rather than swallowing it', async () => {
    onGenerated.mockRejectedValueOnce(new Error('Could not reload this job.'));
    await renderBlock();
    fireEvent.press(screen.getByLabelText('Generate outreach draft'));
    expect(await screen.findByText('Could not reload this job.')).toBeTruthy();
  });
});

describe('editing', () => {
  it('marks the draft as human-edited on the first keystroke', async () => {
    await renderBlock({ job: WITH_DRAFT });
    expect(screen.queryByTestId('draft-edited')).toBeNull();

    fireEvent.changeText(screen.getByTestId('draft-subject'), 'My own subject');
    expect(screen.getByTestId('draft-edited')).toBeTruthy();
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it('persists both fields plus the edit flag when the field is left', async () => {
    await renderBlock({ job: WITH_DRAFT });
    fireEvent.changeText(screen.getByTestId('draft-body'), 'My own words.');
    fireEvent(screen.getByTestId('draft-body'), 'endEditing');

    await waitFor(() =>
      expect(onSaveDraft).toHaveBeenCalledWith({
        draftSubject: WITH_DRAFT.draftSubject,
        draftMessage: 'My own words.',
        draftEditedByHuman: true,
      }),
    );
  });

  it('does not save again when nothing changed since the last save', async () => {
    await renderBlock({ job: WITH_DRAFT });
    fireEvent.changeText(screen.getByTestId('draft-subject'), 'Changed');
    fireEvent(screen.getByTestId('draft-subject'), 'endEditing');
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));

    fireEvent(screen.getByTestId('draft-subject'), 'endEditing');
    await settle();
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });

  it('keeps the editor mounted when every character is deleted', async () => {
    await renderBlock({ job: WITH_DRAFT });
    fireEvent.changeText(screen.getByTestId('draft-subject'), '');
    fireEvent.changeText(screen.getByTestId('draft-body'), '');

    expect(screen.getByTestId('draft-subject')).toBeTruthy();
    expect(screen.getByTestId('draft-body')).toBeTruthy();
    expect(screen.getByLabelText('Regenerate outreach draft')).toBeTruthy();
  });

  it('writes nothing but the four draft fields when it saves', async () => {
    await renderBlock({ job: WITH_DRAFT });
    fireEvent.changeText(screen.getByTestId('draft-subject'), 'Changed');
    fireEvent(screen.getByTestId('draft-subject'), 'endEditing');
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));

    const patch = onSaveDraft.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual([
      'draftEditedByHuman',
      'draftMessage',
      'draftSubject',
    ]);
    for (const forbidden of ['approvalStatus', 'applicationStatus', 'approvedAt', 'emailSentOn']) {
      expect(patch).not.toHaveProperty(forbidden);
    }
  });

  it('saves an edit left behind when the sheet closes', async () => {
    const { view } = await renderBlock({ job: WITH_DRAFT });
    fireEvent.changeText(screen.getByTestId('draft-body'), 'Unsaved words.');
    view.unmount();
    await settle();

    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    expect(onSaveDraft).toHaveBeenCalledWith({
      draftSubject: WITH_DRAFT.draftSubject,
      draftMessage: 'Unsaved words.',
      draftEditedByHuman: true,
    });
  });
});

describe('regeneration over human text', () => {
  it('does not ask anything when nobody has edited', async () => {
    await renderBlock({ job: WITH_DRAFT });
    fireEvent.press(screen.getByLabelText('Regenerate outreach draft'));

    await waitFor(() => expect(generateImpl).toHaveBeenCalledTimes(1));
    expect(confirmRegenerate).not.toHaveBeenCalled();
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it('asks before discarding edits made in this session', async () => {
    await renderBlock({ job: WITH_DRAFT });
    fireEvent.changeText(screen.getByTestId('draft-subject'), 'My subject');
    confirmRegenerate.mockResolvedValueOnce(false);

    fireEvent.press(screen.getByLabelText('Regenerate outreach draft'));
    await settle();

    expect(confirmRegenerate).toHaveBeenCalledTimes(1);
    expect(generateImpl).not.toHaveBeenCalled();
  });

  it('asks when the stored draft was edited by a human, even in a fresh session', async () => {
    await renderBlock({ job: EDITED_DRAFT });
    fireEvent.press(screen.getByLabelText('Regenerate outreach draft'));

    await waitFor(() => expect(confirmRegenerate).toHaveBeenCalledTimes(1));
    expect(generateImpl).toHaveBeenCalledTimes(1);
  });

  it('saves the edits onto the document before regenerating', async () => {
    await renderBlock({ job: WITH_DRAFT });
    fireEvent.changeText(screen.getByTestId('draft-subject'), 'Typed late');
    fireEvent.press(screen.getByLabelText('Regenerate outreach draft'));

    await waitFor(() => expect(generateImpl).toHaveBeenCalledTimes(1));
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    expect(onSaveDraft.mock.invocationCallOrder[0]).toBeLessThan(
      generateImpl.mock.invocationCallOrder[0],
    );
  });

  it('does not save when the generation is abandoned by the confirmation', async () => {
    await renderBlock({ job: EDITED_DRAFT });
    confirmRegenerate.mockResolvedValueOnce(false);

    fireEvent.press(screen.getByLabelText('Regenerate outreach draft'));
    await settle();

    expect(confirmRegenerate).toHaveBeenCalledTimes(1);
    expect(onSaveDraft).not.toHaveBeenCalled();
    expect(generateImpl).not.toHaveBeenCalled();
  });

  it('stops rather than regenerating when the edit cannot be saved', async () => {
    onSaveDraft.mockRejectedValueOnce(new Error('Permission denied.'));
    await renderBlock({ job: WITH_DRAFT });
    fireEvent.changeText(screen.getByTestId('draft-subject'), 'Typed');
    fireEvent.press(screen.getByLabelText('Regenerate outreach draft'));

    await waitFor(() => expect(screen.getByText(/Permission denied\./)).toBeTruthy());
    expect(generateImpl).not.toHaveBeenCalled();
  });
});

describe('failure copy', () => {
  async function failWith(error: unknown, job: Job = NEVER_GENERATED) {
    generateImpl.mockRejectedValueOnce(error);
    await renderBlock({ job });
    fireEvent.press(
      screen.getByLabelText(job.draftSubject === null ? 'Generate outreach draft' : 'Regenerate outreach draft'),
    );
    await settle();
  }

  it('names an expired session rather than blaming the server', async () => {
    await failWith(new ApiError('unauthorized', 'Authentication required.', 401));
    expect(await screen.findByText('Sign in again to generate the draft.')).toBeTruthy();
  });

  it('names a missing local session the same way', async () => {
    await failWith(new ApiError('not_authenticated', 'Not signed in.', null));
    expect(await screen.findByText('Sign in again to generate the draft.')).toBeTruthy();
  });

  it('names a timeout rather than echoing it', async () => {
    await failWith(new ApiError('timeout', 'Request timed out after 15000ms.', null));
    expect(await screen.findByText('That took too long. Try again.')).toBeTruthy();
  });

  it('explains an unreadable payload as a version problem', async () => {
    const error = new Error('not in the expected format');
    error.name = 'InvalidDraftResponseError';
    await failWith(error);
    expect(await screen.findByText(/cannot read. Update the app/)).toBeTruthy();
  });

  it("shows the server's own precondition message, which is written for a human", async () => {
    await failWith(
      new ApiError('client', 'This job has no selected resume. Run a match first.', 409),
    );
    expect(await screen.findByText('This job has no selected resume. Run a match first.')).toBeTruthy();
  });

  it('stays quiet when the sheet closed and the request was cancelled', async () => {
    await failWith(new ApiError('canceled', 'Request cancelled.', null));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it('reports a failed save on its own, without blaming the generator', async () => {
    onSaveDraft.mockRejectedValueOnce(new Error('Offline.'));
    await renderBlock({ job: WITH_DRAFT });
    fireEvent.changeText(screen.getByTestId('draft-body'), 'Words');
    fireEvent(screen.getByTestId('draft-body'), 'endEditing');

    expect(await screen.findByText(/Could not save your edit\. Offline\./)).toBeTruthy();
    expect(generateImpl).not.toHaveBeenCalled();
  });
});

describe('what is never offered', () => {
  it('has no send, approve, or status control anywhere in the block', async () => {
    await renderBlock({ job: WITH_DRAFT });
    const text = JSON.stringify(screen.toJSON());

    for (const forbidden of ['Send Email', 'Send Draft', 'Approve', 'applicationStatus', 'Mark as']) {
      expect(text).not.toContain(forbidden);
    }
    expect(screen.queryAllByLabelText(/send/i)).toHaveLength(0);
    expect(screen.queryAllByLabelText(/approve/i)).toHaveLength(0);
  });

  it('renders no eighth action beyond generating and editing', async () => {
    await renderBlock({ job: WITH_DRAFT });
    expect(screen.queryAllByRole('button')).toHaveLength(1);
  });
});
