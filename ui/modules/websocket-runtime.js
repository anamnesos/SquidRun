/**
 * WebSocket Server for Agent Communication
 * Provides low-latency message delivery bypassing file-based triggers
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const {
  BACKWARD_COMPAT_ROLE_ALIASES,
  ROLE_ID_MAP,
  WORKSPACE_PATH,
  resolveCoordPath,
  resolveBackgroundBuilderAlias,
  resolveBackgroundBuilderPaneId,
  resolveWebSocketPort,
} = require('../config');
const {
  DEFAULT_PROFILE,
  isMainProfile,
  normalizeProfileName,
} = require('../profile');
const {
  applyModelPromptReceiptToAck,
  waitForModelPromptReceipt,
} = require('./model-prompt-receipt');
const {
  getTrustQuoteArmPaneIds,
} = require('./trustquote-arm-specs');

const DEFAULT_PORT = resolveWebSocketPort({
  profileName: process.env.SQUIDRUN_PROFILE || DEFAULT_PROFILE,
});
const MESSAGE_ACK_TTL_MS = 60000;
const ROUTING_STALE_MS = 60000;
const RATE_LIMIT_WINDOW_MS = 1000;  // 1-second sliding window
const RATE_LIMIT_MAX_MESSAGES = 50; // max messages per window per client
const MAX_MESSAGE_SIZE = 256 * 1024; // 256KB max message size
const PENDING_MESSAGE_ACK_TTL_MS = Number.parseInt(
  process.env.SQUIDRUN_COMMS_PENDING_ACK_TTL_MS || String(2 * 60 * 1000),
  10
);
const CONTENT_DEDUPE_TTL_MS = Number.parseInt(process.env.SQUIDRUN_COMMS_CONTENT_DEDUPE_TTL_MS || '15000', 10);
const OUTBOUND_QUEUE_MAX_ENTRIES = Number.parseInt(process.env.SQUIDRUN_COMMS_QUEUE_MAX_ENTRIES || '500', 10);
const OUTBOUND_QUEUE_MAX_AGE_MS = Number.parseInt(process.env.SQUIDRUN_COMMS_QUEUE_MAX_AGE_MS || String(30 * 60 * 1000), 10);
const OUTBOUND_QUEUE_FLUSH_INTERVAL_MS = Number.parseInt(process.env.SQUIDRUN_COMMS_QUEUE_FLUSH_INTERVAL_MS || '30000', 10);
const MODEL_PROMPT_RECEIPT_WAIT_MS = Number.parseInt(process.env.SQUIDRUN_MODEL_PROMPT_RECEIPT_WAIT_MS || '1200', 10);
const DEFAULT_QUEUE_SESSION_SCOPE = 'default';
const CANONICAL_ROLE_IDS = ['architect', 'builder', 'oracle'];
const CANONICAL_ROLE_TO_PANE = new Map(
  CANONICAL_ROLE_IDS
    .map((role) => [role, String(ROLE_ID_MAP?.[role] || '')])
    .filter(([, paneId]) => Boolean(paneId))
);
const PANE_TO_CANONICAL_ROLE = new Map(
  Array.from(CANONICAL_ROLE_TO_PANE.entries()).map(([role, paneId]) => [paneId, role])
);
const TRUSTQUOTE_ARM_TARGET_IDS = new Set(
  getTrustQuoteArmPaneIds()
    .map((paneId) => String(paneId || '').trim().toLowerCase())
    .filter(Boolean)
);
const SIDE_CONTEXT_PATTERN = /\b(eunbyeol|eunby[e]?ol|rachel|side-window|case\s+(?:file|folder|context)|scoped\s+case)\b/i;
const MAIN_CONTEXT_PATTERN = /\b(main\s+(?:builder|architect|oracle)|trading|trade|hood|hyperliquid|ci\s+fix)\b/i;
let wss = null;
let clients = new Map(); // clientId -> { ws, paneId, role }
let clientIdCounter = 0;
let messageHandler = null; // External handler for incoming messages
let recentMessageAcks = new Map(); // messageId -> { ackPayload, expiresAt }
let pendingMessageAcks = new Map(); // messageId -> { promise, createdAt, clientId, resolve, reject }
let recentDispatchAcks = new Map(); // dedupeKey -> { ackPayload, expiresAt }
let pendingDispatchAcks = new Map(); // dedupeKey -> Promise<ackPayload>
let outboundQueue = []; // [{ id, target, content, meta, createdAt, attempts, lastAttemptAt, queuedBy }]
let outboundQueueFlushTimer = null;
let outboundQueueFlushInProgress = false;
let queueSessionScopeId = DEFAULT_QUEUE_SESSION_SCOPE;
let startInFlightPromise = null;

function generateTraceToken(prefix = 'evt') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch (_err) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getDefaultOutboundQueuePath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('state', 'comms-outbound-queue.json'), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, 'state', 'comms-outbound-queue.json');
}

function getOutboundQueuePath() {
  const envPath = toNonEmptyString(process.env.SQUIDRUN_COMMS_QUEUE_FILE);
  if (envPath) {
    return path.resolve(envPath);
  }
  return getDefaultOutboundQueuePath();
}

function normalizePaneId(paneId) {
  if (paneId === null || paneId === undefined) return null;
  const normalized = String(paneId).trim();
  return normalized ? normalized : null;
}

function normalizeRoleId(role) {
  if (typeof role !== 'string') return null;
  const normalized = role.trim().toLowerCase();
  if (!normalized) return null;
  if (CANONICAL_ROLE_IDS.includes(normalized)) return normalized;
  if (BACKWARD_COMPAT_ROLE_ALIASES?.[normalized]) {
    return BACKWARD_COMPAT_ROLE_ALIASES[normalized];
  }
  const mappedPaneId = ROLE_ID_MAP?.[normalized];
  if (mappedPaneId) {
    return PANE_TO_CANONICAL_ROLE.get(String(mappedPaneId)) || null;
  }
  return null;
}

function getPaneIdForRole(role) {
  if (!role) return null;
  return CANONICAL_ROLE_TO_PANE.get(role) || null;
}

function getRoleForPaneId(paneId) {
  if (!paneId) return null;
  return PANE_TO_CANONICAL_ROLE.get(String(paneId)) || null;
}

function isCanonicalLocalPaneRoleTarget(target) {
  return Boolean(normalizeRoleId(target));
}

function isTrustQuoteArmTarget(target) {
  const normalized = String(target || '').trim().toLowerCase();
  return TRUSTQUOTE_ARM_TARGET_IDS.has(normalized);
}

function normalizeScopeProfile(value) {
  return normalizeProfileName(value || DEFAULT_PROFILE);
}

function normalizeWindowKey(value, fallbackProfile = DEFAULT_PROFILE) {
  const normalized = toNonEmptyString(value);
  return normalized ? normalizeProfileName(normalized) : normalizeScopeProfile(fallbackProfile);
}

function normalizeScopeString(value) {
  return toNonEmptyString(value);
}

function normalizeClientScope(input = {}, fallback = {}) {
  const profileName = normalizeScopeProfile(
    input.profileName
    || input.profile
    || input.windowProfile
    || fallback.profileName
    || DEFAULT_PROFILE
  );
  return {
    profileName,
    windowKey: normalizeWindowKey(input.windowKey || input.window || fallback.windowKey, profileName),
    sessionScopeId: normalizeScopeString(
      input.sessionScopeId
      || input.sessionScope
      || input.scopeId
      || fallback.sessionScopeId
    ),
  };
}

function getObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeClientRouteBinding(input = {}, scope = {}) {
  const binding = getObject(input.routeBinding || input.route_binding || input.clientBinding);
  const metadata = getObject(input.metadata);
  const metadataBinding = getObject(metadata.routeBinding || metadata.route_binding || metadata.clientBinding);
  const source = Object.keys(binding).length ? binding : metadataBinding;
  const profileName = normalizeScopeProfile(source.profileName || source.profile || scope.profileName || DEFAULT_PROFILE);
  const windowKey = normalizeWindowKey(source.windowKey || source.window || scope.windowKey, profileName);
  return {
    clientKind: toNonEmptyString(source.clientKind || source.kind || input.clientKind),
    routeOwner: toNonEmptyString(source.routeOwner || source.owner || input.routeOwner),
    roomId: toNonEmptyString(source.roomId || source.room_id),
    role: normalizeRoleId(source.role || input.role) || toNonEmptyString(source.role || input.role),
    paneId: normalizePaneId(source.paneId || source.pane_id || input.paneId)
      || toNonEmptyString(source.paneId || source.pane_id || input.paneId),
    terminalPaneId: toNonEmptyString(source.terminalPaneId || source.terminal_pane_id),
    terminalBacked: source.terminalBacked === true || source.terminal_backed === true,
    agentProcessStarted: source.agentProcessStarted === true || source.agent_process_started === true,
    profileName,
    windowKey,
    sessionScopeId: normalizeScopeString(
      source.sessionScopeId
      || source.session_scope_id
      || scope.sessionScopeId
    ),
    workspace: toNonEmptyString(source.workspace || source.projectPath || source.projectRoot),
    startupBundlePath: toNonEmptyString(source.startupBundlePath || source.startup_bundle_path),
    workstreamPath: toNonEmptyString(source.workstreamPath || source.workstream_path),
  };
}

function extractExplicitRouteScope(message = {}) {
  const metadata = getObject(message.metadata);
  const envelope = getObject(metadata.envelope);
  const routing = getObject(metadata.routing || metadata.route || metadata.scope || envelope.routing);
  const targetMeta = getObject(metadata.target || envelope.target);
  const explicitProfile = routing.profileName
    || routing.profile
    || routing.windowProfile
    || targetMeta.profileName
    || targetMeta.profile
    || targetMeta.windowProfile
    || message.targetProfile
    || message.profileName;
  if (!toNonEmptyString(explicitProfile)) return null;
  const profileName = normalizeScopeProfile(explicitProfile);
  return {
    explicit: true,
    profileName,
    windowKey: normalizeWindowKey(
      routing.windowKey || routing.window || targetMeta.windowKey || targetMeta.window,
      profileName
    ),
    sessionScopeId: normalizeScopeString(
      routing.sessionScopeId
      || routing.sessionScope
      || routing.scopeId
      || targetMeta.sessionScopeId
      || targetMeta.sessionScope
    ),
  };
}

function inferProfileFromPathHint(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const normalized = text.replace(/\\/g, '/');
  const match = normalized.match(/\/\.squidrun\/profiles\/([^/]+)\/workspace(?:\/|$)/i);
  if (!match || !match[1]) return null;
  return normalizeScopeProfile(match[1]);
}

function classifyAbsolutePathsByProfile(content) {
  const profiles = new Set();
  if (!content) return profiles;
  const text = String(content).replace(/\\/g, '/');
  const re = /\bD:\/projects\/squidrun(?:\/(\S*))?/gi;
  let match;
  while ((match = re.exec(text))) {
    const rest = (match[1] || '').replace(/[.,;:)\]'"]+$/, '');
    const sideMatch = rest.match(/^\.squidrun\/profiles\/([^/]+)\/workspace(?:\/|$)/i);
    if (sideMatch && sideMatch[1]) {
      profiles.add(normalizeScopeProfile(sideMatch[1]));
    } else {
      profiles.add(DEFAULT_PROFILE);
    }
  }
  return profiles;
}

function extractMessageProfileHints(message = {}) {
  const metadata = getObject(message.metadata);
  const envelope = getObject(metadata.envelope);
  const senderMeta = getObject(metadata.sender || envelope.sender);
  const targetMeta = getObject(metadata.target || envelope.target);
  const routing = getObject(metadata.routing || metadata.route || metadata.scope || envelope.routing);
  const project = getObject(metadata.project || envelope.project);
  const hints = [];
  const add = (value) => {
    const text = toNonEmptyString(value);
    if (text) hints.push(normalizeScopeProfile(text));
  };

  add(metadata.profileName || metadata.profile || metadata.windowProfile);
  add(senderMeta.profileName || senderMeta.profile || senderMeta.windowProfile);
  add(targetMeta.profileName || targetMeta.profile || targetMeta.windowProfile);
  add(routing.profileName || routing.profile || routing.windowProfile);
  add(inferProfileFromPathHint(project.path));
  add(inferProfileFromPathHint(metadata.projectPath));

  return Array.from(new Set(hints));
}

function getTargetRole(target) {
  const identity = resolveTargetIdentity(target);
  return identity.role || null;
}

function isScopedDiagnosticMessage(message = {}) {
  const metadata = getObject(message.metadata);
  const routing = getObject(metadata.routing || metadata.route || metadata.scope);
  const channel = String(
    routing.channel
    || routing.diagnosticChannel
    || metadata.channel
    || metadata.diagnosticChannel
    || ''
  ).trim().toLowerCase();
  return channel === 'scoped-diagnostic' || channel === 'profile-diagnostic';
}

function isArchitectToArchitectTarget(clientInfo = {}, message = {}) {
  const senderRole = normalizeRoleId(clientInfo.role) || clientInfo.role || null;
  const targetRole = getTargetRole(message.target);
  return senderRole === 'architect' && targetRole === 'architect';
}

function buildRoutingErrorAck(message, traceContext, status, error, details = {}) {
  return {
    type: 'send-ack',
    messageId: message.messageId || null,
    ok: false,
    accepted: false,
    queued: false,
    verified: false,
    status,
    error,
    routingError: true,
    failClosed: true,
    ...details,
    traceId: traceContext?.traceId || null,
    parentEventId: traceContext?.parentEventId || null,
    timestamp: Date.now(),
  };
}

function notifyMainArchitectRoutingError(sourceInfo = {}, message = {}, status, error, details = {}) {
  const payload = JSON.stringify({
    type: 'routing_error',
    from: 'routing-guard',
    status,
    error,
    source: {
      role: sourceInfo.role || null,
      paneId: sourceInfo.paneId || null,
      profileName: sourceInfo.profileName || DEFAULT_PROFILE,
      windowKey: sourceInfo.windowKey || sourceInfo.profileName || DEFAULT_PROFILE,
    },
    target: message.target || null,
    details,
    timestamp: Date.now(),
  });

  for (const info of clients.values()) {
    if (!info || info.ws?.readyState !== 1) continue;
    if (info.role !== 'architect') continue;
    if (!clientMatchesRouteScope(info, { profileName: DEFAULT_PROFILE, windowKey: DEFAULT_PROFILE })) continue;
    try {
      info.ws.send(payload);
    } catch (err) {
      log.warn('WebSocket', `Failed to notify main Architect about routing error: ${err.message}`);
    }
  }
}

function detectWrongContextRoute(clientInfo = {}, message = {}, routeScope = {}) {
  const targetRole = getTargetRole(message.target);
  const senderRole = normalizeRoleId(clientInfo.role) || clientInfo.role || null;
  const targetProfile = normalizeScopeProfile(routeScope?.targetScope?.profileName || DEFAULT_PROFILE);
  const senderProfile = normalizeScopeProfile(clientInfo.profileName || DEFAULT_PROFILE);
  const content = String(message.content || '');
  const profileHints = extractMessageProfileHints(message);
  const hasNonMainHint = profileHints.some((profileName) => !isMainProfile(profileName));
  const hasMainHint = profileHints.some((profileName) => isMainProfile(profileName));
  const pathProfiles = classifyAbsolutePathsByProfile(content);
  const hasForeignMainPath = !isMainProfile(targetProfile)
    && pathProfiles.has(DEFAULT_PROFILE);
  const hasForeignSidePath = [...pathProfiles].some(
    (profileName) => !isMainProfile(profileName) && profileName !== targetProfile
  );
  const sameSideProfile = !isMainProfile(targetProfile)
    && senderProfile === targetProfile
    && (profileHints.length === 0 || profileHints.every((profileName) => profileName === targetProfile));
  const hasSideContent = !sameSideProfile && SIDE_CONTEXT_PATTERN.test(content);
  const hasMainContent = !sameSideProfile && MAIN_CONTEXT_PATTERN.test(content);
  const scopedDiagnostic = isScopedDiagnosticMessage(message);

  if (scopedDiagnostic && (senderRole !== 'architect' || targetRole !== 'architect')) {
    return {
      status: 'routing_error',
      error: 'Scoped diagnostic channel is architect-to-architect only',
      details: { reason: 'invalid_scoped_diagnostic_target', targetRole, senderRole },
    };
  }

  if (scopedDiagnostic && senderRole === 'architect' && targetRole === 'architect') {
    return null;
  }

  if (isMainProfile(targetProfile) && (hasNonMainHint || hasSideContent || hasForeignSidePath) && targetRole !== 'architect') {
    const pattern = hasNonMainHint
      ? null
      : (hasSideContent ? 'SIDE_CONTEXT_PATTERN' : 'foreign_side_profile_path');
    return {
      status: 'routing_error',
      error: 'Side-profile/case context cannot be delivered to main Builder or Oracle',
      details: {
        reason: hasNonMainHint ? 'profile_metadata_mismatch' : 'content_context_mismatch',
        pattern,
        targetRole,
        targetProfile,
        profileHints,
      },
    };
  }

  if (!isMainProfile(targetProfile) && (hasMainHint || hasMainContent || hasForeignMainPath) && targetRole !== 'architect') {
    const pattern = hasMainHint
      ? null
      : (hasMainContent ? 'MAIN_CONTEXT_PATTERN' : 'foreign_main_tree_path');
    return {
      status: 'routing_error',
      error: 'Main SquidRun context cannot be delivered to a side-profile Builder or Oracle',
      details: {
        reason: hasMainHint ? 'profile_metadata_mismatch' : 'content_context_mismatch',
        pattern,
        targetRole,
        targetProfile,
        profileHints,
      },
    };
  }

  return null;
}

function resolveRouteScope(clientInfo = {}, message = {}) {
  const senderScope = normalizeClientScope(clientInfo);
  const explicitScope = extractExplicitRouteScope(message);

  if (!isMainProfile(senderScope.profileName)) {
    if (explicitScope && explicitScope.profileName !== senderScope.profileName) {
      if (isArchitectToArchitectTarget(clientInfo, message)) {
        return {
          ok: true,
          senderScope,
          targetScope: explicitScope,
          failClosed: true,
        };
      }
      return {
        ok: false,
        status: 'cross_profile_scope_mismatch',
        error: `Sender profile '${senderScope.profileName}' cannot target profile '${explicitScope.profileName}'`,
        senderScope,
        targetScope: explicitScope,
        failClosed: true,
      };
    }
    return {
      ok: true,
      senderScope,
      targetScope: {
        profileName: senderScope.profileName,
        windowKey: senderScope.windowKey,
        sessionScopeId: senderScope.sessionScopeId,
      },
      failClosed: true,
    };
  }

  if (explicitScope && !isMainProfile(explicitScope.profileName)) {
    if (!isArchitectToArchitectTarget(clientInfo, message) && getTargetRole(message.target) === 'architect') {
      return {
        ok: false,
        status: 'cross_profile_scope_mismatch',
        error: `Sender role '${clientInfo.role || 'unknown'}' cannot target architect in profile '${explicitScope.profileName}'`,
        senderScope,
        targetScope: explicitScope,
        failClosed: true,
      };
    }
    return {
      ok: true,
      senderScope,
      targetScope: explicitScope,
      failClosed: true,
    };
  }

  return {
    ok: true,
    senderScope,
    targetScope: {
      profileName: DEFAULT_PROFILE,
      windowKey: DEFAULT_PROFILE,
      sessionScopeId: null,
    },
    failClosed: false,
  };
}

function clientMatchesRouteScope(info, routeScope = {}) {
  const targetScope = routeScope?.targetScope || routeScope;
  const requiredProfile = normalizeScopeProfile(targetScope?.profileName || DEFAULT_PROFILE);
  const clientProfile = normalizeScopeProfile(info?.profileName || DEFAULT_PROFILE);
  if (clientProfile !== requiredProfile) return false;

  const requiredWindowKey = toNonEmptyString(targetScope?.windowKey);
  if (requiredWindowKey) {
    const clientWindowKey = normalizeWindowKey(info?.windowKey, clientProfile);
    if (clientWindowKey !== normalizeWindowKey(requiredWindowKey, requiredProfile)) return false;
  }

  const requiredSessionScopeId = toNonEmptyString(targetScope?.sessionScopeId);
  if (requiredSessionScopeId) {
    const clientSessionScopeId = toNonEmptyString(info?.sessionScopeId);
    if (clientSessionScopeId !== requiredSessionScopeId) return false;
  }

  return true;
}

function canUseLocalHandlerRoute(routeScope = {}, clientInfo = {}, message = {}) {
  if (!messageHandler) return false;
  const target = message?.target;
  const targetIdentity = resolveTargetIdentity(target);
  const canonicalLocalTarget = (
    isCanonicalLocalPaneRoleTarget(target)
    || isTrustQuoteArmTarget(target)
    || (targetIdentity.role && CANONICAL_ROLE_IDS.includes(targetIdentity.role))
  );
  if (!canonicalLocalTarget || (!targetIdentity.role && !targetIdentity.paneId)) return false;
  const senderProfile = normalizeScopeProfile(routeScope?.senderScope?.profileName || DEFAULT_PROFILE);
  const targetProfile = normalizeScopeProfile(routeScope?.targetScope?.profileName || DEFAULT_PROFILE);
  if (!routeScope?.failClosed) {
    return isMainProfile(senderProfile) && isMainProfile(targetProfile);
  }
  if (isMainProfile(senderProfile) && !isMainProfile(targetProfile)) {
    return isArchitectToArchitectTarget(clientInfo, message);
  }
  if (!isMainProfile(senderProfile) && senderProfile === targetProfile) return true;
  return (
    !isMainProfile(senderProfile)
    && isMainProfile(targetProfile)
    && isArchitectToArchitectTarget(clientInfo, message)
  );
}

function markClientSeen(clientId, source = 'message', now = Date.now()) {
  const clientInfo = clients.get(clientId);
  if (!clientInfo) return null;
  clientInfo.lastSeen = now;
  return {
    role: clientInfo.role || null,
    paneId: clientInfo.paneId || null,
    lastSeen: now,
    source,
  };
}

function coerceStaleAfterMs(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return ROUTING_STALE_MS;
  }
  return parsed;
}

function resolveTargetIdentity(target) {
  if (target === null || target === undefined) {
    return { role: null, paneId: null };
  }

  const rawTarget = String(target).trim().toLowerCase();
  if (!rawTarget) {
    return { role: null, paneId: null };
  }

  if (TRUSTQUOTE_ARM_TARGET_IDS.has(rawTarget)) {
    return {
      role: rawTarget,
      paneId: rawTarget,
    };
  }

  const backgroundPaneId = typeof resolveBackgroundBuilderPaneId === 'function'
    ? resolveBackgroundBuilderPaneId(rawTarget)
    : null;
  if (backgroundPaneId) {
    const backgroundAlias = typeof resolveBackgroundBuilderAlias === 'function'
      ? resolveBackgroundBuilderAlias(rawTarget)
      : null;
    return {
      role: backgroundAlias,
      paneId: backgroundPaneId,
    };
  }

  const paneId = normalizePaneId(rawTarget);
  if (paneId && PANE_TO_CANONICAL_ROLE.has(paneId)) {
    return {
      role: getRoleForPaneId(paneId),
      paneId,
    };
  }

  const role = normalizeRoleId(rawTarget);
  if (!role) {
    return { role: null, paneId: null };
  }

  return {
    role,
    paneId: getPaneIdForRole(role),
  };
}

function getRoutingHealth(target, staleAfterMs = ROUTING_STALE_MS, now = Date.now(), routeScope = null, options = {}) {
  const staleThresholdMs = coerceStaleAfterMs(staleAfterMs);
  const identity = resolveTargetIdentity(target);
  const excludeClientId = options?.excludeClientId == null ? null : String(options.excludeClientId);
  if (!identity.role && !identity.paneId) {
    return {
      healthy: false,
      status: 'invalid_target',
      role: null,
      paneId: null,
      lastSeen: null,
      ageMs: null,
      staleThresholdMs,
      source: null,
    };
  }

  const hasLocalHandlerRoute = canUseLocalHandlerRoute(routeScope, options?.clientInfo || {}, { target });
  let route = null;
  for (const [candidateClientId, info] of clients) {
    if (!info) continue;
    if (excludeClientId !== null && String(candidateClientId) === excludeClientId) continue;
    if (routeScope && !clientMatchesRouteScope(info, routeScope)) continue;
    if (identity.role && info.role === identity.role) {
      route = info;
      break;
    }
    if (identity.paneId && info.paneId && String(info.paneId) === String(identity.paneId)) {
      route = info;
      break;
    }
  }

  if (!route || !Number.isFinite(route.lastSeen)) {
    if (hasLocalHandlerRoute) {
      return {
        healthy: true,
        status: 'handler_route_available',
        role: identity.role || null,
        paneId: identity.paneId || null,
        lastSeen: null,
        ageMs: null,
        staleThresholdMs,
        source: 'local_message_handler',
        routeScope: routeScope?.targetScope || routeScope || null,
      };
    }
    return {
      healthy: false,
      status: 'no_route',
      role: identity.role || route?.role || null,
      paneId: identity.paneId || route?.paneId || null,
      lastSeen: null,
      ageMs: null,
      staleThresholdMs,
      source: null,
      routeScope: routeScope?.targetScope || routeScope || null,
    };
  }

  const ageMs = Math.max(0, now - route.lastSeen);
  const healthy = ageMs <= staleThresholdMs;

  return {
    healthy,
    status: healthy ? 'healthy' : 'stale',
    role: identity.role || route.role || null,
    paneId: identity.paneId || route.paneId || null,
    lastSeen: route.lastSeen,
    ageMs,
    staleThresholdMs,
    source: 'client_activity',
    routeScope: routeScope?.targetScope || routeScope || null,
    clientKind: route.clientKind || null,
    routeBinding: route.routeBinding || null,
  };
}

async function emitCommsMetric(clientId, clientInfo, eventType, payload = {}) {
  if (!messageHandler || !eventType) return;
  try {
    await messageHandler({
      clientId,
      paneId: clientInfo?.paneId,
      role: clientInfo?.role,
      message: {
        type: 'comms-metric',
        eventType,
        payload,
      },
    });
  } catch (err) {
    log.warn('WebSocket', `Failed to emit comms metric ${eventType}: ${err.message}`);
  }
}

function emitAckLatencyMetric(clientId, clientInfo, message, ackPayload, receivedAtMs) {
  if (!ackPayload || !Number.isFinite(receivedAtMs)) return;
  const ackLatencyMs = Math.max(0, Date.now() - receivedAtMs);
  ackPayload.ackLatencyMs = ackLatencyMs;
  void emitCommsMetric(clientId, clientInfo, 'comms.ack.latency', {
    ackLatencyMs,
    messageType: message?.type || null,
    messageId: message?.messageId || null,
    target: message?.target || null,
    status: ackPayload.status || null,
    verified: ackPayload.verified === true,
    wsDeliveryCount: Number(ackPayload.wsDeliveryCount) || 0,
  });
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    log.error('WebSocket', `Failed to send JSON payload: ${err.message}`);
    return false;
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeQueueSessionScopeId(value) {
  if (typeof value !== 'string') return DEFAULT_QUEUE_SESSION_SCOPE;
  const trimmed = value.trim();
  return trimmed || DEFAULT_QUEUE_SESSION_SCOPE;
}

function getQueueMaxEntries() {
  return parsePositiveInt(OUTBOUND_QUEUE_MAX_ENTRIES, 500);
}

function getQueueMaxAgeMs() {
  return parsePositiveInt(OUTBOUND_QUEUE_MAX_AGE_MS, 30 * 60 * 1000);
}

function getQueueFlushIntervalMs() {
  return parsePositiveInt(OUTBOUND_QUEUE_FLUSH_INTERVAL_MS, 30000);
}

function getQueueDirPath() {
  return path.dirname(getOutboundQueuePath());
}

function ensureQueueDir() {
  fs.mkdirSync(getQueueDirPath(), { recursive: true });
}

function makeQueueEntry(target, content, meta = {}, queuedBy = 'runtime', now = Date.now()) {
  return {
    id: `oq-${now}-${Math.random().toString(36).slice(2, 8)}`,
    target: String(target),
    content: String(content ?? ''),
    meta: (meta && typeof meta === 'object') ? meta : {},
    createdAt: now,
    attempts: 0,
    lastAttemptAt: null,
    sessionScopeId: queueSessionScopeId,
    queuedBy,
  };
}

function isQueueEntry(entry) {
  return Boolean(
    entry
    && typeof entry === 'object'
    && typeof entry.target === 'string'
    && typeof entry.content === 'string'
  );
}

function normalizeQueueEntries(rawEntries, now = Date.now()) {
  if (!Array.isArray(rawEntries)) return [];
  const maxAgeMs = getQueueMaxAgeMs();
  const normalized = [];
  for (const item of rawEntries) {
    if (!isQueueEntry(item)) continue;
    const createdAt = Number.isFinite(item.createdAt) ? item.createdAt : now;
    if (createdAt + maxAgeMs <= now) continue;
    normalized.push({
      id: typeof item.id === 'string' ? item.id : `oq-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
      target: item.target,
      content: item.content,
      meta: (item.meta && typeof item.meta === 'object') ? item.meta : {},
      createdAt,
      attempts: Number.isFinite(item.attempts) ? item.attempts : 0,
      lastAttemptAt: Number.isFinite(item.lastAttemptAt) ? item.lastAttemptAt : null,
      sessionScopeId: normalizeQueueSessionScopeId(item.sessionScopeId || queueSessionScopeId),
      queuedBy: typeof item.queuedBy === 'string' ? item.queuedBy : 'runtime',
    });
  }
  const maxEntries = getQueueMaxEntries();
  return normalized.slice(Math.max(0, normalized.length - maxEntries));
}

function persistOutboundQueue() {
  try {
    const queuePath = getOutboundQueuePath();
    ensureQueueDir();
    const payload = JSON.stringify({
      version: 2,
      sessionScopeId: queueSessionScopeId,
      entries: outboundQueue,
    }, null, 2);
    const tmpPath = `${queuePath}.tmp`;
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    fs.renameSync(tmpPath, queuePath);
    return { ok: true };
  } catch (err) {
    log.error('WebSocket', `Failed to persist outbound queue: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function buildCorruptedQueueBackupPath(queuePath) {
  return `${queuePath}.corrupt-${Date.now()}`;
}

function loadOutboundQueue() {
  try {
    const queuePath = getOutboundQueuePath();
    if (!fs.existsSync(queuePath)) {
      outboundQueue = [];
      return;
    }
    const raw = fs.readFileSync(queuePath, 'utf-8');
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      const corruptedPath = buildCorruptedQueueBackupPath(queuePath);
      try {
        fs.writeFileSync(corruptedPath, raw, 'utf-8');
        log.warn('WebSocket', `Corrupted outbound queue moved to ${corruptedPath}`);
      } catch (backupErr) {
        log.error('WebSocket', `Failed to preserve corrupted outbound queue ${queuePath}: ${backupErr.message}`);
      }

      outboundQueue = [];
      const persistResult = persistOutboundQueue();
      if (!persistResult?.ok) {
        log.error('WebSocket', `Failed to reset outbound queue after corruption: ${persistResult?.error || 'unknown_error'}`);
      }
      log.warn('WebSocket', `Failed to parse outbound queue. Resetting queue: ${parseErr.message}`);
      return;
    }

    // Legacy v1 format: raw array. Discard on startup to avoid cross-session ghost replays.
    if (Array.isArray(parsed)) {
      outboundQueue = [];
      persistOutboundQueue();
      log.info('WebSocket', 'Discarded legacy outbound queue on startup (session scope enforced)');
      return;
    }

    const fileScopeId = normalizeQueueSessionScopeId(parsed?.sessionScopeId);
    const fileEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    if (fileScopeId !== queueSessionScopeId) {
      outboundQueue = [];
      persistOutboundQueue();
      log.info('WebSocket', `Discarded outbound queue from prior session scope (${fileScopeId} -> ${queueSessionScopeId})`);
      return;
    }

    outboundQueue = normalizeQueueEntries(fileEntries).filter(
      (entry) => normalizeQueueSessionScopeId(entry.sessionScopeId) === queueSessionScopeId
    );
    if (!Array.isArray(parsed?.entries) || fileEntries.length !== outboundQueue.length) {
      persistOutboundQueue();
    }
  } catch (err) {
    outboundQueue = [];
    log.warn('WebSocket', `Failed to load outbound queue. Resetting queue: ${err.message}`);
    persistOutboundQueue();
  }
}

function pruneOutboundQueue(now = Date.now()) {
  if (outboundQueue.length === 0) return;
  const maxAgeMs = getQueueMaxAgeMs();
  const maxEntries = getQueueMaxEntries();
  const previousLength = outboundQueue.length;
  outboundQueue = outboundQueue.filter((entry) => Number.isFinite(entry.createdAt) && (entry.createdAt + maxAgeMs > now));
  if (outboundQueue.length > maxEntries) {
    const dropCount = outboundQueue.length - maxEntries;
    outboundQueue = outboundQueue.slice(dropCount);
  }
  if (outboundQueue.length !== previousLength) {
    persistOutboundQueue();
  }
}

function queueOutboundMessage(target, content, meta = {}, queuedBy = 'runtime', now = Date.now()) {
  pruneOutboundQueue(now);
  const maxEntries = getQueueMaxEntries();
  if (outboundQueue.length >= maxEntries) {
    const dropped = outboundQueue.shift();
    log.warn(
      'WebSocket',
      `Outbound queue at capacity (${maxEntries}). Dropped oldest queued message for target ${String(dropped?.target || 'unknown')}.`
    );
  }
  outboundQueue.push(makeQueueEntry(target, content, meta, queuedBy, now));
  const persistResult = persistOutboundQueue();
  const persisted = persistResult?.ok === true;
  return {
    queued: persisted,
    persisted,
    error: persistResult?.error || null,
  };
}

function buildOutboundPayload(content, meta = {}) {
  const traceContext = meta?.traceContext || null;
  const messageMetadata = (meta?.metadata && typeof meta.metadata === 'object' && !Array.isArray(meta.metadata))
    ? meta.metadata
    : null;
  return JSON.stringify({
    type: 'message',
    from: meta.from || 'system',
    priority: meta.priority || 'normal',
    content,
    metadata: messageMetadata,
    traceId: traceContext?.traceId || null,
    parentEventId: traceContext?.parentEventId || null,
    eventId: traceContext?.eventId || null,
    timestamp: Date.now(),
  });
}

function matchClientsForTarget(target, routeScope = null, options = {}) {
  const targetStr = String(target);
  const targetRole = targetStr.toLowerCase();
  const excludeClientId = options?.excludeClientId == null ? null : String(options.excludeClientId);
  const matched = [];
  for (const [clientId, info] of clients) {
    if (excludeClientId !== null && String(clientId) === excludeClientId) continue;
    if (routeScope && !clientMatchesRouteScope(info, routeScope)) continue;
    const paneMatch = info.paneId !== null && String(info.paneId) === targetStr;
    const roleMatch = typeof info.role === 'string' && info.role.toLowerCase() === targetRole;
    if (paneMatch || roleMatch) {
      matched.push([clientId, info]);
    }
  }
  return matched;
}

function deliverToTargetNow(target, content, meta = {}) {
  const payload = buildOutboundPayload(content, meta);
  let sent = false;
  const excludeClientId = meta?.excludeClientId || null;
  const matched = matchClientsForTarget(target, meta.routeScope || null, { excludeClientId });
  for (const [clientId, info] of matched) {
    if (info.ws.readyState !== 1) continue;
    try {
      info.ws.send(payload);
      sent = true;
      log.info('WebSocket', `Sent to ${target} (client ${clientId}): ${String(content).substring(0, 50)}...`);
    } catch (err) {
      log.warn('WebSocket', `Failed sending to ${target} (client ${clientId}): ${err.message}`);
    }
  }
  return sent;
}

function targetMatchesClient(target, info, routeScope = null) {
  if (routeScope && !clientMatchesRouteScope(info, routeScope)) return false;
  const targetStr = String(target);
  const targetRole = targetStr.toLowerCase();
  const paneMatch = info.paneId !== null && String(info.paneId) === targetStr;
  const roleMatch = typeof info.role === 'string' && info.role.toLowerCase() === targetRole;
  return paneMatch || roleMatch;
}

function flushOutboundQueueForClient(clientId, source = 'register') {
  const info = clients.get(clientId);
  if (!info || outboundQueue.length === 0) return 0;
  if (outboundQueueFlushInProgress) return 0;
  pruneOutboundQueue();
  if (outboundQueue.length === 0) return 0;

  outboundQueueFlushInProgress = true;
  let deliveredCount = 0;
  let queueChanged = false;
  try {
    const retained = [];
    for (const entry of outboundQueue) {
      if (!targetMatchesClient(entry.target, info, entry.meta?.routeScope || null)) {
        retained.push(entry);
        continue;
      }
      const sent = deliverToTargetNow(entry.target, entry.content, entry.meta);
      if (sent) {
        deliveredCount += 1;
        queueChanged = true;
      } else {
        entry.attempts = (entry.attempts || 0) + 1;
        entry.lastAttemptAt = Date.now();
        retained.push(entry);
      }
    }
    if (retained.length !== outboundQueue.length || queueChanged) {
      outboundQueue = retained;
      persistOutboundQueue();
    }
  } finally {
    outboundQueueFlushInProgress = false;
  }

  if (deliveredCount > 0) {
    log.info('WebSocket', `Flushed ${deliveredCount} queued message(s) for client ${clientId} via ${source}`);
  }
  return deliveredCount;
}

function flushOutboundQueue(source = 'timer') {
  if (outboundQueue.length === 0) return 0;
  if (outboundQueueFlushInProgress) return 0;
  pruneOutboundQueue();
  if (outboundQueue.length === 0) return 0;

  outboundQueueFlushInProgress = true;
  let deliveredCount = 0;
  let queueChanged = false;
  try {
    const retained = [];
    for (const entry of outboundQueue) {
      const sent = deliverToTargetNow(entry.target, entry.content, entry.meta);
      if (sent) {
        deliveredCount += 1;
        queueChanged = true;
      } else {
        entry.attempts = (entry.attempts || 0) + 1;
        entry.lastAttemptAt = Date.now();
        retained.push(entry);
      }
    }
    if (retained.length !== outboundQueue.length || queueChanged) {
      outboundQueue = retained;
      persistOutboundQueue();
    }
  } finally {
    outboundQueueFlushInProgress = false;
  }

  if (deliveredCount > 0) {
    log.info('WebSocket', `Flushed ${deliveredCount} queued message(s) via ${source}`);
  }
  return deliveredCount;
}

function stopOutboundQueueTimer() {
  if (outboundQueueFlushTimer) {
    clearInterval(outboundQueueFlushTimer);
    outboundQueueFlushTimer = null;
  }
}

function startOutboundQueueTimer() {
  stopOutboundQueueTimer();
  outboundQueueFlushTimer = setInterval(() => {
    flushOutboundQueue('interval');
  }, getQueueFlushIntervalMs());
  if (typeof outboundQueueFlushTimer.unref === 'function') {
    outboundQueueFlushTimer.unref();
  }
}

function coerceAckResult(result) {
  if (!result || typeof result !== 'object') return null;
  const accepted = Object.prototype.hasOwnProperty.call(result, 'accepted')
    ? Boolean(result.accepted)
    : (Object.prototype.hasOwnProperty.call(result, 'success') ? Boolean(result.success) : Boolean(result.ok));
  const queued = Object.prototype.hasOwnProperty.call(result, 'queued')
    ? Boolean(result.queued)
    : accepted;
  const verified = Object.prototype.hasOwnProperty.call(result, 'verified')
    ? Boolean(result.verified)
    : Boolean(result.ok);
  const ok = Object.prototype.hasOwnProperty.call(result, 'ok')
    ? Boolean(result.ok)
    : verified;
  const status = result.status
    || (verified ? 'delivered.verified' : (accepted ? 'accepted.unverified' : 'failed'));

  if (
    Object.prototype.hasOwnProperty.call(result, 'ok')
    || Object.prototype.hasOwnProperty.call(result, 'success')
    || Object.prototype.hasOwnProperty.call(result, 'accepted')
    || Object.prototype.hasOwnProperty.call(result, 'verified')
  ) {
    return {
      ok,
      accepted,
      queued,
      verified,
      status,
      details: result,
    };
  }
  return null;
}

function isAckEligibleMessage(message) {
  return Boolean(message?.ackRequired && (message.type === 'send' || message.type === 'broadcast'));
}

function getNormalizedMessageId(message) {
  if (!message || typeof message.messageId !== 'string') return null;
  const trimmed = message.messageId.trim();
  return trimmed ? trimmed : null;
}

function buildTraceContext(message = {}) {
  const nested = (message?.traceContext && typeof message.traceContext === 'object')
    ? message.traceContext
    : {};
  const messageId = getNormalizedMessageId(message);
  const traceId = toNonEmptyString(nested.traceId)
    || toNonEmptyString(nested.correlationId)
    || toNonEmptyString(message.traceId)
    || toNonEmptyString(message.correlationId)
    || messageId
    || generateTraceToken('trc');
  const parentEventId = toNonEmptyString(nested.parentEventId)
    || toNonEmptyString(nested.causationId)
    || toNonEmptyString(message.parentEventId)
    || toNonEmptyString(message.causationId)
    || null;
  const eventId = toNonEmptyString(nested.eventId)
    || toNonEmptyString(message.eventId)
    || generateTraceToken('evt');

  return {
    traceId,
    parentEventId,
    eventId,
    correlationId: traceId,
    causationId: parentEventId,
    messageId,
  };
}

function pruneExpiredMessageAcks(now = Date.now()) {
  for (const [messageId, entry] of recentMessageAcks.entries()) {
    if (!entry || entry.expiresAt <= now) {
      recentMessageAcks.delete(messageId);
    }
  }
}

function cacheMessageAck(messageId, ackPayload, now = Date.now()) {
  if (!messageId || !ackPayload) return;
  recentMessageAcks.set(messageId, {
    ackPayload,
    expiresAt: now + MESSAGE_ACK_TTL_MS,
  });
}

function getPendingMessageAckTtlMs() {
  return Number.isFinite(PENDING_MESSAGE_ACK_TTL_MS) && PENDING_MESSAGE_ACK_TTL_MS > 0
    ? PENDING_MESSAGE_ACK_TTL_MS
    : (2 * 60 * 1000);
}

function buildPendingAckFailure(messageId, status, message = null) {
  return {
    type: 'send-ack',
    messageId: messageId || null,
    ok: false,
    accepted: false,
    queued: false,
    verified: false,
    status,
    error: message || status,
    timestamp: Date.now(),
  };
}

function resolvePendingMessageAck(messageId, ackPayload) {
  const pendingEntry = pendingMessageAcks.get(messageId);
  if (!pendingEntry) return false;
  pendingMessageAcks.delete(messageId);
  if (typeof pendingEntry.resolve === 'function') {
    pendingEntry.resolve(ackPayload);
  }
  return true;
}

function rejectPendingMessageAck(messageId, error) {
  const pendingEntry = pendingMessageAcks.get(messageId);
  if (!pendingEntry) return false;
  pendingMessageAcks.delete(messageId);
  if (typeof pendingEntry.reject === 'function') {
    pendingEntry.reject(error instanceof Error ? error : new Error(String(error || 'pending_ack_failed')));
  }
  return true;
}

function pruneStalePendingMessageAcks(now = Date.now()) {
  const ttlMs = getPendingMessageAckTtlMs();
  for (const [messageId, pendingEntry] of pendingMessageAcks.entries()) {
    if (!pendingEntry || typeof pendingEntry !== 'object') {
      pendingMessageAcks.delete(messageId);
      continue;
    }
    const createdAt = Number.isFinite(pendingEntry.createdAt) ? pendingEntry.createdAt : now;
    if ((createdAt + ttlMs) > now) continue;
    rejectPendingMessageAck(messageId, new Error(`pending ack timed out after ${ttlMs}ms`));
  }
}

function evictPendingMessageAcksForClient(clientId) {
  for (const [messageId, pendingEntry] of pendingMessageAcks.entries()) {
    if (!pendingEntry || pendingEntry.clientId !== clientId) continue;
    const fallbackAck = buildPendingAckFailure(messageId, 'client_disconnected', 'Sender disconnected before ACK was produced');
    resolvePendingMessageAck(messageId, fallbackAck);
  }
}

function getContentDedupeTtlMs() {
  return Number.isFinite(CONTENT_DEDUPE_TTL_MS) && CONTENT_DEDUPE_TTL_MS > 0
    ? CONTENT_DEDUPE_TTL_MS
    : 15000;
}

function pruneExpiredDispatchAcks(now = Date.now()) {
  for (const [key, entry] of recentDispatchAcks.entries()) {
    if (!entry || entry.expiresAt <= now) {
      recentDispatchAcks.delete(key);
    }
  }
}

function cacheDispatchAck(dedupeKey, ackPayload, now = Date.now()) {
  if (!dedupeKey || !ackPayload) return;
  recentDispatchAcks.set(dedupeKey, {
    ackPayload,
    expiresAt: now + getContentDedupeTtlMs(),
  });
}

function buildDispatchDedupeKey(clientInfo, message = {}) {
  if (!message || (message.type !== 'send' && message.type !== 'broadcast')) return null;
  const senderRole = toNonEmptyString(clientInfo?.role) || null;
  const senderPane = normalizePaneId(clientInfo?.paneId);
  const target = message.type === 'send' ? toNonEmptyString(message.target) : '__broadcast__';
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
  if (!senderRole && !senderPane) return null;
  if (!target || !content) return null;

  const normalizedTarget = target.toLowerCase();
  const normalizedPriority = toNonEmptyString(message.priority) || 'normal';
  const material = [
    `t:${message.type}`,
    `r:${senderRole || ''}`,
    `p:${senderPane || ''}`,
    `g:${normalizedTarget}`,
    `q:${normalizedPriority}`,
    `c:${content}`,
  ].join('|');

  return crypto.createHash('sha1').update(material).digest('hex');
}

function buildDedupeAckPayload(baseAck, messageId, traceContext, dedupeMode, dedupeKey) {
  if (!baseAck || typeof baseAck !== 'object') return null;
  return {
    ...baseAck,
    type: 'send-ack',
    messageId: messageId || null,
    traceId: traceContext?.traceId || baseAck.traceId || messageId || null,
    parentEventId: traceContext?.parentEventId || baseAck.parentEventId || null,
    timestamp: Date.now(),
    dedupe: {
      mode: dedupeMode,
      key: dedupeKey || null,
      sourceMessageId: baseAck.messageId || null,
    },
  };
}

function getDeliveryCheckResult(messageId) {
  const normalizedMessageId = toNonEmptyString(messageId);
  if (!normalizedMessageId) {
    return {
      known: false,
      status: 'invalid_message_id',
      messageId: null,
      ack: null,
      pending: false,
    };
  }

  pruneStalePendingMessageAcks();
  pruneExpiredMessageAcks();
  const cached = recentMessageAcks.get(normalizedMessageId);
  if (cached?.ackPayload) {
    const ack = applyModelPromptReceiptToAck(cached.ackPayload, {
      messageId: normalizedMessageId,
      deliveryId: normalizedMessageId,
    });
    return {
      known: true,
      status: 'cached',
      messageId: normalizedMessageId,
      ack,
      pending: false,
    };
  }

  if (pendingMessageAcks.has(normalizedMessageId)) {
    return {
      known: true,
      status: 'pending',
      messageId: normalizedMessageId,
      ack: null,
      pending: true,
    };
  }

  return {
    known: false,
    status: 'unknown',
    messageId: normalizedMessageId,
    ack: null,
    pending: false,
  };
}

function closeServerQuietly(server) {
  if (!server) return;
  try {
    if (typeof server.removeAllListeners === 'function') {
      server.removeAllListeners();
    }
  } catch {
    // Best effort cleanup.
  }
  try {
    if (typeof server.close === 'function') {
      server.close();
    }
  } catch {
    // Best effort cleanup.
  }
}

function closeClientSocket(info, timeoutMs = 250) {
  const ws = info?.ws;
  if (!ws) return Promise.resolve();
  if (ws.readyState === ws.CLOSED) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.removeListener('close', handleClose);
      } catch {
        // Best effort cleanup.
      }
      if (closeTimer) {
        clearTimeout(closeTimer);
      }
      resolve();
    };
    const handleClose = () => finish();
    ws.once('close', handleClose);

    let closeTimer = setTimeout(() => {
      try {
        if (ws.readyState !== ws.CLOSED) {
          ws.terminate();
        }
      } catch {
        // Best effort cleanup.
      }
      finish();
    }, timeoutMs);
    if (closeTimer && typeof closeTimer.unref === 'function') {
      closeTimer.unref();
    }

    try {
      ws.close(1000, 'Server shutting down');
    } catch {
      try {
        ws.terminate();
      } catch {
        // Best effort cleanup.
      }
      finish();
    }
  });
}

/**
 * Start the WebSocket server
 * @param {object} options - Configuration options
 * @param {number} options.port - Port to listen on (default: resolved runtime WebSocket port)
 * @param {function} options.onMessage - Handler for incoming messages
 * @returns {Promise<WebSocketServer>}
 */
