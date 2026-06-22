'use strict';

const { evaluate, SIGNAL_THRESHOLDS } = require('../modules/the-tell/scorer');

const NOW = 1_700_000_000_000;
const hrs = (n) => NOW + n * 3600000;
const daysAgo = (n) => NOW - n * 86400000;

const sig = (over) => ({ id: over.id || 's1', source: 'live', observedAtMs: NOW, ...over });
const run = (signals) => evaluate({ positions: [], signals, accountValue: 600, nowMs: NOW, glanceAtMs: NOW, state: {}, source: 'live' });

// ---------- promise:collision (the sharp one) ----------
describe('promise:collision — fires ONLY on real-hours impossibility', () => {
  const collide = (overrides = {}) => sig({
    id: 'collide1', type: 'promise:collision', context: 'promise:collision:eunbyul-charles',
    facts: {
      commitments: [
        { id: 'c1', who: '은별', relationshipWeight: 0.95, what: 'review the Hillstate filing', dueMs: hrs(3), durationMin: 120, hardness: 'hard', madeInContextRef: 'telegram:eunbyul' },
        { id: 'c2', who: 'Charles', relationshipWeight: 0.8, what: 'the Saturday rough-in', dueMs: hrs(4), durationMin: 180, hardness: 'hard', madeInContextRef: 'sms:charles' },
      ],
      availableWindows: [{ startMs: NOW, endMs: hrs(4) }], existingBusyMin: 0,
      ...overrides,
    },
  });

  test('SPEAKS when the hard commitments genuinely cannot both fit', () => {
    const out = run([collide()]);
    expect(out.speak).toBe(true);
    expect(out.context).toMatch(/promise:collision/);
    expect(out.claim).toMatch(/don't both fit/i);
    expect(out.proposedAction.executionMode).toBe('dry-run');
  });

  test('SILENT when the same commitments actually FIT the real hours (no vague-overlap alarm)', () => {
    // push the second deadline out so 5h of work fits before both are due
    const out = run([collide({
      commitments: [
        { id: 'c1', who: '은별', relationshipWeight: 0.95, what: 'review', dueMs: hrs(3), durationMin: 120, hardness: 'hard', madeInContextRef: 'telegram:eunbyul' },
        { id: 'c2', who: 'Charles', relationshipWeight: 0.8, what: 'rough-in', dueMs: hrs(10), durationMin: 180, hardness: 'hard', madeInContextRef: 'sms:charles' },
      ],
      availableWindows: [{ startMs: NOW, endMs: hrs(12) }],
    })]);
    expect(out.speak).toBe(false);
    expect(out.swallowed[0].reason).toBe('fits_real_hours_no_collision');
  });

  test('SILENT when any colliding duration is a guess (cannot assert impossibility on soft input)', () => {
    const out = run([collide({
      commitments: [
        { id: 'c1', who: '은별', relationshipWeight: 0.95, what: 'review', dueMs: hrs(3), durationMin: 120, hardness: 'hard', madeInContextRef: 'telegram:eunbyul' },
        { id: 'c2', who: 'Charles', relationshipWeight: 0.8, what: 'rough-in', dueMs: hrs(4), durationMin: undefined, hardness: 'hard', madeInContextRef: 'sms:charles' },
      ],
    })]);
    expect(out.speak).toBe(false);
    expect(out.swallowed[0].reason).toBe('collision_inputs_soft_unknown');
  });

  test('SILENT when both were set in the SAME conversation (he is not blind to the clash)', () => {
    const out = run([collide({
      commitments: [
        { id: 'c1', who: '은별', relationshipWeight: 0.95, what: 'review', dueMs: hrs(3), durationMin: 120, hardness: 'hard', madeInContextRef: 'telegram:eunbyul' },
        { id: 'c2', who: 'Charles', relationshipWeight: 0.8, what: 'rough-in', dueMs: hrs(4), durationMin: 180, hardness: 'hard', madeInContextRef: 'telegram:eunbyul' },
      ],
    })]);
    expect(out.speak).toBe(false);
  });

  test('SILENT when the collision touches nobody who matters (below relationship floor)', () => {
    const out = run([collide({
      commitments: [
        { id: 'c1', who: 'rando', relationshipWeight: 0.2, what: 'x', dueMs: hrs(3), durationMin: 120, hardness: 'hard', madeInContextRef: 'a' },
        { id: 'c2', who: 'rando2', relationshipWeight: 0.2, what: 'y', dueMs: hrs(4), durationMin: 180, hardness: 'hard', madeInContextRef: 'b' },
      ],
    })]);
    expect(out.speak).toBe(false);
    expect(out.swallowed[0].reason).toBe('below_materiality_floor');
  });
});

// ---------- trustquote:job-margin ----------
describe('trustquote:job-margin — under his own floor, only with enough history', () => {
  const bid = (facts) => sig({ id: 'bid1', type: 'trustquote:job-margin', context: 'trustquote:job-margin:455', facts });

  test('SPEAKS when a ready-to-send bid is materially under his proven floor', () => {
    const out = run([bid({ bidAmount: 95000, jobType: 'rough-in', bidMarginPct: 0.18, historicalMargin: { floorPct: 0.30, sampleCount: 5 }, bidStatus: 'ready-to-send' })]);
    expect(out.speak).toBe(true);
    expect(out.claim).toMatch(/under your own floor/i);
    expect(out.proposedAction.executionMode).toBe('dry-run');
  });

  test('SILENT with too little history to assert a floor (anti wrong-margin-read)', () => {
    const out = run([bid({ bidAmount: 95000, jobType: 'rough-in', bidMarginPct: 0.18, historicalMargin: { floorPct: 0.30, sampleCount: 2 }, bidStatus: 'ready-to-send' })]);
    expect(out.speak).toBe(false);
    expect(out.swallowed[0].reason).toBe('insufficient_history_for_floor');
  });

  test('SILENT once the bid is already sent (window closed)', () => {
    const out = run([bid({ bidAmount: 95000, jobType: 'rough-in', bidMarginPct: 0.18, historicalMargin: { floorPct: 0.30, sampleCount: 5 }, bidStatus: 'sent' })]);
    expect(out.speak).toBe(false);
    expect(out.swallowed[0].reason).toBe('already_sent');
  });

  test('SILENT on a trivial under-floor amount', () => {
    const out = run([bid({ bidAmount: 200, jobType: 'service', bidMarginPct: 0.20, historicalMargin: { floorPct: 0.30, sampleCount: 8 }, bidStatus: 'ready-to-send' })]);
    expect(out.speak).toBe(false);
    expect(out.swallowed[0].reason).toBe('below_materiality_floor');
  });
});

// ---------- trustquote:invoice-aging ----------
describe('trustquote:invoice-aging — genuinely overdue, not a data lag', () => {
  const inv = (facts) => sig({ id: 'inv1', type: 'trustquote:invoice-aging', context: 'trustquote:invoice-aging:109', facts });

  test('SPEAKS on a real, collectable, unchased overdue invoice', () => {
    const out = run([inv({ invoiceAmount: 800, dueMs: daysAgo(20), status: 'unpaid', isPendingJob: true, documentType: 'job', customerReachable: true })]);
    expect(out.speak).toBe(true);
    expect(out.claim).toMatch(/overdue/i);
  });

  test('SILENT on a draft quote even when it is old and unpaid', () => {
    const out = run([inv({ invoiceAmount: 36500, dueMs: daysAgo(66), status: 'draft', isPendingJob: false, isProposal: true, documentType: 'quote', invoiceLabel: 'Quote #', customerReachable: true })]);
    expect(out.speak).toBe(false);
    expect(out.swallowed[0].reason).toBe('proposal_not_receivable');
  });

  test('SILENT when the feed cannot prove TrustQuote isPendingJob', () => {
    const out = run([inv({ invoiceAmount: 800, dueMs: daysAgo(20), status: 'unpaid', documentType: 'job', customerReachable: true })]);
    expect(out.speak).toBe(false);
    expect(out.swallowed[0].reason).toBe('not_pending_job');
  });

  test('SILENT when payment is actually recorded (stale "unpaid" flag = data lag)', () => {
    const out = run([inv({ invoiceAmount: 800, dueMs: daysAgo(20), status: 'unpaid', isPendingJob: true, documentType: 'job', paymentReceivedMs: daysAgo(2) })]);
    expect(out.speak).toBe(false);
    expect(out.swallowed[0].reason).toBe('paid_or_payment_recorded');
  });
});

// ---------- cross-type spine ----------
describe('the spine spans domains — one interrupt across his whole world', () => {
  test('ONE-AT-A-TIME picks the single highest regret across trading + signals', () => {
    const out = evaluate({
      positions: [{ coin: 'ETH', szi: -2, entryPx: 3000, liquidationPx: 3100, markPx: 3018, stop: 3030 }],
      priceHistByCoin: { ETH: [
        { tMs: NOW - 1800000, px: 3010 }, { tMs: NOW - 600000, px: 3014 },
        { tMs: NOW - 120000, px: 3015 }, { tMs: NOW - 60000, px: 3016 }, { tMs: NOW, px: 3018 },
      ] },
      signals: [sig({ id: 'bid1', type: 'trustquote:job-margin', context: 'trustquote:job-margin:455',
        facts: { bidAmount: 95000, jobType: 'rough-in', bidMarginPct: 0.18, historicalMargin: { floorPct: 0.30, sampleCount: 5 }, bidStatus: 'ready-to-send' } })],
      accountValue: 600, nowMs: NOW, glanceAtMs: NOW - 20 * 60000, state: {}, source: 'live',
    });
    expect(out.speak).toBe(true);
    // the job-margin signal (regret ~1.0) outranks the trading cliff (~0.85)
    expect(out.context).toBe('trustquote:job-margin:455');
    const swallowedEth = out.swallowed.find((s) => s.coin === 'ETH');
    expect(swallowedEth.reason).toBe('lower_regret_than_bid1');
  });

  test('empty world stays silent at regret 0', () => {
    const out = run([]);
    expect(out.speak).toBe(false);
    expect(out.regretScore).toBe(0);
  });
});
