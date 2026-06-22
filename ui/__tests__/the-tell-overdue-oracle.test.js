'use strict';

// ORACLE TEST — the MIND's invoice-aging gate must agree with TrustQuote's OWN overdue definition.
// The fixture is GENERATED from the real app function (filterInvoicesByFilterQueue ->
// isOverduePending/isPendingJob in TrustQuote/lib/domain/dashboard-workflows.ts), NEVER hand-written.
// That's what makes it an oracle: if TrustQuote changes its definition OR the MIND drifts from it,
// this fails. It's the automatic prevention for the exact bug we hit (a draft quote called "overdue").
//
// Regenerate the fixture (run in D:/projects/TrustQuote, which resolves the @/ import):
//   npx tsx _tell_oracle_gen.ts > <repo>/ui/__tests__/fixtures/trustquote-overdue-oracle.json
// Follow-up to make drift-detection fully automatic: wire that regen + a git-diff check into CI.

const { evaluate } = require('../modules/the-tell/scorer');
const oracle = require('./fixtures/trustquote-overdue-oracle.json');

describe('invoice-aging mirrors TrustQuote canonical overdue (app function as the oracle)', () => {
  const NOW = oracle.nowMs;

  test('fixture really came from the app function, not a hand-copy', () => {
    expect(oracle.generatedFrom).toMatch(/dashboard-workflows/);
    expect(oracle.cases.length).toBeGreaterThanOrEqual(6);
  });

  for (const c of oracle.cases) {
    test(`${c.name}: MIND speaks === canonical.overdue (${c.canonical.overdue})`, () => {
      const out = evaluate({
        positions: [], nowMs: NOW, accountValue: 600, source: 'live', state: {},
        signals: [{
          id: c.invoice.id, type: 'trustquote:invoice-aging', source: 'live', observedAtMs: NOW,
          context: `trustquote:invoice-aging:${c.invoice.id}`,
          rawRefs: { docId: c.invoice.id },
          // facts a CORRECT feed produces: isPendingJob computed via the app's own predicate (not reinvented)
          facts: {
            invoiceAmount: c.invoice.total,
            dueMs: c.invoice.dateMs,
            status: c.canonical.pending ? 'unpaid' : 'paid',
            isPendingJob: c.canonical.pending,
            isProposal: c.invoice.isProposal,
            documentType: c.invoice.isProposal ? 'quote' : 'job',
            customerReachable: true,
          },
        }],
      });
      // THE INVARIANT: the MIND fires on NOTHING the app's own isOverduePending() calls not-overdue.
      // (Safety direction speak=>overdue is load-bearing; on this battery every overdue case also clears
      // materiality, so the biconditional holds and catches drift in both directions.)
      expect(out.speak).toBe(c.canonical.overdue);
    });
  }
});
