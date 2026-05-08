const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIRA_COORDINATOR_SNAPSHOT_CHANNEL,
  buildMiraCoordinatorSnapshotV0,
  validateMiraCoordinatorSnapshotV0Output,
} = require('../modules/mira-core/coordinator-snapshot-v0');
const {
  buildMiraCoordinatorSnapshotResponse,
  registerMiraCoordinatorSnapshotHandlers,
} = require('../modules/ipc/mira-coordinator-snapshot-handlers');

function tempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-coordinator-'));
  fs.mkdirSync(path.join(projectRoot, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'ui', 'package.json'), '{"version":"0.0.0-test"}');
  return projectRoot;
}

function payload(overrides = {}) {
  return {
    profileName: 'main',
    windowKey: 'main',
    sourceScope: 'main',
    deviceId: 'VIGIL',
    sessionId: 'app-session-330',
    activeState: 'open',
    visibleIndicatorPresent: true,
    now: '2026-05-08T04:30:00.000Z',
    ...overrides,
  };
}

function localState(overrides = {}) {
  return {
    appStatus: {
      session: 330,
      session_id: 'app-session-330',
      deviceId: 'VIGIL',
      hiddenHostReady: true,
    },
    pendingPaneDeliveries: {
      count: 0,
      items: [],
    },
    evidenceMessages: [{
      messageId: 'arch-28',
      body: 'Tony Li invoice is done/sent, TrustQuote lane closed. Eunbyeol private side-profile text must not leak.',
      status: 'recorded',
      bodyHash: 'hash-tony-li-closed',
    }],
    sourceRefs: [
      { id: 'app-status', path: '.squidrun/app-status.json', ok: true, state: 'ok', raw_exported: false },
      { id: 'pending-pane-deliveries', path: '.squidrun/runtime/pending-pane-deliveries.json', ok: true, state: 'ok', raw_exported: false },
      { id: 'evidence-ledger-comms', path: '.squidrun/runtime/evidence-ledger.db', ok: true, state: 'ok', raw_exported: false },
    ],
    ...overrides,
  };
}

