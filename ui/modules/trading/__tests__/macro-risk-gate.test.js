'use strict';

const { assessMacroRisk, applyMacroRiskToSignal, clearCache, _internals } = require('../macro-risk-gate');
const {
  classifyRegime,
  classifyCrisisType,
  computeRiskScore,
  regimeConstraints,
  getFedEventState,
  normalizeGdeltArticles,
} = _internals;

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
function mockFetch({ fearGreed = 50, vix = 18, oil = 70, gdeltArticles = null } = {}) {
  process.env.FRED_API_KEY = 'test-key';
  const impl = jest.fn(async (url) => {
    if (url.includes('alternative.me')) {
      return {
        ok: true,
        text: async () => JSON.stringify({ data: [{ value: String(fearGreed) }] }),
      };
    }
    if (url.includes('VIXCLS')) {
      return {
        ok: true,
        text: async () => JSON.stringify({ observations: [{ value: String(vix) }] }),
      };
    }
    if (url.includes('DCOILWTICO')) {
      return {
        ok: true,
        text: async () => JSON.stringify({ observations: [{ value: String(oil) }] }),
      };
    }
    if (url.includes('api.gdeltproject.org')) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          articles: gdeltArticles || [
            { title: 'Shipping lanes stay calm', tone: '0.4', sourcecountry: 'United States' },
            { title: 'Regional talks continue', tone: '0.1', sourcecountry: 'United Arab Emirates' },
          ],
        }),
      };
    }
    return { ok: false, text: async () => '{}' };
  });
  global.fetch = impl;
  return impl;
}

// --- Regime classification unit tests ---

describe('classifyRegime', () => {
  test('returns green when all indicators are calm', () => {
    const { regime } = classifyRegime(15, 60, 70, {
      geopolitics: { riskScore: 20, stayCashTrigger: false },
      fed: { isEventDay: false, inDangerZone: false },
    });
    expect(regime).toBe('green');
  });

  test('returns yellow when VIX is elevated (20-30)', () => {
    const { regime, reason } = classifyRegime(25, 60, 70, {
      geopolitics: { riskScore: 20, stayCashTrigger: false },
      fed: { isEventDay: false, inDangerZone: false },
    });
    expect(regime).toBe('yellow');
    expect(reason.join('; ')).toContain('VIX');
  });

  test('returns yellow when Fear & Greed is 25-40', () => {
    const { regime, reason } = classifyRegime(15, 30, 70, {
      geopolitics: { riskScore: 20, stayCashTrigger: false },
      fed: { isEventDay: false, inDangerZone: false },
    });
    expect(regime).toBe('yellow');
    expect(reason.join('; ')).toContain('Fear & Greed');
  });

  test('returns yellow when oil is $85-100', () => {
    const { regime, reason } = classifyRegime(15, 60, 90, {
      geopolitics: { riskScore: 20, stayCashTrigger: false },
      fed: { isEventDay: false, inDangerZone: false },
    });
    expect(regime).toBe('yellow');
    expect(reason.join('; ')).toContain('Oil');
  });

  test('returns red when GDELT geopolitical risk is elevated', () => {
    const { regime } = classifyRegime(15, 60, 70, {
      geopolitics: { riskScore: 85, stayCashTrigger: false },
      fed: { isEventDay: false, inDangerZone: false },
    });
    expect(regime).toBe('red');
  });

  test('returns stay_cash when GDELT detects kinetic chokepoint conflict', () => {
    const { regime } = classifyRegime(15, 60, 70, {
      geopolitics: { riskScore: 95, stayCashTrigger: true, avgTone: -3.45 },
      fed: { isEventDay: false, inDangerZone: false },
      market: { oilDeltaPct: 0.03, vixDeltaPct: 0.08 },
    });
    expect(regime).toBe('stay_cash');
  });
});

describe('classifyCrisisType', () => {
  test('classifies inflationary crisis when oil rises into elevated VIX', () => {
    expect(classifyCrisisType(26, 92, { oilDeltaPct: 0.035, vixDeltaPct: 0.06 })).toBe('inflationary');
  });

  test('classifies deflationary crisis when oil falls into elevated VIX', () => {
    expect(classifyCrisisType(31, 64, { oilDeltaPct: -0.045, vixDeltaPct: 0.09 })).toBe('deflationary');
  });
});

// --- Risk score tests ---

