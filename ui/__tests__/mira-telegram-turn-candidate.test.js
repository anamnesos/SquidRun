'use strict';

/* global describe, expect, test */

const fs = require('fs');
const path = require('path');

const {
  CANDIDATE_PROTOCOL,
  buildNewMiraTelegramTurnCandidate,
} = require('../modules/mira-telegram-turn-candidate');

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
});
