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

function normalizeProjectRoot(projectRoot) {
  return path.resolve(String(projectRoot || getProjectRoot() || process.cwd()));
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
  const command = process.platform === 'win32'
    ? 'cmd.exe /d /s /c "npx jest --listTests"'
    : 'npx jest --listTests';
  try {
    const stdout = process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx jest --listTests'], {
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
  renderStartupHealthMarkdown,
};
