const { ROLE_ID_MAP, LEGACY_ROLE_ALIASES, ROLE_NAMES } = require('../../config');

const DOMAIN_SCOPE_MAP = Object.freeze({
  architect: ['.squidrun/'],
  frontend: ['ui/renderer.js', 'ui/index.html', 'ui/modules/terminal.js', 'ui/modules/daemon-handlers.js'],
  builder: ['ui/modules/main/', 'ui/modules/ipc/', 'ui/modules/triggers.js', 'ui/modules/watcher.js'],
  backend: ['ui/modules/main/', 'ui/modules/ipc/', 'ui/modules/triggers.js', 'ui/modules/watcher.js'],
  oracle: ['.squidrun/build/', '.squidrun/build/errors.md', 'ui/modules/diagnostic-log.js'],
});
const CANONICAL_ROLE_IDS = new Set(
  (Array.isArray(ROLE_NAMES) && ROLE_NAMES.length > 0 ? ROLE_NAMES : ['architect', 'builder', 'oracle'])
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean)
);
const PANE_ID_TO_CANONICAL_ROLE = new Map(
  Object.entries(ROLE_ID_MAP || {})
    .map(([role, paneId]) => [String(role).toLowerCase(), String(paneId)])
    .filter(([role, paneId]) => CANONICAL_ROLE_IDS.has(role) && paneId)
    .map(([role, paneId]) => [paneId, role])
);

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeRole(role) {
  const raw = asString(role, '').toLowerCase();
  if (!raw) return 'system';
  if (raw === 'system' || raw === 'user' || raw === 'external') return raw;
  if (CANONICAL_ROLE_IDS.has(raw)) return raw;
  if (LEGACY_ROLE_ALIASES?.[raw]) return LEGACY_ROLE_ALIASES[raw];
  const paneRole = PANE_ID_TO_CANONICAL_ROLE.get(raw);
  if (paneRole) return paneRole;
  const mappedPane = ROLE_ID_MAP?.[raw];
  if (mappedPane) {
    const mappedRole = PANE_ID_TO_CANONICAL_ROLE.get(String(mappedPane));
    if (mappedRole) return mappedRole;
  }
  return raw;
}

function roleFromPaneId(paneId) {
  const pane = asString(String(paneId || ''), '');
  if (!pane) return 'system';
  const role = PANE_ID_TO_CANONICAL_ROLE.get(pane);
  if (role) return role;
  return 'system';
}

function normalizeDomain(domain) {
  const normalized = asString(domain, '').toLowerCase();
  if (!normalized) return '';
  if (normalized === 'backend') return normalized;
  const alias = LEGACY_ROLE_ALIASES?.[normalized];
  if (alias === 'builder' || alias === 'oracle') return alias;
  return normalized;
}

function parseFileScopes(task = {}, metadata = {}) {
  const scopes = new Set();
  const candidates = [];
  if (Array.isArray(task.scopes)) candidates.push(...task.scopes);
  if (Array.isArray(task.files)) candidates.push(...task.files);
  if (Array.isArray(metadata.scopes)) candidates.push(...metadata.scopes);
  if (Array.isArray(metadata.files)) candidates.push(...metadata.files);

  for (const entry of candidates) {
    const value = asString(entry, '');
    if (!value) continue;
    scopes.add(value);
  }
  return scopes;
}

function deriveTaskScopes(task = {}, domainOverride = '') {
  const scopes = new Set();
  const metadata = (task && typeof task.metadata === 'object' && !Array.isArray(task.metadata))
    ? task.metadata
    : {};
  const domain = normalizeDomain(domainOverride || metadata.domain || '');
  if (domain) {
    scopes.add(`domain:${domain}`);
    const mapped = DOMAIN_SCOPE_MAP[domain] || [];
    for (const entry of mapped) scopes.add(entry);
  }

  const taskId = asString(task.id, '');
  if (taskId) {
    scopes.add(`task:${taskId}`);
  }

  for (const entry of parseFileScopes(task, metadata)) {
    scopes.add(entry);
  }

  return [...scopes];
}