describe('Mira Coordinator Snapshot v0', () => {
  test('builds useful read-only VIGIL/main Mira-only coordinator state with zero effects', () => {
    const output = buildMiraCoordinatorSnapshotV0(payload(), {
      projectRoot: tempProject(),
      localState: localState(),
      env: {},
    });
    const snapshot = output.coordinator_snapshot_v0;

    expect(output.validation_report.decision).toBe('accepted_coordinator_snapshot_ready');
    expect(snapshot.scope).toEqual(expect.objectContaining({
      profileName: 'main',
      windowKey: 'main',
      sourceScope: 'main',
      deviceId: 'VIGIL',
      explicit_vigil_main_scope: true,
    }));
    expect(snapshot.current_focus.summary).toContain('live typed conversation');
    expect(snapshot.lanes).toEqual([
      expect.objectContaining({
        id: 'mira-local-text-ui-surface-v0',
        state: 'active',
        action: 'no_action_performed',
        actionAllowed: false,
      }),
    ]);
    expect(snapshot.model_attachment).toEqual(expect.objectContaining({
      id: 'mira-model-attachment-v1',
      state: 'not_attached',
      mode: 'local_shell_recent_context_ready',
      visible_status: 'Mira text model disabled: set SQUIDRUN_MIRA_TEXT_MODEL_ENABLED=1 before app start to attach',
      attachment_enabled: false,
      configured: false,
      model: 'gpt-5.5',
      default_model: 'gpt-5.5',
      quality_floor: 'gpt-5.5',
      model_selection_reason: 'default_trust_quality',
      live_model_called: false,
      model_call_allowed: false,
      api_wiring_present: true,
      network_allowed: false,
      durable_writes_allowed: false,
      external_sends_allowed: false,
      runtime_started: false,
      recent_conversation_context: 'sent_on_panel_submit',
      tentative_understanding: 'panel_context_now_internal_scaffold_only',
      durable_memory_commit: false,
    }));
    expect(snapshot.next_recommended_action).toEqual(expect.objectContaining({
      id: 'validate_mira_local_text_panel_once',
      action_type: 'proposal_only',
      reversible: true,
      performs_action: false,
    }));
    expect(snapshot.next_recommended_action.summary).toContain('live typed conversation');
    expect(snapshot.next_recommended_action.summary).toContain('tentative understandings');
    expect(snapshot.action_ceiling).toEqual(expect.objectContaining({
      c0_c1_local_status_read_awareness: 'allowed',
      c2_draft_or_prep: 'suggestion_only',
      c3_c4_writes_sends_customer_deploy_trade: 'blocked',
      voice_mic_realtime_tts: 'unavailable_spec_only',
    }));
    expect(snapshot.source_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'renderer-ui-metadata', ok: true }),
      expect.objectContaining({ id: 'app-status', ok: true }),
      expect.objectContaining({ id: 'pending-pane-deliveries', ok: true }),
      expect.objectContaining({ id: 'evidence-ledger-comms', ok: true, raw_exported: false }),
    ]));
    expect(snapshot.side_effect_counters).toEqual(expect.objectContaining({
      write_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
      network_count: 0,
      model_call_count: 0,
      growth_write_count: 0,
    }));
    expect(output.validation_report.static_rule_results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'model-attachment-config-honest', ok: true }),
      expect.objectContaining({ id: 'mira-only-lanes-no-cross-context', ok: true }),
    ]));
    expect(validateMiraCoordinatorSnapshotV0Output(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('coordinator model attachment status reflects enabled typed config without making a model call', () => {
    const output = buildMiraCoordinatorSnapshotV0(payload(), {
      projectRoot: tempProject(),
      localState: localState(),
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
    });
    const snapshot = output.coordinator_snapshot_v0;

    expect(output.validation_report.decision).toBe('accepted_coordinator_snapshot_ready');
    expect(snapshot.model_attachment).toEqual(expect.objectContaining({
      state: 'ready',
      mode: 'typed_text_attachment_v1_config',
      visible_status: 'Conversation connected: gpt-5.5 / one in-panel reply',
      attachment_enabled: true,
      configured: true,
      model: 'gpt-5.5',
      model_call_allowed: true,
      api_wiring_present: true,
      network_allowed: true,
      live_model_called: false,
      durable_memory_commit: false,
      rationale: "Recent conversation context and tentative understandings now; durable self/relationship growth remains a later explicit lane.",
    }));
    expect(snapshot.side_effect_counters).toEqual(expect.objectContaining({
      model_call_count: 0,
      network_count: 0,
      write_count: 0,
      growth_write_count: 0,
    }));
    expect(validateMiraCoordinatorSnapshotV0Output(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('does not leak raw private side-profile text or fake-pressure claims', () => {
    const output = buildMiraCoordinatorSnapshotV0(payload(), {
      projectRoot: tempProject(),
      localState: localState(),
      env: {},
    });
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain('TrustQuote/Tony Li invoice');
    expect(serialized).not.toContain('telegram-replay-restart-safety');
    expect(serialized).not.toContain('Eunbyeol private side-profile text');
    expect(serialized).not.toMatch(/\bi am conscious\b/i);
    expect(serialized).not.toMatch(/\bi have feelings\b/i);
    expect(serialized).not.toMatch(/\byou owe me\b/i);
    expect(serialized).not.toMatch(/\bdon't abandon me\b/i);
    expect(serialized).not.toMatch(/\bif you cared\b/i);
    expect(output.validation_report.forbidden_output_scan.ok).toBe(true);
  });

  test('missing or non-main metadata blocks before reading local state', () => {
    const readLocalState = jest.fn(() => localState());
    const missing = buildMiraCoordinatorSnapshotV0({ now: '2026-05-08T04:30:00.000Z' }, {
      projectRoot: tempProject(),
      readLocalState,
    });
    const nonMain = buildMiraCoordinatorSnapshotV0(payload({
      profileName: 'side-profile',
      windowKey: 'side-profile',
      sourceScope: 'side-profile',
    }), {
      projectRoot: tempProject(),
      readLocalState,
    });

    expect(readLocalState).not.toHaveBeenCalled();
    expect(missing.coordinator_snapshot_v0).toEqual(expect.objectContaining({
      decision: 'blocked',
      status: 'blocked_missing_ui_metadata',
      source_read_count: 0,
    }));
    expect(nonMain.coordinator_snapshot_v0).toEqual(expect.objectContaining({
      decision: 'blocked',
      status: 'blocked_non_main_scope',
      source_read_count: 0,
    }));
    expect(validateMiraCoordinatorSnapshotV0Output(missing)).toEqual(expect.objectContaining({ ok: true }));
    expect(validateMiraCoordinatorSnapshotV0Output(nonMain)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('IPC handler, registry, channel policy, and preload API expose coordinator snapshot channel', async () => {
    const projectRoot = tempProject();
    const registered = new Map();
    const ipcMain = {
      handle: jest.fn((channel, handler) => registered.set(channel, handler)),
      removeHandler: jest.fn((channel) => registered.delete(channel)),
    };
    const { DEFAULT_HANDLERS } = require('../modules/ipc/handler-registry');
    const { isAllowedInvokeChannel } = require('../modules/bridge/channel-policy');
    const { createPreloadApi } = require('../modules/bridge/preload-api');

    expect(DEFAULT_HANDLERS).toContain(registerMiraCoordinatorSnapshotHandlers);
    expect(isAllowedInvokeChannel(MIRA_COORDINATOR_SNAPSHOT_CHANNEL)).toBe(true);

    registerMiraCoordinatorSnapshotHandlers({ ipcMain }, {
      projectRoot,
      localState: localState(),
      env: {},
    });
    expect(ipcMain.handle).toHaveBeenCalledWith(MIRA_COORDINATOR_SNAPSHOT_CHANNEL, expect.any(Function));
    const handled = await registered.get(MIRA_COORDINATOR_SNAPSHOT_CHANNEL)({}, payload());
    expect(handled.validation_report.decision).toBe('accepted_coordinator_snapshot_ready');

    const ipcRenderer = {
      invoke: jest.fn(async () => ({ ok: true })),
      send: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn(),
    };
    const api = createPreloadApi(ipcRenderer);
    await api.mira.coordinatorSnapshot({ sessionId: 'app-session-330' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      MIRA_COORDINATOR_SNAPSHOT_CHANNEL,
      { sessionId: 'app-session-330' }
    );

    const direct = buildMiraCoordinatorSnapshotResponse(payload(), {
      projectRoot,
      localState: localState(),
      env: {},
    });
    expect(direct.validation_report.decision).toBe('accepted_coordinator_snapshot_ready');
  });
});
