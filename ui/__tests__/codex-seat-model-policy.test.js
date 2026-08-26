const fs = require('node:fs');
const path = require('node:path');

const {
  MAIN_ORACLE_CODEX_POLICY,
  SOURCE_PROJECT_ROOT,
  applyCodexModelPolicy,
  inspectCodexPolicyFlags,
  resolveMainOracleCodexPolicy,
} = require('../modules/codex-seat-model-policy');

describe('MAIN Oracle Codex model policy', () => {
  test('resolves only for the exact MAIN Oracle pane and install root', () => {
    expect(resolveMainOracleCodexPolicy({
      paneId: '3',
      role: 'Oracle',
      profile: 'main',
      installRoot: SOURCE_PROJECT_ROOT,
      cwd: path.join(SOURCE_PROJECT_ROOT, 'a-different-assigned-project'),
    })).toMatchObject(MAIN_ORACLE_CODEX_POLICY);

    expect(resolveMainOracleCodexPolicy({
      paneId: '2', role: 'Builder', profile: 'main',
      installRoot: SOURCE_PROJECT_ROOT, cwd: SOURCE_PROJECT_ROOT,
    })).toBeNull();
    expect(resolveMainOracleCodexPolicy({
      paneId: '3', role: 'Oracle', profile: 'main',
      installRoot: 'D:\\SquidRun\\Client', cwd: 'D:\\SquidRun\\Client',
    })).toBeNull();
  });

  test('pins model and effort before an exact resume subcommand', () => {
    const result = applyCodexModelPolicy(
      'codex --profile squidrun-oracle --yolo resume 22222222-2222-4222-8222-222222222222',
      MAIN_ORACLE_CODEX_POLICY
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      expectedModel: 'gpt-5.6-sol',
      expectedEffort: 'xhigh',
    });
    expect(result.command).toBe(
      'codex --profile squidrun-oracle --yolo --model gpt-5.6-sol '
      + '--config model_reasoning_effort=xhigh resume 22222222-2222-4222-8222-222222222222'
    );
    expect(inspectCodexPolicyFlags(result.command)).toMatchObject({
      models: ['gpt-5.6-sol'],
      efforts: ['xhigh'],
    });
  });

  test('pins cold starts and preserves an already exact command', () => {
    const cold = applyCodexModelPolicy('codex --profile squidrun-oracle', MAIN_ORACLE_CODEX_POLICY);
    expect(cold.command).toBe(
      'codex --profile squidrun-oracle --model gpt-5.6-sol --config model_reasoning_effort=xhigh'
    );

    const exact = applyCodexModelPolicy(cold.command, MAIN_ORACLE_CODEX_POLICY);
    expect(exact).toMatchObject({
      ok: true,
      changed: false,
      command: cold.command,
      reason: 'codex_model_policy_already_pinned',
    });
  });

  test.each([
    ['codex --model gpt-5.6-luna', 'gpt-5.6-luna', null],
    ['codex -c model="gpt-5.6-luna"', 'gpt-5.6-luna', null],
    ['codex --config model_reasoning_effort=low', null, 'low'],
  ])('refuses a conflicting model or effort instead of relying on flag order: %s', (
    command,
    actualModel,
    actualEffort
  ) => {
    expect(applyCodexModelPolicy(command, MAIN_ORACLE_CODEX_POLICY)).toMatchObject({
      ok: false,
      command,
      reason: 'codex_model_policy_conflict',
      actualModel,
      actualEffort,
    });
  });

  test('does not change Claude or a Codex command without an explicit seat policy', () => {
    expect(applyCodexModelPolicy('claude --model opus', MAIN_ORACLE_CODEX_POLICY))
      .toMatchObject({ ok: true, changed: false, command: 'claude --model opus' });
    expect(applyCodexModelPolicy('codex --profile squidrun-builder', null))
      .toMatchObject({ ok: true, changed: false, command: 'codex --profile squidrun-builder' });
  });

  test('the durable daemon reapplies policy from server-owned seat and install facts before PTY spawn', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'terminal-daemon.js'), 'utf8');
    const policyStart = source.indexOf('const codexModelPolicy = resolveMainOracleCodexPolicy({');
    const policyEnd = source.indexOf('paneCommand = codexPolicyResult.command;', policyStart);
    const spawn = source.indexOf('const ptyProcess = pty.spawn(', policyEnd);
    const boundary = source.slice(policyStart, policyEnd);

    expect(policyStart).toBeGreaterThan(0);
    expect(policyEnd).toBeGreaterThan(policyStart);
    expect(spawn).toBeGreaterThan(policyEnd);
    expect(boundary).toContain("role: PANE_ROLES[String(paneId)]");
    expect(boundary).toContain('installRoot: getSquidrunRoot()');
    expect(boundary).not.toContain('installRoot: getProjectRoot()');
    expect(boundary).not.toContain('runtimeEnv.SQUIDRUN_ROLE');
    expect(boundary).not.toContain('runtimeEnv.SQUIDRUN_PROJECT_ROOT');
  });
});
