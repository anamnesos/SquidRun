'use strict';

/**
 * hm-verdict CLI contracts (S468) — the verdict ledger's first production
 * consumer. The full lifecycle must work through the CLI surface: verdicts
 * transition, immutability holds, credibility learns from resolutions.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runVerdictCommand } = require('../scripts/hm-verdict');

describe('hm-verdict lifecycle through the CLI seam', () => {
  let dir;
  let storePath;
  const at = (iso) => ({ nowIso: iso });
  // --backfill to a void path: without it a fresh store seeds the REAL s465
  // backfill (20 records) into the fixture — the exact leak that failed the
  // first run of this suite.
  const run = (args, opts) => runVerdictCommand(
    [...args, '--store', storePath, '--backfill', path.join(dir, 'no-backfill.json')], opts,
  );

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-verdict-'));
    storePath = path.join(dir, 'verdict-ledger.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('add -> list -> resolve -> standing: credibility learns from outcomes', () => {
    for (let i = 0; i < 5; i += 1) {
      run(['add', '--issuer', 'architect', '--kind', 'claim',
        '--statement', `claim number ${i}`, '--evidence', 'fixture'],
      at(`2026-07-04T0${i}:00:00.000Z`));
    }
    const open = run(['list', '--status', 'open']);
    expect(open.count).toBe(5);

    for (const { id } of open.records) {
      run(['resolve', id, '--status', 'held', '--resolver', 'oracle', '--note', 'verified'],
        at('2026-07-04T06:00:00.000Z'));
    }
    const { standings } = run(['standing', '--issuer', 'architect']);
    expect(standings[0]).toMatchObject({ status: 'scored', resolved: 5, accuracy: 1 });
  });

  test('small-n floor holds through the CLI: 4 resolutions = insufficient', () => {
    for (let i = 0; i < 4; i += 1) {
      const { added } = run(['add', '--issuer', 'builder', '--kind', 'verify',
        '--statement', `s${i}`, '--evidence', 'e'], at('2026-07-04T01:00:00.000Z'));
      run(['resolve', added, '--status', 'held', '--resolver', 'oracle', '--note', 'ok'],
        at('2026-07-04T02:00:00.000Z'));
    }
    const { standings } = run(['standing', '--issuer', 'builder']);
    expect(standings[0]).toMatchObject({ status: 'insufficient', accuracy: null });
  });

  test('resolution immutability surfaces as a CLI error, supersede is the path', () => {
    const { added } = run(['add', '--issuer', 'oracle', '--kind', 'gate',
      '--statement', 'gate held', '--evidence', 'run 1'], at('2026-07-04T01:00:00.000Z'));
    run(['resolve', added, '--status', 'failed', '--resolver', 'architect', '--note', 'regressed'],
      at('2026-07-04T02:00:00.000Z'));
    expect(() => run(
      ['resolve', added, '--status', 'held', '--resolver', 'architect', '--note', 'rewrite'],
      at('2026-07-04T03:00:00.000Z'),
    )).toThrow(/immutable/);

    const { superseded, by } = run(['supersede', added, '--issuer', 'oracle', '--kind', 'gate',
      '--statement', 'gate held after fix', '--evidence', 'run 2'], at('2026-07-04T04:00:00.000Z'));
    expect(superseded).toBe(added);
    const all = run(['list']);
    const oldRow = all.records.find((r) => r.id === added);
    const newRow = all.records.find((r) => r.id === by);
    expect(oldRow.status).toBe('superseded');
    expect(newRow.status).toBe('open');
  });

  test('sweep expires only past-window open verdicts', () => {
    run(['add', '--issuer', 'architect', '--kind', 'claim', '--statement', 'expiring',
      '--evidence', 'e', '--expires-at', '2026-07-04T02:00:00.000Z'], at('2026-07-04T01:00:00.000Z'));
    run(['add', '--issuer', 'architect', '--kind', 'claim', '--statement', 'not expiring',
      '--evidence', 'e'], at('2026-07-04T01:00:00.000Z'));
    const { swept } = run(['sweep'], at('2026-07-04T03:00:00.000Z'));
    expect(swept).toBe(1);
    expect(run(['list', '--status', 'expired']).count).toBe(1);
    expect(run(['list', '--status', 'open']).count).toBe(1);
  });

  test('unknown id and unsourced add fail loud, store untouched', () => {
    expect(() => run(['resolve', 'v-nope', '--status', 'held', '--resolver', 'x', '--note', 'n']))
      .toThrow(/no verdict/);
    expect(() => run(['add', '--issuer', 'architect', '--kind', 'claim', '--statement', 's']))
      .toThrow(/evidence/);
    expect(fs.existsSync(storePath)).toBe(false);
  });
});
