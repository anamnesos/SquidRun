'use strict';

const fs = require('fs');
const {
  getProfileProjectRootConfigPath,
  getProfileProjectRootOverride,
} = require('../profile');

const ROOM_ENVELOPE_VERSION = 'squidrun.room-envelope.v0';
const WORK_ROOM_CONTRACT_VERSION = 'squidrun.work-room-contract.v0';
const MAIN_ROOM_ID = 'main';
const TRUSTQUOTE_ROOM_ID = 'trustquote';
const TRUSTQUOTE_PROJECT_PATH = 'D:/projects/TrustQuote';
const TRUSTQUOTE_REQUIRED_PROJECT_ROOT_ENV = 'SQUIDRUN_TRUSTQUOTE_PROJECT_ROOT';
const DEFAULT_SQUIDRUN_ROOT = 'D:/projects/squidrun';
const TRUSTED_INTERNAL_TARGETS = new Set(['architect', 'builder', 'oracle']);
const TRUSTQUOTE_ROOM_VISIBILITIES = new Set(['room_internal', 'cross_room_summary']);
const TRUSTQUOTE_STARTUP_SOURCE_FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'ROLES.md']);
const TRUSTQUOTE_REQUIRED_WORK_ROOM_ROLES = Object.freeze(['builder', 'oracle']);
const TRUSTQUOTE_GENERATED_STARTUP_SOURCE_FILES = new Set(['AGENTS.md', 'ROLES.md']);
const TRUSTQUOTE_WORKSTREAM_VERSION = 'squidrun.work-room-workstream.v0';
const REAL_ROOM_ROUTE_STATUS = 'healthy';
const REAL_ROOM_ROUTE_SOURCE = 'client_activity';
const REAL_ROOM_ROUTE_CLIENT_KIND = 'work_room_route_client';

function toText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function parseMaybeJsonObject(value) {
  if (!value || typeof value !== 'string') return asObject(value);
  try {
    return asObject(JSON.parse(value));
  } catch (_) {
    return {};
  }
}

function normalizeRoomId(value) {
  const normalized = toText(value, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (normalized === MAIN_ROOM_ID || normalized === TRUSTQUOTE_ROOM_ID) return normalized;
  return null;
}

function normalizeInternalRole(value) {
  const normalized = toText(value, '').toLowerCase();
  if (normalized === 'arch') return 'architect';
  return TRUSTED_INTERNAL_TARGETS.has(normalized) ? normalized : null;
}

function normalizePathForMetadata(value) {
  const text = toText(value, '');
  if (!text) return null;
  return text.replace(/\\/g, '/');
}

function stripTrailingSlash(value) {
  return toText(value, '').replace(/[\\/]+$/g, '');
}

function joinMetadataPath(basePath, ...parts) {
  const base = stripTrailingSlash(normalizePathForMetadata(basePath));
  const suffix = parts
    .map((part) => toText(part, '').replace(/^[\\/]+|[\\/]+$/g, ''))
    .filter(Boolean)
    .join('/');
  return suffix ? `${base}/${suffix}` : base;
}

function normalizeProjectToken(value) {
  return toText(value, '').replace(/\\/g, '/').toLowerCase();
}

function sameMetadataPath(left, right) {
  const normalizedLeft = normalizeProjectToken(left).replace(/[\\/]+$/g, '');
  const normalizedRight = normalizeProjectToken(right).replace(/[\\/]+$/g, '');
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function projectMetadataCandidates(metadata = {}) {
  const source = asObject(metadata);
  return [
    asObject(source.project),
    asObject(source.envelope?.project),
  ].filter((project) => Object.keys(project).length > 0);
}

function projectMetadataMatchesName(project = {}, roomOrProjectName = '') {
  const expected = normalizeProjectToken(roomOrProjectName);
  if (!expected) return false;
  const name = normalizeProjectToken(project.name);
  const projectPath = normalizeProjectToken(project.path || project.projectPath || project.project_path);
  return name === expected
    || projectPath === expected
    || projectPath.endsWith(`/${expected}`);
}

function metadataIndicatesTrustQuoteProject(metadata = {}) {
  return projectMetadataCandidates(metadata)
    .some((project) => projectMetadataMatchesName(project, TRUSTQUOTE_ROOM_ID));
}

function metadataIndicatesTrustedMainProject(metadata = {}) {
  return projectMetadataCandidates(metadata)
    .some((project) => projectMetadataMatchesName(project, 'squidrun'));
}

function normalizeSourceRefs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => toText(entry, ''))
    .filter(Boolean)
    .slice(0, 12);
}

