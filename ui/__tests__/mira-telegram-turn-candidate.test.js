'use strict';

/* global describe, expect, test */

const fs = require('fs');
const path = require('path');

const {
  CANDIDATE_PROTOCOL,
  buildNewMiraTelegramTurnCandidate,
} = require('../modules/mira-telegram-turn-candidate');
const {
  buildMiraDirectChannelStatusAnswerV0,
  countJamesActionLines,
  isMiraDirectChannelStatusPrompt,
} = require('../modules/mira-core/live-direct-channel-status-v0');

function ownerRoute(overrides = {}) {
  return {
    ok: true,
    chatId: '5613428850',
    windowKey: 'main',
    profile: 'main',
    reason: 'owner_chat',
    ...overrides,
  };
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
    brokeredAtMs: overrides.brokeredAtMs || Date.parse('2026-05-27T09:10:00.000Z'),
    rawBody: overrides.rawBody || '',
    metadata: { windowKey: 'main' },
  };
}

function progressReport() {
  return {
    computed_total_percent: 73,
    status: 'BLOCKED',
    warnings: [],
    source_refs: {
      head: {
        short_sha: '84d70b21',
        committed_at: '2026-05-27T09:07:12.000Z',
      },
      progress_proof_inputs: {
        source_ref: '.squidrun/runtime/mira-progress-proof-inputs-v0.json',
        status: 'loaded',
      },
    },
  };
}