describe('computeRiskScore', () => {
  test('low risk scenario returns low score', () => {
    const score = computeRiskScore(12, 80, 55, {
      geopolitics: { riskScore: 20, sentiment: 0.2, stayCashTrigger: false },
      fed: { isEventDay: false, inDangerZone: false },
    });
    expect(score).toBeLessThan(25);
  });

  test('high risk scenario returns high score', () => {
    const score = computeRiskScore(38, 10, 115, {
      geopolitics: { riskScore: 88, sentiment: -0.6, stayCashTrigger: false },
      fed: { isEventDay: false, inDangerZone: false },
    });
    expect(score).toBeGreaterThan(75);
  });

  test('score is between 0 and 100', () => {
    const score = computeRiskScore(20, 50, 80, {
      geopolitics: { riskScore: 65, sentiment: -0.2, stayCashTrigger: false },
      fed: { isEventDay: true, inDangerZone: false },
    });
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
    expect(c.positionSizeMultiplier).toBe(0.5);
    expect(c.buyConfidenceMultiplier).toBe(0.8);
  });

  test('red blocks new longs and boosts defensive sells', () => {
    const c = regimeConstraints('red');
    expect(c.allowLongs).toBe(false);
    expect(c.blockNewPositions).toBe(true);
    expect(c.positionSizeMultiplier).toBe(0.35);
    expect(c.buyConfidenceMultiplier).toBe(0.6);
    expect(c.sellConfidenceMultiplier).toBe(1.1);
  });

  test('stay_cash blocks all new positions', () => {
    const c = regimeConstraints('stay_cash', { crisisType: 'deflationary' });
    expect(c.allowLongs).toBe(false);
    expect(c.blockNewPositions).toBe(true);
    expect(c.positionSizeMultiplier).toBe(0);
    expect(c.buyConfidenceMultiplier).toBe(0);
    expect(c.crisisUniverse).toContain('TLT');
    expect(c.crisisUniverse).not.toContain('XLE');
  });
});

describe('normalizeGdeltArticles', () => {
  test('maps deep negative tone plus kinetic chokepoint keywords to stay_cash risk', () => {
    const result = normalizeGdeltArticles({
      articles: [
        {
          title: 'Missile strikes threaten tanker traffic in Strait of Hormuz',
          tone: '-3.45',
          sourcecountry: 'Iran',
        },
        {
          title: 'Warships deployed after attack near Strait of Hormuz',
          tone: '-5.98',
          sourcecountry: 'Oman',
        },
      ],
    }, '(Iran OR "Strait of Hormuz")');

    expect(result.avgTone).toBeLessThanOrEqual(-3);
    expect(result.stayCashTrigger).toBe(true);
    expect(result.riskScore).toBeGreaterThan(90);
    expect(result.activeKineticConflict).toBe(true);
  });
});

describe('applyMacroRiskToSignal', () => {
  test('converts BUY to HOLD when longs are blocked', () => {
    const signal = applyMacroRiskToSignal({
      ticker: 'BTC/USD',
      direction: 'BUY',
      confidence: 0.82,
      reasoning: 'Breakout above range high.',
    }, {
      regime: 'red',
      constraints: regimeConstraints('red'),
    });

    expect(signal.direction).toBe('HOLD');
    expect(signal.confidence).toBeGreaterThanOrEqual(0.72);
    expect(signal.reasoning).toContain('blocks new longs');
  });

  test('preserves SELL and boosts defensive confidence in stay_cash', () => {
    const signal = applyMacroRiskToSignal({
      ticker: 'BTC/USD',
      direction: 'SELL',
      confidence: 0.7,
      reasoning: 'Momentum rolled over.',
    }, {
      regime: 'stay_cash',
      constraints: regimeConstraints('stay_cash'),
    });

    expect(signal.direction).toBe('SELL');
    expect(signal.confidence).toBeGreaterThan(0.7);
    expect(signal.reasoning).toContain('defensive');
  });

  test('preserves crisis-universe BUY signals during stay_cash crisis mode', () => {
    const signal = applyMacroRiskToSignal({
      ticker: 'SQQQ',
      direction: 'BUY',
      confidence: 0.81,
      reasoning: 'Inverse ETF momentum improving.',
    }, {
      regime: 'stay_cash',
      strategyMode: 'crisis',
      constraints: regimeConstraints('stay_cash'),
    });

    expect(signal.direction).toBe('BUY');
    expect(signal.reasoning).toContain('CRISIS mode');
  });
});

