const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  getActiveProfile,
  getProjectRoot,
  resolveCoordPath,
} = require('../../config');

const WORK_ITEM_SCHEMA = 'squidrun.work_item.v0';
const WORK_ITEM_INDEX_SCHEMA = 'squidrun.work_item_index.v0';
const CODEX_VISUAL_REQUEST_SCHEMA = 'squidrun.work_item.codex_visual_request.v0';
const CODEX_VISUAL_RESPONSE_SCHEMA = 'squidrun.work_item.codex_visual_response.v0';
const ACTIVE_WORK_RECONCILIATION_SCHEMA = 'squidrun.work_item.active_work_reconciliation.v0';
const DEFAULT_WORK_ITEM_RELATIVE_ROOT = path.join('runtime', 'work-items');
const DEFAULT_TASK_QUEUE_RELATIVE_PATH = path.join('runtime', 'agent-task-queue.json');
const DEFAULT_CURRENT_LANE_RELATIVE_PATH = path.join('handoffs', 'current-lane.json');
const DEFAULT_VISUAL_REQUEST_DIR = 'codex-visual-requests';
const DEFAULT_INDEX_FILE = 'index.json';
const VALID_STATES = new Set(['open', 'active', 'waiting_codex_visual', 'blocked', 'closed', 'failed', 'canceled']);
const ACTIVE_STATES = new Set(['open', 'active', 'waiting_codex_visual', 'blocked']);
const TERMINAL_STATES = new Set(['closed', 'failed', 'canceled']);
const VALID_RISK_CLASSES = new Set(['safe', 'caution', 'approval_required']);
const DEFAULT_VIEWPORT_MATRIX = Object.freeze([
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]);
const DEFAULT_CODEX_VISUAL_ARTIFACT_REFS = Object.freeze([
  'screenshot',
  'trace',
  'console',
  'network',
  'dom',
  'aria',
]);

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
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
  if (Array.isArray(value)) {
    return value.flatMap((entry) => splitListValue(entry));
  }
  const text = toOptionalString(value, null);
  if (!text) return [];
  if (text.startsWith('[')) {
    const parsed = parseJsonValue(text, null);
    if (Array.isArray(parsed)) return parsed.flatMap((entry) => splitListValue(entry));
  }
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseJsonValue(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  const text = toOptionalString(value, null);
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
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
  const text = toOptionalString(value, null);
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath, payload) {
  ensureDirForFile(filePath);
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
  return filePath;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readJsonFileWithStatus(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, status: 'missing', filePath };
  }
  try {
    return {
      ok: true,
      status: 'ok',
      filePath,
      value: JSON.parse(fs.readFileSync(filePath, 'utf8')),
    };
  } catch (err) {
    return {
      ok: false,
      status: 'broken',
      filePath,
      error: err,
      brokenState: buildBrokenJsonState('work_item_json', filePath, err),
    };
  }
}

function buildBrokenJsonState(store, filePath, err) {
  return {
    status: 'broken',
    code: 'BROKEN_JSON_STATE',
    reason: `${store}_parse_error`,
    store,
    filePath: normalizePathForMetadata(filePath),
    message: err?.message || String(err || 'json parse error'),
  };
}

