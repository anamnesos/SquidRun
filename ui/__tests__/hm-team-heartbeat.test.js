'use strict';

const fs = require('fs');
const path = require('path');
const {
  APP_UNAVAILABLE_EXIT_CODE,
  DEFAULT_CONFIG,
  MAX_DAILY_BEATS,
  TARGETS,
  buildPrompt,
  deriveBeatId,
  exitCodeForStatus,
  priorDeliveredTargets,
  proofRowsForBeat,
  selectFocus,
  validateConfig,
} = require('../scripts/hm-team-heartbeat');

function config(overrides = {}) {
  return JSON.parse(JSON.stringify({ ...DEFAULT_CONFIG, ...overrides }));
}

describe('team heartbeat config contract', () => {
  test('ships the exact two durable windows and seven non-trading seed focuses', () => {
    const value = validateConfig(config());
    expect(value.cadence).toEqual([
      { id: 'am', time: '08:23' },
      { id: 'pm', time: '18:23' },
    ]);
    expect(value.focusRotation.map((entry) => entry.id)).toEqual([
      'james-schedule',
      'open-threads-sweep',
      'site-booking-health',
      'trustquote-drift',
      'memory-rule-hygiene',
      'propose-one-improvement',
      'one-good-question',
    ]);
  });

  test('cannot silently disable or reduce cadence below two beats', () => {
    expect(() => validateConfig(config({ enabled: false }))).toThrow(/cannot disable/i);
    expect(() => validateConfig(config({ cadence: [{ id: 'am', time: '08:23' }] }))).toThrow(/at least 2/i);
    expect(() => validateConfig(config({ minimumDailyBeats: 1 }))).toThrow(/cannot be below 2/i);
  });

  test('bounds daily frequency and rejects duplicate windows', () => {
    const tooMany = Array.from({ length: MAX_DAILY_BEATS + 1 }, (_, index) => ({
      id: `beat-${index}`,
      time: `${String(index).padStart(2, '0')}:00`,
    }));
    expect(() => validateConfig(config({ cadence: tooMany }))).toThrow(/at most/i);
    expect(() => validateConfig(config({ cadence: [
      { id: 'am', time: '08:23' },
      { id: 'again', time: '08:23' },
    ] }))).toThrow(/duplicate cadence time/i);
    expect(() => validateConfig(config({ cadence: [
      { id: 'am', time: '08:23' },
      { id: 'burst', time: '08:59' },
    ] }))).toThrow(/60 minutes of circular spacing/i);
    expect(() => validateConfig(config({ cadence: [
      { id: 'late', time: '23:40' },
      { id: 'early', time: '00:20' },
    ] }))).toThrow(/60 minutes of circular spacing/i);
  });

  test.each([
    'trading scan', 'market scan', 'portfolio health', 'crypto watch', 'open positions',
    'ticker review', 'Hyperliquid status', 'Alpaca account', 'futures options',
  ])(
    'rejects parked focus: %s',
    (instruction) => {
      expect(() => validateConfig(config({
        focusRotation: [{ id: 'bad-focus', instruction }],
      }))).toThrow(/parked trading\/market lane/i);
    }
  );
});

describe('team heartbeat identity, prompt, and rotation', () => {
  test('uses deterministic date plus window identity and preserves a late-night PM catch-up', () => {
    const value = validateConfig(config());
    expect(deriveBeatId(new Date(2026, 7, 19, 16, 0), 'am', value)).toBe('team-heartbeat-2026-08-19-am');
    expect(deriveBeatId(new Date(2026, 7, 20, 2, 0), 'pm', value)).toBe('team-heartbeat-2026-08-19-pm');
  });

  test('keeps focus stable across retries and rotates only after a delivered beat', () => {
    const value = validateConfig(config());
    const first = selectFocus(value, [], 'beat-one');
    expect(first.focusIndex).toBe(0);
    const retry = selectFocus(value, [{
      event: 'heartbeat_attempt', status: 'app_unavailable', beatId: 'beat-one',
      focus: first.focus, focusIndex: first.focusIndex,
    }], 'beat-one');
    expect(retry).toEqual(first);
    const next = selectFocus(value, [{
      event: 'heartbeat_attempt', status: 'delivered', beatId: 'beat-one',
      focus: first.focus, focusIndex: first.focusIndex, deliveredTo: [...TARGETS],
    }], 'beat-two');
    expect(next.focusIndex).toBe(1);
    const afterDedupe = selectFocus(value, [{
      event: 'heartbeat_attempt', status: 'deduped', beatId: 'beat-one',
      focus: first.focus, focusIndex: first.focusIndex, deliveredTo: [...TARGETS],
    }], 'beat-two');
    expect(afterDedupe.focusIndex).toBe(1);
    const incompleteDedupe = selectFocus(value, [{
      event: 'heartbeat_attempt', status: 'deduped', beatId: 'beat-one',
      focus: first.focus, focusIndex: first.focusIndex, deliveredTo: ['architect'],
    }], 'beat-two');
    expect(incompleteDedupe.focusIndex).toBe(0);
  });

  test('uses Oracle-approved bounded authority language and exact beat marker', () => {
    const prompt = buildPrompt({
      beatId: 'team-heartbeat-2026-08-19-am',
      scheduledWindow: 'am',
      focus: DEFAULT_CONFIG.focusRotation[0],
    });
    expect(prompt).toMatch(/^HEARTBEAT team-heartbeat-2026-08-19-am window=AM focus=james-schedule:/);
    expect(prompt).toContain('ONE bounded useful action');
    expect(prompt).toContain('Read-only is the default');
    expect(prompt).toContain('Never touch trading/PARKED lanes');
    expect(prompt).toContain('Never touch trading/PARKED lanes, invoke this runner, create a child beat');
    expect(prompt).toContain('retain at least two daily beats');
    expect(prompt).toContain('silence is valid');
  });

  test('seed focuses preserve lane ownership and audit-only memory hygiene', () => {
    const openThreads = DEFAULT_CONFIG.focusRotation.find((entry) => entry.id === 'open-threads-sweep');
    const memory = DEFAULT_CONFIG.focusRotation.find((entry) => entry.id === 'memory-rule-hygiene');
    expect(openThreads.instruction).toContain('advance only a lane you own');
    expect(openThreads.instruction).toContain("Never close or reassign another role's lane");
    expect(memory.instruction).toContain('Audit one');
    expect(memory.instruction).toContain('do not edit memory or rules');
  });
});

