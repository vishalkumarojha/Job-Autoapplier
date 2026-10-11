import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type {
  JobApplicationStatus,
  JobApprovalStatus,
  JobIntakeStatus,
} from '../../domain/job';

type StageKind = 'intake' | 'approval' | 'application';

type StageValue = JobIntakeStatus | JobApprovalStatus | JobApplicationStatus;

interface Props {
  kind: StageKind;
  value: StageValue;
  compact?: boolean;
}

const STAGE_LABELS: Record<StageKind, string> = {
  intake: 'Intake',
  approval: 'Review',
  // "Application", not "Applied": the stage name must not collide with the status value
  // `applied`, or a card reading "Applied / Applied" is ambiguous.
  application: 'Application',
};

type Tone = 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger';

/**
 * Tone per stage value. Tones are semantic, not decorative: a rejected application and a
 * pending review must not look alike, so the user can scan the pipeline at a glance.
 */
const TONES: Record<StageValue, Tone> = {
  // intake
  unparsed: 'neutral',
  parsed: 'info',
  needs_review: 'warning',
  confirmed: 'success',
  // approval
  draft: 'neutral',
  pending_review: 'warning',
  approved: 'success',
  rejected: 'danger',
  // application
  applied: 'info',
  interview: 'progress',
  offer: 'success',
  withdrawn: 'neutral',
  ghosted: 'danger',
};

const TONE_STYLES: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: '#95A5A6', fg: '#FFFFFF' },
  info: { bg: '#3498DB', fg: '#FFFFFF' },
  progress: { bg: '#9B59B6', fg: '#FFFFFF' },
  success: { bg: '#2ECC71', fg: '#FFFFFF' },
  warning: { bg: '#F39C12', fg: '#FFFFFF' },
  danger: { bg: '#E74C3C', fg: '#FFFFFF' },
};

function humanize(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export default function StageBadge({ kind, value, compact = false }: Props) {
  const tone = TONES[value] ?? 'neutral';
  const palette = TONE_STYLES[tone];

  return (
    <View style={styles.wrapper}>
      {!compact && (
        <Text style={[styles.stageLabel, { color: '#95A5A6' }]} numberOfLines={1}>
          {STAGE_LABELS[kind]}
        </Text>
      )}
      <View style={[styles.badge, { backgroundColor: palette.bg }, compact && styles.badgeCompact]}>
        <Text style={[styles.badgeText, { color: palette.fg }]} numberOfLines={1}>
          {humanize(value)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { alignItems: 'flex-start' },
  stageLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.6, marginBottom: 3 },
  badge: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 7 },
  badgeCompact: { paddingHorizontal: 7, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '700' },
});
