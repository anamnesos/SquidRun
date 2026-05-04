'use strict';

const crypto = require('crypto');
const { inferRiskClass } = require('../scripts/hm-task-queue');

const VALID_INGRESS_SOURCES = new Set([
  'voice',
  'telegram',
  'ui',
  'wake',
  'agent',
  'system',
]);

const DEFAULT_SCOPE = Object.freeze({
  profileName: 'main',
  windowKey: 'main',
  sessionId: '',
  projectPath: '',
});

function toNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function toTimestampMs(value, fallback = Date.now()) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeSource(value) {
  const source = toNonEmptyString(value).toLowerCase();
  return VALID_INGRESS_SOURCES.has(source) ? source : 'system';
}

function normalizeScope(input = {}, fallback = {}) {
  const scope = input && typeof input === 'object' ? input : {};
  const base = { ...DEFAULT_SCOPE, ...fallback };
  return {
    profileName: toNonEmptyString(scope.profileName) || toNonEmptyString(scope.profile) || base.profileName,
    windowKey: toNonEmptyString(scope.windowKey) || toNonEmptyString(scope.window) || base.windowKey,
    sessionId: toNonEmptyString(scope.sessionId) || toNonEmptyString(scope.session) || base.sessionId,
    projectPath: toNonEmptyString(scope.projectPath) || toNonEmptyString(scope.workspace) || base.projectPath,
  };
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);
}

function normalizeTargetIntent(input = {}) {
  const target = toNonEmptyString(input.target) || toNonEmptyString(input.targetRole) || 'architect';
  return {
    target,
    requestedByUser: Boolean(input.requestedByUser),
    allowDirectPaneWrite: false,
  };
}

function normalizeRoutePolicy(input = {}) {
  const failClosed = input.failClosed !== false;
  return {
    failClosed,
    requireSameProfile: input.requireSameProfile !== false,
    requireFreshContext: input.requireFreshContext !== false,
    allowMainFallback: Boolean(input.allowMainFallback),
  };
}

function normalizeIngressEnvelope(input = {}, options = {}) {
  const source = normalizeSource(input.source || options.source);
  const scope = normalizeScope(input.scope || input, options.scope);
  const text = toNonEmptyString(input.text)
    || toNonEmptyString(input.transcript)
    || toNonEmptyString(input.message)
    || '';
  const receivedAtMs = toTimestampMs(input.receivedAtMs || input.timestampMs, options.nowMs || Date.now());
  const speaker = toNonEmptyString(input.speaker) || (source === 'agent' ? 'agent' : 'user');
  const riskClass = toNonEmptyString(input.riskClass) || inferRiskClass({
    title: input.title,
    message: text,
    nextStep: input.nextStep || text,
    source,
  });
  const idempotencySeed = {
    source,
    profileName: scope.profileName,
    windowKey: scope.windowKey,
    sessionId: scope.sessionId,
    text,
    speaker,
    receivedAtMs,
  };

  return {
    schemaVersion: 1,
    source,
    scope,
    speaker,
    text,
    attachments: Array.isArray(input.attachments) ? input.attachments.slice() : [],
    riskClass,
    idempotencyKey: toNonEmptyString(input.idempotencyKey) || `ingress-${stableHash(idempotencySeed)}`,
    contextHints: {
      topic: toNonEmptyString(input.topic),
      language: toNonEmptyString(input.language),
      channelMessageId: toNonEmptyString(input.channelMessageId) || toNonEmptyString(input.messageId),
    },
    targetIntent: normalizeTargetIntent(input.targetIntent || input),
    routePolicy: normalizeRoutePolicy(input.routePolicy || input),
    receivedAtMs,
  };
}

function summarizeIngressEnvelope(envelope = {}) {
  const normalized = normalizeIngressEnvelope(envelope);
  const where = `${normalized.scope.profileName}/${normalized.scope.windowKey}`;
  const text = normalized.text ? `: ${normalized.text}` : '';
  return `${normalized.source} -> ${normalized.targetIntent.target} [${where}, ${normalized.riskClass}]${text}`;
}

module.exports = {
  DEFAULT_SCOPE,
  VALID_INGRESS_SOURCES,
  normalizeIngressEnvelope,
  normalizeRoutePolicy,
  normalizeScope,
  normalizeSource,
  summarizeIngressEnvelope,
};
