#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getProjectRoot } = require('../config');

const KEY_MODULE_PATHS = Object.freeze({
  recovery_manager: path.join('ui', 'modules', 'recovery-manager.js'),
  background_agent_manager: path.join('ui', 'modules', 'main', 'background-agent-manager.js'),
  scheduler: path.join('ui', 'modules', 'scheduler.js'),
  evidence_ledger_memory: path.join('ui', 'modules', 'main', 'evidence-ledger-memory.js'),
  supervisor_daemon: path.join('ui', 'supervisor-daemon.js'),
  supervisor_store: path.join('ui', 'modules', 'supervisor', 'store.js'),
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
  const command = process.platform === 'win32'
    ? `${windowsCmd} /d /s /c "npx jest --listTests"`
    : 'npx jest --listTests';
  try {
    const stdout = process.platform === 'win32'
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
        });
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

function buildHealthStatus(snapshot) {
  const warnings = [];
  if (!snapshot.tests.jestList.ok) {
    warnings.push(`jest_list_failed:${snapshot.tests.jestList.error || 'unknown'}`);
  }
  if (snapshot.tests.testFileCount <= 0) {
    warnings.push('no_test_files_detected');
  }
  const missingKeyModules = Object.entries(snapshot.modules.keyModules)
    .filter(([, value]) => value.exists !== true)
    .map(([key]) => key);
  if (missingKeyModules.length > 0) {
    warnings.push(`missing_key_modules:${missingKeyModules.join(',')}`);
  }
  for (const [key, db] of Object.entries(snapshot.databases)) {
    if (!db.exists) {
      warnings.push(`${key}_missing`);
      continue;
    }
    if (db.error) {
      warnings.push(`${key}_error:${db.error}`);
      continue;
    }
    if (db.rowCount <= 0) {
      warnings.push(`${key}_empty`);
    }
  }
  const bridge = snapshot.bridge && typeof snapshot.bridge === 'object' ? snapshot.bridge : {};
  if (bridge.enabled === true && bridge.configured !== true) {
    warnings.push('bridge_enabled_unconfigured');
  } else if (bridge.enabled === true && bridge.mode !== 'connected') {
    warnings.push(`bridge_enabled_not_connected:${bridge.state || bridge.status || bridge.mode || 'unknown'}`);
  }
  return {
    level: warnings.length > 0 ? 'warn' : 'ok',
    warnings,
  };
}

function createHealthSnapshot(options = {}) {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const uiRoot = path.join(projectRoot, 'ui');
  const testsRoot = path.join(projectRoot, 'ui', '__tests__');
  const modulesRoot = path.join(projectRoot, 'ui', 'modules');
  const evidenceLedgerDbPath = path.join(projectRoot, '.squidrun', 'runtime', 'evidence-ledger.db');
  const cognitiveMemoryDbPath = path.join(projectRoot, 'workspace', 'memory', 'cognitive-memory.db');

  const testFiles = countTestFiles(testsRoot);
  const jestList = listJestTests(uiRoot, asPositiveInt(options.jestTimeoutMs, 30000));
  const moduleFiles = countModuleFiles(modulesRoot);
  const keyModules = collectKeyModules(projectRoot);
  const databases = {
    evidenceLedger: inspectSqliteDb(evidenceLedgerDbPath, ['comms_journal', 'ledger_sessions', 'ledger_decisions']),
    cognitiveMemory: inspectSqliteDb(cognitiveMemoryDbPath, ['nodes', 'memory_pr_queue', 'edges']),
  };
  const bridge = normalizeBridgeSnapshot(options.bridgeStatus);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    projectRoot,
    tests: {
      testsRoot,
      testFileCount: testFiles.count,
      jestList,
    },
    modules: {
      modulesRoot,
      moduleFileCount: moduleFiles.count,
      keyModules,
    },
    databases,
    bridge,
  };

  return {
    ...snapshot,
    status: buildHealthStatus(snapshot),
  };
}

function renderStartupHealthMarkdown(snapshot = {}) {
  const lines = [
    'STARTUP HEALTH',
    `- Overall: ${String(snapshot.status?.level || 'unknown').toUpperCase()}`,
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

  const warnings = Array.isArray(snapshot.status?.warnings) ? snapshot.status.warnings : [];
  if (warnings.length > 0) {
    lines.push(`- Warnings: ${warnings.join('; ')}`);
  }

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
  KEY_MODULE_PATHS,
  collectKeyModules,
  countModuleFiles,
  countTestFiles,
  createHealthSnapshot,
  inspectSqliteDb,
  listJestTests,
  loadSqliteDriver,
  normalizeProjectRoot,
  renderStartupHealthMarkdown,
  resolveWindowsCmdPath,
};
