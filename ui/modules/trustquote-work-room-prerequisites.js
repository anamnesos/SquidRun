'use strict';

const fs = require('fs');
const path = require('path');

const {
  PROFILE_ROOT_CONFIG_VERSION,
  getProfileProjectRootConfigPath,
} = require('../profile');
const {
  TRUSTQUOTE_PROJECT_PATH,
  TRUSTQUOTE_ROOM_ID,
  TRUSTQUOTE_WORKSTREAM_VERSION,
  makeTrustQuoteSessionScopeId,
} = require('./project-room-envelope');

const PREREQUISITE_CONTRACT_VERSION = 'squidrun.trustquote-work-room-prerequisites.v0';
const GENERATED_STARTUP_SOURCE_VERSION = 'squidrun.trustquote-startup-source.v0';

function toText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizeToPosix(value) {
  return toText(value, '').replace(/\\/g, '/');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function resolveSquidrunRoot(options = {}) {
  return path.resolve(options.squidrunRoot || path.join(__dirname, '..', '..'));
}

function resolveMainSessionScopeId(options = {}) {
  const explicit = toText(options.mainSessionScopeId || options.sessionScopeId || options.session_id, '');
  if (explicit) return explicit;

  const squidrunRoot = resolveSquidrunRoot(options);
  const appStatus = readJsonFile(path.join(squidrunRoot, '.squidrun', 'app-status.json'));
  const sessionNumber = Number(appStatus?.session);
  if (Number.isInteger(sessionNumber) && sessionNumber > 0) {
    return `app-session-${sessionNumber}`;
  }
  return 'app-session-preview';
}

function buildGeneratedAgentsSource({ projectPath, sessionScopeId, generatedAt }) {
  return [
    '# TrustQuote SquidRun Work Room Startup Source',
    '',
    `Version: ${GENERATED_STARTUP_SOURCE_VERSION}`,
    `Generated: ${generatedAt}`,
    '',
    'Purpose:',
    '- Bind TrustQuote room agents to the TrustQuote workspace/profile/session before any live room route can render.',
    '',
    'Room identity:',
    `- Profile: ${TRUSTQUOTE_ROOM_ID}`,
    `- Workspace: ${normalizeToPosix(projectPath)}`,
    `- Session Scope: ${sessionScopeId}`,
    '',
    'Rules:',
    '- Work inside the TrustQuote workspace unless a room-scoped instruction explicitly says otherwise.',
    '- Treat SquidRun Main as coordinator context, not TrustQuote workspace authority.',
    '- Follow the TrustQuote CLAUDE.md and imported docs/claude modules for project-specific rules.',
    '- Use .squidrun/link.json as the route/profile/session source of truth.',
    '- Do not claim a live TrustQuote tab or route until builder and oracle routes are healthy client_activity under this session.',
    '',
  ].join('\n');
}

function buildGeneratedRolesSource({ sessionScopeId }) {
  return [
    '# TrustQuote SquidRun Work Room Roles',
    '',
    `Version: ${GENERATED_STARTUP_SOURCE_VERSION}`,
    '',
    'Room roles:',
    '- Architect remains the main SquidRun coordinator unless a future proven room contract says otherwise.',
    '- Builder owns TrustQuote implementation inside the trustquote profile/session boundary.',
    '- Oracle owns TrustQuote investigation, verification, and review inside the trustquote profile/session boundary.',
    '',
    'Route boundary:',
    `- Required session scope: ${sessionScopeId}`,
    '- Required window/profile: trustquote',
    '- Handler-only/local-message routes do not prove a live TrustQuote work room.',
    '',
  ].join('\n');
}

function buildStartupBundle({ projectPath, linkPath, agentsPath, rolesPath, startupBundlePath, sessionScopeId, generatedAt }) {
  return [
    '# TrustQuote Startup Bundle',
    '',
    `Generated: ${generatedAt}`,
    `Session Scope: ${sessionScopeId}`,
    '',
    'Profile identity:',
    `- Profile: ${TRUSTQUOTE_ROOM_ID}`,
    `- Workspace: ${normalizeToPosix(projectPath)}`,
    `- Link: ${normalizeToPosix(linkPath)}`,
    '',
    'Authoritative source files:',
    `- ${normalizeToPosix(agentsPath)}`,
    `- ${normalizeToPosix(path.join(projectPath, 'CLAUDE.md'))}`,
    `- ${normalizeToPosix(rolesPath)}`,
    '',
    'Work-room routing contract:',
    '- Route scope: profileName=trustquote, windowKey=trustquote',
    `- Session scope: ${sessionScopeId}`,
    '- Required live routes before a TrustQuote tab can render: builder and oracle via client_activity.',
    '- Handler-only/local-message routes are not live room proof.',
    '',
    `Bundle path: ${normalizeToPosix(startupBundlePath)}`,
    '',
  ].join('\n');
}

function buildTrustQuoteWorkRoomPrerequisiteArtifacts(options = {}) {
  const squidrunRoot = resolveSquidrunRoot(options);
  const projectPath = path.resolve(options.projectPath || TRUSTQUOTE_PROJECT_PATH);
  const generatedAt = toText(options.generatedAt || options.now, '') || new Date().toISOString();
  const mainSessionScopeId = resolveMainSessionScopeId({ ...options, squidrunRoot });
  const sessionScopeId = makeTrustQuoteSessionScopeId(mainSessionScopeId);
  const profileRootConfigPath = getProfileProjectRootConfigPath(TRUSTQUOTE_ROOM_ID, squidrunRoot);
  const trustQuoteCoordDir = path.join(projectPath, '.squidrun');
  const workRoomDir = path.join(trustQuoteCoordDir, 'work-rooms', TRUSTQUOTE_ROOM_ID);
  const startupDir = path.join(workRoomDir, 'startup');
  const linkPath = path.join(trustQuoteCoordDir, 'link.json');
  const agentsPath = path.join(startupDir, 'AGENTS.md');
  const rolesPath = path.join(startupDir, 'ROLES.md');
  const workstreamPath = path.join(workRoomDir, 'current-workstream.json');
  const startupBundlePath = path.join(squidrunRoot, '.squidrun', 'runtime', 'window-teams', TRUSTQUOTE_ROOM_ID, 'startup-bundle.md');

  const profileRootContract = {
    version: PROFILE_ROOT_CONFIG_VERSION,
    profile: TRUSTQUOTE_ROOM_ID,
    roomId: TRUSTQUOTE_ROOM_ID,
    projectRoot: normalizeToPosix(projectPath),
    source: PREREQUISITE_CONTRACT_VERSION,
    generatedAt,
  };
  const link = {
    squidrun_root: normalizeToPosix(squidrunRoot),
    comms: {
      hm_send: normalizeToPosix(path.join(squidrunRoot, 'ui', 'scripts', 'hm-send.js')),
      hm_comms: normalizeToPosix(path.join(squidrunRoot, 'ui', 'scripts', 'hm-comms.js')),
    },
    workspace: normalizeToPosix(projectPath),
    session_id: sessionScopeId,
    role_targets: {
      architect: 'architect',
      builder: 'builder',
      oracle: 'oracle',
    },
    version: 1,
    profile: TRUSTQUOTE_ROOM_ID,
    room: {
      id: TRUSTQUOTE_ROOM_ID,
      sessionScopeId,
      contractVersion: PREREQUISITE_CONTRACT_VERSION,
    },
  };
  const workstream = {
    version: TRUSTQUOTE_WORKSTREAM_VERSION,
    roomId: TRUSTQUOTE_ROOM_ID,
    profile: TRUSTQUOTE_ROOM_ID,
    projectRoot: normalizeToPosix(projectPath),
    sessionScopeId,
    status: 'initialized_no_active_task',
    routeStatus: 'unproven',
    currentTask: null,
    sourceRefs: [
      normalizeToPosix(linkPath),
      normalizeToPosix(startupBundlePath),
    ],
    blockers: [
      'live_builder_route_missing',
      'live_oracle_route_missing',
    ],
    generatedAt,
  };

  return {
    version: PREREQUISITE_CONTRACT_VERSION,
    roomId: TRUSTQUOTE_ROOM_ID,
    profile: TRUSTQUOTE_ROOM_ID,
    projectPath: normalizeToPosix(projectPath),
    squidrunRoot: normalizeToPosix(squidrunRoot),
    mainSessionScopeId,
    sessionScopeId,
    paths: {
      profileRootConfigPath: normalizeToPosix(profileRootConfigPath),
      linkPath: normalizeToPosix(linkPath),
      agentsPath: normalizeToPosix(agentsPath),
      rolesPath: normalizeToPosix(rolesPath),
      startupBundlePath: normalizeToPosix(startupBundlePath),
      workstreamPath: normalizeToPosix(workstreamPath),
    },
    profileRootContract,
    link,
    startupSources: {
      agents: buildGeneratedAgentsSource({ projectPath, sessionScopeId, generatedAt }),
      roles: buildGeneratedRolesSource({ sessionScopeId }),
    },
    startupBundle: buildStartupBundle({
      projectPath,
      linkPath,
      agentsPath,
      rolesPath,
      startupBundlePath,
      sessionScopeId,
      generatedAt,
    }),
    workstream,
  };
}

function writeTextIfChanged(filePath, text, write) {
  const normalizedText = `${String(text || '').replace(/\s*$/u, '')}\n`;
  if (!write) return { path: normalizeToPosix(filePath), status: 'dry_run' };
  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  if (previous === normalizedText) return { path: normalizeToPosix(filePath), status: 'unchanged' };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, normalizedText, 'utf8');
  return { path: normalizeToPosix(filePath), status: previous === null ? 'created' : 'updated' };
}

