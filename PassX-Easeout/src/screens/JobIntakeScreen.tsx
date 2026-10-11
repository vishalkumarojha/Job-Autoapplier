import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { useTheme } from '../context/ThemeContext';
import BackHeader from '../components/BackHeader';
import { INTAKE_MAX_RAW_CHARS, intakeJob } from '../api/intake';
import { ApiError } from '../api/errors';
import { JOB_RAW_SOURCES, JOB_RAW_SOURCE_LABELS, type JobRawSource } from '../domain/job';
import type { RootStackParamList } from '../types/navigation';
import { normalizeIntakeContent } from '../services/shareContent';

type Props = NativeStackScreenProps<RootStackParamList, 'JobIntake'>;

const ACCENT = '#20B2AA';

/**
 * Turns a thrown value into something worth showing a user.
 *
 * A cancelled request returns an empty string, which the caller treats as "stay quiet":
 * the user navigating away is not a failure they caused, and turning it into an error
 * banner on a screen that is already unmounting is noise at best.
 */
function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isBenign) return '';
    switch (error.kind) {
      case 'not_authenticated':
      case 'unauthorized':
        return 'Sign in again to use Smart Intake.';
      case 'not_found':
        return 'Smart Intake is not available on this account yet.';
      case 'timeout':
        return 'That took too long. Please try again.';
      case 'network':
        return 'Could not reach the server. Check your connection and try again.';
      case 'server':
        return 'Something went wrong while extracting. Please try again in a moment.';
      default:
        // 4xx messages come from this app's own server and describe the request the user
        // sent, so they are safe and useful to show verbatim.
        return error.message;
    }
  }
  if (error instanceof Error && error.name === 'NotAuthenticatedError') {
    return 'Sign in again to use Smart Intake.';
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}

export default function JobIntakeScreen({ navigation, route }: Props) {
  const { theme } = useTheme();

  const [rawText, setRawText] = useState(route.params?.initialText ?? '');
  const [source, setSource] = useState<JobRawSource>(route.params?.initialSource ?? 'paste');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the screen cancels an in-flight extraction rather than letting it resolve
      // into a component that no longer exists.
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!route.params?.initialText) return;
    setRawText(route.params.initialText);
    setSource(route.params.initialSource ?? 'share_android');
  }, [route.params?.initialText, route.params?.initialSource]);

  const trimmed = rawText.trim();
  const tooLong = trimmed.length > INTAKE_MAX_RAW_CHARS;
  // A too-long posting deliberately stays submittable so the press can explain *why* it
  // cannot be sent. Disabling the button instead would leave the red character count as the
  // only clue, and a dead control reads as a bug.
  const canSubmit = trimmed.length > 0 && !submitting;

  const submit = useCallback(async () => {
    if (!trimmed) {
      setError('Paste or share a job posting first.');
      return;
    }
    if (tooLong) {
      setError(
        `That posting is too long (${trimmed.length.toLocaleString('en-US')} characters). ` +
          `The maximum is ${INTAKE_MAX_RAW_CHARS.toLocaleString('en-US')}.`,
      );
      return;
    }

    setSubmitting(true);
    setError(null);
    const attempt = new AbortController();
    controller.current = attempt;
    try {
      const normalized = normalizeIntakeContent(trimmed, source);
      if (!normalized) { setError('Paste or share a job posting first.'); return; }
      const extraction = await intakeJob(normalized.rawText, normalized.rawSource, { signal: attempt.signal });
      if (!mounted.current) return;
      navigation.navigate('JobIntakeReview', {
        rawText: normalized.rawText,
        extraction,
        onSaved: route.params?.onSaved,
      });
    } catch (caught) {
      if (!mounted.current) return;
      const message = describeError(caught);
      if (message) setError(message);
      console.warn('[JobIntake] extraction failed', caught instanceof ApiError ? caught.kind : caught);
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }, [trimmed, tooLong, source, navigation, route.params?.onSaved]);

  const sourceChip = (value: JobRawSource) => {
    const active = value === source;
    return (
      <TouchableOpacity
        key={value}
        testID={`intake-source-${value}`}
        style={[styles.chip, { backgroundColor: active ? ACCENT : theme.iconBg }]}
        onPress={() => setSource(value)}
        disabled={submitting}
        accessibilityRole="button"
        accessibilityState={{ selected: active, disabled: submitting }}
        accessibilityLabel={`Source ${JOB_RAW_SOURCE_LABELS[value]}`}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Text style={[styles.chipText, { color: active ? '#FFFFFF' : theme.textMain }]}>
          {JOB_RAW_SOURCE_LABELS[value]}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top', 'bottom']}>
      <BackHeader title="Smart Intake" navigation={navigation} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[styles.intro, { color: theme.textSub }]}>
            Paste a job posting, or share one from LinkedIn, X, or your email. Nothing is
            saved until you review it on the next screen.
          </Text>

          <View style={[styles.editorCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <TextInput
              testID="intake-raw-text"
              style={[styles.editor, { color: theme.textMain }]}
              placeholder="Paste the job posting here…"
              placeholderTextColor={theme.textSub}
              value={rawText}
              onChangeText={setRawText}
              multiline
              textAlignVertical="top"
              autoCorrect={false}
              autoCapitalize="sentences"
              editable={!submitting}
              accessibilityLabel="Job posting text"
            />
            <View style={styles.editorFooter}>
              <Text
                testID="intake-char-count"
                style={[
                  styles.counter,
                  { color: tooLong ? '#E74C3C' : theme.textSub },
                ]}
              >
                {trimmed.length.toLocaleString('en-US')} / {INTAKE_MAX_RAW_CHARS.toLocaleString('en-US')}
              </Text>
            </View>
          </View>

          <Text style={[styles.label, { color: theme.textSub }]}>WHERE IT CAME FROM</Text>
          <View style={styles.chipRow}>{JOB_RAW_SOURCES.map(sourceChip)}</View>

          {error != null && error !== '' && (
            <View testID="intake-error" style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color="#922B21" />
              <Text style={styles.errorBoxText}>{error}</Text>
            </View>
          )}

          <TouchableOpacity
            testID="intake-submit"
            style={[styles.submit, { backgroundColor: ACCENT }, !canSubmit && styles.submitDisabled]}
            onPress={() => void submit()}
            disabled={!canSubmit}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Extract job details"
            accessibilityState={{ disabled: !canSubmit, busy: submitting }}
          >
            {submitting ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <>
                <Ionicons name="sparkles-outline" size={17} color="#FFFFFF" />
                <Text style={styles.submitText}>Extract Job Details</Text>
              </>
            )}
          </TouchableOpacity>

          {submitting && (
            <Text style={[styles.processing, { color: theme.textSub }]}>
              Reading the posting. This takes a few seconds.
            </Text>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  content: { padding: 20, paddingBottom: 40 },
  intro: { fontSize: 13, lineHeight: 19, marginBottom: 16 },
  editorCard: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  editor: { minHeight: 220, paddingHorizontal: 14, paddingVertical: 14, fontSize: 15, lineHeight: 21 },
  editorFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  counter: { fontSize: 11, fontWeight: '600', fontVariant: ['tabular-nums'] },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, marginTop: 22, marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 16 },
  chipText: { fontSize: 13, fontWeight: '600' },
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    paddingVertical: 15,
    marginTop: 24,
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
  processing: { fontSize: 12, textAlign: 'center', marginTop: 10 },
});