function makeBrokenBackupPath(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.broken-${stamp}-${process.pid}.json`
  );
}

function preserveBrokenJsonFile(filePath, store) {
  const parsed = readJsonFileWithStatus(filePath);
  if (parsed.status !== 'broken') return null;
  const backupPath = makeBrokenBackupPath(filePath);
  fs.copyFileSync(filePath, backupPath);
  return {
    ...parsed.brokenState,
    backupPath: normalizePathForMetadata(backupPath),
    store,
    reason: `${store}_parse_error`,
  };
}

function resolveWorkItemRoot(options = {}) {
  if (toOptionalString(options.workItemRoot, null)) {
    return path.resolve(options.workItemRoot);
  }
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(DEFAULT_WORK_ITEM_RELATIVE_ROOT, { forWrite: true });
  }
  return path.join(getProjectRoot(), '.squidrun', DEFAULT_WORK_ITEM_RELATIVE_ROOT);
}

function resolveTaskQueuePath(options = {}) {
  if (toOptionalString(options.queuePath, null)) return path.resolve(options.queuePath);
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(DEFAULT_TASK_QUEUE_RELATIVE_PATH, { forWrite: true });
  }
  return path.join(getProjectRoot(), '.squidrun', DEFAULT_TASK_QUEUE_RELATIVE_PATH);
}

function resolveCurrentLanePath(options = {}) {
  if (toOptionalString(options.currentLanePath, null)) return path.resolve(options.currentLanePath);
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(DEFAULT_CURRENT_LANE_RELATIVE_PATH, { forWrite: true });
  }
  return path.join(getProjectRoot(), '.squidrun', DEFAULT_CURRENT_LANE_RELATIVE_PATH);
}

function resolveIndexPath(options = {}) {
  return path.join(resolveWorkItemRoot(options), DEFAULT_INDEX_FILE);
}

function resolveItemPath(id, options = {}) {
  const itemId = normalizeWorkItemId(id);
  if (!itemId) throw new Error('work_item_id_required');
  return path.join(resolveWorkItemRoot(options), `${itemId}.json`);
}

function resolveVisualRequestPath(requestId, options = {}) {
  const id = normalizeToken(requestId);
  if (!id) throw new Error('visual_request_id_required');
  return path.join(resolveWorkItemRoot(options), DEFAULT_VISUAL_REQUEST_DIR, `${id}.json`);
}

function normalizeWorkItemId(value) {
  return normalizeToken(value, null);
}

function createWorkItemId(input = {}, nowIso = asIso(input.now)) {
  const slugSource = toOptionalString(input.objective, 'work-item') || 'work-item';
  const slug = normalizeToken(slugSource, 'work-item')
    .slice(0, 48)
    .replace(/_+$/g, '');
  const stamp = nowIso.replace(/[^0-9]/g, '').slice(0, 14) || String(Date.now());
  return `wi-${stamp}-${slug || 'work-item'}`;
}

function normalizeState(value, fallback = 'active') {
  const normalized = normalizeToken(value, fallback);
  return VALID_STATES.has(normalized) ? normalized : fallback;
}

function normalizeRiskClass(value, fallback = 'caution') {
  const normalized = normalizeToken(value, fallback);
  return VALID_RISK_CLASSES.has(normalized) ? normalized : fallback;
}

function defaultSessionId(options = {}) {
  const explicit = toOptionalString(options.sessionId || options.session, null);
  if (explicit) return explicit;
  const appStatusPath = typeof resolveCoordPath === 'function' ? resolveCoordPath('app-status.json') : null;
  const appStatus = appStatusPath ? readJsonFile(appStatusPath) : null;
  const sessionNumber = Number(appStatus?.session);
  if (Number.isInteger(sessionNumber) && sessionNumber > 0) return `app-session-${sessionNumber}`;
  return null;
}

function normalizeProject(input = {}, options = {}) {
  const projectInput = input.project && typeof input.project === 'object' ? input.project : {};
  const projectPath = toOptionalString(input.projectPath || projectInput.path || options.projectPath, null)
    || (typeof getProjectRoot === 'function' ? getProjectRoot() : null);
  const normalizedPath = projectPath ? normalizePathForMetadata(path.resolve(projectPath)) : null;
  return {
    name: toOptionalString(input.projectName || projectInput.name || options.projectName, null)
      || (normalizedPath ? path.basename(normalizedPath) : null),
    path: normalizedPath,
  };
}

function normalizeSession(input = {}, options = {}) {
  const sessionInput = input.session && typeof input.session === 'object' ? input.session : {};
  const directSession = input.session && typeof input.session === 'object' ? null : input.session;
  return {
    id: toOptionalString(sessionInput.id || directSession || input.sessionId, null) || defaultSessionId(options),
  };
}

function normalizeWindow(input = {}) {
  const windowInput = input.window && typeof input.window === 'object' ? input.window : {};
  const directWindow = input.window && typeof input.window === 'object' ? null : input.window;
  return {
    key: normalizeToken(windowInput.key || directWindow || input.windowKey || input.profile, 'main'),
  };
}

function normalizeProofRole(value) {
  return normalizeToken(value, null);
}

function normalizeRequiredProofs(values = []) {
  return uniqueStrings(splitListValue(values))
    .map((role) => normalizeProofRole(role))
    .filter(Boolean)
    .map((role) => ({ role, required: true }));
}

function normalizeRouteHealthRequirement(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...value };
  }
  const parsed = parseJsonValue(value, null);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ...parsed };
  }
  if (value === true || value === 'true' || value === '1' || value === 'required') {
    return { required: true };
  }
  return { required: false };
}

function normalizeJsonSafeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return null;
  }
}

function normalizeJamesCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.required !== true) return null;
  return {
    required: true,
    reason: toOptionalString(value.reason, 'approval_required_checkpoint'),
    policy: toOptionalString(value.policy, 'approval_required'),
  };
}

function normalizeArtifactRef(input = {}) {
  const artifactPath = toOptionalString(input.path || input.artifactPath, null);
  const ref = toOptionalString(input.ref || input.artifactRef || artifactPath, null);
  const hash = toOptionalString(input.hash || input.sha256, null)
    || (artifactPath && fs.existsSync(artifactPath) ? sha256File(artifactPath) : null);
  return {
    ref,
    path: artifactPath ? normalizePathForMetadata(path.resolve(artifactPath)) : null,
    hash,
    hashAlgorithm: hash ? 'sha256' : null,
    kind: normalizeToken(input.kind, null),
    summary: toOptionalString(input.summary, null),
  };
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest('hex')}`;
}

function proofRolesPresent(item = {}) {
  return new Set((Array.isArray(item.proofs) ? item.proofs : [])
    .map((proof) => normalizeProofRole(proof.role))
    .filter(Boolean));
}

function missingRequiredProofs(item = {}) {
  const present = proofRolesPresent(item);
  return (Array.isArray(item.requiredProofs) ? item.requiredProofs : [])
    .filter((proof) => proof?.required !== false)
    .map((proof) => normalizeProofRole(proof.role))
    .filter(Boolean)
    .filter((role) => !present.has(role));
}

function buildProofState(item = {}) {
  const missing = missingRequiredProofs(item);
  const requiredRoles = (Array.isArray(item.requiredProofs) ? item.requiredProofs : [])
    .map((proof) => normalizeProofRole(proof.role))
    .filter(Boolean);
  return {
    requiredRoles,
    presentRoles: Array.from(proofRolesPresent(item)).sort(),
    missingRoles: missing,
    complete: missing.length === 0,
  };
}

