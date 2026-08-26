'use strict';

const { buildPresenceLine, normalizePresenceState } = require('./presence-state');
const { summarizeServiceLifecycle } = require('./service-lifecycle-registry');

function toNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function getContinueStatus(continuePlan = {}) {
  const nextAction = continuePlan && continuePlan.nextAction;
  if (nextAction) {
    return {
      state: 'ready',
      label: `Next: ${toNonEmptyString(nextAction.nextStep) || toNonEmptyString(nextAction.title) || 'continue owned work'}`,
      riskClass: toNonEmptyString(nextAction.riskClass) || 'caution',
      owner: toNonEmptyString(nextAction.owner) || toNonEmptyString(nextAction.agent) || '',
    };
  }

  const heldCount = normalizeCount(continuePlan?.counts?.held);
  if (heldCount > 0) {
    return {
      state: 'held',
      label: `${heldCount} approval-held item${heldCount === 1 ? '' : 's'}`,
      riskClass: 'approval_required',
      owner: '',
    };
  }

  const waitingCount = normalizeCount(continuePlan?.counts?.waiting);
  if (waitingCount > 0) {
    return {
      state: 'waiting',
      label: `${waitingCount} item${waitingCount === 1 ? '' : 's'} waiting`,
      riskClass: 'safe',
      owner: '',
    };
  }

  return {
    state: 'quiet',
    label: 'No due owned work',
    riskClass: 'safe',
    owner: '',
  };
}

function getServiceStatus(serviceRegistry = []) {
  const summary = summarizeServiceLifecycle(serviceRegistry);
  const degraded = Array.isArray(summary.degraded) ? summary.degraded : [];
  if (degraded.length > 0) {
    return {
      state: 'degraded',
      label: `${degraded.length} service${degraded.length === 1 ? '' : 's'} degraded`,
      degradedServiceIds: degraded.map((service) => service.id),
    };
  }
  return {
    state: 'healthy',
    label: 'Services quiet',
    degradedServiceIds: [],
  };
}

function buildConfidenceSurface(input = {}) {
  const presenceState = normalizePresenceState(input.presenceState);
  const presence = {
    state: presenceState.mode,
    label: buildPresenceLine(presenceState),
    channel: presenceState.activeChannel,
  };
  const ownedWork = getContinueStatus(input.continuePlan);
  const services = getServiceStatus(input.serviceRegistry);
  const priority = services.state === 'degraded'
    ? 'service'
    : ownedWork.state === 'ready'
      ? 'owned_work'
      : presence.state === 'blocked'
        ? 'presence'
        : 'quiet';

  const parts = [presence.label, ownedWork.label, services.label].filter(Boolean);
  return {
    ok: services.state !== 'degraded' && presence.state !== 'blocked',
    priority,
    presence,
    ownedWork,
    services,
    line: parts.join(' | '),
  };
}

module.exports = {
  buildConfidenceSurface,
  getContinueStatus,
  getServiceStatus,
};
