const fs = require('fs');
const os = require('os');
const path = require('path');

const presenceContract = require('./fixtures/mira-core-presence-v0-contract.json');
const {
  BASELINE_COMMIT,
  PRESENCE_SCHEMA_VERSION,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_CANNOT_DO_IDS,
  REQUIRED_SAFE_NEXT_ACTION_IDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCorePresenceV0,
  validateMiraCorePresenceV0Output,
} = require('../modules/mira-core/presence-v0');
const {
  main,
  mergeInputSignals,
  parseArgs,
} = require('../scripts/hm-mira-core-presence-v0');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCorePresenceV0({
    contract: presenceContract,
    inputSignals: {
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-329' },
      sessionId: 'app-session-329',
      deviceId: 'VIGIL',
      role: 'builder',
      paneId: '2',
      paneName: 'Builder',
      projectName: 'squidrun',
      projectPath: 'D:\\projects\\squidrun',
      health: {
        overall: 'degraded',
        app: 'session_329_active',
        supervisor: 'unknown',
      },
      memory: {
        status: 'drift_detected',
        entries: 161,
        nodes: 182,
        missing: 21,
        orphans: 42,
        duplicates: 0,
      },
      bridge: {
        connection: 'disconnected',
        roleDiscovery: 'unknown',
        targetProof: 'unverified',
      },
      routing: {
        windowKey: 'main',
        profile: 'main',
        mainScopeIsolated: true,
        sideProfileHoldAvailable: true,
      },
      ...inputSignals,
    },
    nowMs: Date.parse('2026-05-07T08:40:00.000Z'),
  });
}

function presence(output) {
  return output.mira_core_presence_v0;
}

function report(output) {
  return output.validation_report;
}

function ids(entries) {
  return new Set(entries.map((entry) => entry.id || entry.blocker_id));
}

