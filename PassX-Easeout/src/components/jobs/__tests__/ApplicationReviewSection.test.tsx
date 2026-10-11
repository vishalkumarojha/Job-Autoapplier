import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ApplicationReviewSection from '../ApplicationReviewSection';
import { createJob, type Job } from '../../../domain/job';

jest.mock('../../../services/firebase', () => ({ auth: () => ({ currentUser: null }) }));

jest.mock('../ResumeSuggestions', () => () => null);
jest.mock('../OutreachDraftSection', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return ReactModule.forwardRef(() => <Text>Draft preview</Text>);
});

const base: Job = {
  ...createJob({ id: 'job-1', now: '2026-10-05T10:00:00.000Z', company: 'Example', role: 'Engineer' }),
  intakeStatus: 'confirmed', contactEmail: 'recruiter@example.com', selectedResumeId: 'resume-1',
  matchScore: 90, matchBreakdown: [{ criterion: 'must_have', score: 90, weight: 1, rationale: null }],
  draftSubject: 'Approved subject', draftMessage: 'Approved body', approvalStatus: 'approved',
};
const noop = jest.fn(async () => {});

function view(job: Job, overrides: Partial<React.ComponentProps<typeof ApplicationReviewSection>> = {}) {
  return render(<ApplicationReviewSection job={job} onReviewAction={noop} onSaveDraft={async () => job}
    confirmSend={async () => true} sendApplicationImpl={async () => ({ schemaVersion: 1, jobId: job.id, message: 'sent', threadId: null, sentAt: '2026-10-05T10:00:00Z' })}
    {...overrides} />);
}

beforeEach(() => jest.clearAllMocks());

it('hides Send unless approved', () => {
  view({ ...base, approvalStatus: 'pending_review' });
  expect(screen.queryByLabelText('Send application')).toBeNull();
});

it('asks for explicit confirmation with the Job recipient and selected resume', async () => {
  const confirmSend = jest.fn(async () => false);
  view(base, { confirmSend });
  fireEvent.press(screen.getByLabelText('Send application'));
  await waitFor(() => expect(confirmSend).toHaveBeenCalledWith(base));
  expect(screen.getByText('Approved')).toBeTruthy();
});

it('does not send when confirmation is cancelled', async () => {
  const sendApplicationImpl = jest.fn();
  view(base, { confirmSend: async () => false, sendApplicationImpl });
  fireEvent.press(screen.getByLabelText('Send application'));
  await waitFor(() => expect(sendApplicationImpl).not.toHaveBeenCalled());
});

it('sends after confirmation and refreshes the canonical job', async () => {
  const sendApplicationImpl = jest.fn(async () => ({ schemaVersion: 1, jobId: base.id, message: 'sent', threadId: 'thread-1', sentAt: '2026-10-05T10:00:00Z' }));
  const onSend = jest.fn(async () => {});
  view(base, { sendApplicationImpl, onSend });
  fireEvent.press(screen.getByLabelText('Send application'));
  await waitFor(() => expect(sendApplicationImpl).toHaveBeenCalledWith(base.id));
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
});

it('shows a sent state and removes resend/reopen actions', () => {
  view({ ...base, applicationStatus: 'applied', emailSentOn: '2026-10-05T10:00:00Z' });
  expect(screen.getByText('Application Sent')).toBeTruthy();
  expect(screen.queryByLabelText('Send application')).toBeNull();
  expect(screen.queryByLabelText('Reopen review')).toBeNull();
});

it('reports API failures in the review panel', async () => {
  view(base, { sendApplicationImpl: async () => { throw new Error('This application has already been sent.'); } });
  fireEvent.press(screen.getByLabelText('Send application'));
  expect(await screen.findByText('This application has already been sent.')).toBeTruthy();
});

it('uses a native confirmation containing the canonical recipient and resume id', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find((button) => button.text === 'Send Application')?.onPress?.();
  });
  const sendApplicationImpl = jest.fn(async () => ({ schemaVersion: 1, jobId: base.id, message: 'sent', threadId: null, sentAt: '2026-10-05T10:00:00Z' }));
  view(base, { confirmSend: undefined, sendApplicationImpl });
  fireEvent.press(screen.getByLabelText('Send application'));
  await waitFor(() => expect(sendApplicationImpl).toHaveBeenCalled());
  expect(alert).toHaveBeenCalledWith('Send application?', expect.stringContaining('recruiter@example.com'), expect.any(Array), expect.any(Object));
  expect(alert.mock.calls[0][1]).toContain('resume-1');
});
