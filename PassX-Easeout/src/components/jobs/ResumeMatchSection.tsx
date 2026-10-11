import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { listResumes } from '../../api/resumes';
import { matchJob, type MatchRanking } from '../../api/match';
import { ApiError } from '../../api/errors';
import ResumeSuggestions from './ResumeSuggestions';
import {
  MATCH_CRITERIA,
  MATCH_CRITERION_LABELS,
  isMatchCriterion,
  type Job,
  type MatchBreakdown,
  type MatchBreakdownEntry,
} from '../../domain/job';

interface Props {
  job: Job;
  /** Opens the Resume Library so a human can override what matching chose. */
  onOpenResumeLibrary: () => void;
  /**
   * Called after a successful match so the screen can re-read the job from the repository.
   * The match is persisted server-side; this is how the UI catches up with it.
   */
  onMatched: () => void | Promise<void>;
  /** Overridable for tests. Defaults to the real endpoint. */
  runMatchImpl?: typeof matchJob;
  /** Overridable for tests. Defaults to the real Resume Library call. */
  loadResumesImpl?: typeof listResumes;
  /**
   * Called after suggestions are generated so the screen can re-read the job. They are
   * persisted server-side under `job.resumeSuggestions`; this is how the UI catches up.
   */
  onSuggestions?: () => void | Promise<void>;
}

/**
 * Sorts the breakdown into the canonical criterion order regardless of what the server sent,
 * and drops anything this build does not recognise, so a new criterion cannot appear as a raw
 * snake_case row on screen.
 */
function orderBreakdown(breakdown: MatchBreakdown | null): MatchBreakdownEntry[] {
  if (!breakdown) return [];
  const rank = (entry: MatchBreakdownEntry) => {
    const index = (MATCH_CRITERIA as readonly string[]).indexOf(entry.criterion);
    return index === -1 ? MATCH_CRITERIA.length : index;
  };
  return [...breakdown].filter((entry) => isMatchCriterion(entry.criterion)).sort((a, b) => rank(a) - rank(b));
}

/**
 * The resume-match block inside the job detail sheet.
 *
 * What it shows comes from three different places, and keeping them apart is the point:
 *
 * - `job.matchScore`, `job.matchBreakdown`, `job.selectedResumeId` are **persisted**. They
 *   survive a reload and render whether or not this screen started the match.
 * - `rankings` is **session-local**. The endpoint returns every candidate's score, but that
 *   comparison is a one-off, so it is never written back to the job and dies with the screen.
 * - resume **labels** are cosmetic. They are fetched once, and any failure falls back to the
 *   opaque id rather than breaking the section.
 *
 * This component never writes to Firestore. Attaching a resume stays behind the existing
 * picker, and approval, drafting, and sending are not reachable from here at all.
 */
