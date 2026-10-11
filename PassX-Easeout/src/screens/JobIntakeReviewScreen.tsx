import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { createFirestoreJobsRepository } from '../data/jobs/firestore';
import type { JobsRepository } from '../data/jobs/types';
import { computeDedupeKey, type Job, type JobConfidenceField } from '../domain/job';
import BackHeader from '../components/BackHeader';
import { deadlineToInput, parseDeadlineInput } from '../components/jobs/JobForm';
import { ApiError } from '../api/errors';
import type { RootStackParamList } from '../types/navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'JobIntakeReview'>;

const ACCENT = '#20B2AA';

/**
 * Below this, a field's extraction is flagged for the reviewer.
 *
 * 0.6 is a product choice, not a model guarantee: it separates "the model was sure where
 * the text was explicit" from "the model inferred this", which is exactly the boundary a
 * human reviewer needs drawn for them.
 */
const LOW_CONFIDENCE = 0.6;

/** Whitespace-only strings carry no information and are stored as null instead. */
function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function blank(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

function pct(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** Turns a thrown value into something worth showing a user. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}

function Field(props: {
  testID: string;
  label: string;
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  confidence?: number | null;
  error?: string | undefined;
  multiline?: boolean;
  keyboardType?: 'default' | 'email-address' | 'url';
  autoCapitalize?: 'none' | 'sentences';
}) {
  const { theme } = useTheme();
  const { testID, label, value, onChange, placeholder, confidence, error, multiline, keyboardType, autoCapitalize } = props;

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.textSub }]}>{label}</Text>
      <TextInput
        testID={testID}
        style={[
          styles.input,
          {
            backgroundColor: theme.inputBg,
            color: theme.textMain,
            borderColor: error ? '#E74C3C' : 'transparent',
          },
          multiline && styles.inputMultiline,
        ]}
        placeholder={placeholder}
        placeholderTextColor={theme.textSub}
        value={value}
        onChangeText={onChange}
        multiline={multiline ?? false}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        autoCorrect={false}
        editable
        accessibilityLabel={label}
      />
      {typeof confidence === 'number' && (
        <Text
          testID={`intake-confidence-${testID.replace('intake-review-', '')}`}
          style={[
            styles.confidence,
            { color: confidence < LOW_CONFIDENCE ? '#B9770E' : theme.textSub },
          ]}
        >
          {confidence < LOW_CONFIDENCE
            ? `Check this — extraction was ${pct(confidence)} confident`
            : `Extraction confidence ${pct(confidence)}`}
        </Text>
      )}
      {error != null && error !== '' && <Text style={styles.errorText}>{error}</Text>}
    </View>
  );
}

