'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  getProjectRoot,
  resolveCoordPath,
} = require('../../config');
const {
  CODEX_VISUAL_RESPONSE_SCHEMA,
  requestCodexVisual,
  attachProof,
  writeJsonAtomic,
} = require('./work-item-ledger');

const REQUEST_SCHEMA = 'squidrun.codex_attention_bridge.request.v0';
const INDEX_SCHEMA = 'squidrun.codex_attention_bridge.index.v0';
const COMPLETION_SCHEMA = 'squidrun.codex_attention_bridge.completion.v0';
const DEFAULT_BRIDGE_RELATIVE_ROOT = path.join('runtime', 'codex-attention-bridge');
const REQUEST_DIR = 'requests';
const COMPLETION_DIR = 'proof-packets';
const INDEX_FILE = 'index.json';
const ACTIVE_STATUSES = new Set(['requested', 'acknowledged', 'in_progress']);
const TERMINAL_STATUSES = new Set(['completed', 'blocked', 'canceled']);
const VALID_STATUSES = new Set([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizePathForMetadata(value) {
  return toOptionalString(value, '')?.replace(/\\/g, '/') || '';
}

function normalizeToken(value, fallback = null) {
  const text = toOptionalString(value, null);
  if (!text) return fallback;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || fallback;
}

function normalizeFilenameToken(value, fallback = null) {
  const normalized = normalizeToken(value, fallback);
  if (!normalized) return fallback;
  return normalized
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/^_+|_+$/g, '')
    || fallback;
}

function splitListValue(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => splitListValue(entry));
  const text = toOptionalString(value, null);
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.flatMap((entry) => splitListValue(entry));
    } catch (_) {
      // Fall through to comma splitting.
    }
  }
  return text.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function uniqueStrings(values = []) {
  const out = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    for (const entry of splitListValue(value)) {
      if (!entry || out.includes(entry)) continue;
      out.push(entry);
    }
  }
  return out;
}

