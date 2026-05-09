#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getProjectRoot } = require('../config');
const { DEFAULT_PROFILE, namespaceCoordRelPath, normalizeProfileName } = require('../profile');
const { readSystemCapabilitiesSnapshot } = require('../modules/local-model-capabilities');

const KEY_MODULE_PATHS = Object.freeze({
  recovery_manager: path.join('ui', 'modules', 'recovery-manager.js'),
  background_agent_manager: path.join('ui', 'modules', 'main', 'background-agent-manager.js'),
  scheduler: path.join('ui', 'modules', 'scheduler.js'),
  evidence_ledger_memory: path.join('ui', 'modules', 'main', 'evidence-ledger-memory.js'),
  supervisor_daemon: path.join('ui', 'supervisor-daemon.js'),
  supervisor_store: path.join('ui', 'modules', 'supervisor', 'store.js'),
});

/**
 * Startup health scoring contract.
 *
 * The model is intentionally additive and conservative:
 * - Start at 100.
 * - Subtract explicit penalties for independent health findings.
 * - Map the resulting score through shared thresholds so another probe can be
 *   added without inventing a new interpretation layer.
 *
 * Extension rule for new probes:
 * 1. Add a penalty entry here with a short rationale.
 * 2. Reuse an existing severity band when possible:
 *    5-10 = observability or confidence issue
 *    10-15 = operator-actionable degradation
 *    20+ = structural or likely service-breaking problem
 * 3. Emit a stable warning code and apply the named penalty from
 *    `buildHealthStatus()` instead of open-coded score math.
 */
const HEALTH_SCORE_THRESHOLDS = Object.freeze([
  Object.freeze({ minScore: 95, level: 'ok', label: 'OK', description: 'Healthy; no material action required.' }),
  Object.freeze({ minScore: 80, level: 'warn', label: 'WARN', description: 'Attention needed, but the system remains operational.' }),
  Object.freeze({ minScore: 60, level: 'degraded', label: 'DEGRADED', description: 'Multiple or meaningful issues are affecting trust or operability.' }),
  Object.freeze({ minScore: 0, level: 'critical', label: 'CRITICAL', description: 'Health contract is materially broken and needs immediate intervention.' }),
]);

const HEALTH_SCORE_PENALTIES = Object.freeze({
  jest_list_failed: Object.freeze({
    points: 8,
    category: 'foundation',
    rationale: 'Test discovery failed, reducing confidence in startup inventory.',
  }),
  no_test_files_detected: Object.freeze({
    points: 15,
    category: 'foundation',
    rationale: 'No discovered tests means health evidence is materially incomplete.',
  }),
  missing_key_modules: Object.freeze({
    pointsPerItem: 4,
    maxPoints: 20,
    category: 'foundation',
    rationale: 'Missing runtime modules indicate codebase integrity drift.',
  }),
  database_missing: Object.freeze({
    points: 20,
    category: 'foundation',
    rationale: 'A missing core database is structural, not cosmetic.',
  }),
  database_error: Object.freeze({
    points: 12,
    category: 'foundation',
    rationale: 'A present-but-unreadable database weakens trust in the snapshot.',
  }),
  database_empty: Object.freeze({
    points: 6,
    category: 'foundation',
    rationale: 'An empty core database may be expected in edge cases, but should still be visible.',
  }),
  bridge_enabled_unconfigured: Object.freeze({
    points: 20,
    category: 'bridge',
    rationale: 'Bridge is expected to run but lacks usable configuration.',
  }),
  bridge_enabled_not_connected: Object.freeze({
    points: 15,
    category: 'bridge',
    rationale: 'Bridge is enabled and configured, so a disconnect is an operator-actionable degradation.',
  }),
  memory_consistency_drift: Object.freeze({
    points: 12,
    category: 'memory_consistency',
    rationale: 'Confirmed drift reduces retrieval trust and should be corrected promptly.',
  }),
  memory_consistency_unsynced: Object.freeze({
    points: 10,
    category: 'memory_consistency',
    rationale: 'If consistency cannot be confirmed, health visibility is degraded even without confirmed drift.',
  }),
});

const BRIDGE_ENV_KEYS = Object.freeze([
  'SQUIDRUN_CROSS_DEVICE',
  'SQUIDRUN_DEVICE_ID',
  'SQUIDRUN_RELAY_URL',
  'SQUIDRUN_RELAY_SECRET',
  'SQUIDRUN_PROFILE',
]);
const DEFAULT_BRIDGE_DISCOVERY_MAX_AGE_MS = 10 * 60 * 1000;
const MEMORY_CONSISTENCY_REVIEW_SKIP_KIND_ALLOWLIST = Object.freeze([
  'ambiguous_multi_target',
  'deleted_source_orphan',
  'deleted_source_review',
  'mapping_required',
  'relational_migration_required',
  'revision_skew_review_required',
]);

let SQLITE_DRIVER = undefined;
let resolveDefaultCognitiveMemoryDbPathFn = null;
let runMemoryConsistencyCheckFn = null;
let planMemoryConsistencyRepairFn = null;

function getResolveDefaultCognitiveMemoryDbPath() {
  if (!resolveDefaultCognitiveMemoryDbPathFn) {
    ({ resolveDefaultCognitiveMemoryDbPath: resolveDefaultCognitiveMemoryDbPathFn } = require('../modules/cognitive-memory-store'));
  }
  return resolveDefaultCognitiveMemoryDbPathFn;
}

function getRunMemoryConsistencyCheck() {
  if (!runMemoryConsistencyCheckFn) {
    ({ runMemoryConsistencyCheck: runMemoryConsistencyCheckFn } = require('../modules/memory-consistency-check'));
  }
  return runMemoryConsistencyCheckFn;
}

function getPlanMemoryConsistencyRepair() {
  if (!planMemoryConsistencyRepairFn) {
    ({ planMemoryConsistencyRepair: planMemoryConsistencyRepairFn } = require('../modules/memory-consistency-check'));
  }
  return planMemoryConsistencyRepairFn;
}

function asPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isProjectRoot(rootPath) {
  const uiDir = safeStat(path.join(rootPath, 'ui'));
  const uiPackage = safeStat(path.join(rootPath, 'ui', 'package.json'));
  return Boolean(uiDir?.isDirectory() && uiPackage?.isFile());
}

