#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

function resolveElectronPath() {
  try {
    return require('electron');
  } catch (err) {
    throw new Error(`electron package unavailable: ${err.message}`);
  }
}

function parseProbePayload(stdout = '', stderr = '') {
  const lines = `${stdout || ''}\n${stderr || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.reverse()) {
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Keep scanning for a JSON probe line.
    }
  }
  return null;
}

function probeBetterSqlite3() {
  const electronPath = resolveElectronPath();
  const probeScript = [
    "const result = {",
    "  electron: process.versions.electron || null,",
    "  node: process.versions.node,",
    "  modules: process.versions.modules,",
    "};",
    "try {",
    "  const Database = require('better-sqlite3');",
    "  const db = new Database(':memory:');",
    "  result.query = db.prepare('select 1 as ok').get().ok;",
    "  db.close();",
    "  result.betterSqlite3Load = true;",
    "  console.log(JSON.stringify(result));",
    "} catch (err) {",
    "  result.betterSqlite3Load = false;",
    "  result.error = err && err.message ? err.message : String(err);",
    "  console.error(JSON.stringify(result));",
    "  process.exit(1);",
    "}",
  ].join('\n');

  const result = spawnSync(electronPath, ['-e', probeScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    encoding: 'utf8',
  });

  const payload = parseProbePayload(result.stdout, result.stderr);
  return {
    ok: result.status === 0 && payload?.betterSqlite3Load === true,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    payload,
  };
}

function runElectronRebuild() {
  const binName = process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild';
  const rebuildPath = path.join(rootDir, 'node_modules', '.bin', binName);
  return spawnSync(rebuildPath, ['-f', '-o', 'better-sqlite3'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function formatProbe(probe) {
  const payload = probe?.payload || {};
  return [
    `electron=${payload.electron || 'unknown'}`,
    `node=${payload.node || 'unknown'}`,
    `modules=${payload.modules || 'unknown'}`,
    payload.error ? `error=${payload.error}` : null,
  ].filter(Boolean).join(' ');
}

function main() {
  const initial = probeBetterSqlite3();
  if (initial.ok) {
    console.log(`[postinstall] better-sqlite3 loads under Electron (${formatProbe(initial)}); rebuild skipped.`);
    return;
  }

  console.warn(`[postinstall] better-sqlite3 Electron probe failed (${formatProbe(initial)}); rebuilding for Electron.`);
  const rebuild = runElectronRebuild();
  if (rebuild.status !== 0) {
    process.exit(rebuild.status || 1);
  }

  const finalProbe = probeBetterSqlite3();
  if (!finalProbe.ok) {
    console.error(`[postinstall] better-sqlite3 still does not load after rebuild (${formatProbe(finalProbe)}).`);
    process.exit(finalProbe.status || 1);
  }

  console.log(`[postinstall] better-sqlite3 rebuilt and verified under Electron (${formatProbe(finalProbe)}).`);
}

main();
