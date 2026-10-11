import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { generateSuggestions, toPersistedSuggestions } from '../../api/suggestions';
import { ApiError } from '../../api/errors';
import {
  SUGGESTION_CATEGORY_LABELS,
  SUGGESTION_PRIORITY_LABELS,
} from '../../domain/job';
import type { Job, ResumeSuggestion } from '../../domain/job';

interface Props {
  job: Job;
  /**
   * Called after a successful generation so the screen can re-read the job from the
   * repository. Suggestions are persisted server-side; this is how the UI catches up.
   */
  onGenerated?: () => void | Promise<void>;
  /** Overridable for tests. Defaults to the real endpoint. */
  generateImpl?: typeof generateSuggestions;
}

/**
 * Turns a thrown value into something worth showing a user, or `null` to stay quiet.
 *
 * Cancellation is the normal outcome of closing the sheet, so it produces no message.
 * An authentication problem and a timeout each get their own sentence, because neither is
 * the server's fault and the server's copy would not help. Everything else shows the
 * server's own message, which is safe by construction: the endpoint only ever returns
 * fixed strings for 409 and 404, and a fixed string for 500.
 */
function describeFailure(caught: unknown): string | null {
  if (caught instanceof ApiError && caught.isBenign) return null;
  if (caught instanceof ApiError && caught.isAuthProblem) return 'Sign in again to generate suggestions.';
  if (caught instanceof ApiError && caught.kind === 'timeout') return 'That took too long. Try again.';
  if (caught instanceof Error && caught.name === 'InvalidSuggestionsResponseError') {
    return 'The server sent suggestions this version cannot read. Update the app to see them.';
  }
  if (caught instanceof Error && caught.message) return caught.message;
  return 'Could not generate suggestions.';
}

/** A suggestion, rendered as what it is: advice plus the two things that justify it. */
function SuggestionCard({ suggestion }: { suggestion: ResumeSuggestion }) {
  const { theme } = useTheme();
  return (
    <View style={[styles.card, { borderColor: theme.border }]} testID={`suggestion-${suggestion.id}`}>
      <View style={styles.cardHead}>
        <Text style={[styles.priority, { color: theme.textMain }]}>
          {SUGGESTION_PRIORITY_LABELS[suggestion.priority]}
        </Text>
        <Text style={[styles.category, { color: theme.textSub }]}>
          {SUGGESTION_CATEGORY_LABELS[suggestion.category]}
        </Text>
      </View>

      <Text style={[styles.title, { color: theme.textMain }]}>{suggestion.title}</Text>
      <Text style={[styles.body, { color: theme.textMain }]}>{suggestion.suggestion}</Text>

      <Text style={[styles.evidenceLabel, { color: theme.textSub }]}>JOB SAYS</Text>
      <Text style={[styles.evidence, { color: theme.textSub }]}>{suggestion.jobEvidence}</Text>

      <Text style={[styles.evidenceLabel, { color: theme.textSub }]}>RESUME SHOWS</Text>
      <Text style={[styles.evidence, { color: theme.textSub }]}>{suggestion.resumeEvidence}</Text>
    </View>
  );
}

/**
 * The resume-suggestion block inside the job detail sheet.
 *
 * What it shows is always `job.resumeSuggestions` — the **persisted** envelope — so the
 * list survives a reload, survives the sheet closing, and is the same on every device.
 * There is no copy of it in component state; a successful generation calls `onGenerated`
 * and lets the repository round-trip bring the saved result back.
 *
 * The three states the envelope can be in are kept distinct on purpose:
 *
 * - `null`        — nobody has asked yet, so the block offers the action.
 * - `{ [] }`      — generated, and nothing was worth recommending. Shown as an answer.
 * - `{ [...] }`   — generated, with the advice itself.
 *
 * The component never writes to Firestore, never edits a resume, and never re-runs the
 * match. A 409 from the server means the match is gone or incomplete, and the message says
 * so — the honest response is to tell the user, not to quietly pick another resume.
 */
export default function ResumeSuggestions({ job, onGenerated, generateImpl = generateSuggestions }: Props) {
  const { theme } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const generateRef = useRef(generateImpl);
  generateRef.current = generateImpl;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const run = useCallback(async () => {
    // A second tap supersedes the first rather than racing it.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setBusy(true);
    setError(null);
    try {
      await generateRef.current(job.id, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      await onGenerated?.();
    } catch (caught) {
      const message = describeFailure(caught);
      if (!mountedRef.current || message === null) return;
      setError(message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [job.id, onGenerated]);

  const persisted = toPersistedSuggestions(job.resumeSuggestions);
  const suggestions = persisted === null ? [] : persisted.suggestions;
  const hasGenerated = persisted !== null;

  return (
    <View style={[styles.block, { borderTopColor: theme.border }]} testID="resume-suggestions">
      <Text style={[styles.heading, { color: theme.textSub }]}>IMPROVE THIS RESUME</Text>

      {!hasGenerated && (
        <Text style={[styles.hint, { color: theme.textSub }]}>
          Get specific, evidence-based ways to improve this resume for this posting.
        </Text>
      )}

      {hasGenerated && suggestions.length === 0 && (
        <Text style={[styles.hint, { color: theme.textSub }]} testID="suggestions-empty">
          Nothing worth changing. This resume already covers the posting.
        </Text>
      )}

      {suggestions.map((suggestion) => (
        <SuggestionCard key={suggestion.id} suggestion={suggestion} />
      ))}

      {suggestions.length > 0 && (
        <Text style={[styles.disclaimer, { color: theme.textSub }]}>
          These are recommendations. The resume is not modified automatically.
        </Text>
      )}

      {error !== null && (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      )}

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.action, busy && styles.actionDisabled]}
          onPress={() => void run()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={hasGenerated ? 'Regenerate resume suggestions' : 'Generate resume suggestions'}
        >
          {busy ? (
            <ActivityIndicator testID="suggestions-spinner" size="small" color={theme.textMain} />
          ) : (
            <Text style={[styles.actionText, { color: theme.textMain }]}>
              {hasGenerated ? 'Regenerate Suggestions' : 'Generate Suggestions'}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 8,
    paddingTop: 14,
    paddingBottom: 4,
  },
  heading: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
  hint: { fontSize: 13, lineHeight: 18 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  priority: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  category: { fontSize: 10, letterSpacing: 0.4 },
  title: { fontSize: 14, fontWeight: '700', marginTop: 6 },
  body: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  evidenceLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.6, marginTop: 8 },
  evidence: { fontSize: 12, lineHeight: 17, marginTop: 2, fontStyle: 'italic' },
  disclaimer: { fontSize: 11, lineHeight: 16, marginTop: 10 },
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
