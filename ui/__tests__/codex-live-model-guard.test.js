const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  evaluateOracleModelGuard,
  hookResponseFor,
  readLatestLiveState,
} = require('../modules/codex-live-model-guard');
const {
  guardCommandIdentity,
  installOracleModelGuardHooks,
} = require('../modules/codex-model-guard-hooks');
const { captureBinding } = require('../modules/codex-pane-session-store');
const { runCheck } = require('../scripts/hm-codex-model-guard');

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '33333333-3333-4333-8333-333333333333';
const APP_GENERATION = `app-session-${500 + 34}`;
const NEXT_APP_GENERATION = `app-session-${500 + 35}`;

function record(model, effort, ordinal, overrides = {}) {
  return {
    timestamp: new Date(1787590000000 + ordinal).toISOString(),
    ordinal,
    type: 'turn_context',
    payload: {
      turn_id: overrides.turnId || TURN_ID,
      cwd: overrides.cwd,
      model,
      effort,
      collaboration_mode: {
        settings: { model, reasoning_effort: effort },
      },
    },
  };
}

function settingsRecord(model, effort, ordinal, cwd) {
  return {
    timestamp: new Date(1787590000000 + ordinal).toISOString(),
    ordinal,
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_settings: {
        cwd,
        model,
        reasoning_effort: effort,
      },
    },
  };
}