function start(options = {}) {
  if (wss) {
    if (typeof options.onMessage === 'function') {
      messageHandler = options.onMessage;
    }
    return Promise.resolve(wss);
  }

  if (startInFlightPromise) {
    return startInFlightPromise;
  }

  const port = options.port ?? resolveWebSocketPort({
    profileName: process.env.SQUIDRUN_PROFILE || DEFAULT_PROFILE,
  });
  const nextMessageHandler = options.onMessage || null;
  const nextSessionScopeId = normalizeQueueSessionScopeId(options.sessionScopeId);

  startInFlightPromise = new Promise((resolve, reject) => {
    let settled = false;
    let server = null;

    const rejectStart = (err) => {
      if (settled) return;
      settled = true;
      stopOutboundQueueTimer();
      closeServerQuietly(server);
      if (wss === server) {
        wss = null;
      }
      reject(err);
    };

    try {
      messageHandler = nextMessageHandler;
      queueSessionScopeId = nextSessionScopeId;
      recentMessageAcks.clear();
      pendingMessageAcks.clear();
      recentDispatchAcks.clear();
      pendingDispatchAcks.clear();
      loadOutboundQueue();
      stopOutboundQueueTimer();

      server = new WebSocketServer({ port, host: '127.0.0.1' });

      server.on('listening', () => {
        if (settled) return;
        settled = true;
        wss = server;
        log.info('WebSocket', `Server listening on ws://127.0.0.1:${port}`);
        startOutboundQueueTimer();
        resolve(wss);
      });

      server.on('connection', (ws, req) => {
        const clientId = ++clientIdCounter;
        const now = Date.now();
        const clientInfo = {
          ws,
          paneId: null,
          role: null,
          profileName: DEFAULT_PROFILE,
          windowKey: DEFAULT_PROFILE,
          sessionScopeId: null,
          clientKind: null,
          routeBinding: null,
          connectedAt: now,
          lastSeen: now,
        };
        clients.set(clientId, clientInfo);

        log.info('WebSocket', `Client ${clientId} connected from ${req.socket.remoteAddress}`);

        ws.on('message', (data) => {
          handleMessage(clientId, data).catch((err) => {
            log.error('WebSocket', `Unhandled message error for client ${clientId}: ${err.message}`);
          });
        });

        ws.on('close', (code, _reason) => {
          const info = clients.get(clientId);
          const roleInfo = info?.role ? ` (${info.role})` : '';
          log.info('WebSocket', `Client ${clientId}${roleInfo} disconnected: ${code}`);
          evictPendingMessageAcksForClient(clientId);
          clients.delete(clientId);
        });

        ws.on('error', (err) => {
          log.error('WebSocket', `Client ${clientId} error: ${err.message}`);
        });

        // Send welcome message with client ID
        ws.send(JSON.stringify({ type: 'welcome', clientId }));
      });

      server.on('error', (err) => {
        log.error('WebSocket', `Server error: ${err.message}`);
        if (settled) return;
        if (err.code === 'EADDRINUSE') {
          const inUseError = new Error(`Port ${port} already in use`);
          inUseError.code = err.code;
          inUseError.port = port;
          rejectStart(inUseError);
          return;
        }
        err.port = err.port || port;
        rejectStart(err);
      });

    } catch (err) {
      rejectStart(err);
    }
  }).finally(() => {
    startInFlightPromise = null;
  });

  return startInFlightPromise;
}