function normalizeWorkItem(raw = {}, options = {}) {
  const nowIso = asIso(options.now || options.nowMs || raw.createdAt || raw.updatedAt);
  const id = normalizeWorkItemId(raw.id) || createWorkItemId(raw, nowIso);
  const state = normalizeState(raw.state, 'active');
  const createdAt = toOptionalString(raw.createdAt, null) || nowIso;
  const updatedAt = toOptionalString(raw.updatedAt, null) || createdAt;
  const proofs = Array.isArray(raw.proofs) ? raw.proofs.map((proof) => ({
    role: normalizeProofRole(proof.role),
    artifact: normalizeArtifactRef(proof.artifact || proof),
    summary: toOptionalString(proof.summary, null),
    attachedAt: toOptionalString(proof.attachedAt, null) || updatedAt,
    metadata: proof.metadata && typeof proof.metadata === 'object' ? proof.metadata : {},
  })).filter((proof) => proof.role) : [];
  const artifactRefs = Array.isArray(raw.artifactRefs)
    ? raw.artifactRefs.map((artifact) => normalizeArtifactRef(artifact)).filter((artifact) => artifact.ref || artifact.path || artifact.hash)
    : [];
  for (const proof of proofs) {
    const artifact = proof.artifact || {};
    if (!artifact.ref && !artifact.path && !artifact.hash) continue;
    if (artifactRefs.some((existing) => sameArtifactRef(existing, artifact))) continue;
    artifactRefs.push(artifact);
  }

  const item = {
    schema: WORK_ITEM_SCHEMA,
    version: 1,
    id,
    session: normalizeSession(raw, options),
    profile: normalizeToken(raw.profile, typeof getActiveProfile === 'function' ? getActiveProfile() : 'main') || 'main',
    project: normalizeProject(raw, options),
    window: normalizeWindow(raw),
    sourceMessageIds: uniqueStrings(splitListValue(raw.sourceMessageIds || raw.sourceMessageId)),
    objective: toOptionalString(raw.objective, ''),
    ownerRoles: uniqueStrings(splitListValue(raw.ownerRoles || raw.ownerRole)).map((role) => normalizeToken(role)).filter(Boolean),
    scope: {
      in: uniqueStrings(splitListValue(raw.scopeIn || raw.scope?.in)),
      out: uniqueStrings(splitListValue(raw.scopeOut || raw.scope?.out)),
    },
    sideEffectCaps: uniqueStrings(splitListValue(raw.sideEffectCaps || raw.sideEffectCap)),
    riskClass: normalizeRiskClass(raw.riskClass, 'caution'),
    prodGateProfile: toOptionalString(raw.prodGateProfile, null),
    routeHealthRequirement: normalizeRouteHealthRequirement(raw.routeHealthRequirement || raw.routeHealthJson || raw.requireRouteHealth),
    observedSignal: normalizeJsonSafeObject(raw.observedSignal),
    suggestedNextCommand: toOptionalString(raw.suggestedNextCommand || raw.nextCommand, null),
    jamesCheckpoint: normalizeJamesCheckpoint(raw.jamesCheckpoint),
    requiredProofs: Array.isArray(raw.requiredProofs)
      ? raw.requiredProofs.map((proof) => ({
        role: normalizeProofRole(proof.role || proof),
        required: proof.required !== false,
      })).filter((proof) => proof.role)
      : normalizeRequiredProofs(raw.requiredProof || raw.requiredProofs),
    artifactRefs,
    proofs,
    visualRequests: Array.isArray(raw.visualRequests) ? raw.visualRequests : [],
    state,
    closure: raw.closure && typeof raw.closure === 'object' ? raw.closure : null,
    verdict: toOptionalString(raw.verdict, null),
    createdAt,
    updatedAt,
  };
  item.proofState = buildProofState(item);
  return item;
}

function sameArtifactRef(left = {}, right = {}) {
  return Boolean(
    (left.ref && right.ref && left.ref === right.ref)
    || (left.path && right.path && left.path === right.path)
    || (left.hash && right.hash && left.hash === right.hash)
  );
}

function readIndex(options = {}) {
  const indexPath = resolveIndexPath(options);
  const read = readJsonFileWithStatus(indexPath);
  if (read.status === 'missing') {
    return {
      schema: WORK_ITEM_INDEX_SCHEMA,
      version: 1,
      updatedAt: null,
      activeWorkItemId: null,
      items: [],
      status: 'ok',
      staleMarkers: [],
    };
  }
  if (read.status === 'broken') {
    return rebuildIndexFromItemFiles(options, buildBrokenJsonState('work_item_index', indexPath, read.error));
  }
  const parsed = read.value;
  if (!parsed || typeof parsed !== 'object') {
    return rebuildIndexFromItemFiles(options, buildBrokenJsonState(
      'work_item_index',
      indexPath,
      new Error('index payload is not an object')
    ));
  }
  return {
    schema: WORK_ITEM_INDEX_SCHEMA,
    version: 1,
    updatedAt: toOptionalString(parsed.updatedAt, null),
    activeWorkItemId: normalizeWorkItemId(parsed.activeWorkItemId),
    items: Array.isArray(parsed.items) ? parsed.items : [],
    status: 'ok',
    staleMarkers: [],
  };
}

function buildIndexEntryForItem(item, options = {}) {
  return {
    id: item.id,
    state: item.state,
    sessionId: item.session?.id || null,
    profile: item.profile || null,
    windowKey: item.window?.key || null,
    objective: item.objective,
    updatedAt: item.updatedAt,
    path: normalizePathForMetadata(resolveItemPath(item.id, options)),
  };
}

