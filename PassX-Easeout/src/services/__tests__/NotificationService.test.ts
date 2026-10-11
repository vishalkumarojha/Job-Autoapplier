import { parseNormalizedIsoDate, syncJobDeadlineNotification, cancelJobNotifications } from '../NotificationService';

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    requestPermission: jest.fn(async () => ({ authorizationStatus: 2 })),
    createChannel: jest.fn(async () => 'easeout_reminders'),
    createTriggerNotification: jest.fn(async () => 'n1'),
    cancelNotification: jest.fn(async () => undefined),
    displayNotification: jest.fn(async () => undefined),
  },
  TriggerType: { TIMESTAMP: 0 },
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
  AndroidCategory: { REMINDER: 'reminder' },
}));

function fakeNotifee() {
  return {
    requestPermission: jest.fn(async () => ({})),
    createChannel: jest.fn(async () => 'easeout_reminders'),
    createTriggerNotification: jest.fn(async () => 'n1'),
    cancelNotification: jest.fn(async () => undefined),
    displayNotification: jest.fn(async () => undefined),
  };
}

describe('job deadline notification synchronization', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-06T09:00:00.000Z')));
  afterEach(() => jest.useRealTimers());

  it('schedules one stable reminder before a future deadline and cancels an earlier one first', async () => {
    const client = fakeNotifee();
    await syncJobDeadlineNotification({ id: 'job-1', company: 'Acme', role: 'Engineer', deadline: '2026-10-08T09:00:00.000Z', archivedAt: null }, client as any);
    expect(client.cancelNotification).toHaveBeenCalledWith('job-deadline-job-1');
    expect(client.createTriggerNotification).toHaveBeenCalledTimes(1);
    const [notification, trigger] = client.createTriggerNotification.mock.calls[0] as any[];
    expect(notification.id).toBe('job-deadline-job-1');
    expect(notification.body).toContain('Acme · Engineer');
    expect(notification.data).toEqual({ jobId: 'job-1', type: 'deadline' });
    expect(trigger.timestamp).toBe(Date.parse('2026-10-07T09:00:00.000Z'));
  });

  it.each([
    ['null deadline', null, null],
    ['malformed deadline', 'tomorrow', null],
    ['archived job', '2026-10-08T09:00:00.000Z', '2026-10-06T08:00:00.000Z'],
  ])('cancels and does not schedule for %s', async (_label, deadline, archivedAt) => {
    const client = fakeNotifee();
    await syncJobDeadlineNotification({ id: 'job-1', company: 'Acme', role: 'Engineer', deadline, archivedAt } as any, client as any);
    expect(client.cancelNotification).toHaveBeenCalledWith('job-deadline-job-1');
    expect(client.createTriggerNotification).not.toHaveBeenCalled();
  });

  it('cancels both stable reminder ids when a Job is archived', async () => {
    const client = fakeNotifee();
    await cancelJobNotifications('job-2', client as any);
    expect(client.cancelNotification).toHaveBeenNthCalledWith(1, 'job-deadline-job-2');
    expect(client.cancelNotification).toHaveBeenNthCalledWith(2, 'job-followup-job-2');
  });

  it('rejects invalid calendar dates even when JavaScript would roll them forward', () => {
    expect(parseNormalizedIsoDate('2026-02-31T09:00:00.000Z')).toBeNull();
    expect(parseNormalizedIsoDate('2026-10-10T09:00:00.000Z')).toBeInstanceOf(Date);
  });
});