export default function JobIntakeReviewScreen({ navigation, route }: Props) {
  const { theme } = useTheme();
  const { user } = useAuth();

  const extraction = route.params?.extraction;
  const rawText = route.params?.rawText ?? '';

  // One repository per user. The screen holds the abstraction, not a Firestore handle.
  const repository: JobsRepository | null = useMemo(
    () => (user ? createFirestoreJobsRepository(user.uid) : null),
    [user],
  );

  const [company, setCompany] = useState(blank(extraction?.company));
  const [role, setRole] = useState(blank(extraction?.role));
  const [location, setLocation] = useState(blank(extraction?.location));
  const [jobUrl, setJobUrl] = useState(blank(extraction?.jobUrl));
  const [contactName, setContactName] = useState(blank(extraction?.contactName));
  const [contactEmail, setContactEmail] = useState(blank(extraction?.contactEmail));
  const [deadline, setDeadline] = useState(deadlineToInput(extraction?.deadline ?? null));
  const [notes, setNotes] = useState(blank(extraction?.notes));

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * Existing jobs, used only for the duplicate warning. `null` means "not checked yet" or
   * "could not check" — the check is advisory, so a failed read must never block a save.
   */
  const [existing, setExisting] = useState<Job[] | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!repository) return;
    repository
      .listJobs({ includeArchived: true })
      .then((jobs) => {
        if (!cancelled) setExisting(jobs);
      })
      .catch((error) => {
        console.warn('[JobIntakeReview] duplicate check skipped', error);
        if (!cancelled) setExisting([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repository]);

  const confidenceOf = useCallback(
    (field: JobConfidenceField): number | null => {
      const value = extraction?.fieldConfidence?.[field];
      return typeof value === 'number' ? value : null;
    },
    [extraction],
  );

  /**
   * Looks for the same job already on file.
   *
   * Comparing `dedupeKey` rather than raw fields means the warning uses exactly the rule
   * the repository will use to key the document, so the warning and the stored key can
   * never disagree.
   */
  const duplicate = useMemo(() => {
    if (!existing || existing.length === 0) return null;
    const key = computeDedupeKey({
      company: optional(company),
      role: optional(role),
      jobUrl: optional(jobUrl),
    });
    if (!key) return null;
    return existing.find((job) => job.dedupeKey === key) ?? null;
  }, [existing, company, role, jobUrl]);

  const validate = useCallback((): Record<string, string> | null => {
    const errors: Record<string, string> = {};

    if (!company.trim()) errors.company = 'Company is required.';
    if (!role.trim()) errors.role = 'Role is required.';

    const url = jobUrl.trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) {
      errors.jobUrl = 'Enter a full URL starting with http:// or https://.';
    }

    const email = contactEmail.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.contactEmail = 'Enter a valid email address.';
    }

    const parsed = parseDeadlineInput(deadline);
    if (!parsed.ok) errors.deadline = parsed.error;

    setFieldErrors(errors);
    return Object.keys(errors).length > 0 ? errors : null;
  }, [company, role, jobUrl, contactEmail, deadline]);

  const handleSubmit = useCallback(async () => {
    if (!repository || !extraction || saving) return;
    if (validate()) return;

    const deadlineValue = parseDeadlineInput(deadline);
    const deadlineIso = deadlineValue.ok ? deadlineValue.value : null;
    const email = optional(contactEmail);

    // Provenance follows who supplied the value: unchanged from the extraction means the
    // model found it, anything the reviewer touched is theirs, and an absent field claims
    // nothing. The two comparisons are deliberately different — the deadline is compared
    // as a stored instant, the email case-insensitively, because emails are normalized to
    // lowercase on the way out of the server but may be re-typed with capitals.
    const deadlineSource = !deadlineIso
      ? ('unknown' as const)
      : deadlineIso === extraction.deadline
        ? ('extracted' as const)
        : ('user_entered' as const);
    const contactEmailSource = !email
      ? ('unknown' as const)
      : email.toLowerCase() === extraction.contactEmail
        ? ('extracted' as const)
        : ('user_entered' as const);

    setSaving(true);
    setSaveError(null);
    try {
      await repository.createJob({
        company: optional(company),
        role: optional(role),
        location: optional(location),
        jobUrl: optional(jobUrl),
        contactName: optional(contactName),
        contactEmail: email,
        notes: optional(notes),
        deadline: deadlineIso,
        deadlineSource,
        contactEmailSource,
        // The posting is stored verbatim, and the capture channel is recorded on
        // `rawSource`. `Job.source` — where the job was advertised — is a different
        // question and is left null rather than guessed from how the text arrived.
        rawText,
        rawSource: extraction.source,
        intakeStatus: 'confirmed',
        fieldConfidence: extraction.fieldConfidence,
      });
      if (!mounted.current) return;
      route.params?.onSaved?.();
      navigation.navigate('JobPipeline');
    } catch (error) {
      console.error('[JobIntakeReview] createJob failed', error);
      if (mounted.current) setSaveError(describeError(error));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [
    repository,
    extraction,
    saving,
    validate,
    deadline,
    contactEmail,
    company,
    role,
    location,
    jobUrl,
    contactName,
    notes,
    rawText,
    route.params,
    navigation,
  ]);

  if (!extraction) {
    // Reached by a state restore or a direct route call: there is nothing to review, and
    // rendering an empty form would invite saving a job with no provenance at all.
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
        <BackHeader title="Review Extraction" navigation={navigation} />
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: theme.textMain }]}>Nothing to review</Text>
          <Text style={[styles.emptyText, { color: theme.textSub }]}>
            Go back and extract a job posting first.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!repository) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
        <BackHeader title="Review Extraction" navigation={navigation} />
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: theme.textMain }]}>Sign in to save</Text>
          <Text style={[styles.emptyText, { color: theme.textSub }]}>
            You need to be signed in to keep an extracted job.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const sourceLabel =
    extraction.source === 'share_android' ? 'Shared from another app' : `Captured as ${extraction.source}`;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <BackHeader title="Review Extraction" navigation={navigation} />

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.banner, { backgroundColor: theme.iconBg }]}>
            <Ionicons name="sparkles-outline" size={15} color={ACCENT} />
            <Text style={[styles.bannerText, { color: theme.textSub }]}>
              Extracted by AI from a posting ({sourceLabel}). Nothing is saved until you press
              save, and you can edit every field.
            </Text>
          </View>

          {duplicate && (
            <View testID="intake-duplicate" style={styles.warnBox}>
              <Ionicons name="warning-outline" size={16} color="#B9770E" />
              <Text style={styles.warnText}>
                {duplicate.archivedAt
                  ? 'You archived a job with these details. Saving will keep both.'
                  : `This looks like "${duplicate.role ?? 'Untitled role'} at ${duplicate.company ?? 'unknown company'}" already in your pipeline.`}
              </Text>
            </View>
          )}

          <Text style={[styles.sectionTitle, { color: theme.textSub }]}>REQUIRED</Text>
          <Field
            testID="intake-review-company"
            label="Company"
            value={company}
            onChange={setCompany}
            placeholder="e.g. Example Company"
            confidence={confidenceOf('company')}
            error={fieldErrors.company}
          />
          <Field
            testID="intake-review-role"
            label="Role"
            value={role}
            onChange={setRole}
            placeholder="e.g. Backend Engineer"
            confidence={confidenceOf('role')}
            error={fieldErrors.role}
          />

          <Text style={[styles.sectionTitle, { color: theme.textSub }]}>DETAILS</Text>
          <Field
            testID="intake-review-location"
            label="Location"
            value={location}
            onChange={setLocation}
            placeholder="e.g. Bangalore (optional)"
            confidence={confidenceOf('location')}
          />
          <Field
            testID="intake-review-jobUrl"
            label="Job URL"
            value={jobUrl}
            onChange={setJobUrl}
            placeholder="https:// (optional)"
            confidence={confidenceOf('jobUrl')}
            error={fieldErrors.jobUrl}
            keyboardType="url"
            autoCapitalize="none"
          />
          <Field
            testID="intake-review-deadline"
            label="Deadline"
            value={deadline}
            onChange={setDeadline}
            placeholder="YYYY-MM-DD (optional)"
            confidence={confidenceOf('deadline')}
            error={fieldErrors.deadline}
            autoCapitalize="none"
          />
          <Field
            testID="intake-review-contactName"
            label="Contact name"
            value={contactName}
            onChange={setContactName}
            placeholder="Recruiter or contact (optional)"
            confidence={confidenceOf('contactName')}
          />
          <Field
            testID="intake-review-contactEmail"
            label="Contact email"
            value={contactEmail}
            onChange={setContactEmail}
            placeholder="name@company.com (optional)"
            confidence={confidenceOf('contactEmail')}
            error={fieldErrors.contactEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <Field
            testID="intake-review-notes"
            label="Notes"
            value={notes}
            onChange={setNotes}
            placeholder="Anything worth remembering (optional)"
            multiline
          />

          <Text style={[styles.sectionTitle, { color: theme.textSub }]}>RAW POSTING</Text>
          <View style={[styles.rawCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text testID="intake-raw-text" style={[styles.rawText, { color: theme.textSub }]} selectable>
              {rawText}
            </Text>
          </View>

          {saveError != null && saveError !== '' && (
            <View testID="intake-review-error" style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color="#E74C3C" />
              <Text style={styles.errorBoxText}>{saveError}</Text>
            </View>
          )}

          <TouchableOpacity
            testID="intake-review-submit"
            style={[styles.submit, { backgroundColor: ACCENT }, saving && styles.submitDisabled]}
            onPress={() => void handleSubmit()}
            disabled={saving}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={duplicate ? 'Save job anyway' : 'Save job'}
            accessibilityState={{ disabled: saving, busy: saving }}
          >
            {saving ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.submitText}>{duplicate ? 'Save Anyway' : 'Save Job'}</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  content: { padding: 20, paddingBottom: 40 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyTitle: { fontSize: 19, fontWeight: '700', marginBottom: 8 },
  emptyText: { fontSize: 14, textAlign: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderRadius: 10,
    padding: 12,
  },
  bannerText: { fontSize: 12, lineHeight: 17, flex: 1 },
  warnBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FEF5E7',
    borderRadius: 10,
    padding: 12,
    marginTop: 14,
  },
  warnText: { color: '#7E5109', fontSize: 13, flex: 1 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginTop: 20,
    marginBottom: 8,
  },
  field: { marginBottom: 12 },
  label: { fontSize: 12, fontWeight: '600', marginBottom: 5 },
  input: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, borderWidth: 1 },
  inputMultiline: { minHeight: 84, textAlignVertical: 'top' },
  confidence: { fontSize: 11, marginTop: 5, fontWeight: '600' },
  errorText: { color: '#E74C3C', fontSize: 12, marginTop: 4 },
  rawCard: { borderRadius: 10, borderWidth: 1, padding: 14 },
  rawText: { fontSize: 13, lineHeight: 19 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FDEDEC',
    borderRadius: 10,
    padding: 12,
    marginTop: 18,
  },
  errorBoxText: { color: '#922B21', fontSize: 13, flexShrink: 1 },
  submit: {
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 24,
  },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
});