function rebuildIndexFromItemFiles(options = {}, brokenState = null) {
  const workItemRoot = resolveWorkItemRoot(options);
  const staleMarkers = ['work_item_index_rebuilt_from_item_files'];
  if (brokenState) staleMarkers.unshift(brokenState.reason || 'work_item_index_parse_error');
  const entries = [];
  if (fs.existsSync(workItemRoot)) {
    const names = fs.readdirSync(workItemRoot)
      .filter((name) => name.endsWith('.json') && name !== DEFAULT_INDEX_FILE)
      .sort();
    for (const name of names) {
      const itemPath = path.join(workItemRoot, name);
      const read = readJsonFileWithStatus(itemPath);
      if (!read.ok || !read.value || typeof read.value !== 'object') continue;
      const item = normalizeWorkItem(read.value, options);
      entries.push(buildIndexEntryForItem(item, options));
    }
  }
  entries.sort((left, right) => toTimestampMs(right.updatedAt) - toTimestampMs(left.updatedAt));
  const activeEntry = entries.find((candidate) => ACTIVE_STATES.has(candidate.state));
  return {
    schema: WORK_ITEM_INDEX_SCHEMA,
    version: 1,
    updatedAt: null,
    activeWorkItemId: activeEntry ? activeEntry.id : null,
    items: entries,
    status: brokenState ? 'rebuilt_from_broken_index' : 'rebuilt',
    brokenState,
    staleMarkers,
  };
}

function writeIndex(index, options = {}) {
  const normalized = {
    schema: WORK_ITEM_INDEX_SCHEMA,
    version: 1,
    updatedAt: asIso(options.now || options.nowMs),
    activeWorkItemId: normalizeWorkItemId(index.activeWorkItemId),
    items: Array.isArray(index.items) ? index.items : [],
  };
  const indexPath = resolveIndexPath(options);
  const preservedBrokenState = preserveBrokenJsonFile(indexPath, 'work_item_index');
  writeJsonAtomic(indexPath, normalized);
  if (preservedBrokenState) {
    normalized.preservedBrokenState = preservedBrokenState;
  }
  return normalized;
}

function updateIndexForItem(item, options = {}) {
  const index = readIndex(options);
  const entry = buildIndexEntryForItem(item, options);
  index.items = [
    ...index.items.filter((candidate) => candidate.id !== item.id),
    entry,
  ].sort((left, right) => toTimestampMs(right.updatedAt) - toTimestampMs(left.updatedAt));
  const activeEntry = index.items.find((candidate) => ACTIVE_STATES.has(candidate.state));
  index.activeWorkItemId = activeEntry ? activeEntry.id : null;
  return writeIndex(index, options);
}

function saveWorkItem(item, options = {}) {
  const normalized = normalizeWorkItem(item, options);
  writeJsonAtomic(resolveItemPath(normalized.id, options), normalized);
  const index = updateIndexForItem(normalized, options);
  return {
    ok: true,
    workItemPath: normalizePathForMetadata(resolveItemPath(normalized.id, options)),
    indexPath: normalizePathForMetadata(resolveIndexPath(options)),
    item: normalized,
    index,
  };
}

function loadWorkItem(id, options = {}) {
  const itemPath = resolveItemPath(id, options);
  const parsed = readJsonFile(itemPath);
  if (!parsed) {
    return {
      ok: false,
      reason: 'work_item_not_found',
      id: normalizeWorkItemId(id),
      workItemPath: normalizePathForMetadata(itemPath),
    };
  }
  return {
    ok: true,
    workItemPath: normalizePathForMetadata(itemPath),
    item: normalizeWorkItem(parsed, options),
  };
}

function listWorkItems(options = {}) {
  const index = readIndex(options);
  const items = [];
  for (const entry of index.items) {
    const loaded = loadWorkItem(entry.id, options);
    if (loaded.ok) items.push(loaded.item);
  }
  return {
    ok: true,
    workItemRoot: normalizePathForMetadata(resolveWorkItemRoot(options)),
    indexPath: normalizePathForMetadata(resolveIndexPath(options)),
    activeWorkItemId: index.activeWorkItemId || null,
    indexStatus: index.status || 'ok',
    brokenState: index.brokenState || null,
    staleMarkers: Array.isArray(index.staleMarkers) ? index.staleMarkers : [],
    items,
  };
}

function openWorkItem(input = {}, options = {}) {
  const nowIso = asIso(input.now || options.now || options.nowMs);
  const item = normalizeWorkItem({
    ...input,
    id: input.id || createWorkItemId(input, nowIso),
    state: input.state || 'active',
    createdAt: nowIso,
    updatedAt: nowIso,
  }, {
    ...options,
    now: nowIso,
  });
  if (!item.objective) {
    throw new Error('objective_required');
  }
  return saveWorkItem(item, { ...options, now: nowIso });
}

function attachProof(input = {}, options = {}) {
  const id = normalizeWorkItemId(input.id || input.workItemId);
  if (!id) throw new Error('work_item_id_required');
  const role = normalizeProofRole(input.role || input.proofRole);
  if (!role) throw new Error('proof_role_required');
  const loaded = loadWorkItem(id, options);
  if (!loaded.ok) return loaded;
  const nowIso = asIso(input.now || options.now || options.nowMs);
  const visualRequestId = normalizeToken(input.visualRequestId || input.requestId, null);
  const responseArtifact = normalizeArtifactRef({
    ref: input.responseRef || input.responseArtifactRef,
    path: input.responsePath || input.responseArtifactPath,
    hash: input.responseHash || input.responseSha256,
    kind: 'codex_visual_response',
    summary: input.responseSummary,
  });
  const proofMetadata = input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {};
  if (role === 'codex_browser' && visualRequestId) {
    proofMetadata.codexVisual = {
      requestId: visualRequestId,
      requestPath: loaded.item.visualRequests.find((request) => request.id === visualRequestId)?.path || null,
      responseArtifact,
      expectedResponseSchema: CODEX_VISUAL_RESPONSE_SCHEMA,
    };
  }
  const artifact = normalizeArtifactRef({
    ref: input.ref || input.artifactRef,
    path: input.path || input.artifactPath,
    hash: input.hash || input.sha256,
    kind: input.kind,
    summary: input.summary,
  });
  const proof = {
    role,
    artifact,
    summary: toOptionalString(input.summary, null),
    attachedAt: nowIso,
    metadata: proofMetadata,
  };
  const item = {
    ...loaded.item,
    proofs: [...loaded.item.proofs, proof],
    artifactRefs: loaded.item.artifactRefs,
    visualRequests: loaded.item.visualRequests.map((request) => {
      if (role !== 'codex_browser' || !visualRequestId || request.id !== visualRequestId) return request;
      return {
        ...request,
        status: 'proof_attached',
        proofAttachedAt: nowIso,
        responseRef: responseArtifact.ref || null,
        responsePath: responseArtifact.path || null,
        responseHash: responseArtifact.hash || null,
      };
    }),
    updatedAt: nowIso,
  };
  if ((artifact.ref || artifact.path || artifact.hash) && !item.artifactRefs.some((existing) => sameArtifactRef(existing, artifact))) {
    item.artifactRefs = [...item.artifactRefs, artifact];
  }
  return saveWorkItem(item, { ...options, now: nowIso });
}

