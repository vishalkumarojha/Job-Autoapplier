import React, { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Alert,
} from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { generateDraft, DRAFT_MAX_MESSAGE_CHARS, DRAFT_MAX_SUBJECT_CHARS } from '../../api/draft';
import { ApiError } from '../../api/errors';
import type { Job, JobOutreachDraft } from '../../domain/job';

/** The three persisted fields a human edit may change. Nothing else is written here. */
export type DraftEditPatch = Pick<
  JobOutreachDraft,
  'draftSubject' | 'draftMessage' | 'draftEditedByHuman'
>;

/** A handle the parent can use to flush unsaved edits to the server. */
export interface DraftFlushHandle {
  /** Persists any unsaved edits. Returns true if successful or nothing to save. */
  flush: () => Promise<boolean>;
}

interface Props {
  job: Job;
  /**
   * Called after a successful generation so the screen can re-read the job from the
   * repository. The draft is persisted server-side; this is how the UI catches up,
   * including the reset of `draftEditedByHuman`.
   */
  onGenerated?: () => void | Promise<void>;
  /**
   * Persists a human edit and returns the stored job.
   *
   * The screen owns the repository, so this component never touches Firestore itself.
   * Required: an edit that cannot be saved must not look saved.
   */
  onSaveDraft: (patch: DraftEditPatch) => Promise<Job> | Job;
  /** Optional handle the parent can use to flush unsaved edits before approval. */
  flushRef?: React.Ref<DraftFlushHandle>;
  /** Overridable for tests. Defaults to the real endpoint. */
  generateImpl?: typeof generateDraft;
  /**
   * Resolves `false` to cancel a regeneration. Called only when there is human-edited text
   * to lose. Defaults to an `Alert`; tests inject a resolved promise so no native dialog
   * is required.
   */
  confirmRegenerate?: () => Promise<boolean>;
}

/**
 * Turns a thrown value into something worth showing a user, or `null` to stay quiet.
 *
 * Cancellation is the normal outcome of leaving the sheet, so it produces no message. An
 * authentication problem and a timeout each get their own sentence, because neither is the
 * server's fault and the server's copy would not help. Everything else shows the server's
 * own message, which is safe by construction: the endpoint only ever returns fixed strings
 * for the preconditions, for 404, and for 500.
 */
function describeFailure(caught: unknown): string | null {
  if (caught instanceof ApiError && caught.isBenign) return null;
  if (caught instanceof ApiError && caught.isAuthProblem) return 'Sign in again to generate the draft.';
  if (caught instanceof ApiError && caught.kind === 'timeout') return 'That took too long. Try again.';
  if (caught instanceof Error && caught.name === 'InvalidDraftResponseError') {
    return 'The server sent a draft this version cannot read. Update the app to see it.';
  }
  if (caught instanceof Error && caught.message) return caught.message;
  return 'Could not generate the outreach draft.';
}

function describeSaveFailure(caught: unknown): string | null {
  if (caught instanceof ApiError && caught.isBenign) return null;
  if (caught instanceof Error && caught.message) return `Could not save your edit. ${caught.message}`;
  return 'Could not save your edit.';
}

