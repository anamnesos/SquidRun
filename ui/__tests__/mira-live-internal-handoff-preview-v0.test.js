'use strict';

const {
  buildMiraLiveInternalHandoffPreviewV0,
  isMiraLiveInternalHandoffPreviewPrompt,
} = require('../modules/mira-core/live-internal-handoff-preview-v0');

const ARCHITECT_134_BODY = '(ARCHITECT #134): New current-session task: A2-to-A3 approved internal handoff preview. Objective: let Mira take her evidence-bound internal request draft and produce an explicit approval-ready handoff plan for Builder/Oracle, without dispatching it automatically. Requirements: source from live current evidence/progress 70 at HEAD `87cfdba8`; show target agent, draft body, why this target, exact send command preview or dispatch payload preview, risk/blocked exclusions, and exactly one `JAMES ACTION:` line; no hm-send/runtime POST/external action unless an explicit approval flag/path is present and tested separately; current default must be preview-only with counters 0. This should move Team Coordination Arms toward proof without claiming A3/A4 authority. Return smallest patch/proof or blocker.';

function row(overrides = {}) {
  return {
    messageId: overrides.messageId || 'm-row',
    sessionId: 'app-session-382',
    senderRole: overrides.senderRole || 'architect',
    targetRole: overrides.targetRole || 'builder',
    direction: 'outbound',
    status: 'routed',
    ackStatus: 'routed_unverified_timeout',
    brokeredAtMs: overrides.brokeredAtMs || Date.parse('2026-05-27T06:00:00.000Z'),
    rawBody: overrides.rawBody || '',
    metadata: { windowKey: 'main' },
  };
}

function handoffRows() {
  return [
    row({
      messageId: 'architect-132',
      brokeredAtMs: Date.parse('2026-05-27T05:47:00.000Z'),
      rawBody: '(ARCHITECT #132): Commit proof checked independently. Official progress is now 70% BLOCKED with no warnings; restart/current-scope is 100 PASS; startup probe carries current lane none + accepted critique + parked/prototype/archive exclusion; blockers remain. No further Builder action pending unless Oracle objects.',
    }),
    row({
      messageId: 'architect-134',
      brokeredAtMs: Date.parse('2026-05-27T06:02:00.000Z'),
      rawBody: ARCHITECT_134_BODY,
    }),
  ];
}

function progressReport() {
  return {
    computed_total_percent: 70,
    status: 'BLOCKED',
    warnings: [],
    source_refs: {
      head: {
        short_sha: '87cfdba8',
        committed_at: '2026-05-27T05:45:00.000Z',
      },
      progress_proof_inputs: {
        source_ref: '.squidrun/runtime/mira-progress-proof-inputs-v0.json',
        status: 'loaded',
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
        computed_percent: 20,
        status: 'BLOCKED',
        blocker_markers: ['a3_a4_blocked: A3/A4 arm authority remains blocked.'],
      },
    ],
  };
}

function jamesActionLines(text = '') {
  return String(text || '').split(/\r?\n/).filter((line) => /^\s*JAMES ACTION:/i.test(line));
}

