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
const TASK_AUDIT_SECTIONS = Object.freeze(['Mira', 'TrustQuote', 'SquidRun', 'Other']);
const DGC_BUNDLE_BASENAME = 'main-DGcSGf52.js';

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

function splitListValue(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => splitListValue(entry));
  const text = toOptionalString(value, null);
  if (!text) return [];
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function normalizeSection(value) {
  const text = toOptionalString(value, null);
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (normalized === 'mira') return 'Mira';
  if (normalized === 'trustquote') return 'TrustQuote';
  if (normalized === 'squidrun') return 'SquidRun';
  if (normalized === 'other') return 'Other';
  return null;
}

function haystackForSection(item = {}) {
  const source = item.source && typeof item.source === 'object' ? item.source : {};
  const project = item.project && typeof item.project === 'object' ? item.project : {};
  return [
    item.id,
    item.title,
    item.objective,
    item.kind,
    item.status,
    item.profile,
    item.windowKey,
    item.section,
    project.name,
    project.path,
    item.sourceRef,
    source.kind,
    source.ref,
    source.label,
    item.rationale,
    item.nextAction,
  ].filter(Boolean).join(' ').toLowerCase();
}

function classifyTaskAuditSection(item = {}) {
  const explicit = normalizeSection(item.section || item.area);
  if (explicit) return explicit;
  const project = item.project && typeof item.project === 'object' ? item.project : {};
  const projectSection = normalizeSection(project.name);
  if (projectSection) return projectSection;

  const haystack = haystackForSection(item);
  if (/\btrustquote\b|trustquote-work-room|work-room|route-owner|prod-readiness|staging|deploy/.test(haystack)) {
    return 'TrustQuote';
  }
  if (/\bmira\b|presence-runtime|north-star|voice-transport|a3_a4|a3|a4/.test(haystack)) {
    return 'Mira';
  }
  if (/\bsquidrun\b|task-audit|work-item|codex|attention|desktop|mission-control|memory|evidence|restart|handoff|current-lane|hm-send|telegram|supervisor|scheduler|recovery|bridge|pane|oracle|architect|builder|firmware|gemini|localmodel|future-items/.test(haystack)) {
    return 'SquidRun';
  }
  return 'Other';
}

function addSection(item = {}) {
  return {
    ...item,
    section: classifyTaskAuditSection(item),
  };
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
  return addSection({
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
  });
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
  return addSection({
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
  });
}

function activeItemFromCurrentLane(currentLane = {}) {
  const activeLane = currentLane.activeLane && typeof currentLane.activeLane === 'object'
    ? currentLane.activeLane
    : null;
  if (!activeLane) return null;
  const updatedAt = asIso(currentLane.generatedAt || Date.now());
  return addSection({
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
  });
}

function shouldPromoteCurrentLaneFallback(currentLane = {}) {
  const activeLane = currentLane.activeLane && typeof currentLane.activeLane === 'object'
    ? currentLane.activeLane
    : null;
  if (!activeLane) return false;
  if (toOptionalString(activeLane.workItemId || activeLane.sourceRef, null)) return true;

  const source = toOptionalString(currentLane.source, '').toLowerCase();
  const laneId = toOptionalString(activeLane.laneId, '').toLowerCase();
  if (source === 'comms_journal' && laneId.includes(':unsequenced:')) return false;
  return true;
}

function activeItemFromQueueTask(task = {}) {
  const updatedAt = asIso(task.updatedAt || task.lastAdvancedAt || Date.now());
  return addSection({
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
  });
}

function normalizeTaskAuditItem(raw = {}, index = 0, sourcePath = null, defaults = {}) {
  const id = toOptionalString(raw.id, null) || `task-audit-item-${index + 1}`;
  const updatedAt = asIso(raw.updatedAt || raw.createdAt || raw.timestamp || Date.now());
  const sessionId = toOptionalString(raw.sessionId || raw.session?.id, null);
  const requestedPartition = String(raw.partition || raw.tab || 'future').toLowerCase();
  const partition = requestedPartition === 'active'
    ? 'active'
    : (requestedPartition === 'history' || requestedPartition === 'resolved' ? 'history' : 'future');
  return addSection({
    id,
    title: toOptionalString(raw.title || raw.objective || raw.summary, '(no title)'),
    status: toOptionalString(raw.status || raw.state, 'future'),
    verdict: toOptionalString(raw.verdict, null),
    kind: toOptionalString(raw.kind || raw.category, 'future_audit'),
    partition,
    section: toOptionalString(raw.section || raw.area, null),
    tags: uniqueStrings(splitListValue(raw.tags || raw.tag)),
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
    closedAt: toOptionalString(raw.closedAt || raw.resolvedAt, null) ? asIso(raw.closedAt || raw.resolvedAt) : null,
    whatHappened: toOptionalString(raw.whatHappened || raw.outcome, null),
    why: toOptionalString(raw.why || raw.evidenceSummary, null),
    rationale: toOptionalString(raw.rationale || raw.reason || raw.notes, null),
    nextAction: toOptionalString(raw.nextAction, null),
    evidenceRefs: uniqueStrings(raw.evidenceRefs || raw.evidenceRef || []),
  });
}

