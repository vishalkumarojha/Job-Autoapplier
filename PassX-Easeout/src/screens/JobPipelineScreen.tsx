import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Modal,
  ScrollView,
  Alert,
  ActivityIndicator,
  RefreshControl,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { createFirestoreJobsRepository } from '../data/jobs/firestore';
import type { JobsRepository } from '../data/jobs/types';
import {
  JOB_APPLICATION_STATUSES,
  isCanonicalJob,
} from '../domain/job';
import type { Job, JobApplicationStatus } from '../domain/job';
import type { RootStackParamList } from '../types/navigation';
import BackHeader from '../components/BackHeader';
import JobCard from '../components/jobs/JobCard';
import JobForm from '../components/jobs/JobForm';
import type { JobFormValues } from '../components/jobs/JobForm';
import StageBadge from '../components/jobs/StageBadge';
import DeadlineChip from '../components/jobs/DeadlineChip';
import ResumeMatchSection from '../components/jobs/ResumeMatchSection';
import OutreachDraftSection, { type DraftEditPatch } from '../components/jobs/OutreachDraftSection';
import ApplicationReviewSection from '../components/jobs/ApplicationReviewSection';
import { parseNormalizedIsoDate, syncJobDeadlineNotification, syncJobFollowupNotification } from '../services/NotificationService';

type Props = NativeStackScreenProps<RootStackParamList, 'JobPipeline'>;

const SUCCESS_VISIBLE_MS = 3000;
const ACCENT = '#20B2AA';

