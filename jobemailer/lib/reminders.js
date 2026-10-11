import { getFirestore } from 'firebase-admin/firestore';
import { firebaseApp } from './auth.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseNormalizedIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (calendarDay.getUTCFullYear() !== year || calendarDay.getUTCMonth() !== month - 1 || calendarDay.getUTCDate() !== day) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function reminderCandidates(job, now = Date.now()) {
  if (!job || job.archivedAt) return [];
  const result = [];
  const deadline = parseNormalizedIsoDate(job.deadline);
  if (deadline) {
    const date = deadline;
    if (date.getTime() > now && date.getTime() - now <= DAY_MS) {
      result.push({ type: 'deadline', date: date.toISOString().slice(0, 10), relevantDate: date.toISOString() });
    }
  }
  const hasSentApplication = Boolean(job.emailSentOn || job.gmailThreadId || Number(job.followUpCount) > 0);
  const followupDate = parseNormalizedIsoDate(job.nextReminderAt);
  if (hasSentApplication && followupDate && followupDate.getTime() <= now && !['complete', 'sent', 'disabled'].includes(String(job.followUpStatus || '').toLowerCase())) {
    result.push({ type: 'followup', date: followupDate.toISOString().slice(0, 10), relevantDate: followupDate.toISOString() });
  }
  return result.map((candidate) => ({
    ...candidate,
    key: `${job.id || ''}:${candidate.type}:${candidate.date}`,
    jobId: job.id,
    company: safeLabel(job.company),
    role: safeLabel(job.role),
  }));
}

function safeLabel(value) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : 'Unknown'; }

export function reminderText(event) {
  const label = event.type === 'deadline' ? 'Deadline reminder' : event.type === 'application_update' ? 'Application update' : event.type === 'followup_sent' ? 'Follow-up sent' : 'Follow-up reminder';
  return `${label}\n${event.company} — ${event.role}\nDate: ${event.relevantDate.slice(0, 10)}`;
}

export async function sendExpoPush(token, event, fetchImpl = fetch) {
  try {
    const title = event.type === 'deadline' ? 'Deadline reminder' : event.type === 'application_update' ? 'Application update' : event.type === 'followup_sent' ? 'Follow-up sent' : 'Follow-up due';
    const response = await fetchImpl('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ to: token, title, body: `${event.company} · ${event.role}`, data: { jobId: event.jobId, type: event.type }, sound: 'default' }) });
    if (!response.ok) throw new Error('push_provider_error');
    return true;
  } catch { throw new Error('Push delivery failed.'); }
}

export async function sendTelegramReminder(event, { botToken, chatId }, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: reminderText(event), disable_web_page_preview: true }) });
    if (!response.ok) throw new Error('telegram_provider_error');
    return true;
  } catch { throw new Error('Telegram delivery failed.'); }
}

function dbFor(deps, config) { return deps.db ?? getFirestore(firebaseApp(config)); }

/** Claims deterministic events transactionally, then sends through injected transports. */
export async function runReminderSweep({ config, now = Date.now(), db, push = sendExpoPush, telegram = sendTelegramReminder, fetchImpl = fetch }) {
  const store = dbFor({ db }, config);
  const jobs = await store.collectionGroup('jobs').get();
  let examined = 0, delivered = 0, skipped = 0;
  for (const snap of jobs.docs ?? []) {
    const data = snap.data() || {};
    const uid = snap.ref.parent.parent?.id;
    if (!uid || (data.schemaVersion ?? 0) < 1 || data.archivedAt) continue;
    examined++;
    const job = { ...data, id: snap.id };
    const stateRef = store.doc(`users/${uid}/reminderState/${snap.id}`);
    const lifecycleEvents = await store.runTransaction(async (tx) => {
      const state = await tx.get(stateRef);
      const previous = state.exists ? state.data() || {} : null;
      const status = safeLabel(job.applicationStatus);
      const stamp = typeof job.updatedAt === 'string' && Number.isFinite(Date.parse(job.updatedAt)) ? job.updatedAt : new Date(now).toISOString();
      const followUpStatus = safeLabel(job.followUpStatus).toLowerCase();
      const followUpSentAt = typeof job.followUpLastSentAt === 'string' ? job.followUpLastSentAt : null;
      tx.set(stateRef, { applicationStatus: status, followUpStatus, followUpSentAt, updatedAt: stamp });
      if (!previous) return [];
      const result = [];
      if (previous.applicationStatus !== status && previous.updatedAt !== stamp) {
        result.push({ type: 'application_update', date: stamp.slice(0, 10), relevantDate: stamp, key: `${job.id}:application_update:${status}:${stamp}`, jobId: job.id, company: safeLabel(job.company), role: safeLabel(job.role) });
      }
      const sentIdentity = followUpSentAt || stamp;
      const previousSentIdentity = previous.followUpSentAt || (['sent', 'complete'].includes(previous.followUpStatus) ? previous.updatedAt : '');
      const followUpWasSent = ['sent', 'complete'].includes(followUpStatus) && sentIdentity !== previousSentIdentity;
      if (followUpWasSent) {
        const sentAt = followUpSentAt || stamp;
        result.push({ type: 'followup_sent', date: sentAt.slice(0, 10), relevantDate: sentAt, key: `${job.id}:followup_sent:${sentAt}`, jobId: job.id, company: safeLabel(job.company), role: safeLabel(job.role) });
      }
      return result;
    });
    const dueEvents = reminderCandidates(job, now);
    dueEvents.push(...lifecycleEvents);
    for (const event of dueEvents) {
      const eventRef = store.doc(`users/${uid}/reminderEvents/${encodeURIComponent(event.key)}`);
      const claimed = await store.runTransaction(async (tx) => {
        const existing = await tx.get(eventRef);
        if (existing.exists) return false;
        tx.create(eventRef, { status: 'processing', type: event.type, jobId: event.jobId, createdAt: new Date(now).toISOString() });
        return true;
      });
      if (!claimed) { skipped++; continue; }
      try {
        const userTokens = await store.doc(`users/${uid}`).collection('pushTokens').get();
        for (const tokenDoc of userTokens.docs ?? []) await push(tokenDoc.data().token, event, fetchImpl);
        if (config.telegramBotToken && config.telegramChatId && config.telegramUserUid === uid) await telegram(event, config, fetchImpl);
        await eventRef.update({ status: 'sent', sentAt: new Date(now).toISOString() });
        delivered++;
      } catch {
        // Keep the claim to avoid duplicate external delivery if a provider timed out after accepting it.
        await eventRef.update({ status: 'delivery_uncertain' }).catch(() => {});
        skipped++;
      }
    }
  }
  return { examined, delivered, skipped };
}

export function validExpoPushToken(value) { return typeof value === 'string' && /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,}\]$/.test(value); }
export { DAY_MS };