function asIso(value, fallbackMs = Date.now()) {
  if (value instanceof Date) return value.toISOString();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  const text = toOptionalString(value, null);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

function toTimestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest('hex')}`;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function resolveBridgeRoot(options = {}) {
  if (toOptionalString(options.bridgeRoot, null)) return path.resolve(options.bridgeRoot);
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(DEFAULT_BRIDGE_RELATIVE_ROOT, { forWrite: true });
  }
  return path.join(getProjectRoot(), '.squidrun', DEFAULT_BRIDGE_RELATIVE_ROOT);
}

function resolveIndexPath(options = {}) {
  return path.join(resolveBridgeRoot(options), INDEX_FILE);
}

function resolveRequestPath(id, options = {}) {
  const requestId = normalizeRequestId(id);
  if (!requestId) throw new Error('request_id_required');
  return path.join(resolveBridgeRoot(options), REQUEST_DIR, `${requestId}.json`);
}

function resolveCompletionPath(id, options = {}) {
  const requestId = normalizeRequestId(id);
  if (!requestId) throw new Error('request_id_required');
  return path.join(resolveBridgeRoot(options), COMPLETION_DIR, `${requestId}.completion.json`);
}

function normalizeRequestId(value) {
  return normalizeFilenameToken(value, null);
}

function normalizePriority(value) {
  const normalized = normalizeToken(value, 'normal');
  return VALID_PRIORITIES.has(normalized) ? normalized : 'normal';
}

function normalizeStatus(value, fallback = 'requested') {
  const normalized = normalizeToken(value, fallback);
  return VALID_STATUSES.has(normalized) ? normalized : fallback;
}

function createRequestId(input = {}, nowIso = asIso(input.now)) {
  const target = normalizeFilenameToken(
    input.work_item_id || input.workItemId || input.reason || 'codex-attention',
    'codex-attention'
  );
  const stamp = nowIso.replace(/[^0-9]/g, '').slice(0, 14) || String(Date.now());
  return `codex-attention-${stamp}-${target.slice(0, 48)}`;
}

function normalizeTarget(input = {}) {
  const rawTarget = input.target && typeof input.target === 'object' ? input.target : {};
  const url = toOptionalString(input.url || input.targetUrl || rawTarget.url, null);
  const route = toOptionalString(input.route || rawTarget.route, null);
  const windowKey = normalizeToken(input.window || input.windowKey || rawTarget.window_key || rawTarget.windowKey, null);
  const surface = toOptionalString(input.surface || rawTarget.surface, null)
    || (url ? 'url' : (route ? 'route' : (windowKey ? 'window' : null)));
  return {
    surface,
    url,
    route,
    window_key: windowKey,
  };
}

function hasTarget(target = {}) {
  return Boolean(target.surface || target.url || target.route || target.window_key);
}

function buildIndexEntry(request = {}) {
  return {
    id: request.id,
    work_item_id: request.work_item_id || null,
    correlation_id: request.correlation_id || null,
    requested_by: request.requested_by || null,
    proof_role: request.proof_role || null,
    priority: request.priority || 'normal',
    status: request.status || 'requested',
    target: request.target || {},
    created_at: request.created_at || null,
    updated_at: request.updated_at || null,
    path: normalizePathForMetadata(resolveRequestPath(request.id, request._options || {})),
  };
}

function readIndex(options = {}) {
  const indexPath = resolveIndexPath(options);
  const parsed = readJsonFile(indexPath);
  if (!parsed || typeof parsed !== 'object') {
    return {
      schema: INDEX_SCHEMA,
      version: 1,
      updated_at: null,
      active_request_ids: [],
      requests: [],
    };
  }
  return {
    schema: INDEX_SCHEMA,
    version: 1,
    updated_at: toOptionalString(parsed.updated_at, null),
    active_request_ids: Array.isArray(parsed.active_request_ids) ? parsed.active_request_ids : [],
    requests: Array.isArray(parsed.requests) ? parsed.requests : [],
  };
}

function writeIndexForRequests(requests = [], options = {}) {
  const nowIso = asIso(options.now || options.nowMs);
  const entries = sortRequests(requests).map((request) => buildIndexEntry({ ...request, _options: options }));
  const index = {
    schema: INDEX_SCHEMA,
    version: 1,
    updated_at: nowIso,
    active_request_ids: entries.filter((entry) => ACTIVE_STATUSES.has(entry.status)).map((entry) => entry.id),
    requests: entries,
  };
  writeJsonAtomic(resolveIndexPath(options), index);
  return index;
}

function loadRequestsFromIndex(options = {}) {
  const index = readIndex(options);
  const requests = [];
  const warnings = [];
  for (const entry of index.requests) {
    const requestPath = entry.path ? path.resolve(entry.path) : resolveRequestPath(entry.id, options);
    const parsed = readJsonFile(requestPath);
    if (!parsed || typeof parsed !== 'object') {
      warnings.push(`missing_request_file:${entry.id}`);
      continue;
    }
    requests.push(normalizeStoredRequest(parsed, options));
  }
  return { index, requests, warnings };
}

function normalizeStoredRequest(raw = {}, options = {}) {
  const id = normalizeRequestId(raw.id);
  return {
    schema: REQUEST_SCHEMA,
    version: 1,
    id,
    work_item_id: normalizeToken(raw.work_item_id || raw.workItemId, null),
    requested_by: normalizeToken(raw.requested_by || raw.requestedBy, null),
    reason: toOptionalString(raw.reason, ''),
    target: normalizeTarget(raw),
    checklist: uniqueStrings(raw.checklist || raw.invariants || raw.invariant),
    proof_role: normalizeToken(raw.proof_role || raw.proofRole, 'codex_browser'),
    priority: normalizePriority(raw.priority),
    status: normalizeStatus(raw.status),
    correlation_id: normalizeToken(raw.correlation_id || raw.correlationId || id, id),
    created_at: asIso(raw.created_at || raw.createdAt),
    updated_at: asIso(raw.updated_at || raw.updatedAt || raw.created_at || raw.createdAt),
    acknowledged_at: toOptionalString(raw.acknowledged_at || raw.acknowledgedAt, null),
    acknowledged_by: normalizeToken(raw.acknowledged_by || raw.acknowledgedBy, null),
    completed_at: toOptionalString(raw.completed_at || raw.completedAt, null),
    completed_by: normalizeToken(raw.completed_by || raw.completedBy, null),
    visual_request: raw.visual_request && typeof raw.visual_request === 'object' ? raw.visual_request : null,
    completion: raw.completion && typeof raw.completion === 'object' ? raw.completion : null,
    no_side_effect_caps: uniqueStrings(raw.no_side_effect_caps || raw.noSideEffectCaps),
    requested_artifact_refs: uniqueStrings(raw.requested_artifact_refs || raw.requestedArtifactRefs),
    path: normalizePathForMetadata(resolveRequestPath(id, options)),
  };
}

function saveRequest(request = {}, options = {}) {
  const normalized = normalizeStoredRequest(request, options);
  writeJsonAtomic(resolveRequestPath(normalized.id, options), normalized);
  const { requests } = loadRequestsFromIndex(options);
  const nextRequests = [
    ...requests.filter((existing) => existing.id !== normalized.id),
    normalized,
  ];
  const index = writeIndexForRequests(nextRequests, options);
  return {
    ok: true,
    request: normalized,
    request_path: normalized.path,
    index_path: normalizePathForMetadata(resolveIndexPath(options)),
    index,
  };
}

function sortRequests(requests = []) {
  return [...requests].sort((left, right) => {
    const priorityDelta = (PRIORITY_RANK[left.priority] ?? 2) - (PRIORITY_RANK[right.priority] ?? 2);
    if (priorityDelta !== 0) return priorityDelta;
    return toTimestampMs(left.created_at) - toTimestampMs(right.created_at);
  });
}

function createCodexAttentionRequest(input = {}, options = {}) {
  const nowIso = asIso(input.now || options.now || options.nowMs);
  const target = normalizeTarget(input);
  if (!hasTarget(target)) throw new Error('target_required');
  const reason = toOptionalString(input.reason, null);
  if (!reason) throw new Error('reason_required');
  const requestedBy = normalizeToken(input.requested_by || input.requestedBy || input.requester || input.role, null);
  if (!requestedBy) throw new Error('requested_by_required');
  const id = normalizeRequestId(input.id) || createRequestId(input, nowIso);
  const correlationId = normalizeToken(input.correlation_id || input.correlationId, id);
  const workItemId = normalizeToken(input.work_item_id || input.workItemId, null);
  const checklist = uniqueStrings(input.checklist || input.invariant || input.invariants);
  const proofRole = normalizeToken(input.proof_role || input.proofRole, 'codex_browser');
  const request = {
    schema: REQUEST_SCHEMA,
    version: 1,
    id,
    work_item_id: workItemId,
    requested_by: requestedBy,
    reason,
    target,
    checklist,
    proof_role: proofRole,
    priority: normalizePriority(input.priority),
    status: 'requested',
    created_at: nowIso,
    updated_at: nowIso,
    correlation_id: correlationId,
    no_side_effect_caps: uniqueStrings(input.no_side_effect_caps || input.noSideEffectCaps),
    requested_artifact_refs: uniqueStrings(input.requested_artifact_refs || input.requestedArtifactRefs),
    visual_request: null,
    completion: null,
  };

  if (workItemId && (target.route || target.url) && input.workItemVisualRequest !== false) {
    const visual = requestCodexVisual({
      id: workItemId,
      requestId: correlationId,
      route: target.route,
      url: target.url,
      invariant: checklist,
      noSideEffectCaps: request.no_side_effect_caps,
      requestedArtifactRefs: request.requested_artifact_refs,
      viewport: input.viewport,
      viewportMatrix: input.viewportMatrix,
      consoleExpectation: input.consoleExpectation,
      devBadgeExpectation: input.devBadgeExpectation,
      overflowExpectation: input.overflowExpectation,
      now: nowIso,
    }, options);
    request.visual_request = visual.ok === false
      ? {
        status: 'blocked',
        reason: visual.reason || 'work_item_visual_request_failed',
      }
      : {
        status: 'requested',
        id: visual.visualRequest.id,
        path: visual.visualRequestPath,
        schema: visual.visualRequest.schema,
        expected_response_schema: CODEX_VISUAL_RESPONSE_SCHEMA,
      };
  }

  return saveRequest(request, { ...options, now: nowIso });
}

function listCodexAttentionRequests(input = {}, options = {}) {
  const { index, requests, warnings } = loadRequestsFromIndex(options);
  const includeAll = input.all === true || input.includeAll === true;
  const wantedStatuses = uniqueStrings(input.status || input.statuses)
    .map((status) => normalizeStatus(status, null))
    .filter(Boolean);
  const filtered = sortRequests(requests).filter((request) => {
    if (wantedStatuses.length > 0) return wantedStatuses.includes(request.status);
    return includeAll ? true : ACTIVE_STATUSES.has(request.status);
  });
  return {
    ok: true,
    schema: INDEX_SCHEMA,
    bridge_root: normalizePathForMetadata(resolveBridgeRoot(options)),
    index_path: normalizePathForMetadata(resolveIndexPath(options)),
    active_request_ids: requests.filter((request) => ACTIVE_STATUSES.has(request.status)).map((request) => request.id),
    active_count: requests.filter((request) => ACTIVE_STATUSES.has(request.status)).length,
    request_count: filtered.length,
    total_count: requests.length,
    requests: filtered,
    index,
    warnings,
  };
}

function loadCodexAttentionRequest(id, options = {}) {
  const requestId = normalizeRequestId(id);
  if (!requestId) throw new Error('request_id_required');
  const requestPath = resolveRequestPath(requestId, options);
  const parsed = readJsonFile(requestPath);
  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      reason: 'request_not_found',
      request_id: requestId,
      request_path: normalizePathForMetadata(requestPath),
    };
  }
  return {
    ok: true,
    request: normalizeStoredRequest(parsed, options),
    request_path: normalizePathForMetadata(requestPath),
  };
}

function ackCodexAttentionRequest(input = {}, options = {}) {
  const id = input.id || input.request_id || input.requestId;
  const loaded = loadCodexAttentionRequest(id, options);
  if (!loaded.ok) return loaded;
  const nowIso = asIso(input.now || options.now || options.nowMs);
  const request = loaded.request;
  if (TERMINAL_STATUSES.has(request.status)) {
    return { ok: false, reason: 'request_terminal', request };
  }
  const next = {
    ...request,
    status: request.status === 'requested' ? 'acknowledged' : request.status,
    acknowledged_at: request.acknowledged_at || nowIso,
    acknowledged_by: normalizeToken(input.acknowledged_by || input.acknowledgedBy || input.by || input.role, 'codex'),
    updated_at: nowIso,
  };
  return saveRequest(next, { ...options, now: nowIso });
}

function buildCompletionPacket(request = {}, input = {}, completionPath = null, nowIso = asIso()) {
  const result = normalizeToken(input.result || input.verdict, 'pass');
  return {
    schema: COMPLETION_SCHEMA,
    version: 1,
    request_id: request.id,
    work_item_id: request.work_item_id,
    correlation_id: request.correlation_id,
    proof_role: request.proof_role,
    result,
    completed_by: normalizeToken(input.completed_by || input.completedBy || input.by || input.role, 'codex'),
    completed_at: nowIso,
    target: request.target,
    checklist: request.checklist,
    proof: {
      ref: toOptionalString(input.proof_ref || input.proofRef || input.ref, null),
      path: input.proof_path || input.proofPath || input.path
        ? normalizePathForMetadata(path.resolve(input.proof_path || input.proofPath || input.path))
        : null,
      hash: toOptionalString(input.proof_hash || input.proofHash || input.hash || input.sha256, null),
      summary: toOptionalString(input.summary, null),
      packet_path: completionPath ? normalizePathForMetadata(completionPath) : null,
    },
    visual_request: request.visual_request,
    artifacts: uniqueStrings(input.artifact || input.artifacts),
    hashes: uniqueStrings(input.hashes || input.hash),
    notes: toOptionalString(input.notes, null),
    no_side_effects_observed: input.no_side_effects_observed !== false && input.noSideEffectsObserved !== false,
    expected_codex_response_schema: CODEX_VISUAL_RESPONSE_SCHEMA,
  };
}

function completeCodexAttentionRequest(input = {}, options = {}) {
  const id = input.id || input.request_id || input.requestId;
  const loaded = loadCodexAttentionRequest(id, options);
  if (!loaded.ok) return loaded;
  const nowIso = asIso(input.now || options.now || options.nowMs);
  const request = loaded.request;
  if (TERMINAL_STATUSES.has(request.status)) {
    return { ok: false, reason: 'request_terminal', request };
  }
  const completionPath = resolveCompletionPath(request.id, options);
  const completion = buildCompletionPacket(request, input, completionPath, nowIso);
  writeJsonAtomic(completionPath, completion);
  const completionHash = sha256File(completionPath);

  let workItemProof = null;
  const shouldAttach = input.attachWorkItemProof !== false && input.attach_work_item_proof !== false;
  if (shouldAttach && request.work_item_id && request.proof_role) {
    workItemProof = attachProof({
      id: request.work_item_id,
      role: request.proof_role,
      ref: completion.proof.ref || `${request.id}:codex-attention-proof`,
      path: completion.proof.path || completionPath,
      hash: completion.proof.hash || completionHash,
      kind: 'codex_attention_bridge_completion',
      summary: completion.proof.summary || `Codex attention bridge ${completion.result}`,
      visualRequestId: request.visual_request?.id,
      responseRef: `${request.id}:completion`,
      responsePath: completionPath,
      responseHash: completionHash,
      responseSummary: completion.proof.summary || 'Codex attention bridge completion packet',
      metadata: {
        codexAttentionBridge: {
          request_id: request.id,
          correlation_id: request.correlation_id,
          completion_path: normalizePathForMetadata(completionPath),
          completion_hash: completionHash,
          result: completion.result,
        },
      },
      now: nowIso,
    }, options);
  }

  const nextStatus = completion.result === 'blocked' ? 'blocked' : 'completed';
  const saved = saveRequest({
    ...request,
    status: nextStatus,
    completed_at: nowIso,
    completed_by: completion.completed_by,
    updated_at: nowIso,
    completion: {
      path: normalizePathForMetadata(completionPath),
      hash: completionHash,
      result: completion.result,
      work_item_proof_attached: Boolean(workItemProof?.ok),
      work_item_proof_reason: workItemProof?.ok === false ? workItemProof.reason : null,
    },
  }, { ...options, now: nowIso });

  return {
    ...saved,
    completion,
    completion_path: normalizePathForMetadata(completionPath),
    completion_hash: completionHash,
    work_item_proof: workItemProof,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  COMPLETION_SCHEMA,
  DEFAULT_BRIDGE_RELATIVE_ROOT,
  INDEX_SCHEMA,
  REQUEST_SCHEMA,
  TERMINAL_STATUSES,
  ackCodexAttentionRequest,
  completeCodexAttentionRequest,
  createCodexAttentionRequest,
  listCodexAttentionRequests,
  loadCodexAttentionRequest,
  normalizeStoredRequest,
  readIndex,
  resolveBridgeRoot,
  resolveCompletionPath,
  resolveIndexPath,
  resolveRequestPath,
  saveRequest,
};