describe('New Mira Telegram turn candidate dry-run', () => {
  test('builds a deterministic non-model turn candidate for main owner text only', () => {
    const result = buildNewMiraTelegramTurnCandidate({
      body: 'what are we doing next?',
      sender: 'james',
      metadata: {
        chatId: '5613428850',
        updateId: 150,
        messageId: 77,
      },
      inboundRoute: ownerRoute(),
      inboundSessionScopeId: 'app-session-377:main',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      protocol: CANDIDATE_PROTOCOL,
      status: 'new_mira_telegram_turn_candidate_ready',
      dryRun: true,
    }));
    expect(result.route).toEqual(expect.objectContaining({
      currentOwner: 'squidrun-telegram-guard-stack',
      reason: 'owner_chat',
      chatId: '5613428850',
      windowKey: 'main',
      profile: 'main',
      routeOwnerChange: false,
      liveRouteChanged: false,
    }));
    expect(result.candidate).toEqual({
      endpoint: '/turn',
      method: 'POST',
      body: {
        text: 'what are we doing next?',
        sessionId: 'app-session-377:main',
        messageId: 'telegram-in-150',
        requestId: 'telegram-in-150-new-mira-dry-run',
        useModel: false,
      },
    });
    expect(result.candidate.body).not.toHaveProperty('modelProvider');
    expect(result.candidate.body).not.toHaveProperty('modelName');
    expect(result.sideEffects).toEqual({
      telegramSendFunctionCall: false,
      liveTelegramSend: false,
      routeOwnerChange: false,
      runtimeExecutes: false,
      runtimeActions: false,
      toolsEnabled: false,
      sendsEnabled: false,
      store: false,
      modelInvoked: false,
      modelProviderCall: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
    });
  });

  test('recognizes Telegram status, what-now, and continue prompts for direct-channel status', () => {
    expect(isMiraDirectChannelStatusPrompt('status')).toBe(true);
    expect(isMiraDirectChannelStatusPrompt('Mira, what now?')).toBe(true);
    expect(isMiraDirectChannelStatusPrompt('Ok continue')).toBe(true);
    expect(isMiraDirectChannelStatusPrompt('/task continue')).toBe(false);
  });

  test('builds a plain direct-channel status answer from live evidence without route-owner change', () => {
    const result = buildMiraDirectChannelStatusAnswerV0({
      promptText: 'status',
      metadata: {
        channel: 'telegram',
        chatId: '5613428850',
        sessionId: 'app-session-382',
      },
      inboundRoute: ownerRoute(),
    }, {
      nowMs: Date.parse('2026-05-27T09:12:00.000Z'),
      progressReport: progressReport(),
      currentLaneSnapshot: {
        version: 1,
        generatedAt: '2026-05-27T09:08:00.000Z',
        sessionId: 'app-session-382',
        status: 'none',
        activeLane: null,
        continuity: {
          recent_completed_fixes: [{
            source_ref: 'builder#38',
            summary: 'Approved internal handoff send landed cleanly.',
          }],
          stale_backlog_markers: [],
        },
      },
      commsRows: [
        row({
          messageId: 'architect-160',
          brokeredAtMs: Date.parse('2026-05-27T09:09:00.000Z'),
          rawBody: '(ARCHITECT #160): ACK Builder #38. No Builder action pending unless Oracle objects.',
        }),
        row({
          messageId: 'architect-161',
          brokeredAtMs: Date.parse('2026-05-27T09:10:00.000Z'),
          rawBody: '(ARCHITECT #161): New current-session task: Direct Channel Reachability checkpoint. Objective: move the Direct Channel Reachability category from UNKNOWN toward proven by making the current James-facing channel path evidence-bound and understandable. Return a small patch/proof packet or blocker. No broad refactors.',
        }),
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      decision: 'answered_direct_channel_status_from_live_evidence',
      james_action_line_count: 1,
    }));
    expect(result.route).toEqual(expect.objectContaining({
      currentOwner: 'squidrun-telegram-guard-stack',
      miraOwnsTelegram: false,
      routeOwnerChange: false,
      liveRouteChanged: false,
      windowKey: 'main',
      profile: 'main',
    }));
    expect(result.current_lane).toEqual(expect.objectContaining({
      source_ref: 'architect#161',
      objective: expect.stringContaining('Direct Channel Reachability checkpoint'),
    }));
    expect(result.progress).toEqual(expect.objectContaining({
      percent: 73,
      status: 'BLOCKED',
      head_short_sha: '84d70b21',
      proof_source_ref: '.squidrun/runtime/mira-progress-proof-inputs-v0.json',
    }));
    expect(result.answer_text).toContain('Direct channel: Telegram is reachable through squidrun-telegram-guard-stack');
    expect(result.answer_text).toContain('official progress 73% BLOCKED at HEAD 84d70b21');
    expect(result.answer_text).toContain('Current lane: Direct Channel Reachability checkpoint');
    expect(result.answer_text).toContain('parked, prototype, archive');
    expect(result.answer_text).toContain('JAMES ACTION: NONE');
    expect(result.answer_text).not.toMatch(/\[(?:AGENT MSG|CURRENT PROJECT)\]|\((?:ARCHITECT|BUILDER|ORACLE)\s+#\d+\):/);
    expect(countJamesActionLines(result.answer_text)).toBe(1);
    expect(result.egress_integrity).toEqual(expect.objectContaining({
      telegram_chunk_count: 1,
      would_truncate_silently: false,
      internal_pane_labels_present: false,
    }));
    expect(result.no_effects).toEqual(expect.objectContaining({
      telegram_send_function_call: false,
      internal_handoff_send_count: 0,
      hm_send_count: 0,
      runtime_post_count: 0,
      model_call_count: 0,
      route_owner_change_count: 0,
      external_action_count: 0,
    }));
  });

  test('blocks direct-channel status answers for scoped/non-main Telegram routes', () => {
    const result = buildMiraDirectChannelStatusAnswerV0({
      promptText: 'continue',
      metadata: {
        channel: 'telegram',
        chatId: '2222222222',
        sessionId: 'app-session-382:scoped',
      },
      inboundRoute: ownerRoute({
        chatId: '2222222222',
        windowKey: 'scoped',
        profile: 'scoped',
        reason: 'explicit_non_owner_route',
      }),
    }, {
      progressReport: progressReport(),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      decision: 'blocked_non_main_or_unowned_direct_channel_route',
      reason: 'direct-channel status answers require the main owned Telegram route',
    }));
    expect(result.route).toEqual(expect.objectContaining({
      windowKey: 'scoped',
      profile: 'scoped',
      routeOwnerChange: false,
      liveRouteChanged: false,
    }));
    expect(result.no_effects).toEqual(expect.objectContaining({
      telegram_send_function_call: false,
      route_owner_change_count: 0,
      external_action_count: 0,
    }));
  });

  test.each([
    ['/task route this', 'telegram_agent_ops_or_command_excluded'],
    ['(ARCHITECT #1): route Builder this', 'telegram_agent_ops_or_command_excluded'],
    ['builder: patch this', 'telegram_agent_ops_or_command_excluded'],
    ['[AGENT MSG - reply via hm-send.js] (ARCHITECT #1): no', 'telegram_agent_ops_or_command_excluded'],
  ])('preserves command and agent-op exclusions for %s', (body, reason) => {
    const result = buildNewMiraTelegramTurnCandidate({
      body,
      metadata: { chatId: '5613428850', updateId: 151 },
      inboundRoute: ownerRoute(),
      inboundSessionScopeId: 'app-session-377:main',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'new_mira_telegram_candidate_blocked',
      reason,
      dryRun: true,
    }));
  });

  test('preserves media exclusions', () => {
    const result = buildNewMiraTelegramTurnCandidate({
      body: 'caption on this',
      metadata: {
        chatId: '5613428850',
        updateId: 152,
        media: { kind: 'photo' },
      },
      inboundRoute: ownerRoute(),
      inboundSessionScopeId: 'app-session-377:main',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'telegram_media_excluded',
      dryRun: true,
    }));
  });

  test('preserves scoped and non-owner route exclusions', () => {
    const scoped = buildNewMiraTelegramTurnCandidate({
      body: 'hello from a scoped chat',
      metadata: { chatId: '2222222222', updateId: 153 },
      inboundRoute: ownerRoute({
        chatId: '2222222222',
        windowKey: 'scoped',
        profile: 'scoped',
        reason: 'explicit_non_owner_route',
      }),
      inboundSessionScopeId: 'app-session-377:scoped',
    });
    const unknown = buildNewMiraTelegramTurnCandidate({
      body: 'hello from unknown chat',
      metadata: { chatId: '9999999999', updateId: 154 },
      inboundRoute: {
        ok: false,
        blocked: true,
        chatId: '9999999999',
        reason: 'unknown_non_owner_chat',
      },
      inboundSessionScopeId: 'app-session-377:main',
    });
    const missingOwner = buildNewMiraTelegramTurnCandidate({
      body: 'hello from default route',
      metadata: { chatId: null, updateId: 155 },
      inboundRoute: ownerRoute({
        chatId: null,
        reason: 'missing_chat_id_default_main',
      }),
      inboundSessionScopeId: 'app-session-377:main',
    });

    expect(scoped).toEqual(expect.objectContaining({
      ok: false,
      reason: 'telegram_inbound_route_not_main_owner',
      windowKey: 'scoped',
      profile: 'scoped',
    }));
    expect(unknown).toEqual(expect.objectContaining({
      ok: false,
      reason: 'telegram_inbound_route_blocked',
      routeReason: 'unknown_non_owner_chat',
    }));
    expect(missingOwner).toEqual(expect.objectContaining({
      ok: false,
      reason: 'telegram_owner_chat_required',
      routeReason: 'missing_chat_id_default_main',
    }));
  });

  test('stays dry-run by construction and does not import live send or runtime execution seams', () => {
    const modulePath = path.join(__dirname, '..', 'modules', 'mira-telegram-turn-candidate.js');
    const source = fs.readFileSync(modulePath, 'utf8');

    expect(source).toContain('resolveTelegramInboundRoute');
    expect(source).not.toContain('sendRoutedTelegramMessage');
    expect(source).not.toContain('sendTelegram');
    expect(source).not.toContain('runRuntimeTurn');
    expect(source).not.toContain('invokeTurnModel');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('appendRuntimeTurnJournal');
  });

  test('direct-channel status answer stays out of send, provider, and route-control seams', () => {
    const modulePath = path.join(__dirname, '..', 'modules', 'mira-core', 'live-direct-channel-status-v0.js');
    const source = fs.readFileSync(modulePath, 'utf8');

    expect(source).not.toContain('sendRoutedTelegramMessage');
    expect(source).not.toContain('sendTelegram(');
    expect(source).not.toContain('sendAgentMessage');
    expect(source).not.toContain('runRuntimeTurn');
    expect(source).not.toContain('invokeTurnModel');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('setRouteOwner');
  });
});