/**
 * Turns a thrown value into something worth showing a user.
 *
 * `JobNotFoundError` is detected by name rather than by importing the class, so this
 * screen stays dependent on the `JobsRepository` abstraction instead of the Firestore
 * implementation that happens to raise it.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'JobNotFoundError') return 'That job no longer exists.';
    if (error.message) return error.message;
  }
  return 'Something went wrong. Please try again.';
}

function formatTimestamp(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!match) return iso.trim();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = months[Number(match[2]) - 1] ?? match[2];
  return `${Number(match[3])} ${monthName} ${match[1]}`;
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  const { theme } = useTheme();
  if (value == null || value === '') return null;
  return (
    <View style={styles.detailRow}>
      <Text style={[styles.detailLabel, { color: theme.textSub }]}>{label}</Text>
      <Text style={[styles.detailValue, { color: theme.textMain }]}>{value}</Text>
    </View>
  );
}

function FollowupReminderEditor({ value, color, muted, border, background, onSave }: {
  value: string | null; color: string; muted: string; border: string; background: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  return (
    <View style={styles.reminderEditor}>
      <Text style={[styles.detailLabel, { color: muted }]}>FOLLOW-UP REMINDER (ISO DATE/TIME)</Text>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="2026-10-10T09:00:00.000Z"
        placeholderTextColor={muted}
        autoCapitalize="none"
        style={[styles.reminderInput, { color, borderColor: border, backgroundColor: background }]}
        accessibilityLabel="Follow-up reminder date and time"
      />
      <TouchableOpacity style={styles.reminderSave} onPress={() => void onSave(draft.trim())} accessibilityRole="button">
        <Text style={styles.reminderSaveText}>{draft.trim() ? 'Save reminder' : 'Clear reminder'}</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function JobPipelineScreen({ navigation, route }: Props) {
  const { user } = useAuth();
  const { theme } = useTheme();

  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState<Job | null>(null);
  const [selected, setSelected] = useState<Job | null>(null);

  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (successTimer.current) clearTimeout(successTimer.current);
    };
  }, []);

  // One repository per user. The screen holds the abstraction, not a Firestore handle.
  const repository: JobsRepository | null = useMemo(
    () => (user ? createFirestoreJobsRepository(user.uid) : null),
    [user],
  );

  const showSuccess = useCallback((message: string) => {
    setSuccessMsg(message);
    if (successTimer.current) clearTimeout(successTimer.current);
    successTimer.current = setTimeout(() => {
      if (mounted.current) setSuccessMsg(null);
    }, SUCCESS_VISIBLE_MS);
  }, []);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!repository) {
        setLoadError('You need to be signed in to view jobs.');
        setLoading(false);
        return;
      }
      if (mode === 'initial') setLoading(true);
      setLoadError(null);
      try {
        const jobs = await repository.listJobs();
        await Promise.all(jobs.flatMap((job) => [syncJobDeadlineNotification(job), syncJobFollowupNotification(job)]));
        if (!mounted.current) return;
        setAllJobs(jobs);
      } catch (error) {
        console.error('[JobPipeline] listJobs failed', error);
        if (!mounted.current) return;
        setLoadError(describeError(error));
      } finally {
        if (mounted.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [repository],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  /**
   * Re-sync `selected` from `allJobs` so it never goes stale after a refresh.
   *
   * Gated only on `[allJobs]` — not on `selected` — to avoid overwriting a fresh
   * `setSelected(updated)` that arrives from an in-flight mutation (e.g. draft save
   * or status change) before the next `load('refresh')` resolves.
   */
  useEffect(() => {
    if (!mounted.current) return;
    const currentSelected = selected;
    if (!currentSelected) return;
    const refreshed = allJobs.find((j) => j.id === currentSelected.id);
    if (refreshed && refreshed !== currentSelected) {
      setSelected(refreshed);
    }
  }, [allJobs]);

  useEffect(() => {
    const jobId = route.params?.jobId;
    if (!jobId) return;
    const match = allJobs.find((job) => job.id === jobId);
    if (match) {
      setSelected(match);
      navigation.setParams({ jobId: undefined });
    }
  }, [allJobs, route.params?.jobId, navigation]);

  /**
   * Canonical records only.
   *
   * `schemaVersion` is the boundary: documents written by the Phase 1 repository carry
   * `JOB_SCHEMA_VERSION` or higher, while legacy Job Tracker documents have no version
   * field and read back as 0. Filtering here means those records are never rendered as
   * blank canonical jobs, and nothing is written back to them — no silent migration.
   */
  const canonicalJobs = useMemo(() => allJobs.filter(isCanonicalJob), [allJobs]);

  const legacyCount = allJobs.length - canonicalJobs.length;

  const openCreate = useCallback(() => {
    setEditing(null);
    setFormError(null);
    setFormVisible(true);
  }, []);

  const openEdit = useCallback((job: Job) => {
    setSelected(null);
    setEditing(job);
    setFormError(null);
    setFormVisible(true);
  }, []);

  const closeForm = useCallback(() => {
    if (saving) return;
    setFormVisible(false);
    setEditing(null);
    setFormError(null);
  }, [saving]);

  const handleFormSubmit = useCallback(
    async (values: JobFormValues) => {
      if (!repository) return;

      // Provenance follows who supplied the value. In this phase that is always a human.
      const provenance = {
        deadlineSource: values.deadline ? ('user_entered' as const) : ('unknown' as const),
        contactEmailSource: values.contactEmail ? ('user_entered' as const) : ('unknown' as const),
      };

      setSaving(true);
      setFormError(null);
      try {
        if (editing) {
          // Partial update: untouched fields are preserved by the repository and
          // `dedupeKey` is recomputed there, never here.
          const updated = await repository.updateJob(editing.id, {
            ...values,
            ...provenance,
            intakeStatus: 'confirmed',
          });
          setSelected((current) => (current && current.id === updated.id ? updated : current));
          showSuccess('Job updated.');
        } else {
          await repository.createJob({
            ...values,
            ...provenance,
            intakeStatus: 'confirmed',
            rawSource: 'manual',
          });
          showSuccess('Job created.');
        }
        setFormVisible(false);
        setEditing(null);
        await load('refresh');
      } catch (error) {
        console.error('[JobPipeline] save failed', { mode: editing ? 'update' : 'create', error });
        if (mounted.current) setFormError(describeError(error));
      } finally {
        if (mounted.current) setSaving(false);
      }
    },
    [repository, editing, load, showSuccess],
  );

  const handleArchive = useCallback(
    (job: Job) => {
      if (!repository) return;
      const label = job.role ?? 'Untitled role';
      const company = job.company ?? 'unknown company';
      Alert.alert(
        'Archive job',
        `Archive "${label} at ${company}"? It will be hidden from the pipeline but kept, never deleted.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Archive',
            style: 'destructive',
            onPress: async () => {
              try {
                await repository.archiveJob(job.id);
                const { cancelJobNotifications } = await import('../services/NotificationService');
                await cancelJobNotifications(job.id);
                setSelected((current) => (current && current.id === job.id ? null : current));
                showSuccess('Job archived.');
                await load('refresh');
              } catch (error) {
                console.error('[JobPipeline] archiveJob failed', { jobId: job.id, error });
                if (mounted.current) Alert.alert('Could not archive', describeError(error));
              }
            },
          },
        ],
      );
    },
    [repository, load, showSuccess],
  );

  /**
   * Attaches a resume to a job.
   *
   * The patch contains `selectedResumeId` and nothing else. That is deliberate: matching,
   * scoring, and approval are separate features with their own approval gates, and a selection
   * must not be able to move any of them as a side effect. `dedupeKey` is recomputed by the
   * repository from the identifying fields, which this patch does not touch.
   */
  const handleSelectResume = useCallback(
    async (jobId: string, resumeId: string, label: string) => {
      if (!repository) return;
      try {
        const updated = await repository.updateJob(jobId, { selectedResumeId: resumeId });
        setSelected((current) => (current && current.id === updated.id ? updated : current));
        showSuccess(`Resume attached: ${label}`);
        await load('refresh');
      } catch (error) {
        console.error('[JobPipeline] selectResume failed', { jobId, error });
        if (mounted.current) Alert.alert('Could not attach resume', describeError(error));
      }
    },
    [repository, load, showSuccess],
  );

  const openResumePicker = useCallback(
    (job: Job) => {
      navigation.navigate('ResumeLibrary', {
        jobId: job.id,
        selectedResumeId: job.selectedResumeId,
        onSelect: (result) => {
          void handleSelectResume(job.id, result.resumeId, result.label);
        },
      });
    },
    [navigation, handleSelectResume],
  );

  const handleApplicationStatus = useCallback(
    async (job: Job, status: JobApplicationStatus) => {
      if (!repository || job.applicationStatus === status) return;
      try {
        const updated = await repository.updateJob(job.id, { applicationStatus: status });
        setSelected(updated);
        await load('refresh');
      } catch (error) {
        console.error('[JobPipeline] updateJob failed', { jobId: job.id, error });
        if (mounted.current) Alert.alert('Could not update', describeError(error));
      }
    },
    [repository, load],
  );

  /**
   * Persists a human edit of the outreach draft.
   *
   * The four draft fields are ordinary job fields, so this is the same `updateJob` path
   * the form and the stage picker use — no separate writer, no approval, no send. The
   * returned job is pushed into `selected` so the sheet reflects the save immediately
   * instead of waiting for a list refresh.
   */
  const handleSaveDraft = useCallback(
    async (jobId: string, patch: DraftEditPatch): Promise<Job> => {
      if (!repository) throw new Error('You need to be signed in to save this draft.');
      try {
        const updated = await repository.updateJob(jobId, patch);
        setSelected((current) => (current && current.id === updated.id ? updated : current));
        return updated;
      } catch (error) {
        console.error('[JobPipeline] saveDraft failed', { jobId, error });
        throw error;
      }
    },
    [repository],
  );

  /** Triggers an approval action and refreshes the job list. */
  const runApproval = useCallback(async () => {
    if (!repository || !selected) return;
    await load('refresh');
  }, [repository, selected, load]);

  /** Ref passed to ApplicationReviewSection so it can flush unsaved draft edits before approval. */
  const draftFlushRef = useRef<{ flush: () => Promise<boolean> } | null>(null);

  const renderBody = () => {
    if (loading) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#20B2AA" />
          <Text style={[styles.centeredText, { color: theme.textSub }]}>Loading your jobs…</Text>
        </View>
      );
    }

    if (loadError != null && canonicalJobs.length === 0) {
      return (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={44} color="#E74C3C" />
          <Text style={[styles.errorTitle, { color: theme.textMain }]}>Could not load jobs</Text>
          <Text style={[styles.centeredText, { color: theme.textSub }]}>{loadError}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => void load('initial')}>
            <Ionicons name="refresh" size={16} color="#FFFFFF" />
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <FlatList
        data={canonicalJobs}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load('refresh');
            }}
            tintColor={theme.textSub}
          />
        }
        ListHeaderComponent={
          legacyCount > 0 ? (
            <View style={[styles.legacyNotice, { backgroundColor: theme.iconBg }]}>
              <Ionicons name="information-circle-outline" size={16} color={theme.textSub} />
              <Text style={[styles.legacyText, { color: theme.textSub }]}>
                {legacyCount} older job {legacyCount === 1 ? 'record uses' : 'records use'} the previous
                tracker format and {legacyCount === 1 ? 'is' : 'are'} not shown here. They have not
                been changed or moved — open the Job Tracker to see them.
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          loadError != null ? null : (
            <View style={styles.emptyState}>
              <Ionicons name="git-branch-outline" size={52} color={theme.border} />
              <Text style={[styles.emptyTitle, { color: theme.textMain }]}>No jobs in the pipeline yet</Text>
              <Text style={[styles.emptyText, { color: theme.textSub }]}>
                Add a job manually to start. Smart Intake, resume matching, and outreach drafting
                arrive in later phases — nothing is inferred for you here.
              </Text>
              <TouchableOpacity style={styles.emptyBtn} onPress={openCreate}>
                <Ionicons name="add" size={18} color="#FFFFFF" />
                <Text style={styles.emptyBtnText}>Add Job</Text>
              </TouchableOpacity>
            </View>
          )
        }
        renderItem={({ item }) => (
          <JobCard
            job={item}
            onPress={() => setSelected(item)}
            onEdit={() => openEdit(item)}
            onArchive={() => handleArchive(item)}
          />
        )}
      />
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <BackHeader
        title="Job Pipeline"
        navigation={navigation}
        rightElement={
          <TouchableOpacity
            style={styles.addBtn}
            onPress={openCreate}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Add job"
          >
            <Ionicons name="add" size={18} color="#FFFFFF" />
            <Text style={styles.addBtnText}>Add Job</Text>
          </TouchableOpacity>
        }
      />

      <View style={[styles.subHeader, { borderBottomColor: theme.border }]}>
        <Text style={[styles.subHeaderText, { color: theme.textSub }]}>
          Canonical jobs · {canonicalJobs.length} active
        </Text>
        <View style={styles.subHeaderActions}>
          <TouchableOpacity
            style={styles.subHeaderLink}
            onPress={() => navigation.navigate('JobIntake', { onSaved: () => void load('refresh') })}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Open Smart Intake"
          >
            <Ionicons name="sparkles-outline" size={14} color="#20B2AA" />
            <Text style={styles.subHeaderLinkText}>Intake</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.subHeaderLink}
            onPress={() => navigation.navigate('ResumeLibrary')}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Open resume library"
          >
            <Ionicons name="documents-outline" size={14} color="#20B2AA" />
            <Text style={styles.subHeaderLinkText}>Resumes</Text>
          </TouchableOpacity>
        </View>
      </View>

      {successMsg != null && (
        <View style={styles.successBar}>
          <Ionicons name="checkmark-circle" size={16} color="#1E8449" />
          <Text style={styles.successText}>{successMsg}</Text>
        </View>
      )}

      {renderBody()}

      {/* Create / edit */}
      <Modal visible={formVisible} animationType="slide" onRequestClose={closeForm}>
        <SafeAreaView style={[styles.modalRoot, { backgroundColor: theme.background }]}>
          <JobForm
            key={editing === null ? 'create' : `edit-${editing.id}`}
            mode={editing === null ? 'create' : 'edit'}
            initial={editing}
            submitting={saving}
            serverError={formError}
            onSubmit={(values) => void handleFormSubmit(values)}
            onCancel={closeForm}
          />
        </SafeAreaView>
      </Modal>

      {/* Detail */}
      <Modal
        visible={selected !== null}
        animationType="fade"
        transparent
        onRequestClose={() => setSelected(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.detailCard, { backgroundColor: theme.card }]}>
            {selected !== null && (
              <>
                <View style={[styles.detailHeader, { borderBottomColor: theme.border }]}>
                  <Text style={[styles.detailTitle, { color: theme.textMain }]} numberOfLines={2}>
                    {selected.role ?? 'Untitled role'}
                  </Text>
                  <Text style={[styles.detailSubtitle, { color: theme.textSub }]} numberOfLines={1}>
                    {selected.company ?? 'Company not set'}
                  </Text>
                </View>

                <ScrollView style={styles.detailBody} contentContainerStyle={styles.detailBodyContent}>
                  <View style={styles.detailBadges}>
                    <StageBadge kind="intake" value={selected.intakeStatus} />
                    <StageBadge kind="approval" value={selected.approvalStatus} />
                  </View>

                  <DetailRow label="Location" value={selected.location} />
                  <DetailRow label="Job URL" value={selected.jobUrl} />
                  <DetailRow label="Source" value={selected.source} />
                  <DetailRow label="Contact" value={selected.contactName} />
                  <DetailRow label="Contact email" value={selected.contactEmail} />
                  <DetailRow label="Notes" value={selected.notes} />
                  <DetailRow label="Follow-up status" value={selected.followUpStatus.replace(/_/g, ' ')} />
                  <DetailRow label="Last follow-up sent" value={selected.followUpLastSentAt ? formatTimestamp(selected.followUpLastSentAt) : null} />

                  {/* Selection entry point. The stored value is an opaque id, so the
                      detail view labels it "Change" rather than pretending to name a file. */}
                  <TouchableOpacity
                    style={styles.detailRow}
                    onPress={() => openResumePicker(selected)}
                    accessibilityRole="button"
                    accessibilityLabel="Choose resume"
                  >
                    <Text style={[styles.detailLabel, { color: theme.textSub }]}>Selected resume</Text>
                    <View style={styles.resumeRow}>
                      <Text style={[styles.detailValue, { color: theme.textMain }]} numberOfLines={1}>
                        {selected.selectedResumeId ?? 'None selected'}
                      </Text>
                      <Ionicons name="chevron-forward" size={16} color={theme.textSub} />
                    </View>
                  </TouchableOpacity>
                  {/* Resume matching. The persisted score, breakdown, and ranking live here;
                      the section never writes to Firestore, so attaching a resume still goes
                      through the picker row above and approval is untouched. */}
                  <ResumeMatchSection
                    job={selected}
                    onOpenResumeLibrary={() => openResumePicker(selected)}
                    onMatched={() => load('refresh')}
                    onSuggestions={() => load('refresh')}
                  />
                  {/* Application Review. Combines the job summary, resume match, suggestions,
                      outreach draft, and approval actions in one surface so there is
                      exactly one draft editor on screen. Keyed by id so switching jobs
                      starts from a clean state. */}
                  <ApplicationReviewSection
                    key={selected.id}
                    job={selected}
                    onReviewAction={runApproval}
                    onSend={() => load('refresh')}
                    onSaveDraft={(patch) => handleSaveDraft(selected.id, patch)}
                    draftFlushRef={draftFlushRef}
                  />

                  <View style={styles.detailRow}>
                    <Text style={[styles.detailLabel, { color: theme.textSub }]}>Deadline</Text>
                    <DeadlineChip deadline={selected.deadline} />
                  </View>

                  <FollowupReminderEditor
                    value={selected.nextReminderAt}
                    color={theme.textMain}
                    muted={theme.textSub}
                    border={theme.border}
                    background={theme.inputBg}
                    onSave={async (value) => {
                      if (!repository) return;
                      if (value && !parseNormalizedIsoDate(value)) {
                        Alert.alert('Invalid reminder', 'Enter a valid ISO date and time, such as 2026-10-10T09:00:00.000Z.');
                        return;
                      }
                      try {
                        const updated = await repository.updateJob(selected.id, { nextReminderAt: value || null });
                        setSelected(updated);
                        await syncJobFollowupNotification(updated);
                        showSuccess(value ? 'Follow-up reminder saved.' : 'Follow-up reminder cleared.');
                      } catch (error) { Alert.alert('Could not save reminder', describeError(error)); }
                    }}
                  />

                  <View style={styles.detailRow}>
                    <Text style={[styles.detailLabel, { color: theme.textSub }]}>Created</Text>
                    <Text style={[styles.detailValue, { color: theme.textMain }]}>
                      {formatTimestamp(selected.createdAt)}
                    </Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={[styles.detailLabel, { color: theme.textSub }]}>Updated</Text>
                    <Text style={[styles.detailValue, { color: theme.textMain }]}>
                      {formatTimestamp(selected.updatedAt)}
                    </Text>
                  </View>

                  <Text style={[styles.statusHeading, { color: theme.textSub }]}>APPLICATION STATUS</Text>
                  <View style={styles.chipRow}>
                    {JOB_APPLICATION_STATUSES.map((status) => {
                      const active = selected.applicationStatus === status;
                      return (
                        <TouchableOpacity
                          key={status}
                          style={[
                            styles.chip,
                            {
                              backgroundColor: active ? '#20B2AA' : theme.inputBg,
                              borderColor: active ? '#20B2AA' : theme.border,
                            },
                          ]}
                          onPress={() => void handleApplicationStatus(selected, status)}
                        >
                          <Text
                            style={[styles.chipText, { color: active ? '#FFFFFF' : theme.textMain }]}
                          >
                            {status.replace(/_/g, ' ')}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <Text style={[styles.notImplemented, { color: theme.textSub }]}>
                    Outreach drafting and approval are not wired up yet, so the review stage stays at
                    its current value.
                  </Text>
                </ScrollView>

                <View style={[styles.detailFooter, { borderTopColor: theme.border }]}>
                  <TouchableOpacity onPress={() => openEdit(selected)}>
                    <Text style={styles.footerAction}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleArchive(selected)}>
                    <Text style={[styles.footerAction, styles.footerDestructive]}>Archive</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSelected(null)}>
                    <Text style={[styles.footerAction, { color: theme.textSub }]}>Close</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#20B2AA',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 18,
    gap: 4,
  },
  addBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
  subHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderBottomWidth: 1,
    gap: 12,
  },
  subHeaderText: { fontSize: 12, fontWeight: '600', letterSpacing: 0.3, flexShrink: 1 },
  subHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  subHeaderLink: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  subHeaderLinkText: { color: ACCENT, fontWeight: '700', fontSize: 13 },
  resumeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  reminderEditor: { gap: 8, paddingVertical: 12 },
  reminderInput: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 9, fontSize: 13 },
  reminderSave: { alignSelf: 'flex-start', paddingVertical: 7, paddingHorizontal: 12, backgroundColor: ACCENT, borderRadius: 8 },
  reminderSaveText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  successBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#E9F7EF',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  successText: { color: '#1E8449', fontSize: 13, fontWeight: '600' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 10 },
  centeredText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  errorTitle: { fontSize: 17, fontWeight: '700', marginTop: 4 },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#20B2AA',
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 12,
    marginTop: 12,
  },
  retryText: { color: '#FFFFFF', fontWeight: '700' },
  listContent: { padding: 20, paddingBottom: 40, flexGrow: 1 },
  legacyNotice: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderRadius: 10,
    marginBottom: 16,
  },
  legacyText: { fontSize: 12, lineHeight: 17, flexShrink: 1 },
  emptyState: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginTop: 16 },
  emptyText: { fontSize: 14, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#20B2AA',
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 22,
    marginTop: 22,
  },
  emptyBtnText: { color: '#FFFFFF', fontWeight: '700' },
  modalRoot: { flex: 1 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  detailCard: { width: '90%', maxHeight: '88%', borderRadius: 20, overflow: 'hidden' },
  detailHeader: { paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1 },
  detailTitle: { fontSize: 19, fontWeight: '700' },
  detailSubtitle: { fontSize: 14, marginTop: 3 },
  detailBody: { flexGrow: 0 },
  detailBodyContent: { padding: 20 },
  detailBadges: { flexDirection: 'row', gap: 16, marginBottom: 6 },
  detailRow: { marginTop: 12 },
  detailLabel: { fontSize: 12, fontWeight: '600', marginBottom: 3 },
  detailValue: { fontSize: 15 },
  statusHeading: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, marginTop: 24, marginBottom: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 18, borderWidth: 1 },
  chipText: { fontSize: 12, fontWeight: '600' },
  notImplemented: { fontSize: 12, marginTop: 20, lineHeight: 17 },
  detailFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderTopWidth: 1,
  },
  footerAction: { color: '#20B2AA', fontWeight: '700', fontSize: 14 },
  footerDestructive: { color: '#E74C3C' },
});
