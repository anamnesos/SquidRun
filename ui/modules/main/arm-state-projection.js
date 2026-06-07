const path = require('path');
const {
  getArmRegistryManifest,
  queryArmCheckinProofs,
  queryArmMissingWatchdogs,
  closeArmRegistryStores,
} = require('./arm-registry');
const {
  queryArmApplyRequests,
  closeArmApplyQueueStores,
} = require('./arm-apply-queue');
const {
  resolveDefaultDbPath,
  armProofMatchesCurrentIdentity,
} = require('./evidence-ledger-store');

const ARM_STATE_PROJECTION_SCHEMA = 'squidrun.arm_state_projection.v0';

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function toMs(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  return fallback;
}

function countBy(rows = [], key) {
  const counts = {};
  for (const row of rows) {
    const value = toOptionalString(row?.[key], 'unknown') || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  }
  return null;
}

function latestAcceptedByArm(proofs = [], registry = {}) {
  const latest = new Map();
  const currentArmById = new Map((registry.arms || []).map((arm) => [arm.armId, arm]));
  for (const proof of proofs) {
    if (!proof?.armId || proof.status !== 'accepted') continue;
    if (!armProofMatchesCurrentIdentity(proof, currentArmById.get(proof.armId), registry)) continue;
    const current = latest.get(proof.armId);
    if (!current || Number(proof.checkedInAtMs || 0) > Number(current.checkedInAtMs || 0)) {
      latest.set(proof.armId, proof);
    }
  }
  return latest;
}

function resolveReadinessSessionId(filters = {}, registry = {}) {
  return toOptionalString(
    filters.readinessSessionId || filters.readiness_session_id || filters.currentSessionId || filters.current_session_id,
    null
  ) || toOptionalString(
    filters.sessionId || filters.session_id || filters.sessionScopeId || filters.session_scope_id,
    null
  ) || toOptionalString(registry.sessionId, null);
}

function summarizeWatchdogs(watchdogs = [], nowMs) {
  const openStatuses = new Set(['expected', 'nudged', 'escalated']);
  const open = watchdogs.filter((watchdog) => openStatuses.has(watchdog.status));
  const dueTimes = open
    .map((watchdog) => firstNumber(watchdog.escalateDueAtMs, watchdog.nudgeDueAtMs))
    .filter((value) => Number.isFinite(value));
  const overdue = open.filter((watchdog) => {
    const dueAtMs = firstNumber(watchdog.escalateDueAtMs, watchdog.nudgeDueAtMs);
    return Number.isFinite(dueAtMs) && nowMs >= dueAtMs;
  });
  return {
    total: watchdogs.length,
    open: open.length,
    expected: watchdogs.filter((watchdog) => watchdog.status === 'expected').length,
    nudged: watchdogs.filter((watchdog) => watchdog.status === 'nudged').length,
    escalated: watchdogs.filter((watchdog) => watchdog.status === 'escalated').length,
    satisfied: watchdogs.filter((watchdog) => watchdog.status === 'satisfied').length,
    overdue: overdue.length,
    nextDueAtMs: dueTimes.length > 0 ? Math.min(...dueTimes) : null,
    byStatus: countBy(watchdogs, 'status'),
  };
}

function summarizeApplyQueue(requests = []) {
  return {
    total: requests.length,
    approvalRequired: requests.filter((request) => request.approvalRequired).length,
    pendingApproval: requests.filter((request) => request.status === 'approval_required').length,
    executable: requests.filter((request) => request.status === 'executable').length,
    dispatchBlocked: requests.filter((request) => request.status === 'dispatch_blocked').length,
    byStatus: countBy(requests, 'status'),
    byRiskClass: countBy(requests, 'riskClass'),
    byCategory: countBy(requests, 'actionCategory'),
  };
}

function compactWatchdog(watchdog = {}) {
  return {
    watchdogId: watchdog.watchdogId,
    armId: watchdog.armId,
    armKey: watchdog.armKey,
    role: watchdog.role,
    status: watchdog.status,
    expectedAtMs: watchdog.expectedAtMs,
    nudgeDueAtMs: watchdog.nudgeDueAtMs,
    nudgedAtMs: watchdog.nudgedAtMs,
    escalateDueAtMs: watchdog.escalateDueAtMs,
    escalatedAtMs: watchdog.escalatedAtMs,
    satisfiedAtMs: watchdog.satisfiedAtMs,
  };
}

function compactApplyRequest(request = {}) {
  return {
    requestId: request.requestId,
    armId: request.armId,
    armKey: request.armKey,
    role: request.role,
    actionCategory: request.actionCategory,
    riskClass: request.riskClass,
    status: request.status,
    approvalRequired: request.approvalRequired,
    approvedBy: request.approvedBy,
    approvedAtMs: request.approvedAtMs,
    approvalRef: request.approvalRef,
    evidenceRefs: request.evidenceRefs,
    sideEffectResult: request.sideEffectResult,
    createdAtMs: request.createdAtMs,
    updatedAtMs: request.updatedAtMs,
  };
}

function buildFilters(filters = {}) {
  const source = asObject(filters);
  return {
    ...(source.registryId || source.registry_id ? { registryId: source.registryId || source.registry_id } : {}),
    ...(source.appRoomId || source.app_room_id || source.roomId || source.room_id
      ? { appRoomId: source.appRoomId || source.app_room_id || source.roomId || source.room_id }
      : {}),
    ...(source.sessionId || source.session_id || source.sessionScopeId || source.session_scope_id
      ? { sessionId: source.sessionId || source.session_id || source.sessionScopeId || source.session_scope_id }
      : {}),
  };
}

