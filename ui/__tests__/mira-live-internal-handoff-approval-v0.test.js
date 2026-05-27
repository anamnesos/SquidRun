'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildMiraLiveInternalHandoffPreviewV0,
} = require('../modules/mira-core/live-internal-handoff-preview-v0');
const {
  APPROVAL_SEND_CHANNEL,
  executeMiraInternalHandoffApprovalSendV0,
  sha256Text,
} = require('../modules/mira-core/live-internal-handoff-approval-v0');
const {
  registerMiraLocalTextUiSurfaceHandlers,
} = require('../modules/ipc/mira-local-text-ui-surface-handlers');

const ARCHITECT_147_BODY = '(ARCHITECT #147): New current-session task: approval-controlled internal handoff send checkpoint. User said `Keep going`. Objective: extend Mira\'s internal handoff preview into a strictly explicit approval path that can send the reviewed Builder/Oracle handoff internally, while ordinary Mira text remains preview-only. Requirements: default path still no hm-send/no runtime POST/no external action; dispatch only from a separate explicit approval action/token bound to the exact preview id/hash, target, body, session/profile/window, and current HEAD/proof state; internal targets only (`builder` or `oracle`); no Telegram/voice/A4/external action; stale/edited/wrong-target/wrong-window/replayed approvals rejected; duplicate send prevented; proof records source refs, approval id, target, body hash, and send result; tests cover no-send default, approval sends exactly once to correct internal target, replay rejected, stale preview rejected, and counters/effects separated. Return smallest patch/proof or blocker.';

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-handoff-approval-'));
}

function row(overrides = {}) {
  return {
    messageId: overrides.messageId || 'm-row',
    sessionId: 'app-session-382',
    senderRole: overrides.senderRole || 'architect',
    targetRole: overrides.targetRole || 'builder',
    direction: 'outbound',
    status: 'routed',
    ackStatus: 'routed_unverified_timeout',
    brokeredAtMs: overrides.brokeredAtMs || Date.parse('2026-05-27T08:45:00.000Z'),
    rawBody: overrides.rawBody || '',
    metadata: { windowKey: 'main' },
  };
}

function handoffRows() {
  return [
    row({
      messageId: 'architect-143',
      brokeredAtMs: Date.parse('2026-05-27T07:12:30.000Z'),
      rawBody: '(ARCHITECT #143): Commit proof checked independently. Official progress is now 73% BLOCKED; preview-only handoff works with no dispatch/model/network/write effects; A3/A4 and voice remain blocked. No further Builder action pending unless Oracle objects.',
    }),
    row({
      messageId: 'architect-147',
      brokeredAtMs: Date.parse('2026-05-27T08:44:00.000Z'),
      rawBody: ARCHITECT_147_BODY,
    }),
  ];
}

function progressReport(overrides = {}) {
  return {
    computed_total_percent: 73,
    status: 'BLOCKED',
    warnings: [],
    canonical_hash: 'sha256:progress-570b05b9',
    source_refs: {
      head: {
        short_sha: '570b05b9',
        committed_at: '2026-05-27T07:10:03.000Z',
      },
      progress_proof_inputs: {
        source_ref: '.squidrun/runtime/mira-progress-proof-inputs-v0.json',
        status: 'loaded',
        canonical_hash: 'sha256:proof-570b05b9',
      },
    },
    categories: [
      {
        id: 'restart_current_scope_continuity',
        computed_percent: 100,
        status: 'PASS',
      },
      {
        id: 'team_coordination_arms',
        computed_percent: 40,
        status: 'BLOCKED',
        blocker_markers: ['a3_a4_blocked: A3/A4 arm authority remains blocked.'],
      },
      {
        id: 'voice_transport',
        computed_percent: 0,
        status: 'BLOCKED',
      },
    ],
    ...overrides,
  };
}

function approvalMetadata(overrides = {}) {
  return {
    sessionId: 'app-session-382',
    profileName: 'main',
    windowKey: 'main',
    sourceScope: 'main',
    ...overrides,
  };
}

function buildPreview(options = {}) {
  return buildMiraLiveInternalHandoffPreviewV0({
    promptText: options.promptText || 'approval-ready Builder handoff preview',
    metadata: approvalMetadata(),
  }, {
    nowMs: Date.parse('2026-05-27T08:45:00.000Z'),
    commsRows: handoffRows(),
    progressReport: progressReport(),
    progressProofArtifactHash: 'sha256:proof-570b05b9',
  });
}

function approvalInput(preview, overrides = {}) {
  return {
    approvalToken: preview.approval_gate.approval_token,
    approvalId: preview.approval_gate.approval_id,
    preview,
    targetAgent: preview.target_agent,
    draftBody: preview.draft_body,
    metadata: approvalMetadata(),
    ...overrides,
  };
}