function isUiRoot(rootPath) {
  const packageJson = safeStat(path.join(rootPath, 'package.json'));
  const testsDir = safeStat(path.join(rootPath, '__tests__'));
  const modulesDir = safeStat(path.join(rootPath, 'modules'));
  return Boolean(
    packageJson?.isFile()
    && testsDir?.isDirectory()
    && modulesDir?.isDirectory()
  );
}

function normalizeProjectRoot(projectRoot) {
  const resolved = path.resolve(String(projectRoot || getProjectRoot() || process.cwd()));
  if (isProjectRoot(resolved)) {
    return resolved;
  }

  if (path.basename(resolved).toLowerCase() === 'ui' && isUiRoot(resolved)) {
    const parent = path.dirname(resolved);
    if (isProjectRoot(parent)) {
      return parent;
    }
  }

  if (path.basename(resolved).toLowerCase() === '.squidrun') {
    const parent = path.dirname(resolved);
    if (isProjectRoot(parent)) {
      return parent;
    }
  }

  return resolved;
}

function resolveWindowsCmdPath(env = process.env) {
  const candidates = [
    env.ComSpec,
    env.COMSPEC,
    env.SystemRoot ? path.join(env.SystemRoot, 'System32', 'cmd.exe') : null,
    env.WINDIR ? path.join(env.WINDIR, 'System32', 'cmd.exe') : null,
    'cmd.exe',
  ].filter(Boolean);

  return candidates.find((candidate) => {
    if (candidate.toLowerCase() === 'cmd.exe') {
      return true;
    }
    return safeStat(candidate)?.isFile() === true;
  }) || 'cmd.exe';
}

function loadSqliteDriver() {
  if (SQLITE_DRIVER !== undefined) {
    return SQLITE_DRIVER;
  }

  try {
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') {
      SQLITE_DRIVER = {
        name: 'node:sqlite',
        create: (filename, options = {}) => new mod.DatabaseSync(filename, options),
      };
      return SQLITE_DRIVER;
    }
  } catch {
    // Fall through to native addon fallback for Electron's Node runtime.
  }

  try {
    const BetterSqlite3 = require('better-sqlite3');
    SQLITE_DRIVER = {
      name: 'better-sqlite3',
      create: (filename, options = {}) => new BetterSqlite3(filename, options),
    };
    return SQLITE_DRIVER;
  } catch {
    SQLITE_DRIVER = null;
    return SQLITE_DRIVER;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isFiniteNumberValue(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function normalizeBridgeDeviceId(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  return normalized || null;
}

function normalizeBridgeRoles(input) {
  if (!Array.isArray(input)) return [];
  const roles = new Set();
  for (const value of input) {
    const role = String(value || '').trim().toLowerCase();
    if (role) roles.add(role);
  }
  return Array.from(roles).sort();
}

function envFlagTruthy(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}

function parseEnvFile(envPath) {
  if (!safeStat(envPath)?.isFile()) return {};
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const env = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex <= 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      if (!key) continue;
      env[key] = trimmed.slice(eqIndex + 1).replace(/^['"]|['"]$/g, '');
    }
    return env;
  } catch {
    return {};
  }
}

function readEffectiveProjectEnv(projectRoot, runtimeEnv = process.env) {
  const envMap = parseEnvFile(path.join(projectRoot, '.env'));
  for (const key of BRIDGE_ENV_KEYS) {
    if (typeof runtimeEnv?.[key] === 'string') {
      envMap[key] = runtimeEnv[key];
    }
  }
  return envMap;
}

function normalizeBridgeDiscoveryDevice(input = {}) {
  const entry = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : {};
  const deviceId = normalizeBridgeDeviceId(entry.device_id || entry.deviceId || entry.id);
  if (!deviceId) return null;
  return {
    device_id: deviceId,
    roles: normalizeBridgeRoles(entry.roles),
    connected_since: asNonEmptyString(entry.connected_since || entry.connectedSince || entry.connected_at || entry.connectedAt),
  };
}

function normalizeBridgeDiscoveryDevices(input) {
  if (!Array.isArray(input)) return [];
  const devices = new Map();
  for (const entry of input) {
    const device = normalizeBridgeDiscoveryDevice(entry);
    if (!device) continue;
    devices.set(device.device_id, device);
  }
  return Array.from(devices.values()).sort((a, b) => a.device_id.localeCompare(b.device_id));
}

function readBridgeKnownDevicesCache(projectRoot, options = {}) {
  const cachePath = options.bridgeKnownDevicesPath
    ? path.resolve(String(options.bridgeKnownDevicesPath))
    : path.join(projectRoot, '.squidrun', 'bridge', 'known-devices.json');
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
  const maxAgeMs = Number.isFinite(Number(options.bridgeDiscoveryMaxAgeMs))
    ? Math.max(0, Math.floor(Number(options.bridgeDiscoveryMaxAgeMs)))
    : DEFAULT_BRIDGE_DISCOVERY_MAX_AGE_MS;

  if (!safeStat(cachePath)?.isFile()) {
    return {
      ok: false,
      path: cachePath,
      status: 'missing',
      error: null,
      updatedAt: null,
      ageMs: null,
      maxAgeMs,
      devices: [],
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const updatedAt = asNonEmptyString(parsed.updated_at || parsed.updatedAt);
    const updatedAtMs = updatedAt ? Date.parse(updatedAt) : NaN;
    const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, nowMs - updatedAtMs) : null;
    const devices = normalizeBridgeDiscoveryDevices(parsed.devices);
    const fresh = ageMs !== null && ageMs <= maxAgeMs;
    return {
      ok: fresh,
      path: cachePath,
      status: fresh ? 'fresh' : (ageMs === null ? 'invalid_timestamp' : 'stale'),
      error: null,
      updatedAt,
      ageMs,
      maxAgeMs,
      source: asNonEmptyString(parsed.source) || 'unknown',
      devices,
    };
  } catch (err) {
    return {
      ok: false,
      path: cachePath,
      status: 'read_error',
      error: err.message,
      updatedAt: null,
      ageMs: null,
      maxAgeMs,
      devices: [],
    };
  }
}

function walkFiles(rootPath, predicate = null, results = []) {
  const stat = safeStat(rootPath);
  if (!stat) return results;
  if (stat.isFile()) {
    if (!predicate || predicate(rootPath, stat)) {
      results.push(rootPath);
    }
    return results;
  }

  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    walkFiles(path.join(rootPath, entry.name), predicate, results);
  }
  return results;
}

function countTestFiles(testRoot) {
  const files = walkFiles(testRoot, (filePath) => /\.test\.[cm]?js$/i.test(filePath));
  return {
    root: testRoot,
    count: files.length,
    files,
  };
}

function listJestTests(projectRoot, timeoutMs = 30000) {
  const windowsCmd = resolveWindowsCmdPath();
  const localJestBin = path.join(projectRoot, 'node_modules', 'jest', 'bin', 'jest.js');
  const useLocalJestBin = safeStat(localJestBin)?.isFile() === true;
  const command = useLocalJestBin
    ? `${process.execPath} ${localJestBin} --listTests`
    : (process.platform === 'win32'
      ? `${windowsCmd} /d /s /c "npx jest --listTests"`
      : 'npx jest --listTests');
  try {
    const stdout = useLocalJestBin
      ? execFileSync(process.execPath, [localJestBin, '--listTests'], {
          cwd: projectRoot,
          encoding: 'utf8',
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
        })
      : (process.platform === 'win32'
      ? execFileSync(windowsCmd, ['/d', '/s', '/c', 'npx jest --listTests'], {
          cwd: projectRoot,
          encoding: 'utf8',
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        })
      : execFileSync('npx', ['jest', '--listTests'], {
          cwd: projectRoot,
          encoding: 'utf8',
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        }));
    const files = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      ok: true,
      command,
      count: files.length,
      files,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      command,
      count: 0,
      files: [],
      error: err.message,
    };
  }
}