function normalizeViewport(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const width = Number(value.width);
    const height = Number(value.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return {
        name: toOptionalString(value.name, `${Math.floor(width)}x${Math.floor(height)}`),
        width: Math.floor(width),
        height: Math.floor(height),
      };
    }
  }
  const text = toOptionalString(value, null);
  if (!text) return null;
  const match = text.match(/^(?:(.+?):)?(\d+)x(\d+)$/i);
  if (!match) return null;
  return {
    name: toOptionalString(match[1], `${match[2]}x${match[3]}`),
    width: Number.parseInt(match[2], 10),
    height: Number.parseInt(match[3], 10),
  };
}

function normalizeViewportMatrix(value) {
  const parsed = parseJsonValue(value, null);
  const source = Array.isArray(parsed) ? parsed : splitListValue(value);
  const normalized = source
    .map((entry) => normalizeViewport(entry))
    .filter(Boolean);
  return normalized.length ? normalized : DEFAULT_VIEWPORT_MATRIX.map((entry) => ({ ...entry }));
}

function createVisualRequestId(workItemId, nowIso) {
  const stamp = nowIso.replace(/[^0-9]/g, '').slice(0, 14) || String(Date.now());
  return `codex-visual-${stamp}-${normalizeWorkItemId(workItemId)}`;
}

function buildExpectedCodexVisualResponse(packet = {}) {
  return {
    schema: CODEX_VISUAL_RESPONSE_SCHEMA,
    version: 1,
    requestId: packet.id,
    workItemId: packet.workItemId,
    route: packet.route || null,
    url: packet.url || null,
    result: 'pass|fail|blocked',
    viewportResults: (Array.isArray(packet.viewportMatrix) ? packet.viewportMatrix : []).map((viewport) => ({
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
      result: 'pass|fail|blocked',
      console: {
        errors: [],
        warnings: [],
      },
      devBadge: {
        visible: false,
        notes: null,
      },
      overflow: {
        horizontal: false,
        scrollWidth: null,
        clientWidth: null,
      },
      artifacts: [],
      hashes: [],
      notes: null,
    })),
    artifacts: [],
    hashes: [],
    notes: null,
    noSideEffectsObserved: true,
  };
}

function requestCodexVisual(input = {}, options = {}) {
  const id = normalizeWorkItemId(input.id || input.workItemId);
  if (!id) throw new Error('work_item_id_required');
  const loaded = loadWorkItem(id, options);
  if (!loaded.ok) return loaded;
  const route = toOptionalString(input.route, null);
  const url = toOptionalString(input.url, null);
  if (!route && !url) {
    throw new Error('route_or_url_required');
  }
  const nowIso = asIso(input.now || options.now || options.nowMs);
  const requestId = normalizeToken(input.requestId, null) || createVisualRequestId(id, nowIso);
  const packet = {
    schema: CODEX_VISUAL_REQUEST_SCHEMA,
    version: 1,
    id: requestId,
    workItemId: id,
    createdAt: nowIso,
    status: 'requested',
    route,
    url,
    viewportMatrix: normalizeViewportMatrix(input.viewportMatrix || input.viewport),
    invariants: uniqueStrings(splitListValue(input.invariants || input.invariant)),
    expectations: {
      console: toOptionalString(input.consoleExpectation, 'no_new_errors'),
      devBadge: toOptionalString(input.devBadgeExpectation, 'not_visible_unless_expected'),
      overflow: toOptionalString(input.overflowExpectation, 'no_horizontal_overflow'),
    },
    noSideEffectCaps: uniqueStrings(splitListValue(input.noSideEffectCaps || input.noSideEffectCap || loaded.item.sideEffectCaps)),
    requestedArtifactRefs: uniqueStrings(splitListValue(input.requestedArtifactRefs || input.requestedArtifact || DEFAULT_CODEX_VISUAL_ARTIFACT_REFS)),
  };
  packet.expectedCodexResponse = buildExpectedCodexVisualResponse(packet);
  packet.attachProofShape = {
    command: 'hm-work-item attach-proof',
    role: 'codex_browser',
    requiredFields: ['workItemId', 'visualRequestId', 'responseArtifactRefOrPath', 'result', 'hashes'],
    example: {
      id,
      role: 'codex_browser',
      visualRequestId: requestId,
      ref: `${requestId}:codex-browser-response`,
      responseRef: `${requestId}:response-json`,
      hash: 'sha256:<artifact-or-response-hash>',
      summary: 'Codex browser proof attached; no side effects observed.',
    },
  };
  const requestPath = resolveVisualRequestPath(requestId, options);
  writeJsonAtomic(requestPath, packet);
  const item = {
    ...loaded.item,
    state: loaded.item.state === 'blocked' ? 'blocked' : 'waiting_codex_visual',
    visualRequests: [
      ...loaded.item.visualRequests,
      {
        id: requestId,
        path: normalizePathForMetadata(requestPath),
        status: packet.status,
        createdAt: nowIso,
      },
    ],
    updatedAt: nowIso,
  };
  const saved = saveWorkItem(item, { ...options, now: nowIso });
  return {
    ...saved,
    visualRequestPath: normalizePathForMetadata(requestPath),
    visualRequest: packet,
  };
}