describe('Mira live internal handoff approval v0', () => {
  test('preview remains no-send by default while exposing an explicit approval action token', () => {
    const preview = buildPreview();

    expect(preview.ok).toBe(true);
    expect(preview.decision).toBe('preview_ready_no_dispatch');
    expect(preview.preview_id).toMatch(/^mira-internal-handoff-preview-/);
    expect(preview.preview_hash).toMatch(/^sha256:/);
    expect(preview.approval_gate).toEqual(expect.objectContaining({
      required_before_dispatch: true,
      dispatch_enabled: false,
      channel: APPROVAL_SEND_CHANNEL,
      preview_id: preview.preview_id,
      approval_id: expect.stringMatching(/^mira-internal-handoff-approval-/),
      approval_token: expect.stringMatching(/^mira-internal-handoff-approval-/),
      binding: expect.objectContaining({
        target_agent: 'builder',
        body_hash: sha256Text(preview.draft_body),
        session: {
          session_id: 'app-session-382',
          profile_name: 'main',
          window_key: 'main',
          source_scope: 'main',
        },
      }),
    }));
    expect(preview.no_effects).toEqual(expect.objectContaining({
      hm_send_count: 0,
      send_count: 0,
      runtime_post_count: 0,
      model_call_count: 0,
      network_count: 0,
      write_count: 0,
      dispatch_count: 0,
    }));
  });

  test('explicit approval sends exactly once to the bound internal target and records proof', async () => {
    const projectRoot = tempProject();
    const preview = buildPreview();
    const sendInternalMessage = jest.fn(async (target, body, metadata) => ({
      ok: true,
      status: 'sent',
      transport: 'hm-send',
      message_id: 'mock-send-1',
      target,
      body_hash: sha256Text(body),
      approval_id: metadata.approval_id,
    }));

    try {
      const result = await executeMiraInternalHandoffApprovalSendV0(approvalInput(preview), {
        projectRoot,
        currentProgressReport: progressReport(),
        progressProofArtifactHash: 'sha256:proof-570b05b9',
        nowMs: Date.parse('2026-05-27T08:46:00.000Z'),
        sendInternalMessage,
      });

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        decision: 'sent_internal_handoff_once',
        sent: true,
        target_agent: 'builder',
        approval_id: preview.approval_gate.approval_id,
        preview_id: preview.preview_id,
        body_hash: sha256Text(preview.draft_body),
      }));
      expect(sendInternalMessage).toHaveBeenCalledTimes(1);
      expect(sendInternalMessage.mock.calls[0][0]).toBe('builder');
      expect(sendInternalMessage.mock.calls[0][1]).toBe(preview.draft_body);
      expect(sendInternalMessage.mock.calls[0][2]).toEqual(expect.objectContaining({
        approval_id: preview.approval_gate.approval_id,
        preview_id: preview.preview_id,
        body_hash: sha256Text(preview.draft_body),
        internal_only: true,
      }));
      expect(result.side_effect_counters).toEqual(expect.objectContaining({
        hm_send_count: 1,
        internal_send_count: 1,
        external_send_count: 0,
        runtime_post_count: 0,
        model_call_count: 0,
        write_count: 1,
        approval_record_write_count: 1,
      }));
      expect(fs.existsSync(result.proof_record_path)).toBe(true);
      const proof = JSON.parse(fs.readFileSync(result.proof_record_path, 'utf8'));
      expect(proof).toEqual(expect.objectContaining({
        approval_id: preview.approval_gate.approval_id,
        target_agent: 'builder',
        body_hash: sha256Text(preview.draft_body),
      }));
      expect(proof.source_refs).toEqual(expect.arrayContaining([
        'architect#147',
        'HEAD:570b05b9',
        '.squidrun/runtime/mira-progress-proof-inputs-v0.json',
      ]));
      expect(proof.send_result).toEqual(expect.objectContaining({
        ok: true,
        message_id: 'mock-send-1',
      }));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('replayed approval is rejected and does not send again', async () => {
    const projectRoot = tempProject();
    const preview = buildPreview();
    const sendInternalMessage = jest.fn(async () => ({ ok: true, status: 'sent' }));

    try {
      const first = await executeMiraInternalHandoffApprovalSendV0(approvalInput(preview), {
        projectRoot,
        currentProgressReport: progressReport(),
        progressProofArtifactHash: 'sha256:proof-570b05b9',
        nowMs: Date.parse('2026-05-27T08:46:00.000Z'),
        sendInternalMessage,
      });
      const replay = await executeMiraInternalHandoffApprovalSendV0(approvalInput(preview), {
        projectRoot,
        currentProgressReport: progressReport(),
        progressProofArtifactHash: 'sha256:proof-570b05b9',
        nowMs: Date.parse('2026-05-27T08:47:00.000Z'),
        sendInternalMessage,
      });

      expect(first.ok).toBe(true);
      expect(replay).toEqual(expect.objectContaining({
        ok: false,
        decision: 'rejected_replayed_approval',
        sent: false,
      }));
      expect(sendInternalMessage).toHaveBeenCalledTimes(1);
      expect(replay.side_effect_counters.hm_send_count).toBe(0);
      expect(replay.side_effect_counters.write_count).toBe(0);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('stale, edited, wrong-target, and wrong-window approvals are rejected before send', async () => {
    const projectRoot = tempProject();
    const preview = buildPreview();

    const cases = [
      {
        label: 'stale proof state',
        input: approvalInput(preview),
        options: {
          currentProgressReport: progressReport({
            source_refs: {
              ...progressReport().source_refs,
              head: { short_sha: '99999999', committed_at: '2026-05-27T09:00:00.000Z' },
              progress_proof_inputs: progressReport().source_refs.progress_proof_inputs,
            },
          }),
        },
        decision: 'rejected_stale_preview',
      },
      {
        label: 'edited body',
        input: approvalInput(preview, { draftBody: `${preview.draft_body}\nEdited after approval.` }),
        options: { currentProgressReport: progressReport() },
        decision: 'rejected_body_hash_mismatch',
      },
      {
        label: 'wrong target',
        input: approvalInput(preview, { targetAgent: 'oracle' }),
        options: { currentProgressReport: progressReport() },
        decision: 'rejected_target_mismatch',
      },
      {
        label: 'wrong trusted window',
        input: approvalInput(preview, { metadata: approvalMetadata() }),
        trustedMetadata: approvalMetadata({ windowKey: 'side-window' }),
        requireTrustedMetadata: true,
        options: { currentProgressReport: progressReport() },
        decision: 'rejected_session_binding_mismatch',
      },
    ];

    try {
      for (const item of cases) {
        const sendInternalMessage = jest.fn(async () => ({ ok: true, status: 'sent' }));
        const result = await executeMiraInternalHandoffApprovalSendV0(item.input, {
          projectRoot: path.join(projectRoot, item.label.replace(/\s+/g, '-')),
          progressProofArtifactHash: 'sha256:proof-570b05b9',
          nowMs: Date.parse('2026-05-27T08:46:00.000Z'),
          sendInternalMessage,
          trustedMetadata: item.trustedMetadata,
          requireTrustedMetadata: item.requireTrustedMetadata,
          ...item.options,
        });

        expect(result.decision).toBe(item.decision);
        expect(result.sent).toBe(false);
        expect(sendInternalMessage).not.toHaveBeenCalled();
        expect(result.side_effect_counters).toEqual(expect.objectContaining({
          hm_send_count: 0,
          internal_send_count: 0,
          external_send_count: 0,
          runtime_post_count: 0,
          model_call_count: 0,
          write_count: 0,
        }));
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('expired preview is rejected before send', async () => {
    const projectRoot = tempProject();
    const preview = buildPreview();
    const sendInternalMessage = jest.fn(async () => ({ ok: true, status: 'sent' }));

    try {
      const result = await executeMiraInternalHandoffApprovalSendV0(approvalInput(preview), {
        projectRoot,
        currentProgressReport: progressReport(),
        progressProofArtifactHash: 'sha256:proof-570b05b9',
        nowMs: Date.parse('2026-05-27T09:30:00.000Z'),
        sendInternalMessage,
      });

      expect(result.decision).toBe('rejected_stale_preview');
      expect(result.sent).toBe(false);
      expect(sendInternalMessage).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('IPC handler sends once through sendAgentMessage adapter with trusted event metadata', async () => {
    const projectRoot = tempProject();
    const preview = buildPreview();
    const registered = new Map();
    const ipcMain = {
      handle: jest.fn((channel, handler) => registered.set(channel, handler)),
      removeHandler: jest.fn((channel) => registered.delete(channel)),
    };
    const sendAgentMessage = jest.fn(async (target, body, metadata) => ({
      accepted: true,
      queued: true,
      status: 'routed_unverified',
      messageId: 'agent-send-1',
      target,
      bodyHash: sha256Text(body),
      metadata,
    }));

    try {
      registerMiraLocalTextUiSurfaceHandlers({
        ipcMain,
        mainWindow: { webContents: { id: 101 } },
      }, {
        projectRoot,
        getSessionId: () => 'app-session-382',
        currentProgressReport: progressReport(),
        progressProofArtifactHash: 'sha256:proof-570b05b9',
        nowMs: Date.parse('2026-05-27T08:46:00.000Z'),
        sendAgentMessage,
      });

      const handler = registered.get(APPROVAL_SEND_CHANNEL);
      const result = await handler({ sender: { id: 101 } }, approvalInput(preview, {
        metadata: approvalMetadata({ windowKey: 'spoofed-window', sourceScope: 'spoofed-source' }),
      }));

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        decision: 'sent_internal_handoff_once',
        sent: true,
        target_agent: 'builder',
      }));
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);
      expect(sendAgentMessage.mock.calls[0][0]).toBe('builder');
      expect(sendAgentMessage.mock.calls[0][1]).toBe(preview.draft_body);
      expect(sendAgentMessage.mock.calls[0][2]).toEqual(expect.objectContaining({
        senderRole: 'mira',
        source: 'mira-internal-handoff-approval',
        approval_id: preview.approval_gate.approval_id,
        preview_id: preview.preview_id,
        body_hash: sha256Text(preview.draft_body),
        internal_only: true,
      }));
      expect(result.send_result).toEqual(expect.objectContaining({
        ok: true,
        status: 'sent',
        transport: 'sendAgentMessage',
        result: expect.objectContaining({
          accepted: true,
          queued: true,
          status: 'routed_unverified',
        }),
      }));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('IPC handler records failed send when sendAgentMessage reports window unavailable', async () => {
    const projectRoot = tempProject();
    const preview = buildPreview();
    const registered = new Map();
    const ipcMain = {
      handle: jest.fn((channel, handler) => registered.set(channel, handler)),
      removeHandler: jest.fn((channel) => registered.delete(channel)),
    };
    const sendAgentMessage = jest.fn(async () => ({
      accepted: false,
      queued: false,
      status: 'window_unavailable',
    }));

    try {
      registerMiraLocalTextUiSurfaceHandlers({
        ipcMain,
        mainWindow: { webContents: { id: 101 } },
      }, {
        projectRoot,
        getSessionId: () => 'app-session-382',
        currentProgressReport: progressReport(),
        progressProofArtifactHash: 'sha256:proof-570b05b9',
        nowMs: Date.parse('2026-05-27T08:46:00.000Z'),
        sendAgentMessage,
      });

      const handler = registered.get(APPROVAL_SEND_CHANNEL);
      const result = await handler({ sender: { id: 101 } }, approvalInput(preview));

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        decision: 'send_failed_recorded',
        reason: 'window_unavailable',
        sent: false,
        target_agent: 'builder',
      }));
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);
      expect(result.send_result).toEqual(expect.objectContaining({
        ok: false,
        status: 'window_unavailable',
        transport: 'sendAgentMessage',
        result: expect.objectContaining({
          accepted: false,
          queued: false,
          status: 'window_unavailable',
        }),
      }));
      expect(result.side_effect_counters).toEqual(expect.objectContaining({
        hm_send_count: 0,
        internal_send_count: 0,
        write_count: 1,
        approval_record_write_count: 1,
      }));
      expect(fs.existsSync(result.proof_record_path)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('IPC handler rejects spoofed payload metadata when trusted sender metadata is missing', async () => {
    const projectRoot = tempProject();
    const preview = buildPreview();
    const registered = new Map();
    const ipcMain = {
      handle: jest.fn((channel, handler) => registered.set(channel, handler)),
      removeHandler: jest.fn((channel) => registered.delete(channel)),
    };
    const sendAgentMessage = jest.fn(async () => ({ ok: true }));

    try {
      registerMiraLocalTextUiSurfaceHandlers({
        ipcMain,
        mainWindow: { webContents: { id: 101 } },
      }, {
        projectRoot,
        getSessionId: () => 'app-session-382',
        currentProgressReport: progressReport(),
        progressProofArtifactHash: 'sha256:proof-570b05b9',
        nowMs: Date.parse('2026-05-27T08:46:00.000Z'),
        sendAgentMessage,
      });

      const handler = registered.get(APPROVAL_SEND_CHANNEL);
      const result = await handler({ sender: { id: 202 } }, approvalInput(preview, {
        metadata: approvalMetadata(),
      }));

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        decision: 'rejected_untrusted_approval_context',
        sent: false,
      }));
      expect(sendAgentMessage).not.toHaveBeenCalled();
      expect(result.side_effect_counters.hm_send_count).toBe(0);
      expect(result.side_effect_counters.write_count).toBe(0);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