const defaultConfirmRegenerate = (): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    Alert.alert(
      'Regenerate this draft?',
      'A new draft replaces your edits.',
      [
        { text: 'Keep my edits', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Regenerate', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

/**
 * The four questions the server will ask, answered here so the action is not offered when
 * it can only fail. The server remains the authority — this is purely "do not show a button
 * that promises something it cannot do."
 */
function canGenerate(job: Job): boolean {
  if (job.intakeStatus !== 'confirmed') return false;
  if (job.selectedResumeId === null) return false;
  if (job.matchScore === null || typeof job.matchScore !== 'number') return false;
  if (!Array.isArray(job.matchBreakdown) || job.matchBreakdown.length === 0) return false;
  return true;
}

/**
 * The outreach-draft block inside the job detail sheet.
 *
 * What it shows is `job.draftSubject` / `job.draftMessage` — the **persisted** draft — so it
 * survives a reload and is identical on every device. Typing edits a local copy; the stored
 * draft only changes when `onSaveDraft` resolves, and `draftEditedByHuman` flips on the
 * first keystroke so a later regeneration has to ask first.
 *
 * What this component never does, because none of it is Phase 7:
 *
 * - It never sends. There is no Send button, no approve, and no status change anywhere in
 *   this tree; the disclaimer says so out loud.
 * - It never re-generates over human text silently. `job.draftEditedByHuman` or any edit
 *   made in this session routes through `confirmRegenerate`.
 * - It never writes to Firestore directly. Both persistence paths go through the screen.
 */
export default forwardRef<DraftFlushHandle, Props>(function OutreachDraftSection({
  job,
  onGenerated,
  onSaveDraft,
  flushRef,
  generateImpl = generateDraft,
  confirmRegenerate = defaultConfirmRegenerate,
}: Props) {
  const { theme } = useTheme();

  const [subject, setSubject] = useState(job.draftSubject ?? '');
  const [message, setMessage] = useState(job.draftMessage ?? '');
  /**
   * Render-time mirror of `editedRef`. The ref exists so async callbacks read the current
   * value instead of a closure's; the state exists so React re-renders when it flips.
   * The two are always written together.
   */
  const [edited, setEdited] = useState(Boolean(job.draftEditedByHuman));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subjectRef = useRef(subject);
  const messageRef = useRef(message);
  /** Unsaved local changes. Drives whether a flush is needed before anything else happens. */
  const dirtyRef = useRef(false);
  /** Whether a human has touched the text since the last generation. Survives a save. */
  const editedRef = useRef(false);
  /** The `draftGenerationAt` the local copy was last synchronised from. */
  const seededRef = useRef(job.draftGeneratedAt);

  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const generateRef = useRef(generateImpl);
  generateRef.current = generateImpl;
  const saveRef = useRef(onSaveDraft);
  saveRef.current = onSaveDraft;
  const confirmRef = useRef(confirmRegenerate);
  confirmRef.current = confirmRegenerate;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      // Leaving the sheet can happen while a field is focused, in which case
      // `onEndEditing` never fires. Last chance to keep what the human typed.
      if (dirtyRef.current) {
        void Promise.resolve(
          saveRef.current({
            draftSubject: subjectRef.current,
            draftMessage: messageRef.current,
            draftEditedByHuman: true,
          }),
        ).catch(() => undefined);
      }
    };
  }, []);

  // Switching to a different job discards the previous job's local copy outright. There is
  // nothing worth carrying across, and a leftover unsaved edit would otherwise be written
  // onto the wrong document.
  useEffect(() => {
    subjectRef.current = job.draftSubject ?? '';
    messageRef.current = job.draftMessage ?? '';
    setSubject(subjectRef.current);
    setMessage(messageRef.current);
    seededRef.current = job.draftGeneratedAt;
    dirtyRef.current = false;
    editedRef.current = Boolean(job.draftEditedByHuman);
    setEdited(Boolean(job.draftEditedByHuman));
    setError(null);
  }, [job.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A draft that changed elsewhere (a regeneration on this device via `onGenerated`, or on
  // another one) replaces the local copy. Guarded by `draftGeneratedAt` rather than by
  // `draftSubject` so a human save — which leaves the timestamp alone — never overwrites
  // text the user is still looking at.
  useEffect(() => {
    if (job.draftGeneratedAt === seededRef.current) return;
    subjectRef.current = job.draftSubject ?? '';
    messageRef.current = job.draftMessage ?? '';
    setSubject(subjectRef.current);
    setMessage(messageRef.current);
    seededRef.current = job.draftGeneratedAt;
    dirtyRef.current = false;
    // The server stamps `false` on every generation, so this is a fresh draft.
    editedRef.current = false;
    setEdited(false);
  }, [job.draftGeneratedAt, job.draftSubject, job.draftMessage]);

  const persist = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    try {
      await saveRef.current({
        draftSubject: subjectRef.current,
        draftMessage: messageRef.current,
        draftEditedByHuman: true,
      });
      dirtyRef.current = false;
      editedRef.current = true;
      setEdited(true);
      return true;
    } catch (caught) {
      const message_ = describeSaveFailure(caught);
      if (mountedRef.current && message_ !== null) setError(message_);
      return false;
    }
  }, []);

  // Expose a flush handle so the parent can persist unsaved edits before approval.
  useImperativeHandle(flushRef, () => ({
    flush: persist,
  }), [persist]);

  const run = useCallback(async () => {
    // Anything typed but not yet saved is about to be replaced. Put it on the document
    // first, so the confirmation the user is about to answer is about a real stored draft.
    if (editedRef.current || job.draftEditedByHuman) {
      const proceed = await confirmRef.current();
      if (!proceed) return;
    }

    // A second tap supersedes the first rather than racing it.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setBusy(true);
    setError(null);
    try {
      const saved = await persist();
      if (!saved) return;
      const result = await generateRef.current(job.id, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      subjectRef.current = result.draftSubject;
      messageRef.current = result.draftMessage;
      setSubject(result.draftSubject);
      setMessage(result.draftMessage);
      seededRef.current = result.generatedAt;
      dirtyRef.current = false;
      editedRef.current = false;
      setEdited(false);
      await onGenerated?.();
    } catch (caught) {
      const message_ = describeFailure(caught);
      if (!mountedRef.current || message_ === null) return;
      setError(message_);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [job.id, job.draftEditedByHuman, onGenerated, persist]);

  const onEdit = (field: 'subject' | 'body', text: string) => {
    if (field === 'subject') {
      subjectRef.current = text;
      setSubject(text);
    } else {
      messageRef.current = text;
      setMessage(text);
    }
    dirtyRef.current = true;
    if (!editedRef.current) {
      editedRef.current = true;
      setEdited(true);
      setError(null);
    }
  };

  const hasDraft = subject.trim() !== '' || message.trim() !== '';
  const offersAction = canGenerate(job);

  // Nothing to show and nothing to offer: the block would be an empty heading.
  if (!hasDraft && !offersAction) return null;

  const showEditedMarker = edited || job.draftEditedByHuman;
  /**
   * The editor stays mounted once a draft has ever existed, even if the user deletes every
   * character — otherwise the text fields would vanish mid-edit with nowhere to retype.
   * With no draft on the document there is nothing to edit yet, so only the offer is shown;
   * this is also what stops typing into an empty box from becoming a "human edit" that a
   * regeneration then throws away.
   */
  const showEditor = hasDraft || edited || seededRef.current !== null;

  return (
    <View style={[styles.block, { borderTopColor: theme.border }]} testID="outreach-draft">
      <Text style={[styles.heading, { color: theme.textSub }]}>OUTREACH DRAFT</Text>

      {!showEditor && (
        <Text style={[styles.hint, { color: theme.textSub }]}>
          Draft a short outreach email from this posting and your selected resume.
        </Text>
      )}

      {showEditor && (
        <View>
          <TextInput
            style={[styles.subject, { color: theme.textMain, borderColor: theme.border }]}
            value={subject}
            onChangeText={(text) => onEdit('subject', text)}
            onEndEditing={() => void persist()}
            placeholder="Subject"
            placeholderTextColor={theme.textSub}
            accessibilityLabel="Outreach subject"
            testID="draft-subject"
            multiline={false}
            maxLength={DRAFT_MAX_SUBJECT_CHARS}
            editable={!busy}
          />
          <TextInput
            style={[styles.body, { color: theme.textMain, borderColor: theme.border }]}
            value={message}
            onChangeText={(text) => onEdit('body', text)}
            onEndEditing={() => void persist()}
            placeholder="Message"
            placeholderTextColor={theme.textSub}
            accessibilityLabel="Outreach message"
            testID="draft-body"
            multiline
            textAlignVertical="top"
            maxLength={DRAFT_MAX_MESSAGE_CHARS}
            editable={!busy}
          />

          {showEditedMarker && (
            <Text style={[styles.edited, { color: theme.textSub }]} testID="draft-edited">
              You have edited this draft.
            </Text>
          )}

          <Text style={[styles.disclaimer, { color: theme.textSub }]} testID="draft-disclaimer">
            AI-generated draft — review before sending. Nothing is sent from this screen.
          </Text>
        </View>
      )}

      {error !== null && (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      )}

      {offersAction && (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.action, busy && styles.actionDisabled]}
            onPress={() => void run()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={
              showEditor ? 'Regenerate outreach draft' : 'Generate outreach draft'
            }
          >
            {busy ? (
              <ActivityIndicator testID="draft-spinner" size="small" color={theme.textMain} />
            ) : (
              <Text style={[styles.actionText, { color: theme.textMain }]}>
                {showEditor ? 'Regenerate Draft' : 'Generate Draft'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}
);
const styles = StyleSheet.create({
  block: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 8,
    paddingTop: 14,
    paddingBottom: 4,
  },
  heading: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
  hint: { fontSize: 13, lineHeight: 18 },
  subject: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  body: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    lineHeight: 19,
    minHeight: 140,
  },
  edited: { fontSize: 11, lineHeight: 16, marginTop: 8, fontStyle: 'italic' },
  disclaimer: { fontSize: 11, lineHeight: 16, marginTop: 8 },
  error: { fontSize: 13, marginTop: 8, lineHeight: 18, color: '#E74C3C' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 14 },
  action: {
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#95A5A6',
    marginRight: 8,
    marginBottom: 8,
    justifyContent: 'center',
  },
  actionDisabled: { opacity: 0.5 },
  actionText: { fontSize: 13, fontWeight: '600' },
});