function countModuleFiles(modulesRoot) {
  const files = walkFiles(modulesRoot, (filePath) => /\.[cm]?js$/i.test(filePath));
  return {
    root: modulesRoot,
    count: files.length,
    files,
  };
}

function resolveProfileCoordPath(projectRoot, relPath, profileName = DEFAULT_PROFILE) {
  const profile = normalizeProfileName(profileName || DEFAULT_PROFILE);
  return path.join(projectRoot, '.squidrun', namespaceCoordRelPath(relPath, profile));
}

function readAppStatusSnapshot(projectRoot, options = {}) {
  const profileName = normalizeProfileName(options.profileName || DEFAULT_PROFILE);
  const appStatusPath = resolveProfileCoordPath(projectRoot, 'app-status.json', profileName);
  const stat = safeStat(appStatusPath);
  if (!stat || !stat.isFile()) {
    return {
      path: appStatusPath,
      exists: false,
      sessionNumber: null,
      sessionId: null,
      error: null,
    };
  }

  try {
    const raw = fs.readFileSync(appStatusPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      path: appStatusPath,
      exists: true,
      sessionNumber: asPositiveInt(
        parsed?.session ?? parsed?.session_number ?? parsed?.sessionNumber,
        null
      ),
      sessionId: typeof parsed?.session_id === 'string'
        ? parsed.session_id.trim() || null
        : (typeof parsed?.sessionId === 'string' ? parsed.sessionId.trim() || null : null),
      error: null,
    };
  } catch (err) {
    return {
      path: appStatusPath,
      exists: true,
      sessionNumber: null,
      sessionId: null,
      error: err.message,
    };
  }
}

function collectKeyModules(projectRoot) {
  const modules = {};
  for (const [key, relPath] of Object.entries(KEY_MODULE_PATHS)) {
    const absPath = path.join(projectRoot, relPath);
    modules[key] = {
      path: relPath.replace(/\\/g, '/'),
      exists: fs.existsSync(absPath),
    };
  }
  return modules;
}

function quoteSqlIdentifier(identifier) {
  return `"${String(identifier || '').replace(/"/g, '""')}"`;
}

function inspectSqliteDb(dbPath, tableCandidates = []) {
  const stat = safeStat(dbPath);
  if (!stat || !stat.isFile()) {
    return {
      path: dbPath,
      exists: false,
      sizeBytes: 0,
      tables: [],
      primaryTable: null,
      rowCount: 0,
      error: null,
    };
  }

  let db = null;
  try {
    const driver = loadSqliteDriver();
    if (!driver) {
      return {
        path: dbPath,
        exists: true,
        sizeBytes: stat.size,
        tables: [],
        primaryTable: null,
        rowCount: 0,
        error: 'sqlite_driver_unavailable',
      };
    }
    db = driver.create(dbPath, { readonly: true });
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => String(row.name || ''));
    const preferredTable = tableCandidates.find((candidate) => tables.includes(candidate)) || tables[0] || null;
    let rowCount = 0;
    if (preferredTable) {
      const query = `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(preferredTable)}`;
      rowCount = Number(db.prepare(query).get()?.count || 0);
    }
    return {
      path: dbPath,
      exists: true,
      sizeBytes: stat.size,
      tables,
      primaryTable: preferredTable,
      rowCount,
      error: null,
    };
  } catch (err) {
    return {
      path: dbPath,
      exists: true,
      sizeBytes: stat.size,
      tables: [],
      primaryTable: null,
      rowCount: 0,
      error: err.message,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // best effort
    }
  }
}

function normalizeBridgeSnapshot(bridgeStatus = null) {
  const source = bridgeStatus && typeof bridgeStatus === 'object' && !Array.isArray(bridgeStatus)
    ? bridgeStatus
    : {};
  const relayUrl = typeof source.relayUrl === 'string' && source.relayUrl.trim()
    ? source.relayUrl.trim()
    : null;
  const deviceId = typeof source.deviceId === 'string' && source.deviceId.trim()
    ? source.deviceId.trim()
    : null;
  const state = typeof source.state === 'string' && source.state.trim()
    ? source.state.trim()
    : null;
  const status = typeof source.status === 'string' && source.status.trim()
    ? source.status.trim()
    : null;
  const enabled = source.enabled === true;
  const configured = source.configured === true || Boolean(relayUrl && deviceId);
  const requestedMode = typeof source.mode === 'string' && source.mode.trim()
    ? source.mode.trim().toLowerCase()
    : null;
  const pending = source.pending === true
    || requestedMode === 'pending'
    || state === 'pending_live_discovery'
    || status === 'pending_live_discovery';
  const mode = enabled !== true
    ? 'disabled'
    : (pending
      ? 'pending'
      : ((state === 'connected' || status === 'relay_connected' || requestedMode === 'connected')
      ? 'connected'
      : 'connecting'));

  return {
    enabled,
    configured,
    mode,
    running: source.running === true,
    relayUrl,
    deviceId,
    state,
    status,
    pending,
    lowFidelity: source.lowFidelity === true,
    discoveredRoles: normalizeBridgeRoles(source.discoveredRoles || source.roles),
    architectRoleDiscovery: source.architectRoleDiscovery === 'registered' ? 'registered' : 'unknown',
    liveDiscovery: source.liveDiscovery && typeof source.liveDiscovery === 'object' && !Array.isArray(source.liveDiscovery)
      ? source.liveDiscovery
      : null,
  };
}

