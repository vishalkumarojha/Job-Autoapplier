import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { listResumes } from '../api/resumes';
import { ApiError } from '../api/errors';
import type { ResumeSummary } from '../domain/resume';
import type { RootStackParamList } from '../types/navigation';
import BackHeader from '../components/BackHeader';

type Props = NativeStackScreenProps<RootStackParamList, 'ResumeLibrary'>;

const ACCENT = '#20B2AA';

/** Formats an ISO timestamp as `5 Oct 2026`, or returns a dash when unset. */
function formatDate(iso: string | null): string {
  if (iso == null || iso.trim() === '') return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!match) return iso.trim();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = months[Number(match[2]) - 1] ?? match[2];
  return `${Number(match[3])} ${monthName} ${match[1]}`;
}

/** Turns a thrown value into something worth showing a person. */
function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    // A cancelled request is an expected outcome (the user left the screen), so it is not
    // worth an error banner.
    if (error.isBenign) return '';
    switch (error.kind) {
      case 'not_authenticated':
        return 'Sign in to see your resumes.';
      case 'unauthorized':
        return 'Your session expired. Sign in again to load resumes.';
      case 'not_found':
        return 'The resume service is not available yet. It needs to be configured on the server.';
      case 'timeout':
        return 'The server took too long to respond. Pull down to retry.';
      case 'network':
        return 'Could not reach the server. Check your connection and try again.';
      case 'malformed_response':
        return 'The server sent something unexpected. This is a bug worth reporting.';
      default:
        return error.message;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Pull down to retry.';
}