describe('team heartbeat routed-proof and retry dedupe', () => {
  const beatId = 'team-heartbeat-2026-08-19-am';
  const body = `HEARTBEAT ${beatId} window=AM focus=james-schedule: check.`;

  test('accepts only fresh main-scope routed/acked rows from sender heartbeat', () => {
    const rows = [
      { rowId: 1, sender: 'heartbeat', target: 'architect', status: 'routed', scope: 'main', timestampMs: 110, rawBody: body },
      { rowId: 2, sender: 'heartbeat', target: 'builder', status: 'acked', scope: 'main', timestampMs: 120, rawBody: body },
      { rowId: 3, sender: 'architect', target: 'oracle', status: 'routed', scope: 'main', timestampMs: 130, rawBody: body },
      { rowId: 4, sender: 'heartbeat', target: 'oracle', status: 'recorded', scope: 'main', timestampMs: 140, rawBody: body },
      { rowId: 5, sender: 'heartbeat', target: 'oracle', status: 'routed', scope: 'side', timestampMs: 150, rawBody: body },
      { rowId: 6, sender: 'heartbeat', target: 'oracle', status: 'routed', scope: 'main', timestampMs: 90, rawBody: body },
    ];
    expect([...proofRowsForBeat(rows, beatId, 100).keys()]).toEqual(['architect', 'builder']);
  });

  test('merges immediately journaled target proof with ledger proof and sends only missing targets', () => {
    const logs = [{ beatId, deliveredTo: ['architect'] }];
    const ledger = [{
      rowId: 2, sender: 'heartbeat', target: 'builder', status: 'routed', scope: 'main',
      timestampMs: 120, rawBody: body,
    }];
    expect([...priorDeliveredTargets(logs, beatId, ledger)].sort()).toEqual(['architect', 'builder']);
    expect(TARGETS.filter((target) => !priorDeliveredTargets(logs, beatId, ledger).has(target))).toEqual(['oracle']);
  });

  test('uses a distinct nonzero exit code for app-down, partial, and lock-busy bounded retries', () => {
    expect(APP_UNAVAILABLE_EXIT_CODE).toBe(75);
    expect(exitCodeForStatus('app_unavailable')).toBe(75);
    expect(exitCodeForStatus('partial')).toBe(75);
    expect(exitCodeForStatus('lock_busy')).toBe(75);
    expect(exitCodeForStatus('delivered')).toBe(0);
  });
});

describe('team heartbeat scheduled-task source contract', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'hm-team-heartbeat-install.ps1'), 'utf8');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'hm-team-heartbeat.js'), 'utf8');
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'hm-run-hidden.vbs'), 'utf8');

  test('registers hidden daily tasks with missed-run recovery and capped failure retry', () => {
    expect(installer).toContain("$taskPrefix = 'SquidRun-Team-Heartbeat-'");
    expect(installer).toContain("$wscript = Join-Path $env:SystemRoot 'System32\\wscript.exe'");
    expect(installer).toContain("$hiddenLauncher = Join-Path $PSScriptRoot 'hm-run-hidden.vbs'");
    expect(installer).toContain("$hiddenTaskRunner = Join-Path $PSScriptRoot 'hm-hidden-task.js'");
    expect(installer).toContain('-Execute $wscript');
    expect(installer).not.toContain('-Execute $node `');
    expect(launcher).toContain('shell.Run(command, 0, True)');
    expect(launcher).toContain('WScript.Quit exitCode');
    expect(installer).toContain('-StartWhenAvailable');
    expect(installer).toContain('-RestartCount 6');
    expect(installer).toContain('-RestartInterval (New-TimeSpan -Minutes 15)');
    expect(installer).toContain('-MultipleInstances IgnoreNew');
    expect(installer).toContain("-LogonType Interactive");
    expect(installer).toContain("-RunLevel Limited");
    expect(installer).toContain('-ErrorAction Stop');
    expect(installer).toContain("'run',");
    expect(installer).toContain("'--scheduled-window',");
    expect(installer).toContain('$null -ne $_');
  });

  test('audits planned/applied/failed reconciliation and never invokes a legacy runner', () => {
    expect(installer).toContain("'cadence_reconcile_planned'");
    expect(installer).toContain("'cadence_reconcile_applied'");
    expect(installer).toContain("'cadence_reconcile_failed'");
    expect(runner).toContain("'--role', 'heartbeat', '--no-fallback'");
    expect(runner).toContain("args.push('--between', 'heartbeat', target)");
    expect(runner).toContain('maxBuffer: 4 * 1024 * 1024');
    expect(runner).not.toContain('setInterval(');
    expect(runner).not.toContain('hm-' + 'heartbeat.js');
  });
});
