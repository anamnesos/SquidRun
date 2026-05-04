'use strict';

const VALID_PRESENCE_MODES = new Set([
  'idle',
  'listening',
  'heard',
  'thinking',
  'speaking',
  'working',
  'waiting',
  'blocked',
]);

const DEFAULT_PRESENCE_STATE = Object.freeze({
  mode: 'idle',
  activeChannel: 'ui',
  activeProfileName: 'main',
  activeWindowKey: 'main',
  currentTopic: '',
  lastHeardText: '',
  lastUserInputAtMs: 0,
  lastAcknowledgedAtMs: 0,
  lastSpokeAtMs: 0,
  activeWorkId: '',
  blockedReason: '',
  updatedAtMs: 0,
});

function toNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function toTimestampMs(value, fallback = Date.now()) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizePresenceMode(value, fallback = 'idle') {
  const mode = toNonEmptyString(value).toLowerCase();
  return VALID_PRESENCE_MODES.has(mode) ? mode : fallback;
}

function normalizePresenceState(input = {}) {
  const state = input && typeof input === 'object' ? input : {};
  const fallbackMode = normalizePresenceMode(DEFAULT_PRESENCE_STATE.mode);
  return {
    mode: normalizePresenceMode(state.mode, fallbackMode),
    activeChannel: toNonEmptyString(state.activeChannel) || DEFAULT_PRESENCE_STATE.activeChannel,
    activeProfileName: toNonEmptyString(state.activeProfileName) || DEFAULT_PRESENCE_STATE.activeProfileName,
    activeWindowKey: toNonEmptyString(state.activeWindowKey) || DEFAULT_PRESENCE_STATE.activeWindowKey,
    currentTopic: toNonEmptyString(state.currentTopic),
    lastHeardText: toNonEmptyString(state.lastHeardText),
    lastUserInputAtMs: toTimestampMs(state.lastUserInputAtMs, DEFAULT_PRESENCE_STATE.lastUserInputAtMs),
    lastAcknowledgedAtMs: toTimestampMs(state.lastAcknowledgedAtMs, DEFAULT_PRESENCE_STATE.lastAcknowledgedAtMs),
    lastSpokeAtMs: toTimestampMs(state.lastSpokeAtMs, DEFAULT_PRESENCE_STATE.lastSpokeAtMs),
    activeWorkId: toNonEmptyString(state.activeWorkId),
    blockedReason: toNonEmptyString(state.blockedReason),
    updatedAtMs: toTimestampMs(state.updatedAtMs, DEFAULT_PRESENCE_STATE.updatedAtMs),
  };
}

function shouldAcknowledgeBeforeTask(state) {
  const normalized = normalizePresenceState(state);
  return normalized.lastUserInputAtMs > normalized.lastAcknowledgedAtMs;
}

function applyPresenceEvent(currentState = {}, event = {}) {
  const state = normalizePresenceState(currentState);
  const now = toTimestampMs(event.timestampMs);
  const type = toNonEmptyString(event.type).toLowerCase();
  const next = { ...state, updatedAtMs: now };

  if (event.channel) next.activeChannel = toNonEmptyString(event.channel) || next.activeChannel;
  if (event.profileName) next.activeProfileName = toNonEmptyString(event.profileName) || next.activeProfileName;
  if (event.windowKey) next.activeWindowKey = toNonEmptyString(event.windowKey) || next.activeWindowKey;
  if (event.topic) next.currentTopic = toNonEmptyString(event.topic);

  if (type === 'user_voice_started' || type === 'user_typing_started') {
    next.mode = 'listening';
    next.activeChannel = toNonEmptyString(event.channel) || (type === 'user_voice_started' ? 'voice' : next.activeChannel);
    next.blockedReason = '';
    return next;
  }

  if (type === 'user_transcript' || type === 'user_message') {
    next.mode = 'heard';
    next.lastHeardText = toNonEmptyString(event.text) || next.lastHeardText;
    next.lastUserInputAtMs = now;
    next.activeChannel = toNonEmptyString(event.channel) || next.activeChannel;
    next.blockedReason = '';
    return next;
  }

  if (type === 'mira_acknowledged') {
    next.mode = 'thinking';
    next.lastAcknowledgedAtMs = now;
    return next;
  }

  if (type === 'mira_speaking') {
    next.mode = 'speaking';
    next.lastSpokeAtMs = now;
    next.lastAcknowledgedAtMs = Math.max(next.lastAcknowledgedAtMs, now);
    return next;
  }

  if (type === 'work_started') {
    next.mode = 'working';
    next.activeWorkId = toNonEmptyString(event.workId) || next.activeWorkId;
    next.blockedReason = '';
    return next;
  }

  if (type === 'waiting') {
    next.mode = 'waiting';
    next.blockedReason = toNonEmptyString(event.reason);
    return next;
  }

  if (type === 'blocked') {
    next.mode = 'blocked';
    next.blockedReason = toNonEmptyString(event.reason) || 'Blocked';
    return next;
  }

  if (type === 'work_completed') {
    next.mode = 'idle';
    next.activeWorkId = '';
    next.blockedReason = '';
    return next;
  }

  return next;
}

function buildPresenceLine(state = {}) {
  const normalized = normalizePresenceState(state);
  if (normalized.mode === 'blocked') return `Blocked: ${normalized.blockedReason || 'needs attention'}`;
  if (normalized.mode === 'working') return `Working: ${normalized.currentTopic || normalized.activeWorkId || 'owned work'}`;
  if (normalized.mode === 'heard') return `Heard: ${normalized.lastHeardText || 'user input'}`;
  if (normalized.mode === 'speaking') return 'Speaking';
  if (normalized.mode === 'thinking') return 'Thinking';
  if (normalized.mode === 'listening') return 'Listening';
  if (normalized.mode === 'waiting') return `Waiting: ${normalized.blockedReason || 'next trigger'}`;
  return 'Idle';
}

module.exports = {
  DEFAULT_PRESENCE_STATE,
  VALID_PRESENCE_MODES,
  applyPresenceEvent,
  buildPresenceLine,
  normalizePresenceMode,
  normalizePresenceState,
  shouldAcknowledgeBeforeTask,
};
