'use strict';

const manualStopOverrides = require('../manual-stop-overrides');

describe('manual-stop-overrides', () => {
  test('blocks trailing tighten while a manual widened stop is still outside break-even', () => {
    expect(manualStopOverrides.evaluateManualStopOverrideGuard({
      ticker: 'ORDI/USD',
      stopOrderId: '393948579664',
      stopPrice: 4.35,
      entryPrice: 4.3084,
      mode: 'wick_clearance',
    }, {
      livePosition: {
        coin: 'ORDI',
        isLong: false,
        signedSize: -86.99,
        absSize: 86.99,
        entryPx: 4.3084,
      },
      activeStopOrder: {
        oid: 393948579664,
        price: 4.35,
      },
      candidateStop: 4.3352,
    })).toEqual(expect.objectContaining({
      blocked: true,
      clearOverride: false,
      reason: 'manual_stop_override_guard_active',
      override: expect.objectContaining({
        ticker: 'ORDI/USD',
        mode: 'wick_clearance',
      }),
    }));
  });

  test('releases the manual override once the replacement stop reaches break-even or better', () => {
    expect(manualStopOverrides.evaluateManualStopOverrideGuard({
      ticker: 'ORDI/USD',
      stopOrderId: '393948579664',
      stopPrice: 4.35,
      entryPrice: 4.3084,
      mode: 'wick_clearance',
    }, {
      livePosition: {
        coin: 'ORDI',
        isLong: false,
        signedSize: -86.99,
        absSize: 86.99,
        entryPx: 4.3084,
      },
      activeStopOrder: {
        oid: 393948579664,
        price: 4.35,
      },
      candidateStop: 4.3084,
    })).toEqual(expect.objectContaining({
      blocked: false,
      clearOverride: true,
      reason: 'manual_override_released_break_even_or_better',
    }));
  });
});