function itemsFromStore(parsed, sourcePath, defaults = {}) {
  const rawItems = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
  return rawItems.map((item, index) => normalizeTaskAuditItem(item, index, normalizePathForMetadata(sourcePath), defaults));
}

function resolvedDgcProofPath(options = {}) {
  const explicit = toOptionalString(options.dgcResolvedProofPath, null);
  if (explicit) return path.resolve(explicit);
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('runtime', 'builder-task-audit-cleanup-392-proof.md'));
  }
  return path.join(getProjectRoot(), '.squidrun', 'runtime', 'builder-task-audit-cleanup-392-proof.md');
}

function dgcBundlePath(options = {}) {
  const explicit = toOptionalString(options.dgcBundlePath, null);
  if (explicit) return path.resolve(explicit);
  return path.join(getProjectRoot(), 'ui', DGC_BUNDLE_BASENAME);
}

function hasDgcResolvedByAbsenceProof(options = {}) {
  const proofPath = resolvedDgcProofPath(options);
  try {
    const text = fs.readFileSync(proofPath, 'utf8');
    return text.includes('Resolved by absence / no-op')
      && text.includes(`ui/${DGC_BUNDLE_BASENAME}`)
      && text.includes('does not exist');
  } catch (_) {
    return false;
  }
}

function isDgcBundleAuditItem(item = {}) {
  return haystackForSection(item).includes(DGC_BUNDLE_BASENAME.toLowerCase());
}

