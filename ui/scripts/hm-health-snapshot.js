#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getProjectRoot } = require('../config');
const { resolveDefaultCognitiveMemoryDbPath } = require('../modules/cognitive-memory-store');
const { runMemoryConsistencyCheck } = require('../modules/memory-consistency-check');
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

let SQLITE_DRIVER = undefined;

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

function readAppStatusSnapshot(projectRoot) {
  const appStatusPath = path.join(projectRoot, '.squidrun', 'app-status.json');
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
  const mode = enabled !== true
    ? 'disabled'
    : ((state === 'connected' || status === 'relay_connected')
      ? 'connected'
      : 'connecting');

  return {
    enabled,
    configured,
    mode,
    running: source.running === true,
    relayUrl,
    deviceId,
    state,
    status,
  };
}

function summarizeMemoryConsistency(result = null) {
  const source = result && typeof result === 'object' && !Array.isArray(result)
    ? result
    : {};
  const summary = source.summary && typeof source.summary === 'object' && !Array.isArray(source.summary)
    ? source.summary
    : {};
  return {
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
    return summarizeMemoryConsistency(runMemoryConsistencyCheck({
      projectRoot,
      sampleLimit: Number.isFinite(Number(options.memoryConsistencySampleLimit))
        ? Number(options.memoryConsistencySampleLimit)
        : 5,
    }));
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
      provider: 'ollama',
      ollama: {
        running: false,
        reachable: false,
        selectedModel: null,
        error: 'not_detected',
      },
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
  } else if (bridge.enabled === true && bridge.mode !== 'connected') {
    warnings.push(`bridge_enabled_not_connected:${bridge.state || bridge.status || bridge.mode || 'unknown'}`);
    addPenalty('bridge_enabled_not_connected');
  }
  const memoryConsistency = snapshot.memoryConsistency && typeof snapshot.memoryConsistency === 'object'
    ? snapshot.memoryConsistency
    : {};
  if (memoryConsistency.status === 'drift_detected') {
    warnings.push(
      'memory_consistency_drift:'
      + `missing=${Number(memoryConsistency.summary?.missingInCognitiveCount || 0)},`
      + `orphans=${Number(memoryConsistency.summary?.orphanedNodeCount || 0)},`
      + `duplicates=${Number(memoryConsistency.summary?.duplicateKnowledgeHashCount || 0)}`
    );
    addPenalty('memory_consistency_drift');
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
  const uiRoot = path.join(projectRoot, 'ui');
  const testsRoot = path.join(projectRoot, 'ui', '__tests__');
  const modulesRoot = path.join(projectRoot, 'ui', 'modules');
  const evidenceLedgerDbPath = path.join(projectRoot, '.squidrun', 'runtime', 'evidence-ledger.db');
  const cognitiveMemoryDbPath = resolveDefaultCognitiveMemoryDbPath({ projectRoot });
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
  const generatedAt = typeof options.generatedAt === 'string' && options.generatedAt.trim()
    ? options.generatedAt.trim()
    : new Date(nowMs).toISOString();

  const testFiles = countTestFiles(testsRoot);
  const jestList = listJestTests(uiRoot, asPositiveInt(options.jestTimeoutMs, 30000));
  const moduleFiles = countModuleFiles(modulesRoot);
  const keyModules = collectKeyModules(projectRoot);
  const appStatus = readAppStatusSnapshot(projectRoot);
  const databases = {
    evidenceLedger: inspectSqliteDb(evidenceLedgerDbPath, ['comms_journal', 'ledger_sessions', 'ledger_decisions']),
    cognitiveMemory: inspectSqliteDb(cognitiveMemoryDbPath, ['nodes', 'memory_pr_queue', 'edges']),
  };
  const bridge = normalizeBridgeSnapshot(options.bridgeStatus);
  const memoryConsistency = inspectMemoryConsistency(projectRoot, options);
  const systemCapabilities = inspectSystemCapabilities(projectRoot, options);

  const snapshot = {
    generatedAt,
    projectRoot,
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
  const bridgePenalty = Array.isArray(snapshot.status?.penalties)
    ? snapshot.status.penalties.find((entry) => String(entry?.code || '').startsWith('bridge_'))
    : null;
  if (bridgePenalty) {
    const bridgeProbeStatus = bridgePenalty.code === 'bridge_enabled_not_connected'
      ? 'degraded (enabled but disconnected)'
      : (bridgePenalty.code === 'bridge_enabled_unconfigured' ? 'degraded (enabled but unconfigured)' : `degraded (${bridgePenalty.code})`);
    lines.push(`- Probe: ${bridgeProbeStatus}; penalty=${Number(bridgePenalty.points || 0)}`);
  }

  const warnings = Array.isArray(snapshot.status?.warnings) ? snapshot.status.warnings : [];
  if (warnings.length > 0) {
    lines.push(`- Warnings: ${warnings.join('; ')}`);
  }

  const localModels = snapshot.systemCapabilities?.localModels || {};
  const ollama = localModels.ollama || {};
  const sleepExtraction = localModels.sleepExtraction || {};
  lines.push('');
  lines.push('LOCAL MODELS');
  lines.push(`- Feature Enabled: ${localModels.enabled === true ? 'yes' : 'no'}`);
  lines.push(`- Ollama: ${ollama.running === true ? 'running' : 'unavailable'}${ollama.error ? ` (${ollama.error})` : ''}`);
  lines.push(`- Selected Model: ${ollama.selectedModel || 'none'}`);
  lines.push(`- Sleep Extraction: path=${sleepExtraction.path || 'fallback'}, enabled=${sleepExtraction.enabled === true ? 'yes' : 'no'}, available=${sleepExtraction.available === true ? 'yes' : 'no'}${sleepExtraction.model ? `, model=${sleepExtraction.model}` : ''}`);

  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  const snapshot = createHealthSnapshot({
    projectRoot: argv[0] || null,
  });
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
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
  getPenaltyPoints,
  inspectSqliteDb,
  listJestTests,
  loadSqliteDriver,
  normalizeProjectRoot,
  renderStartupHealthMarkdown,
  resolveHealthThreshold,
  resolveWindowsCmdPath,
};
