'use strict';

const scheduler = require('../scheduler');

describe('polymarket scheduler support', () => {
  test('builds a 4-hour scan cadence with 30-minute monitoring intervals', () => {
    const day = scheduler.buildPolymarketDailySchedule(new Date('2026-03-18T15:00:00.000Z'));
    const keys = day.schedule.map((event) => event.key);

    expect(day.scanIntervalHours).toBe(4);
    expect(day.monitorIntervalMinutes).toBe(30);
    expect(keys.filter((key) => key === 'polymarket_scan')).toHaveLength(6);
    expect(keys.filter((key) => key === 'polymarket_consensus')).toHaveLength(6);
    expect(keys.filter((key) => key === 'polymarket_execute')).toHaveLength(6);
    expect(keys.filter((key) => key === 'polymarket_monitor')).toHaveLength(48);
  });

  test('finds the next scheduled Polymarket wake event', async () => {
    const nextEvent = await scheduler.getNextPolymarketWakeEvent(new Date('2026-03-18T15:10:00.000Z'));

    expect(nextEvent).toMatchObject({
      key: 'polymarket_monitor',
      marketDate: '2026-03-18',
    });
  });
});