function writeJsonIfChanged(filePath, payload, write) {
  return writeTextIfChanged(filePath, JSON.stringify(payload, null, 2), write);
}

function isSameTrustQuoteWorkstreamScope(existing, next) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false;
  if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
  return toText(existing.version, '') === TRUSTQUOTE_WORKSTREAM_VERSION
    && toText(existing.roomId, '') === TRUSTQUOTE_ROOM_ID
    && toText(existing.profile, '') === TRUSTQUOTE_ROOM_ID
    && normalizeToPosix(existing.projectRoot || existing.workspace) === normalizeToPosix(next.projectRoot || next.workspace)
    && toText(existing.sessionScopeId || existing.session_id, '') === toText(next.sessionScopeId || next.session_id, '');
}

function isProvenTrustQuoteWorkstream(existing, next) {
  return isSameTrustQuoteWorkstreamScope(existing, next)
    && toText(existing.routeStatus, '').toLowerCase() === 'proven'
    && Array.isArray(existing.blockers)
    && existing.blockers.length === 0;
}

function writeWorkstreamIfChanged(filePath, payload, write) {
  if (write && fs.existsSync(filePath)) {
    const existing = readJsonFile(filePath);
    if (isProvenTrustQuoteWorkstream(existing, payload)) {
      return { path: normalizeToPosix(filePath), status: 'preserved_proven' };
    }
  }
  return writeJsonIfChanged(filePath, payload, write);
}

