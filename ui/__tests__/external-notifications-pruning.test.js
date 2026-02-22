const ORIGINAL_MAP = global.Map;

describe('external-notifications dedupe pruning', () => {
  afterEach(() => {
    global.Map = ORIGINAL_MAP;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('prunes expired dedupe entries by TTL', async () => {
    let trackedMap = null;
    class TrackingMap extends ORIGINAL_MAP {
      constructor(...args) {
        super(...args);
        trackedMap = this;
      }
    }

    global.Map = TrackingMap;
    const { createExternalNotifier } = require('../modules/external-notifications');

    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    const notifier = createExternalNotifier({
      getSettings: () => ({
        externalNotificationsEnabled: true,
        notifyOnAlerts: true,
        slackWebhookUrl: 'not-a-valid-url',
      }),
      dedupeWindowMs: 50,
      log: {
        warn: jest.fn(),
      },
    });
    global.Map = ORIGINAL_MAP;

    await notifier.notify({ category: 'alert', title: 'A', message: 'one' });
    expect(trackedMap.size).toBe(1);

    now = 100;
    await notifier.notify({ category: 'alert', title: 'B', message: 'two' });
    expect(trackedMap.size).toBe(1);

    now = 200;
    await notifier.notify({ category: 'alert', title: 'C', message: 'three' });
    expect(trackedMap.size).toBe(1);
  });
});