/**
 * Handle incoming message from a client
 * @param {number} clientId - Client identifier
 * @param {Buffer|string} rawData - Raw message data
 */
async function handleMessage(clientId, rawData) {
  const clientInfo = clients.get(clientId);
  if (!clientInfo) return;

  // Rate limiting: sliding window per client
  const now = Date.now();
  const receivedAtMs = now;
  if (!clientInfo._rateBucketStart || now - clientInfo._rateBucketStart > RATE_LIMIT_WINDOW_MS) {
    clientInfo._rateBucketStart = now;
    clientInfo._rateBucketCount = 0;
  }
  clientInfo._rateBucketCount++;
  if (clientInfo._rateBucketCount > RATE_LIMIT_MAX_MESSAGES) {
    log.warn('WebSocket', `Rate limit exceeded for client ${clientId} (${clientInfo._rateBucketCount}/${RATE_LIMIT_MAX_MESSAGES} per ${RATE_LIMIT_WINDOW_MS}ms)`);
    sendJson(clientInfo.ws, { type: 'error', message: 'Rate limit exceeded' });
    return;
  }

  // Message size limit
  const rawSize = typeof rawData === 'string' ? rawData.length : rawData.byteLength || 0;
  if (rawSize > MAX_MESSAGE_SIZE) {
    log.warn('WebSocket', `Oversized message from client ${clientId}: ${rawSize} bytes (max ${MAX_MESSAGE_SIZE})`);
    sendJson(clientInfo.ws, { type: 'error', message: 'Message too large' });
    return;
  }

  let message;
  try {
    const str = rawData.toString();
    message = JSON.parse(str);
  } catch (_err) {
    // Plain text message
    message = { type: 'text', content: rawData.toString() };
  }

  log.info('WebSocket', `Received from client ${clientId}: ${JSON.stringify(message).substring(0, 100)}`);
  // Refresh route health on any inbound frame.
  markClientSeen(clientId, 'message');

  // Handle registration messages
  if (message.type === 'register') {
    const normalizedRole = normalizeRoleId(message.role) || message.role || null;
    const normalizedPaneId = normalizePaneId(message.paneId) || getPaneIdForRole(normalizeRoleId(message.role));
    const scope = normalizeClientScope(message);
    clientInfo.paneId = normalizedPaneId || null;
    clientInfo.role = normalizedRole || null;
    clientInfo.profileName = scope.profileName;
    clientInfo.windowKey = scope.windowKey;
    clientInfo.sessionScopeId = scope.sessionScopeId;
    clientInfo.routeBinding = normalizeClientRouteBinding(message, scope);
    clientInfo.clientKind = clientInfo.routeBinding.clientKind || null;
    markClientSeen(clientId, 'register');
    log.info(
      'WebSocket',
      `Client ${clientId} registered as pane=${clientInfo.paneId} role=${clientInfo.role} profile=${clientInfo.profileName}`
    );
    sendJson(clientInfo.ws, {
      type: 'registered',
      paneId: clientInfo.paneId,
      role: clientInfo.role,
      profileName: clientInfo.profileName,
      windowKey: clientInfo.windowKey,
      sessionScopeId: clientInfo.sessionScopeId,
      clientKind: clientInfo.clientKind,
      routeBinding: clientInfo.routeBinding,
    });
    flushOutboundQueueForClient(clientId, 'register');
    return;
  }

  if (message.type === 'heartbeat' || message.type === 'route-heartbeat') {
    sendJson(clientInfo.ws, {
      type: `${message.type}-ack`,
      requestId: typeof message.requestId === 'string' ? message.requestId : null,
      timestamp: Date.now(),
      role: clientInfo.role || null,
      paneId: clientInfo.paneId || null,
      profileName: clientInfo.profileName || DEFAULT_PROFILE,
      windowKey: clientInfo.windowKey || clientInfo.profileName || DEFAULT_PROFILE,
      sessionScopeId: clientInfo.sessionScopeId || null,
      clientKind: clientInfo.clientKind || null,
      routeBinding: clientInfo.routeBinding || null,
    });
    return;
  }

  if (message.type === 'health-check') {
    const routeScope = resolveRouteScope(clientInfo, message);
    if (!routeScope.ok) {
      sendJson(clientInfo.ws, {
        type: 'health-check-result',
        requestId: typeof message.requestId === 'string' ? message.requestId : null,
        target: message.target || null,
        timestamp: Date.now(),
        healthy: false,
        status: routeScope.status,
        error: routeScope.error,
        failClosed: true,
        routeScope: routeScope.targetScope || null,
      });
      return;
    }
    const health = getRoutingHealth(message.target, message.staleAfterMs, Date.now(), routeScope, {
      excludeClientId: clientId,
      clientInfo,
    });
    if (routeScope.failClosed && health.status === 'no_route') {
      health.status = 'scope_route_unavailable';
      health.failClosed = true;
      health.error = `No ${routeScope.targetScope.profileName} profile route for target '${message.target}'`;
    }
    sendJson(clientInfo.ws, {
      type: 'health-check-result',
      requestId: typeof message.requestId === 'string' ? message.requestId : null,
      target: message.target || null,
      timestamp: Date.now(),
      ...health,
    });
    return;
  }

  if (message.type === 'delivery-check') {
    const requestId = toNonEmptyString(message.requestId);
    const result = getDeliveryCheckResult(message.messageId);
    sendJson(clientInfo.ws, {
      type: 'delivery-check-result',
      requestId,
      timestamp: Date.now(),
      ...result,
    });
    return;
  }

  const traceEligible = (message.type === 'send' || message.type === 'broadcast');
  const ackEligible = isAckEligibleMessage(message);
  const messageId = ackEligible ? getNormalizedMessageId(message) : null;
  const requestId = toNonEmptyString(message.requestId);
  const ingressTraceContext = traceEligible ? buildTraceContext(message) : null;
  const dispatchTraceContext = ingressTraceContext
    ? {
      ...ingressTraceContext,
      parentEventId: ingressTraceContext.eventId,
      causationId: ingressTraceContext.eventId,
    }
    : null;

  if (ackEligible && messageId) {
    pruneStalePendingMessageAcks();
    pruneExpiredMessageAcks();

    const cached = recentMessageAcks.get(messageId);
    if (cached?.ackPayload) {
      void emitCommsMetric(clientId, clientInfo, 'comms.dedupe.hit', {
        mode: 'cache',
        messageId,
        target: message?.target || null,
        status: cached.ackPayload?.status || null,
      });
      sendJson(clientInfo.ws, cached.ackPayload);
      return;
    }

    const pendingEntry = pendingMessageAcks.get(messageId);
    if (pendingEntry?.promise) {
      void emitCommsMetric(clientId, clientInfo, 'comms.dedupe.hit', {
        mode: 'pending',
        messageId,
        target: message?.target || null,
      });
      try {
        const pendingAck = await pendingEntry.promise;
        if (pendingAck) {
          sendJson(clientInfo.ws, pendingAck);
        }
      } catch (err) {
        const failedAck = {
          type: 'send-ack',
          messageId,
          ok: false,
          accepted: false,
          queued: false,
          verified: false,
          status: 'handler_error',
          error: err.message,
          traceId: ingressTraceContext?.traceId || null,
          parentEventId: ingressTraceContext?.parentEventId || null,
          timestamp: Date.now(),
        };
        sendJson(clientInfo.ws, failedAck);
      }
      return;
    }
  }

  const dispatchDedupeKey = ackEligible ? buildDispatchDedupeKey(clientInfo, message) : null;
  if (ackEligible && dispatchDedupeKey) {
    pruneExpiredDispatchAcks();

    const cachedDispatch = recentDispatchAcks.get(dispatchDedupeKey);
    if (cachedDispatch?.ackPayload) {
      void emitCommsMetric(clientId, clientInfo, 'comms.dedupe.hit', {
        mode: 'signature_cache',
        dedupeKey: dispatchDedupeKey,
        messageId: messageId || null,
        target: message?.target || null,
        status: cachedDispatch.ackPayload?.status || null,
      });
      const dedupeAck = buildDedupeAckPayload(
        cachedDispatch.ackPayload,
        messageId,
        ingressTraceContext,
        'signature_cache',
        dispatchDedupeKey
      );
      if (dedupeAck) {
        sendJson(clientInfo.ws, dedupeAck);
        if (messageId) {
          cacheMessageAck(messageId, dedupeAck);
        }
        return;
      }
    }

    const pendingDispatch = pendingDispatchAcks.get(dispatchDedupeKey);
    if (pendingDispatch) {
      void emitCommsMetric(clientId, clientInfo, 'comms.dedupe.hit', {
        mode: 'signature_pending',
        dedupeKey: dispatchDedupeKey,
        messageId: messageId || null,
        target: message?.target || null,
      });
      try {
        const pendingAck = await pendingDispatch;
        const dedupeAck = buildDedupeAckPayload(
          pendingAck,
          messageId,
          ingressTraceContext,
          'signature_pending',
          dispatchDedupeKey
        );
        if (dedupeAck) {
          sendJson(clientInfo.ws, dedupeAck);
          if (messageId) {
            cacheMessageAck(messageId, dedupeAck);
          }
        }
      } catch (err) {
        const failedAck = {
          type: 'send-ack',
          messageId,
          ok: false,
          accepted: false,
          queued: false,
          verified: false,
          status: 'handler_error',
          error: err.message,
          traceId: ingressTraceContext?.traceId || null,
          parentEventId: ingressTraceContext?.parentEventId || null,
          timestamp: Date.now(),
          dedupe: {
            mode: 'signature_pending',
            key: dispatchDedupeKey,
          },
        };
        sendJson(clientInfo.ws, failedAck);
        if (messageId) {
          cacheMessageAck(messageId, failedAck);
        }
      }
      return;
    }
  }

  let resolvePendingAck = null;
  let rejectPendingAck = null;
  if (ackEligible && messageId) {
    const pendingEntry = {
      promise: null,
      createdAt: Date.now(),
      clientId,
      resolve: null,
      reject: null,
    };
    pendingEntry.promise = new Promise((resolve, reject) => {
      pendingEntry.resolve = resolve;
      pendingEntry.reject = reject;
    });
    // Avoid unhandled-rejection noise when a sender disconnects before consumers await.
    pendingEntry.promise.catch(() => {});
    resolvePendingAck = pendingEntry.resolve;
    rejectPendingAck = pendingEntry.reject;
    pendingMessageAcks.set(messageId, pendingEntry);
  }

  let resolvePendingDispatchAck = null;
  let rejectPendingDispatchAck = null;
  if (ackEligible && dispatchDedupeKey) {
    const pendingDispatch = new Promise((resolve, reject) => {
      resolvePendingDispatchAck = resolve;
      rejectPendingDispatchAck = reject;
    });
    pendingDispatchAcks.set(dispatchDedupeKey, pendingDispatch);
  }

  function finalizeAckTracking(ackPayload, err) {
    if (!ackEligible) return;
    if (messageId) {
      pendingMessageAcks.delete(messageId);
    }
    if (dispatchDedupeKey) {
      pendingDispatchAcks.delete(dispatchDedupeKey);
    }

    if (ackPayload) {
      if (messageId) {
        cacheMessageAck(messageId, ackPayload);
      }
      if (dispatchDedupeKey) {
        cacheDispatchAck(dispatchDedupeKey, ackPayload);
      }
      if (resolvePendingAck) resolvePendingAck(ackPayload);
      if (resolvePendingDispatchAck) resolvePendingDispatchAck(ackPayload);
      return;
    }

    const trackingError = err || new Error('ACK processing failed');
    if (rejectPendingAck) {
      rejectPendingAck(trackingError);
    }
    if (rejectPendingDispatchAck) {
      rejectPendingDispatchAck(trackingError);
    }
  }

  let wsDeliveryCount = 0;
  let skipMessageHandler = false;

  // Handle agent-to-agent messages
  if (message.type === 'send') {
    const { target, content, priority, metadata } = message;
    const routeScope = resolveRouteScope(clientInfo, message);
    if (!routeScope.ok) {
      const ackPayload = buildRoutingErrorAck(
        message,
        ingressTraceContext,
        routeScope.status,
        routeScope.error,
        {
          routeScope: routeScope.targetScope || null,
          wsDeliveryCount: 0,
        }
      );
      notifyMainArchitectRoutingError(clientInfo, message, routeScope.status, routeScope.error, {
        routeScope: routeScope.targetScope || null,
      });
      sendJson(clientInfo.ws, ackPayload);
      finalizeAckTracking(ackPayload);
      return;
    }
    const wrongContext = detectWrongContextRoute(clientInfo, message, routeScope);
    if (wrongContext) {
      const ackPayload = buildRoutingErrorAck(
        message,
        ingressTraceContext,
        wrongContext.status,
        wrongContext.error,
        {
          routeScope: routeScope.targetScope || null,
          contextGuard: wrongContext.details || null,
          wsDeliveryCount: 0,
        }
      );
      notifyMainArchitectRoutingError(clientInfo, message, wrongContext.status, wrongContext.error, {
        routeScope: routeScope.targetScope || null,
        contextGuard: wrongContext.details || null,
      });
      sendJson(clientInfo.ws, ackPayload);
      finalizeAckTracking(ackPayload);
      return;
    }
    const matched = matchClientsForTarget(target, routeScope, { excludeClientId: clientId });
    const localHandlerRoute = canUseLocalHandlerRoute(routeScope, clientInfo, message);
    if (routeScope.failClosed && matched.length === 0 && !localHandlerRoute) {
      const ackPayload = buildRoutingErrorAck(
        message,
        ingressTraceContext,
        'scope_route_unavailable',
        `No ${routeScope.targetScope.profileName} profile route for target '${target}'`,
        {
          routeScope: routeScope.targetScope,
          wsDeliveryCount: 0,
        }
      );
      notifyMainArchitectRoutingError(clientInfo, message, 'scope_route_unavailable', ackPayload.error, {
        routeScope: routeScope.targetScope,
      });
      sendJson(clientInfo.ws, ackPayload);
      finalizeAckTracking(ackPayload);
      return;
    }
    // Try WebSocket clients first (for future direct agent-to-agent)
    if ((matched.length > 0 || !localHandlerRoute) && sendToTarget(target, content, {
      from: clientInfo.role || clientId,
      priority,
      metadata: (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) ? metadata : null,
      traceContext: dispatchTraceContext,
      routeScope,
      persistIfOffline: false,
      excludeClientId: clientId,
    })) {
      wsDeliveryCount = 1;
      // Fail-closed side-profile delivery is terminal-backed by the scoped route client.
      // Letting canonical targets fall through to the main handler after this creates
      // wrong-profile trigger fallbacks for messages that were already routed.
      skipMessageHandler = (
        routeScope.failClosed
        && !isMainProfile(routeScope.targetScope?.profileName)
      ) || !isCanonicalLocalPaneRoleTarget(target);
    }
  }

  // Handle broadcast
  if (message.type === 'broadcast') {
    wsDeliveryCount = broadcast(message.content, {
      from: clientInfo.role || clientId,
      excludeSender: clientId,
      traceContext: dispatchTraceContext,
    });
    // Don't return - let messageHandler also route to terminals/triggers
  }

  let handlerResult = null;

  // Pass to external handler if set
  if (messageHandler && !skipMessageHandler) {
    try {
      handlerResult = await messageHandler({
        clientId,
        paneId: clientInfo.paneId,
        role: clientInfo.role,
        message: dispatchTraceContext ? { ...message, traceContext: dispatchTraceContext } : message,
        traceContext: dispatchTraceContext,
      });
    } catch (err) {
      log.error('WebSocket', `messageHandler failed for client ${clientId}: ${err.message}`);
      if (requestId && !ackEligible) {
        sendJson(clientInfo.ws, {
          type: 'response',
          requestId,
          ok: false,
          error: err.message,
          timestamp: Date.now(),
        });
      }
      if (message.ackRequired && (message.type === 'send' || message.type === 'broadcast')) {
        const ackPayload = {
          type: 'send-ack',
          messageId: message.messageId || null,
          ok: false,
          accepted: false,
          queued: false,
          verified: false,
          status: 'handler_error',
          error: err.message,
          wsDeliveryCount,
          traceId: ingressTraceContext?.traceId || null,
          parentEventId: ingressTraceContext?.parentEventId || null,
          timestamp: Date.now(),
        };
        emitAckLatencyMetric(clientId, clientInfo, message, ackPayload, receivedAtMs);
        sendJson(clientInfo.ws, ackPayload);
        finalizeAckTracking(ackPayload, err);
      }
      else {
        finalizeAckTracking(null, err);
      }
      return;
    }
  }

  if (requestId && !ackEligible) {
    sendJson(clientInfo.ws, {
      type: 'response',
      requestId,
      ok: true,
      result: handlerResult,
      timestamp: Date.now(),
    });
    finalizeAckTracking(null);
    return;
  }

  if (message.ackRequired && (message.type === 'send' || message.type === 'broadcast')) {
    const handlerAck = coerceAckResult(handlerResult);
    const websocketDelivered = wsDeliveryCount > 0;
    const accepted = websocketDelivered || Boolean(handlerAck?.accepted || handlerAck?.ok);
    const queued = websocketDelivered || Boolean(handlerAck?.queued || handlerAck?.accepted || handlerAck?.ok);
    const verified = Boolean(handlerAck?.verified);
    const ok = accepted || verified;
    const routeScope = message.type === 'send'
      ? resolveRouteScope(clientInfo, message)
      : { failClosed: false, targetScope: null };
    const scopedHandlerMiss = message.type === 'send'
      && routeScope.ok
      && routeScope.failClosed
      && !websocketDelivered
      && !accepted
      && !verified;

    let status = verified
      ? 'delivered.verified'
      : (websocketDelivered ? 'delivered.websocket' : (accepted ? 'accepted.unverified' : 'unrouted'));
    if (scopedHandlerMiss) {
      status = 'scoped_route_not_ready';
    }
    if (handlerAck?.status) {
      status = handlerAck.status;
      if (websocketDelivered && handlerAck.verified === false) {
        status = 'delivered.websocket';
      }
    }

    let ackPayload = {
      type: 'send-ack',
      messageId: message.messageId || null,
      ok,
      accepted,
      queued,
      verified,
      status,
      wsDeliveryCount,
      userVisible: verified === true,
      handlerResult: handlerAck?.details || null,
      failClosed: scopedHandlerMiss ? true : undefined,
      routeScope: scopedHandlerMiss ? routeScope.targetScope : undefined,
      error: scopedHandlerMiss
        ? `No ready ${routeScope.targetScope.profileName} profile terminal route for target '${message.target}'`
        : undefined,
      traceId: ingressTraceContext?.traceId || null,
      parentEventId: ingressTraceContext?.parentEventId || null,
      timestamp: Date.now(),
    };
    await waitForModelPromptReceipt(
      {
        messageId: message.messageId || null,
        deliveryId: handlerAck?.deliveryId || handlerAck?.details?.deliveryId || message.messageId || null,
      },
      handlerAck,
      { timeoutMs: MODEL_PROMPT_RECEIPT_WAIT_MS }
    );
    ackPayload = applyModelPromptReceiptToAck(ackPayload, {
      messageId: message.messageId || null,
      deliveryId: handlerAck?.deliveryId || handlerAck?.details?.deliveryId || message.messageId || null,
    }, handlerAck);
    emitAckLatencyMetric(clientId, clientInfo, message, ackPayload, receivedAtMs);
    sendJson(clientInfo.ws, ackPayload);
    finalizeAckTracking(ackPayload);
    return;
  }

  finalizeAckTracking(null);
}

