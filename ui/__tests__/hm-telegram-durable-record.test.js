/**
 * The pre-send `recorded` row, for the one path whose replay logic depends on it.
 *
 * hm-telegram writes that row BEFORE the HTTP call and, historically, only
 * warned if the write failed. For an ordinary send that is fine. For the Mira
 * ingress-reply path it is not: if the row is missing and the process dies
 * during the call, the drain's replay lookup finds no evidence at all,
 * concludes nothing was delivered, and sends James the same reply a second
 * time. The row is what makes that crash window ambiguous — and ambiguity
 * holds, which is the whole point.
 */
const path = require('path');

const MODULE_PATH = path.join(__dirname, '..', 'scripts', 'hm-telegram.js');

describe('hm-telegram durable pre-send record', () => {
  test('requireDurableJournal is opt-in, so ordinary sends are unaffected', () => {
    // A blanket change here would alter every unrelated send in the app.
    const src = require('fs').readFileSync(MODULE_PATH, 'utf8');
    expect(src).toContain('opts.requireDurableJournal === true');
    // The non-strict branch must still exist and still just warn.
    expect(src).toContain('upsertTelegramJournal(recordEntry);');
  });

  test('the strict helper reports failure instead of proceeding to send', () => {
    const src = require('fs').readFileSync(MODULE_PATH, 'utf8');
    const start = src.indexOf('function requireTelegramJournalRecord');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toContain("error: 'durable_journal_unavailable'");
    expect(body).toContain("result?.ok !== true");
  });

  test('the strict path returns BEFORE any send when the record cannot be written', () => {
    // Ordering is the whole guarantee: a return after the send would prove
    // nothing. The early return must sit between the record attempt and the
    // send, so scan the region between them.
    const src = require('fs').readFileSync(MODULE_PATH, 'utf8');
    const strictStart = src.indexOf('if (opts.requireDurableJournal === true) {');
    expect(strictStart).toBeGreaterThan(-1);
    const region = src.slice(strictStart, strictStart + 700);
    expect(region).toContain('const recorded = requireTelegramJournalRecord(recordEntry);');
    expect(region).toContain('if (!recorded.ok) {');
    expect(region).toContain('error: recorded.error');
    // No send may appear inside the guard region.
    expect(region).not.toContain('sendTelegramApi');
    expect(region).not.toContain('await fetch');
  });
});
