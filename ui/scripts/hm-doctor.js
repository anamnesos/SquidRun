#!/usr/bin/env node
/**
 * hm-doctor: one-command diagnostics bundle for SquidRun bug reports.
 * Usage: node ui/scripts/hm-doctor.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_WS_PORT = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const DEFAULT_WS_TIMEOUT_MS = 2500;
const DEFAULT_DAEMON_TIMEOUT_MS = 2500;
const APP_LOG_TAIL_LINES = 80;

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value;
}

function readJsonFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, reason: 'missing', path: filePath };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, data: JSON.parse(raw), path: filePath };
  } catch (err) {
    return { ok: false, reason: err.message, path: filePath };
  }
}

function parseEnvKeys(envPath) {
  if (!fs.existsSync(envPath)) {
    return { ok: false, reason: 'missing', path: envPath, keys: [] };
  }

  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const keys = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex <= 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      if (!key) continue;
      const rawValue = trimmed.slice(eqIndex + 1);
      const unquoted = rawValue.replace(/^['"]|['"]$/g, '');
      keys.push({
        key,
        valueRedacted: redactValue(unquoted),
      });
    }
    return { ok: true, path: envPath, keys };
  } catch (err) {
    return { ok: false, reason: err.message, path: envPath, keys: [] };
  }
}

function redactValue(value) {
  const normalized = asString(value, '');
  if (!normalized) return '(empty)';
  return `<redacted:${normalized.length} chars>`;
}

function tailFile(filePath, maxLines = APP_LOG_TAIL_LINES) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'missing', path: filePath, lines: [] };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const tail = lines.slice(Math.max(0, lines.length - maxLines));
    return { ok: true, path: filePath, lines: tail };
  } catch (err) {
    return { ok: false, reason: err.message, path: filePath, lines: [] };
  }
}

function resolveDaemonPipePath() {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\squidrun-terminal'
    : '/tmp/squidrun-terminal.sock';
}

function queryPaneStatus(timeoutMs = DEFAULT_DAEMON_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const pipePath = resolveDaemonPipePath();
    const socket = net.createConnection(pipePath);
    let settled = false;
    let buffer = '';
    let timeoutId = null;

    function finish(payload) {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      try {
        socket.destroy();
      } catch {
        // Best effort cleanup.
      }
      resolve(payload);
    }

    timeoutId = setTimeout(() => {
      finish({
        ok: false,
        reason: `timeout after ${timeoutMs}ms`,
        pipePath,
      });
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ action: 'list' })}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (parsed && parsed.event === 'list' && Array.isArray(parsed.terminals)) {
          finish({
            ok: true,
            pipePath,
            panes: parsed.terminals.map((term) => ({
              paneId: String(term.paneId || ''),
              alive: term.alive === true,
              mode: term.mode || null,
              pid: term.pid || null,
              cwd: term.cwd || null,
              lastActivity: term.lastActivity || null,
            })),
          });
          return;
        }
      }
    });

    socket.on('error', (err) => {
      finish({
        ok: false,
        reason: err.message,
        pipePath,
      });
    });

    socket.on('close', () => {
      if (!settled) {
        finish({
          ok: false,
          reason: 'daemon connection closed before list response',
          pipePath,
        });
      }
    });
  });
}

async function checkWebSocketConnectivity(timeoutMs = DEFAULT_WS_TIMEOUT_MS) {
  const url = `ws://127.0.0.1:${DEFAULT_WS_PORT}`;
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    const requestId = `doctor-${Date.now()}`;
    const ws = new WebSocket(url);

    function finish(payload) {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      try {
        ws.close();
      } catch {
        // Best effort close.
      }
      resolve(payload);
    }

    timeoutId = setTimeout(() => {
      finish({
        ok: false,
        url,
        reason: `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'health-check',
        requestId,
        target: 'architect',
        staleAfterMs: 60000,
      }));
    });

    ws.on('message', (raw) => {
      let payload = null;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (payload?.type === 'health-check-result' && payload?.requestId === requestId) {
        finish({
          ok: true,
          url,
          result: payload,
        });
      }
    });

    ws.on('error', (err) => {
      finish({
        ok: false,
        url,
        reason: err.message,
      });
    });
  });
}

function countEvidenceLedgerRows(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: 'missing', path: dbPath };
  }

  const errors = [];

  // Prefer better-sqlite3 if its native binary matches the current runtime.
  try {
    const BetterSqlite3 = require('better-sqlite3');
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS count FROM comms_journal').get();
      return {
        ok: true,
        path: dbPath,
        driver: 'better-sqlite3',
        commsJournalRows: Number(row?.count || 0),
      };
    } finally {
      db.close();
    }
  } catch (err) {
    errors.push(`better-sqlite3: ${err.message}`);
  }

  // Fallback to node:sqlite while suppressing the experimental warning for cleaner diagnostics output.
  try {
    const originalEmitWarning = process.emitWarning;
    try {
      process.emitWarning = (warning, ...args) => {
        const message = typeof warning === 'string'
          ? warning
          : (warning && typeof warning.message === 'string' ? warning.message : '');
        if (message.includes('SQLite is an experimental feature')) return;
        return originalEmitWarning.call(process, warning, ...args);
      };
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare('SELECT COUNT(*) AS count FROM comms_journal').get();
        return {
          ok: true,
          path: dbPath,
          driver: 'node:sqlite',
          commsJournalRows: Number(row?.count || 0),
        };
      } finally {
        db.close();
      }
    } finally {
      process.emitWarning = originalEmitWarning;
    }
  } catch (err) {
    errors.push(`node:sqlite: ${err.message}`);
  }

  return { ok: false, reason: errors.join(' | '), path: dbPath };
}

function printSection(title, payload) {
  console.log(`\n=== ${title} ===`);
  if (typeof payload === 'string') {
    console.log(payload);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const appStatusPath = path.join(ROOT_DIR, '.squidrun', 'app-status.json');
  const envPath = path.join(ROOT_DIR, '.env');
  const appLogPath = path.join(ROOT_DIR, 'workspace', 'logs', 'app.log');
  const evidencePath = path.join(ROOT_DIR, '.squidrun', 'runtime', 'evidence-ledger.db');

  const platformInfo = {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    hostname: os.hostname(),
    cwd: process.cwd(),
    rootDir: ROOT_DIR,
    nowIso: new Date().toISOString(),
  };

  const nodeInfo = {
    nodeVersion: process.version,
    nodeVersions: process.versions,
  };

  const appStatus = readJsonFileSafe(appStatusPath);
  const envKeys = parseEnvKeys(envPath);
  const appLogTail = tailFile(appLogPath, APP_LOG_TAIL_LINES);
  const [wsTest, paneStatus] = await Promise.all([
    checkWebSocketConnectivity(),
    queryPaneStatus(),
  ]);
  const evidenceCounts = countEvidenceLedgerRows(evidencePath);

  printSection('Platform', platformInfo);
  printSection('Node', nodeInfo);
  printSection('App Status', appStatus);
  printSection('Env Keys (redacted)', envKeys);
  printSection('WS Connectivity', wsTest);
  printSection('Pane Status', paneStatus);
  printSection('Evidence Ledger Rows', evidenceCounts);
  printSection('Recent app.log Tail', appLogTail);
}

main().catch((err) => {
  console.error(`hm-doctor failed: ${err.message}`);
  process.exit(1);
});
