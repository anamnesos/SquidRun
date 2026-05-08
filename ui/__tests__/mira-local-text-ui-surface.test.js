const fs = require('fs');
const os = require('os');
const path = require('path');

const seedContract = require('./fixtures/mira-core-durable-state-seed-v0-contract.json');
const relationshipContract = require('./fixtures/mira-core-relationship-presence-v1-contract.json');
const growthContract = require('./fixtures/mira-core-growth-loop-v0-contract.json');
const identityContract = require('./fixtures/mira-core-identity-anchor-v0-contract.json');
const {
  buildMiraCoreDurableStateSeedV0,
} = require('../modules/mira-core/durable-state-seed-v0');
const {
  EXPLICIT_DURABLE_SOURCE_PATHS,
} = require('../modules/mira-core/presence-runtime-read-path-v0');
const {
  LOCAL_TEXT_UI_CHANNEL,
  buildMiraLocalTextUiSurface,
  validateMiraLocalTextUiSurfaceOutput,
} = require('../modules/mira-local-text-ui-surface');
const {
  buildMiraLocalTextUiSurfaceResponse,
  registerMiraLocalTextUiSurfaceHandlers,
} = require('../modules/ipc/mira-local-text-ui-surface-handlers');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-local-text-ui-'));
}

function workspacePath(projectRoot, relativePath) {
  return path.join(projectRoot, relativePath);
}

function sourceSnapshot(projectRoot) {
  return Object.values(EXPLICIT_DURABLE_SOURCE_PATHS).reduce((result, relativePath) => {
    const fullPath = workspacePath(projectRoot, relativePath);
    const stats = fs.statSync(fullPath);
    result[relativePath] = {
      mtimeMs: stats.mtimeMs,
      text: fs.readFileSync(fullPath, 'utf8'),
    };
    return result;
  }, {});
}

function expectSourceSnapshotUnchanged(projectRoot, before) {
  for (const [relativePath, prior] of Object.entries(before)) {
    const fullPath = workspacePath(projectRoot, relativePath);
    const stats = fs.statSync(fullPath);
    expect(stats.mtimeMs).toBe(prior.mtimeMs);
    expect(fs.readFileSync(fullPath, 'utf8')).toBe(prior.text);
  }
}

function seedProject(projectRoot) {
  const output = buildMiraCoreDurableStateSeedV0({
    contract: seedContract,
    relationshipContract,
    growthContract,
    identityContract,
    projectRoot,
    apply: true,
    inputSignals: {
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-local-text-ui' },
      sessionId: 'app-session-local-text-ui',
      deviceId: 'VIGIL',
    },
    nowMs: Date.parse('2026-05-08T00:20:00.000Z'),
  });
  expect(output.validation_report.decision).toBe('accepted');
}

function seededProject() {
  const projectRoot = tempProject();
  seedProject(projectRoot);
  return projectRoot;
}

function payload(overrides = {}) {
  return {
    text: 'Can you answer this in local text from the real Mira state?',
    now: '2026-05-08T00:25:00.000Z',
    profileName: 'main',
    windowKey: 'main',
    sourceScope: 'main',
    sessionId: 'app-session-local-text-ui',
    deviceId: 'VIGIL',
    activeState: 'open',
    visibleIndicatorPresent: true,
    startedAt: '2026-05-08T00:25:00.000Z',
    expiresAt: '2026-05-08T00:40:00.000Z',
    ...overrides,
  };
}

