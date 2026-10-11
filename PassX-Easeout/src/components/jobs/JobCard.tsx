import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import type { Job } from '../../domain/job';
import StageBadge from './StageBadge';
import DeadlineChip from './DeadlineChip';

function formatUpdated(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!match) return iso.trim();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = months[Number(match[2]) - 1] ?? match[2];
  return `${Number(match[3])} ${monthName} ${match[1]}`;
}

interface Props {
  job: Job;
  onPress: () => void;
  onEdit: () => void;
  onArchive: () => void;
}

export default function JobCard({ job, onPress, onEdit, onArchive }: Props) {
  const { theme } = useTheme();

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: theme.card }]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <View style={styles.topRow}>
        <View style={styles.headings}>
          <Text style={[styles.role, { color: theme.textMain }]} numberOfLines={1}>
            {job.role ?? 'Untitled role'}
          </Text>
          <Text style={[styles.company, { color: theme.textSub }]} numberOfLines={1}>
            {job.company ?? 'Company not set'}
          </Text>
        </View>
        <StageBadge kind="intake" value={job.intakeStatus} />
      </View>

      {job.location != null && job.location !== '' && (
        <View style={styles.metaRow}>
          <Ionicons name="location-outline" size={13} color={theme.textSub} />
          <Text style={[styles.meta, { color: theme.textSub }]} numberOfLines={1}>
            {job.location}
          </Text>
        </View>
      )}

      {job.jobUrl != null && job.jobUrl !== '' && (
        <View style={styles.metaRow}>
          <Ionicons name="link-outline" size={13} color={theme.textSub} />
          <Text style={[styles.meta, { color: theme.textSub }]} numberOfLines={1}>
            {job.jobUrl}
          </Text>
        </View>
      )}

      {job.source != null && job.source !== '' && (
        <View style={styles.metaRow}>
          <Ionicons name="pricetag-outline" size={13} color={theme.textSub} />
          <Text style={[styles.meta, { color: theme.textSub }]} numberOfLines={1}>
            Source: {job.source}
          </Text>
        </View>
      )}

      {/* `draft` is the default for a job nobody has applied to yet, so it carries no
          information on a card. Approval stays visible because it is the human gate. */}
      {job.applicationStatus !== 'draft' && (
        <View style={styles.badgeRow}>
          <StageBadge kind="application" value={job.applicationStatus} compact />
        </View>
      )}

      {job.matchScore != null && (
        <View style={styles.badgeRow}>
          <View style={[styles.pill, { backgroundColor: theme.iconBg }]}>
            <Text style={[styles.pillText, { color: theme.textMain }]}>Match {job.matchScore}</Text>
          </View>
        </View>
      )}

      {job.selectedResumeId != null && job.selectedResumeId !== '' && (
        <View style={styles.badgeRow}>
          <View style={[styles.pill, { backgroundColor: theme.iconBg }]}>
            <Ionicons name="document-text-outline" size={11} color={theme.textSub} />
            <Text style={[styles.pillText, styles.pillWithIcon, { color: theme.textSub }]} numberOfLines={1}>
              {job.selectedResumeId}
            </Text>
          </View>
        </View>
      )}

      <View style={[styles.footer, { borderTopColor: theme.border }]}>
        <DeadlineChip deadline={job.deadline} />
        <View style={styles.footerRight}>
          <Text style={[styles.updated, { color: theme.textSub }]} numberOfLines={1}>
            Updated {formatUpdated(job.updatedAt)}
          </Text>
          <TouchableOpacity onPress={onEdit} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="create-outline" size={17} color={theme.textSub} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onArchive} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="archive-outline" size={17} color={theme.textSub} />
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
  },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 },
  headings: { flex: 1 },
  role: { fontSize: 17, fontWeight: '700' },
  company: { fontSize: 14, marginTop: 3 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 7 },
  meta: { fontSize: 12, flexShrink: 1 },
  badgeRow: { flexDirection: 'row', marginTop: 9, gap: 8 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 7,
    maxWidth: '100%',
  },
  pillText: { fontSize: 11, fontWeight: '600' },
  pillWithIcon: { fontWeight: '500', flexShrink: 1 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 13,
    paddingTop: 11,
    borderTopWidth: 1,
    gap: 8,
  },
  footerRight: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  updated: { fontSize: 11 },
});
