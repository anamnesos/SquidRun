const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const START_HOOK = path.join(__dirname, '..', 'scripts', 'codex-hooks', 'session-start.ps1');
const STOP_HOOK = path.join(__dirname, '..', 'scripts', 'codex-hooks', 'stop.ps1');
const SHARED_CWD = path.resolve('D:/projects/squidrun');

function runHook(script, payload, logRoot, identity = {}) {
  const env = {
    ...process.env,
    SQUIDRUN_CODEX_HOOK_TEST_LOG_ROOT: logRoot,
    SQUIDRUN_CODEX_HOOK_TEST_DISABLE_BINDER: '1',
    SQUIDRUN_PROJECT_ROOT: SHARED_CWD,
    SQUIDRUN_PROFILE: '',
    SQUIDRUN_ROLE: '',
    SQUIDRUN_PANE_ID: '',
    ...identity,
  };
  return spawnSync('pwsh', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
  ], {
    cwd: SHARED_CWD,
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

function payload(overrides = {}) {
  return {
    session_id: '11111111-1111-4111-8111-111111111111',
    cwd: SHARED_CWD,
    transcript_path: 'C:/fixture/rollout.jsonl',
    model: 'gpt-test',
    permission_mode: 'test',
    source: 'resume',
    stop_hook_active: false,
    last_assistant_message: '',
    ...overrides,
  };
}

describe('Codex hook seat-scoped state', () => {
  let logRoot;

  beforeEach(() => {
    logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-codex-hook-state-'));
    fs.mkdirSync(path.join(logRoot, 'hook-state'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(logRoot, { recursive: true, force: true });
  });

  test('same-cwd Builder and Oracle stops write distinct state and starts read only their own', () => {
    const builderIdentity = {
      SQUIDRUN_PROFILE: 'main', SQUIDRUN_ROLE: 'builder', SQUIDRUN_PANE_ID: '2',
    };
    const oracleIdentity = {
      SQUIDRUN_PROFILE: 'main', SQUIDRUN_ROLE: 'oracle', SQUIDRUN_PANE_ID: '3',
    };

    const builderStop = runHook(
      STOP_HOOK,
      payload({ last_assistant_message: 'builder-only-summary' }),
      logRoot,
      builderIdentity
    );
    const oracleStop = runHook(
      STOP_HOOK,
      payload({
        session_id: '22222222-2222-4222-8222-222222222222',
        last_assistant_message: 'oracle-only-summary',
      }),
      logRoot,
      oracleIdentity
    );

    expect(builderStop.status).toBe(0);
    expect(oracleStop.status).toBe(0);
    expect(builderStop.stdout).toContain('{"continue":true}');
    expect(oracleStop.stdout).toContain('{"continue":true}');
    expect(fs.readdirSync(path.join(logRoot, 'hook-state'))).toHaveLength(2);

    const builderStart = runHook(START_HOOK, payload(), logRoot, builderIdentity);
    const oracleStart = runHook(START_HOOK, payload(), logRoot, oracleIdentity);
    expect(builderStart.status).toBe(0);
    expect(oracleStart.status).toBe(0);
    expect(builderStart.stdout).toContain('builder-only-summary');
    expect(builderStart.stdout).not.toContain('oracle-only-summary');
    expect(oracleStart.stdout).toContain('oracle-only-summary');
    expect(oracleStart.stdout).not.toContain('builder-only-summary');
  });

  test('no complete SquidRun identity cannot read a seat file; no identity retains legacy cwd state', () => {
    const builderIdentity = {
      SQUIDRUN_PROFILE: 'main', SQUIDRUN_ROLE: 'builder', SQUIDRUN_PANE_ID: '2',
    };
    expect(runHook(
      STOP_HOOK,
      payload({ last_assistant_message: 'seat-private-summary' }),
      logRoot,
      builderIdentity
    ).status).toBe(0);

    const outsideBeforeLegacy = runHook(START_HOOK, payload(), logRoot);
    expect(outsideBeforeLegacy.status).toBe(0);
    expect(outsideBeforeLegacy.stdout).not.toContain('seat-private-summary');
    expect(outsideBeforeLegacy.stdout.trim()).toBe('');

    expect(runHook(
      STOP_HOOK,
      payload({ last_assistant_message: 'legacy-workspace-summary' }),
      logRoot
    ).status).toBe(0);
    const outsideAfterLegacy = runHook(START_HOOK, payload(), logRoot);
    expect(outsideAfterLegacy.stdout).toContain('legacy-workspace-summary');
    expect(outsideAfterLegacy.stdout).not.toContain('seat-private-summary');
  });

  test('partial SquidRun identity fails closed instead of falling back to cwd-only state', () => {
    const before = fs.readdirSync(path.join(logRoot, 'hook-state')).length;
    const partial = { SQUIDRUN_PROFILE: 'main', SQUIDRUN_ROLE: 'builder', SQUIDRUN_PANE_ID: '' };

    const stop = runHook(
      STOP_HOOK,
      payload({ last_assistant_message: 'must-not-persist' }),
      logRoot,
      partial
    );
    const start = runHook(START_HOOK, payload(), logRoot, partial);

    expect(stop.status).toBe(0);
    expect(stop.stdout).toContain('{"continue":true}');
    expect(start.status).toBe(0);
    expect(start.stdout.trim()).toBe('');
    expect(fs.readdirSync(path.join(logRoot, 'hook-state'))).toHaveLength(before);
  });
});