function normalizeTaskSummary(task = {}) {
  const subject = asString(task.subject, '');
  const description = asString(task.description, '');
  const text = [subject, description].filter(Boolean).join(' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function buildReadBeforeWorkQueryPayloads({ task = {}, paneId, domain = '', sessionsBack = 3, limit = 8 } = {}) {
  const role = roleFromPaneId(paneId);
  const normalizedDomain = normalizeDomain(domain || task?.metadata?.domain || '');
  const scopeCandidates = deriveTaskScopes(task, normalizedDomain)
    .filter((scope) => scope !== 'task:' && !scope.startsWith('task:'))
    .slice(0, 8);
  const summaryText = normalizeTaskSummary(task);
  const queryLimit = Math.max(1, Math.min(50, asNumber(limit, 8) || 8));
  const sessionWindow = Math.max(1, Math.min(10, asNumber(sessionsBack, 3) || 3));

  const payloads = [];
  payloads.push({
    owner: role,
    sessionsBack: sessionWindow,
    limit: queryLimit,
  });

  for (const scope of scopeCandidates) {
    payloads.push({
      scope,
      sessionsBack: sessionWindow,
      limit: Math.max(1, Math.min(20, Math.ceil(queryLimit / 2))),
    });
  }

  if (summaryText.length >= 8) {
    payloads.push({
      text: summaryText,
      sessionsBack: sessionWindow,
      limit: queryLimit,
    });
  }

  return payloads;
}

function sortClaims(claims = []) {
  return [...claims].sort((left, right) => {
    const confidenceDiff = Number(right?.confidence || 0) - Number(left?.confidence || 0);
    if (confidenceDiff !== 0) return confidenceDiff;
    const updatedDiff = Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0);
    if (updatedDiff !== 0) return updatedDiff;
    return String(left?.id || '').localeCompare(String(right?.id || ''));
  });
}

function pickTopClaims(claimGroups = [], maxClaims = 3) {
  const dedup = new Map();
  const flat = Array.isArray(claimGroups) ? claimGroups.flat() : [];
  for (const claim of flat) {
    if (!claim || typeof claim !== 'object') continue;
    const claimId = asString(claim.id, '');
    if (!claimId || dedup.has(claimId)) continue;
    dedup.set(claimId, claim);
  }

  const limit = Math.max(1, Math.min(10, asNumber(maxClaims, 3) || 3));
  return sortClaims([...dedup.values()]).slice(0, limit);
}