function normalizeVerdict(value, fallback = null) {
  const normalized = normalizeToken(value, fallback);
  if (normalized === 'pass' || normalized === 'passed' || normalized === 'complete' || normalized === 'done') return 'passed';
  if (normalized === 'fail' || normalized === 'failed') return 'failed';
  if (normalized === 'block' || normalized === 'blocked') return 'blocked';
  if (normalized === 'cancel' || normalized === 'canceled' || normalized === 'cancelled') return 'canceled';
  return normalized;
}

function closeWorkItem(input = {}, options = {}) {
  const id = normalizeWorkItemId(input.id || input.workItemId);
  if (!id) throw new Error('work_item_id_required');
  const loaded = loadWorkItem(id, options);
  if (!loaded.ok) return loaded;
  const nowIso = asIso(input.now || options.now || options.nowMs);
  const verdict = normalizeVerdict(input.verdict || input.state, 'passed');
  const missing = missingRequiredProofs(loaded.item);
  const explicitNonPass = verdict === 'blocked' || verdict === 'failed' || verdict === 'canceled';
  if (missing.length > 0 && !explicitNonPass) {
    return {
      ok: false,
      reason: 'missing_required_proofs',
      missingRequiredProofs: missing,
      item: loaded.item,
      workItemPath: loaded.workItemPath,
    };
  }
  const reason = toOptionalString(input.reason, null);
  const nextState = verdict === 'blocked'
    ? 'blocked'
    : (verdict === 'failed' ? 'failed' : (verdict === 'canceled' ? 'canceled' : 'closed'));
  const item = {
    ...loaded.item,
    state: nextState,
    verdict,
    closure: {
      state: nextState,
      verdict,
      reason,
      closed: TERMINAL_STATES.has(nextState),
      closedAt: TERMINAL_STATES.has(nextState) ? nowIso : null,
      blockedAt: nextState === 'blocked' ? nowIso : null,
      missingRequiredProofs: missing,
    },
    updatedAt: nowIso,
  };
  const saved = saveWorkItem(item, { ...options, now: nowIso });
  return {
    ...saved,
    closed: TERMINAL_STATES.has(nextState),
    missingRequiredProofs: missing,
  };
}

function statusWorkItems(input = {}, options = {}) {
  const id = normalizeWorkItemId(input.id || input.workItemId);
  if (id) return loadWorkItem(id, options);
  const listed = listWorkItems(options);
  return {
    ...listed,
    activeWorkReconciliation: buildActiveWorkReconciliation({
      ...options,
      listResult: listed,
    }),
  };
}

function normalizeQueueActiveTask(agent, task = {}) {
  if (!task || typeof task !== 'object') return null;
  const taskId = toOptionalString(task.taskId || task.id, null);
  if (!taskId) return null;
  return {
    agent,
    taskId,
    title: toOptionalString(task.title, null),
    state: normalizeToken(task.state || task.status, 'active'),
    status: normalizeToken(task.status || task.state, 'active'),
    source: toOptionalString(task.source, null),
    // hm-task-queue tasks never carry updatedAt (only ms fields); derive it
    // so this field stops being always-null across the seam. No timestamp
    // means null — never a fabricated "now".
    updatedAt: toOptionalString(task.updatedAt, null)
      || (Number.isFinite(Number(task.lastAdvancedAt || task.lastDispatchAtMs || task.enqueuedAtMs))
        && Number(task.lastAdvancedAt || task.lastDispatchAtMs || task.enqueuedAtMs) > 0
        ? asIso(task.lastAdvancedAt || task.lastDispatchAtMs || task.enqueuedAtMs)
        : null),
    lastAdvancedAt: task.lastAdvancedAt || task.lastDispatchAtMs || null,
  };
}

function readQueueActiveTasks(options = {}) {
  const queuePath = resolveTaskQueuePath(options);
  const read = readJsonFileWithStatus(queuePath);
  const parsed = read.ok ? read.value : null;
  const agents = parsed?.agents && typeof parsed.agents === 'object' ? parsed.agents : {};
  const active = [];
  for (const agent of ['architect', 'builder', 'oracle']) {
    const normalized = normalizeQueueActiveTask(agent, agents[agent]?.active);
    if (normalized) active.push(normalized);
  }
  return {
    queuePath: normalizePathForMetadata(queuePath),
    brokenState: read.status === 'broken'
      ? buildBrokenJsonState('agent_task_queue', queuePath, read.error)
      : null,
    active,
  };
}

