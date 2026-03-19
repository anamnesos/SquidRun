'use strict';

const { assessMacroRisk, clearCache, _internals } = require('../macro-risk-gate');
const { classifyRegime, computeRiskScore, regimeConstraints } = _internals;

// Mock global fetch
beforeEach(() => {
  clearCache();
  delete process.env.FRED_API_KEY;
});

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * Build a mock fetch that returns predefined data for each API URL pattern.
 */
function mockFetch({ fearGreed = 50, vix = 18, oil = 70 } = {}) {
  process.env.FRED_API_KEY = 'test-key';
  const impl = jest.fn(async (url) => {
    if (url.includes('alternative.me')) {
      return {
        ok: true,
        json: async () => ({ data: [{ value: String(fearGreed) }] }),
      };
    }
    if (url.includes('VIXCLS')) {
      return {
        ok: true,
        json: async () => ({ observations: [{ value: String(vix) }] }),
      };
    }
    if (url.includes('DCOILWTICO')) {
      return {
        ok: true,
        json: async () => ({ observations: [{ value: String(oil) }] }),
      };
    }
    return { ok: false, json: async () => ({}) };
  });
  global.fetch = impl;
  return impl;
}

// --- Regime classification unit tests ---

describe('classifyRegime', () => {
  test('returns green when all indicators are calm', () => {
    const { regime } = classifyRegime(15, 60, 70);
    expect(regime).toBe('green');
  });

  test('returns yellow when VIX is elevated (20-30)', () => {
    const { regime, reason } = classifyRegime(25, 60, 70);
    expect(regime).toBe('yellow');
    expect(reason.join('; ')).toContain('VIX');
  });

  test('returns yellow when Fear & Greed is 25-40', () => {
    const { regime, reason } = classifyRegime(15, 30, 70);
    expect(regime).toBe('yellow');
    expect(reason.join('; ')).toContain('Fear & Greed');
  });

  test('returns yellow when oil is $85-100', () => {
    const { regime, reason } = classifyRegime(15, 60, 90);
    expect(regime).toBe('yellow');
    expect(reason.join('; ')).toContain('Oil');
  });

  test('returns red when VIX > 30', () => {
    const { regime } = classifyRegime(35, 60, 70);
    expect(regime).toBe('red');
  });

  test('returns red when Fear & Greed < 25', () => {
    const { regime } = classifyRegime(15, 10, 70);
    expect(regime).toBe('red');
  });

  test('returns red when oil > 100', () => {
    const { regime } = classifyRegime(15, 60, 110);
    expect(regime).toBe('red');
  });

  test('worst-case wins: yellow VIX + red oil = red', () => {
    const { regime } = classifyRegime(25, 60, 110);
    expect(regime).toBe('red');
  });
});

// --- Risk score tests ---

describe('computeRiskScore', () => {
  test('low risk scenario returns low score', () => {
    const score = computeRiskScore(12, 80, 55);
    expect(score).toBeLessThan(25);
  });

  test('high risk scenario returns high score', () => {
    const score = computeRiskScore(38, 10, 115);
    expect(score).toBeGreaterThan(75);
  });

  test('score is between 0 and 100', () => {
    const score = computeRiskScore(20, 50, 80);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// --- Regime constraints tests ---

describe('regimeConstraints', () => {
  test('green has full multipliers', () => {
    const c = regimeConstraints('green');
    expect(c.positionSizeMultiplier).toBe(1.0);
    expect(c.buyConfidenceMultiplier).toBe(1.0);
    expect(c.sellConfidenceMultiplier).toBe(1.0);
    expect(c.allowLongs).toBe(true);
  });

  test('yellow reduces position size and buy confidence', () => {
    const c = regimeConstraints('yellow');
    expect(c.positionSizeMultiplier).toBe(0.6);
    expect(c.buyConfidenceMultiplier).toBe(0.8);
  });

  test('red has most restrictive multipliers', () => {
    const c = regimeConstraints('red');
    expect(c.positionSizeMultiplier).toBe(0.35);
    expect(c.buyConfidenceMultiplier).toBe(0.6);
    expect(c.sellConfidenceMultiplier).toBe(1.1);
  });
});

// --- Full assessMacroRisk integration tests ---

describe('assessMacroRisk', () => {
  test('GREEN regime with calm indicators', async () => {
    mockFetch({ fearGreed: 60, vix: 15, oil: 70 });
    const result = await assessMacroRisk();

    expect(result.regime).toBe('green');
    expect(result.score).toBeLessThan(40);
    expect(result.indicators.vix.value).toBe(15);
    expect(result.indicators.vix.source).toBe('api');
    expect(result.indicators.fearGreed.value).toBe(60);
    expect(result.indicators.oilPrice.value).toBe(70);
    expect(result.constraints.positionSizeMultiplier).toBe(1.0);
    expect(result.fetchedAt).toBeTruthy();
    expect(typeof result.reason).toBe('string');
  });

  test('YELLOW regime with elevated VIX', async () => {
    mockFetch({ fearGreed: 55, vix: 25, oil: 70 });
    const result = await assessMacroRisk();

    expect(result.regime).toBe('yellow');
    expect(result.constraints.positionSizeMultiplier).toBe(0.6);
    expect(result.constraints.buyConfidenceMultiplier).toBe(0.8);
  });

  test('RED regime with extreme fear', async () => {
    mockFetch({ fearGreed: 10, vix: 35, oil: 105 });
    const result = await assessMacroRisk();

    expect(result.regime).toBe('red');
    expect(result.score).toBeGreaterThan(60);
    expect(result.constraints.positionSizeMultiplier).toBe(0.35);
    expect(result.constraints.buyConfidenceMultiplier).toBe(0.6);
    expect(result.constraints.sellConfidenceMultiplier).toBe(1.1);
  });

  test('uses fallback values when FRED_API_KEY is missing', async () => {
    // No FRED key set, only mock Fear & Greed
    global.fetch = jest.fn(async (url) => {
      if (url.includes('alternative.me')) {
        return {
          ok: true,
          json: async () => ({ data: [{ value: '50' }] }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    const result = await assessMacroRisk();

    expect(result.indicators.vix.source).toBe('fallback');
    expect(result.indicators.oilPrice.source).toBe('fallback');
    expect(result.indicators.fearGreed.source).toBe('api');
    // Fallback values are calm, so regime should be green
    expect(result.regime).toBe('green');
  });

  test('uses fallback values when APIs fail', async () => {
    process.env.FRED_API_KEY = 'test-key';
    global.fetch = jest.fn(async () => {
      throw new Error('network error');
    });

    const result = await assessMacroRisk();

    expect(result.indicators.vix.source).toBe('fallback');
    expect(result.indicators.fearGreed.source).toBe('fallback');
    expect(result.indicators.oilPrice.source).toBe('fallback');
    expect(result.regime).toBe('green');
  });

  test('caches results for 15 minutes', async () => {
    const fetchImpl = mockFetch({ fearGreed: 60, vix: 15, oil: 70 });

    await assessMacroRisk();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 3 API calls

    await assessMacroRisk();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // Still 3 — served from cache
  });

  test('skipCache forces fresh fetch', async () => {
    const fetchImpl = mockFetch({ fearGreed: 60, vix: 15, oil: 70 });

    await assessMacroRisk();
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    await assessMacroRisk({ skipCache: true });
    expect(fetchImpl).toHaveBeenCalledTimes(6); // 3 more calls
  });
});
