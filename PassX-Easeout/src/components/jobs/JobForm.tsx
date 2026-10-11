import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import type { IsoDateTime, Job } from '../../domain/job';

/** Canonical fields this form owns. Empty optional strings are normalized to null. */
export interface JobFormValues {
  company: string | null;
  role: string | null;
  location: string | null;
  jobUrl: string | null;
  contactName: string | null;
  contactEmail: string | null;
  source: string | null;
  deadline: IsoDateTime | null;
  notes: string | null;
  rawText: string | null;
}

type ParseResult = { ok: true; value: IsoDateTime | null } | { ok: false; error: string };

/**
 * Converts a `YYYY-MM-DD` entry into an ISO-8601 instant at UTC midnight.
 *
 * The round-trip check matters: `new Date(Date.UTC(2026, 1, 31))` silently becomes
 * 3 March, so without it a typo like `2026-02-31` would be stored as a real but wrong
 * deadline.
 */
export function parseDeadlineInput(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return { ok: false, error: 'Use the format YYYY-MM-DD.' };

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, error: 'That date does not exist.' };
  }

  return { ok: true, value: date.toISOString() };
}

/**
 * Reads the stored ISO timestamp back into `YYYY-MM-DD` for display in the input.
 *
 * Exported because the Smart Intake review screen renders the same field and must display
 * an extracted deadline the same way the manual form does; two different renderings of one
 * stored value would be a needless source of drift.
 */
export function deadlineToInput(deadline: IsoDateTime | null): string {
  if (!deadline) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(deadline.trim());
  return match ? match[1] : '';
}

function blank(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** Whitespace-only strings carry no information and are stored as null instead. */
function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

interface Props {
  mode: 'create' | 'edit';
  initial?: Job | null;
  submitting: boolean;
  /** Repository error from a previous attempt, shown inline so it is not swallowed. */
  serverError?: string | null;
  onSubmit: (values: JobFormValues) => void;
  onCancel: () => void;
}

export default function JobForm({ mode, initial, submitting, serverError, onSubmit, onCancel }: Props) {
  const { theme } = useTheme();

  const [company, setCompany] = useState(blank(initial?.company));
  const [role, setRole] = useState(blank(initial?.role));
  const [location, setLocation] = useState(blank(initial?.location));
  const [jobUrl, setJobUrl] = useState(blank(initial?.jobUrl));
  const [contactName, setContactName] = useState(blank(initial?.contactName));
  const [contactEmail, setContactEmail] = useState(blank(initial?.contactEmail));
  const [source, setSource] = useState(blank(initial?.source));
  const [deadline, setDeadline] = useState(deadlineToInput(initial?.deadline ?? null));
  const [notes, setNotes] = useState(blank(initial?.notes));
  const [rawText, setRawText] = useState(blank(initial?.rawText));

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const validate = (): JobFormValues | null => {
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

    const parsedDeadline = parseDeadlineInput(deadline);
    if (!parsedDeadline.ok) errors.deadline = parsedDeadline.error;

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return null;

    return {
      company: optional(company),
      role: optional(role),
      location: optional(location),
      jobUrl: optional(jobUrl),
      contactName: optional(contactName),
      contactEmail: optional(contactEmail),
      source: optional(source),
      deadline: parsedDeadline.ok ? parsedDeadline.value : null,
      notes: optional(notes),
      rawText: optional(rawText),
    };
  };

  const handleSubmit = () => {
    const values = validate();
    if (values) onSubmit(values);
  };

  const input = (
    label: string,
    value: string,
    onChange: (text: string) => void,
    placeholder: string,
    keyName?: string,
    options?: { multiline?: boolean; keyboardType?: 'default' | 'email-address' | 'url'; autoCapitalize?: 'none' | 'sentences' },
  ) => (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.textSub }]}>{label}</Text>
      <TextInput
        style={[
          styles.input,
          { backgroundColor: theme.inputBg, color: theme.textMain, borderColor: fieldErrors[keyName ?? ''] ? '#E74C3C' : 'transparent' },
          options?.multiline && styles.inputMultiline,
        ]}
        placeholder={placeholder}
        placeholderTextColor={theme.textSub}
        value={value}
        onChangeText={onChange}
        multiline={options?.multiline ?? false}
        keyboardType={options?.keyboardType ?? 'default'}
        autoCapitalize={options?.autoCapitalize ?? 'sentences'}
        autoCorrect={false}
      />
      {keyName && fieldErrors[keyName] && (
        <Text style={styles.errorText}>{fieldErrors[keyName]}</Text>
      )}
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.card }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.textMain }]}>
          {mode === 'create' ? 'Add Job' : 'Edit Job'}
        </Text>
        <TouchableOpacity onPress={onCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={[styles.cancelLink, { color: theme.textSub }]}>Close</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.sectionTitle, { color: theme.textSub }]}>REQUIRED</Text>
        {input('Company', company, setCompany, 'e.g. Example Company', 'company')}
        {input('Role', role, setRole, 'e.g. Backend Engineer Intern', 'role')}

        <Text style={[styles.sectionTitle, { color: theme.textSub }]}>DETAILS</Text>
        {input('Location', location, setLocation, 'e.g. Bangalore (optional)')}
        {input(
          'Job URL',
          jobUrl,
          setJobUrl,
          'https:// (optional)',
          'jobUrl',
          { keyboardType: 'url', autoCapitalize: 'none' },
        )}
        {input('Source', source, setSource, 'e.g. linkedin, referral (optional)')}
        {input(
          'Deadline',
          deadline,
          setDeadline,
          'YYYY-MM-DD (optional)',
          'deadline',
          { autoCapitalize: 'none' },
        )}
        {input(
          'Contact name',
          contactName,
          setContactName,
          'Recruiter or contact (optional)',
        )}
        {input(
          'Contact email',
          contactEmail,
          setContactEmail,
          'name@company.com (optional)',
          'contactEmail',
          { keyboardType: 'email-address', autoCapitalize: 'none' },
        )}
        {input('Notes', notes, setNotes, 'Anything worth remembering (optional)', undefined, { multiline: true })}

        <Text style={[styles.sectionTitle, { color: theme.textSub }]}>RAW CAPTURE</Text>
        {input('Job description text', rawText, setRawText, 'Optional. Parsing arrives in a later phase.', undefined, { multiline: true })}

        {serverError != null && serverError !== '' && (
          <View style={styles.serverError}>
            <Ionicons name="alert-circle-outline" size={16} color="#E74C3C" />
            <Text style={styles.serverErrorText}>{serverError}</Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.submit, submitting && styles.submitDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
          activeOpacity={0.85}
        >
          {submitting ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Text style={styles.submitText}>{mode === 'create' ? 'Create Job' : 'Save Changes'}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  title: { fontSize: 19, fontWeight: '700' },
  cancelLink: { fontSize: 14, fontWeight: '600' },
  scroll: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 40 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginTop: 18,
    marginBottom: 8,
  },
  field: { marginBottom: 12 },
  label: { fontSize: 12, fontWeight: '600', marginBottom: 5 },
  input: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, borderWidth: 1 },
  inputMultiline: { minHeight: 84, textAlignVertical: 'top' },
  errorText: { color: '#E74C3C', fontSize: 12, marginTop: 4 },
  serverError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FDEDEC',
    borderRadius: 10,
    padding: 12,
    marginTop: 16,
  },
  serverErrorText: { color: '#922B21', fontSize: 13, flexShrink: 1 },
  submit: {
    backgroundColor: '#20B2AA',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 24,
  },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
});
