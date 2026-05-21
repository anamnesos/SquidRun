'use strict';

const DIRECT_CHANNEL_READINESS_PROTOCOL = 'squidrun.mira.direct_channel_readiness.v0';

function toNonEmptyString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeChatId(value) {
  const text = toNonEmptyString(value);
  if (!text) return null;
  return text.replace(/\s+/g, '');
}

function normalizeKind(value) {
  return (toNonEmptyString(value) || 'telegram').toLowerCase();
}

function normalizeRole(value) {
  return (toNonEmptyString(value) || '').toLowerCase().replace(/[\s-]+/g, '_');
}

function looksLikeRawTelegramCredential(value) {
  const text = toNonEmptyString(value);
  if (!text) return false;
  return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(text);
}

function findRawCredentialField(channel) {
  if (!channel || typeof channel !== 'object') return null;
  const entry = Object.entries(channel).find(([, value]) => (
    typeof value === 'string' && looksLikeRawTelegramCredential(value)
  ));
  return entry?.[0] || null;
}

function getBotRef(channel) {
  if (!channel || typeof channel !== 'object') return null;
  return toNonEmptyString(channel.botRef)
    || toNonEmptyString(channel.botIdRef)
    || toNonEmptyString(channel.credentialRef)
    || toNonEmptyString(channel.configRef);
}

function normalizeChannel(channel = {}, fallbackRole = '') {
  const role = normalizeRole(channel.role || channel.owner || fallbackRole);
  const kind = normalizeKind(channel.kind || channel.channelKind);
  const chatId = normalizeChatId(channel.chatId || channel.chatRef);
  const botRef = getBotRef(channel);
  return {
    kind,
    role,
    label: toNonEmptyString(channel.label) || null,
    chatId,
    botRef,
  };
}

function isCurrentSquidRunOpsChannel(channel) {
  const role = normalizeRole(channel?.role || channel?.owner || channel?.label);
  if (role === 'squidrun_team_ops' || role === 'current_squidrun_team_ops') return true;
  if (role === 'squidrun' || role === 'team_ops' || role === 'ops') return true;
  return channel?.isCurrentSquidRunTeamOps === true;
}

function blocked(reason, details = {}) {
  return {
    ok: false,
    protocol: DIRECT_CHANNEL_READINESS_PROTOCOL,
    status: 'mira_direct_channel_readiness_blocked',
    readiness: 'blocked',
    dryRun: true,
    sendReady: false,
    liveActivationReady: false,
    reason,
    sideEffects: buildNoSideEffects(),
    ...details,
  };
}

function buildNoSideEffects() {
  return {
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
  };
}