function unavailableProjection(reason, dbPath, nowMs) {
  return {
    ok: false,
    status: 'not_found',
    reason,
    schema: ARM_STATE_PROJECTION_SCHEMA,
    generatedAtMs: nowMs,
    dbPath,
    projectionOnly: true,
    readOnly: true,
    explicitInvocationRequired: true,
    trustQuoteRoomBehaviorUnchanged: true,
    dispatchEnabled: false,
    executorEnabled: false,
    sideEffects: {
      writesPerformed: 0,
      dispatchesPerformed: 0,
      watchdogAdvancesPerformed: 0,
    },
  };
}

function buildArmStateProjection(filters = {}, options = {}) {
  const opts = asObject(options);
  const nowMs = toMs(opts.nowMs, Date.now());
  const dbPath = path.resolve(String(opts.dbPath || resolveDefaultDbPath()));
  const registryFilters = buildFilters(filters);
  const registry = getArmRegistryManifest(registryFilters, { dbPath });
  if (!registry) {
    return unavailableProjection('arm_registry_not_found', dbPath, nowMs);
  }
  const readinessSessionId = resolveReadinessSessionId(filters, registry);

  const checkins = queryArmCheckinProofs({ registryId: registry.registryId, limit: 50_000 }, { dbPath });
  const watchdogs = queryArmMissingWatchdogs({
    registryId: registry.registryId,
    ...(readinessSessionId ? { sessionId: readinessSessionId } : {}),
    limit: 50_000,
  }, { dbPath });
  const applyRequests = queryArmApplyRequests({
    registryId: registry.registryId,
    ...(readinessSessionId ? { sessionId: readinessSessionId } : {}),
    limit: 50_000,
  }, { dbPath });
  const readinessRegistry = { ...registry, readinessSessionId };
  const proofByArm = latestAcceptedByArm(checkins, readinessRegistry);
  const scopedCheckins = readinessSessionId
    ? checkins.filter((proof) => proof.sessionId === readinessSessionId)
    : checkins;
  let desiredCount = 0;
  let readyCount = 0;

  const activeArms = registry.arms.filter((arm) => arm.required && arm.status !== 'disabled');
  const arms = activeArms.map((arm) => {
    const latestProof = proofByArm.get(arm.armId) || null;
    const armWatchdogs = watchdogs.filter((watchdog) => watchdog.armId === arm.armId);
    const armApplyRequests = applyRequests.filter((request) => request.armId === arm.armId);
    desiredCount += 1;
    if (latestProof) readyCount += 1;
    const projectedStatus = latestProof ? 'ready' : 'missing';
    return {
      armId: arm.armId,
      armKey: arm.armKey,
      role: arm.role,
      paneId: arm.paneId,
      routeTarget: arm.routeTarget,
      armKind: arm.armKind,
      displayName: arm.displayName,
      required: arm.required,
      status: projectedStatus,
      latestAcceptedCheckin: latestProof ? {
        checkinId: latestProof.checkinId,
        proofKind: latestProof.proofKind,
        messageId: latestProof.messageId,
        commsRowId: latestProof.commsRowId,
        checkedInAtMs: latestProof.checkedInAtMs,
        proofRefs: latestProof.proofRefs,
      } : null,
      watchdogSummary: summarizeWatchdogs(armWatchdogs, nowMs),
      applyQueueSummary: summarizeApplyQueue(armApplyRequests),
    };
  });
  const missingCount = Math.max(0, desiredCount - readyCount);

  const includeRows = opts.includeRows !== false;
  return {
    ok: true,
    status: missingCount === 0 ? 'ready' : 'missing',
    schema: ARM_STATE_PROJECTION_SCHEMA,
    generatedAtMs: nowMs,
    dbPath,
    projectionOnly: true,
    readOnly: true,
    explicitInvocationRequired: true,
    trustQuoteRoomBehaviorUnchanged: true,
    dispatchEnabled: false,
    executorEnabled: false,
    sideEffects: {
      writesPerformed: 0,
      dispatchesPerformed: 0,
      watchdogAdvancesPerformed: 0,
    },
    registry: {
      registryId: registry.registryId,
      appRoomId: registry.appRoomId,
      sessionId: registry.sessionId,
      readinessSessionId,
      mainSessionId: registry.mainSessionId,
      leadRole: registry.leadRole,
      leadPaneId: registry.leadPaneId,
      routeTarget: registry.routeTarget,
      status: registry.status,
      desiredCount,
      readyCount,
      missingCount,
      lastEvaluatedAtMs: registry.lastEvaluatedAtMs,
      metadata: registry.metadata,
    },
    arms,
    checkins: {
      total: scopedCheckins.length,
      accepted: scopedCheckins.filter((proof) => proof.status === 'accepted').length,
      rejected: scopedCheckins.filter((proof) => proof.status === 'rejected').length,
      byStatus: countBy(scopedCheckins, 'status'),
    },
    watchdogs: {
      summary: summarizeWatchdogs(watchdogs, nowMs),
      rows: includeRows ? watchdogs.map(compactWatchdog) : [],
    },
    applyQueue: {
      summary: summarizeApplyQueue(applyRequests),
      rows: includeRows ? applyRequests.map(compactApplyRequest) : [],
    },
  };
}

function closeArmStateProjectionStores() {
  closeArmRegistryStores();
  closeArmApplyQueueStores();
}

module.exports = {
  ARM_STATE_PROJECTION_SCHEMA,
  buildArmStateProjection,
  closeArmStateProjectionStores,
  _internals: {
    summarizeApplyQueue,
    summarizeWatchdogs,
  },
};
