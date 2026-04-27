'use strict';

const {
  evaluateTooLateShortRule,
  DEFAULT_THRESHOLDS,
} = require('../oracle-watch-too-late-filter');

const BASE_RULE = {
  trigger: 'lose_fail_retest',
  loseLevel: 0.17362,
  retestMin: 0.17362,
  retestMax: 0.17459,
  ticker: 'MEGA/USD',
};

function minutesAgo(nowMs, minutes) {
  return nowMs - (minutes * 60_000);
}

function buildBars1m(nowMs, rows) {
  return rows.map((row, i) => ({
    time: minutesAgo(nowMs, rows.length - i - 1),
    open: row.open ?? row.close,
    high: row.high ?? row.close,
    low: row.low ?? row.close,
    close: row.close,
    volume: row.volume ?? 1000,
  }));
}

function buildBars5m(rows) {
  return rows.map((row, i) => ({
    open: row.open ?? row.close,
    high: row.high ?? row.close,
    low: row.low ?? row.close,
    close: row.close,
    volume: row.volume ?? 1000,
  }));
}

describe('oracle-watch-too-late-filter', () => {
  const NOW = Date.parse('2026-04-23T17:35:00.000Z');

  describe('evaluateTooLateShortRule', () => {
    test('passes through non-lose_fail_retest rules unchanged', () => {
      const result = evaluateTooLateShortRule({
        rule: { trigger: 'reclaim_hold' },
      });
      expect(result.decision).toBe('fire');
      expect(result.skipped).toBe('not_lose_fail_retest');
    });

    test('fires when no features flagged and BTC not trending up', () => {
      const bars1m = buildBars1m(NOW, [
        { close: 0.174, high: 0.174, low: 0.173 },
        { close: 0.172, high: 0.173, low: 0.172 }, // break below 0.17362
        { close: 0.170, high: 0.172, low: 0.170 }, // new lower low
        { close: 0.169, high: 0.170, low: 0.169 },
      ]);
      const bars5m = buildBars5m([
        { close: 0.180, high: 0.182, low: 0.178, open: 0.180, volume: 5000 }, // dumpHigh
        { close: 0.170, high: 0.178, low: 0.168, open: 0.180, volume: 8000 },
        { close: 0.169, high: 0.171, low: 0.168, open: 0.170, volume: 7000 }, // dumpLow 0.168
        { close: 0.169, high: 0.170, low: 0.168, open: 0.169, volume: 6000 },
        { close: 0.169, high: 0.170, low: 0.169, open: 0.169, volume: 5500 }, // close near low -> lower-half, no flip
        { close: 0.169, high: 0.170, low: 0.169, open: 0.169, volume: 5000 },
      ]);
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m,
          bars5m,
          market: { price: 0.169, fundingRate: 0.00001, openInterestChange1hPct: 0.02 },
        },
        btcContext: { bar5m: { open: 78000, close: 77900 } },
        nowMs: NOW,
      });
      expect(result.decision).toBe('fire');
      expect(result.reasons).toEqual([]);
    });

    test('flags crowded short when funding <=-0.00015 and oi1h <=0', () => {
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m: [],
          bars5m: [],
          market: { price: 0.170, fundingRate: -0.0002, openInterestChange1hPct: -0.01 },
        },
        nowMs: NOW,
      });
      expect(result.reasons).toContain('crowded_short');
      expect(result.decision).toBe('soft_block');
    });

    test('falls back to 24h OI when 1h OI unavailable', () => {
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m: [],
          bars5m: [],
          market: { price: 0.170, fundingRate: -0.0002, openInterestChange24hPct: -0.05 },
        },
        nowMs: NOW,
      });
      expect(result.features.crowded.flagged).toBe(true);
      expect(result.features.crowded.detail.source).toBe('24h_fallback');
    });

    test('does not flag crowded when funding is positive', () => {
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m: [],
          bars5m: [],
          market: { price: 0.170, fundingRate: 0.00005, openInterestChange1hPct: -0.5 },
        },
        nowMs: NOW,
      });
      expect(result.features.crowded.flagged).toBe(false);
    });

    test('flags stale breakdown after >30min with no new low', () => {
      const bars1m = [
        { time: minutesAgo(NOW, 40), close: 0.174, high: 0.174, low: 0.174 },
        { time: minutesAgo(NOW, 38), close: 0.170, high: 0.173, low: 0.168 }, // break + initial low
        { time: minutesAgo(NOW, 30), close: 0.169, high: 0.171, low: 0.169 },
        { time: minutesAgo(NOW, 20), close: 0.170, high: 0.172, low: 0.169 },
        { time: minutesAgo(NOW, 5), close: 0.172, high: 0.173, low: 0.170 },
      ];
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m,
          bars5m: [],
          market: { price: 0.172, fundingRate: 0, openInterestChange1hPct: 0 },
        },
        nowMs: NOW,
      });
      expect(result.features.staleBreakdown.flagged).toBe(true);
      expect(result.features.staleBreakdown.detail.minutesSinceBreak).toBeGreaterThanOrEqual(30);
    });

    test('does not flag stale breakdown when a new lower low prints', () => {
      const bars1m = [
        { time: minutesAgo(NOW, 40), close: 0.174, high: 0.174, low: 0.174 },
        { time: minutesAgo(NOW, 38), close: 0.170, high: 0.173, low: 0.168 },
        { time: minutesAgo(NOW, 20), close: 0.165, high: 0.170, low: 0.164 }, // lower low
        { time: minutesAgo(NOW, 5), close: 0.166, high: 0.168, low: 0.165 },
      ];
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m,
          bars5m: [],
          market: { price: 0.166, fundingRate: 0, openInterestChange1hPct: 0 },
        },
        nowMs: NOW,
      });
      expect(result.features.staleBreakdown.flagged).toBe(false);
    });

    test('flags depth-from-low when retrace >35%', () => {
      const bars5m = buildBars5m([
        { high: 0.200, low: 0.195, close: 0.196, open: 0.200, volume: 1000 }, // dumpHigh 0.200
        { high: 0.196, low: 0.175, close: 0.178, open: 0.196, volume: 2000 },
        { high: 0.180, low: 0.170, close: 0.175, open: 0.178, volume: 2000 }, // dumpLow 0.170
        { high: 0.186, low: 0.175, close: 0.184, open: 0.175, volume: 1500 },
        { high: 0.186, low: 0.181, close: 0.184, open: 0.182, volume: 1200 },
        { high: 0.186, low: 0.183, close: 0.184, open: 0.184, volume: 1000 },
      ]);
      // impulse 0.030; (0.184-0.170)/0.030 = 0.467 > 0.35
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m: [],
          bars5m,
          market: { price: 0.184, fundingRate: 0 },
        },
        nowMs: NOW,
      });
      expect(result.features.depthFromLow.flagged).toBe(true);
      expect(result.features.depthFromLow.detail.retracePct).toBeGreaterThan(0.35);
    });

    test('flags momentum flip when last 5m upper-half and volume declining', () => {
      const bars5m = buildBars5m([
        { high: 0.180, low: 0.175, close: 0.176, open: 0.178, volume: 3000 },
        { high: 0.178, low: 0.172, close: 0.173, open: 0.177, volume: 2500 },
        { high: 0.180, low: 0.173, close: 0.179, open: 0.174, volume: 2000 },
        { high: 0.185, low: 0.175, close: 0.184, open: 0.177, volume: 1500 }, // vol declining, close upper-half
      ]);
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m: [],
          bars5m,
          market: { price: 0.184, fundingRate: 0 },
        },
        nowMs: NOW,
      });
      expect(result.features.momentumFlip.flagged).toBe(true);
    });

    test('flags retest vigor when >=3 wicks tag retestMin without a flush', () => {
      // loseLevel 0.17362, retestMin 0.17362 - wicks tag zone but closes hold at/above
      const bars1m = [
        { time: minutesAgo(NOW, 8), close: 0.1738, high: 0.1742, low: 0.1736 },
        { time: minutesAgo(NOW, 6), close: 0.1740, high: 0.1745, low: 0.1737 },
        { time: minutesAgo(NOW, 4), close: 0.1740, high: 0.1748, low: 0.1738 },
        { time: minutesAgo(NOW, 2), close: 0.1742, high: 0.1745, low: 0.1739 },
      ];
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m,
          bars5m: [],
          market: { price: 0.174, fundingRate: 0 },
        },
        nowMs: NOW,
      });
      expect(result.features.retestVigor.flagged).toBe(true);
    });

    test('does NOT flag retest vigor if a flush prints below loseLevel', () => {
      const bars1m = [
        { time: minutesAgo(NOW, 8), close: 0.173, high: 0.174, low: 0.172 },
        { time: minutesAgo(NOW, 6), close: 0.173, high: 0.175, low: 0.172 },
        { time: minutesAgo(NOW, 4), close: 0.165, high: 0.173, low: 0.164 }, // flush under loseLevel 0.17362
        { time: minutesAgo(NOW, 2), close: 0.170, high: 0.172, low: 0.168 },
      ];
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m,
          bars5m: [],
          market: { price: 0.170, fundingRate: 0 },
        },
        nowMs: NOW,
      });
      expect(result.features.retestVigor.flagged).toBe(false);
    });

    test('BTC up-trend alone triggers soft_block', () => {
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m: [],
          bars5m: [],
          market: { price: 0.170, fundingRate: 0 },
        },
        btcContext: { bar5m: { open: 77000, close: 77200 } }, // +0.0026 > 0.001
        nowMs: NOW,
      });
      expect(result.decision).toBe('soft_block');
      expect(result.reasons).toContain('btc_up_trend');
    });

    test('BTC up-trend + 1 feature flag escalates to hard_block', () => {
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m: [],
          bars5m: [],
          market: { price: 0.170, fundingRate: -0.0005, openInterestChange1hPct: -0.01 },
        },
        btcContext: { bar5m: { open: 77000, close: 77200 } },
        nowMs: NOW,
      });
      expect(result.decision).toBe('hard_block');
      expect(result.reasons).toContain('crowded_short');
      expect(result.reasons).toContain('btc_up_trend');
    });

    test('two feature flags without BTC gate = hard_block', () => {
      const bars5m = buildBars5m([
        { high: 0.200, low: 0.195, close: 0.196, open: 0.200, volume: 1000 },
        { high: 0.196, low: 0.175, close: 0.178, open: 0.196, volume: 2000 },
        { high: 0.180, low: 0.170, close: 0.175, open: 0.178, volume: 2000 },
        { high: 0.186, low: 0.175, close: 0.184, open: 0.175, volume: 1500 },
        { high: 0.186, low: 0.181, close: 0.184, open: 0.182, volume: 1200 },
        { high: 0.186, low: 0.183, close: 0.184, open: 0.184, volume: 1000 },
      ]);
      const result = evaluateTooLateShortRule({
        rule: BASE_RULE,
        symbolContext: {
          bars1m: [],
          bars5m,
          market: { price: 0.184, fundingRate: -0.0003, openInterestChange1hPct: -0.02 },
        },
        nowMs: NOW,
      });
      expect(result.decision).toBe('hard_block');
      expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    });

    test('default thresholds exported and match spec', () => {
      expect(DEFAULT_THRESHOLDS.crowdedFundingMax).toBe(-0.00015);
      expect(DEFAULT_THRESHOLDS.staleBreakdownMinutes).toBe(30);
      expect(DEFAULT_THRESHOLDS.depthFromLowMaxRetracePct).toBe(0.35);
      expect(DEFAULT_THRESHOLDS.retestWickCountMin).toBe(3);
      expect(DEFAULT_THRESHOLDS.btcUpTrendMinChangePct).toBe(0.001);
    });
  });
});
