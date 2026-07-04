'use strict';

describe('tell-sensors-v2 — historical margin index (the stub that starved the sensor)', () => {
  const { buildTrustQuoteFactSignalsFromDocs } = require('../modules/main/trustquote-tell-feed');
  // jest cannot load TrustQuote's tsx pricing hooks — inject the seam param
  const pricingModule = {
    calculateBaseTotal: (j) => Number(j.price) * Number(j.quantity || 1),
    calculateServiceTotal: (j) => Number(j.price) * Number(j.quantity || 1),
    calculateGrandTotal: (subtotal, discount) => subtotal - (Number(discount) || 0),
  };
  const paidJob = (id, type, total, marginPct) => ({
    id, collection: 'jobs',
    data: {
      paymentStatus: 'paid', total, jobTypes: [{ type, price: String(total), quantity: 1 }],
      bidMarginPct: marginPct, status: 'completed', updatedAt: Date.now(),
    },
  });

  test('floor computes at n>=3 comparables with leave-one-out; small-n stays silent', () => {
    const docs = [
      paidJob('h1', 'Toilet', 550, 0.42),
      paidJob('h2', 'toilet', 600, 0.38),
      paidJob('h3', 'Toilets', 500, 0.45),
      paidJob('h4', 'toilet', 580, 0.40),
      // the LIVE bid being scored — draft, viewed now
      { id: 'live1', collection: 'jobs', data: { status: 'draft', total: 400, jobTypes: [{ type: 'toilet', price: '400', quantity: 1 }], bidMarginPct: 0.10, lastViewedAt: Date.now(), updatedAt: Date.now() } },
      // a lonely type: only 2 paid sewer jobs -> must stay silent
      paidJob('s1', 'sewer', 14000, 0.5),
      paidJob('s2', 'sewer', 13000, 0.48),
      { id: 'live2', collection: 'jobs', data: { status: 'draft', total: 9000, jobTypes: [{ type: 'sewer', price: '9000', quantity: 1 }], bidMarginPct: 0.1, lastViewedAt: Date.now(), updatedAt: Date.now() } },
    ];
    const signals = buildTrustQuoteFactSignalsFromDocs({ jobs: docs, nowMs: Date.now(), source: 'live', pricingModule });
    const toilet = signals.find((s) => s.rawRefs?.docId === 'live1');
    expect(toilet.facts.historicalMargin.sampleCount).toBe(3); // h1,h2,h4 — WEDGE parity: 'Toilets' (h3) is its own key (no plural folding in the source of truth; gap filed upstream)
    expect(toilet.facts.historicalMargin.floorPct).toBeCloseTo(0.38, 2); // p25 of [.38,.40,.42]
    const sewer = signals.find((s) => s.rawRefs?.docId === 'live2');
    expect(sewer.facts.historicalMargin.sampleCount).toBe(0); // n=2 < 3 -> honest silence
    expect(sewer.facts.historicalMargin.floorPct).toBeNull();
  });

  test('leave-one-out: a transacted doc never grounds its own floor', () => {
    const docs = [
      paidJob('a', 'faucet', 450, 0.5),
      paidJob('b', 'faucet', 460, 0.5),
      paidJob('c', 'faucet', 440, 0.5),
    ];
    const signals = buildTrustQuoteFactSignalsFromDocs({ jobs: docs, nowMs: Date.now(), source: 'live', pricingModule });
    for (const s of signals.filter((x) => x.facts && x.facts.historicalMargin)) {
      expect(s.facts.historicalMargin.sampleCount).toBeLessThanOrEqual(2); // self excluded -> 2 < 3 -> silent
      expect(s.facts.historicalMargin.floorPct).toBeNull();
    }
  });
});

test('price floor computes from prices alone — no cost data needed (his corpus reality)', () => {
  const pricingModule = {
    calculateBaseTotal: (j) => Number(j.price) * Number(j.quantity || 1),
    calculateServiceTotal: (j) => Number(j.price) * Number(j.quantity || 1),
    calculateGrandTotal: (s, d) => s - (Number(d) || 0),
  };
  const paidNoCost = (id, type, total) => ({
    id, collection: 'jobs',
    data: { paymentStatus: 'paid', total, jobTypes: [{ type, price: String(total), quantity: 1 }], status: 'completed', updatedAt: Date.now() },
  });
  const docs = [
    paidNoCost('t1', 'toilet', 500), paidNoCost('t2', 'toilet', 550),
    paidNoCost('t3', 'toilet', 600), paidNoCost('t4', 'toilet', 700),
    { id: 'liveP', collection: 'jobs', data: { status: 'draft', total: 400, jobTypes: [{ type: 'toilet', price: '400', quantity: 1 }], lastViewedAt: Date.now(), updatedAt: Date.now() } },
  ];
  const { buildTrustQuoteFactSignalsFromDocs } = require('../modules/main/trustquote-tell-feed');
  const signals = buildTrustQuoteFactSignalsFromDocs({ jobs: docs, nowMs: Date.now(), source: 'live', pricingModule });
  const live = signals.find((s) => s.rawRefs?.docId === 'liveP');
  const hm = live.facts.historicalMargin;
  expect(hm.priceFloorUsd).toBe(550); // p25 of [500,550,600,700]
  expect(hm.priceSampleCount).toBe(4);
  expect(hm.floorPct).toBeNull(); // no cost data -> margin floor honestly absent
  expect(hm.sampleCount).toBe(0);
});

test('scorer price-mode: floors on price when cost data absent, speaks his numbers, honest mode marker', () => {
  const { scoreSignal } = require('../modules/the-tell/scorer');
  const sig = { id: 'sPM', signalClass: 'trustquote:job-margin', rawRefs: { collection: 'jobs', docId: 'sPM' } };
  const facts = {
    bidAmount: 400, bidPrice: 400, bidCost: null, bidMarginPct: null,
    jobType: 'toilet', bidStatus: 'draft',
    historicalMargin: { floorPct: null, sampleCount: 0, jobIds: ['t1', 't2', 't3', 't4'], priceFloorUsd: 550, priceSampleCount: 4 },
  };
  const scored = scoreSignal ? scoreSignal(sig, facts, Date.now())
    : require('../modules/the-tell/scorer').scoreTrustQuoteJobMargin(sig, facts, Date.now());
  expect(scored.reason === 'insufficient_history_for_floor').toBe(false); // the starvation reason is GONE
  expect(scored.speech.verify.floorMode).toBe('price');
  expect(scored.speech.verify.priceFloorUsd).toBe(550);
  expect(scored.snapshot.underUsd).toBe(150); // 550 floor - 400 bid
  expect(scored.speech.claim).toContain('under what you usually charge');
});
