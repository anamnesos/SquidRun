'use strict';

const {
  evaluate, scorePosition, THRESHOLDS, withCooldown, windowFactor, normalizeSource,
} = require('../modules/the-tell/scorer');

const NOW = 1_700_000_000_000;
const minAgo = (n) => NOW - n * 60000;

// A short ETH position whose mark is drifting UP toward a stop above it, with a late acceleration.
function ethShort(overrides = {}) {
  return {
    position: {
      coin: 'ETH', szi: -2, entryPx: 3000, liquidationPx: 3100, leverage: 5, ...overrides.position,
    },
    accountValue: 600,
    glanceAtMs: overrides.glanceAtMs ?? minAgo(20),       // not looked in 20 min
    nowMs: NOW,
    markByCoin: { ETH: overrides.mark ?? 3018 },          // 0.40% below the 3030 stop
    stopByCoin: { ETH: overrides.stop ?? 3030 },
    priceHistByCoin: {
      ETH: overrides.priceHist ?? [
        { tMs: minAgo(30), px: 3010 },
        { tMs: minAgo(20), px: 3012 },
        { tMs: minAgo(10), px: 3014 },
        { tMs: minAgo(2), px: 3015 },
        { tMs: minAgo(1), px: 3016 },
        { tMs: NOW, px: overrides.mark ?? 3018 },         // late acceleration
      ],
    },
    state: overrides.state || {},
  };
}

function run(overrides) {
  const cfg = ethShort(overrides);
  return evaluate({
    positions: [{ coin: 'ETH', szi: cfg.position.szi, entryPx: cfg.position.entryPx,
      liquidationPx: cfg.position.liquidationPx, markPx: cfg.markByCoin.ETH, stop: cfg.stopByCoin.ETH }],
    accountValue: cfg.accountValue, nowMs: cfg.nowMs, glanceAtMs: cfg.glanceAtMs,
    priceHistByCoin: cfg.priceHistByCoin, state: cfg.state,
  });
}

