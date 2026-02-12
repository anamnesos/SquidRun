const contracts = require('./contracts');
const contractPromotion = require('./contract-promotion');

const ACTIONS = Object.freeze({
  LIST: 'list',
  APPROVE: 'approve',
  REJECT: 'reject',
});

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeAction(action) {
  const normalized = String(action || '').trim().toLowerCase();
  if (normalized === 'list' || normalized === 'list-promotions' || normalized === 'get-promotions') {
    return ACTIONS.LIST;
  }
  if (normalized === 'approve' || normalized === 'approval' || normalized === 'signoff') {
    return ACTIONS.APPROVE;
  }
  if (normalized === 'reject' || normalized === 'rejection' || normalized === 'false-positive') {
    return ACTIONS.REJECT;
  }
  return null;
}

function normalizeContractId(raw) {
  const value = String(raw || '').trim();
  return value || null;
}

function normalizeAgentName(payload = {}, source = {}) {
  const payloadObj = asObject(payload);
  const sourceObj = asObject(source);

  const candidate = payloadObj.agent
    || payloadObj.agentName
    || payloadObj.author
    || sourceObj.role
    || sourceObj.author;

  const value = String(candidate || '').trim();
  return value || null;
}

function normalizeReason(payload = {}) {
  const payloadObj = asObject(payload);
  const value = String(payloadObj.reason || '').trim();
  return value || null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getContractStatsSnapshot(options = {}) {
  const opts = asObject(options);
  const includeEnforced = opts.includeEnforced === true;
  const includeUnknown = opts.includeUnknown !== false;

  if (typeof contractPromotion.syncStatsFromDisk === 'function') {
    contractPromotion.syncStatsFromDisk();
  }

  const stats = contractPromotion.getStats();
  const statsContracts = asObject(stats.contracts);
  const contractIds = new Set();

  for (const contract of contracts.SHADOW_CONTRACTS || []) {
    if (contract && contract.id) {
      contractIds.add(contract.id);
    }
  }

  for (const contractId of Object.keys(statsContracts)) {
    contractIds.add(contractId);
  }

  const rows = [];
  for (const contractId of contractIds) {
    const statsEntry = statsContracts[contractId] || null;
    const definition = contracts.getContractById(contractId);
    const mode = statsEntry?.mode || definition?.mode || 'shadow';
    const isKnown = Boolean(definition);
    const isShadow = mode === 'shadow';

    if (!includeEnforced && !isShadow) continue;
    if (!includeUnknown && !isKnown) continue;

    const sessionsTracked = Number(statsEntry?.sessionsTracked || 0);
    const falsePositives = Number(statsEntry?.falsePositives || 0);
    const agentSignoffs = Array.isArray(statsEntry?.agentSignoffs) ? statsEntry.agentSignoffs : [];
    const readyForPromotion = contractPromotion.isReadyForPromotion(contractId);

    rows.push({
      contractId,
      knownContract: isKnown,
      mode,
      sessionsTracked,
      shadowViolations: Number(statsEntry?.shadowViolations || 0),
      falsePositives,
      agentSignoffs: [...agentSignoffs],
      signoffCount: agentSignoffs.length,
      requiredSessions: contractPromotion.MIN_SESSIONS,
      requiredSignoffs: contractPromotion.REQUIRED_SIGNOFFS,
      missingSessions: Math.max(0, contractPromotion.MIN_SESSIONS - sessionsTracked),
      missingSignoffs: Math.max(0, contractPromotion.REQUIRED_SIGNOFFS - agentSignoffs.length),
      blockedByFalsePositives: falsePositives > 0,
      readyForPromotion,
      lastUpdated: statsEntry?.lastUpdated || null,
    });
  }

  rows.sort((a, b) => {
    if (a.readyForPromotion !== b.readyForPromotion) {
      return a.readyForPromotion ? -1 : 1;
    }
    return String(a.contractId).localeCompare(String(b.contractId));
  });

  const ready = rows.filter((row) => row.readyForPromotion);
  const enforced = rows.filter((row) => row.mode === 'enforced');
  const shadow = rows.filter((row) => row.mode === 'shadow');

  return {
    ok: true,
    action: ACTIONS.LIST,
    promotions: rows,
    summary: {
      total: rows.length,
      ready: ready.length,
      shadow: shadow.length,
      enforced: enforced.length,
    },
  };
}

function resolveKnownContract(contractId, statsContracts) {
  if (contracts.getContractById(contractId)) return true;
  return Boolean(asObject(statsContracts)[contractId]);
}

function approvePromotion(payload = {}, options = {}) {
  const payloadObj = asObject(payload);
  const source = asObject(options.source);
  const contractId = normalizeContractId(payloadObj.contractId || payloadObj.id);
  if (!contractId) {
    return { ok: false, action: ACTIONS.APPROVE, status: 'invalid_contract_id' };
  }

  if (typeof contractPromotion.syncStatsFromDisk === 'function') {
    contractPromotion.syncStatsFromDisk();
  }
  const stats = contractPromotion.getStats();
  if (!resolveKnownContract(contractId, stats.contracts)) {
    return { ok: false, action: ACTIONS.APPROVE, status: 'unknown_contract', contractId };
  }
  const existingEntry = asObject(stats.contracts)[contractId] || null;
  const definition = contracts.getContractById(contractId);
  const effectiveMode = existingEntry?.mode || definition?.mode || 'shadow';
  if (effectiveMode !== 'shadow') {
    return { ok: false, action: ACTIONS.APPROVE, status: 'already_enforced', contractId };
  }

  const agent = normalizeAgentName(payloadObj, source);
  if (!agent) {
    return { ok: false, action: ACTIONS.APPROVE, status: 'invalid_agent', contractId };
  }

  const before = clone(contractPromotion.getContractStats(contractId));

  contractPromotion.addSignoff(contractId, agent);
  const promotedContracts = contractPromotion.checkPromotions();
  contractPromotion.saveStats();

  const after = clone(contractPromotion.getContractStats(contractId));
  return {
    ok: true,
    action: ACTIONS.APPROVE,
    status: 'approved',
    contractId,
    agent,
    signoffAdded: (after.agentSignoffs || []).length > (before.agentSignoffs || []).length,
    promoted: promotedContracts.includes(contractId),
    promotedContracts,
    promotion: {
      mode: after.mode,
      sessionsTracked: after.sessionsTracked,
      falsePositives: after.falsePositives,
      signoffCount: Array.isArray(after.agentSignoffs) ? after.agentSignoffs.length : 0,
      requiredSessions: contractPromotion.MIN_SESSIONS,
      requiredSignoffs: contractPromotion.REQUIRED_SIGNOFFS,
    },
  };
}

function rejectPromotion(payload = {}, options = {}) {
  const payloadObj = asObject(payload);
  const source = asObject(options.source);
  const contractId = normalizeContractId(payloadObj.contractId || payloadObj.id);
  if (!contractId) {
    return { ok: false, action: ACTIONS.REJECT, status: 'invalid_contract_id' };
  }

  if (typeof contractPromotion.syncStatsFromDisk === 'function') {
    contractPromotion.syncStatsFromDisk();
  }
  const stats = contractPromotion.getStats();
  if (!resolveKnownContract(contractId, stats.contracts)) {
    return { ok: false, action: ACTIONS.REJECT, status: 'unknown_contract', contractId };
  }
  const existingEntry = asObject(stats.contracts)[contractId] || null;
  const definition = contracts.getContractById(contractId);
  const effectiveMode = existingEntry?.mode || definition?.mode || 'shadow';
  if (effectiveMode !== 'shadow') {
    return { ok: false, action: ACTIONS.REJECT, status: 'already_enforced', contractId };
  }

  const before = clone(contractPromotion.getContractStats(contractId));

  const agent = normalizeAgentName(payloadObj, source);
  const reason = normalizeReason(payloadObj);

  contractPromotion.recordFalsePositive(contractId);
  contractPromotion.saveStats();

  const after = clone(contractPromotion.getContractStats(contractId));
  return {
    ok: true,
    action: ACTIONS.REJECT,
    status: 'rejected',
    contractId,
    agent,
    reason,
    falsePositiveRecorded: Number(after.falsePositives || 0) > Number(before.falsePositives || 0),
    promotion: {
      mode: after.mode,
      sessionsTracked: after.sessionsTracked,
      falsePositives: after.falsePositives,
      signoffCount: Array.isArray(after.agentSignoffs) ? after.agentSignoffs.length : 0,
      requiredSessions: contractPromotion.MIN_SESSIONS,
      requiredSignoffs: contractPromotion.REQUIRED_SIGNOFFS,
    },
  };
}

function executeContractPromotionAction(action, payload = {}, options = {}) {
  const normalizedAction = normalizeAction(action);
  if (!normalizedAction) {
    return {
      ok: false,
      action: normalizeAction(action),
      status: 'invalid_action',
      error: `Unsupported contract-promotion action: ${String(action || '')}`,
    };
  }

  if (normalizedAction === ACTIONS.LIST) {
    return getContractStatsSnapshot(payload);
  }
  if (normalizedAction === ACTIONS.APPROVE) {
    return approvePromotion(payload, options);
  }
  if (normalizedAction === ACTIONS.REJECT) {
    return rejectPromotion(payload, options);
  }

  return {
    ok: false,
    action: normalizedAction,
    status: 'invalid_action',
  };
}

module.exports = {
  ACTIONS,
  normalizeAction,
  getContractStatsSnapshot,
  approvePromotion,
  rejectPromotion,
  executeContractPromotionAction,
};
