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
  test('builds useful read-only VIGIL/main coordinator state with closed lanes and zero effects', () => {
    const output = buildMiraCoordinatorSnapshotV0(payload(), {
      projectRoot: tempProject(),
      localState: localState(),
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
    expect(snapshot.current_focus.summary).toContain('local text panel');
    expect(snapshot.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'trustquote-tony-li-invoice',
        state: 'closed',
        action: 'no_action_performed',
        actionAllowed: false,
      }),
      expect.objectContaining({
        id: 'telegram-replay-restart-safety',
        state: 'closed',
        action: 'no_action_performed',
        actionAllowed: false,
      }),
    ]));
    expect(snapshot.next_recommended_action).toEqual(expect.objectContaining({
      id: 'validate_mira_local_text_panel_once',
      action_type: 'proposal_only',
      reversible: true,
      performs_action: false,
    }));
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
    expect(validateMiraCoordinatorSnapshotV0Output(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('does not leak raw private side-profile text or fake-pressure claims', () => {
    const output = buildMiraCoordinatorSnapshotV0(payload(), {
      projectRoot: tempProject(),
      localState: localState(),
    });
    const serialized = JSON.stringify(output);

    expect(serialized).toContain('TrustQuote/Tony Li invoice');
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
    });
    expect(direct.validation_report.decision).toBe('accepted_coordinator_snapshot_ready');
  });
});