function applyBridgeDiscoveryToSnapshot(snapshot = {}, discovery = {}, options = {}) {
  const bridge = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? { ...snapshot }
    : {};
  const cache = discovery && typeof discovery === 'object' && !Array.isArray(discovery)
    ? discovery
    : {};
  const targetDeviceId = normalizeBridgeDeviceId(bridge.deviceId);
  const devices = normalizeBridgeDiscoveryDevices(cache.devices);
  const matched = targetDeviceId
    ? devices.find((device) => device.device_id === targetDeviceId)
    : null;
  const roles = matched ? normalizeBridgeRoles(matched.roles) : [];
  const architectOnline = cache.ok === true && Boolean(matched) && roles.includes('architect');
  const liveDiscovery = {
    ok: architectOnline,
    source: 'known-devices-cache',
    status: architectOnline
      ? 'architect_online'
      : (cache.status || (cache.ok === true ? 'no_matching_architect' : 'unavailable')),
    path: cache.path || null,
    updatedAt: cache.updatedAt || null,
    ageMs: isFiniteNumberValue(cache.ageMs) ? Number(cache.ageMs) : null,
    maxAgeMs: isFiniteNumberValue(cache.maxAgeMs) ? Number(cache.maxAgeMs) : DEFAULT_BRIDGE_DISCOVERY_MAX_AGE_MS,
    deviceId: targetDeviceId,
    matchedDeviceId: matched?.device_id || null,
    roles,
    error: cache.error || null,
  };

  const allowUpgrade = options.allowUpgrade !== false;
  if (!architectOnline || !allowUpgrade) {
    return {
      ...bridge,
      liveDiscovery,
    };
  }

  return {
    ...bridge,
    mode: 'connected',
    state: 'connected',
    status: 'relay_connected',
    pending: false,
    lowFidelity: false,
    discoveredRoles: roles,
    architectRoleDiscovery: 'registered',
    liveDiscovery,
  };
}

function buildBridgeSnapshotFromEnv(projectRoot, runtimeEnv = process.env) {
  const envMap = readEffectiveProjectEnv(projectRoot, runtimeEnv);
  const relayUrl = asNonEmptyString(envMap.SQUIDRUN_RELAY_URL);
  const deviceId = asNonEmptyString(envMap.SQUIDRUN_DEVICE_ID);
  const enabled = envFlagTruthy(envMap.SQUIDRUN_CROSS_DEVICE);
  return normalizeBridgeSnapshot({
    enabled,
    configured: Boolean(relayUrl && deviceId),
    relayUrl,
    deviceId,
    state: enabled && relayUrl && deviceId ? 'pending_live_discovery' : (enabled ? 'unknown' : null),
    mode: enabled && relayUrl && deviceId ? 'pending' : null,
    pending: Boolean(enabled && relayUrl && deviceId),
    lowFidelity: true,
  });
}

function resolveBridgeSnapshot(projectRoot, options = {}) {
  const hasExplicitBridgeStatus = options.bridgeStatus && typeof options.bridgeStatus === 'object' && !Array.isArray(options.bridgeStatus);
  const baseSnapshot = hasExplicitBridgeStatus
    ? normalizeBridgeSnapshot(options.bridgeStatus)
    : buildBridgeSnapshotFromEnv(projectRoot, options.env || process.env);
  const discovery = options.bridgeDiscovery && typeof options.bridgeDiscovery === 'object' && !Array.isArray(options.bridgeDiscovery)
    ? options.bridgeDiscovery
    : readBridgeKnownDevicesCache(projectRoot, options);
  return applyBridgeDiscoveryToSnapshot(baseSnapshot, discovery, {
    allowUpgrade: !hasExplicitBridgeStatus,
  });
}

function summarizeMemoryConsistency(result = null) {
  const source = result && typeof result === 'object' && !Array.isArray(result)
    ? result
    : {};
  const summary = source.summary && typeof source.summary === 'object' && !Array.isArray(source.summary)
    ? source.summary
    : {};
  const summarized = {
    checkedAt: typeof source.checkedAt === 'string' ? source.checkedAt : null,
    status: typeof source.status === 'string' && source.status.trim() ? source.status.trim() : 'unknown',
    synced: source.synced === true,
    error: typeof source.error === 'string' && source.error.trim() ? source.error.trim() : null,
    summary: {
      knowledgeEntryCount: Number(summary.knowledgeEntryCount || 0),
      knowledgeNodeCount: Number(summary.knowledgeNodeCount || 0),
      missingInCognitiveCount: Number(summary.missingInCognitiveCount || 0),
      orphanedNodeCount: Number(summary.orphanedNodeCount || 0),
      duplicateKnowledgeHashCount: Number(summary.duplicateKnowledgeHashCount || 0),
      issueCount: Number(summary.issueCount || 0),
    },
  };
  const repairPlan = summarizeMemoryConsistencyRepairPlan(source.repairPlan || source.dryRunRepair || null);
  if (repairPlan) {
    summarized.repairPlan = repairPlan;
  }
  return summarized;
}

function summarizeItemsByKey(items = [], key) {
  if (!Array.isArray(items)) return {};
  return items.reduce((acc, item) => {
    const value = item && typeof item === 'object'
      ? String(item[key] || '').trim()
      : '';
    const bucket = value || 'unknown';
    acc[bucket] = Number(acc[bucket] || 0) + 1;
    return acc;
  }, {});
}

