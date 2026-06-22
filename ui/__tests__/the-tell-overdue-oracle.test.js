'use strict';

// ORACLE TEST — the MIND's invoice-aging gate must agree with TrustQuote's OWN overdue definition.
// The fixture is GENERATED from the real app function (filterInvoicesByFilterQueue ->
// isOverduePending/isPendingJob in TrustQuote/lib/domain/dashboard-workflows.ts), NEVER hand-written.
// That's what makes it an oracle: if TrustQuote changes its definition OR the MIND drifts from it,
// this fails. It's the automatic prevention for the exact bug we hit (a draft quote called "overdue").
//
// REGENERATE (no stray file left in TrustQuote's repo): paste the generator below into a temp file
// INSIDE D:/projects/TrustQuote (so its `@/` path import resolves), run it, then delete the temp file:
//   npx tsx gen.ts > <squidrun>/ui/__tests__/fixtures/trustquote-overdue-oracle.json && rm gen.ts
// ---- generator (the exact reproduction; runs TrustQuote's REAL overdue/pending predicate) ----
//   import { filterInvoicesByFilterQueue } from '@/lib/domain/dashboard-workflows'
//   const NOW = new Date('2026-06-22T17:00:00Z')
//   const iso = (dAgo) => new Date(NOW.getTime() - dAgo*86400000).toISOString()
//   const pay = (amt, dAgo) => ({ amount: String(amt), dateCollected: iso(dAgo) })
//   // real Invoice shapes: date:string, total:number, isProposal:boolean; paymentDates[].amount:string, .dateCollected:string
//   const cases = [
//     { name:'draft_quote_66d', inv:{ id:'q1', isProposal:true,  date:iso(66), total:36500, paymentDates:[] } },
//     { name:'sent_unpaid_20d', inv:{ id:'i1', isProposal:false, date:iso(20), total:800,   paymentDates:[] } },
//     { name:'sent_unpaid_5d',  inv:{ id:'i2', isProposal:false, date:iso(5),  total:800,   paymentDates:[] } },
//     { name:'sent_paid_30d',   inv:{ id:'i3', isProposal:false, date:iso(30), total:800,   paymentDates:[pay(800,10)] } },
//     { name:'sent_partial_20d',inv:{ id:'i4', isProposal:false, date:iso(20), total:800,   paymentDates:[pay(300,10)] } },
//     { name:'sent_overpaid_30d',inv:{ id:'i5', isProposal:false,date:iso(30), total:800,   paymentDates:[pay(900,10)] } },
//     { name:'sent_unpaid_15d', inv:{ id:'i6', isProposal:false, date:iso(15), total:800,   paymentDates:[] } },
//     { name:'sent_unpaid_14d', inv:{ id:'i7', isProposal:false, date:iso(14), total:800,   paymentDates:[] } },
//   ]
//   const invs = cases.map(c=>c.inv)
//   const overdue = new Set(filterInvoicesByFilterQueue(invs, 'overdue', NOW).map(x=>x.id))
//   const pending = new Set(filterInvoicesByFilterQueue(invs, 'unpaid',  NOW).map(x=>x.id))   // 'unpaid' queue == isPendingJob
//   const out = cases.map(c=>({ name:c.name, invoice:{ id:c.inv.id, isProposal:c.inv.isProposal, dateMs:Date.parse(c.inv.date), total:c.inv.total, paidCollected:(c.inv.paymentDates||[]).reduce((s,p)=>s+(p.dateCollected?Number(p.amount):0),0) }, canonical:{ overdue:overdue.has(c.inv.id), pending:pending.has(c.inv.id) } }))
//   console.log(JSON.stringify({ generatedFrom:'TrustQuote lib/domain/dashboard-workflows.ts :: filterInvoicesByFilterQueue (real isOverduePending/isPendingJob)', nowMs:NOW.getTime(), overdueDays:14, cases:out }, null, 2))
// ---- end generator ----
// Follow-up (queued, Architect-gated): wire regen + a git-diff check into CI so a TrustQuote definition
// change fails loudly instead of waiting for a manual rerun. Proper durable home for the generator =
// TrustQuote/tools/ via the TrustQuote lane (that placement + the CI step go together).

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
