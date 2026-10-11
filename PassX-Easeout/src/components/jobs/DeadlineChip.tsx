import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { IsoDateTime } from '../../domain/job';

const DAY_MS = 24 * 60 * 60 * 1000;

type Urgency = 'overdue' | 'soon' | 'upcoming';

function urgencyFor(deadline: IsoDateTime, now: number): Urgency {
  const remaining = new Date(deadline).getTime() - now;
  if (remaining < 0) return 'overdue';
  if (remaining <= 3 * DAY_MS) return 'soon';
  return 'upcoming';
}

/**
 * Formats the calendar date of an ISO timestamp.
 *
 * Deliberately reads the `YYYY-MM-DD` prefix instead of going through `new Date()` and
 * local-time getters: the stored value is an instant, but a deadline is a calendar day,
 * and rendering it in the device timezone would shift it by a day either side of UTC
 * midnight. Formatting the stored date keeps what the user typed as what they see.
 */
function formatDeadline(deadline: IsoDateTime): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(deadline.trim());
  if (!match) return deadline.trim();
  const [, year, month, day] = match;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIndex = Number(month) - 1;
  const monthName = months[monthIndex] ?? month;
  return `${Number(day)} ${monthName} ${year}`;
}

interface Props {
  deadline: IsoDateTime | null;
  /** Injected so rendering is deterministic under test. */
  now?: number;
}

export default function DeadlineChip({ deadline, now = Date.now() }: Props) {
  if (!deadline) {
    return (
      <View style={styles.row}>
        <Ionicons name="calendar-outline" size={13} color="#95A5A6" />
        <Text style={[styles.text, { color: '#95A5A6' }]}>No deadline</Text>
      </View>
    );
  }

  const urgency = urgencyFor(deadline, now);
  const color = urgency === 'overdue' ? '#E74C3C' : urgency === 'soon' ? '#F39C12' : '#95A5A6';
  const suffix = urgency === 'overdue' ? ' · passed' : '';

  return (
    <View style={styles.row}>
      <Ionicons
        name={urgency === 'overdue' ? 'alert-circle-outline' : 'calendar-outline'}
        size={13}
        color={color}
      />
      <Text style={[styles.text, { color }]}>{`${formatDeadline(deadline)}${suffix}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  text: { fontSize: 12, fontWeight: '600' },
});