function summarizeMemoryConsistencyRepairPlan(plan = null) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const summary = plan.summary && typeof plan.summary === 'object' && !Array.isArray(plan.summary)
    ? plan.summary
    : plan;
  return {
    mode: typeof plan.mode === 'string' && plan.mode.trim() ? plan.mode.trim() : null,
    dryRun: plan.dryRun === true || plan.mode === 'dry_run',
    actionCount: Number(summary.actionCount || 0),
    insertCount: Number(summary.insertCount || 0),
    duplicateMergeCount: Number(summary.duplicateMergeCount || 0),
    orphanDeleteCount: Number(summary.orphanDeleteCount || 0),
    deleteCount: Number(summary.deleteCount || 0),
    skippedCount: Number(summary.skippedCount || 0),
    deferredActionCount: Number(summary.deferredActionCount || 0),
    deferredSkippedCount: Number(summary.deferredSkippedCount || 0),
    skippedByKind: plan.skippedByKind && typeof plan.skippedByKind === 'object' && !Array.isArray(plan.skippedByKind)
      ? { ...plan.skippedByKind }
      : summarizeItemsByKey(plan.skipped, 'kind'),
    skippedByDriftType: plan.skippedByDriftType && typeof plan.skippedByDriftType === 'object' && !Array.isArray(plan.skippedByDriftType)
      ? { ...plan.skippedByDriftType }
      : summarizeItemsByKey(plan.skipped, 'driftType'),
    error: typeof plan.error === 'string' && plan.error.trim() ? plan.error.trim() : null,
  };
}

function resolveHealthThreshold(score) {
  const normalizedScore = Math.max(0, Math.min(100, Number(score) || 0));
  return HEALTH_SCORE_THRESHOLDS.find((entry) => normalizedScore >= entry.minScore) || HEALTH_SCORE_THRESHOLDS[HEALTH_SCORE_THRESHOLDS.length - 1];
}

function getPenaltyPoints(ruleName, options = {}) {
  const rule = HEALTH_SCORE_PENALTIES[ruleName];
  if (!rule) return 0;
  if (Number.isFinite(Number(rule.points))) {
    return Math.max(0, Number(rule.points));
  }
  if (Number.isFinite(Number(rule.pointsPerItem))) {
    const count = Math.max(0, Number(options.count) || 0);
    const raw = count * Number(rule.pointsPerItem);
    const maxPoints = Number.isFinite(Number(rule.maxPoints)) ? Number(rule.maxPoints) : raw;
    return Math.max(0, Math.min(raw, maxPoints));
  }
  return 0;
}

function inspectMemoryConsistency(projectRoot, options = {}) {
  if (options.memoryConsistency && typeof options.memoryConsistency === 'object') {
    return summarizeMemoryConsistency(options.memoryConsistency);
  }

  try {
    const checkOptions = {
      projectRoot,
      profileName: normalizeProfileName(options.profileName || DEFAULT_PROFILE),
      sampleLimit: Number.isFinite(Number(options.memoryConsistencySampleLimit))
        ? Number(options.memoryConsistencySampleLimit)
        : 5,
    };
    const check = getRunMemoryConsistencyCheck()(checkOptions);
    if (check?.status !== 'drift_detected') {
      return summarizeMemoryConsistency(check);
    }

    try {
      const repairPlan = getPlanMemoryConsistencyRepair()(checkOptions);
      return summarizeMemoryConsistency({
        ...check,
        repairPlan,
      });
    } catch (err) {
      return summarizeMemoryConsistency({
        ...check,
        repairPlan: {
          error: err.message,
          summary: {
            actionCount: 0,
            skippedCount: 0,
          },
        },
      });
    }
  } catch (err) {
    return summarizeMemoryConsistency({
      status: 'check_failed',
      synced: false,
      error: err.message,
      summary: {},
    });
  }
}

function inspectSystemCapabilities(projectRoot, options = {}) {
  if (options.systemCapabilities && typeof options.systemCapabilities === 'object') {
    return options.systemCapabilities;
  }
  return readSystemCapabilitiesSnapshot(projectRoot) || {
    generatedAt: null,
    localModels: {
      enabled: false,
      sleepExtraction: {
        enabled: false,
        available: false,
        model: null,
        path: 'fallback',
        reason: 'not_detected',
      },
    },
  };
}

function hasMemoryConsistencyCheckFailure(memoryConsistency = {}) {
  const status = String(memoryConsistency.status || '').trim();
  if (memoryConsistency.error) return true;
  if (memoryConsistency.repairPlan?.error) return true;
  if (!status || status === 'unknown') return memoryConsistency.synced === false;
  if (status === 'in_sync' || status === 'drift_detected') return false;
  return memoryConsistency.synced === false;
}

function positiveCountEntries(counts = {}) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return [];
  return Object.entries(counts)
    .map(([key, count]) => [String(key || '').trim(), Number(count || 0)])
    .filter(([key, count]) => key && count > 0);
}

function countEntriesTotal(entries = []) {
  return entries.reduce((sum, [, count]) => sum + Number(count || 0), 0);
}

function hasOnlyKnownMemoryConsistencyReviewSkips(repairPlan = null) {
  if (!repairPlan || typeof repairPlan !== 'object' || Array.isArray(repairPlan)) return false;
  const skippedCount = Number(repairPlan.skippedCount || 0);
  if (skippedCount <= 0) return true;
  const kindEntries = positiveCountEntries(repairPlan.skippedByKind);
  const driftEntries = positiveCountEntries(repairPlan.skippedByDriftType);
  const entries = kindEntries.length > 0 ? kindEntries : driftEntries;
  if (entries.length === 0) return false;
  const allKnown = entries.every(([kind]) => MEMORY_CONSISTENCY_REVIEW_SKIP_KIND_ALLOWLIST.includes(kind));
  return allKnown && countEntriesTotal(entries) >= skippedCount;
}

