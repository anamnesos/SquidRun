'use strict';

const fs = require('fs');
const path = require('path');

const {
  ACTIVE_STATES,
  TERMINAL_STATES,
  statusWorkItems,
} = require('./work-item-ledger');
const {
  getProjectRoot,
  resolveCoordPath,
} = require('../../config');

const SNAPSHOT_SCHEMA = 'squidrun.live_task_audit_sidecar.snapshot.v0';
const TASK_AUDIT_ITEMS_SCHEMA = 'squidrun.live_task_audit_sidecar.items.v0';
const DEFAULT_TASK_AUDIT_ITEMS_RELATIVE_PATH = path.join('runtime', 'live-task-audit-sidecar', 'task-audit-items.json');
const DEFAULT_APP_STATUS_RELATIVE_PATH = 'app-status.json';

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizePathForMetadata(value) {
  return toOptionalString(value, '')?.replace(/\\/g, '/') || '';
}

function asIso(value, fallbackMs = Date.now()) {
  const text = toOptionalString(value, null);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  return new Date(fallbackMs).toISOString();
}

function toTimestampMs(value) {
  const text = toOptionalString(value, null);
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSessionNumber(sessionId) {
  const match = String(sessionId || '').match(/\bapp-session-(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function uniqueStrings(values = []) {
  const out = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = toOptionalString(value, null);
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function resolveAppStatusPath(options = {}) {
  if (toOptionalString(options.appStatusPath, null)) return path.resolve(options.appStatusPath);
  if (typeof resolveCoordPath === 'function') return resolveCoordPath(DEFAULT_APP_STATUS_RELATIVE_PATH);
  return path.join(getProjectRoot(), '.squidrun', DEFAULT_APP_STATUS_RELATIVE_PATH);
}

function readCurrentAppSessionId(options = {}) {
  const parsed = readJsonFile(resolveAppStatusPath(options));
  const session = Number(parsed?.session);
  if (Number.isInteger(session) && session > 0) return `app-session-${session}`;
  return null;
}

function resolveTaskAuditItemsPath(options = {}) {
  const explicitPath = toOptionalString(options.taskAuditItemsPath || options.manualItemsPath, null);
  if (explicitPath) return path.resolve(explicitPath);
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(DEFAULT_TASK_AUDIT_ITEMS_RELATIVE_PATH, { forWrite: true });
  }
  return path.join(getProjectRoot(), '.squidrun', DEFAULT_TASK_AUDIT_ITEMS_RELATIVE_PATH);
}

function sourceFromWorkItem(item = {}) {
  const sourceMessageIds = uniqueStrings(item.sourceMessageIds || []);
  return {
    kind: 'work_item',
    ref: item.id || null,
    messageIds: sourceMessageIds,
    label: sourceMessageIds[0] || item.id || 'work_item',
  };
}

function normalizeProofSummary(item = {}) {
  const proofState = item.proofState && typeof item.proofState === 'object' ? item.proofState : {};
  return {
    complete: proofState.complete === true,
    requiredRoles: Array.isArray(proofState.requiredRoles) ? proofState.requiredRoles : [],
    presentRoles: Array.isArray(proofState.presentRoles) ? proofState.presentRoles : [],
    missingRoles: Array.isArray(proofState.missingRoles) ? proofState.missingRoles : [],
  };
}

function activeItemFromWorkItem(item = {}) {
  const sessionId = toOptionalString(item.session?.id, null);
  const updatedAt = asIso(item.updatedAt || item.createdAt);
  return {
    id: item.id || null,
    title: toOptionalString(item.objective, '(no objective)'),
    status: toOptionalString(item.state, 'active'),
    ownerRoles: uniqueStrings(item.ownerRoles || []),
    sessionId,
    sessionNumber: parseSessionNumber(sessionId),
    profile: toOptionalString(item.profile, null),
    windowKey: toOptionalString(item.window?.key, null),
    project: item.project || null,
    source: sourceFromWorkItem(item),
    sourceRef: item.id || null,
    sourceMessageIds: uniqueStrings(item.sourceMessageIds || []),
    createdAt: asIso(item.createdAt || updatedAt),
    updatedAt,
    timestamp: updatedAt,
    proofState: normalizeProofSummary(item),
    riskClass: item.riskClass || null,
    sideEffectCaps: Array.isArray(item.sideEffectCaps) ? item.sideEffectCaps : [],
    requiredProofs: Array.isArray(item.requiredProofs) ? item.requiredProofs : [],
  };
}

function historyItemFromWorkItem(item = {}) {
  const sessionId = toOptionalString(item.session?.id, null);
  const closure = item.closure && typeof item.closure === 'object' ? item.closure : {};
  const closedAt = asIso(closure.closedAt || item.updatedAt || item.createdAt);
  const proofState = normalizeProofSummary(item);
  const verdict = toOptionalString(item.verdict || closure.verdict || item.state, 'closed');
  const whatHappened = toOptionalString(closure.reason, null)
    || `Work item ended with ${verdict}.`;
  const proofText = proofState.requiredRoles.length
    ? `Proof: ${proofState.presentRoles.length}/${proofState.requiredRoles.length} roles present.`
    : 'Proof: no required roles recorded.';
  const missingText = proofState.missingRoles.length
    ? ` Missing: ${proofState.missingRoles.join(', ')}.`
    : '';
  return {
    id: item.id || null,
    title: toOptionalString(item.objective, '(no objective)'),
    status: verdict,
    verdict,
    state: toOptionalString(item.state, null),
    ownerRoles: uniqueStrings(item.ownerRoles || []),
    sessionId,
    sessionNumber: parseSessionNumber(sessionId),
    profile: toOptionalString(item.profile, null),
    windowKey: toOptionalString(item.window?.key, null),
    project: item.project || null,
    source: {
      kind: 'work_item_history',
      ref: item.id || null,
      messageIds: uniqueStrings(item.sourceMessageIds || []),
      label: uniqueStrings(item.sourceMessageIds || [])[0] || item.id || 'work_item_history',
    },
    sourceRef: item.id || null,
    sourceMessageIds: uniqueStrings(item.sourceMessageIds || []),
    createdAt: asIso(item.createdAt || closedAt),
    updatedAt: asIso(item.updatedAt || closedAt),
    timestamp: closedAt,
    closedAt,
    whatHappened,
    why: `${proofText}${missingText}`,
    proofState,
    closureReason: toOptionalString(closure.reason, null),
  };
}

function activeItemFromCurrentLane(currentLane = {}) {
  const activeLane = currentLane.activeLane && typeof currentLane.activeLane === 'object'
    ? currentLane.activeLane
    : null;
  if (!activeLane) return null;
  const updatedAt = asIso(currentLane.generatedAt || Date.now());
  return {
    id: activeLane.workItemId || activeLane.laneId || activeLane.sourceRef || activeLane.sourceMessageId,
    title: toOptionalString(activeLane.objective, '(no objective)'),
    status: toOptionalString(activeLane.status || currentLane.status, 'active'),
    ownerRoles: uniqueStrings(activeLane.ownerRoles || activeLane.targetRole || []),
    sessionId: toOptionalString(currentLane.sessionId, null),
    sessionNumber: parseSessionNumber(currentLane.sessionId),
    profile: null,
    windowKey: null,
    project: null,
    source: {
      kind: 'current_lane',
      ref: activeLane.sourceRef || activeLane.laneId || null,
      messageIds: uniqueStrings(activeLane.sourceMessageId || []),
      label: activeLane.sourceRef || activeLane.sourceMessageId || 'current_lane',
    },
    sourceRef: activeLane.sourceRef || activeLane.laneId || null,
    sourceMessageIds: uniqueStrings(activeLane.sourceMessageId || []),
    createdAt: updatedAt,
    updatedAt,
    timestamp: updatedAt,
    proofState: null,
    riskClass: null,
    sideEffectCaps: [],
    requiredProofs: [],
  };
}

function activeItemFromQueueTask(task = {}) {
  const updatedAt = asIso(task.updatedAt || task.lastAdvancedAt || Date.now());
  return {
    id: task.taskId || `${task.agent}:active`,
    title: toOptionalString(task.title, task.taskId || '(no title)'),
    status: toOptionalString(task.status || task.state, 'active'),
    ownerRoles: uniqueStrings(task.agent || []),
    sessionId: null,
    sessionNumber: null,
    profile: null,
    windowKey: null,
    project: null,
    source: {
      kind: 'agent_task_queue',
      ref: task.taskId || null,
      messageIds: [],
      label: task.source || task.taskId || 'agent_task_queue',
    },
    sourceRef: task.taskId || null,
    sourceMessageIds: [],
    createdAt: updatedAt,
    updatedAt,
    timestamp: updatedAt,
    proofState: null,
    riskClass: null,
    sideEffectCaps: [],
    requiredProofs: [],
  };
}

function normalizeTaskAuditItem(raw = {}, index = 0, sourcePath = null, defaults = {}) {
  const id = toOptionalString(raw.id, null) || `task-audit-item-${index + 1}`;
  const updatedAt = asIso(raw.updatedAt || raw.createdAt || raw.timestamp || Date.now());
  const sessionId = toOptionalString(raw.sessionId || raw.session?.id, null);
  const partition = String(raw.partition || raw.tab || 'future').toLowerCase() === 'active'
    ? 'active'
    : 'future';
  return {
    id,
    title: toOptionalString(raw.title || raw.objective || raw.summary, '(no title)'),
    status: toOptionalString(raw.status || raw.state, 'future'),
    kind: toOptionalString(raw.kind || raw.category, 'future_audit'),
    partition,
    ownerRoles: uniqueStrings(raw.ownerRoles || raw.ownerRole || raw.owner || []),
    sessionId,
    sessionNumber: parseSessionNumber(sessionId),
    source: {
      kind: toOptionalString(raw.sourceKind || raw.source?.kind, defaults.sourceKind || 'task_audit_item_store'),
      ref: toOptionalString(raw.sourceRef || raw.source?.ref || sourcePath, null),
      label: toOptionalString(raw.sourceLabel || raw.source?.label, defaults.sourceLabel || 'task_audit_items'),
    },
    sourceRef: toOptionalString(raw.sourceRef || raw.source?.ref || sourcePath, null),
    createdAt: asIso(raw.createdAt || updatedAt),
    updatedAt,
    timestamp: updatedAt,
    rationale: toOptionalString(raw.rationale || raw.reason || raw.notes, null),
    nextAction: toOptionalString(raw.nextAction, null),
  };
}

function itemsFromStore(parsed, sourcePath, defaults = {}) {
  const rawItems = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
  return rawItems.map((item, index) => normalizeTaskAuditItem(item, index, normalizePathForMetadata(sourcePath), defaults));
}

function readTaskAuditItems(options = {}) {
  const taskAuditItemsPath = resolveTaskAuditItemsPath(options);
  const parsed = readJsonFile(taskAuditItemsPath);
  const items = itemsFromStore(parsed, taskAuditItemsPath, {
    sourceKind: 'task_audit_item_store',
    sourceLabel: 'task_audit_items',
  });
  return {
    ok: true,
    schema: TASK_AUDIT_ITEMS_SCHEMA,
    sourcePath: normalizePathForMetadata(taskAuditItemsPath),
    taskAuditItemsPath: normalizePathForMetadata(taskAuditItemsPath),
    present: Boolean(parsed),
    taskAuditItemsPresent: Boolean(parsed),
    legacyFutureItemsReader: 'disabled',
    legacyFutureItemsRead: false,
    items,
  };
}

function readFutureItems(options = {}) {
  return readTaskAuditItems(options);
}

function futureItemsFromReconciliation(reconciliation = {}, generatedAt = asIso()) {
  const warnings = Array.isArray(reconciliation.warnings) ? reconciliation.warnings : [];
  return warnings.map((warning, index) => {
    const kind = String(warning || '').includes('conflict') ? 'reconciliation_conflict' : 'reconciliation_stale_marker';
    return normalizeTaskAuditItem({
      id: `reconciliation-${index + 1}-${String(warning).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 48)}`,
      title: String(warning || 'active work reconciliation warning'),
      status: kind === 'reconciliation_conflict' ? 'needs_review' : 'watch',
      kind,
      sourceKind: 'active_work_reconciliation',
      sourceRef: reconciliation.schema || 'active_work_reconciliation',
      sourceLabel: reconciliation.authority || reconciliation.status || 'reconciliation',
      createdAt: generatedAt,
      updatedAt: generatedAt,
      rationale: 'Active task authority and fallback stores need review before this becomes active work.',
    }, index);
  });
}

function sortByUpdatedAtDesc(items = []) {
  return [...items].sort((left, right) => toTimestampMs(right.updatedAt) - toTimestampMs(left.updatedAt));
}

function buildActiveItems(status = {}) {
  const items = Array.isArray(status.items) ? status.items : [];
  const typedActive = items
    .filter((item) => ACTIVE_STATES.has(item.state))
    .map(activeItemFromWorkItem);
  if (typedActive.length > 0) return sortByUpdatedAtDesc(typedActive);

  const reconciliation = status.activeWorkReconciliation || {};
  const fallback = [];
  const currentLaneItem = activeItemFromCurrentLane(reconciliation.currentLaneActive || {});
  if (currentLaneItem) fallback.push(currentLaneItem);
  for (const task of Array.isArray(reconciliation.queueActive) ? reconciliation.queueActive : []) {
    const queueItem = activeItemFromQueueTask(task);
    if (!fallback.some((item) => item.id === queueItem.id)) fallback.push(queueItem);
  }
  return sortByUpdatedAtDesc(fallback);
}

function buildHistoryItems(status = {}, options = {}) {
  const limit = Number.isFinite(Number(options.historyLimit)) ? Number(options.historyLimit) : 50;
  const items = Array.isArray(status.items) ? status.items : [];
  return sortByUpdatedAtDesc(items
    .filter((item) => TERMINAL_STATES.has(item.state))
    .map(historyItemFromWorkItem))
    .slice(0, limit);
}

function buildLiveTaskAuditSnapshot(options = {}) {
  const generatedAt = asIso(options.now || options.nowMs);
  const status = statusWorkItems({}, options);
  const reconciliation = status.activeWorkReconciliation || null;
  const itemStore = readTaskAuditItems(options);
  const supplementalActiveItems = itemStore.items.filter((item) => item.partition === 'active');
  const activeItems = sortByUpdatedAtDesc([
    ...buildActiveItems(status),
    ...supplementalActiveItems,
  ]);
  const historyItems = buildHistoryItems(status, options);
  const futureItems = sortByUpdatedAtDesc([
    ...itemStore.items.filter((item) => item.partition !== 'active'),
    ...futureItemsFromReconciliation(reconciliation || {}, generatedAt),
  ]);
  const primarySessionId = activeItems[0]?.sessionId
    || reconciliation?.currentLaneActive?.sessionId
    || toOptionalString(options.sessionId || options.session, null);
  const currentSessionId = primarySessionId
    || readCurrentAppSessionId(options)
    || status.items?.[0]?.session?.id;

  return {
    schema: SNAPSHOT_SCHEMA,
    version: 1,
    generatedAt,
    session: {
      id: currentSessionId || null,
      number: parseSessionNumber(currentSessionId),
    },
    active: {
      count: activeItems.length,
      items: activeItems,
    },
    future: {
      count: futureItems.length,
      items: futureItems,
      sourcePath: itemStore.sourcePath,
      sourcePresent: itemStore.present,
      taskAuditItemsPath: itemStore.taskAuditItemsPath,
      taskAuditItemsPresent: itemStore.taskAuditItemsPresent,
      legacyFutureItemsReader: itemStore.legacyFutureItemsReader,
      legacyFutureItemsRead: itemStore.legacyFutureItemsRead,
    },
    history: {
      count: historyItems.length,
      items: historyItems,
    },
    reconciliation,
    sources: {
      workItemRoot: status.workItemRoot || null,
      workItemIndexPath: status.indexPath || null,
      taskAuditItemsPath: itemStore.taskAuditItemsPath,
      appStatusPath: normalizePathForMetadata(resolveAppStatusPath(options)),
      currentLanePath: reconciliation?.currentLaneActive?.currentLanePath || null,
    },
  };
}

module.exports = {
  DEFAULT_TASK_AUDIT_ITEMS_RELATIVE_PATH,
  SNAPSHOT_SCHEMA,
  TASK_AUDIT_ITEMS_SCHEMA,
  buildLiveTaskAuditSnapshot,
  readFutureItems,
  readTaskAuditItems,
  resolveAppStatusPath,
  resolveTaskAuditItemsPath,
};