/**
 * Send message to a specific target (paneId or role)
 * @param {string} target - Target paneId or role name
 * @param {string} content - Message content
 * @param {object} meta - Metadata (from, priority)
 */
function sendToTarget(target, content, meta = {}) {
  const sent = deliverToTargetNow(target, content, meta);
  if (sent) return true;

  const shouldPersistOffline = meta?.persistIfOffline !== false;
  if (shouldPersistOffline) {
    const queueResult = queueOutboundMessage(target, content, meta, 'sendToTarget');
    if (queueResult?.persisted) {
      log.warn('WebSocket', `No connected client for target: ${target}. Queued for reconnect delivery.`);
    } else {
      log.warn(
        'WebSocket',
        `No connected client for target: ${target}. Queue persisted failed; retained in memory for retry (${queueResult?.error || 'unknown_error'}).`
      );
    }
  } else {
    log.warn('WebSocket', `No connected client for target: ${target}`);
  }

  return false;
}

/**
 * Broadcast message to all connected clients
 * @param {string} content - Message content
 * @param {object} options - Options (from, excludeSender)
 */
function broadcast(content, options = {}) {
  const traceContext = options?.traceContext || null;
  const payload = JSON.stringify({
    type: 'broadcast',
    from: options.from || 'system',
    content,
    traceId: traceContext?.traceId || null,
    parentEventId: traceContext?.parentEventId || null,
    eventId: traceContext?.eventId || null,
    timestamp: Date.now(),
  });

  let count = 0;
  for (const [clientId, info] of clients) {
    if (options.excludeSender && clientId === options.excludeSender) continue;
    if (info.ws.readyState === 1) { // WebSocket.OPEN
      info.ws.send(payload);
      count++;
    }
  }

  log.info('WebSocket', `Broadcast to ${count} clients: ${content.substring(0, 50)}...`);
  return count;
}

