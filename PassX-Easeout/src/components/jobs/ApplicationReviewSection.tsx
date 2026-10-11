import React, { useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { startReview, approveJob, rejectJob, reopenJob } from '../../api/approval';
import { sendApplication } from '../../api/send';
import { ApiError } from '../../api/errors';
import StageBadge from './StageBadge';
import ResumeSuggestions from './ResumeSuggestions';
import OutreachDraftSection, { DraftFlushHandle, DraftEditPatch } from './OutreachDraftSection';
import { MATCH_CRITERIA, type MatchCriterion } from '../../domain/job';
import type { Job, MatchBreakdownEntry } from '../../domain/job';

interface Props {
  job: Job;
  /** Called after a successful review action so the screen can re-read the job. */
  onReviewAction: () => void | Promise<void>;
  /** Called after a successful send so the screen can re-read the job. */
  onSend?: () => void | Promise<void>;
  /** Called after a draft save so the screen can re-read the job. */
  onSaveDraft: (patch: DraftEditPatch) => Promise<Job> | Job;
  /** Optional handle to flush unsaved draft edits before approval. */
  draftFlushRef?: React.RefObject<DraftFlushHandle | null> | null;
  /** Overridable for tests. Defaults to the real endpoints. */
  startReviewImpl?: typeof startReview;
  approveJobImpl?: typeof approveJob;
  rejectJobImpl?: typeof rejectJob;
  reopenJobImpl?: typeof reopenJob;
  sendApplicationImpl?: typeof sendApplication;
  /** Resolves `false` to cancel an approval. Defaults to an `Alert`. */
  confirmApprove?: () => Promise<boolean>;
  /** Resolves `false` to cancel a send. Defaults to an `Alert`. */
  confirmSend?: (job: Job) => Promise<boolean>;
}

/**
 * Sorts the breakdown into the canonical criterion order.
 */
function orderBreakdown(breakdown: MatchBreakdownEntry[] | null): MatchBreakdownEntry[] {
  if (!breakdown) return [];
  const rank = (entry: MatchBreakdownEntry) => {
    const index = (MATCH_CRITERIA as readonly string[]).indexOf(entry.criterion);
    return index === -1 ? MATCH_CRITERIA.length : index;
  };
  return [...breakdown]
    .filter((entry): entry is MatchBreakdownEntry & { criterion: MatchCriterion } =>
      (MATCH_CRITERIA as readonly string[]).includes(entry.criterion))
    .sort((a, b) => rank(a) - rank(b));
}

/**
 * Turns a thrown value into something worth showing a user, or `null` to stay quiet.
 */
function describeFailure(caught: unknown): string | null {
  if (caught instanceof ApiError && caught.isBenign) return null;
  if (caught instanceof ApiError && caught.isAuthProblem) return 'Sign in again to complete this action.';
  if (caught instanceof ApiError && caught.kind === 'timeout') return 'That took too long. Try again.';
  if (caught instanceof Error && caught.message) return caught.message;
  return 'Could not complete the action.';
}

const defaultConfirmApprove = (): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    Alert.alert(
      'Approve this application?',
      'This marks the application as approved for the future sending stage.\n\nNothing will be sent yet.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Approve', style: 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

const defaultConfirmSend = (job: Job): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    Alert.alert(
      'Send application?',
      `This will send an application to:\n${job.contactEmail ?? 'No recipient email'}\n\nResume:\n${job.selectedResumeId ?? 'No resume selected'}\n\nNothing else will be changed automatically.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Send Application', style: 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

function formatSentDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The application review block inside the job detail sheet.
 *
 * Combines:
 * - Job summary (company, role, location, contact, deadline)
 * - Selected resume with match score and breakdown
 * - Resume suggestions (if available)
 * - Outreach draft (embedded, read-only until approval actions allow)
 * - Approval controls (Start Review, Approve/Reject, Reopen)
 *
 * The server is the authority on all transitions; this component only reflects the
 * persisted state and dispatches actions. No sending, no Gmail, no status changes
 * beyond approvalStatus.
 */
export default function ApplicationReviewSection({
  job,
  onReviewAction,
  onSend,
  onSaveDraft,
  draftFlushRef,
  startReviewImpl = startReview,
  approveJobImpl = approveJob,
  rejectJobImpl = rejectJob,
  reopenJobImpl = reopenJob,
  sendApplicationImpl = sendApplication,
  confirmApprove = defaultConfirmApprove,
  confirmSend = defaultConfirmSend,
}: Props) {
  const { theme } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const flushRef = useRef<DraftFlushHandle | null>(draftFlushRef?.current ?? null);
  flushRef.current = draftFlushRef?.current ?? null;

  const actionMap = {
    review: startReviewImpl,
    approve: approveJobImpl,
    reject: rejectJobImpl,
    reopen: reopenJobImpl,
  } as const;

  type ActionKey = keyof typeof actionMap;

  const runAction = useCallback(async (action: ActionKey) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // If approving, flush any unsaved draft edits first so the approved version
      // matches what the human was looking at.
      if (action === 'approve' && flushRef.current) {
        await flushRef.current.flush();
      }
      await actionMap[action](job.id);
      await onReviewAction();
    } catch (caught) {
      const message = describeFailure(caught);
      if (!mountedRef.current || message === null) return;
      setError(message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, job.id, onReviewAction, actionMap]);

  const runSend = useCallback(async () => {
    if (busy || job.approvalStatus !== 'approved' || job.emailSentOn || job.gmailThreadId || job.applicationStatus === 'applied') return;
    const confirmed = await confirmSend(job);
    if (!confirmed || !mountedRef.current) return;
    setBusy(true);
    setError(null);
    try {
      await sendApplicationImpl(job.id);
      await onSend?.();
    } catch (caught) {
      const message = describeFailure(caught);
      if (!mountedRef.current || message === null) return;
      setError(message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, job, confirmSend, onSend, sendApplicationImpl]);

  const { approvalStatus, emailSentOn, gmailThreadId } = job;

  const canStartReview = approvalStatus === 'draft';
  const inReview = approvalStatus === 'pending_review';
  const isApproved = approvalStatus === 'approved';
  const isRejected = approvalStatus === 'rejected';
  const alreadySent = Boolean(emailSentOn || gmailThreadId || job.applicationStatus === 'applied');

  return (
    <View style={[styles.section, { borderTopColor: theme.border }]} testID="application-review-section">
      <Text style={[styles.heading, { color: theme.textSub }]}>APPLICATION REVIEW</Text>

      {/* Approval status badge */}
      <View style={styles.statusRow}>
        <StageBadge kind="approval" value={approvalStatus} />
      </View>

      {/* Job summary */}
      <View style={styles.jobSummary}>
        {job.company && (
          <DetailRow label="Company" value={job.company} />
        )}
        {job.role && (
          <DetailRow label="Role" value={job.role} />
        )}
        {job.location && (
          <DetailRow label="Location" value={job.location} />
        )}
        {job.contactName && (
          <DetailRow label="Contact" value={job.contactEmail ? `${job.contactName} (${job.contactEmail})` : job.contactName} />
        )}
        {job.source && (
          <DetailRow label="Source" value={job.source} />
        )}
        {job.deadline && (
          <DetailRow label="Deadline" value={job.deadline} />
        )}
      </View>

      {/* Resume & Match */}
      {job.selectedResumeId && job.matchScore !== null && (
        <View style={styles.matchBlock}>
          <Text style={[styles.subHeading, { color: theme.textSub }]}>RESUME & MATCH</Text>

          <Text style={[styles.matchScore, { color: theme.textMain }]}>
            {job.matchScore} / 100
          </Text>

          <View style={styles.breakdown}>
            {orderBreakdown(job.matchBreakdown).map((entry) => (
              <View key={entry.criterion} style={styles.criterionRow}>
                <View style={styles.criterionHead}>
                  <Text style={[styles.criterionLabel, { color: theme.textMain }]}>
                    {entry.criterion === 'must_have' ? 'Must Have' :
                     entry.criterion === 'nice_to_have' ? 'Nice to Have' :
                     entry.criterion === 'seniority' ? 'Seniority' :
                     entry.criterion === 'role_alignment' ? 'Role Alignment' :
                     entry.criterion === 'technology_alignment' ? 'Technology' : entry.criterion}
                  </Text>
                  <Text style={[styles.criterionScore, { color: theme.textMain }]}>{entry.score} / 100</Text>
                </View>
                <Text style={[styles.criterionWeight, { color: theme.textSub }]}>
                  weight {Math.round(entry.weight * 100)}%
                </Text>
                {entry.rationale !== null && (
                  <Text style={[styles.rationale, { color: theme.textSub }]} numberOfLines={3}>
                    {entry.rationale}
                  </Text>
                )}
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Resume Suggestions */}
      {job.resumeSuggestions && job.resumeSuggestions.suggestions.length > 0 && (
        <ResumeSuggestions job={job} />
      )}

      {/* Outreach Draft — embedded so there is exactly one editor on screen. */}
      <OutreachDraftSection
        ref={flushRef}
        key={job.id}
        job={job}
        onSaveDraft={onSaveDraft}
        onGenerated={onReviewAction}
      />

      {/* Approval Actions */}
      <View style={styles.actions}>
        {canStartReview && (
          <TouchableOpacity
            style={[styles.actionPrimary, busy && styles.actionDisabled]}
            onPress={() => void runAction('review')}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Start review"
          >
            <Text style={[styles.actionText, { color: theme.textMain }]}>Start Review</Text>
          </TouchableOpacity>
        )}

        {inReview && (
          <>
            <TouchableOpacity
              style={[styles.actionDanger, busy && styles.actionDisabled]}
              onPress={() => void runAction('reject')}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Reject application"
            >
              <Text style={[styles.actionText, { color: '#FFFFFF' }]}>Reject</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionPrimary, busy && styles.actionDisabled]}
              onPress={() => void runAction('approve')}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Approve application"
            >
              {busy ? (
                <ActivityIndicator testID="approve-spinner" size="small" color={theme.textMain} />
              ) : (
                <Text style={[styles.actionText, { color: theme.textMain }]}>Approve Application</Text>
              )}
            </TouchableOpacity>
          </>
        )}

        {!alreadySent && (isApproved || isRejected) && (
          <TouchableOpacity
            style={[styles.actionSecondary, busy && styles.actionDisabled]}
            onPress={() => void runAction('reopen')}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={isApproved ? 'Reopen review' : 'Re-enter review'}
          >
            <Text style={[styles.actionText, { color: theme.textSub }]}>{isApproved ? 'Reopen Review' : 'Re-enter Review'}</Text>
          </TouchableOpacity>
        )}

        {/* Send action — only when approved and not already sent */}
        {isApproved && !alreadySent && Boolean(job.contactEmail) && Boolean(job.selectedResumeId) && (
          <TouchableOpacity
            style={[styles.actionPrimary, busy && styles.actionDisabled]}
            onPress={() => void runSend()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Send application"
          >
            {busy ? (
              <ActivityIndicator testID="send-spinner" size="small" color={theme.textMain} />
            ) : (
              <Text style={[styles.actionText, { color: theme.textMain }]}>Send Application</Text>
            )}
          </TouchableOpacity>
        )}

        {/* Already sent state */}
        {alreadySent && (
          <View style={styles.sentState}>
            <Text style={[styles.sentLabel, { color: theme.textSub }]}>Application Sent</Text>
            {emailSentOn && (
              <Text style={[styles.sentDetail, { color: theme.textSub }]}>
                Sent: {formatSentDate(emailSentOn)}
              </Text>
            )}
            {gmailThreadId && (
              <Text style={[styles.sentDetail, { color: theme.textSub }]}>
                Gmail thread: tracked
              </Text>
            )}
          </View>
        )}

        {/* Disclaimer */}
        <Text style={[styles.disclaimer, { color: theme.textSub }]}>
          {inReview ? 'Nothing is sent by approving this application.' : 'Approval is required before sending.'}
        </Text>
      </View>

      {error !== null && (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      )}
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const { theme } = useTheme();
  return (
    <View style={styles.detailRow}>
      <Text style={[styles.detailLabel, { color: theme.textSub }]}>{label}</Text>
      <Text style={[styles.detailValue, { color: theme.textMain }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 8,
    paddingTop: 14,
    paddingBottom: 4,
  },
  heading: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
  statusRow: { marginBottom: 12, alignItems: 'flex-start' },
  jobSummary: { marginBottom: 16 },
  detailRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
  detailLabel: { fontSize: 12, fontWeight: '600', width: 80 },
  detailValue: { fontSize: 12, flex: 1 },
  subHeading: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 6 },
  matchBlock: { marginBottom: 16 },
  matchScore: { fontSize: 24, fontWeight: '800', marginBottom: 8 },
  breakdown: { marginTop: 8 },
  criterionRow: { marginTop: 10 },
  criterionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  criterionLabel: { fontSize: 13, fontWeight: '600' },
  criterionScore: { fontSize: 13, fontWeight: '700' },
  criterionWeight: { fontSize: 11, marginTop: 1 },
  rationale: { fontSize: 12, marginTop: 3, lineHeight: 17 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 16, gap: 8 },
  actionPrimary: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#20B2AA',
    marginBottom: 8,
    justifyContent: 'center',
  },
  actionSecondary: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#95A5A6',
    marginBottom: 8,
    justifyContent: 'center',
  },
  actionDanger: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#E74C3C',
    marginBottom: 8,
    justifyContent: 'center',
  },
  actionDisabled: { opacity: 0.5 },
  actionText: { fontSize: 13, fontWeight: '700' },
  disclaimer: { fontSize: 11, lineHeight: 16, marginTop: 12, fontStyle: 'italic' },
  error: { fontSize: 13, marginTop: 8, lineHeight: 18, color: '#E74C3C' },
  sentState: { marginTop: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#95A5A6' },
  sentLabel: { fontSize: 13, fontWeight: '700', marginBottom: 4 },
  sentDetail: { fontSize: 11, lineHeight: 16, marginBottom: 2 },
});