export default function ResumeMatchSection({
  job,
  onOpenResumeLibrary,
  onMatched,
  runMatchImpl = matchJob,
  loadResumesImpl = listResumes,
  onSuggestions,
}: Props) {
  const { theme } = useTheme();
  const [rankings, setRankings] = useState<MatchRanking[] | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const loadResumesRef = useRef(loadResumesImpl);
  loadResumesRef.current = loadResumesImpl;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Closing the sheet cancels an in-flight match. The server may still finish and
      // persist; the user simply stops waiting for an answer they closed.
      controllerRef.current?.abort();
    };
  }, []);

  // One request for the whole library. Labels are decoration, so a failure is swallowed and
  // the opaque resume id is rendered instead.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resumes = await loadResumesRef.current();
        if (cancelled || !mountedRef.current) return;
        const next: Record<string, string> = {};
        for (const resume of resumes) next[resume.resumeId] = resume.resumeLabel;
        setLabels(next);
      } catch {
        // Keep rendering opaque ids rather than failing the section.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const labelFor = useCallback((resumeId: string) => labels[resumeId] ?? resumeId, [labels]);

  const runMatch = useCallback(async () => {
    // A second tap supersedes the first rather than racing it.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setBusy(true);
    setError(null);
    try {
      const result = await runMatchImpl(job.id, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      setRankings(result.rankings);
      await onMatched();
    } catch (caught) {
      // Cancellation is the normal outcome of closing the sheet, not a failure to report.
      if (caught instanceof ApiError && caught.isBenign) return;
      if (!mountedRef.current) return;
      setError(caught instanceof Error && caught.message ? caught.message : 'Could not match this job.');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [job.id, runMatchImpl, onMatched]);

  const breakdown = orderBreakdown(job.matchBreakdown);

  return (
    <View style={[styles.section, { borderTopColor: theme.border }]} testID="resume-match-section">
      <Text style={[styles.heading, { color: theme.textSub }]}>RESUME MATCH</Text>

      <Text style={[styles.scoreValue, { color: theme.textMain }]}>
        {job.matchScore === null ? 'Not matched yet' : `${job.matchScore} / 100`}
      </Text>
      {job.selectedResumeId !== null && (
        <Text style={[styles.selected, { color: theme.textSub }]} numberOfLines={1}>
          {labelFor(job.selectedResumeId)}
        </Text>
      )}

      {job.matchScore === null && (
        <Text style={[styles.hint, { color: theme.textSub }]}>
          Run a match to compare every resume in your library against this posting.
        </Text>
      )}

      {error !== null && (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      )}

      {breakdown.map((entry) => (
        <View key={entry.criterion} style={styles.criterionRow}>
          <View style={styles.criterionHead}>
            <Text style={[styles.criterionLabel, { color: theme.textMain }]}>
              {isMatchCriterion(entry.criterion) ? MATCH_CRITERION_LABELS[entry.criterion] : entry.criterion}
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

      {rankings !== null && (
        <View style={styles.rankings}>
          <Text style={[styles.rankingsHeading, { color: theme.textSub }]}>THIS RUN</Text>
          {rankings.map((ranking, index) => {
            const isSelected = ranking.resumeId === job.selectedResumeId;
            return (
              <View key={ranking.resumeId} style={styles.rankingRow}>
                <Text style={[styles.rankingIndex, { color: theme.textSub }]}>{index + 1}.</Text>
                <Text
                  style={[styles.rankingLabel, { color: isSelected ? theme.textMain : theme.textSub }]}
                  numberOfLines={1}
                >
                  {labelFor(ranking.resumeId)}
                </Text>
                <Text style={[styles.rankingScore, { color: theme.textMain }]}>{ranking.score}</Text>
              </View>
            );
          })}
        </View>
      )}

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.action, busy && styles.actionDisabled]}
          onPress={() => void runMatch()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Re-run resume match"
        >
          {busy ? (
            <ActivityIndicator testID="match-spinner" size="small" color={theme.textMain} />
          ) : (
            <Text style={[styles.actionText, { color: theme.textMain }]}>
              {job.matchScore === null ? 'Run Match' : 'Re-run Match'}
            </Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.action}
          onPress={onOpenResumeLibrary}
          accessibilityRole="button"
          accessibilityLabel="View resume library"
        >
          <Text style={[styles.actionText, { color: theme.textSub }]}>View Resume Library</Text>
        </TouchableOpacity>
      </View>

      {job.selectedResumeId !== null && job.matchBreakdown !== null && (
        <ResumeSuggestions job={job} onGenerated={onSuggestions} />
      )}
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
  scoreValue: { fontSize: 24, fontWeight: '800' },
  selected: { fontSize: 13, marginTop: 2 },
  hint: { fontSize: 13, marginTop: 8, lineHeight: 18 },
  error: { fontSize: 13, marginTop: 8, lineHeight: 18, color: '#E74C3C' },
  criterionRow: { marginTop: 12 },
  criterionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  criterionLabel: { fontSize: 14, fontWeight: '600' },
  criterionScore: { fontSize: 14, fontWeight: '700' },
  criterionWeight: { fontSize: 11, marginTop: 1 },
  rationale: { fontSize: 12, marginTop: 3, lineHeight: 17 },
  rankings: { marginTop: 16 },
  rankingsHeading: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 6 },
  rankingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3 },
  rankingIndex: { fontSize: 13, width: 22 },
  rankingLabel: { fontSize: 13, flex: 1 },
  rankingScore: { fontSize: 13, fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 16 },
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
