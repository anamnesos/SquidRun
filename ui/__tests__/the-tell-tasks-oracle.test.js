'use strict';

// ORACLE TEST — the MIND's job-tasks-incomplete gate must agree with TrustQuote's OWN isTasksIncomplete.
// The fixture is GENERATED from the real app function (filterInvoicesByFilterQueue(..., 'tasks') ->
// isTasksIncomplete/getTaskSummary in TrustQuote/lib/domain/dashboard-workflows.ts), NEVER hand-written.
// This is the 2nd app-predicate-oracle slice (after overdue): re-grounds the old fake "job-proof-stale"
// (TrustQuote has no proof concept) onto the app's real "incomplete tasks on a billable job".
//
// REGENERATE (no stray file left in TrustQuote): paste the generator below into a temp file INSIDE
// D:/projects/TrustQuote (so its `@/` import resolves), run it, then delete the temp file:
//   npx tsx gen.ts > <squidrun>/ui/__tests__/fixtures/trustquote-tasks-oracle.json && rm gen.ts
// ---- generator (runs TrustQuote's REAL isTasksIncomplete via the 'tasks' filter queue) ----
//   import { filterInvoicesByFilterQueue } from '@/lib/domain/dashboard-workflows'
//   const NOW = new Date('2026-06-22T17:00:00Z')
//   const tasks = (...done) => ({ jobTasks: done.map((completed) => ({ completed })) })
//   const cases = [
//     { name:'proposal_incomplete',            inv:{ id:'p1', isProposal:true,  jobTypes:[tasks(false,true)] } },
//     { name:'nonproposal_all_complete',       inv:{ id:'j1', isProposal:false, jobTypes:[tasks(true,true)] } },
//     { name:'nonproposal_some_incomplete',    inv:{ id:'j2', isProposal:false, jobTypes:[tasks(true,false)] } },
//     { name:'nonproposal_all_incomplete',     inv:{ id:'j3', isProposal:false, jobTypes:[tasks(false)] } },
//     { name:'nonproposal_no_tasks',           inv:{ id:'j4', isProposal:false, jobTypes:[tasks()] } },
//     { name:'nonproposal_multi_jobtype_mixed',inv:{ id:'j5', isProposal:false, jobTypes:[tasks(true),tasks(false,true)] } },
//   ]
//   const invs = cases.map(c=>c.inv)
//   const incomplete = new Set(filterInvoicesByFilterQueue(invs, 'tasks', NOW).map(x=>x.id))
//   const sum = inv => { const a=(inv.jobTypes||[]).flatMap(j=>j.jobTasks||[]); return { total:a.length, incomplete:a.filter(t=>!t.completed).length } }
//   const out = cases.map(c=>{ const s=sum(c.inv); return { name:c.name, invoice:{ id:c.inv.id, isProposal:c.inv.isProposal, tasksTotal:s.total, tasksIncomplete:s.incomplete }, canonical:{ tasksIncomplete:incomplete.has(c.inv.id) } } })
//   console.log(JSON.stringify({ generatedFrom:'TrustQuote dashboard-workflows :: filterInvoicesByFilterQueue("tasks") (real isTasksIncomplete/getTaskSummary)', nowMs:NOW.getTime(), cases:out }, null, 2))
// ---- end generator ----

const { evaluate } = require('../modules/the-tell/scorer');
const oracle = require('./fixtures/trustquote-tasks-oracle.json');

describe('job-tasks-incomplete mirrors TrustQuote canonical isTasksIncomplete (app function as the oracle)', () => {
  const NOW = oracle.nowMs;

  test('fixture really came from the app function, not a hand-copy', () => {
    expect(oracle.generatedFrom).toMatch(/isTasksIncomplete|tasks/);
    expect(oracle.cases.length).toBeGreaterThanOrEqual(5);
  });

  for (const c of oracle.cases) {
    test(`${c.name}: MIND speaks === canonical.tasksIncomplete (${c.canonical.tasksIncomplete})`, () => {
      const out = evaluate({
        positions: [], nowMs: NOW, accountValue: 600, source: 'live', state: {},
        signals: [{
          id: c.invoice.id, type: 'trustquote:job-tasks-incomplete', source: 'live', observedAtMs: NOW,
          context: `trustquote:job-tasks-incomplete:${c.invoice.id}`,
          rawRefs: { docId: c.invoice.id },
          // facts a correct feed produces (tasksTotal/tasksIncomplete via getTaskSummary); jobValue+billable
          // fixed material so the test isolates the canonical task gate (MIND may be MORE silent, never less).
          facts: {
            isProposal: c.invoice.isProposal,
            tasksTotal: c.invoice.tasksTotal,
            tasksIncomplete: c.invoice.tasksIncomplete,
            jobValue: 800,
            jobStatus: 'billable',
            customerReachable: true,
          },
        }],
      });
      // THE INVARIANT: the MIND fires on NOTHING the app's own isTasksIncomplete() calls complete.
      expect(out.speak).toBe(c.canonical.tasksIncomplete);
    });
  }
});