describe('Codex live Oracle model guard', () => {
  let root;
  let installRoot;
  let projectRoot;
  let sessionRoot;
  let transcriptPath;
  let bindingStorePath;
  let env;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-model-guard-'));
    installRoot = path.join(root, 'squidrun-install');
    projectRoot = path.join(root, 'workspace');
    sessionRoot = path.join(root, 'codex-home', 'sessions');
    transcriptPath = path.join(
      sessionRoot,
      '2026',
      '08',
      '24',
      `rollout-test-${SESSION_ID}.jsonl`
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.mkdirSync(installRoot, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    bindingStorePath = path.join(
      installRoot,
      '.squidrun',
      'runtime',
      'codex-pane-sessions.json'
    );
    fs.mkdirSync(path.dirname(bindingStorePath), { recursive: true });
    fs.writeFileSync(bindingStorePath, `${JSON.stringify({
      schema: 'squidrun.codex_pane_sessions.v1',
      panes: {
        '3': {
          cli: 'codex',
          sessionId: SESSION_ID,
          threadId: SESSION_ID,
          paneId: '3',
          role: 'oracle',
          profile: 'main',
          cwd: projectRoot,
          projectRoot,
          transcriptPath,
          paneLaunchId: 'pl_33333333333333333333333333333333',
          appGeneration: APP_GENERATION,
          boundAt: '2026-08-24T18:00:00.000Z',
          source: 'codex_session_start_hook',
        },
      },
    }, null, 2)}\n`);
    env = {
      SQUIDRUN_ROLE: 'Oracle',
      SQUIDRUN_PANE_ID: '3',
      SQUIDRUN_PROFILE: 'main',
      SQUIDRUN_PROJECT_ROOT: projectRoot,
      SQUIDRUN_PANE_LAUNCH_ID: 'pl_33333333333333333333333333333333',
      SQUIDRUN_APP_GENERATION: APP_GENERATION,
    };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function payload(eventName = 'UserPromptSubmit', overrides = {}) {
    return {
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      transcript_path: transcriptPath,
      cwd: projectRoot,
      hook_event_name: eventName,
      model: 'gpt-5.6-sol',
      ...overrides,
    };
  }

  function writeTranscript(entries = []) {
    const all = [
      {
        type: 'session_meta',
        payload: { session_id: SESSION_ID, id: SESSION_ID, cwd: projectRoot },
      },
      ...entries,
    ];
    fs.writeFileSync(
      transcriptPath,
      `${all.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    );
  }

  function evaluate(eventName = 'UserPromptSubmit', overrides = {}, optionOverrides = {}) {
    return evaluateOracleModelGuard(payload(eventName, overrides), {
      expectedInstallRoot: installRoot,
      guardInstallRoot: installRoot,
      bindingStorePath,
      expectedModel: 'gpt-5.6-sol',
      expectedEffort: 'xhigh',
      codexSessionRoot: sessionRoot,
      env,
      ...optionOverrides,
    });
  }

  test('accepts exact live Sol/xhigh and binds the current turn', () => {
    writeTranscript([record(
      'gpt-5.6-sol', 'xhigh', 10, { cwd: projectRoot }
    )]);

    expect(evaluate()).toMatchObject({
      applicable: true,
      ok: true,
      reason: 'live_model_policy_verified',
      payloadModel: 'gpt-5.6-sol',
      state: {
        source: 'turn_context',
        ordinal: 10,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        turnId: TURN_ID,
      },
    });
  });

  test('guards MAIN Oracle while its assigned project and live cwd are outside SquidRun', () => {
    expect(projectRoot).not.toBe(installRoot);
    writeTranscript([record(
      'gpt-5.6-sol', 'xhigh', 10, { cwd: projectRoot }
    )]);

    expect(evaluate()).toMatchObject({
      applicable: true,
      ok: true,
      reason: 'live_model_policy_verified',
      state: { cwd: projectRoot },
    });
  });

  test.each([
    ['gpt-5.6-luna', 'low'],
    ['gpt-5.6-sol', 'low'],
    ['gpt-5.6-luna', 'xhigh'],
  ])('blocks transcript state %s/%s even when saved launch settings are irrelevant', (model, effort) => {
    writeTranscript([record(
      model, effort, 11, { cwd: projectRoot }
    )]);

    expect(evaluate()).toMatchObject({
      applicable: true,
      ok: false,
      reason: 'live_model_or_effort_mismatch',
      state: { model, effort },
    });
  });

  test('payload Luna blocks before transcript inspection can grant stale credit', () => {
    writeTranscript([record(
      'gpt-5.6-sol', 'xhigh', 12, { cwd: projectRoot }
    )]);
    expect(evaluate('PreToolUse', { model: 'gpt-5.6-luna' })).toMatchObject({
      ok: false,
      reason: 'live_payload_model_mismatch',
      payloadModel: 'gpt-5.6-luna',
    });
  });

  test('latest restored Sol/xhigh supersedes earlier Luna/low in the same transcript', () => {
    writeTranscript([
      record('gpt-5.6-luna', 'low', 20, { cwd: projectRoot }),
      record('gpt-5.6-sol', 'xhigh', 21, { cwd: projectRoot }),
    ]);

    expect(evaluate()).toMatchObject({
      ok: true,
      state: { ordinal: 21, model: 'gpt-5.6-sol', effort: 'xhigh' },
    });
  });

  test('a delayed hostile thread-settings apply supersedes a clean post-compaction turn', () => {
    writeTranscript([
      record('gpt-5.6-sol', 'xhigh', 25, { cwd: projectRoot }),
      settingsRecord('gpt-5.6-luna', 'low', 26, projectRoot),
    ]);

    expect(evaluate('UserPromptSubmit', { model: 'gpt-5.6-sol' })).toMatchObject({
      ok: false,
      reason: 'live_model_or_effort_mismatch',
      payloadModel: 'gpt-5.6-sol',
      state: {
        source: 'thread_settings_applied',
        ordinal: 26,
        model: 'gpt-5.6-luna',
        effort: 'low',
      },
    });
  });

  test('wrong turn, missing transcript, and out-of-root transcript fail closed', () => {
    writeTranscript([record(
      'gpt-5.6-sol', 'xhigh', 30,
      { cwd: projectRoot, turnId: '44444444-4444-4444-8444-444444444444' }
    )]);
    expect(evaluate()).toMatchObject({ ok: false, reason: 'live_turn_context_mismatch' });

    fs.rmSync(transcriptPath);
    expect(evaluate()).toMatchObject({
      ok: false,
      reason: 'main_oracle_binding_transcript_missing',
    });

    const outside = path.join(root, `outside-${SESSION_ID}.jsonl`);
    fs.writeFileSync(outside, '{}\n');
    expect(readLatestLiveState(outside, {
      sessionId: SESSION_ID,
      codexSessionRoot: sessionRoot,
    }))
      .toMatchObject({ ok: false, reason: 'transcript_outside_codex_session_root' });
  });

  test('a brand-new startup may await its first turn only when payload model is exact', () => {
    writeTranscript();
    expect(evaluate('SessionStart', { source: 'startup', turn_id: undefined })).toMatchObject({
      ok: true,
      limited: true,
      reason: 'startup_model_verified_effort_pending_first_turn',
    });
    expect(evaluate('SessionStart', {
      source: 'startup', turn_id: undefined, model: 'gpt-5.6-luna',
    })).toMatchObject({ ok: false, reason: 'live_payload_model_mismatch' });
  });

  test('guard-first resume permits only the binding refresh window and the next prompt requires it', () => {
    writeTranscript([record(
      'gpt-5.6-sol', 'xhigh', 13, { cwd: projectRoot }
    )]);
    const resumedEnv = {
      ...env,
      SQUIDRUN_PANE_LAUNCH_ID: 'pl_44444444444444444444444444444444',
      SQUIDRUN_APP_GENERATION: NEXT_APP_GENERATION,
    };

    expect(evaluate('SessionStart', {
      source: 'resume',
      turn_id: undefined,
    }, { env: resumedEnv })).toMatchObject({
      applicable: true,
      ok: true,
      limited: true,
      bindingPending: true,
      reason: 'main_oracle_binding_refresh_pending',
    });
    expect(evaluate('SessionStart', {
      source: 'compact',
      turn_id: undefined,
    }, { env: resumedEnv })).toMatchObject({
      ok: true,
      limited: true,
      bindingPending: true,
      reason: 'main_oracle_binding_refresh_pending',
    });
    expect(evaluate('SessionStart', {
      source: 'resume',
      turn_id: undefined,
      model: 'gpt-5.6-luna',
    }, { env: resumedEnv })).toMatchObject({
      ok: false,
      reason: 'live_payload_model_mismatch',
    });

    expect(evaluate('UserPromptSubmit', {}, { env: resumedEnv })).toMatchObject({
      applicable: true,
      ok: false,
      reason: 'main_oracle_binding_mismatch',
    });
    expect(evaluate('PreToolUse', {}, { env: resumedEnv })).toMatchObject({
      applicable: true,
      ok: false,
      reason: 'main_oracle_binding_mismatch',
    });

    expect(captureBinding(bindingStorePath, {
      paneId: '3',
      role: 'oracle',
      profile: 'main',
      sessionId: SESSION_ID,
      threadId: SESSION_ID,
      cwd: projectRoot,
      projectRoot,
      transcriptPath,
      paneLaunchId: resumedEnv.SQUIDRUN_PANE_LAUNCH_ID,
      appGeneration: resumedEnv.SQUIDRUN_APP_GENERATION,
    }, {
      expectedCwd: projectRoot,
      codexSessionRoot: sessionRoot,
    })).toMatchObject({ ok: true });

    expect(evaluate('UserPromptSubmit', {}, { env: resumedEnv })).toMatchObject({
      applicable: true,
      ok: true,
      reason: 'live_model_policy_verified',
    });
  });

  test('other seats are byte-behavior no-ops while malformed Oracle identity blocks', () => {
    const builder = evaluateOracleModelGuard(payload(), {
      expectedInstallRoot: installRoot,
      guardInstallRoot: installRoot,
      codexSessionRoot: sessionRoot,
      env: { ...env, SQUIDRUN_ROLE: 'Builder', SQUIDRUN_PANE_ID: '2' },
    });
    expect(builder).toEqual({ applicable: false, ok: true, reason: 'not_main_oracle_seat' });

    const malformedOracle = evaluateOracleModelGuard(payload(), {
      expectedInstallRoot: installRoot,
      guardInstallRoot: installRoot,
      codexSessionRoot: sessionRoot,
      env: { ...env, SQUIDRUN_PANE_ID: '2' },
    });
    expect(malformedOracle).toMatchObject({
      applicable: true,
      ok: false,
      reason: 'oracle_guard_identity_mismatch',
    });
  });

  test('exact SIDE Oracle/3/main is a no-op while an unbound MAIN Oracle fails closed', () => {
    const sideRoot = path.join(root, 'Client');
    const side = evaluateOracleModelGuard(payload('UserPromptSubmit', {
      cwd: sideRoot,
      transcript_path: path.join(sideRoot, `rollout-${SESSION_ID}.jsonl`),
    }), {
      expectedInstallRoot: installRoot,
      guardInstallRoot: installRoot,
      bindingStorePath,
      codexSessionRoot: sessionRoot,
      env: {
        ...env,
        SQUIDRUN_DATA_ROOT: sideRoot,
        SQUIDRUN_PROJECT_ROOT: sideRoot,
      },
    });
    expect(side).toEqual({
      applicable: false,
      ok: true,
      reason: 'different_squidrun_install',
    });

    fs.rmSync(bindingStorePath);
    expect(evaluate()).toMatchObject({
      applicable: true,
      ok: false,
      reason: 'main_oracle_binding_absent',
    });
  });

  test('emits event-specific fail-closed hook protocol', () => {
    const failure = { applicable: true, ok: false, reason: 'live_model_or_effort_mismatch' };
    expect(hookResponseFor(failure, payload('PreToolUse'))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    expect(hookResponseFor(failure, payload('UserPromptSubmit'))).toMatchObject({
      decision: 'block',
    });
    expect(hookResponseFor(failure, payload('SessionStart'))).toMatchObject({
      continue: false,
      stopReason: 'live_model_or_effort_mismatch',
    });
    expect(hookResponseFor(failure, payload('Stop'))).toMatchObject({
      continue: false,
      stopReason: 'live_model_or_effort_mismatch',
    });
  });

  test('reads only a bounded tail and ignores an incomplete leading fragment', () => {
    const filler = `${JSON.stringify({ ordinal: 1, type: 'response_item', payload: { text: 'x'.repeat(5000) } })}\n`;
    writeTranscript();
    fs.appendFileSync(transcriptPath, filler.repeat(40));
    fs.appendFileSync(transcriptPath, `${JSON.stringify(record(
      'gpt-5.6-sol', 'xhigh', 99, { cwd: projectRoot }
    ))}\n`);
    expect(readLatestLiveState(transcriptPath, {
      sessionId: SESSION_ID,
      codexSessionRoot: sessionRoot,
      maxTailBytes: 64 * 1024,
    })).toMatchObject({
      ok: true,
      state: { ordinal: 99, model: 'gpt-5.6-sol', effort: 'xhigh' },
    });
  });
});

describe('Oracle model guard hook installation', () => {
  test('the hook CLI fails closed when its trusted install-root argument is absent', async () => {
    const checked = await runCheck({}, {
      raw: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
      env: {},
    });

    expect(checked.result).toMatchObject({
      applicable: true,
      ok: false,
      reason: 'expected_install_root_required',
    });
    expect(checked.response).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('expected_install_root_required'),
    });
  });

  test('an applicable Oracle check fails closed when its audit receipt cannot be written', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-model-guard-trace-'));
    try {
      const projectRoot = path.join(root, 'workspace');
      const sessionRoot = path.join(root, 'codex-home', 'sessions');
      const transcriptPath = path.join(
        sessionRoot,
        '2026',
        '08',
        '24',
        `rollout-test-${SESSION_ID}.jsonl`
      );
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.writeFileSync(transcriptPath, [
        JSON.stringify({
          type: 'session_meta',
          payload: { session_id: SESSION_ID, id: SESSION_ID, cwd: projectRoot },
        }),
        JSON.stringify(record('gpt-5.6-sol', 'xhigh', 41, { cwd: projectRoot })),
        '',
      ].join('\n'));
      const bindingStorePath = path.join(
        projectRoot,
        '.squidrun',
        'runtime',
        'codex-pane-sessions.json'
      );
      fs.mkdirSync(path.dirname(bindingStorePath), { recursive: true });
      fs.writeFileSync(bindingStorePath, `${JSON.stringify({
        schema: 'squidrun.codex_pane_sessions.v1',
        panes: {
          '3': {
            cli: 'codex',
            sessionId: SESSION_ID,
            threadId: SESSION_ID,
            paneId: '3',
            role: 'oracle',
            profile: 'main',
            cwd: projectRoot,
            projectRoot,
            transcriptPath,
            paneLaunchId: 'pl_33333333333333333333333333333333',
            appGeneration: APP_GENERATION,
            boundAt: '2026-08-24T18:00:00.000Z',
            source: 'codex_session_start_hook',
          },
        },
      }, null, 2)}\n`);

      const checked = await runCheck({
        expectedInstallRoot: projectRoot,
        bindingStorePath,
        codexSessionRoot: sessionRoot,
      }, {
        raw: JSON.stringify({
          session_id: SESSION_ID,
          turn_id: TURN_ID,
          transcript_path: transcriptPath,
          cwd: projectRoot,
          hook_event_name: 'UserPromptSubmit',
          model: 'gpt-5.6-sol',
        }),
        env: {
          SQUIDRUN_ROLE: 'Oracle',
          SQUIDRUN_PANE_ID: '3',
          SQUIDRUN_PROFILE: 'main',
          SQUIDRUN_PROJECT_ROOT: projectRoot,
          SQUIDRUN_PANE_LAUNCH_ID: 'pl_33333333333333333333333333333333',
          SQUIDRUN_APP_GENERATION: APP_GENERATION,
        },
        guardInstallRoot: projectRoot,
        appendTrace: () => ({ ok: false, error: 'disk unavailable' }),
      });

      expect(checked.result).toMatchObject({
        ok: false,
        reason: 'guard_trace_write_failed',
        priorReason: 'live_model_policy_verified',
      });
      expect(checked.response).toMatchObject({ decision: 'block' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a non-Oracle project hook is a no-op and writes no guard receipt', async () => {
    const appendTrace = jest.fn();
    const checked = await runCheck({ expectedInstallRoot: 'D:\\projects\\squidrun' }, {
      raw: JSON.stringify({ hook_event_name: 'PreToolUse' }),
      env: {
        SQUIDRUN_ROLE: 'Builder',
        SQUIDRUN_PANE_ID: '2',
        SQUIDRUN_PROFILE: 'main',
        SQUIDRUN_PROJECT_ROOT: 'D:\\projects\\squidrun',
      },
      appendTrace,
    });

    expect(checked.result).toEqual({
      applicable: false,
      ok: true,
      reason: 'not_main_oracle_seat',
    });
    expect(checked.response).toEqual({});
    expect(appendTrace).not.toHaveBeenCalled();
  });

  test('installs six exact synchronous hooks idempotently and preserves unrelated hooks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-model-guard-install-'));
    try {
      const codexHome = path.join(root, 'codex-home');
      const configPath = path.join(codexHome, 'hooks.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        hooks: {
          Stop: [{ hooks: [
            { type: 'command', command: 'node existing-stop.js' },
            { type: 'command', command: 'node unrelated-hm-codex-model-guard.js-backup' },
            {
              type: 'command',
              command: `node "${path.join(root, 'other', 'hm-codex-model-guard.js')}" check`,
            },
          ] }],
          PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'node image-guard.js' }] }],
        },
      }, null, 2));

      const first = installOracleModelGuardHooks({ installRoot: root, codexHome });
      const second = installOracleModelGuardHooks({ installRoot: root, codexHome });
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const all = Object.entries(config.hooks).flatMap(([event, entries]) => entries.flatMap((entry) => (
        entry.hooks.map((hook) => ({ event, matcher: entry.matcher, command: hook.command }))
      )));
      const exactGuardPath = path.join(root, 'ui', 'scripts', 'hm-codex-model-guard.js');
      const guards = all.filter((entry) => (
        guardCommandIdentity(entry.command, exactGuardPath) !== null
      ));

      expect(first).toMatchObject({ ok: true, changed: true });
      expect(second).toMatchObject({ ok: true, changed: false });
      expect(guards.map((entry) => entry.event).sort()).toEqual([
        'PostCompact', 'PreCompact', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit',
      ]);
      expect(guards.find((entry) => entry.event === 'PreToolUse').matcher).toBe('*');
      expect(all.some((entry) => entry.command === 'node existing-stop.js')).toBe(true);
      expect(all.some((entry) => entry.command === 'node image-guard.js')).toBe(true);
      expect(all.some((entry) => (
        entry.command === 'node unrelated-hm-codex-model-guard.js-backup'
      ))).toBe(true);
      expect(all.some((entry) => (
        entry.command === `node "${path.join(root, 'other', 'hm-codex-model-guard.js')}" check`
      ))).toBe(true);
      expect(first.configPath).toBe(configPath);
      expect(first.command).toContain('--expected-install-root');
      expect(first.command).not.toContain('--model');
      expect(first.command).not.toContain('--effort');
      expect(guardCommandIdentity(
        'node unrelated-hm-codex-model-guard.js-backup',
        exactGuardPath
      )).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