function buildMiraDirectChannelReadiness({
  currentChannel = null,
  candidateChannel = null,
} = {}) {
  if (!currentChannel || typeof currentChannel !== 'object') {
    return blocked('current_squidrun_team_ops_channel_required');
  }

  const currentRawCredentialField = findRawCredentialField(currentChannel);
  if (currentRawCredentialField) {
    return blocked('raw_telegram_credential_value_not_allowed', {
      credentialField: currentRawCredentialField,
      currentChannel: {
        kind: 'telegram',
        role: 'squidrun_team_ops',
        chatId: null,
        botRef: null,
        isCurrentSquidRunTeamOps: true,
        isFinalNewMiraDirectChannel: false,
      },
    });
  }

  const current = normalizeChannel(currentChannel, 'squidrun_team_ops');
  if (current.kind !== 'telegram' || !isCurrentSquidRunOpsChannel(currentChannel)) {
    return blocked('current_squidrun_team_ops_channel_required', {
      currentChannel: {
        kind: current.kind,
        role: current.role || null,
        isCurrentSquidRunTeamOps: false,
        isFinalNewMiraDirectChannel: false,
      },
    });
  }

  if (!candidateChannel || typeof candidateChannel !== 'object') {
    return blocked('separate_new_mira_channel_config_required', {
      currentChannel: {
        kind: current.kind,
        role: 'squidrun_team_ops',
        chatId: current.chatId,
        botRef: current.botRef,
        isCurrentSquidRunTeamOps: true,
        isFinalNewMiraDirectChannel: false,
      },
    });
  }

  const candidateRawCredentialField = findRawCredentialField(candidateChannel);
  if (candidateRawCredentialField) {
    return blocked('raw_telegram_credential_value_not_allowed', {
      credentialField: candidateRawCredentialField,
      currentChannel: {
        kind: current.kind,
        role: 'squidrun_team_ops',
        chatId: current.chatId,
        botRef: current.botRef,
        isCurrentSquidRunTeamOps: true,
        isFinalNewMiraDirectChannel: false,
      },
    });
  }

  const candidate = normalizeChannel(candidateChannel, 'new_mira_direct');
  if (candidate.kind !== 'telegram') {
    return blocked('separate_new_mira_telegram_channel_required', {
      candidateChannel: {
        kind: candidate.kind,
        role: candidate.role || null,
        isFinalNewMiraDirectChannel: false,
      },
    });
  }

  if (isCurrentSquidRunOpsChannel(candidateChannel)) {
    return blocked('current_squidrun_channel_is_not_new_mira_direct_channel', {
      currentChannel: {
        kind: current.kind,
        role: 'squidrun_team_ops',
        chatId: current.chatId,
        botRef: current.botRef,
        isCurrentSquidRunTeamOps: true,
        isFinalNewMiraDirectChannel: false,
      },
      candidateChannel: {
        kind: candidate.kind,
        role: candidate.role || null,
        chatId: candidate.chatId,
        botRef: candidate.botRef,
        isFinalNewMiraDirectChannel: false,
      },
    });
  }

  if (!candidate.chatId || !candidate.botRef) {
    return blocked('separate_new_mira_channel_config_required', {
      candidateChannel: {
        kind: candidate.kind,
        role: candidate.role || null,
        chatId: candidate.chatId,
        botRef: candidate.botRef,
        isFinalNewMiraDirectChannel: false,
      },
    });
  }

  if (current.chatId && candidate.chatId === current.chatId) {
    return blocked('separate_new_mira_chat_required', {
      currentChannel: {
        kind: current.kind,
        role: 'squidrun_team_ops',
        chatId: current.chatId,
        botRef: current.botRef,
        isCurrentSquidRunTeamOps: true,
        isFinalNewMiraDirectChannel: false,
      },
      candidateChannel: {
        kind: candidate.kind,
        role: candidate.role || null,
        chatId: candidate.chatId,
        botRef: candidate.botRef,
        isFinalNewMiraDirectChannel: false,
      },
    });
  }

  if (current.botRef && candidate.botRef === current.botRef) {
    return blocked('separate_new_mira_bot_required', {
      currentChannel: {
        kind: current.kind,
        role: 'squidrun_team_ops',
        chatId: current.chatId,
        botRef: current.botRef,
        isCurrentSquidRunTeamOps: true,
        isFinalNewMiraDirectChannel: false,
      },
      candidateChannel: {
        kind: candidate.kind,
        role: candidate.role || null,
        chatId: candidate.chatId,
        botRef: candidate.botRef,
        isFinalNewMiraDirectChannel: false,
      },
    });
  }

  return {
    ok: true,
    protocol: DIRECT_CHANNEL_READINESS_PROTOCOL,
    status: 'mira_direct_channel_candidate_ready',
    readiness: 'candidate_ready',
    dryRun: true,
    sendReady: false,
    liveActivationReady: false,
    currentChannel: {
      kind: current.kind,
      role: 'squidrun_team_ops',
      chatId: current.chatId,
      botRef: current.botRef,
      isCurrentSquidRunTeamOps: true,
      isFinalNewMiraDirectChannel: false,
    },
    candidateChannel: {
      kind: candidate.kind,
      role: 'new_mira_direct',
      chatId: candidate.chatId,
      botRef: candidate.botRef,
      separateFromCurrent: true,
      isFinalNewMiraDirectChannel: false,
    },
    route: {
      currentOwner: 'squidrun-telegram-guard-stack',
      proposedFutureOwner: 'new-mira-direct-channel',
      routeOwnerChange: false,
      liveRouteChanged: false,
      currentSquidRunRouteUntouched: true,
    },
    jamesGate: {
      required: true,
      when: 'create_or_provide_and_test_real_separate_new_mira_channel_bot_chat_or_switch_live_route_owner',
    },
    sideEffects: buildNoSideEffects(),
  };
}

module.exports = {
  DIRECT_CHANNEL_READINESS_PROTOCOL,
  buildMiraDirectChannelReadiness,
  normalizeChatId,
};