function getMemoryConsistencyActionability(memoryConsistency = {}) {
  const summary = memoryConsistency.summary && typeof memoryConsistency.summary === 'object'
    ? memoryConsistency.summary
    : {};
  const repairPlan = memoryConsistency.repairPlan && typeof memoryConsistency.repairPlan === 'object'
    ? memoryConsistency.repairPlan
    : null;
  const missing = Number(summary.missingInCognitiveCount || 0);
  const orphans = Number(summary.orphanedNodeCount || 0);
  const duplicates = Number(summary.duplicateKnowledgeHashCount || 0);
  const issues = Number(summary.issueCount || 0);
  const actionCount = repairPlan ? Number(repairPlan.actionCount || 0) : 0;
  const skippedCount = repairPlan ? Number(repairPlan.skippedCount || 0) : 0;
  const checkFailure = hasMemoryConsistencyCheckFailure(memoryConsistency);
  const actionable = missing > 0
    || duplicates > 0
    || issues > 0
    || actionCount > 0;
  const knownReviewSkips = hasOnlyKnownMemoryConsistencyReviewSkips(repairPlan);
  const reviewOnly = memoryConsistency.status === 'drift_detected'
    && !checkFailure
    && !actionable
    && orphans > 0
    && repairPlan !== null
    && skippedCount >= orphans
    && knownReviewSkips;
  return {
    missing,
    orphans,
    duplicates,
    issues,
    actionCount,
    skippedCount,
    checkFailure,
    actionable,
    knownReviewSkips,
    reviewOnly,
  };
}

function buildHealthStatus(snapshot) {
  const warnings = [];
  const penalties = [];
  let score = 100;
  const addPenalty = (code, points = null, options = {}) => {
    const normalizedPoints = points === null ? getPenaltyPoints(code, options) : Math.max(0, Number(points) || 0);
    penalties.push({ code, points: normalizedPoints });
    score = Math.max(0, score - normalizedPoints);
  };
  if (!snapshot.tests.jestList.ok) {
    warnings.push(`jest_list_failed:${snapshot.tests.jestList.error || 'unknown'}`);
    addPenalty('jest_list_failed');
  }
  if (snapshot.tests.testFileCount <= 0) {
    warnings.push('no_test_files_detected');
    addPenalty('no_test_files_detected');
  }
  const missingKeyModules = Object.entries(snapshot.modules.keyModules)
    .filter(([, value]) => value.exists !== true)
    .map(([key]) => key);
  if (missingKeyModules.length > 0) {
    warnings.push(`missing_key_modules:${missingKeyModules.join(',')}`);
    addPenalty('missing_key_modules', null, { count: missingKeyModules.length });
  }
  for (const [key, db] of Object.entries(snapshot.databases)) {
    if (!db.exists) {
      warnings.push(`${key}_missing`);
      addPenalty('database_missing');
      continue;
    }
    if (db.error) {
      warnings.push(`${key}_error:${db.error}`);
      addPenalty('database_error');
      continue;
    }
    if (db.rowCount <= 0) {
      warnings.push(`${key}_empty`);
      addPenalty('database_empty');
    }
  }
  const bridge = snapshot.bridge && typeof snapshot.bridge === 'object' ? snapshot.bridge : {};
  if (bridge.enabled === true && bridge.configured !== true) {
    warnings.push('bridge_enabled_unconfigured');
    addPenalty('bridge_enabled_unconfigured');
  } else if (bridge.enabled === true && bridge.mode === 'pending') {
    warnings.push('bridge_connectivity_pending:live_discovery_not_available');
  } else if (bridge.enabled === true && bridge.mode !== 'connected') {
    warnings.push(`bridge_enabled_not_connected:${bridge.state || bridge.status || bridge.mode || 'unknown'}`);
    addPenalty('bridge_enabled_not_connected');
  }
  const memoryConsistency = snapshot.memoryConsistency && typeof snapshot.memoryConsistency === 'object'
    ? snapshot.memoryConsistency
    : {};
  const memoryActionability = getMemoryConsistencyActionability(memoryConsistency);
  if (memoryActionability.checkFailure) {
    warnings.push(`memory_consistency_${memoryConsistency.status || 'unknown'}`);
    addPenalty('memory_consistency_unsynced');
  } else if (memoryConsistency.status === 'drift_detected' && memoryActionability.actionable) {
    warnings.push(
      'memory_consistency_drift:'
      + `missing=${memoryActionability.missing},`
      + `orphans=${memoryActionability.orphans},`
      + `duplicates=${memoryActionability.duplicates},`
      + `actions=${memoryActionability.actionCount},`
      + `issues=${memoryActionability.issues}`
    );
    addPenalty('memory_consistency_drift');
  } else if (memoryConsistency.status === 'drift_detected' && memoryActionability.reviewOnly) {
    warnings.push(
      'memory_consistency_review_queue:'
      + `orphans=${memoryActionability.orphans},`
      + `actions=${memoryActionability.actionCount},`
      + `skips=${memoryActionability.skippedCount}`
    );
  } else if (memoryConsistency.status === 'drift_detected') {
    warnings.push(
      'memory_consistency_unclassified_drift:'
      + `missing=${memoryActionability.missing},`
      + `orphans=${memoryActionability.orphans},`
      + `duplicates=${memoryActionability.duplicates},`
      + `actions=${memoryActionability.actionCount},`
      + `issues=${memoryActionability.issues},`
      + `known_review_skips=${memoryActionability.knownReviewSkips ? 'yes' : 'no'}`
    );
    addPenalty('memory_consistency_unsynced');
  } else if (memoryConsistency.synced === false) {
    warnings.push(`memory_consistency_${memoryConsistency.status || 'unknown'}`);
    addPenalty('memory_consistency_unsynced');
  }
  const threshold = resolveHealthThreshold(score);
  return {
    level: threshold.level,
    label: threshold.label,
    score,
    warnings,
    penalties,
    threshold,
  };
}