function hashRoomBody(body = '') {
  const text = String(body || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `room-body-v0:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function makeTrustQuoteSessionScopeId(mainSessionScopeId = '') {
  const base = toText(mainSessionScopeId, 'app-session-preview');
  return base.toLowerCase().endsWith(`:${TRUSTQUOTE_ROOM_ID}`)
    ? base
    : `${base}:${TRUSTQUOTE_ROOM_ID}`;
}

function makeRoomRouteScope(roomId = TRUSTQUOTE_ROOM_ID, sessionScopeId = '') {
  const normalizedRoomId = normalizeRoomId(roomId);
  return {
    profileName: normalizedRoomId,
    windowKey: normalizedRoomId,
    sessionScopeId: toText(sessionScopeId, null),
  };
}

function defaultPathExists(filePath) {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

function defaultReadJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function trustQuoteWorkRoomPath(projectPath, ...parts) {
  return joinMetadataPath(projectPath, '.squidrun', 'work-rooms', TRUSTQUOTE_ROOM_ID, ...parts);
}

function trustQuoteGeneratedStartupSourcePath(projectPath, name) {
  return trustQuoteWorkRoomPath(projectPath, 'startup', name);
}

function trustQuoteWorkstreamPath(projectPath) {
  return trustQuoteWorkRoomPath(projectPath, 'current-workstream.json');
}

function resolveStartupSourceFile(projectPath, name, pathExists) {
  const rootPath = joinMetadataPath(projectPath, name);
  if (pathExists(rootPath)) {
    return {
      name,
      path: rootPath,
      present: true,
      source: 'project_root',
    };
  }

  const generatedPath = trustQuoteGeneratedStartupSourcePath(projectPath, name);
  if (TRUSTQUOTE_GENERATED_STARTUP_SOURCE_FILES.has(name) && pathExists(generatedPath)) {
    return {
      name,
      path: generatedPath,
      present: true,
      source: 'generated_room_startup',
      rootPath,
    };
  }

  return {
    name,
    path: rootPath,
    present: false,
    source: 'missing',
    fallbackPath: TRUSTQUOTE_GENERATED_STARTUP_SOURCE_FILES.has(name) ? generatedPath : null,
  };
}

function resolveTrustQuoteProfileRootBinding(options = {}) {
  const projectPath = normalizePathForMetadata(options.projectPath || TRUSTQUOTE_PROJECT_PATH);
  const squidrunRoot = normalizePathForMetadata(options.squidrunRoot || DEFAULT_SQUIDRUN_ROOT);
  const env = asObject(options.env || (typeof process !== 'undefined' ? process.env : {}));
  const envProjectRoot = normalizePathForMetadata(env[TRUSTQUOTE_REQUIRED_PROJECT_ROOT_ENV]);
  const envStatus = envProjectRoot
    ? (sameMetadataPath(envProjectRoot, projectPath) ? 'configured' : 'mismatch')
    : 'missing';
  const hasOverride = Object.prototype.hasOwnProperty.call(options, 'profileRootOverride');
  let profileRoot = hasOverride ? options.profileRootOverride : null;
  if (!hasOverride) {
    const resolver = typeof options.getProfileProjectRootOverride === 'function'
      ? options.getProfileProjectRootOverride
      : getProfileProjectRootOverride;
    try {
      profileRoot = resolver(TRUSTQUOTE_ROOM_ID, env, { squidrunRoot });
    } catch (_) {
      profileRoot = null;
    }
  }
  const profileRootPath = normalizePathForMetadata(profileRoot);
  const profileStatus = profileRootPath
    ? (sameMetadataPath(profileRootPath, projectPath) ? 'configured' : 'mismatch')
    : 'missing';
  const profileConfigPath = getProfileProjectRootConfigPath(TRUSTQUOTE_ROOM_ID, squidrunRoot);
  const status = envStatus === 'configured' || profileStatus === 'configured'
    ? 'configured'
    : (envStatus === 'mismatch' || profileStatus === 'mismatch' ? 'mismatch' : 'missing');

  return {
    status,
    source: envStatus === 'configured'
      ? 'env'
      : (profileStatus === 'configured' ? 'profile_root_contract' : null),
    env: {
      requiredName: TRUSTQUOTE_REQUIRED_PROJECT_ROOT_ENV,
      requiredValue: projectPath,
      currentValue: envProjectRoot || null,
      status: envStatus,
    },
    profileRoot: {
      path: profileConfigPath,
      expectedValue: projectPath,
      currentValue: profileRootPath || null,
      status: profileStatus,
    },
  };
}

function hasTrustQuoteText(row = {}) {
  return /\btrustquote\b/i.test(toText(row.rawBody || row.body || row.content, ''));
}

function hasTrustQuoteRoomText(row = {}) {
  return /\btrustquote\b[\s\S]{0,80}\broom\b/i.test(toText(row.rawBody || row.body || row.content, ''))
    || /\broom\b[\s\S]{0,80}\btrustquote\b/i.test(toText(row.rawBody || row.body || row.content, ''));
}

function extractMetadata(rowOrMetadata = {}) {
  const source = asObject(rowOrMetadata);
  if (source.metadata || source.meta || source.metadata_json) {
    return {
      ...parseMaybeJsonObject(source.metadata_json),
      ...asObject(source.metadata),
      ...asObject(source.meta),
    };
  }
  return parseMaybeJsonObject(rowOrMetadata);
}

function extractRoomMetadata(metadata = {}) {
  const source = extractMetadata(metadata);
  const room = {
    ...asObject(source.room),
    ...asObject(source.roomEnvelope),
    ...asObject(source.room_envelope),
  };
  const directRoomId = source.roomId || source.room_id || source.sourceRoomId || source.source_room_id;
  if (directRoomId && !room.id && !room.sourceRoomId && !room.source_room_id) {
    room.id = directRoomId;
  }
  return room;
}

function buildTrustQuoteRoomEnvelope(input = {}) {
  const body = toText(input.body || input.rawBody || input.content, '');
  const targetRole = normalizeInternalRole(input.targetRole || input.target_role || 'architect') || 'architect';
  const visibility = TRUSTQUOTE_ROOM_VISIBILITIES.has(toText(input.visibility, 'cross_room_summary'))
    ? toText(input.visibility, 'cross_room_summary')
    : 'cross_room_summary';
  const sessionScopeId = toText(input.sessionScopeId || input.session_scope_id, null);

  return {
    version: ROOM_ENVELOPE_VERSION,
    room: {
      id: TRUSTQUOTE_ROOM_ID,
      sourceRoomId: TRUSTQUOTE_ROOM_ID,
      sourceWindowKey: TRUSTQUOTE_ROOM_ID,
      sourceProjectPath: normalizePathForMetadata(input.sourceProjectPath || input.source_project_path || TRUSTQUOTE_PROJECT_PATH),
      targetRoomId: MAIN_ROOM_ID,
      targetRole,
      visibility,
      sessionScopeId,
      bodyHash: toText(input.bodyHash || input.body_hash, '') || hashRoomBody(body),
      sourceRefs: normalizeSourceRefs(input.sourceRefs || input.source_refs),
      dispatch: 'preview_only',
    },
  };
}

function buildTrustQuoteLaunchReadiness(options = {}) {
  const projectPath = normalizePathForMetadata(options.projectPath || TRUSTQUOTE_PROJECT_PATH);
  const squidrunRoot = normalizePathForMetadata(options.squidrunRoot || DEFAULT_SQUIDRUN_ROOT);
  const mainSessionScopeId = toText(options.mainSessionScopeId || options.sessionScopeId || options.session_id, 'app-session-preview');
  const sessionScopeId = makeTrustQuoteSessionScopeId(mainSessionScopeId);
  const pathExists = typeof options.pathExists === 'function' ? options.pathExists : defaultPathExists;
  const readJson = typeof options.readJson === 'function' ? options.readJson : defaultReadJson;
  const rootBinding = resolveTrustQuoteProfileRootBinding({
    ...options,
    projectPath,
    squidrunRoot,
  });
  const linkPath = joinMetadataPath(projectPath, '.squidrun', 'link.json');
  const startupBundlePath = joinMetadataPath(squidrunRoot, '.squidrun', 'runtime', 'window-teams', TRUSTQUOTE_ROOM_ID, 'startup-bundle.md');
  const sourceFiles = TRUSTQUOTE_STARTUP_SOURCE_FILES.map((name) => (
    resolveStartupSourceFile(projectPath, name, pathExists)
  ));
  const linkExists = Boolean(pathExists(linkPath));
  const linkJson = linkExists ? asObject(readJson(linkPath)) : {};
  const linkIssues = [];

  if (!linkExists) {
    linkIssues.push('missing');
  } else if (!Object.keys(linkJson).length) {
    linkIssues.push('unreadable');
  } else {
    if (!sameMetadataPath(linkJson.workspace, projectPath)) linkIssues.push('workspace_mismatch');
    if (toText(linkJson.profile, '') !== TRUSTQUOTE_ROOM_ID) linkIssues.push('missing_or_wrong_profile');
    if (toText(linkJson.session_id, '') !== sessionScopeId) linkIssues.push('stale_session_scope');
  }

  const blockers = ['explicit_launch_approval_required'];
  if (rootBinding.status === 'missing') blockers.push('project_root_binding_missing');
  if (rootBinding.status === 'mismatch') blockers.push('project_root_binding_mismatch');
  if (rootBinding.env.status === 'missing' && rootBinding.profileRoot.status !== 'configured') blockers.push('env_override_missing');
  if (rootBinding.env.status === 'mismatch') blockers.push('env_override_mismatch');
  if (rootBinding.profileRoot.status === 'missing' && rootBinding.env.status !== 'configured') blockers.push('profile_root_contract_missing');
  if (rootBinding.profileRoot.status === 'mismatch') blockers.push('profile_root_contract_mismatch');

  for (const sourceFile of sourceFiles) {
    if (sourceFile.present !== true) {
      blockers.push(`trustquote_${sourceFile.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_missing`);
    }
  }

  const linkStatus = linkIssues.length ? 'stale_or_non_profiled' : 'current';
  if (linkStatus !== 'current') blockers.push('trustquote_link_json_stale_or_non_profiled');
  blockers.push('raw_secondary_window_auto_boots_full_3_pane_team');

  const payload = {
    roomId: TRUSTQUOTE_ROOM_ID,
    launchMode: 'main_owned_secondary_window_preview',
    windowKey: TRUSTQUOTE_ROOM_ID,
    profileName: MAIN_ROOM_ID,
    profileKey: TRUSTQUOTE_ROOM_ID,
    projectRoot: projectPath,
    requiredEnv: {
      [TRUSTQUOTE_REQUIRED_PROJECT_ROOT_ENV]: projectPath,
    },
    sessionScopeId,
    startupBundlePath,
    linkPath,
    autoBootAgents: false,
    roleLayout: 'builder-oracle-preview',
    allowedRoles: ['builder', 'oracle'],
    blockedRoles: ['architect'],
    dispatch: 'preview_only',
  };
  const roomEnvelopePreview = buildTrustQuoteRoomEnvelope({
    body: 'TrustQuote room launch readiness preview.',
    targetRole: 'architect',
    sessionScopeId,
    sourceRefs: [
      projectPath,
      linkPath,
      startupBundlePath,
    ],
  });

  return {
    roomId: TRUSTQUOTE_ROOM_ID,
    status: 'preview_only',
    canLaunchAgents: false,
    approvalRequired: true,
    projectRootBinding: rootBinding,
    env: rootBinding.env,
    profileRoot: rootBinding.profileRoot,
    sourceFiles,
    link: {
      path: linkPath,
      status: linkStatus,
      exists: linkExists,
      issues: linkIssues,
      expected: {
        workspace: projectPath,
        profile: TRUSTQUOTE_ROOM_ID,
        session_id: sessionScopeId,
      },
      current: linkExists && Object.keys(linkJson).length ? {
        workspace: normalizePathForMetadata(linkJson.workspace),
        profile: toText(linkJson.profile, null),
        session_id: toText(linkJson.session_id, null),
      } : null,
    },
    rawPath: {
      secondaryWindowSupported: true,
      currentRoleLayout: 'standard',
      currentAutoBootAgents: true,
      currentBootScope: 'full_3_pane_team',
      previewAutoBootAgents: false,
    },
    payload,
    roomEnvelopePreview,
    sideEffectBoundary: {
      opensWindow: false,
      writesStartupBundle: false,
      writesProfileLink: false,
      launchesAgents: false,
      dispatchesMessage: false,
      performsRuntimePost: false,
      mutatesMainProjectContext: false,
      changesAppLifecycle: false,
      changesChannelRoute: false,
      includesUnreviewedRoom: false,
    },
    blockers,
  };
}

function normalizeRouteHealth(role, value = {}) {
  const source = asObject(value);
  const normalizedRole = normalizeInternalRole(source.role || role);
  const routeBinding = asObject(source.routeBinding || source.binding);
  const healthy = source.healthy === true
    && toText(source.status, '') === REAL_ROOM_ROUTE_STATUS
    && toText(source.source, '') === REAL_ROOM_ROUTE_SOURCE;
  return {
    role: normalizedRole || role,
    healthy,
    status: toText(source.status, source.healthy === true ? 'unknown' : 'missing'),
    source: toText(source.source, null),
    lastSeen: source.lastSeen ?? null,
    ageMs: Number.isFinite(Number(source.ageMs)) ? Number(source.ageMs) : null,
    routeScope: asObject(source.routeScope || source.targetScope),
    clientKind: toText(source.clientKind || routeBinding.clientKind, null),
    routeBinding: {
      clientKind: toText(routeBinding.clientKind || source.clientKind, null),
      routeOwner: toText(routeBinding.routeOwner || routeBinding.owner, null),
      roomId: normalizeRoomId(routeBinding.roomId || routeBinding.room_id),
      role: normalizeInternalRole(routeBinding.role || source.role || role),
      paneId: toText(routeBinding.paneId || routeBinding.pane_id, null),
      terminalPaneId: toText(routeBinding.terminalPaneId || routeBinding.terminal_pane_id, null),
      terminalBacked: routeBinding.terminalBacked === true || routeBinding.terminal_backed === true,
      agentProcessStarted: routeBinding.agentProcessStarted === true || routeBinding.agent_process_started === true,
      profileName: toText(routeBinding.profileName || routeBinding.profile, null),
      windowKey: toText(routeBinding.windowKey || routeBinding.window, null),
      sessionScopeId: toText(routeBinding.sessionScopeId || routeBinding.session_scope_id, null),
      workspace: normalizePathForMetadata(routeBinding.workspace || routeBinding.projectPath || routeBinding.projectRoot),
      startupBundlePath: normalizePathForMetadata(routeBinding.startupBundlePath || routeBinding.startup_bundle_path),
      workstreamPath: normalizePathForMetadata(routeBinding.workstreamPath || routeBinding.workstream_path),
    },
  };
}

function resolveRouteHealth(role, routeScope, options = {}) {
  if (typeof options.getRoutingHealth === 'function') {
    return normalizeRouteHealth(role, options.getRoutingHealth(
      role,
      options.staleAfterMs,
      options.now,
      routeScope,
      asObject(options.routingHealthOptions)
    ));
  }
  const routeHealth = asObject(options.routeHealth);
  return normalizeRouteHealth(role, routeHealth[role]);
}

function routeScopeMatchesExpected(routeScope = {}, expected = {}) {
  const source = asObject(routeScope);
  return toText(source.profileName, '') === expected.profileName
    && toText(source.windowKey, '') === expected.windowKey
    && toText(source.sessionScopeId, null) === expected.sessionScopeId;
}

function getRouteOwnerProofIssues(route = {}, expected = {}) {
  const binding = asObject(route.routeBinding);
  const issues = [];
  if (route.healthy !== true) return issues;
  if (toText(route.clientKind || binding.clientKind, '') !== REAL_ROOM_ROUTE_CLIENT_KIND) {
    issues.push('client_kind_missing');
  }
  if (binding.roomId !== TRUSTQUOTE_ROOM_ID) issues.push('room_mismatch');
  if (binding.role !== route.role) issues.push('role_mismatch');
  if (binding.terminalBacked !== true) issues.push('terminal_not_backed');
  if (binding.agentProcessStarted !== true) issues.push('agent_process_not_started');
  if (!binding.terminalPaneId) issues.push('terminal_pane_missing');
  if (!routeScopeMatchesExpected(binding, expected.routeScope)) issues.push('binding_scope_mismatch');
  if (!sameMetadataPath(binding.workspace, expected.projectPath)) issues.push('workspace_mismatch');
  if (!sameMetadataPath(binding.startupBundlePath, expected.startupBundlePath)) issues.push('startup_bundle_mismatch');
  if (!sameMetadataPath(binding.workstreamPath, expected.workstreamPath)) issues.push('workstream_mismatch');
  return issues;
}

function normalizeWorkstreamEvidence(value = {}, expected = {}) {
  const source = asObject(value);
  const issues = [];
  if (toText(source.version, '') !== TRUSTQUOTE_WORKSTREAM_VERSION) issues.push('version_mismatch');
  if (toText(source.roomId, '') !== TRUSTQUOTE_ROOM_ID) issues.push('room_mismatch');
  if (!sameMetadataPath(source.projectRoot || source.workspace, expected.projectPath)) issues.push('project_mismatch');
  if (toText(source.profile, '') !== TRUSTQUOTE_ROOM_ID) issues.push('profile_mismatch');
  if (toText(source.sessionScopeId || source.session_id, '') !== expected.sessionScopeId) issues.push('session_scope_mismatch');

  return {
    path: toText(source.path, expected.path),
    present: true,
    status: issues.length ? 'stale_or_mismatched' : 'current',
    issues,
    currentTask: source.currentTask || null,
    workstreamStatus: toText(source.status, null),
    routeStatus: toText(source.routeStatus, null),
    sourceRefs: normalizeSourceRefs(source.sourceRefs),
  };
}

function resolveTrustQuoteWorkstreamEvidence(options = {}) {
  const projectPath = normalizePathForMetadata(options.projectPath || TRUSTQUOTE_PROJECT_PATH);
  const sessionScopeId = toText(options.sessionScopeId, null);
  const pathExists = typeof options.pathExists === 'function' ? options.pathExists : defaultPathExists;
  const readJson = typeof options.readJson === 'function' ? options.readJson : defaultReadJson;
  const workstreamPath = trustQuoteWorkstreamPath(projectPath);

  if (options.workstreamEvidence && typeof options.workstreamEvidence === 'object') {
    return normalizeWorkstreamEvidence({
      path: workstreamPath,
      ...options.workstreamEvidence,
    }, {
      path: workstreamPath,
      projectPath,
      sessionScopeId,
    });
  }

  if (!pathExists(workstreamPath)) {
    return {
      path: workstreamPath,
      present: false,
      status: 'missing',
      issues: ['missing'],
      currentTask: null,
      workstreamStatus: null,
      routeStatus: null,
      sourceRefs: [],
    };
  }

  const parsed = asObject(readJson(workstreamPath));
  if (!Object.keys(parsed).length) {
    return {
      path: workstreamPath,
      present: true,
      status: 'unreadable',
      issues: ['unreadable'],
      currentTask: null,
      workstreamStatus: null,
      routeStatus: null,
      sourceRefs: [],
    };
  }

  return normalizeWorkstreamEvidence({
    path: workstreamPath,
    ...parsed,
  }, {
    path: workstreamPath,
    projectPath,
    sessionScopeId,
  });
}

function buildTrustQuoteWorkRoomContract(options = {}) {
  const projectPath = normalizePathForMetadata(options.projectPath || TRUSTQUOTE_PROJECT_PATH);
  const mainSessionScopeId = toText(options.mainSessionScopeId || options.sessionScopeId || options.session_id, 'app-session-preview');
  const sessionScopeId = makeTrustQuoteSessionScopeId(mainSessionScopeId);
  const routeScope = makeRoomRouteScope(TRUSTQUOTE_ROOM_ID, sessionScopeId);
  const readiness = buildTrustQuoteLaunchReadiness({
    ...options,
    projectPath,
    mainSessionScopeId,
  });
  const requiredRoles = (Array.isArray(options.requiredRoles) ? options.requiredRoles : TRUSTQUOTE_REQUIRED_WORK_ROOM_ROLES)
    .map(normalizeInternalRole)
    .filter((role) => role && role !== 'architect');
  const uniqueRequiredRoles = Array.from(new Set(requiredRoles));
  const routeChecks = uniqueRequiredRoles.map((role) => resolveRouteHealth(role, routeScope, options));
  const workstream = resolveTrustQuoteWorkstreamEvidence({
    ...options,
    projectPath,
    sessionScopeId,
  });
  const routeOwnerExpected = {
    projectPath,
    routeScope,
    startupBundlePath: readiness.payload?.startupBundlePath,
    workstreamPath: trustQuoteWorkstreamPath(projectPath),
  };
  const blockers = [];

  if (readiness.projectRootBinding.status !== 'configured') {
    blockers.push(`project_root_binding_${readiness.projectRootBinding.status}`);
  }
  for (const sourceFile of readiness.sourceFiles) {
    if (sourceFile.present !== true) {
      blockers.push(`missing_startup_source:${sourceFile.name}`);
    }
  }
  if (readiness.link.status !== 'current') {
    blockers.push('profile_link_not_current');
  }
  if (uniqueRequiredRoles.length === 0) {
    blockers.push('required_room_agent_roles_missing');
  }
  if (workstream.status !== 'current') {
    blockers.push(`workstream_evidence_${workstream.status}`);
  }
  for (const route of routeChecks) {
    if (!route.healthy) {
      blockers.push(`route_unhealthy:${route.role}:${route.status}`);
      continue;
    }
    if (!routeScopeMatchesExpected(route.routeScope, routeScope)) {
      blockers.push(`route_scope_mismatch:${route.role}`);
    }
    for (const issue of getRouteOwnerProofIssues(route, routeOwnerExpected)) {
      blockers.push(`route_owner_proof_${issue}:${route.role}`);
    }
  }

  const proven = blockers.length === 0;
  return {
    version: WORK_ROOM_CONTRACT_VERSION,
    roomId: TRUSTQUOTE_ROOM_ID,
    label: 'TrustQuote',
    status: proven ? 'proven' : 'blocked',
    canRenderTopTab: proven,
    canRouteTask: proven,
    project: {
      name: 'TrustQuote',
      path: projectPath,
    },
    routeContract: {
      ownerRoomId: TRUSTQUOTE_ROOM_ID,
      routeScope,
      requiredRoles: uniqueRequiredRoles,
      routeChecks,
      allowedTargets: proven ? uniqueRequiredRoles : [],
    },
    antiPurgatory: {
      continuitySource: readiness.link.path,
      currentTaskSource: workstream.status === 'current' ? workstream.path : 'comms_journal_room_scope_required',
      manualUiInspectionRequired: false,
      unprovenRoomRenders: false,
    },
    readiness,
    workstream,
    blockers,
  };
}

function normalizeTrustQuoteRoomEnvelope(rowOrMetadata = {}) {
  const metadata = extractMetadata(rowOrMetadata);
  const room = extractRoomMetadata(metadata);
  const sourceRoomId = normalizeRoomId(
    room.sourceRoomId
      || room.source_room_id
      || room.id
      || room.roomId
      || room.room_id
      || metadata.windowKey
      || metadata.window_key
      || metadata.profile
  );
  const rawSourceRoom = toText(
    room.sourceRoomId
      || room.source_room_id
      || room.id
      || room.roomId
      || room.room_id
      || metadata.windowKey
      || metadata.window_key
      || metadata.profile,
    ''
  );

  if (!sourceRoomId) {
    return {
      ok: false,
      status: rawSourceRoom ? 'unsupported_room_metadata' : 'missing_room_metadata',
      roomId: rawSourceRoom || null,
      visibleInMain: true,
      canAffectMainCurrentLane: false,
      reason: rawSourceRoom ? 'unsupported_room_metadata_non_authoritative' : 'missing_room_metadata_non_authoritative',
    };
  }

  if (sourceRoomId !== TRUSTQUOTE_ROOM_ID) {
    return {
      ok: false,
      status: 'not_trustquote_room',
      roomId: sourceRoomId,
      visibleInMain: sourceRoomId !== MAIN_ROOM_ID,
      canAffectMainCurrentLane: sourceRoomId === MAIN_ROOM_ID,
      reason: sourceRoomId === MAIN_ROOM_ID ? 'main_room_metadata' : 'other_room_non_authoritative',
    };
  }

  const targetRoomId = normalizeRoomId(room.targetRoomId || room.target_room_id || room.targetRoom || room.target_room || MAIN_ROOM_ID);
  const targetRole = normalizeInternalRole(room.targetRole || room.target_role || metadata.targetRole || metadata.target_role);
  const visibility = TRUSTQUOTE_ROOM_VISIBILITIES.has(toText(room.visibility, 'cross_room_summary'))
    ? toText(room.visibility, 'cross_room_summary')
    : 'cross_room_summary';

  return {
    ok: true,
    status: 'trustquote_room_envelope',
    version: toText(metadata.version || metadata.roomEnvelopeVersion || metadata.room_envelope_version, ROOM_ENVELOPE_VERSION),
    roomId: TRUSTQUOTE_ROOM_ID,
    sourceRoomId: TRUSTQUOTE_ROOM_ID,
    sourceWindowKey: toText(room.sourceWindowKey || room.source_window_key || metadata.windowKey || metadata.window_key, TRUSTQUOTE_ROOM_ID),
    sourceProjectPath: normalizePathForMetadata(room.sourceProjectPath || room.source_project_path),
    targetRoomId: targetRoomId || MAIN_ROOM_ID,
    targetRole,
    visibility,
    sessionScopeId: toText(room.sessionScopeId || room.session_scope_id || metadata.sessionScopeId || metadata.session_scope_id, null),
    bodyHash: toText(room.bodyHash || room.body_hash, null),
    sourceRefs: normalizeSourceRefs(room.sourceRefs || room.source_refs),
    visibleInMain: true,
    canAffectMainCurrentLane: false,
    reason: 'trustquote_room_preview_only',
  };
}

function canUseCommsRowAsMainLaneAuthority(row = {}) {
  const metadata = extractMetadata(row);
  const room = extractRoomMetadata(metadata);
  const hasExplicitRoom = Object.keys(room).length > 0
    || Boolean(metadata.roomId || metadata.room_id || metadata.sourceRoomId || metadata.source_room_id);
  const roomStatus = normalizeTrustQuoteRoomEnvelope(metadata);
  if (roomStatus.ok && roomStatus.roomId === TRUSTQUOTE_ROOM_ID) return false;
  if (hasExplicitRoom && roomStatus.roomId !== MAIN_ROOM_ID) return false;
  if (metadataIndicatesTrustQuoteProject(metadata)) return false;

  const windowKey = toText(metadata.windowKey || metadata.window_key || metadata.profile || metadata.profileName || metadata.profile_name, '').toLowerCase();
  if (windowKey === TRUSTQUOTE_ROOM_ID) return false;

  const sessionScopeId = toText(metadata.sessionScopeId || metadata.session_scope_id || row.sessionId || row.session_id, '').toLowerCase();
  if (sessionScopeId.split(':').pop() === TRUSTQUOTE_ROOM_ID) return false;

  if (!hasExplicitRoom && hasTrustQuoteRoomText(row) && !metadataIndicatesTrustedMainProject(metadata)) return false;

  return true;
}

function normalizeTrustQuoteRoomCommsRow(row = {}) {
  const envelope = normalizeTrustQuoteRoomEnvelope(row);
  const timestampMs = Number(row.brokeredAtMs || row.sentAtMs || row.updatedAtMs || row.timestampMs || 0) || 0;
  const visibleBecauseText = hasTrustQuoteText(row);
  const visible = envelope.ok || envelope.visibleInMain || visibleBecauseText;
  if (!visible) return null;

  return {
    messageId: toText(row.messageId || row.message_id, null),
    sessionId: toText(row.sessionId || row.session_id, null),
    senderRole: normalizeInternalRole(row.senderRole || row.sender_role) || toText(row.senderRole || row.sender_role, null),
    targetRole: normalizeInternalRole(row.targetRole || row.target_role) || toText(row.targetRole || row.target_role, null),
    timestampMs,
    rawBody: toText(row.rawBody || row.raw_body || row.body, ''),
    envelope,
    visibleInMain: true,
    canAffectMainCurrentLane: false,
    authorityReason: envelope.reason || 'trustquote_room_activity_non_authoritative',
  };
}

function queryTrustQuoteRoomRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeTrustQuoteRoomCommsRow(row))
    .filter(Boolean)
    .sort((left, right) => right.timestampMs - left.timestampMs);
}

function buildTrustQuoteReadiness(options = {}) {
  const projectPath = normalizePathForMetadata(options.projectPath || TRUSTQUOTE_PROJECT_PATH);
  const pathExists = typeof options.pathExists === 'function'
    ? options.pathExists(projectPath)
    : null;
  const rows = queryTrustQuoteRoomRows(options.commsRows || []);
  const validRows = rows.filter((row) => row.envelope.ok);
  const nonAuthoritativeRows = rows.filter((row) => row.canAffectMainCurrentLane !== true);
  const launchReadiness = buildTrustQuoteLaunchReadiness({
    ...options,
    projectPath,
  });

  return {
    roomId: TRUSTQUOTE_ROOM_ID,
    status: 'preview_only',
    projectPath,
    projectPathStatus: pathExists === true ? 'present' : (pathExists === false ? 'missing' : 'unchecked'),
    transport: 'existing_comms_journal_metadata',
    envelopeVersion: ROOM_ENVELOPE_VERSION,
    validRoomRowCount: validRows.length,
    visibleNonAuthoritativeRowCount: nonAuthoritativeRows.length,
    launchReadiness,
    canLaunchAgents: false,
    canMutateMainProjectContext: false,
    canAffectMainCurrentLane: false,
    canDispatchExternalAction: false,
    blockers: [
      'explicit_room_launch_not_approved',
      'main_lane_authority_disabled',
      'cross_room_publish_requires_review',
      ...launchReadiness.blockers,
    ],
  };
}

function buildTrustQuoteReadinessCard(options = {}) {
  const readiness = buildTrustQuoteReadiness(options);
  return {
    id: TRUSTQUOTE_ROOM_ID,
    label: 'TrustQuote',
    status: 'PREVIEW',
    authority: 'preview',
    title: 'TrustQuote readiness',
    summary: 'Readiness snapshot for possible TrustQuote work.',
    details: [
      `Project: ${readiness.projectPath}`,
      'Status: preview only',
      'Review required before launch',
    ],
    jamesAction: 'JAMES ACTION: NONE',
    readiness,
  };
}

module.exports = {
  MAIN_ROOM_ID,
  ROOM_ENVELOPE_VERSION,
  TRUSTQUOTE_PROJECT_PATH,
  TRUSTQUOTE_REQUIRED_PROJECT_ROOT_ENV,
  TRUSTQUOTE_WORKSTREAM_VERSION,
  REAL_ROOM_ROUTE_CLIENT_KIND,
  WORK_ROOM_CONTRACT_VERSION,
  TRUSTQUOTE_ROOM_ID,
  buildTrustQuoteLaunchReadiness,
  buildTrustQuoteReadiness,
  buildTrustQuoteReadinessCard,
  buildTrustQuoteRoomEnvelope,
  buildTrustQuoteWorkRoomContract,
  canUseCommsRowAsMainLaneAuthority,
  hashRoomBody,
  makeTrustQuoteSessionScopeId,
  makeRoomRouteScope,
  normalizeTrustQuoteRoomCommsRow,
  normalizeTrustQuoteRoomEnvelope,
  queryTrustQuoteRoomRows,
};