describe('getFedEventState', () => {
  test('marks the Fed danger zone on decision day', () => {
    const state = getFedEventState(new Date('2026-03-18T18:30:00.000Z'));
    expect(state.isEventDay).toBe(true);
    expect(state.inDangerZone).toBe(true);
    expect(state.hoursUntilDecision).toBeLessThanOrEqual(0);
    expect(state.hoursUntilDecision).toBeGreaterThanOrEqual(-1);
    expect(state.nextDecisionAt).toBe('2026-03-18T18:00:00.000Z');
  });
});

// --- Full assessMacroRisk integration tests ---

describe('assessMacroRisk', () => {
  test('GREEN regime with calm indicators', async () => {
    mockFetch({ fearGreed: 60, vix: 15, oil: 70 });
    const result = await assessMacroRisk();

    expect(result.regime).toBe('green');
    expect(result.strategyMode).toBe('normal');
    expect(result.score).toBeLessThan(40);
    expect(result.indicators.vix.value).toBe(15);
    expect(result.indicators.vix.source).toBe('api');
    expect(result.indicators.fearGreed.value).toBe(60);
    expect(result.indicators.oilPrice.value).toBe(70);
    expect(result.constraints.positionSizeMultiplier).toBe(1.0);
    expect(result.intelligence.geopolitics.source).toBe('gdelt');
    expect(result.fetchedAt).toBeTruthy();
    expect(typeof result.reason).toBe('string');
  });

  test('YELLOW regime with elevated VIX', async () => {
    mockFetch({
      fearGreed: 55,
      vix: 25,
      oil: 70,
      gdeltArticles: [
        { title: 'Shipping tension rises in Red Sea', tone: '-1.6' },
      ],
    });
    const result = await assessMacroRisk();

    expect(result.regime).toBe('yellow');
    expect(result.strategyMode).toBe('defensive');
    expect(result.constraints.positionSizeMultiplier).toBe(0.5);
    expect(result.constraints.buyConfidenceMultiplier).toBe(0.8);
  });

  test('RED regime with geopolitical conflict', async () => {
    mockFetch({
      fearGreed: 35,
      vix: 22,
      oil: 86,
      gdeltArticles: [
        { title: 'Missile launch threatens tanker route near Strait of Hormuz', tone: '-2.45' },
        { title: 'Regional conflict rattles shipping markets', tone: '-2.2' },
      ],
    });
    const result = await assessMacroRisk();

    expect(result.regime).toBe('red');
    expect(result.strategyMode).toBe('defensive');
    expect(result.score).toBeGreaterThan(60);
    expect(result.constraints.allowLongs).toBe(false);
    expect(result.constraints.positionSizeMultiplier).toBe(0.35);
    expect(result.constraints.buyConfidenceMultiplier).toBe(0.6);
    expect(result.constraints.sellConfidenceMultiplier).toBe(1.1);
  });

  test('STAY_CASH regime with deep Hormuz conflict tone', async () => {
    mockFetch({
      fearGreed: 11,
      vix: 25.1,
      oil: 93.39,
      gdeltArticles: [
        { title: 'Missile strikes hit tankers in Strait of Hormuz', tone: '-3.45' },
        { title: 'Warships respond after attack near Strait of Hormuz chokepoint', tone: '-5.98' },
      ],
    });
    const result = await assessMacroRisk();

    expect(result.regime).toBe('stay_cash');
    expect(result.strategyMode).toBe('crisis');
    expect(result.crisisType).toBe('inflationary');
    expect(result.score).toBeGreaterThan(90);
    expect(result.intelligence.geopolitics.stayCashTrigger).toBe(true);
    expect(result.constraints.buyConfidenceMultiplier).toBe(0);
    expect(result.constraints.positionSizeMultiplier).toBe(0);
  });

  test('uses fallback values when FRED_API_KEY is missing', async () => {
    // No FRED key set, only mock Fear & Greed
    global.fetch = jest.fn(async (url) => {
      if (url.includes('alternative.me')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ data: [{ value: '50' }] }),
        };
      }
      if (url.includes('api.gdeltproject.org')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ articles: [] }),
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
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    await assessMacroRisk();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test('skipCache forces fresh fetch', async () => {
    const fetchImpl = mockFetch({ fearGreed: 60, vix: 15, oil: 70 });

    await assessMacroRisk();
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    await assessMacroRisk({ skipCache: true });
    expect(fetchImpl).toHaveBeenCalledTimes(8);
  });
});
