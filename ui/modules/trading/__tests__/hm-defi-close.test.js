'use strict';

const hmDefiClose = require('../../../scripts/hm-defi-close');

describe('hm-defi-close', () => {
  test('parseCloseOptions reads retry delay', () => {
    const argv = hmDefiClose.parseCliArgs([
      '--asset', 'AVAX',
      '--retry-delay', '800',
    ]);

    expect(hmDefiClose.parseCloseOptions(argv)).toEqual({
      asset: 'AVAX',
      closePct: null,
      dryRun: false,
      help: false,
      retryDelayMs: 800,
      size: null,
    });
  });

  test('parseCloseOptions reads help flag', () => {
    const argv = hmDefiClose.parseCliArgs(['--help']);

    expect(hmDefiClose.parseCloseOptions(argv)).toEqual({
      asset: null,
      closePct: null,
      dryRun: false,
      help: true,
      retryDelayMs: 0,
      size: null,
    });
  });

  test('parseCloseOptions reads close pct and clamps it into range', () => {
    const argv = hmDefiClose.parseCliArgs([
      '--asset', 'ETH',
      '--close-pct', '150',
    ]);

    expect(hmDefiClose.parseCloseOptions(argv)).toEqual({
      asset: 'ETH',
      closePct: 100,
      dryRun: false,
      help: false,
      retryDelayMs: 0,
      size: null,
    });
  });

  test('resolveRequestedCloseSize supports size and close pct inputs', () => {
    expect(hmDefiClose.resolveRequestedCloseSize(-4.2, 1.5, null)).toBe(1.5);
    expect(hmDefiClose.resolveRequestedCloseSize(-4.2, 0, 50)).toBeCloseTo(2.1, 6);
    expect(hmDefiClose.resolveRequestedCloseSize(-4.2, 0, null)).toBeCloseTo(4.2, 6);
  });

  test('buildCloseOrderPlan formats low-priced closes without collapsing to zero', () => {
    const plan = hmDefiClose.buildCloseOrderPlan({
      size: -787,
      midPrice: 0.036164,
      szDecimals: 0,
    });

    expect(plan).toEqual(expect.objectContaining({
      isBuy: true,
      absSize: 787,
      limitPrice: '0.036526',
      sideLabel: 'BUY',
    }));
  });

  test('buildCloseOrderPlan preserves sensible sell pricing for long closes', () => {
    const plan = hmDefiClose.buildCloseOrderPlan({
      size: 4.2,
      midPrice: 9.0246,
      szDecimals: 2,
    });

    expect(plan).toEqual(expect.objectContaining({
      isBuy: false,
      absSize: 4.2,
      limitPrice: '8.9344',
      sideLabel: 'SELL',
    }));
  });
});
