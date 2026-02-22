#!/usr/bin/env node
/**
 * hm-doctor: Preflight checks for running SquidRun on a fresh machine.
 * Usage: node ui/scripts/hm-doctor.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const DEFAULT_PORT = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const UI_DIR = path.resolve(__dirname, '..');

function printStatus(level, title, detail) {
  const label = level === 'pass' ? 'PASS' : level === 'warn' ? 'WARN' : 'FAIL';
  console.log(`[${label}] ${title}`);
  if (detail) {
    console.log(`       ${detail}`);
  }
}

function getPackageJson() {
  const packagePath = path.join(UI_DIR, 'package.json');
  return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
}

function compareNodeMajor(minMajor) {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(major)) {
    return { ok: false, detail: `Unable to parse Node version: ${process.versions.node}` };
  }
  if (major < minMajor) {
    return { ok: false, detail: `Node ${process.versions.node} detected; requires >= ${minMajor}.x` };
  }
  return { ok: true, detail: `Node ${process.versions.node}` };
}

function checkDependenciesInstalled() {
  const pkg = getPackageJson();
  const deps = Object.keys(pkg.dependencies || {});

  const missing = [];
  deps.forEach((name) => {
    try {
      require.resolve(`${name}/package.json`, { paths: [UI_DIR] });
    } catch {
      missing.push(name);
    }
  });

  if (missing.length > 0) {
    return {
      ok: false,
      detail: `Missing ${missing.length}/${deps.length} dependency packages: ${missing.join(', ')}`,
    };
  }

  return { ok: true, detail: `${deps.length} dependencies resolved` };
}

function checkNodePtyHealth() {
  try {
    const pty = require('node-pty');
    if (!pty || typeof pty.spawn !== 'function') {
      return { ok: false, detail: 'node-pty loaded but spawn() is unavailable' };
    }
    return { ok: true, detail: 'node-pty loaded and spawn() is available' };
  } catch (err) {
    return {
      ok: false,
      detail: `node-pty failed to load: ${err.message}. Try: npm run rebuild`,
    };
  }
}

function checkNodeSqliteHealth() {
  try {
    const sqlite = require('node:sqlite');
    if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
      return {
        ok: true,
        warn: true,
        detail: 'node:sqlite loaded but DatabaseSync is unavailable (optional runtime path)',
      };
    }

    const db = new sqlite.DatabaseSync(':memory:');
    const row = db.prepare('SELECT 1 AS ok').get();
    db.close();

    if (!row || row.ok !== 1) {
      return {
        ok: true,
        warn: true,
        detail: 'node:sqlite loaded but query smoke test failed (optional runtime path)',
      };
    }

    return { ok: true, detail: 'node:sqlite loaded and in-memory query succeeded' };
  } catch (err) {
    return {
      ok: true,
      warn: true,
      detail: `node:sqlite unavailable in this runtime (${err.message}); falling back to better-sqlite3`,
    };
  }
}

function isBetterSqliteAbiMismatch(err) {
  const message = typeof err?.message === 'string' ? err.message : '';
  if (!message) return false;
  return message.includes('compiled against a different Node.js version')
    || message.includes('NODE_MODULE_VERSION');
}

function checkBetterSqliteHealth(options = {}) {
  const nodeSqliteHealthy = options.nodeSqliteHealthy === true;
  try {
    const BetterSqlite3 = require('better-sqlite3');
    const db = new BetterSqlite3(':memory:');
    const row = db.prepare('SELECT 1 AS ok').get();
    db.close();

    if (!row || row.ok !== 1) {
      return { ok: false, detail: 'better-sqlite3 loaded but query smoke test failed' };
    }

    return { ok: true, detail: 'better-sqlite3 loaded and in-memory query succeeded' };
  } catch (err) {
    if (nodeSqliteHealthy && isBetterSqliteAbiMismatch(err)) {
      return {
        ok: true,
        warn: true,
        detail: `better-sqlite3 ABI mismatch: ${err.message}. node:sqlite is healthy, so this is non-blocking for CLI`,
      };
    }

    return {
      ok: false,
      detail: `better-sqlite3 failed health check: ${err.message}. Try: npm run rebuild`,
    };
  }
}

async function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        resolve({
          ok: true,
          warn: true,
          detail: `Port ${port} is already in use (SquidRun may already own this port)`,
        });
        return;
      }
      resolve({ ok: false, detail: `Port ${port} check failed: ${err.message}` });
    });

    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve({ ok: true, detail: `Port ${port} is available` });
      });
    });
  });
}

function checkShellDefaults() {
  if (os.platform() === 'win32') {
    const shellPath = process.env.COMSPEC;
    if (!shellPath) {
      return { ok: false, detail: 'COMSPEC is not set' };
    }
    if (!fs.existsSync(shellPath)) {
      return { ok: false, detail: `COMSPEC points to missing path: ${shellPath}` };
    }
    return { ok: true, detail: `COMSPEC=${shellPath}` };
  }

  const shellPath = process.env.SHELL;
  if (!shellPath) {
    return { ok: false, detail: 'SHELL is not set' };
  }
  if (!fs.existsSync(shellPath)) {
    return { ok: false, detail: `SHELL points to missing path: ${shellPath}` };
  }

  try {
    fs.accessSync(shellPath, fs.constants.X_OK);
  } catch {
    return { ok: false, detail: `SHELL is not executable: ${shellPath}` };
  }

  return { ok: true, detail: `SHELL=${shellPath}` };
}

function writeProbeFile(targetDir) {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.accessSync(targetDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    const probe = path.join(targetDir, `.hm-doctor-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return { ok: true, detail: `${targetDir}` };
  } catch (err) {
    return { ok: false, detail: `${targetDir} (${err.message})` };
  }
}

function checkFilePermissions() {
  const targets = [
    path.join(ROOT_DIR, '.squidrun'),
    path.join(ROOT_DIR, '.squidrun', 'triggers'),
  ];

  const failures = [];
  const successes = [];

  targets.forEach((target) => {
    const result = writeProbeFile(target);
    if (result.ok) successes.push(result.detail);
    else failures.push(result.detail);
  });

  if (failures.length > 0) {
    return {
      ok: false,
      detail: `Permission issues: ${failures.join('; ')}`,
    };
  }

  return {
    ok: true,
    detail: `Writable paths: ${successes.length}/${targets.length}`,
  };
}

async function main() {
  console.log('SquidRun Doctor: preflight checks');
  console.log(`Project root: ${ROOT_DIR}`);
  console.log('');

  let nodeSqliteHealthy = false;
  const checks = [
    { title: 'Node version', run: () => compareNodeMajor(18) },
    { title: 'Dependencies installed', run: () => checkDependenciesInstalled() },
    { title: 'Native module: node-pty', run: () => checkNodePtyHealth() },
    {
      title: 'Native module: node:sqlite',
      run: () => {
        const result = checkNodeSqliteHealth();
        nodeSqliteHealthy = result.ok && result.warn !== true;
        return result;
      },
    },
    {
      title: 'Native module: better-sqlite3',
      run: () => checkBetterSqliteHealth({ nodeSqliteHealthy }),
    },
    { title: `Port ${DEFAULT_PORT} availability`, run: () => checkPortAvailable(DEFAULT_PORT) },
    { title: 'Shell defaults', run: () => checkShellDefaults() },
    { title: 'File permissions', run: () => checkFilePermissions() },
  ];

  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const check of checks) {
    try {
      // Support both sync and async checks with one path.
      const result = await Promise.resolve(check.run());
      if (result.ok) {
        if (result.warn) {
          warnCount += 1;
          printStatus('warn', check.title, result.detail);
        } else {
          passCount += 1;
          printStatus('pass', check.title, result.detail);
        }
      } else {
        failCount += 1;
        printStatus('fail', check.title, result.detail);
      }
    } catch (err) {
      failCount += 1;
      printStatus('fail', check.title, err.message);
    }
  }

  console.log('');
  console.log(`Summary: ${passCount} passed, ${warnCount} warned, ${failCount} failed`);

  if (failCount > 0) {
    process.exitCode = 1;
    console.log('Doctor result: FAIL');
    return;
  }

  console.log('Doctor result: PASS');
}

main().catch((err) => {
  console.error(`Doctor execution failed: ${err.message}`);
  process.exit(1);
});
