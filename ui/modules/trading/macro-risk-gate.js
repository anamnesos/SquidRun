/**
 * Macro Risk Gate — Assesses macro-economic conditions to adjust trading constraints.
 *
 * Fetches Fear & Greed Index, VIX, and oil prices from free APIs.
 * Computes a risk regime (green/yellow/red) and returns position-sizing constraints.
 * Results are cached for 15 minutes to avoid hammering APIs every consensus round.
 */

'use strict';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const FALLBACK_VALUES = Object.freeze({
  vix: 18,
  fearGreed: 50,
  oilPrice: 70,
});

let _cache = null;

/**
 * Fetch JSON from a URL with a timeout.
 * @param {string} url
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<Object|null>}
 */
async function fetchJson(url, timeoutMs = 10000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch the Alternative.me Crypto Fear & Greed Index (0-100).
 * @returns {Promise<{value: number, source: string}>}
 */
async function fetchFearGreed() {
  const data = await fetchJson('https://api.alternative.me/fng/?limit=1');
  if (data?.data?.[0]?.value != null) {
    return { value: Number(data.data[0].value), source: 'api' };
  }
  console.warn('[macro-risk-gate] Fear & Greed API failed, using fallback');
  return { value: FALLBACK_VALUES.fearGreed, source: 'fallback' };
}

/**
 * Fetch a FRED series observation (most recent value).
 * @param {string} seriesId
 * @param {string} label
 * @param {number} fallback
 * @returns {Promise<{value: number, source: string}>}
 */
async function fetchFredSeries(seriesId, label, fallback) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    console.warn(`[macro-risk-gate] FRED_API_KEY missing, using fallback for ${label}`);
    return { value: fallback, source: 'fallback' };
  }
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=1&file_type=json&api_key=${apiKey}`;
  const data = await fetchJson(url);
  const obs = data?.observations?.[0];
  if (obs?.value != null && obs.value !== '.') {
    return { value: Number(obs.value), source: 'api' };
  }
  console.warn(`[macro-risk-gate] FRED ${seriesId} returned no data, using fallback for ${label}`);
  return { value: fallback, source: 'fallback' };
}

/**
 * Determine regime from a single indicator.
 * @param {number} vix
 * @param {number} fearGreed
 * @param {number} oilPrice
 * @returns {{regime: string, reason: string[]}}
 */
function classifyRegime(vix, fearGreed, oilPrice) {
  const reasons = [];
  let worstRegime = 'green';

  function escalate(regime, reason) {
    reasons.push(reason);
    if (regime === 'red') {
      worstRegime = 'red';
    } else if (regime === 'yellow' && worstRegime !== 'red') {
      worstRegime = 'yellow';
    }
  }

  // VIX thresholds
  if (vix > 30) {
    escalate('red', `VIX at ${vix.toFixed(1)} (>30 = extreme fear)`);
  } else if (vix >= 20) {
    escalate('yellow', `VIX at ${vix.toFixed(1)} (20-30 = elevated)`);
  }

  // Fear & Greed thresholds (lower = more fear = more risk)
  if (fearGreed < 25) {
    escalate('red', `Fear & Greed at ${fearGreed} (<25 = extreme fear)`);
  } else if (fearGreed <= 40) {
    escalate('yellow', `Fear & Greed at ${fearGreed} (25-40 = fear)`);
  }

  // Oil thresholds
  if (oilPrice > 100) {
    escalate('red', `Oil at $${oilPrice.toFixed(2)} (>$100 = supply shock risk)`);
  } else if (oilPrice >= 85) {
    escalate('yellow', `Oil at $${oilPrice.toFixed(2)} ($85-100 = elevated)`);
  }

  if (reasons.length === 0) {
    reasons.push(`All clear: VIX ${vix.toFixed(1)}, F&G ${fearGreed}, Oil $${oilPrice.toFixed(2)}`);
  }

  return { regime: worstRegime, reason: reasons };
}

/**
 * Compute a composite risk score (0-100, higher = more risk).
 * @param {number} vix
 * @param {number} fearGreed
 * @param {number} oilPrice
 * @returns {number}
 */
function computeRiskScore(vix, fearGreed, oilPrice) {
  // VIX: 10 = 0 risk, 40+ = 100 risk
  const vixScore = Math.min(100, Math.max(0, ((vix - 10) / 30) * 100));
  // Fear & Greed inverted: 100 F&G = 0 risk, 0 F&G = 100 risk
  const fgScore = Math.min(100, Math.max(0, 100 - fearGreed));
  // Oil: 50 = 0 risk, 120+ = 100 risk
  const oilScore = Math.min(100, Math.max(0, ((oilPrice - 50) / 70) * 100));

  // Weighted average — VIX gets the most weight for equity trading
  return Math.round(vixScore * 0.45 + fgScore * 0.35 + oilScore * 0.20);
}

/**
 * Map regime to trading constraints.
 * @param {string} regime
 * @returns {Object}
 */
function regimeConstraints(regime) {
  switch (regime) {
    case 'red':
      return {
        allowLongs: true,
        positionSizeMultiplier: 0.35,
        buyConfidenceMultiplier: 0.6,
        sellConfidenceMultiplier: 1.1,
      };
    case 'yellow':
      return {
        allowLongs: true,
        positionSizeMultiplier: 0.6,
        buyConfidenceMultiplier: 0.8,
        sellConfidenceMultiplier: 1.0,
      };
    default: // green
      return {
        allowLongs: true,
        positionSizeMultiplier: 1.0,
        buyConfidenceMultiplier: 1.0,
        sellConfidenceMultiplier: 1.0,
      };
  }
}

/**
 * Assess current macro risk conditions.
 *
 * @param {Object} [options={}]
 * @param {boolean} [options.skipCache=false] - Force fresh API calls
 * @param {number} [options.timeoutMs=10000] - Per-request timeout
 * @returns {Promise<Object>} Macro risk assessment
 */
async function assessMacroRisk(options = {}) {
  const { skipCache = false } = options;

  // Return cached result if still fresh
  if (!skipCache && _cache && (Date.now() - _cache.timestamp) < CACHE_TTL_MS) {
    return _cache.result;
  }

  // Fetch all indicators in parallel
  const [fearGreedResult, vixResult, oilResult] = await Promise.all([
    fetchFearGreed(),
    fetchFredSeries('VIXCLS', 'VIX', FALLBACK_VALUES.vix),
    fetchFredSeries('DCOILWTICO', 'Oil (WTI)', FALLBACK_VALUES.oilPrice),
  ]);

  const vix = vixResult.value;
  const fearGreed = fearGreedResult.value;
  const oilPrice = oilResult.value;

  const { regime, reason } = classifyRegime(vix, fearGreed, oilPrice);
  const score = computeRiskScore(vix, fearGreed, oilPrice);
  const constraints = regimeConstraints(regime);
  const fetchedAt = new Date().toISOString();

  const result = {
    regime,
    score,
    indicators: {
      vix: { value: vix, source: vixResult.source },
      fearGreed: { value: fearGreed, source: fearGreedResult.source },
      oilPrice: { value: oilPrice, source: oilResult.source },
    },
    constraints,
    reason: reason.join('; '),
    fetchedAt,
  };

  _cache = { result, timestamp: Date.now() };
  return result;
}

/**
 * Clear the internal cache (useful for testing).
 */
function clearCache() {
  _cache = null;
}

module.exports = {
  assessMacroRisk,
  clearCache,
  // Exported for testing
  _internals: {
    classifyRegime,
    computeRiskScore,
    regimeConstraints,
    fetchFearGreed,
    fetchFredSeries,
    FALLBACK_VALUES,
    CACHE_TTL_MS,
  },
};