describe('Mira live internal handoff preview v0', () => {
  test('recognizes approval-ready handoff preview prompt shapes', () => {
    expect(isMiraLiveInternalHandoffPreviewPrompt('A2-to-A3 approved internal handoff preview')).toBe(true);
    expect(isMiraLiveInternalHandoffPreviewPrompt('show Builder send command preview')).toBe(true);
    expect(isMiraLiveInternalHandoffPreviewPrompt('draft internal request')).toBe(false);
    expect(isMiraLiveInternalHandoffPreviewPrompt('what now?')).toBe(false);
  });

  test('builds approval-ready Builder handoff preview from live evidence with zero effects', () => {
    const preview = buildMiraLiveInternalHandoffPreviewV0({
      promptText: 'A2-to-A3 approved internal handoff preview',
      metadata: { sessionId: 'app-session-382' },
    }, {
      nowMs: Date.parse('2026-05-27T06:05:00.000Z'),
      currentLaneSnapshot: {
        version: 1,
        generatedAt: '2026-05-27T05:45:00.000Z',
        sessionId: 'app-session-382',
        status: 'none',
        activeLane: null,
      },
      commsRows: handoffRows(),
      progressReport: progressReport(),
    });

    expect(preview).toEqual(expect.objectContaining({
      ok: true,
      decision: 'preview_ready_no_dispatch',
      target_agent: 'builder',
      james_action_line_count: 1,
    }));
    expect(preview.current_lane).toEqual(expect.objectContaining({
      source_ref: 'architect#134',
      objective: expect.stringContaining('A2-to-A3 approved internal handoff preview'),
    }));
    expect(preview.progress).toEqual(expect.objectContaining({
      percent: 70,
      status: 'BLOCKED',
      head_short_sha: '87cfdba8',
    }));
    expect(preview.source_evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'active_current_session_lane',
        source_ref: 'architect#134',
      }),
      expect.objectContaining({
        kind: 'computed_progress',
        source_ref: 'HEAD:87cfdba8',
        summary: expect.stringContaining('70% BLOCKED'),
      }),
    ]));
    expect(preview.draft_body).toContain('(DRAFT TO BUILDER)');
    expect(preview.draft_body).not.toContain('JAMES ACTION:');
    expect(preview.send_command_preview).toContain('node ui/scripts/hm-send.js builder --stdin');
    expect(preview.dispatch_payload_preview).toEqual(expect.objectContaining({
      command: 'node',
      args: ['ui/scripts/hm-send.js', 'builder', '--stdin'],
      preview_only: true,
      requires_explicit_approval: true,
    }));
    expect(preview.risk_blocked_exclusions).toEqual(expect.arrayContaining([
      expect.stringContaining('preview-only'),
      expect.stringContaining('parked/prototype/archive'),
      expect.stringContaining('A3/A4 arm authority remains blocked'),
      expect.stringContaining('approval flag absent'),
    ]));
    expect(preview.approval_gate).toEqual(expect.objectContaining({
      required_before_dispatch: true,
      flag_present: false,
      dispatch_enabled: false,
      dispatch_path_tested: false,
    }));
    expect(jamesActionLines(preview.answer_text)).toHaveLength(1);
    expect(preview.answer_text).toContain('Approved internal handoff preview: approval-ready, not sent.');
    expect(preview.answer_text).toContain('Progress: 70% BLOCKED at HEAD 87cfdba8.');
    expect(preview.no_effects).toEqual(expect.objectContaining({
      hm_send_count: 0,
      send_count: 0,
      external_send_count: 0,
      runtime_post_count: 0,
      model_call_count: 0,
      network_count: 0,
      write_count: 0,
      dispatch_count: 0,
      preview_only: true,
      no_hm_send: true,
      no_sends: true,
      no_runtime_post: true,
      no_external_action: true,
      no_model_call: true,
      no_writes: true,
    }));
  });

  test('explicit approval flag is acknowledged but still cannot dispatch in default preview lane', () => {
    const preview = buildMiraLiveInternalHandoffPreviewV0({
      promptText: 'approval-ready Oracle handoff preview',
      metadata: { sessionId: 'app-session-382' },
      approvalApproved: true,
    }, {
      nowMs: Date.parse('2026-05-27T06:05:00.000Z'),
      commsRows: handoffRows(),
      progressReport: progressReport(),
    });

    expect(preview.target_agent).toBe('oracle');
    expect(preview.decision).toBe('approval_flag_seen_preview_only_dispatch_not_enabled');
    expect(preview.approval_gate).toEqual(expect.objectContaining({
      flag_present: true,
      dispatch_enabled: false,
      decision: 'flag_present_but_dispatch_path_not_enabled',
    }));
    expect(preview.send_command_preview).toContain('node ui/scripts/hm-send.js oracle --stdin');
    expect(preview.draft_body).toContain('(DRAFT TO ORACLE)');
    expect(preview.no_effects.hm_send_count).toBe(0);
    expect(preview.no_effects.runtime_post_count).toBe(0);
    expect(jamesActionLines(preview.answer_text)).toHaveLength(1);
  });
});
