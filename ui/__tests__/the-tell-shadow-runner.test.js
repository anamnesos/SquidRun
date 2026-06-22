const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizeIntervalMs,
  runShadowTick,
  verifyRefsForSignal,
  MIN_INTERVAL_MS,
} = require('../modules/main/the-tell-shadow-runner');
const { evaluatePromotionGate } = require('../modules/the-tell/promotion-gate');

describe('the tell shadow runner', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-tell-shadow-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('writes spoke rows with verify refs, review verdict slot, claim, and regret score', async () => {
    const ledgerPath = path.join(tempDir, 'shadow.json');
    const statusPath = path.join(tempDir, 'status.json');
    const nowMs = Date.parse('2026-06-22T19:00:00.000Z');
    const signal = {
      type: 'trustquote:invoice-aging',
      id: 'jobs:invoice-1:invoice-aging',
      source: 'live',
      observedAtMs: nowMs,
      rawRefs: {
        system: 'trustquote',
        collection: 'jobs',
        docId: 'invoice-1',
        businessId: 'biz-1',
        customerId: 'cust-1',
      },
      facts: {
        invoiceAmount: 36500,
        balanceDue: 36500,
        dueMs: nowMs - 20 * 86400000,
        isPendingJob: true,
        status: 'unpaid',
      },
    };

    const result = await runShadowTick({
      nowMs,
      runId: 'shadow-test',
      tickId: 'tick-1',
      ledgerPath,
      statusPath,
      fetchTrustQuoteReadOnlySignals: jest.fn(async () => ({
        ok: true,
        source: 'live',
        checkedAt: new Date(nowMs).toISOString(),
        data: {
          counts: { jobs: 1, quotes: 0 },
          eventCount: 0,
          parkedCount: 0,
          signals: [signal],
        },
      })),
      evaluate: jest.fn(() => ({
        source: 'live',
        regretScore: 0.91,
        context: 'trustquote:invoice-aging',
        speak: true,
        claim: 'Invoice is overdue.',
        whyNow: 'It is 20 days overdue.',
        receipts: [{ label: 'Amount', value: '$36500', source: 'TrustQuote' }],
        verify: { invoiceDocId: 'invoice-1', amount: 36500, dueMs: signal.facts.dueMs },
        proposedAction: { text: 'Draft reminder', reversible: true, executionMode: 'dry-run' },
        _winner: { kind: 'signal', key: signal.id, type: signal.type, _sig: signal },
        swallowed: [],
      })),
    });

    expect(result.rows).toHaveLength(2);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    expect(ledger.shadowStartedAtMs).toBe(nowMs);
    const spoke = ledger.rows.find((row) => row.type === 'spoke');
    expect(spoke).toEqual(expect.objectContaining({
      ts: nowMs,
      type: 'spoke',
      signalClass: 'trustquote:invoice-aging',
      key: 'jobs:invoice-1:invoice-aging',
      claim: 'Invoice is overdue.',
      regretScore: 0.91,
      review: { verdict: 'pending', by: null, at: null },
      dryRun: true,
      readOnly: true,
    }));
    expect(spoke.verify.firestore).toEqual([expect.objectContaining({
      collection: 'jobs',
      docId: 'invoice-1',
      path: 'jobs/invoice-1',
    })]);
    expect(spoke.verify.numbers).toEqual(expect.objectContaining({
      invoiceAmount: 36500,
      balanceDue: 36500,
      dueMs: signal.facts.dueMs,
    }));
    expect(JSON.parse(fs.readFileSync(statusPath, 'utf8')).lastTick.counts.spokeRows).toBe(1);
    const gate = evaluatePromotionGate(ledger, { nowMs: nowMs + 6 * 86400000 });
    expect(gate.perClass['trustquote:invoice-aging'].blockers).toContain('1_unreviewed_spoke_rows');
  });

  test('writes swallowed rows with structured reasons and signal refs', async () => {
    const ledgerPath = path.join(tempDir, 'shadow.json');
    const signal = {
      type: 'trustquote:job-margin',
      id: 'quotes:quote-1:job-margin',
      source: 'live',
      observedAtMs: Date.parse('2026-06-22T19:00:00.000Z'),
      rawRefs: { system: 'trustquote', collection: 'quotes', docId: 'quote-1', businessId: 'biz-1' },
      facts: {
        bidAmount: 1000,
        bidPrice: 1000,
        historicalMargin: { floorPct: null, sampleCount: 0, jobIds: [] },
      },
    };

    await runShadowTick({
      nowMs: signal.observedAtMs,
      ledgerPath,
      statusPath: path.join(tempDir, 'status.json'),
      fetchTrustQuoteReadOnlySignals: jest.fn(async () => ({
        ok: true,
        source: 'live',
        data: { counts: { jobs: 0, quotes: 1 }, eventCount: 0, parkedCount: 0, signals: [signal] },
      })),
      evaluate: jest.fn(() => ({
        source: 'live',
        regretScore: 0,
        context: 'trustquote:job-margin',
        speak: false,
        swallowed: [{
          type: 'swallowed',
          key: signal.id,
          signal: signal.type,
          reason: 'insufficient_history_for_floor',
          regretScore: 0,
          snapshot: { bidAmount: 1000 },
          wouldHaveSaid: null,
        }],
      })),
    });

    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const swallowed = ledger.rows.find((row) => row.type === 'swallowed');
    expect(swallowed).toEqual(expect.objectContaining({
      type: 'swallowed',
      signalClass: 'trustquote:job-margin',
      key: 'quotes:quote-1:job-margin',
      reason: 'insufficient_history_for_floor',
      regretScore: 0,
      dryRun: true,
      readOnly: true,
    }));
    expect(swallowed.verify.firestore).toEqual([expect.objectContaining({
      collection: 'quotes',
      docId: 'quote-1',
    })]);
  });

  test('normalizes intervals to avoid hammering Firestore', () => {
    expect(normalizeIntervalMs(1000)).toBe(MIN_INTERVAL_MS);
  });

  test('extracts verify refs from TrustQuote rawRefs and numbers', () => {
    const refs = verifyRefsForSignal({
      rawRefs: { system: 'trustquote', collection: 'jobs', docId: 'job-1', businessId: 'biz' },
      facts: { jobValue: 75, tasksTotal: 2, tasksIncomplete: 1 },
    }, {});
    expect(refs.firestore[0].path).toBe('jobs/job-1');
    expect(refs.numbers).toEqual(expect.objectContaining({
      jobValue: 75,
      tasksTotal: 2,
      tasksIncomplete: 1,
    }));
  });
});