/**
 * Send message to a specific pane (convenience wrapper)
 * @param {string} paneId - Target pane ID
 * @param {string} content - Message content
 * @param {object} meta - Metadata
 */
function sendToPane(paneId, content, meta = {}) {
  return sendToTarget(paneId, content, meta);
}

/**
 * Get list of connected clients
 * @returns {Array} Client info array
 */
function getClients() {
  return Array.from(clients.entries()).map(([id, info]) => ({
    clientId: id,
    paneId: info.paneId,
    role: info.role,
    profileName: info.profileName || DEFAULT_PROFILE,
    windowKey: info.windowKey || info.profileName || DEFAULT_PROFILE,
    sessionScopeId: info.sessionScopeId || null,
    clientKind: info.clientKind || null,
    routeBinding: info.routeBinding || null,
    connectedAt: info.connectedAt,
    lastSeen: info.lastSeen || null,
    ready: info.ws.readyState === 1,
  }));
}

/**
 * Stop the WebSocket server
 */
async function stop() {
  stopOutboundQueueTimer();
  if (!wss && startInFlightPromise) {
    try {
      await startInFlightPromise;
    } catch {
      // Ignore startup failure; cleanup below will reset local state.
    }
    stopOutboundQueueTimer();
  }

  const server = wss;
  if (!server) {
    outboundQueueFlushInProgress = false;
    outboundQueue = [];
    return;
  }

  const rawServer = server._server;
  const serverClients = server.clients instanceof Set ? Array.from(server.clients) : [];
  const serverClientClosures = serverClients.map((client) => closeClientSocket({ ws: client }));
  const clientClosures = Array.from(clients.values()).map((info) => closeClientSocket(info));
  clients.clear();
  recentMessageAcks.clear();
  pendingMessageAcks.clear();
  recentDispatchAcks.clear();
  pendingDispatchAcks.clear();
  outboundQueueFlushInProgress = false;
  outboundQueue = [];
  await Promise.allSettled([...clientClosures, ...serverClientClosures]);

  try {
    if (rawServer && typeof rawServer.closeIdleConnections === 'function') {
      rawServer.closeIdleConnections();
    }
  } catch {
    // Best effort cleanup.
  }
  try {
    if (rawServer && typeof rawServer.closeAllConnections === 'function') {
      rawServer.closeAllConnections();
    }
  } catch {
    // Best effort cleanup.
  }
  try {
    if (rawServer && typeof rawServer.unref === 'function') {
      rawServer.unref();
    }
  } catch {
    // Best effort cleanup.
  }

  await new Promise((resolve) => {
    server.close(() => {
      log.info('WebSocket', 'Server stopped');
      try {
        if (typeof server.removeAllListeners === 'function') {
          server.removeAllListeners();
        }
      } catch {
        // Best effort cleanup.
      }
      try {
        if (rawServer && typeof rawServer.unref === 'function') {
          rawServer.unref();
        }
      } catch {
        // Best effort cleanup.
      }
      if (wss === server) {
        wss = null;
      }
      resolve();
    });
  });
}

/**
 * Check if server is running
 * @returns {boolean}
 */
function isRunning() {
  return wss !== null;
}

/**
 * Get server port
 * @returns {number|null}
 */
function getPort() {
  if (!wss) return null;
  if (typeof wss.address === 'function') {
    const address = wss.address();
    if (address && typeof address === 'object' && address.port) {
      return address.port;
    }
  }
  return wss.options?.port || null;
}

module.exports = {
  start,
  stop,
  isRunning,
  getPort,
  getClients,
  sendToTarget,
  sendToPane,
  broadcast,
  DEFAULT_PORT,
};
