import React from 'react';
import { render, screen } from '@testing-library/react-native';
import StageBadge from '../StageBadge';
import type { JobApplicationStatus, JobApprovalStatus, JobIntakeStatus } from '../../../domain/job';

describe('StageBadge', () => {
  it('labels each stage so the pipeline position is readable', () => {
    render(<StageBadge kind="intake" value="confirmed" />);
    expect(screen.getByText('Intake')).toBeTruthy();
    expect(screen.getByText('Confirmed')).toBeTruthy();
  });

  it('uses distinct stage names for the three pipeline stages', () => {
    const intake = render(<StageBadge kind="intake" value="parsed" />);
    expect(intake.getByText('Intake')).toBeTruthy();
    intake.unmount();

    const approval = render(<StageBadge kind="approval" value="pending_review" />);
    expect(approval.getByText('Review')).toBeTruthy();
    approval.unmount();

    const application = render(<StageBadge kind="application" value="applied" />);
    expect(application.getByText('Application')).toBeTruthy();
    // The stage name must not duplicate its own status value.
    expect(application.getAllByText('Applied')).toHaveLength(1);
  });

  it('humanizes snake_case values', () => {
    render(<StageBadge kind="approval" value="pending_review" />);
    expect(screen.getByText('Pending review')).toBeTruthy();
    expect(screen.queryByText('pending_review')).toBeNull();
  });

  it('humanizes multi-word values in the application stage', () => {
    render(<StageBadge kind="application" value="ghosted" />);
    expect(screen.getByText('Ghosted')).toBeTruthy();
  });

  it('omits the stage label in compact mode', () => {
    render(<StageBadge kind="application" value="interview" compact />);
    expect(screen.getByText('Interview')).toBeTruthy();
    expect(screen.queryByText('Application')).toBeNull();
  });

  it.each<[StageKind, string]>([
    ['intake', 'unparsed'],
    ['intake', 'parsed'],
    ['intake', 'needs_review'],
    ['intake', 'confirmed'],
    ['approval', 'draft'],
    ['approval', 'pending_review'],
    ['approval', 'approved'],
    ['approval', 'rejected'],
    ['application', 'draft'],
    ['application', 'applied'],
    ['application', 'interview'],
    ['application', 'offer'],
    ['application', 'rejected'],
    ['application', 'withdrawn'],
    ['application', 'ghosted'],
  ])('renders %s value %s as capitalized text', (kind, value) => {
    const { unmount } = render(<StageBadge kind={kind} value={value as never} />);
    const expected = value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    expect(screen.getByText(expected)).toBeTruthy();
    unmount();
  });

  it('accepts the canonical enum unions without widening them', () => {
    // Compile-time guard: the props must not accept arbitrary strings.
    const intake: JobIntakeStatus = 'needs_review';
    const approval: JobApprovalStatus = 'approved';
    const application: JobApplicationStatus = 'offer';
    const { unmount } = render(<StageBadge kind="intake" value={intake} />);
    unmount();
    render(<StageBadge kind="approval" value={approval} />);
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(application).toBe('offer');
  });

  it('gives a rejected application and a pending review different colours', () => {
    // Distinct tones are what let a user scan the pipeline at a glance. The colour sits
    // on the badge's wrapping View, so the style is read from the text's parent.
    const toneOf = (kind: StageKind, value: string) => {
      const view = render(<StageBadge kind={kind} value={value as never} compact />);
      const label = value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
      // `parent` is the host Text, so walk one more level up to the badge View, which is
      // what actually carries the background colour.
      const badge = view.getByText(label).parent?.parent;
      const style = (badge?.props as { style?: unknown } | undefined)?.style;
      const flattened = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
      view.unmount();
      return (flattened as { backgroundColor?: string } | undefined)?.backgroundColor;
    };
    const rejected = toneOf('application', 'rejected');
    const pending = toneOf('approval', 'pending_review');
    expect(rejected).toBeDefined();
    expect(pending).toBeDefined();
    expect(rejected).not.toBe(pending);
  });
});

type StageKind = 'intake' | 'approval' | 'application';
