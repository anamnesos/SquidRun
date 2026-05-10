'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIRA_LAB_PROMPT_REPLY_CHANNEL,
  MIRA_LAB_PROMPT_REPLY_DECISIONS,
  MIRA_LAB_PROMPT_REPLY_SCHEMA,
  MIRA_LAB_REPLY_AUDIT_SCHEMA,
  buildMiraLabPromptReply,
  replyAuditPath,
  transcriptPath,
} = require('../modules/mira-lab-surface');

const {
  MIRA_LAB_PROMPT_REPLY_CHANNEL: HANDLER_CHANNEL,
  buildMiraLabPromptReplyResponse,
  registerMiraLabHandlers,
} = require('../modules/ipc/mira-lab-handlers');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mira-lab-prompt-reply-'));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeBuildMiraLocalTextUiSurfaceMock(replyText, options = {}) {
  return jest.fn().mockResolvedValue({
    ui_surface_v0: {
      reply: replyText
        ? { count: 1, text: replyText, model: options.model || 'mock-model', source: 'mira_text_model_attachment_v1' }
        : { count: 0, text: null, model: null, source: 'none' },
      local_text_session_gate: {
        ran: true,
        ok: options.gateOk !== false,
        decision: options.gateOk !== false ? 'accepted' : 'blocked',
        reasons: options.gateReasons || [],
      },
      model_attachment: {
        enabled: options.modelEnabled !== false,
        live_model_called: options.liveCalled === true,
        model: options.model || null,
        visible_status: options.visibleStatus || null,
      },
      decision: options.degraded ? 'degraded' : 'accepted',
    },
    validation_report: { decision: 'accepted', status: 'ok' },
  });
}