function summarizeStatement(statement, maxChars = 140) {
  const text = asString(statement, '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatReadBeforeWorkMessage({ task = {}, claims = [] } = {}) {
  if (!Array.isArray(claims) || claims.length === 0) return null;
  const taskId = asString(task.id, 'task');
  const header = `[TEAM MEMORY] Prior context for ${taskId}:`;
  const lines = claims.slice(0, 3).map((claim, index) => {
    const status = asString(claim.status, 'proposed');
    const claimType = asString(claim.claimType || claim.claim_type, 'fact');
    const owner = asString(claim.owner, 'system');
    const statement = summarizeStatement(claim.statement, 140);
    return `${index + 1}. (${status}/${claimType}/${owner}) ${statement}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

function buildTaskStatusPatternEvent({ task = {}, status = '', metadata = null, paneId = null, nowMs = Date.now() } = {}) {
  const normalizedStatus = asString(status, '').toLowerCase();
  if (!normalizedStatus) return null;
  const eventMetadata = (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
    ? metadata
    : {};
  const owner = roleFromPaneId(task.owner || paneId);
  const domain = normalizeDomain(task?.metadata?.domain || eventMetadata?.domain || '');
  const taskId = asString(task.id, '');
  const scopes = deriveTaskScopes(task, domain);
  const summary = normalizeTaskSummary(task);
  const errorMessage = asString(eventMetadata?.error?.message || eventMetadata?.errorMessage || '', '');

  return {
    eventType: 'task.status_changed',
    status: normalizedStatus,
    taskId: taskId || null,
    actor: owner,
    owner,
    scope: scopes[0] || (domain ? `domain:${domain}` : 'task:unknown'),
    scopes,
    domain: domain || null,
    message: summary || taskId || 'Task status changed',
    error: errorMessage || null,
    timestamp: Math.floor(asNumber(nowMs, Date.now()) || Date.now()),
  };
}

function buildTaskCloseClaimPayload({ task = {}, status = '', metadata = null, paneId = null, nowMs = Date.now() } = {}) {
  const normalizedStatus = asString(status, '').toLowerCase();
  if (normalizedStatus !== 'completed' && normalizedStatus !== 'failed') return null;

  const eventMetadata = (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
    ? metadata
    : {};
  const taskId = asString(task.id, '');
  if (!taskId) return null;

  const domain = normalizeDomain(task?.metadata?.domain || eventMetadata?.domain || '');
  const owner = roleFromPaneId(task.owner || paneId);
  const summary = normalizeTaskSummary(task);
  const errorMessage = asString(eventMetadata?.error?.message || eventMetadata?.errorMessage || '', '');
  const eventTimestamp = asString(
    task.completedAt || task.failedAt || task.updatedAt || eventMetadata.updatedAt || '',
    ''
  );
  const idempotencyKey = `task-close:${taskId}:${normalizedStatus}:${eventTimestamp || 'unknown'}`;

  const baseStatement = normalizedStatus === 'completed'
    ? `Task ${taskId} completed${summary ? `: ${summary}` : '.'}`
    : `Task ${taskId} failed${summary ? `: ${summary}` : '.'}`;
  const statement = errorMessage && normalizedStatus === 'failed'
    ? `${baseStatement} Error: ${errorMessage}`
    : baseStatement;

  return {
    statement,
    claimType: normalizedStatus === 'completed' ? 'fact' : 'negative',
    owner,
    status: 'confirmed',
    confidence: normalizedStatus === 'completed' ? 0.9 : 0.95,
    idempotencyKey,
    session: asString(eventMetadata.session, '') || null,
    nowMs: Math.floor(asNumber(nowMs, Date.now()) || Date.now()),
    scopes: deriveTaskScopes(task, domain),
  };
}

function buildGuardFiringPatternEvent(entry = {}, nowMs = Date.now()) {
  const event = (entry && typeof entry.event === 'object' && !Array.isArray(entry.event)) ? entry.event : {};
  const scope = asString(entry.scope || event.scope || event.file || 'ui/modules/triggers.js', 'ui/modules/triggers.js');
  return {
    eventType: 'guard.fired',
    scope,
    action: asString(entry.action, 'warn'),
    guardId: asString(entry.guardId, '') || null,
    message: asString(entry.message, 'Guard fired'),
    status: asString(event.status, '') || null,
    claimId: asString(event.claimId || event.claim_id, '') || null,
    target: asString(event.target, '') || null,
    timestamp: Math.floor(asNumber(nowMs, Date.now()) || Date.now()),
  };
}

function buildGuardPreflightEvent({ target = '', content = '', fromRole = 'system', traceContext = null, nowMs = Date.now() } = {}) {
  const normalizedTarget = asString(target, '').toLowerCase();
  const role = normalizeRole(fromRole);
  const traceId = asString(traceContext?.traceId || traceContext?.correlationId, '') || null;
  return {
    eventType: 'comms.preflight',
    scope: 'ui/modules/triggers.js',
    target: normalizedTarget || null,
    actor: role,
    message: asString(content, '').slice(0, 512),
    traceId,
    timestamp: Math.floor(asNumber(nowMs, Date.now()) || Date.now()),
  };
}

function buildSessionLifecyclePatternEvent({
  paneId = null,
  status = '',
  exitCode = null,
  reason = '',
  nowMs = Date.now(),
} = {}) {
  const pane = asString(String(paneId || ''), '');
  const normalizedStatus = asString(status, '').toLowerCase();
  if (!pane || !normalizedStatus) return null;

  const role = roleFromPaneId(pane);
  const code = asNumber(exitCode, null);
  const normalizedReason = asString(reason, '');
  const message = normalizedStatus === 'started'
    ? `Session started for pane ${pane}`
    : `Session ended for pane ${pane}${Number.isFinite(code) ? ` (exit ${code})` : ''}`;

  return {
    eventType: 'session.lifecycle',
    scope: `pane:${pane}`,
    paneId: pane,
    actor: role,
    owner: role,
    status: normalizedStatus,
    exitCode: Number.isFinite(code) ? Math.floor(code) : null,
    reason: normalizedReason || null,
    message,
    timestamp: Math.floor(asNumber(nowMs, Date.now()) || Date.now()),
  };
}

function isDeliveryFailureResult(result = {}) {
  if (!result || typeof result !== 'object') return true;
  if (result.verified === true) return false;
  if (result.accepted === false) return true;
  if (result.queued === false) return true;
  const status = asString(result.status, '').toLowerCase();
  if (!status) return true;
  return (
    status.includes('unverified')
    || status.includes('timeout')
    || status.includes('failed')
    || status === 'no_targets'
    || status === 'invalid_target'
    || status === 'guard_blocked'
  );
}

function buildDeliveryFailurePatternEvent({
  channel = 'send',
  target = null,
  fromRole = 'system',
  result = {},
  traceContext = null,
  nowMs = Date.now(),
} = {}) {
  const role = normalizeRole(fromRole);
  const status = asString(result?.status, 'delivery_failed');
  const traceId = asString(traceContext?.traceId || traceContext?.correlationId, '') || null;
  const notified = Array.isArray(result?.notified) ? result.notified.map((entry) => String(entry)) : [];
  return {
    eventType: 'delivery.failed',
    scope: 'ui/modules/triggers.js',
    channel: asString(channel, 'send'),
    status,
    target: asString(target, '') || null,
    actor: role,
    notified,
    deliveryId: asString(result?.deliveryId, '') || null,
    traceId,
    message: asString(result?.details?.reason || result?.details?.error || status, status),
    timestamp: Math.floor(asNumber(nowMs, Date.now()) || Date.now()),
  };
}

function buildDeliveryOutcomePatternEvent({
  channel = 'send',
  target = null,
  fromRole = 'system',
  result = {},
  traceContext = null,
  nowMs = Date.now(),
} = {}) {
  const role = normalizeRole(fromRole);
  const status = asString(result?.status, 'delivery_unknown');
  const traceId = asString(traceContext?.traceId || traceContext?.correlationId, '') || null;
  const notified = Array.isArray(result?.notified) ? result.notified.map((entry) => String(entry)) : [];
  const verified = result?.verified === true;
  const accepted = result?.accepted !== false;
  const queued = result?.queued !== false;
  const outcome = verified
    ? 'delivered'
    : (accepted && queued ? 'accepted_unverified' : 'failed');

  return {
    eventType: 'delivery.outcome',
    scope: 'ui/modules/triggers.js',
    channel: asString(channel, 'send'),
    status,
    outcome,
    target: asString(target, '') || null,
    actor: role,
    notified,
    deliveryId: asString(result?.deliveryId, '') || null,
    traceId,
    verified,
    accepted,
    queued,
    message: asString(result?.details?.reason || result?.details?.error || status, status),
    timestamp: Math.floor(asNumber(nowMs, Date.now()) || Date.now()),
  };
}

function buildIntentUpdatePatternEvent({
  paneId = null,
  role = null,
  session = null,
  intent = '',
  previousIntent = '',
  source = 'renderer',
  nowMs = Date.now(),
} = {}) {
  const pane = asString(String(paneId || ''), '');
  if (!pane) return null;
  const normalizedRole = normalizeRole(role || roleFromPaneId(pane));
  const normalizedIntent = asString(intent, '');
  const priorIntent = asString(previousIntent, '');
  const normalizedSession = asString(String(session ?? ''), '');
  return {
    eventType: 'intent.updated',
    scope: `pane:${pane}`,
    paneId: pane,
    actor: normalizedRole,
    owner: normalizedRole,
    session: normalizedSession || null,
    status: 'updated',
    intent: normalizedIntent || null,
    previousIntent: priorIntent || null,
    source: asString(source, 'renderer'),
    message: normalizedIntent || 'Intent updated',
    timestamp: Math.floor(asNumber(nowMs, Date.now()) || Date.now()),
  };
}

module.exports = {
  roleFromPaneId,
  normalizeDomain,
  deriveTaskScopes,
  buildReadBeforeWorkQueryPayloads,
  pickTopClaims,
  formatReadBeforeWorkMessage,
  buildTaskStatusPatternEvent,
  buildTaskCloseClaimPayload,
  buildGuardFiringPatternEvent,
  buildGuardPreflightEvent,
  buildSessionLifecyclePatternEvent,
  isDeliveryFailureResult,
  buildDeliveryFailurePatternEvent,
  buildDeliveryOutcomePatternEvent,
  buildIntentUpdatePatternEvent,
};