/** Renders `software_engineering` as `Software engineering`. */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function ResumeRow({
  resume,
  picking,
  isSelected,
  onPress,
}: {
  resume: ResumeSummary;
  picking: boolean;
  isSelected: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();

  return (
    <TouchableOpacity
      style={[
        styles.card,
        {
          backgroundColor: theme.card,
          borderColor: isSelected ? ACCENT : 'transparent',
          borderWidth: isSelected ? 2 : 0,
        },
      ]}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      testID={`resume-row-${resume.resumeId}`}
    >
      <View style={styles.titleRow}>
        <Text style={[styles.label, { color: theme.textMain }]} numberOfLines={2}>
          {resume.resumeLabel}
        </Text>
        {resume.isDefault && (
          <View style={[styles.defaultPill, { backgroundColor: theme.iconBg }]}>
            <Ionicons name="star" size={10} color={ACCENT} />
            <Text style={styles.defaultText}>Default</Text>
          </View>
        )}
        {picking && isSelected && (
          <Ionicons name="checkmark-circle" size={20} color={ACCENT} style={styles.check} />
        )}
      </View>

      <Text style={[styles.subtitle, { color: theme.textSub }]} numberOfLines={1}>
        {[
          resume.targetRole ?? null,
          resume.targetRoleFamily != null && resume.targetRoleFamily !== ''
            ? humanize(resume.targetRoleFamily)
            : null,
        ]
          .filter((part): part is string => part != null && part !== '')
          .join(' · ') || 'No target role set'}
      </Text>

      <View style={styles.metaRow}>
        <View style={[styles.versionPill, { backgroundColor: theme.inputBg }]}>
          <Text style={[styles.versionText, { color: theme.textSub }]}>v{resume.version}</Text>
        </View>
        <Ionicons name="sync-outline" size={12} color={theme.textSub} />
        <Text style={[styles.meta, { color: theme.textSub }]}>Updated {formatDate(resume.updatedAt)}</Text>
        {resume.lastUsedAt != null && (
          <>
            <Ionicons name="paper-plane-outline" size={12} color={theme.textSub} />
            <Text style={[styles.meta, { color: theme.textSub }]}>Last used {formatDate(resume.lastUsedAt)}</Text>
          </>
        )}
      </View>

      {resume.keywords.length > 0 && (
        <View style={styles.keywordRow}>
          {resume.keywords.slice(0, 6).map((keyword) => (
            <View key={keyword} style={[styles.keyword, { backgroundColor: theme.iconBg }]}>
              <Text style={[styles.keywordText, { color: theme.textSub }]}>{keyword}</Text>
            </View>
          ))}
          {resume.keywords.length > 6 && (
            <Text style={[styles.keywordOverflow, { color: theme.textSub }]}>
              +{resume.keywords.length - 6}
            </Text>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

export default function ResumeLibraryScreen({ navigation, route }: Props) {
  const { theme } = useTheme();

  // Both parameters are optional, so one screen serves as a standalone list and as a picker.
  // Passing a jobId is what turns it into a picker: selection is only reported back when a
  // job is being edited.
  const jobId = route.params?.jobId;
  const initialSelected = route.params?.selectedResumeId ?? null;
  const onSelect = route.params?.onSelect;
  const picking = jobId != null;

  const [resumes, setResumes] = useState<ResumeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelected);

  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (mode: 'initial' | 'refresh') => {
    if (mode === 'initial') setLoading(true);
    setError(null);
    try {
      const list = await listResumes();
      if (!mounted.current) return;
      setResumes(list);
    } catch (caught) {
      console.error('[ResumeLibrary] listResumes failed', caught);
      if (!mounted.current) return;
      const message = describeError(caught);
      // A benign failure (cancelled) leaves the previous state alone.
      if (message) setError(message);
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load('initial');
  }, [load]);

  const handlePress = useCallback(
    (resume: ResumeSummary) => {
      if (!picking) return; // Standalone mode is read-only in this phase.
      setSelectedId(resume.resumeId);
      onSelect?.({ resumeId: resume.resumeId, label: resume.resumeLabel });
      navigation.goBack();
    },
    [picking, onSelect, navigation],
  );

  // Standalone mode sorts the default first so the most likely resume is visible without
  // scrolling. Picker mode keeps server order so the list matches the cache.
  const ordered = useMemo(() => {
    if (picking) return resumes;
    const withDefault = resumes.filter((resume) => resume.isDefault);
    const rest = resumes.filter((resume) => !resume.isDefault);
    return [...withDefault, ...rest];
  }, [resumes, picking]);

  const renderBody = () => {
    if (loading) {
      return (
        <View style={styles.centered} testID="resume-loading">
          <ActivityIndicator size="large" color={ACCENT} />
          <Text style={[styles.centeredText, { color: theme.textSub }]}>Loading your resumes…</Text>
        </View>
      );
    }

    if (error != null && resumes.length === 0) {
      return (
        <View style={styles.centered} testID="resume-error">
          <Ionicons name="alert-circle-outline" size={44} color="#E74C3C" />
          <Text style={[styles.errorTitle, { color: theme.textMain }]}>Could not load resumes</Text>
          <Text style={[styles.centeredText, { color: theme.textSub }]}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => void load('initial')}>
            <Ionicons name="refresh" size={16} color="#FFFFFF" />
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <FlatList
        data={ordered}
        keyExtractor={(item) => item.resumeId}
        contentContainerStyle={styles.listContent}
        testID="resume-list"
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
          picking ? (
            <View style={[styles.pickerNotice, { backgroundColor: theme.iconBg }]}>
              <Ionicons name="information-circle-outline" size={16} color={theme.textSub} />
              <Text style={[styles.pickerNoticeText, { color: theme.textSub }]}>
                Pick a resume to attach to this job. Choosing one only records which resume you
                picked — nothing is sent and no scoring happens yet.
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          error != null ? null : (
            <View style={styles.emptyState} testID="resume-empty">
              <Ionicons name="documents-outline" size={52} color={theme.border} />
              <Text style={[styles.emptyTitle, { color: theme.textMain }]}>No resumes in the library</Text>
              <Text style={[styles.emptyText, { color: theme.textSub }]}>
                Resumes are read from a Google Drive folder and cached on the server. Run the
                server sync to populate the library, then pull down to refresh.
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <ResumeRow
            resume={item}
            picking={picking}
            isSelected={item.resumeId === selectedId}
            onPress={() => handlePress(item)}
          />
        )}
      />
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <BackHeader title="Resume Library" navigation={navigation} />
      {renderBody()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 10 },
  centeredText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  errorTitle: { fontSize: 17, fontWeight: '700', marginTop: 4 },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ACCENT,
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 12,
    marginTop: 12,
  },
  retryText: { color: '#FFFFFF', fontWeight: '700' },
  listContent: { padding: 20, paddingBottom: 40, flexGrow: 1 },
  pickerNotice: { flexDirection: 'row', gap: 8, padding: 12, borderRadius: 10, marginBottom: 16 },
  pickerNoticeText: { fontSize: 12, lineHeight: 17, flexShrink: 1 },
  card: { borderRadius: 14, padding: 16, marginBottom: 14, elevation: 2, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { fontSize: 16, fontWeight: '700', flex: 1 },
  defaultPill: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  defaultText: { fontSize: 10, fontWeight: '700', color: ACCENT },
  check: { marginLeft: 2 },
  subtitle: { fontSize: 13, marginTop: 4 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 9, flexWrap: 'wrap' },
  versionPill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 7 },
  versionText: { fontSize: 11, fontWeight: '700' },
  meta: { fontSize: 11 },
  keywordRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10, alignItems: 'center' },
  keyword: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  keywordText: { fontSize: 11, fontWeight: '600' },
  keywordOverflow: { fontSize: 11, fontWeight: '600' },
  emptyState: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginTop: 16 },
  emptyText: { fontSize: 14, marginTop: 8, textAlign: 'center', lineHeight: 20 },
});
