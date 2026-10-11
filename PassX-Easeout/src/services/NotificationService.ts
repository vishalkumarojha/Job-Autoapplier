import notifee, { TriggerType, TimestampTrigger, AndroidImportance, AndroidCategory } from '@notifee/react-native';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScheduledNotification {
  id: string;
  title: string;
  body: string;
  triggerDate: Date;
}

export function parseNormalizedIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const datePart = value.slice(0, 10);
  const [year, month, day] = datePart.split('-').map(Number);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (calendarDay.getUTCFullYear() !== year || calendarDay.getUTCMonth() !== month - 1 || calendarDay.getUTCDate() !== day) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

// ─── Permissions ──────────────────────────────────────────────────────────────

export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const settings = await notifee.requestPermission();
    return typeof settings.authorizationStatus === 'number' && settings.authorizationStatus >= 2;
  } catch {
    return false;
  }
}

// ─── Channel (Android) ────────────────────────────────────────────────────────

async function ensureChannel(client = notifee) {
  await client.createChannel({
    id: 'easeout_reminders',
    name: 'EaseOut Reminders',
    importance: AndroidImportance.HIGH,
    vibration: true,
    sound: 'default',
  });
}

// ─── Schedule a deadline reminder ─────────────────────────────────────────────

/**
 * Schedule a notification `hoursBefore` hours before `deadlineDate`.
 * Pass a stable `notifId` (e.g., Firestore doc ID) so it can be cancelled.
 */
export async function scheduleDeadlineNotification(
  notifId: string,
  title: string,
  body: string,
  deadlineDate: Date,
  hoursBefore = 24,
  data: Record<string, string> = {},
  client = notifee,
): Promise<void> {
  try {
    await ensureChannel(client);
    const triggerDate = new Date(deadlineDate.getTime() - hoursBefore * 60 * 60 * 1000);
    if (triggerDate.getTime() <= Date.now()) return; // already past

    const trigger: TimestampTrigger = {
      type: TriggerType.TIMESTAMP,
      timestamp: triggerDate.getTime(),
    };

    await client.createTriggerNotification(
      {
        id: notifId,
        title,
        body,
        data,
        android: {
          channelId: 'easeout_reminders',
          importance: AndroidImportance.HIGH,
          category: AndroidCategory.REMINDER,
          smallIcon: 'ic_launcher',
          pressAction: { id: 'default' },
        },
      },
      trigger,
    );
  } catch (e) {
    console.warn('[NotificationService] scheduleDeadlineNotification error:', e);
  }
}

// ─── Send an immediate notification ───────────────────────────────────────────

export async function sendImmediateNotification(
  title: string,
  body: string,
): Promise<void> {
  try {
    await ensureChannel();
    await notifee.displayNotification({
      title,
      body,
      android: {
        channelId: 'easeout_reminders',
        importance: AndroidImportance.DEFAULT,
        smallIcon: 'ic_launcher',
        pressAction: { id: 'default' },
      },
    });
  } catch (e) {
    console.warn('[NotificationService] sendImmediateNotification error:', e);
  }
}

// ─── Cancel a notification ────────────────────────────────────────────────────

export async function cancelNotification(notifId: string, client = notifee): Promise<void> {
  try {
    await client.cancelNotification(notifId);
  } catch {
    // silently ignore
  }
}

/** Stable device-local deadline reminder keyed by the canonical Job id. */
export async function syncJobDeadlineNotification(job: {
  id: string; company: string | null; role: string | null; deadline: string | null; archivedAt: string | null;
}, client = notifee): Promise<void> {
  const id = `job-deadline-${job.id}`;
  await cancelNotification(id, client);
  if (job.archivedAt || !job.deadline) return;
  const deadline = parseNormalizedIsoDate(job.deadline);
  if (!deadline || deadline.getTime() <= Date.now()) return;
  const triggerAt = deadline.getTime() - 24 * 60 * 60 * 1000;
  if (triggerAt <= Date.now()) return;
  const label = `${job.company || 'Company'} · ${job.role || 'Role'}`;
  await scheduleDeadlineNotification(id, 'Deadline approaching', `${label} · ${deadline.toLocaleDateString()}`, deadline, 24, { jobId: job.id, type: 'deadline' }, client);
}

export async function cancelJobNotifications(jobId: string, client = notifee): Promise<void> {
  await cancelNotification(`job-deadline-${jobId}`, client);
  await cancelNotification(`job-followup-${jobId}`, client);
}

export async function syncJobFollowupNotification(job: {
  id: string; company: string | null; role: string | null; nextReminderAt: string | null;
  followUpStatus: string; archivedAt: string | null;
}, client = notifee): Promise<void> {
  const id = `job-followup-${job.id}`;
  await cancelNotification(id, client);
  if (job.archivedAt || !job.nextReminderAt || ['complete', 'sent', 'disabled'].includes(job.followUpStatus.toLowerCase())) return;
  const date = parseNormalizedIsoDate(job.nextReminderAt);
  if (!date || date.getTime() <= Date.now()) return;
  try {
    await ensureChannel(client);
    await client.createTriggerNotification({
      id, title: 'Follow-up due', body: `${job.company || 'Company'} · ${job.role || 'Role'}`,
      data: { jobId: job.id, type: 'followup' },
      android: { channelId: 'easeout_reminders', importance: AndroidImportance.HIGH, category: AndroidCategory.REMINDER, smallIcon: 'ic_launcher', pressAction: { id: 'default' } },
    }, { type: TriggerType.TIMESTAMP, timestamp: date.getTime() });
  } catch (error) { console.warn('[NotificationService] follow-up notification could not be scheduled'); }
}

// ─── Helper: parse a simple deadline string to a Date ─────────────────────────

export function parseDeadlineToDate(deadlineStr: string): Date | null {
  if (!deadlineStr) return null;
  const lower = deadlineStr.toLowerCase().trim();
  const now = new Date();

  if (lower === 'today') {
    const d = new Date(now); d.setHours(20, 0, 0, 0); return d;
  }
  if (lower === 'tomorrow') {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d;
  }

  // Try natural date parse
  const parsed = new Date(deadlineStr);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}
