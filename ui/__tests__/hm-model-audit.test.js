'use strict';

/** hm-model-audit contracts: the router-blindness antidote stays honest. */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  tallyModelsByDay,
  mergeTallies,
  auditDir,
  findOffendingTurns,
  modelMatchesExpected,
  resolveExpectedModelForTranscript,
  createAlertPolicy,
  createStateChangeAlertFilter,
  findOffendingTurnsForTranscript,
  expectedModelsFromSettings,
  buildWatchStatusSnapshot,
  formatAlertMessage,
  servingNow,
  WATCH_MIN_STALE_AFTER_MS,
} = require('../scripts/hm-model-audit');

const line = (ts, model) => JSON.stringify({ timestamp: ts, message: { model } });

describe('hm-model-audit', () => {
  test('tallies serving model per day, skips junk and pre-since days', () => {
    const lines = [
      line('2026-07-02T01:00:00Z', 'claude-fable-5'),
      line('2026-07-02T02:00:00Z', 'claude-fable-5'),
      line('2026-07-02T03:00:00Z', 'claude-opus-4-8'),
      line('2026-06-30T03:00:00Z', 'claude-opus-4-8'), // pre-since, dropped
      JSON.stringify({ timestamp: '2026-07-02T04:00:00Z', message: {} }), // no model
      'not json with "model" in it',
      '',
    ];
    expect(tallyModelsByDay(lines, { since: '2026-07-01' })).toEqual({
      '2026-07-02': { 'claude-fable-5': 2, 'claude-opus-4-8': 1 },
    });
  });

  test('mergeTallies sums across files', () => {
    const a = { '2026-07-02': { 'claude-fable-5': 2 } };
    mergeTallies(a, { '2026-07-02': { 'claude-fable-5': 3, 'claude-opus-4-8': 1 } });
    expect(a['2026-07-02']).toEqual({ 'claude-fable-5': 5, 'claude-opus-4-8': 1 });
  });

  test('auditDir scans a directory of transcripts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-audit-'));
    fs.writeFileSync(path.join(dir, 'a.jsonl'), [
      line('2026-07-02T01:00:00Z', 'claude-fable-5'),
      line('2026-07-03T01:00:00Z', 'claude-fable-5'),
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'b.jsonl'), line('2026-07-03T02:00:00Z', 'claude-opus-4-8'));
    fs.writeFileSync(path.join(dir, 'ignored.txt'), line('2026-07-03T02:00:00Z', 'x'));

    const result = auditDir(dir, { perFile: true });
    expect(result.filesScanned).toBe(2);
    expect(result.byDay).toEqual({
      '2026-07-02': { 'claude-fable-5': 1 },
      '2026-07-03': { 'claude-fable-5': 1, 'claude-opus-4-8': 1 },
    });
    expect(Object.keys(result.byFile).sort()).toEqual(['a.jsonl', 'b.jsonl']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('watch core: flags substitutions, ignores expected + synthetic turns', () => {
    const lines = [
      line('2026-07-04T11:00:00Z', 'claude-fable-5'),     // expected — quiet
      line('2026-07-04T11:01:00Z', '<synthetic>'),        // bookkeeping — quiet
      line('2026-07-04T11:02:00Z', 'claude-opus-4-8'),    // ALERT
      'garbage "model" line',
    ];
    expect(findOffendingTurns(lines, 'claude-fable-5')).toEqual([
      { model: 'claude-opus-4-8', timestamp: '2026-07-04T11:02:00Z' },
    ]);
  });

  test('watch core: compact settings model matches full served model family', () => {
    expect(modelMatchesExpected('claude-opus-4-8', 'opus')).toBe(true);
    expect(modelMatchesExpected('claude-sonnet-4-6', 'sonnet')).toBe(true);
    expect(modelMatchesExpected('claude-fable-5', 'fable')).toBe(true);
    expect(modelMatchesExpected('claude-opus-4-8', 'claude-fable-5')).toBe(false);
  });

  test('settings expectation maps transcript session to owning pane command first', () => {
    const settings = {
      claudeModel: 'opus',
      paneCommands: {
        '1': 'claude --model claude-fable-5',
        '2': 'codex',
      },
    };
    const paneSessionIds = {
      panes: {
        '1': 'session-for-architect',
        '2': 'session-for-builder',
      },
    };

    expect(resolveExpectedModelForTranscript('session-for-architect.jsonl', { settings, paneSessionIds }))
      .toEqual({
        expectedModel: 'claude-fable-5',
        paneId: '1',
        source: 'pane-command',
      });
    expect(resolveExpectedModelForTranscript('session-for-builder.jsonl', { settings, paneSessionIds }).expectedModel)
      .toBe('');
  });

  test('settings expectation falls back to global claudeModel for generic Claude pane command', () => {
    const settings = {
      claudeModel: 'opus',
      paneCommands: {
        '1': 'claude',
      },
    };
    const paneSessionIds = { panes: { '1': 'session-for-architect' } };

    expect(resolveExpectedModelForTranscript('session-for-architect.jsonl', { settings, paneSessionIds }))
      .toEqual({
        expectedModel: 'opus',
        paneId: '1',
        source: 'settings-claudeModel',
      });
  });

  test('watch status expectation summary is derived from current Claude pane settings', () => {
    expect(expectedModelsFromSettings({
      claudeModel: 'claude-fable-5',
      paneCommands: {
        '1': 'claude --model claude-fable-5',
        '2': 'codex',
        '3': 'claude',
      },
    })).toEqual([
      { paneId: '1', expectedModel: 'claude-fable-5', source: 'pane-command' },
      { paneId: '3', expectedModel: 'claude-fable-5', source: 'settings-claudeModel' },
    ]);
  });

  test('settings-derived gate: opus setting makes opus transcript silent and fable transcript alarm', () => {
    const context = {
      settings: {
        paneCommands: { '1': 'claude --model opus' },
      },
      paneSessionIds: { panes: { '1': 'architect-session' } },
    };

    expect(findOffendingTurnsForTranscript(
      'architect-session.jsonl',
      [line('2026-07-04T11:00:00Z', 'claude-opus-4-8')],
      context
    )).toEqual([]);
    expect(findOffendingTurnsForTranscript(
      'architect-session.jsonl',
      [line('2026-07-04T11:01:00Z', 'claude-fable-5')],
      context
    )).toEqual([
      {
        file: 'architect-session.jsonl',
        model: 'claude-fable-5',
        timestamp: '2026-07-04T11:01:00Z',
        expectedModel: 'opus',
        paneId: '1',
        source: 'pane-command',
      },
    ]);
  });

  test('settings-derived gate follows an opus to fable flip without restart state', () => {
    const paneSessionIds = { panes: { '1': 'architect-session' } };
    const opusSettings = { paneCommands: { '1': 'claude --model opus' } };
    const fableSettings = { paneCommands: { '1': 'claude --model claude-fable-5' } };
    const opusTurn = [line('2026-07-04T11:02:00Z', 'claude-opus-4-8')];

    expect(findOffendingTurnsForTranscript(
      'architect-session.jsonl',
      opusTurn,
      { settings: opusSettings, paneSessionIds }
    )).toEqual([]);
    expect(findOffendingTurnsForTranscript(
      'architect-session.jsonl',
      opusTurn,
      { settings: fableSettings, paneSessionIds }
    )).toEqual([
      {
        file: 'architect-session.jsonl',
        model: 'claude-opus-4-8',
        timestamp: '2026-07-04T11:02:00Z',
        expectedModel: 'claude-fable-5',
        paneId: '1',
        source: 'pane-command',
      },
    ]);
  });

  test('watch alert filter emits once per substitution state change', () => {
    const shouldAlert = createStateChangeAlertFilter();
    const first = { file: 'a.jsonl', expectedModel: 'opus', model: 'claude-fable-5' };
    const repeat = { file: 'a.jsonl', expectedModel: 'opus', model: 'claude-fable-5' };
    const changed = { file: 'a.jsonl', expectedModel: 'opus', model: 'claude-sonnet-4-6' };
    const ok = { file: 'a.jsonl', expectedModel: 'opus', model: 'claude-opus-4-8' };

    expect(shouldAlert(first)).toBe(true);
    expect(shouldAlert(repeat)).toBe(false);
    expect(shouldAlert(changed)).toBe(true);
    expect(shouldAlert(ok)).toBe(false);
    expect(shouldAlert(first)).toBe(true);
  });

  test('watch self-status rejects stale running:true heartbeat even when pid is alive', () => {
    const nowMs = Date.parse('2026-07-06T12:30:00.000Z');
    const staleHeartbeatMs = nowMs - WATCH_MIN_STALE_AFTER_MS - 1000;

    const status = buildWatchStatusSnapshot({
      pid: process.pid,
      pidAlive: true,
      pidMtimeMs: nowMs - 60 * 1000,
      statusFile: {
        pid: process.pid,
        running: true,
        heartbeatAtMs: staleHeartbeatMs,
        intervalMs: 1000,
        expectedModels: [{ paneId: '1', expectedModel: 'claude-fable-5', source: 'pane-command' }],
      },
      nowMs,
    });

    expect(status).toEqual(expect.objectContaining({
      running: false,
      staleHeartbeat: true,
      statusFresh: false,
      reason: 'stale_model_audit_watch_status',
      pid: process.pid,
    }));
    expect(status.statusAgeMs).toBe(WATCH_MIN_STALE_AFTER_MS + 1000);
  });

  test('watch self-status treats missing heartbeat as not running, not mtime-fresh', () => {
    const nowMs = Date.parse('2026-07-06T12:30:00.000Z');

    const status = buildWatchStatusSnapshot({
      pid: process.pid,
      pidAlive: true,
      pidMtimeMs: nowMs - 60 * 1000,
      statusFile: {
        pid: process.pid,
        running: true,
        intervalMs: 1000,
      },
      statusMtimeMs: nowMs,
      nowMs,
    });

    expect(status).toEqual(expect.objectContaining({
      running: false,
      staleHeartbeat: true,
      statusFresh: false,
      statusAgeMs: null,
      reason: 'stale_model_audit_watch_status',
    }));
  });

  describe('createAlertPolicy (2026-07-06 lesson: two 5am pings, then 11 silent Opus hours)', () => {
    const offendingTurn = (ts) => ({
      file: 'arch.jsonl',
      model: 'claude-opus-4-8',
      timestamp: ts,
      expectedModel: 'claude-fable-5',
    });
    const expectedTurn = { file: 'arch.jsonl', model: 'claude-fable-5', expectedModel: 'claude-fable-5' };

    test('renags on a persisting substitution once per realert window', () => {
      const policy = createAlertPolicy({ realertMs: 60000 });

      expect(policy(offendingTurn('t0'), 0)).toEqual(expect.objectContaining({
        kind: 'substitution', offendingSince: 't0', offendingTurns: 1,
      }));
      expect(policy(offendingTurn('t1'), 30000)).toBeNull();
      expect(policy(offendingTurn('t2'), 60000)).toEqual(expect.objectContaining({
        kind: 'still-offending', offendingSince: 't0', offendingTurns: 3,
      }));
      expect(policy(offendingTurn('t3'), 90000)).toBeNull();
      expect(policy(offendingTurn('t4'), 125000)).toEqual(expect.objectContaining({
        kind: 'still-offending', offendingTurns: 5,
      }));
    });

    test('emits recovery with run accounting, then a fresh substitution on re-offend', () => {
      const policy = createAlertPolicy({ realertMs: 60000 });
      policy(offendingTurn('t0'), 0);
      policy(offendingTurn('t1'), 1000);

      expect(policy(expectedTurn, 2000)).toEqual(expect.objectContaining({
        kind: 'recovered', offendingSince: 't0', offendingTurns: 2,
      }));
      expect(policy(expectedTurn, 3000)).toBeNull();
      expect(policy(offendingTurn('t5'), 4000)).toEqual(expect.objectContaining({
        kind: 'substitution', offendingSince: 't5', offendingTurns: 1,
      }));
    });
  });

  test('servingNow reports the last served model per mapped Claude pane', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-serving-'));
    fs.writeFileSync(path.join(dir, 'sess-arch.jsonl'), [
      line('2026-07-06T10:00:00Z', 'claude-fable-5'),
      line('2026-07-06T12:29:45Z', 'claude-opus-4-8'),
      JSON.stringify({ timestamp: '2026-07-06T12:30:00Z', message: { model: '<synthetic>' } }),
      'trailing junk with "model"',
    ].join('\n'));

    const rows = servingNow({
      dir,
      settings: {
        paneCommands: {
          '1': 'claude --model claude-fable-5',
          '2': 'codex',
          '3': 'claude --model claude-fable-5',
        },
      },
      paneSessionIds: { panes: { '1': 'sess-arch', '2': 'sess-builder', '3': 'sess-oracle' } },
    });

    expect(rows).toEqual([
      {
        paneId: '1',
        sessionId: 'sess-arch',
        expectedModel: 'claude-fable-5',
        servedModel: 'claude-opus-4-8',
        servedAt: '2026-07-06T12:29:45Z',
        ok: false,
      },
      {
        paneId: '3',
        sessionId: 'sess-oracle',
        expectedModel: 'claude-fable-5',
        servedModel: null,
        servedAt: null,
        ok: null,
      },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('alert messages carry persistence accounting', () => {
    expect(formatAlertMessage({
      kind: 'still-offending',
      file: 'a.jsonl',
      model: 'claude-opus-4-8',
      expectedModel: 'claude-fable-5',
      offendingSince: '2026-07-06T12:29:45Z',
      offendingTurns: 675,
    }, { paneId: '3' })).toContain(
      'ONGOING: a.jsonl pane 3 still serving claude-opus-4-8 since 2026-07-06T12:29:45Z (675 offending turns'
    );
    expect(formatAlertMessage({
      kind: 'recovered',
      file: 'a.jsonl',
      model: 'claude-fable-5',
      expectedModel: 'claude-fable-5',
      offendingSince: '2026-07-06T12:29:45Z',
      offendingTurns: 675,
    }, { paneId: '3' })).toContain('MODEL RECOVERED: a.jsonl pane 3 back on claude-fable-5');
  });
});