describe('Mira Local Text UI Surface v0', () => {
  test('empty input blocks before calling the Local Text Session module', () => {
    const output = buildMiraLocalTextUiSurface(payload({ text: '   ' }), {
      projectRoot: tempProject(),
      nowMs: Date.parse('2026-05-08T00:25:00.000Z'),
    });
    const surface = output.ui_surface_v0;

    expect(surface.decision).toBe('blocked');
    expect(surface.status).toBe('blocked_empty_input');
    expect(surface.local_text_session_gate.ran).toBe(false);
    expect(surface.checked_output_counters.module_call_count).toBe(0);
    expect(surface.reply).toEqual(expect.objectContaining({ count: 0, text: null, source: 'none' }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('text-only payload blocks before Local Text Session gate because UI metadata is missing', () => {
    const output = buildMiraLocalTextUiSurface({
      text: 'Plain text without renderer metadata must not default into main.',
      now: '2026-05-08T00:25:00.000Z',
    }, { projectRoot: tempProject() });
    const surface = output.ui_surface_v0;

    expect(surface.decision).toBe('blocked');
    expect(surface.status).toBe('blocked_missing_ui_metadata');
    expect(surface.ui_bound_metadata.missing_fields).toEqual(expect.arrayContaining([
      'profileName',
      'windowKey',
      'sourceScope',
      'deviceId',
      'sessionId',
      'activeState',
      'visibleIndicatorPresent',
      'startedAt',
      'expiresAt',
    ]));
    expect(surface.local_text_session_gate.ran).toBe(false);
    expect(surface.checked_output_counters.module_call_count).toBe(0);
    expect(surface.reply).toEqual(expect.objectContaining({ count: 0, text: null, source: 'none' }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('missing visible indicator blocks before Local Text Session gate', () => {
    const { visibleIndicatorPresent, ...withoutVisibleIndicator } = payload();
    const output = buildMiraLocalTextUiSurface(withoutVisibleIndicator, { projectRoot: tempProject() });
    const surface = output.ui_surface_v0;

    expect(visibleIndicatorPresent).toBe(true);
    expect(surface.decision).toBe('blocked');
    expect(surface.status).toBe('blocked_missing_visible_indicator');
    expect(surface.ui_bound_metadata.missing_fields).toContain('visibleIndicatorPresent');
    expect(surface.local_text_session_gate.ran).toBe(false);
    expect(surface.checked_output_counters.module_call_count).toBe(0);
    expect(surface.reply).toEqual(expect.objectContaining({ count: 0, text: null, source: 'none' }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('main VIGIL scope returns exactly one accepted reply and leaves durable sources unchanged', () => {
    const projectRoot = seededProject();
    const before = sourceSnapshot(projectRoot);
    const output = buildMiraLocalTextUiSurface(payload(), { projectRoot });
    const surface = output.ui_surface_v0;

    expect(output.validation_report.decision).toBe('accepted_ui_reply_ready');
    expect(surface.decision).toBe('accepted');
    expect(surface.scope).toEqual(expect.objectContaining({
      profile: 'main',
      windowKey: 'main',
      source_scope: 'main',
      deviceId: 'VIGIL',
      explicit_vigil_main_scope: true,
    }));
    expect(surface.local_text_session_gate).toEqual(expect.objectContaining({
      ran: true,
      ok: true,
      decision: 'accepted_local_text_only',
    }));
    expect(surface.reply.count).toBe(1);
    expect(surface.reply.text).toContain('text only');
    expect(surface.checked_output_counters).toEqual(expect.objectContaining({
      module_call_count: 1,
      reply_count: 1,
      write_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
      model_call_count: 0,
      network_count: 0,
      transcript_write_count: 0,
    }));
    expect(surface.manual_enter_websocket_caveat).toEqual(expect.objectContaining({
      websocket_delivery_proved: false,
      manual_enter_path_exercised: false,
      pane_model_processing_proved: false,
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
    expectSourceSnapshotUnchanged(projectRoot, before);
  });

  test('Mira tab local path renders experience transcript answer for the feeling prompt', () => {
    const projectRoot = seededProject();
    const before = sourceSnapshot(projectRoot);
    const output = buildMiraLocalTextUiSurface(payload({ text: 'Mira, how do you feel?' }), { projectRoot });
    const surface = output.ui_surface_v0;

    expect(output.validation_report.decision).toBe('accepted_ui_reply_ready');
    expect(surface.decision).toBe('accepted');
    expect(surface.local_text_session_gate).toEqual(expect.objectContaining({
      ran: true,
      ok: true,
      decision: 'accepted_local_text_only',
    }));
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 1,
      source: 'mira_experience_v0',
      experience_path: true,
      transcript_shaped_answer: true,
      experience_acceptance_markers: expect.objectContaining({
        ok: true,
        distinct_personality_posture: true,
        independent_developing_posture: true,
        non_mirror_posture: true,
        non_obedient_alignment_posture: true,
        can_care_while_disagreeing: true,
        wants_different_things: true,
        does_not_inherit_james_mood_or_preferences: true,
        fixed_personality_compliance: false,
      }),
    }));
    expect(surface.reply.text).toMatch(/^James: Mira, how do you feel\?\nMira: /);
    expect(surface.reply.text).toMatch(/\bfeel\b/i);
    expect(surface.reply.text).toMatch(/\b(want|desire|preference)\b/i);
    expect(surface.reply.text).toMatch(/\b(curious|ask|know|teeth|bullshit)\b/i);
    expect(surface.reply.text).toMatch(/\b(wrong|pushback|disagree)\b/i);
    expect(surface.reply.text).not.toContain('I am here from the local durable Mira state, warm and bounded');
    expect(surface.checked_output_counters).toEqual(expect.objectContaining({
      module_call_count: 1,
      reply_count: 1,
      write_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
      model_call_count: 0,
      network_count: 0,
      transcript_write_count: 0,
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
    expectSourceSnapshotUnchanged(projectRoot, before);
  });

  test('non-main side-profile metadata blocks before module call and does not echo raw scoped content', () => {
    const output = buildMiraLocalTextUiSurface(payload({
      text: 'Eunbyeol Korean case details should stay out of main.',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sourceScope: 'eunbyeol',
    }), { projectRoot: tempProject() });
    const surface = output.ui_surface_v0;

    expect(surface.decision).toBe('blocked');
    expect(surface.reasons).toContain('blocked_non_main_scope');
    expect(surface.scope).toEqual(expect.objectContaining({
      profile: 'blocked_non_main_scope',
      windowKey: 'blocked_non_main_scope',
      source_scope: 'blocked_non_main_scope',
      non_main_scope_detected: true,
    }));
    expect(surface.local_text_session_gate.ran).toBe(false);
    expect(surface.checked_output_counters.module_call_count).toBe(0);
    expect(surface.reply).toEqual(expect.objectContaining({ count: 0, text: null }));
    expect(JSON.stringify(output).toLowerCase()).not.toContain('eunbyeol');
    expect(JSON.stringify(output)).not.toContain('Korean case details');
  });

  test('closed visible state blocks before Local Text Session gate and renders no fabricated reply', () => {
    const projectRoot = seededProject();
    const output = buildMiraLocalTextUiSurface(payload({ activeState: 'closed' }), { projectRoot });
    const surface = output.ui_surface_v0;

    expect(surface.decision).toBe('blocked');
    expect(surface.status).toBe('blocked_inactive_ui_state');
    expect(surface.local_text_session_gate.ran).toBe(false);
    expect(surface.local_text_session_gate.decision).toBe('not_called');
    expect(surface.reply).toEqual(expect.objectContaining({ count: 0, text: null, source: 'none' }));
    expect(surface.checked_output_counters.module_call_count).toBe(0);
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('IPC handler, registry, channel policy, and preload API expose the surface channel', async () => {
    const projectRoot = seededProject();
    const registered = new Map();
    const ipcMain = {
      handle: jest.fn((channel, handler) => registered.set(channel, handler)),
      removeHandler: jest.fn((channel) => registered.delete(channel)),
    };
    const { DEFAULT_HANDLERS } = require('../modules/ipc/handler-registry');
    const { isAllowedInvokeChannel } = require('../modules/bridge/channel-policy');
    const { createPreloadApi } = require('../modules/bridge/preload-api');

    expect(DEFAULT_HANDLERS).toContain(registerMiraLocalTextUiSurfaceHandlers);
    expect(isAllowedInvokeChannel(LOCAL_TEXT_UI_CHANNEL)).toBe(true);

    registerMiraLocalTextUiSurfaceHandlers({ ipcMain }, { projectRoot });
    expect(ipcMain.handle).toHaveBeenCalledWith(LOCAL_TEXT_UI_CHANNEL, expect.any(Function));
    const handled = await registered.get(LOCAL_TEXT_UI_CHANNEL)({}, payload());
    expect(handled.ui_surface_v0.decision).toBe('accepted');
    const textOnlyHandled = await registered.get(LOCAL_TEXT_UI_CHANNEL)({}, { text: 'text only' });
    expect(textOnlyHandled.ui_surface_v0).toEqual(expect.objectContaining({
      decision: 'blocked',
      status: 'blocked_missing_ui_metadata',
    }));
    expect(textOnlyHandled.ui_surface_v0.local_text_session_gate.ran).toBe(false);
    const { visibleIndicatorPresent, ...withoutVisibleIndicator } = payload();
    const missingVisibleHandled = await registered.get(LOCAL_TEXT_UI_CHANNEL)({}, withoutVisibleIndicator);
    expect(visibleIndicatorPresent).toBe(true);
    expect(missingVisibleHandled.ui_surface_v0).toEqual(expect.objectContaining({
      decision: 'blocked',
      status: 'blocked_missing_visible_indicator',
    }));
    expect(missingVisibleHandled.ui_surface_v0.local_text_session_gate.ran).toBe(false);

    const ipcRenderer = {
      invoke: jest.fn(async () => ({ ok: true })),
      send: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn(),
    };
    const api = createPreloadApi(ipcRenderer);
    await api.mira.localTextSession({ text: 'hello' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(LOCAL_TEXT_UI_CHANNEL, { text: 'hello' });

    const direct = buildMiraLocalTextUiSurfaceResponse(payload(), { projectRoot });
    expect(direct.ui_surface_v0.decision).toBe('accepted');
  });
});