function readCurrentLaneActive(options = {}) {
  const currentLanePath = resolveCurrentLanePath(options);
  const parsed = readJsonFile(currentLanePath);
  const activeLane = parsed?.activeLane && typeof parsed.activeLane === 'object' ? parsed.activeLane : null;
  return {
    currentLanePath: normalizePathForMetadata(currentLanePath),
    source: toOptionalString(parsed?.source, null),
    status: toOptionalString(parsed?.status, null),
    generatedAt: toOptionalString(parsed?.generatedAt, null),
    sessionId: toOptionalString(parsed?.sessionId, null),
    activeLane: activeLane ? {
      laneId: toOptionalString(activeLane.laneId, null),
      workItemId: toOptionalString(activeLane.workItemId, null),
      sourceRef: toOptionalString(activeLane.sourceRef, null),
      sourceMessageId: toOptionalString(activeLane.sourceMessageId, null),
      objective: toOptionalString(activeLane.objective, null),
      kind: toOptionalString(activeLane.kind, null),
      status: toOptionalString(activeLane.status, null),
      ownerRoles: uniqueStrings(activeLane.ownerRoles || activeLane.targetRole || []),
    } : null,
  };
}

function activeWorkItemsFromList(listed = {}, options = {}) {
  const items = Array.isArray(listed.items) ? listed.items : [];
  return items
    .filter((item) => ACTIVE_STATES.has(item.state))
    .filter((item) => workItemMatchesScope(item, options))
    .sort((left, right) => toTimestampMs(right.updatedAt) - toTimestampMs(left.updatedAt));
}

function queueTaskMatchesWorkItem(task = {}, item = {}) {
  if (!task?.taskId || !item?.id) return false;
  return task.taskId === item.id || (Array.isArray(item.sourceMessageIds) && item.sourceMessageIds.includes(task.taskId));
}

function sourceMatchesWorkItem(sourceId, item = {}) {
  const source = toOptionalString(sourceId, null);
  if (!source || !item?.id) return false;
  return source === item.id
    || (Array.isArray(item.sourceMessageIds) && item.sourceMessageIds.includes(source));
}

function objectiveTokens(value) {
  const text = toOptionalString(value, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  return new Set(text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4));
}

function objectivesLikelySame(left, right) {
  const leftTokens = objectiveTokens(left);
  const rightTokens = objectiveTokens(right);
  if (leftTokens.size < 6 || rightTokens.size < 6) return false;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap >= 8;
}

function currentLaneMatchesWorkItem(activeLane = {}, item = {}) {
  if (!activeLane || !item?.id) return false;
  const laneWorkItemId = activeLane.workItemId || activeLane.laneId || activeLane.sourceRef;
  if (sourceMatchesWorkItem(laneWorkItemId, item)) return true;
  if (sourceMatchesWorkItem(activeLane.sourceMessageId, item)) return true;
  if (objectivesLikelySame(activeLane.objective, item.objective)) return true;
  return false;
}

function buildActiveWorkReconciliation(options = {}) {
  const listed = options.listResult && typeof options.listResult === 'object'
    ? options.listResult
    : (typeof options.listWorkItems === 'function' ? options.listWorkItems(options) : listWorkItems(options));
  const activeWorkItems = activeWorkItemsFromList(listed, options);
  const activeWorkItem = activeWorkItems[0] || null;
  const queue = readQueueActiveTasks(options);
  const currentLane = readCurrentLaneActive(options);
  const conflictMarkers = [];
  const staleMarkers = Array.isArray(listed.staleMarkers) ? [...listed.staleMarkers] : [];
  const conflictingStores = [];

  if (listed.brokenState) {
    staleMarkers.push(`typed_work_item_index_broken:${listed.brokenState.reason || 'unknown'}`);
  }
  if (queue.brokenState) {
    staleMarkers.push(`agent_task_queue_broken:${queue.brokenState.reason || 'unknown'}`);
  }

  if (activeWorkItem) {
    for (const task of queue.active) {
      if (!queueTaskMatchesWorkItem(task, activeWorkItem)) {
        const marker = `queue_active_conflicts_with_work_item:${task.agent}:${task.taskId}`;
        conflictMarkers.push(marker);
        conflictingStores.push({
          store: 'agent-task-queue',
          id: `${task.agent}:${task.taskId}`,
          activeId: task.taskId,
          agent: task.agent,
          sourcePath: queue.queuePath,
          active: task,
          conflictWithWorkItemId: activeWorkItem.id,
          marker,
        });
      }
    }
    if (currentLane.activeLane) {
      const laneWorkItemId = currentLane.activeLane.workItemId || currentLane.activeLane.laneId || currentLane.activeLane.sourceRef;
      const currentLaneAgrees = currentLaneMatchesWorkItem(currentLane.activeLane, activeWorkItem);
      if (laneWorkItemId && !currentLaneAgrees) {
        const marker = `current_lane_conflicts_with_work_item:${laneWorkItemId}`;
        conflictMarkers.push(marker);
        conflictingStores.push({
          store: 'current-lane',
          id: laneWorkItemId,
          activeId: laneWorkItemId,
          sourcePath: currentLane.currentLanePath,
          source: currentLane.source,
          active: currentLane.activeLane,
          conflictWithWorkItemId: activeWorkItem.id,
          marker,
        });
      }
      if (currentLane.source !== 'work_item' && !currentLaneAgrees) {
        staleMarkers.push(`current_lane_source_not_work_item:${currentLane.source || 'unknown'}`);
      }
    }
  } else {
    if (queue.active.length > 0) {
      staleMarkers.push('no_typed_active_work_item_queue_active');
    }
    if (currentLane.activeLane) {
      staleMarkers.push('no_typed_active_work_item_current_lane_active');
    }
  }

  let chosenAuthority = 'none';
  if (activeWorkItem) chosenAuthority = 'work_item';
  else if (currentLane.activeLane) chosenAuthority = 'current_lane';
  else if (queue.active.length > 0) chosenAuthority = 'agent_task_queue';

  const status = conflictMarkers.length > 0
    ? 'CONFLICT'
    : (staleMarkers.length > 0 ? 'STALE' : 'OK');

  return {
    schema: ACTIVE_WORK_RECONCILIATION_SCHEMA,
    version: 1,
    generatedAt: asIso(options.now || options.nowMs),
    status,
    authority: chosenAuthority,
    chosenAuthority,
    activeWorkItemId: activeWorkItem?.id || null,
    activeWorkItemIds: activeWorkItems.map((item) => item.id),
    queueActiveIds: queue.active.map((task) => `${task.agent}:${task.taskId}`),
    queueActive: queue.active,
    currentLaneActive: currentLane,
    conflictingStores,
    conflictMarkers,
    staleMarkers,
    warnings: [...conflictMarkers, ...staleMarkers],
  };
}