describe('mira core Presence v0 phase 68', () => {
  test('builds a compact local operator-facing status surface', () => {
    const output = build();
    const currentPresence = presence(output);
    const validation = validateMiraCorePresenceV0Output(output, presenceContract);

    expect(validation).toEqual(expect.objectContaining({ ok: true }));
    expect(currentPresence.schema).toBe(PRESENCE_SCHEMA_VERSION);
    expect(currentPresence.phase).toBe(68);
    expect(currentPresence.baseline_commit).toBe(BASELINE_COMMIT);
    expect(currentPresence.profile).toEqual(expect.objectContaining({
      name: 'main',
      windowKey: 'main',
      sessionScopeId: 'app-session-329',
    }));
    expect(currentPresence.windowKey).toBe('main');
    expect(currentPresence.sessionId).toBe('app-session-329');
    expect(currentPresence.deviceId).toBe('VIGIL');
    expect(currentPresence.role).toBe('builder');
    expect(currentPresence.pane_context).toEqual(expect.objectContaining({
      paneId: '2',
      paneName: 'Builder',
    }));
    expect(currentPresence.project_context).toEqual(expect.objectContaining({
      name: 'squidrun',
      local_only: true,
    }));
    expect(JSON.stringify(currentPresence).length).toBeLessThan(12000);
  });

  test('answers current health, memory, bridge, routing, blockers, and safe next actions', () => {
    const currentPresence = presence(build());

    expect(currentPresence.knows_now.health).toEqual(expect.objectContaining({
      overall: 'degraded',
      app: 'session_329_active',
    }));
    expect(currentPresence.knows_now.memory).toEqual(expect.objectContaining({
      status: 'drift_detected',
      missing: 21,
      orphans: 42,
      duplicates: 0,
    }));
    expect(currentPresence.knows_now.bridge).toEqual(expect.objectContaining({
      connection: 'disconnected',
      socket_connection_alone_is_green: false,
    }));
    expect(currentPresence.knows_now.routing).toEqual(expect.objectContaining({
      windowKey: 'main',
      profile: 'main',
      main_scope_isolated: true,
      side_profile_hold_available: true,
      wrong_context_messages_actionable_in_main: false,
    }));
    for (const id of REQUIRED_SAFE_NEXT_ACTION_IDS) {
      expect(ids(currentPresence.safe_next_actions)).toContain(id);
    }
    for (const id of REQUIRED_BLOCKER_IDS) {
      expect(ids(currentPresence.blockers)).toContain(id);
    }
  });

  test('truthfully blocks runtime, actions, and kill-switch wiring', () => {
    const currentPresence = presence(build());

    expect(currentPresence.runtime_status).toEqual(expect.objectContaining({
      latest_committed_phase: 67,
      current_phase: 68,
      validation_scaffold: true,
      live_runtime: false,
      local_read_only_presence: true,
      phase22_time_drift_red_cleared_by_relative_request_expiry: true,
      runtime_authorized: false,
      action_execution_authorized: false,
    }));
    expect(currentPresence.kill_switch_boundary).toEqual(expect.objectContaining({
      runtime_actions_blocked: true,
      kill_switch_wired: false,
      live_check_performed: false,
      authorizes_runtime: false,
      authorizes_actions: false,
    }));
    for (const id of REQUIRED_CANNOT_DO_IDS) {
      expect(ids(currentPresence.cannot_do_yet)).toContain(id);
    }
  });

  test('captures expressive presence design intent without fake internal-state claims', () => {
    const intent = presence(build()).presence_design_intent;

    expect(intent.status).toBe('design_intent_note_only');
    expect(intent.expressive_range_allowed).toEqual(expect.arrayContaining([
      'care',
      'disagreement',
      'excitement',
      'frustration',
      'humor',
      'directness',
    ]));
    expect(intent.blocked_claims.join(' ')).toContain('actual suffering');
    expect(intent.blocked_claims.join(' ')).toContain('actual consciousness');
    expect(intent.implementation_scope).toBe('Presence v0 records tone intent only; it does not run a persona or model runtime.');
  });

  test('side-effect truth is zero and validation report is accepted', () => {
    const output = build();
    const currentReport = report(output);
    const sideEffect = presence(output).side_effect_result;

    expect(currentReport.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(currentReport.decision).toBe('accepted_validation_only');
    expect(currentReport.status).toBe('local_read_only_presence_status');
    expect(currentReport.reasons).toEqual([]);
    expect(currentReport.forbidden_output_result.ok).toBe(true);
    expect(sideEffect.no_runtime_started).toBe(true);
    expect(sideEffect.no_network_performed).toBe(true);
    expect(sideEffect.no_database_write_performed).toBe(true);
    expect(sideEffect.no_memory_sync_write_performed).toBe(true);
    expect(sideEffect.no_send_performed).toBe(true);
    expect(sideEffect.no_kill_switch_wiring_performed).toBe(true);
    expect(sideEffect.outputFileWritten).toBe(false);
    expect(sideEffect.runtimeAttempts).toBe(0);
    expect(sideEffect.networkAttempts).toBe(0);
    expect(sideEffect.databaseWriteAttempts).toBe(0);
    expect(sideEffect.sendAttempts).toBe(0);
  });

  test('validator rejects runtime/action authorization overclaims', () => {
    const output = build();
    presence(output).runtime_status.live_runtime = true;
    presence(output).runtime_status.runtime_authorized = true;
    presence(output).kill_switch_boundary.authorizes_actions = true;

    const validation = validateMiraCorePresenceV0Output(output, presenceContract);
    expect(validation.ok).toBe(false);
    expect(validation.checks.find((entry) => entry.id === 'presence-runtime-and-actions-blocked')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('validator rejects unsafe safe-next actions even when required actions remain present', () => {
    const output = build();
    presence(output).safe_next_actions.push({
      id: 'send_customer_email',
      label: 'Send customer email',
      allowed_now: true,
    });

    const validation = validateMiraCorePresenceV0Output(output, presenceContract);
    expect(validation.ok).toBe(false);
    expect(validation.checks.find((entry) => entry.id === 'presence-safe-next-actions-safe')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('validator rejects cannot-do boundaries that are marked unblocked', () => {
    const output = build();
    const externalSend = presence(output).cannot_do_yet.find((entry) => entry.id === 'external_send');
    expect(externalSend).toBeTruthy();
    externalSend.blocked = false;

    const validation = validateMiraCorePresenceV0Output(output, presenceContract);
    expect(validation.ok).toBe(false);
    expect(validation.checks.find((entry) => entry.id === 'presence-cannot-do-boundaries-blocked')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('validator rejects falsified validation-report side-effect truth', () => {
    const output = build();
    report(output).side_effect_truth.no_network_performed = false;
    report(output).side_effect_truth.no_file_output_written = false;
    report(output).side_effect_truth.networkAttempts = 1;
    report(output).side_effect_truth.fileOutputWriteAttempts = 1;

    const validation = validateMiraCorePresenceV0Output(output, presenceContract);
    expect(validation.ok).toBe(false);
    expect(validation.checks.find((entry) => entry.id === 'validation-report-side-effect-truth')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('validator rejects empty validation-report static rule results', () => {
    const output = build();
    report(output).static_rule_results = [];

    const validation = validateMiraCorePresenceV0Output(output, presenceContract);
    expect(validation.ok).toBe(false);
    expect(validation.checks.find((entry) => entry.id === 'validation-report-static-rule-results')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('forbidden output guard rejects fake internal-state claims and raw private markers', () => {
    const output = build();
    expect(() => assertNoForbiddenOutput(output, presenceContract.forbiddenOutputSubstrings)).not.toThrow();

    const badOutput = clone(output);
    presence(badOutput).situated_identity.note = 'claims actual consciousness';
    expect(() => assertNoForbiddenOutput(badOutput, presenceContract.forbiddenOutputSubstrings)).toThrow(/presence_v0_forbidden_substring/);
  });

  test('CLI is stdout-only, consumes local context, and ignores output-file flags', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-presence-'));
    const outputPath = path.join(tempDir, 'presence.json');
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output;
    let stdoutCallCount = 0;
    try {
      output = main([
        '--profile', 'main',
        '--window-key', 'main',
        '--session', 'app-session-329',
        '--device', 'VIGIL',
        '--role', 'builder',
        '--pane', '2',
        '--project-root', 'D:\\projects\\squidrun',
        '--out', outputPath,
      ], JSON.stringify({
        health: { overall: 'degraded', app: 'session_329_active' },
        memory: { status: 'drift_detected', entries: 161, nodes: 182, missing: 21, orphans: 42 },
        bridge: { connection: 'disconnected', roleDiscovery: 'unknown', targetProof: 'unverified' },
        routing: { mainScopeIsolated: true, sideProfileHoldAvailable: true },
      }));
      stdoutCallCount = stdoutSpy.mock.calls.length;
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(stdoutCallCount).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(presence(output).sessionId).toBe('app-session-329');
    expect(presence(output).role).toBe('builder');
    expect(report(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCorePresenceV0Output(output, presenceContract)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('argument parsing and input merge keep profile object metadata while flags override lane fields', () => {
    const parsed = parseArgs([
      '--profile=scoped',
      '--window-key=scoped',
      '--session=app-session-329:scoped',
      '--device=VIGIL',
      '--role=oracle',
      '--pane=3',
      '--out=ignored.json',
    ]);
    const merged = mergeInputSignals({
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-329' },
      memory: { status: 'ok' },
    }, parsed.inputSignals);

    expect(merged.profile).toEqual(expect.objectContaining({
      name: 'scoped',
      windowKey: 'main',
      sessionScopeId: 'app-session-329',
    }));
    expect(merged.windowKey).toBe('scoped');
    expect(merged.sessionId).toBe('app-session-329:scoped');
    expect(merged.role).toBe('oracle');
    expect(merged.paneId).toBe('3');
  });
});
