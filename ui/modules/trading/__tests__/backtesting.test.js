'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const backtesting = require('../backtesting');

describe('backtesting data alignment', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-backtesting-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('normalizes half-hour Yahoo timestamps onto hourly buckets', () => {
    const csvPath = path.join(tempDir, 'SPY_1h_6mo.csv');
    fs.writeFileSync(csvPath, [
      'timestamp,Open,High,Low,Close,Volume',
      '2025-09-22 13:30:00+00:00,10,11,9,10.5,100',
      '2025-09-22 14:30:00+00:00,10.5,11.5,10,11,110',
    ].join('\n'));

    const bars = backtesting.loadBarsFromCsv(csvPath, 'SPY');

    expect(bars[0].timestamp).toBe('2025-09-22T13:00:00.000Z');
    expect(bars[1].timestamp).toBe('2025-09-22T14:00:00.000Z');
  });

  test('builds a shared timeline once timestamps are bucketed', () => {
    const dataset = new Map([
      ['BTC/USD', [
        { timestamp: '2025-09-22T13:00:00.000Z', close: 1 },
        { timestamp: '2025-09-22T14:00:00.000Z', close: 2 },
      ]],
      ['SPY', [
        { timestamp: '2025-09-22T13:00:00.000Z', close: 3 },
        { timestamp: '2025-09-22T14:00:00.000Z', close: 4 },
      ]],
    ]);

    expect(backtesting.buildIntersectionTimeline(dataset)).toEqual([
      '2025-09-22T13:00:00.000Z',
      '2025-09-22T14:00:00.000Z',
    ]);
  });

  test('builds inflationary crisis macro risk from historical VIX and oil proxies', () => {
    const macroRisk = backtesting.buildDynamicMacroRisk('2026-03-18T18:00:00.000Z', new Map([
      ['^VIX', [
        { timestamp: '2026-03-18T17:00:00.000Z', close: 24 },
        { timestamp: '2026-03-18T18:00:00.000Z', close: 31 },
      ]],
      ['CL=F', [
        { timestamp: '2026-03-18T17:00:00.000Z', close: 78 },
        { timestamp: '2026-03-18T18:00:00.000Z', close: 84 },
      ]],
    ]), {
      crisisActivation: true,
    });

    expect(macroRisk.crisisType).toBe('inflationary');
    expect(macroRisk.regime).toBe('stay_cash');
    expect(macroRisk.constraints.crisisUniverse).toContain('XLE');
  });
});