function createHealthSnapshot(options = {}) {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const profileName = normalizeProfileName(options.profileName || DEFAULT_PROFILE);
  const uiRoot = path.join(projectRoot, 'ui');
  const testsRoot = path.join(projectRoot, 'ui', '__tests__');
  const modulesRoot = path.join(projectRoot, 'ui', 'modules');
  const evidenceLedgerDbPath = resolveProfileCoordPath(projectRoot, path.join('runtime', 'evidence-ledger.db'), profileName);
  const cognitiveMemoryDbPath = getResolveDefaultCognitiveMemoryDbPath()({ projectRoot, profileName });
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
  const generatedAt = typeof options.generatedAt === 'string' && options.generatedAt.trim()
    ? options.generatedAt.trim()
    : new Date(nowMs).toISOString();

  const testFiles = countTestFiles(testsRoot);
  const jestList = listJestTests(uiRoot, asPositiveInt(options.jestTimeoutMs, 30000));
  const moduleFiles = countModuleFiles(modulesRoot);
  const keyModules = collectKeyModules(projectRoot);
  const appStatus = readAppStatusSnapshot(projectRoot, { profileName });
  const databases = {
    evidenceLedger: inspectSqliteDb(evidenceLedgerDbPath, ['comms_journal', 'ledger_sessions', 'ledger_decisions']),
    cognitiveMemory: inspectSqliteDb(cognitiveMemoryDbPath, ['nodes', 'memory_pr_queue', 'edges']),
  };
  const bridge = resolveBridgeSnapshot(projectRoot, options);
  const memoryConsistency = inspectMemoryConsistency(projectRoot, { ...options, profileName });
  const systemCapabilities = inspectSystemCapabilities(projectRoot, options);

  const snapshot = {
    generatedAt,
    projectRoot,
    profileName,
    tests: {
      testsRoot,
      testFileCount: testFiles.count,
      jestList,
    },
    appStatus,
    modules: {
      modulesRoot,
      moduleFileCount: moduleFiles.count,
      keyModules,
    },
    databases,
    bridge,
    memoryConsistency,
    systemCapabilities,
  };

  return {
    ...snapshot,
    status: buildHealthStatus(snapshot),
  };
}

function renderStartupHealthMarkdown(snapshot = {}) {
  const overallLevel = String(snapshot.status?.label || snapshot.status?.level || 'unknown').toUpperCase();
  const overallScore = Number.isFinite(Number(snapshot.status?.score)) ? Number(snapshot.status.score) : null;
  const lines = [
    'STARTUP HEALTH',
    `- Overall: ${overallLevel}${overallScore !== null ? ` (score=${overallScore}/100)` : ''}`,
    `- Generated: ${typeof snapshot.generatedAt === 'string' && snapshot.generatedAt.trim() ? snapshot.generatedAt.trim() : 'unknown'}`,
    `- Profile: ${normalizeProfileName(snapshot.profileName || DEFAULT_PROFILE)}`,
    `- App Session: ${Number.isInteger(Number(snapshot.appStatus?.sessionNumber)) ? `session ${Number(snapshot.appStatus.sessionNumber)}` : 'unknown'}${snapshot.appStatus?.error ? ` (app-status error: ${snapshot.appStatus.error})` : ''}`,
    `- Tests: ${Number(snapshot.tests?.testFileCount || 0)} files, ${Number(snapshot.tests?.jestList?.count || 0)} Jest-discoverable suites${snapshot.tests?.jestList?.ok === false ? ' (list failed)' : ''}`,
    `- Modules: ${Number(snapshot.modules?.moduleFileCount || 0)} JS modules under ui/modules`,
  ];

  const keyModules = snapshot.modules?.keyModules || {};
  const presentModules = Object.entries(keyModules)
    .filter(([, value]) => value && value.exists === true)
    .map(([key]) => key.replace(/_/g, '-'));
  if (presentModules.length > 0) {
    lines.push(`- Key runtime modules: ${presentModules.join(', ')}`);
  }

  const evidenceLedger = snapshot.databases?.evidenceLedger || {};
  const cognitiveMemory = snapshot.databases?.cognitiveMemory || {};
  lines.push(`- Evidence ledger DB: ${evidenceLedger.exists ? `present, rows=${Number(evidenceLedger.rowCount || 0)}` : 'missing'}`);
  lines.push(`- Cognitive memory DB: ${cognitiveMemory.exists ? `present, rows=${Number(cognitiveMemory.rowCount || 0)}` : 'missing'}`);

  const memoryConsistency = snapshot.memoryConsistency && typeof snapshot.memoryConsistency === 'object'
    ? snapshot.memoryConsistency
    : {};
  lines.push('');
  lines.push('MEMORY CONSISTENCY');
  lines.push(`- Sync Status: ${memoryConsistency.status || 'unknown'} (${memoryConsistency.synced === true ? 'in sync' : 'attention needed'})`);
  lines.push(
    '- Counts: '
    + `entries=${Number(memoryConsistency.summary?.knowledgeEntryCount || 0)}, `
    + `nodes=${Number(memoryConsistency.summary?.knowledgeNodeCount || 0)}, `
    + `missing=${Number(memoryConsistency.summary?.missingInCognitiveCount || 0)}, `
    + `orphans=${Number(memoryConsistency.summary?.orphanedNodeCount || 0)}, `
    + `duplicates=${Number(memoryConsistency.summary?.duplicateKnowledgeHashCount || 0)}`
  );
  if (memoryConsistency.error) {
    lines.push(`- Error: ${memoryConsistency.error}`);
  }
  if (memoryConsistency.repairPlan && typeof memoryConsistency.repairPlan === 'object') {
    const plan = memoryConsistency.repairPlan;
    lines.push(
      '- Review Queue: '
      + `actions=${Number(plan.actionCount || 0)}, `
      + `skips=${Number(plan.skippedCount || 0)}, `
      + `insert=${Number(plan.insertCount || 0)}, `
      + `merge=${Number(plan.duplicateMergeCount || 0)}, `
      + `delete=${Number(plan.orphanDeleteCount || 0)}`
    );
    const skippedByKind = plan.skippedByKind && typeof plan.skippedByKind === 'object' && !Array.isArray(plan.skippedByKind)
      ? Object.entries(plan.skippedByKind)
        .filter(([, count]) => Number(count || 0) > 0)
        .map(([kind, count]) => `${kind}=${Number(count || 0)}`)
      : [];
    if (skippedByKind.length > 0) {
      lines.push(`- Review Types: ${skippedByKind.join(', ')}`);
    }
    if (plan.error) {
      lines.push(`- Review Error: ${plan.error}`);
    }
  }

  const bridge = snapshot.bridge && typeof snapshot.bridge === 'object' ? snapshot.bridge : {};
  const bridgeState = typeof bridge.state === 'string' && bridge.state.trim()
    ? bridge.state.trim()
    : (typeof bridge.status === 'string' && bridge.status.trim() ? bridge.status.trim() : 'unknown');
  lines.push('');
  lines.push('BRIDGE HEALTH');
  lines.push(`- Connection: ${bridgeState}`);
  lines.push(`- Device ID: ${bridge.deviceId ? String(bridge.deviceId) : 'missing'}`);
  lines.push(`- Relay URL: ${bridge.relayUrl ? String(bridge.relayUrl) : 'unconfigured'}`);
  lines.push(`- Runtime: mode=${bridge.mode || 'unknown'}, enabled=${bridge.enabled === true ? 'yes' : 'no'}, configured=${bridge.configured === true ? 'yes' : 'no'}`);
  if (bridge.liveDiscovery && typeof bridge.liveDiscovery === 'object') {
    const discovery = bridge.liveDiscovery;
    const ageText = isFiniteNumberValue(discovery.ageMs)
      ? `${Math.round(Number(discovery.ageMs) / 1000)}s old`
      : 'age unknown';
    const roleText = Array.isArray(discovery.roles) && discovery.roles.length > 0
      ? discovery.roles.join(',')
      : 'none';
    lines.push(
      `- Live Discovery: ${discovery.ok === true ? 'verified' : 'not verified'}`
      + ` (${discovery.status || 'unknown'}; source=${discovery.source || 'unknown'}; ${ageText}; roles=${roleText})`
    );
    if (discovery.error) {
      lines.push(`- Live Discovery Error: ${discovery.error}`);
    }
  }
  const bridgePenalty = Array.isArray(snapshot.status?.penalties)
    ? snapshot.status.penalties.find((entry) => String(entry?.code || '').startsWith('bridge_'))
    : null;
  if (bridgePenalty) {
    const bridgeProbeStatus = bridgePenalty.code === 'bridge_enabled_not_connected'
      ? 'degraded (enabled but disconnected)'
      : (bridgePenalty.code === 'bridge_enabled_unconfigured' ? 'degraded (enabled but unconfigured)' : `degraded (${bridgePenalty.code})`);
    lines.push(`- Probe: ${bridgeProbeStatus}; penalty=${Number(bridgePenalty.points || 0)}`);
  } else if (bridge.enabled === true && bridge.mode === 'pending') {
    lines.push('- Probe: pending (live discovery not available in standalone snapshot); penalty=0');
  }

  const warnings = Array.isArray(snapshot.status?.warnings) ? snapshot.status.warnings : [];
  if (warnings.length > 0) {
    lines.push(`- Warnings: ${warnings.join('; ')}`);
  }

  const localModels = snapshot.systemCapabilities?.localModels || {};
  const sleepExtraction = localModels.sleepExtraction || {};
  lines.push('');
  lines.push('LOCAL MODELS');
  lines.push(`- Feature Enabled: ${localModels.enabled === true ? 'yes' : 'no'}`);
  lines.push(`- Sleep Extraction: path=${sleepExtraction.path || 'fallback'}, enabled=${sleepExtraction.enabled === true ? 'yes' : 'no'}, available=${sleepExtraction.available === true ? 'yes' : 'no'}${sleepExtraction.model ? `, model=${sleepExtraction.model}` : ''}`);

  return `${lines.join('\n')}\n`;
}

