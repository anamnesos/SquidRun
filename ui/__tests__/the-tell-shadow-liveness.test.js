/* global afterEach, beforeEach, describe, expect, it, jest */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { inspectShadowRunnerStatus } = require('../modules/main/the-tell-shadow-runner');

// A pid that cannot be alive. Chosen high and then verified unused below.
const DEAD_PID = 4194303;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tell-shadow-'));
}

function writeStatus(dir, overrides = {}) {
  const statusPath = path.join(dir, 'status.json');
  const nowMs = Date.now();
  fs.writeFileSync(statusPath, JSON.stringify({
    ok: true,
    running: true,
    runId: 'the-tell-shadow:test',
    intervalMs: 1200000,
    lastTick: {
      type: 'tick',
      ts: nowMs,
      checkedAt: new Date(nowMs).toISOString(),
      tickId: 'the-tell-shadow:test:tick:1',
      ok: true,
    },
    ...overrides,
  }, null, 2));
  return statusPath;
}

describe('The Tell shadow runner liveness is FAIL CLOSED', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('A DEAD OWNER PID CANNOT ASSERT running:true, even with a FRESH tick', () => {
    // This is the exact hole. The runner died uncleanly, so nothing ever
    // rewrote running:false, and the last tick it managed to write is recent.
    // The old opt-IN pid check meant any caller that did not ask got "running".
    const statusPath = writeStatus(dir, { ownerPid: DEAD_PID });

    const result = inspectShadowRunnerStatus({
      statusPath,
      ledgerPath: path.join(dir, 'ledger.json'),
      pidPath: path.join(dir, 'missing.pid'),
    });

    expect(result.reportedRunning).toBe(true);   // the file still claims it
    expect(result.tickFresh).toBe(true);          // and the tick is recent
    expect(result.ownerPidAlive).toBe(false);
    expect(result.running).toBe(false);           // but we do not believe it
  });

  it('A LIVE OWNER PID IS BELIEVED', () => {
    const statusPath = writeStatus(dir, { ownerPid: process.pid });

    const result = inspectShadowRunnerStatus({
      statusPath,
      ledgerPath: path.join(dir, 'ledger.json'),
      pidPath: path.join(dir, 'missing.pid'),
    });

    expect(result.ownerPidAlive).toBe(true);
    expect(result.running).toBe(true);
  });

  it('VERIFICATION IS THE DEFAULT — a caller must opt OUT, not opt IN', () => {
    const statusPath = writeStatus(dir, { ownerPid: DEAD_PID });
    const args = {
      statusPath,
      ledgerPath: path.join(dir, 'ledger.json'),
      pidPath: path.join(dir, 'missing.pid'),
    };

    // Default: verified, so a dead process reads as not running.
    expect(inspectShadowRunnerStatus(args).running).toBe(false);
    // Explicit opt-out restores the old trusting behaviour for anyone who
    // genuinely wants the file's raw claim.
    expect(inspectShadowRunnerStatus({ ...args, requirePid: false }).running).toBe(true);
  });

  it('A STALE TICK IS DEAD REGARDLESS OF PID', () => {
    const old = Date.now() - (40 * 60 * 60 * 1000); // 40 h, well past threshold
    const statusPath = writeStatus(dir, {
      ownerPid: process.pid,
      lastTick: {
        type: 'tick', ts: old, checkedAt: new Date(old).toISOString(),
        tickId: 'the-tell-shadow:test:tick:old', ok: true,
      },
    });

    const result = inspectShadowRunnerStatus({
      statusPath,
      ledgerPath: path.join(dir, 'ledger.json'),
      pidPath: path.join(dir, 'missing.pid'),
      staleThresholdMs: 90000000,
    });

    expect(result.tickFresh).toBe(false);
    expect(result.running).toBe(false);
  });
});

describe('startup-health recovers the shadow runner (Architect #5b)', () => {
  const health = require('../scripts/hm-startup-health');

  it('EXPOSES a recovery branch at all — the gap was that none existed', () => {
    expect(typeof health.runTheTellShadowAutoRecover).toBe('function');
  });

  it('IS DISABLED BY ITS OPT-OUT FLAG', () => {
    expect(health.runTheTellShadowAutoRecover(['--no-the-tell-shadow-auto-recover']))
      .toMatchObject({ ok: true, skipped: true, reason: 'disabled_or_help' });
  });

  it('DOES NOTHING ON A NON-OWNER PROFILE', () => {
    expect(health.runTheTellShadowAutoRecover(['--profile=sideprofile']))
      .toMatchObject({ ok: true, skipped: true, reason: 'profile_not_owner' });
  });

  it('IS ACTUALLY WIRED INTO runStartupHealth — the seam, not just the function', () => {
    // Exporting a recovery function proves nothing if startup health never
    // calls it. That is precisely the failure this lane fixes: the check could
    // see the runner die and had no path to act on it.
    jest.resetModules();
    jest.doMock('child_process', () => ({
      spawnSync: jest.fn(() => ({ status: 0, stdout: '', stderr: '' })),
    }));
    const childProcess = require('child_process');
    const wired = require('../scripts/hm-startup-health');

    wired.runStartupHealth([os.tmpdir(), '--json'], { stderr: { write: jest.fn() } });

    const shadowCalls = childProcess.spawnSync.mock.calls.filter(
      ([, args]) => String(args?.[0] || '').includes('hm-the-tell-shadow.js')
    );
    expect(shadowCalls.length).toBeGreaterThan(0);

    jest.dontMock('child_process');
    jest.resetModules();
  });
});