describe('THE TELL scorer — break-of-silence', () => {
  test('SPEAKS when severity+blindness+window+motion all line up', () => {
    const out = run();
    expect(out.speak).toBe(true);
    expect(out.regretScore).toBeGreaterThanOrEqual(THRESHOLDS.SPEAK);
    expect(out.context).toBe('trading:hyperliquid:ETH');
    expect(out.claim).toMatch(/stop is about to hit/i);
    expect(out.receipts.length).toBe(6);
    // dry-run safety: action surfaces but never carries a live-execution directive
    expect(out.proposedAction.executionMode).toBe('dry-run');
    expect(out.proposedAction.reversible).toBe(true);
    expect(out.proposedAction.dryRunLabel).toMatch(/don't touch your money/i);
    expect(JSON.stringify(out.proposedAction)).not.toMatch(/hm-defi-close|execute|autoClose|privateKey/i);
  });

  test('SILENT when HL is open right now (blindness=0) — gate 2', () => {
    const out = run({ glanceAtMs: minAgo(1) });
    expect(out.speak).toBe(false);
    expect(out.swallowed.find((s) => s.coin === 'ETH').reason).toBe('gate2_he_was_looking');
  });

  test('SILENT when near the stop but not moving (chop) — gate 1', () => {
    const flat = [
      { tMs: minAgo(30), px: 3018 }, { tMs: minAgo(2), px: 3018 }, { tMs: NOW, px: 3018 },
    ];
    const out = run({ priceHist: flat });
    expect(out.speak).toBe(false);
    expect(out.swallowed.find((s) => s.coin === 'ETH').reason).toBe('gate1_near_but_no_motion');
  });

  test('SILENT when too close to act — let the stop work — gate 3', () => {
    // mark 0.5 below the 3030 stop, still accelerating -> eta well under the 2-min floor
    const out = run({ mark: 3029.5 });
    expect(out.speak).toBe(false);
    expect(out.swallowed.find((s) => s.coin === 'ETH').reason).toBe('gate3_too_late_let_stop_work');
  });

  test('SILENT when the loss is below the severity floor', () => {
    const out = run({ position: { coin: 'ETH', szi: -0.4, entryPx: 3000, liquidationPx: 3100 } });
    expect(out.speak).toBe(false);
    expect(out.swallowed.find((s) => s.coin === 'ETH').reason).toBe('severity_below_floor');
  });

  test('continuous regretScore is emitted even when it stays SILENT (the felt "tell")', () => {
    const out = run({ glanceAtMs: minAgo(1) }); // looking-now: not eligible, but tension is real
    expect(out.speak).toBe(false);
    expect(out.regretScore).toBeGreaterThan(0);
    expect(out.regretScore).toBeLessThan(THRESHOLDS.SPEAK);
  });
});

describe('THE TELL scorer — silence discipline', () => {
  test('COOLDOWN suppresses a coin that would otherwise speak', () => {
    const out = run({ state: { cooldowns: { ETH: NOW + 5 * 60000 } } });
    expect(out.speak).toBe(false);
    expect(out.swallowed.find((s) => s.coin === 'ETH').reason).toBe('cooldown_active');
  });

  test('ONE-AT-A-TIME: only the highest-regret position speaks; the other is swallowed', () => {
    const positions = [
      { coin: 'ETH', szi: -2, entryPx: 3000, liquidationPx: 3100, markPx: 3018, stop: 3030 },
      { coin: 'BTC', szi: -0.1, entryPx: 60000, liquidationPx: 62000, markPx: 60360, stop: 60600 },
    ];
    const out = evaluate({
      positions, accountValue: 600, nowMs: NOW, glanceAtMs: minAgo(20),
      priceHistByCoin: {
        ETH: ethShort().priceHistByCoin.ETH,
        BTC: [
          { tMs: minAgo(30), px: 60200 }, { tMs: minAgo(10), px: 60280 },
          { tMs: minAgo(2), px: 60320 }, { tMs: minAgo(1), px: 60340 }, { tMs: NOW, px: 60360 },
        ],
      },
      state: {},
    });
    expect(out.speak).toBe(true);
    expect(out.context).toBe('trading:hyperliquid:ETH');
    const btc = out.swallowed.find((s) => s.coin === 'BTC');
    expect(btc).toBeTruthy();
    expect(btc.reason).toBe('lower_regret_than_ETH');
  });

  test('NAKED position (no stop) escalates: speaks about the missing stop, risk unbounded', () => {
    const out = evaluate({
      positions: [{ coin: 'ETH', szi: -2, entryPx: 3000, liquidationPx: 3100, markPx: 3060, stop: null }],
      accountValue: 600, nowMs: NOW, glanceAtMs: minAgo(20),
      priceHistByCoin: {
        ETH: [
          { tMs: minAgo(30), px: 3030 }, { tMs: minAgo(10), px: 3045 },
          { tMs: minAgo(2), px: 3055 }, { tMs: minAgo(1), px: 3058 }, { tMs: NOW, px: 3060 },
        ],
      },
      state: {},
    });
    expect(out.speak).toBe(true);
    expect(out.claim).toMatch(/NO stop/i);
    expect(out.receipts.find((r) => r.label === 'Stop').value).toBe('NONE SET');
    // honest bounded loss, not dramatic "unbounded": 2 * |3000-3100| = $200 to liquidation
    expect(out.receipts.find((r) => r.label === 'At risk').value).toMatch(/up to -\$200\.00 at liquidation/i);
  });

  test('NAKED dust/ghost (sub-floor risk) is SILENT even with motion — no cry-wolf', () => {
    // a stale ~$3 naked position (szi -1, entry 30, liq 33) drifting up: must NOT speak, must NOT glow the edge
    const out = evaluate({
      positions: [{ coin: 'HOOD', szi: -1, entryPx: 30, liquidationPx: 33, markPx: 30.5, stop: null }],
      accountValue: 0, nowMs: NOW, glanceAtMs: minAgo(20),
      priceHistByCoin: {
        HOOD: [{ tMs: minAgo(10), px: 30.0 }, { tMs: minAgo(1), px: 30.4 }, { tMs: NOW, px: 30.5 }],
      },
      state: {}, source: 'live',
    });
    expect(out.speak).toBe(false);
    expect(out.regretScore).toBe(0); // sub-floor ghost contributes ZERO ambient tension — edge stays at rest
    expect(out.swallowed.find((s) => s.coin === 'HOOD').reason).toBe('severity_below_floor');
  });
});

describe('THE TELL scorer — structural silence (combiner)', () => {
  test('any single factor at zero collapses the score to zero (AND-like)', () => {
    // blindness 0 (looking now) must zero the score regardless of the others
    const s = scorePosition({
      position: { coin: 'ETH', szi: -2, entryPx: 3000, liquidationPx: 3100 },
      mark: 3018, stop: 3030, accountValue: 600, nowMs: NOW, glanceAtMs: NOW, // looking RIGHT now
      priceHist: ethShort().priceHistByCoin.ETH,
    });
    expect(s.regretScore).toBe(0);
  });

  test('cooldown helper arms a per-coin window', () => {
    const next = withCooldown({}, 'ETH', NOW);
    expect(next.cooldowns.ETH).toBe(NOW + THRESHOLDS.COOLDOWN_MIN * 60000);
  });
});

describe('THE TELL scorer — the felt "tell" is a smooth build, not a jump-cut', () => {
  test('windowFactor is continuous across the whole eta range (no pops)', () => {
    let prev = windowFactor(0.01);
    let maxStep = 0;
    for (let eta = 0.02; eta <= 60; eta += 0.05) {
      const w = windowFactor(eta);
      maxStep = Math.max(maxStep, Math.abs(w - prev));
      prev = w;
    }
    // no discontinuity: a real jump-cut would be >=0.1 (the old code jumped ~0.5 at the cliff edge).
    // The steepest legit slope is the post-peak futile release (~0.5/min) — continuous, not a pop.
    expect(maxStep).toBeLessThan(0.03);
  });

  test('tension builds on approach (silent), peaks in the actionable band, releases when futile', () => {
    expect(windowFactor(50)).toBe(0);                 // beyond the horizon: at rest
    expect(windowFactor(30)).toBeGreaterThan(0);      // approaching: building
    expect(windowFactor(30)).toBeLessThan(windowFactor(10)); // hotter as it nears the band
    expect(windowFactor(6)).toBeGreaterThan(windowFactor(30)); // band hotter than approach
    expect(windowFactor(0.5)).toBeLessThan(windowFactor(6));   // futile: releasing
  });

  test('rest -> approach(silent, nonzero) -> speak, with no 0-then-jump', () => {
    // approach frame ~30 min out: NOT eligible (gate1), but regret is real and rising
    const approach = scorePosition({
      position: { coin: 'ETH', szi: -2, entryPx: 3000, liquidationPx: 3100 },
      mark: 2971, stop: 3030, accountValue: 600, nowMs: NOW, glanceAtMs: minAgo(20),
      priceHist: [
        { tMs: minAgo(30), px: 2960 }, { tMs: minAgo(10), px: 2965 },
        { tMs: minAgo(2), px: 2968 }, { tMs: minAgo(1), px: 2969 }, { tMs: NOW, px: 2971 },
      ],
    });
    expect(approach.eligible).toBe(false);
    expect(approach.regretScore).toBeGreaterThan(0.3);
    expect(approach.regretScore).toBeLessThan(THRESHOLDS.SPEAK);
    // band frame ~6 min out: now it speaks, and the score rose (didn't jump from ~0)
    const band = scorePosition({
      position: { coin: 'ETH', szi: -2, entryPx: 3000, liquidationPx: 3100 },
      mark: 3018, stop: 3030, accountValue: 600, nowMs: NOW, glanceAtMs: minAgo(20),
      priceHist: ethShort().priceHistByCoin.ETH,
    });
    expect(band.eligible).toBe(true);
    expect(band.regretScore).toBeGreaterThan(approach.regretScore);
  });
});

describe('THE TELL scorer — honesty: a replay can never read as live money', () => {
  test('FAIL-SAFE: absent/blank source is "unverified" (badged), NEVER "live"', () => {
    expect(run().source).toBe('unverified');                 // run() passes no source
    expect(normalizeSource(undefined)).toBe('unverified');
    expect(normalizeSource('')).toBe('unverified');
    expect(normalizeSource('  ')).toBe('unverified');
  });

  test('"live" only when explicitly asserted; scenario tags pass through verbatim', () => {
    expect(normalizeSource('live')).toBe('live');
    const live = evaluate({
      positions: [{ coin: 'ETH', szi: -2, entryPx: 3000, liquidationPx: 3100, markPx: 3018, stop: 3030 }],
      accountValue: 600, nowMs: NOW, glanceAtMs: minAgo(20),
      priceHistByCoin: { ETH: ethShort().priceHistByCoin.ETH }, state: {}, source: 'live',
    });
    expect(live.source).toBe('live');
    const replayed = evaluate({
      positions: [{ coin: 'ETH', szi: -2, entryPx: 3000, liquidationPx: 3100, markPx: 3018, stop: 3030 }],
      accountValue: 600, nowMs: NOW, glanceAtMs: minAgo(20),
      priceHistByCoin: { ETH: ethShort().priceHistByCoin.ETH }, state: {}, source: 'scenario:eth-stop-approach',
    });
    expect(replayed.source).toBe('scenario:eth-stop-approach');
  });
});