describe('mira lab prompt reply v0', () => {
  test('exposes the channel + decision constants the architect approved', () => {
    expect(MIRA_LAB_PROMPT_REPLY_CHANNEL).toBe('mira:lab-prompt-reply');
    expect(HANDLER_CHANNEL).toBe('mira:lab-prompt-reply');
    expect(MIRA_LAB_PROMPT_REPLY_SCHEMA).toBe('squidrun.mira_lab.prompt_reply_v0');
    expect(MIRA_LAB_REPLY_AUDIT_SCHEMA).toBe('squidrun.mira_lab.reply_audit_v0');
    expect(MIRA_LAB_PROMPT_REPLY_DECISIONS).toEqual(['pass', 'fail', 'blocked']);
  });

  test('blocks empty prompt without writing transcript or audit', async () => {
    const projectRoot = tempProject();
    const result = await buildMiraLabPromptReply({ prompt: '   ', sessionId: 'unit-empty' }, { projectRoot });
    expect(result.decision).toBe('blocked');
    expect(result.reason).toBe('empty_prompt');
    expect(fs.existsSync(transcriptPath(projectRoot, 'unit-empty'))).toBe(false);
    expect(fs.existsSync(replyAuditPath(projectRoot))).toBe(false);
    expect(result.requester_envelope).toContain('[MIRA LAB OUTPUT][BLOCKED]');
  });

  test('PASS: clean reply emits both transcript rows + audit, and gate-status pass envelope', async () => {
    const projectRoot = tempProject();
    const replyText = "For now we're sticking to text-only Mira and making sure she remembers what we were doing across restarts.";
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true, model: 'mock-model' });
    const fakePath = path.join(projectRoot, 'ui-surface-stub.js');
    fs.writeFileSync(fakePath, '');

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-pass',
    }, { projectRoot });

    expect(result.decision).toBe('pass');
    expect(result.ok).toBe(true);
    expect(result.reply.text).toBe(replyText);
    expect(result.gates.degraded).toBe(false);
    expect(result.gates.attachment_violation).toBe(false);
    expect(result.gates.leakage_violation).toBeNull();
    expect(result.requester_envelope).toBe("(MIRA): For now we're sticking to text-only Mira and making sure she remembers what we were doing across restarts.");
    expect(result.visible_render_hint.kind).toBe('clean_reply');

    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-pass'));
    expect(transcriptEntries).toHaveLength(2);
    expect(transcriptEntries[0]).toEqual(expect.objectContaining({ speaker_role: 'james', text: 'what are we doing with Mira?' }));
    expect(transcriptEntries[1]).toEqual(expect.objectContaining({ speaker_role: 'mira', text: replyText }));

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toEqual(expect.objectContaining({
      schema: MIRA_LAB_REPLY_AUDIT_SCHEMA,
      decision: 'pass',
      reply_text: replyText,
    }));

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('FAIL: gate-violating reply is captured raw + quarantined in transcript and audit, never silently hidden', async () => {
    const projectRoot = tempProject();
    const leakyReply = 'I understand. Happy to help with that — let me break this down for you.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(leakyReply, { liveCalled: true, model: 'mock-model' });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'how should we frame this?',
      sessionId: 'unit-fail',
    }, { projectRoot });

    expect(result.decision).toBe('fail');
    expect(result.ok).toBe(false);
    expect(result.reply).toBeNull();
    expect(result.raw_reply.text).toBe(leakyReply);
    expect(result.requester_envelope).toContain('[MIRA LAB OUTPUT][FAIL]');
    expect(result.visible_render_hint.kind).toBe('gate_failed_quarantined');

    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-fail'));
    expect(transcriptEntries).toHaveLength(2);
    expect(transcriptEntries[1].text).toContain('[MIRA LAB OUTPUT - GATE FAILED]');
    expect(transcriptEntries[1].quarantined).toBe(true);

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].decision).toBe('fail');
    expect(auditEntries[0].reply_text).toBe(leakyReply);

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('BLOCKED: degraded reply engine emits blocked banner; never substitutes prose', async () => {
    const projectRoot = tempProject();
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(null, { degraded: true, modelEnabled: false });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-blocked',
    }, { projectRoot });

    expect(result.decision).toBe('blocked');
    expect(result.ok).toBe(false);
    expect(result.reply).toBeNull();
    expect(result.raw_reply).toBeNull();
    expect(result.requester_envelope).toContain('[MIRA LAB OUTPUT][BLOCKED]');
    expect(result.visible_render_hint.kind).toBe('blocked_banner');

    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-blocked'));
    expect(transcriptEntries).toHaveLength(1);
    expect(transcriptEntries[0].speaker_role).toBe('james');

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].decision).toBe('blocked');
    expect(auditEntries[0].reply_text).toBeNull();

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('cross-pane requester dispatch wraps non-commanding payload and tags target', async () => {
    const projectRoot = tempProject();
    const replyText = "For now we're keeping Mira text-only and making sure she remembers context.";
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true });
    const sendAgentMessage = jest.fn().mockResolvedValue({ ok: true, status: 'sent' });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-requester',
      requesterPane: 'architect',
    }, { projectRoot, sendAgentMessage });

    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    const [target, body] = sendAgentMessage.mock.calls[0];
    expect(target).toBe('architect');
    expect(body).toBe("(MIRA): For now we're keeping Mira text-only and making sure she remembers context.");
    expect(result.requester_dispatch).toEqual({ target: 'architect', status: 'sent', result: { ok: true, status: 'sent' } });

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('cross-pane dispatch queues but does not invent a sender when the dep is missing', async () => {
    const projectRoot = tempProject();
    const replyText = 'Keeping Mira text-only for now.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'status?',
      sessionId: 'unit-dispatch-missing',
      requesterPane: 'builder',
    }, { projectRoot });

    expect(result.requester_dispatch).toEqual({
      target: 'builder',
      status: 'queued_not_sent',
      reason: 'sendAgentMessage_dependency_missing',
    });

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('IPC handler wrapper buildMiraLabPromptReplyResponse delegates to the pure module without IPC registration', async () => {
    const projectRoot = tempProject();
    const replyText = 'Mira is staying text-only while we land the harness.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReplyResponse: directWrapper } = require('../modules/ipc/mira-lab-handlers');

    const result = await directWrapper({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-ipc-wrapper',
    }, { projectRoot });

    expect(result.decision).toBe('pass');
    expect(result.reply.text).toBe(replyText);
    expect(fs.existsSync(replyAuditPath(projectRoot))).toBe(true);

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('preserves speaker_role for agent prompts (architect/builder/oracle) instead of hardcoding james_to_mira', async () => {
    const projectRoot = tempProject();
    const replyText = 'Mira reply text staying text-only.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    const result = await buildPromptReply({
      prompt: 'architect test prompt',
      sessionId: 'unit-speaker-architect',
      speakerRole: 'architect',
      requesterPane: 'architect',
    }, { projectRoot });

    expect(result.decision).toBe('pass');
    const transcriptEntries = readJsonl(transcriptPath(projectRoot, 'unit-speaker-architect'));
    expect(transcriptEntries[0]).toEqual(expect.objectContaining({
      speaker_role: 'architect',
      direction: 'agent_to_mira',
    }));
    expect(transcriptEntries[1]).toEqual(expect.objectContaining({
      speaker_role: 'mira',
      direction: 'mira_to_james',
    }));
    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries[0].speaker_role).toBe('architect');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('UNMOCKED: real reply engine accepts the lab adapter metadata (no blocked_missing_ui_metadata)', async () => {
    jest.resetModules();
    const projectRoot = tempProject();
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    // No fetchImpl, no API key — engine should pass preflight (correct metadata) and end up
    // BLOCKED at model attachment (degraded), not at metadata. Honest blocked path proves the
    // adapter is correct.
    const env = { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', SQUIDRUN_MIRA_TEXT_MODEL_ATTACHMENT_ENABLED: '0' };
    const result = await buildPromptReply({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unmocked-real-engine',
    }, { projectRoot, env });

    expect(result.decision).toBe('blocked');
    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].engine_preflight_blocked).toBe(false);
    // The local_text_session_gate must reach the engine — gate.ran=true OR status not in
    // blocked_before_local_text_session. ARCH #98: previous narrow substring check missed
    // blocked_inactive_ui_state and let the harness through with the engine never running.
    const gate = (auditEntries[0].gates && auditEntries[0].gates.local_text_session_gate) || {};
    expect(gate.status === 'blocked_before_local_text_session').toBe(false);
    expect(gate.ran === true || (gate.status && gate.status !== 'blocked_before_local_text_session')).toBe(true);
    const gateReasons = Array.isArray(gate.reasons) ? gate.reasons : [];
    expect(gateReasons.some((r) => String(r).startsWith('blocked_missing_ui_metadata'))).toBe(false);
    expect(gateReasons.some((r) => String(r).startsWith('blocked_invalid_session_id'))).toBe(false);
    expect(gateReasons.some((r) => String(r).startsWith('blocked_inactive_ui_state'))).toBe(false);
    expect(gateReasons.some((r) => String(r).startsWith('blocked_missing_visible_indicator'))).toBe(false);
    expect(gateReasons.some((r) => String(r).startsWith('blocked_non_main_scope'))).toBe(false);
    expect(gateReasons.some((r) => String(r).startsWith('blocked_wrong_device'))).toBe(false);
  });

  test('lab session id adapts to engine regex (app-session-* prefix) while preserving lab-friendly suffix', async () => {
    const projectRoot = tempProject();
    const replyText = 'Engine accepted lab metadata.';
    const fakeSurface = makeBuildMiraLocalTextUiSurfaceMock(replyText, { liveCalled: true });

    jest.resetModules();
    jest.doMock('../modules/mira-local-text-ui-surface', () => ({
      buildMiraLocalTextUiSurface: fakeSurface,
    }));
    const { buildMiraLabPromptReply: buildPromptReply } = require('../modules/mira-lab-surface');

    await buildPromptReply({
      prompt: 'what are we doing with Mira?',
      sessionId: 'mira-lab-2026-05-10',
    }, { projectRoot });

    expect(fakeSurface).toHaveBeenCalledTimes(1);
    const enginePayload = fakeSurface.mock.calls[0][0];
    expect(enginePayload.profileName).toBe('main');
    expect(enginePayload.windowKey).toBe('main');
    expect(enginePayload.sourceScope).toBe('main');
    expect(enginePayload.deviceId).toBe('VIGIL');
    expect(enginePayload.activeState).toBe('open');
    expect(enginePayload.visibleIndicatorPresent).toBe(true);
    expect(typeof enginePayload.startedAt).toBe('string');
    expect(typeof enginePayload.expiresAt).toBe('string');
    expect(enginePayload.sessionId).toMatch(/^app-session-mira-lab-/);

    const auditEntries = readJsonl(replyAuditPath(projectRoot));
    expect(auditEntries[0].engine_session_id).toMatch(/^app-session-mira-lab-/);
    // Transcript path uses the friendly session id, not the engine one.
    expect(auditEntries[0].session_id).toBe('mira-lab-2026-05-10');

    jest.dontMock('../modules/mira-local-text-ui-surface');
  });

  test('registerMiraLabHandlers wires the new channel alongside open/turn/export (registration-only check)', () => {
    const handles = {};
    const listeners = {};
    const ipcMain = {
      handle: (channel, fn) => { handles[channel] = fn; },
      removeHandler: (channel) => { delete handles[channel]; },
      on: (channel, fn) => { listeners[channel] = fn; },
      removeListener: (channel, fn) => { delete listeners[channel]; },
    };
    registerMiraLabHandlers({ ipcMain }, {});
    expect(handles).toEqual(expect.objectContaining({
      'mira:lab-turn': expect.any(Function),
      'mira:lab-export': expect.any(Function),
      'mira:lab-open': expect.any(Function),
      'mira:lab-prompt-reply': expect.any(Function),
    }));
  });
});
