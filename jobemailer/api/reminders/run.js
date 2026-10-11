import { reminderConfig } from '../../lib/config.js';
import { runReminderSweep } from '../../lib/reminders.js';

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
  let config;
  try { config = reminderConfig(); } catch { return res.status(503).json({ error: 'Reminder service is not configured.' }); }
  const authorization = req.headers?.authorization ?? req.headers?.Authorization;
  if (authorization !== `Bearer ${config.cronSecret}`) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const result = await runReminderSweep({ config });
    return res.status(200).json(result);
  } catch { return res.status(500).json({ error: 'Reminder processing failed.' }); }
}