function workItemMatchesScope(item, options = {}) {
  const expectedSession = toOptionalString(options.sessionId || options.session, null);
  const expectedProfile = normalizeToken(options.profileName || options.profile, 'main');
  const expectedWindow = normalizeToken(options.windowKey || options.window || expectedProfile, expectedProfile || 'main');
  const itemSession = toOptionalString(item.session?.id, null);
  if (expectedSession && itemSession && itemSession !== expectedSession) return false;
  const itemProfile = normalizeToken(item.profile, 'main');
  const itemWindow = normalizeToken(item.window?.key, itemProfile || 'main');
  return itemProfile === expectedProfile && itemWindow === expectedWindow;
}

function deriveWorkItemCurrentLaneSnapshot(options = {}) {
  const listed = typeof options.listWorkItems === 'function'
    ? options.listWorkItems(options)
    : listWorkItems(options);
  const items = Array.isArray(listed.items) ? listed.items : [];
  const candidates = activeWorkItemsFromList(listed, options);
  const terminalCount = items.filter((item) => TERMINAL_STATES.has(item.state)).length;
  const reconciliation = buildActiveWorkReconciliation({
    ...options,
    listResult: listed,
  });
  const active = candidates[0] || null;
  const generatedAt = asIso(options.now || options.nowMs);
  if (!active) {
    return {
      version: 1,
      generatedAt,
      sessionId: toOptionalString(options.sessionId || options.session, null),
      source: 'work_item',
      status: 'none',
      activeLane: null,
      activeLaneCount: 0,
      candidateCount: 0,
      resolvedOrSupersededCount: terminalCount,
      activeWorkReconciliation: reconciliation,
      continuity: {
        next_action: null,
        recent_completed_fixes: [],
        stale_backlog_markers: reconciliation.warnings,
      },
    };
  }

  const status = active.state === 'blocked' ? 'blocked' : 'active';
  return {
    version: 1,
    generatedAt,
    sessionId: active.session?.id || toOptionalString(options.sessionId || options.session, null),
    source: 'work_item',
    status,
    activeLane: {
      laneId: active.id,
      workItemId: active.id,
      objective: active.objective,
      kind: 'proof_bound_work_item',
      priority: 200,
      status: active.state,
      sourceMessageId: active.sourceMessageIds[0] || null,
      sourceMessageIds: active.sourceMessageIds,
      sourceRef: active.id,
      sourceTimestampMs: toTimestampMs(active.createdAt),
      senderRole: 'architect',
      targetRole: active.ownerRoles[0] || null,
      ownerRoles: active.ownerRoles,
      riskClass: active.riskClass,
      prodGateProfile: active.prodGateProfile,
      routeHealthRequirement: active.routeHealthRequirement,
      observedSignal: active.observedSignal,
      suggestedNextCommand: active.suggestedNextCommand,
      jamesCheckpoint: active.jamesCheckpoint,
      sideEffectCaps: active.sideEffectCaps,
      requiredProofs: active.requiredProofs,
      proofState: active.proofState,
      artifactRefs: active.artifactRefs,
      visualRequests: active.visualRequests,
      activeWorkReconciliation: reconciliation,
      closure: active.closure,
      verdict: active.verdict,
    },
    activeLaneCount: 1,
    candidateCount: candidates.length,
    resolvedOrSupersededCount: terminalCount,
    activeWorkReconciliation: reconciliation,
    continuity: {
      next_action: status === 'blocked'
        ? `Resolve blocked work item ${active.id}: ${active.closure?.reason || active.objective}`
        : `Continue work item ${active.id}: ${active.objective}`,
      recent_completed_fixes: [],
      stale_backlog_markers: reconciliation.warnings,
    },
  };
}

module.exports = {
  ACTIVE_STATES,
  ACTIVE_WORK_RECONCILIATION_SCHEMA,
  CODEX_VISUAL_REQUEST_SCHEMA,
  CODEX_VISUAL_RESPONSE_SCHEMA,
  DEFAULT_CODEX_VISUAL_ARTIFACT_REFS,
  DEFAULT_CURRENT_LANE_RELATIVE_PATH,
  DEFAULT_TASK_QUEUE_RELATIVE_PATH,
  DEFAULT_WORK_ITEM_RELATIVE_ROOT,
  TERMINAL_STATES,
  VALID_RISK_CLASSES,
  VALID_STATES,
  WORK_ITEM_INDEX_SCHEMA,
  WORK_ITEM_SCHEMA,
  attachProof,
  buildActiveWorkReconciliation,
  closeWorkItem,
  deriveWorkItemCurrentLaneSnapshot,
  listWorkItems,
  loadWorkItem,
  missingRequiredProofs,
  normalizeWorkItem,
  openWorkItem,
  readIndex,
  requestCodexVisual,
  resolveIndexPath,
  resolveItemPath,
  resolveVisualRequestPath,
  resolveWorkItemRoot,
  saveWorkItem,
  statusWorkItems,
  writeJsonAtomic,
};