function resolveSourceRefPath(sourceRef, options = {}) {
  const ref = toOptionalString(sourceRef, null);
  if (!ref) return null;
  if (/^[a-z]+:\/\//i.test(ref)) return null;
  const rawPath = ref.split(/\s+vs\s+/i)[0].split(/\s+\(/)[0].trim();
  if (!rawPath || rawPath.includes(':') && !/^[A-Za-z]:[\\/]/.test(rawPath)) return null;
  if (/^HEAD:/i.test(rawPath) || /^architect#\d+|^builder#\d+|^oracle#\d+/i.test(rawPath)) return null;
  const normalized = rawPath.replace(/\\/g, '/');
  if (!/[/.]/.test(normalized)) return null;
  if (path.isAbsolute(rawPath)) return path.resolve(rawPath);
  return path.join(getProjectRoot(), rawPath);
}

function isMissingSourceResolvedItem(item = {}, options = {}) {
  if (item.partition === 'history') return false;
  const explicit = String(item.resolveWhenSourceMissing || item.resolve_when_source_missing || '').toLowerCase();
  const sourceKind = String(item.source?.kind || item.sourceKind || '').toLowerCase();
  const kind = String(item.kind || '').toLowerCase();
  const shouldCheck = explicit === 'true'
    || explicit === '1'
    || sourceKind === 'coordination_state'
    || kind.includes('delete_candidate')
    || kind.includes('dead_file')
    || kind.includes('stale_file');
  if (!shouldCheck) return false;
  const sourcePath = resolveSourceRefPath(item.sourceRef || item.source?.ref, options);
  if (!sourcePath) return false;
  return !fs.existsSync(sourcePath);
}

function resolveMissingSourceAuditItem(item = {}, options = {}) {
  if (!isMissingSourceResolvedItem(item, options)) return item;
  const sourceRef = item.sourceRef || item.source?.ref || 'source file';
  const updatedAt = asIso(options.now || options.nowMs);
  return addSection({
    ...item,
    partition: 'history',
    status: 'resolved',
    verdict: 'resolved_by_absence',
    state: 'closed',
    closedAt: updatedAt,
    updatedAt,
    timestamp: updatedAt,
    whatHappened: `${sourceRef} is absent, so the delete/dead-file audit item no longer belongs in Needs Doing.`,
    why: `Source disappearance was reconciled from ${normalizePathForMetadata(resolveSourceRefPath(sourceRef, options) || sourceRef)}.`,
    rationale: `Resolved by absence: ${sourceRef} is no longer present.`,
    nextAction: 'No active action remains unless the source reappears.',
    evidenceRefs: uniqueStrings([...(item.evidenceRefs || []), normalizePathForMetadata(resolveSourceRefPath(sourceRef, options) || sourceRef)]),
  });
}

function resolveDgcBundleAuditItem(item = {}, options = {}) {
  if (!isDgcBundleAuditItem(item)) return item;
  if (item.partition === 'history' || fs.existsSync(dgcBundlePath(options)) || !hasDgcResolvedByAbsenceProof(options)) {
    return item;
  }
  const proofPath = normalizePathForMetadata(resolvedDgcProofPath(options));
  return addSection({
    ...item,
    partition: 'history',
    status: 'resolved',
    verdict: 'resolved',
    state: 'closed',
    closedAt: '2026-05-31T20:20:37.176Z',
    updatedAt: '2026-05-31T20:20:37.176Z',
    timestamp: '2026-05-31T20:20:37.176Z',
    whatHappened: `${DGC_BUNDLE_BASENAME} was checked in session 392 and resolved by absence; no file exists now.`,
    why: `Evidence: ${proofPath}; ${normalizePathForMetadata(dgcBundlePath(options))} is absent.`,
    rationale: `${DGC_BUNDLE_BASENAME} is not present, so this is not current cleanup work.`,
    nextAction: 'No action needed unless the file reappears.',
    evidenceRefs: uniqueStrings([...(item.evidenceRefs || []), proofPath]),
  });
}

function reconcileTaskAuditItems(items = [], options = {}) {
  return items
    .map((item) => resolveMissingSourceAuditItem(item, options))
    .map((item) => resolveDgcBundleAuditItem(item, options));
}

function historyItemFromTaskAuditItem(item = {}) {
  const closedAt = asIso(item.closedAt || item.updatedAt || item.timestamp || item.createdAt);
  const verdict = toOptionalString(item.verdict || item.status || 'resolved', 'resolved');
  const whatHappened = toOptionalString(item.whatHappened || item.rationale, null)
    || 'Audit item was resolved or recorded for history.';
  const why = toOptionalString(item.why || item.nextAction, null)
    || 'Retained as Task Audit history with source evidence.';
  return addSection({
    ...item,
    status: verdict,
    verdict,
    state: 'closed',
    closedAt,
    timestamp: closedAt,
    updatedAt: asIso(item.updatedAt || closedAt),
    source: item.source && typeof item.source === 'object'
      ? { ...item.source, kind: item.source.kind || 'task_audit_history' }
      : { kind: 'task_audit_history', ref: item.sourceRef || item.id || null, label: 'task_audit_history' },
    sourceRef: item.sourceRef || item.id || null,
    whatHappened,
    why,
    closureReason: whatHappened,
    proofState: null,
  });
}

function readTaskAuditItems(options = {}) {
  const taskAuditItemsPath = resolveTaskAuditItemsPath(options);
  const parsed = readJsonFile(taskAuditItemsPath);
  const items = reconcileTaskAuditItems(itemsFromStore(parsed, taskAuditItemsPath, {
    sourceKind: 'task_audit_item_store',
    sourceLabel: 'task_audit_items',
  }), options);
  return {
    ok: true,
    schema: TASK_AUDIT_ITEMS_SCHEMA,
    sourcePath: normalizePathForMetadata(taskAuditItemsPath),
    taskAuditItemsPath: normalizePathForMetadata(taskAuditItemsPath),
    present: Boolean(parsed),
    taskAuditItemsPresent: Boolean(parsed),
    items,
  };
}

function reconciliationWarningTitle(warning) {
  const text = String(warning || '');
  if (text === 'no_typed_active_work_item_current_lane_active') {
    return 'Current-lane store shows an unverified active entry';
  }
  if (text === 'no_typed_active_work_item_queue_active') {
    return 'Agent queue has active work without typed work-item proof';
  }
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
    || 'Active work reconciliation warning';
}

function futureItemsFromReconciliation(reconciliation = {}, generatedAt = asIso()) {
  const warnings = Array.isArray(reconciliation.warnings) ? reconciliation.warnings : [];
  return warnings.map((warning, index) => {
    const kind = String(warning || '').includes('conflict') ? 'reconciliation_conflict' : 'reconciliation_stale_marker';
    return normalizeTaskAuditItem({
      id: `reconciliation-${index + 1}-${String(warning).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 48)}`,
      title: reconciliationWarningTitle(warning),
      status: kind === 'reconciliation_conflict' ? 'needs_review' : 'watch',
      kind,
      sourceKind: 'active_work_reconciliation',
      sourceRef: reconciliation.schema || 'active_work_reconciliation',
      sourceLabel: reconciliation.authority || reconciliation.status || 'reconciliation',
      createdAt: generatedAt,
      updatedAt: generatedAt,
      rationale: 'Active task authority and fallback stores need review before this becomes active work.',
      nextAction: 'Review later only when Architect opens a current lane with typed work-item proof.',
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
  if (shouldPromoteCurrentLaneFallback(reconciliation.currentLaneActive || {})) {
    const currentLaneItem = activeItemFromCurrentLane(reconciliation.currentLaneActive || {});
    if (currentLaneItem) fallback.push(currentLaneItem);
  }
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
  const historyItems = sortByUpdatedAtDesc([
    ...buildHistoryItems(status, options),
    ...itemStore.items.filter((item) => item.partition === 'history').map(historyItemFromTaskAuditItem),
  ]).slice(0, Number.isFinite(Number(options.historyLimit)) ? Number(options.historyLimit) : 50);
  const futureItems = sortByUpdatedAtDesc([
    ...itemStore.items.filter((item) => item.partition === 'future'),
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
  TASK_AUDIT_SECTIONS,
  TASK_AUDIT_ITEMS_SCHEMA,
  buildLiveTaskAuditSnapshot,
  classifyTaskAuditSection,
  readTaskAuditItems,
  resolveAppStatusPath,
  resolveTaskAuditItemsPath,
};