function materializeTrustQuoteWorkRoomPrerequisites(options = {}) {
  const write = options.write === true;
  const artifacts = buildTrustQuoteWorkRoomPrerequisiteArtifacts(options);
  const results = [
    {
      kind: 'profile_root_contract',
      ...writeJsonIfChanged(artifacts.paths.profileRootConfigPath, artifacts.profileRootContract, write),
    },
    {
      kind: 'profile_link',
      ...writeJsonIfChanged(artifacts.paths.linkPath, artifacts.link, write),
    },
    {
      kind: 'startup_source_agents',
      ...writeTextIfChanged(artifacts.paths.agentsPath, artifacts.startupSources.agents, write),
    },
    {
      kind: 'startup_source_roles',
      ...writeTextIfChanged(artifacts.paths.rolesPath, artifacts.startupSources.roles, write),
    },
    {
      kind: 'startup_bundle',
      ...writeTextIfChanged(artifacts.paths.startupBundlePath, artifacts.startupBundle, write),
    },
    {
      kind: 'workstream',
      ...writeWorkstreamIfChanged(artifacts.paths.workstreamPath, artifacts.workstream, write),
    },
  ];

  return {
    ok: true,
    write,
    artifacts,
    results,
  };
}

module.exports = {
  GENERATED_STARTUP_SOURCE_VERSION,
  PREREQUISITE_CONTRACT_VERSION,
  buildTrustQuoteWorkRoomPrerequisiteArtifacts,
  materializeTrustQuoteWorkRoomPrerequisites,
  resolveMainSessionScopeId,
};