function renderUsage() {
  return [
    'Usage: node ui/scripts/hm-health-snapshot.js [projectRoot] [--profile <name>]',
    '',
    'Creates a JSON startup health snapshot for a SquidRun project.',
    '',
    'Options:',
    '  -h, --help          Show this help and exit.',
    '  --profile <name>    Use a profile-scoped coordination namespace.',
    '  --markdown          Print the compact startup markdown summary.',
    '  --json              Print the raw JSON snapshot (default).',
    '',
  ].join('\n');
}

function parseCliArgs(argv = []) {
  const parsed = {
    help: false,
    projectRoot: null,
    profileName: null,
    format: 'json',
    errors: [],
  };
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '').trim();
    if (!token) continue;
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    if (token === '--markdown') {
      parsed.format = 'markdown';
      continue;
    }
    if (token === '--json') {
      parsed.format = 'json';
      continue;
    }
    if (token === '--profile') {
      const next = String(args[index + 1] || '').trim();
      if (!next || next.startsWith('-')) {
        parsed.errors.push('--profile requires a profile name.');
      } else {
        parsed.profileName = next;
        index += 1;
      }
      continue;
    }
    if (token.startsWith('--profile=')) {
      const value = token.slice('--profile='.length).trim();
      if (!value) {
        parsed.errors.push('--profile requires a profile name.');
      } else {
        parsed.profileName = value;
      }
      continue;
    }
    if (token.startsWith('-')) {
      parsed.errors.push(`Unknown option: ${token}`);
      continue;
    }
    if (!parsed.projectRoot) {
      parsed.projectRoot = token;
    } else {
      parsed.errors.push(`Unexpected argument: ${token}`);
    }
  }
  return parsed;
}

function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    stdout.write(renderUsage());
    return 0;
  }
  if (parsed.errors.length > 0) {
    stderr.write(`${parsed.errors.join('\n')}\n\n${renderUsage()}`);
    return 1;
  }
  const snapshot = createHealthSnapshot({
    projectRoot: parsed.projectRoot || null,
    profileName: parsed.profileName || DEFAULT_PROFILE,
  });
  if (parsed.format === 'markdown') {
    stdout.write(renderStartupHealthMarkdown(snapshot));
  } else {
    stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  }
  return 0;
}

if (require.main === module) {
  try {
    const exitCode = main();
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  HEALTH_SCORE_PENALTIES,
  HEALTH_SCORE_THRESHOLDS,
  KEY_MODULE_PATHS,
  collectKeyModules,
  countModuleFiles,
  countTestFiles,
  createHealthSnapshot,
  applyBridgeDiscoveryToSnapshot,
  buildBridgeSnapshotFromEnv,
  getPenaltyPoints,
  inspectSqliteDb,
  listJestTests,
  loadSqliteDriver,
  readBridgeKnownDevicesCache,
  normalizeProjectRoot,
  parseCliArgs,
  readEffectiveProjectEnv,
  renderStartupHealthMarkdown,
  renderUsage,
  resolveHealthThreshold,
  resolveWindowsCmdPath,
  main,
};
