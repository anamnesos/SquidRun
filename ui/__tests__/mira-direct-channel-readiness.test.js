'use strict';

/* global describe, expect, test */

const fs = require('fs');
const path = require('path');

const {
  DIRECT_CHANNEL_READINESS_PROTOCOL,
  buildMiraDirectChannelReadiness,
} = require('../modules/mira-direct-channel-readiness');

function currentOpsChannel(overrides = {}) {
  return {
    kind: 'telegram',
    role: 'squidrun_team_ops',
    chatId: '5613428850',
    botRef: 'SQUIDRUN_TELEGRAM_BOT_REF',
    ...overrides,
  };
}

function separateNewMiraChannel(overrides = {}) {
  return {
    kind: 'telegram',
    role: 'new_mira_direct',
    chatId: '7777777777',
    botRef: 'NEW_MIRA_DIRECT_TELEGRAM_BOT_REF',
    ...overrides,
  };
}

describe('Mira separate direct-channel readiness dry-run', () => {
  test('blocks missing separate New Mira channel config', () => {
    const result = buildMiraDirectChannelReadiness({
      currentChannel: currentOpsChannel(),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      protocol: DIRECT_CHANNEL_READINESS_PROTOCOL,
      status: 'mira_direct_channel_readiness_blocked',
      readiness: 'blocked',
      reason: 'separate_new_mira_channel_config_required',
      dryRun: true,
      sendReady: false,
      liveActivationReady: false,
    }));
    expect(result.currentChannel).toEqual(expect.objectContaining({
      role: 'squidrun_team_ops',
      isCurrentSquidRunTeamOps: true,
      isFinalNewMiraDirectChannel: false,
    }));
  });

  test('blocks treating the current SquidRun team ops channel as the final New Mira channel', () => {
    const result = buildMiraDirectChannelReadiness({
      currentChannel: currentOpsChannel(),
      candidateChannel: currentOpsChannel(),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'current_squidrun_channel_is_not_new_mira_direct_channel',
      dryRun: true,
    }));
    expect(result.candidateChannel).toEqual(expect.objectContaining({
      role: 'squidrun_team_ops',
      isFinalNewMiraDirectChannel: false,
    }));
  });

  test('blocks a New Mira candidate that reuses the current chat or bot reference', () => {
    const sameChat = buildMiraDirectChannelReadiness({
      currentChannel: currentOpsChannel(),
      candidateChannel: separateNewMiraChannel({
        chatId: '5613428850',
      }),
    });
    const sameBot = buildMiraDirectChannelReadiness({
      currentChannel: currentOpsChannel(),
      candidateChannel: separateNewMiraChannel({
        botRef: 'SQUIDRUN_TELEGRAM_BOT_REF',
      }),
    });

    expect(sameChat).toEqual(expect.objectContaining({
      ok: false,
      reason: 'separate_new_mira_chat_required',
    }));
    expect(sameBot).toEqual(expect.objectContaining({
      ok: false,
      reason: 'separate_new_mira_bot_required',
    }));
  });

  test('rejects raw Telegram credential-shaped values in dry-run config', () => {
    const result = buildMiraDirectChannelReadiness({
      currentChannel: currentOpsChannel(),
      candidateChannel: separateNewMiraChannel({
        botToken: '123456789:abcdefghijklmnopqrstuvwxyzABCDEFG',
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'raw_telegram_credential_value_not_allowed',
      credentialField: 'botToken',
      dryRun: true,
    }));
    expect(result.sideEffects).toEqual(expect.objectContaining({
      tokenRead: false,
      tokenValueStored: false,
      liveTelegramSend: false,
      routeOwnerChange: false,
    }));
  });

  test('rejects raw credential-shaped values in candidate reference fields', () => {
    const rawToken = '123456789:abcdefghijklmnopqrstuvwxyzABCDEFG';
    const rawBotRef = buildMiraDirectChannelReadiness({
      currentChannel: currentOpsChannel(),
      candidateChannel: separateNewMiraChannel({
        botRef: rawToken,
      }),
    });
    const rawAlternateRef = buildMiraDirectChannelReadiness({
      currentChannel: currentOpsChannel(),
      candidateChannel: separateNewMiraChannel({
        botRef: null,
        configRef: rawToken,
      }),
    });

    expect(rawBotRef).toEqual(expect.objectContaining({
      ok: false,
      reason: 'raw_telegram_credential_value_not_allowed',
      credentialField: 'botRef',
      sendReady: false,
      liveActivationReady: false,
    }));
    expect(rawAlternateRef).toEqual(expect.objectContaining({
      ok: false,
      reason: 'raw_telegram_credential_value_not_allowed',
      credentialField: 'configRef',
      sendReady: false,
      liveActivationReady: false,
    }));
    expect(JSON.stringify(rawBotRef)).not.toContain(rawToken);
    expect(JSON.stringify(rawAlternateRef)).not.toContain(rawToken);
  });

  test('rejects raw credential-shaped values in current-channel reference fields without echoing them', () => {
    const rawToken = '123456789:abcdefghijklmnopqrstuvwxyzABCDEFG';
    const result = buildMiraDirectChannelReadiness({
      currentChannel: currentOpsChannel({
        botRef: rawToken,
      }),
      candidateChannel: separateNewMiraChannel(),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'raw_telegram_credential_value_not_allowed',
      credentialField: 'botRef',
      sendReady: false,
      liveActivationReady: false,
    }));
    expect(result.currentChannel).toEqual(expect.objectContaining({
      role: 'squidrun_team_ops',
      chatId: null,
      botRef: null,
    }));
    expect(JSON.stringify(result)).not.toContain(rawToken);
  });

  test('rejects raw credential-shaped candidate chat ids without echoing them', () => {
    const rawToken = '123456789:abcdefghijklmnopqrstuvwxyzABCDEFG';
    const result = buildMiraDirectChannelReadiness({
      currentChannel: currentOpsChannel(),
      candidateChannel: separateNewMiraChannel({
        chatId: rawToken,
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'raw_telegram_credential_value_not_allowed',
      credentialField: 'chatId',
      sendReady: false,
      liveActivationReady: false,
    }));
    expect(result).not.toHaveProperty('candidateChannel');
    expect(JSON.stringify(result)).not.toContain(rawToken);
  });

  test('rejects raw credential-shaped current chat ids without echoing them', () => {
    const rawToken = '123456789:abcdefghijklmnopqrstuvwxyzABCDEFG';
    const result = buildMiraDirectChannelReadiness({
      currentChannel: currentOpsChannel({
        chatId: rawToken,
      }),
      candidateChannel: separateNewMiraChannel(),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'raw_telegram_credential_value_not_allowed',
      credentialField: 'chatId',
      sendReady: false,
      liveActivationReady: false,
    }));
    expect(result.currentChannel).toEqual(expect.objectContaining({
      role: 'squidrun_team_ops',
      chatId: null,
      botRef: null,
    }));
    expect(JSON.stringify(result)).not.toContain(rawToken);
  });

  test('marks valid separate Telegram config candidate-ready only with no send, route flip, model, or runtime', () => {
    const result = buildMiraDirectChannelReadiness({
      currentChannel: currentOpsChannel(),
      candidateChannel: separateNewMiraChannel(),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      protocol: DIRECT_CHANNEL_READINESS_PROTOCOL,
      status: 'mira_direct_channel_candidate_ready',
      readiness: 'candidate_ready',
      dryRun: true,
      sendReady: false,
      liveActivationReady: false,
    }));
    expect(result.currentChannel).toEqual({
      kind: 'telegram',
      role: 'squidrun_team_ops',
      chatId: '5613428850',
      botRef: 'SQUIDRUN_TELEGRAM_BOT_REF',
      isCurrentSquidRunTeamOps: true,
      isFinalNewMiraDirectChannel: false,
    });
    expect(result.candidateChannel).toEqual({
      kind: 'telegram',
      role: 'new_mira_direct',
      chatId: '7777777777',
      botRef: 'NEW_MIRA_DIRECT_TELEGRAM_BOT_REF',
      separateFromCurrent: true,
      isFinalNewMiraDirectChannel: false,
    });
    expect(result.route).toEqual({
      currentOwner: 'squidrun-telegram-guard-stack',
      proposedFutureOwner: 'new-mira-direct-channel',
      routeOwnerChange: false,
      liveRouteChanged: false,
      currentSquidRunRouteUntouched: true,
    });
    expect(result.jamesGate).toEqual({
      required: true,
      when: 'create_or_provide_and_test_real_separate_new_mira_channel_bot_chat_or_switch_live_route_owner',
    });
    expect(result.sideEffects).toEqual({
      botCreated: false,
      tokenRead: false,
      tokenValueStored: false,
      liveTelegramSend: false,
      telegramSendFunctionCall: false,
      routeOwnerChange: false,
      liveRouteChanged: false,
      modelInvoked: false,
      modelProviderCall: false,
      runtimeStarted: false,
      runtimeExecutes: false,
      toolsEnabled: false,
      sendsEnabled: false,
      store: false,
      bridgeAutoSend: false,
      offPcAccess: false,
    });
  });

  test('stays pure and does not import send, provider, runtime, route-control, or env-token seams', () => {
    const modulePath = path.join(__dirname, '..', 'modules', 'mira-direct-channel-readiness.js');
    const source = fs.readFileSync(modulePath, 'utf8');

    expect(source).not.toContain('process.env');
    expect(source).not.toContain('sendRoutedTelegramMessage');
    expect(source).not.toContain('sendTelegram');
    expect(source).not.toContain('requestTelegram');
    expect(source).not.toContain('runRuntimeTurn');
    expect(source).not.toContain('invokeTurnModel');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('appendRuntimeTurnJournal');
    expect(source).not.toContain('setRouteOwner');
  });
});
