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
const PANE_ROLE_MAP = Object.freeze({
  '1': 'architect',
  '2': 'builder',
  '3': 'oracle',
});

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

function readEnvMap(envPath) {
  if (!fs.existsSync(envPath)) return {};
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

function parseCommandString(command) {
  const normalized = asString(command, '').trim();
  if (!normalized) {
    return {
      raw: '',
      cli: null,
      model: null,
    };
  }
  const parts = normalized.split(/\s+/).filter(Boolean);
  const cli = parts[0] || null;
  let model = null;
  for (let i = 0; i < parts.length; i += 1) {
    if ((parts[i] === '--model' || parts[i] === '-m') && parts[i + 1]) {
      model = parts[i + 1];
      break;
    }
  }
  if (!model && cli === 'codex') {
    model = 'default';
  }
  return {
    raw: normalized,
    cli,
    model,
  };
}

function buildPaneRoleModelMapping(settingsResult, paneStatusResult) {
  if (!settingsResult?.ok) {
    return {
      ok: false,
      reason: settingsResult?.reason || 'settings_unavailable',
      path: settingsResult?.path || null,
    };
  }

  const paneCommands = settingsResult.data?.paneCommands || {};
  const livePanes = new Map(
    Array.isArray(paneStatusResult?.panes)
      ? paneStatusResult.panes.map((pane) => [String(pane.paneId || ''), pane])
      : []
  );
  const paneIds = ['1', '2', '3'];

  return {
    ok: true,
    path: settingsResult.path,
    panes: paneIds.map((paneId) => {
      const command = parseCommandString(paneCommands[paneId] || '');
      const live = livePanes.get(paneId) || null;
      return {
        paneId,
        role: PANE_ROLE_MAP[paneId] || 'unknown',
        cli: command.cli,
        model: command.model,
        command: command.raw || null,
        alive: live?.alive ?? null,
        pid: live?.pid ?? null,
        cwd: live?.cwd ?? null,
        lastActivity: live?.lastActivity ?? null,
      };
    }),
  };
}

function buildSupervisorState(supervisorResult, sessionStateResult) {
  if (!supervisorResult?.ok && !sessionStateResult?.ok) {
    return {
      ok: false,
      reason: 'supervisor_status_and_session_state_unavailable',
      supervisorPath: supervisorResult?.path || null,
      sessionStatePath: sessionStateResult?.path || null,
    };
  }

  const supervisor = supervisorResult?.ok ? supervisorResult.data : {};
  const sessionState = sessionStateResult?.ok ? sessionStateResult.data : {};
  const terminals = Array.isArray(sessionState?.terminals) ? sessionState.terminals : [];

  return {
    ok: true,
    supervisorPath: supervisorResult?.path || null,
    sessionStatePath: sessionStateResult?.path || null,
    supervisor: supervisorResult?.ok ? {
      pid: supervisor.pid || null,
      heartbeatAtMs: supervisor.heartbeatAtMs || null,
      pollMs: supervisor.pollMs || null,
      maxWorkers: supervisor.maxWorkers || null,
      activeWorkers: Array.isArray(supervisor.activeWorkers) ? supervisor.activeWorkers : [],
      counts: supervisor.counts || null,
      sleepCycle: supervisor.sleepCycle ? {
        enabled: supervisor.sleepCycle.enabled === true,
        running: supervisor.sleepCycle.running === true,
        idleThresholdMs: supervisor.sleepCycle.idleThresholdMs || null,
        minIntervalMs: supervisor.sleepCycle.minIntervalMs || null,
        activity: supervisor.sleepCycle.activity || null,
        lastSummary: supervisor.sleepCycle.lastSummary ? {
          status: supervisor.sleepCycle.lastSummary.status || null,
          reason: supervisor.sleepCycle.lastSummary.reason || null,
          skipped: supervisor.sleepCycle.lastSummary.skipped === true,
          skipReason: supervisor.sleepCycle.lastSummary.skipReason || null,
          startedAtMs: supervisor.sleepCycle.lastSummary.startedAtMs || null,
          finishedAtMs: supervisor.sleepCycle.lastSummary.finishedAtMs || null,
        } : null,
      } : null,
    } : null,
    daemonSession: sessionStateResult?.ok ? {
      savedAt: sessionState.savedAt || null,
      daemonPid: sessionState.daemonPid || null,
      terminalCount: terminals.length,
      activePaneIds: terminals.filter((term) => term?.alive === true).map((term) => String(term.paneId || '')),
      terminals: terminals.map((term) => ({
        paneId: String(term?.paneId || ''),
        alive: term?.alive === true,
        pid: term?.pid || null,
        cwd: term?.cwd || null,
        lastActivity: term?.lastActivity || null,
        lastInputTime: term?.lastInputTime || null,
      })),
    } : null,
  };
}

function buildBridgeStatus(runtimeDir, envMap, knownDevicesResult) {
  const runtimeArtifacts = fs.existsSync(runtimeDir)
    ? fs.readdirSync(runtimeDir).filter((name) => /bridge|relay/i.test(name))
    : [];
  const crossDeviceRaw = asString(envMap.SQUIDRUN_CROSS_DEVICE, '').toLowerCase();
  const crossDeviceEnabled = ['1', 'true', 'yes', 'on'].includes(crossDeviceRaw);
  const relayUrl = asString(envMap.SQUIDRUN_RELAY_URL, '') || null;

  return {
    ok: true,
    runtimeDir,
    runtimeArtifacts,
    crossDeviceEnabled,
    relayUrl,
    deviceId: asString(envMap.SQUIDRUN_DEVICE_ID, '') || null,
    knownDevicesCache: knownDevicesResult?.ok ? {
      path: knownDevicesResult.path,
      updatedAt: knownDevicesResult.data?.updated_at || null,
      source: knownDevicesResult.data?.source || null,
      deviceCount: Array.isArray(knownDevicesResult.data?.devices) ? knownDevicesResult.data.devices.length : 0,
      devices: Array.isArray(knownDevicesResult.data?.devices) ? knownDevicesResult.data.devices : [],
    } : {
      path: knownDevicesResult?.path || null,
      reason: knownDevicesResult?.reason || 'missing',
    },
    note: runtimeArtifacts.length > 0
      ? 'Using dedicated bridge/relay runtime artifacts.'
      : 'No dedicated bridge/relay runtime file found under .squidrun/runtime; reporting env + known-devices cache.',
  };
}

function buildExperiencePrecedence(settingsResult, userProfileResult) {
  const settingsValue = settingsResult?.ok
    ? asString(settingsResult.data?.userExperienceLevel, '') || null
    : null;
  const profileValue = userProfileResult?.ok
    ? asString(userProfileResult.data?.experience_level, '') || null
    : null;
  const resolved = profileValue || settingsValue || null;

  return {
    ok: Boolean(settingsResult?.ok || userProfileResult?.ok),
    canonicalSource: profileValue ? 'workspace/user-profile.json' : (settingsValue ? 'ui/settings.json' : null),
    resolvedValue: resolved,
    settingsValue,
    profileValue,
    status: settingsValue && profileValue
      ? (settingsValue === profileValue ? 'aligned' : 'mismatch_profile_wins')
      : 'partial',
    note: profileValue
      ? 'workspace/user-profile.json is user-edited and wins when values differ.'
      : 'No canonical user-profile experience level found; falling back to settings.json.',
  };
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
  const settingsPath = path.join(ROOT_DIR, 'ui', 'settings.json');
  const userProfilePath = path.join(ROOT_DIR, 'workspace', 'user-profile.json');
  const runtimeDir = path.join(ROOT_DIR, '.squidrun', 'runtime');
  const supervisorStatusPath = path.join(runtimeDir, 'supervisor-status.json');
  const sessionStatePath = path.join(runtimeDir, 'session-state.json');
  const knownDevicesPath = path.join(ROOT_DIR, '.squidrun', 'bridge', 'known-devices.json');

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
  const settings = readJsonFileSafe(settingsPath);
  const userProfile = readJsonFileSafe(userProfilePath);
  const supervisorStatus = readJsonFileSafe(supervisorStatusPath);
  const sessionState = readJsonFileSafe(sessionStatePath);
  const knownDevices = readJsonFileSafe(knownDevicesPath);
  const envMap = readEnvMap(envPath);
  const envKeys = parseEnvKeys(envPath);
  const appLogTail = tailFile(appLogPath, APP_LOG_TAIL_LINES);
  const [wsTest, paneStatus] = await Promise.all([
    checkWebSocketConnectivity(),
    queryPaneStatus(),
  ]);
  const evidenceCounts = countEvidenceLedgerRows(evidencePath);
  const paneRoleModelMapping = buildPaneRoleModelMapping(settings, paneStatus);
  const supervisorState = buildSupervisorState(supervisorStatus, sessionState);
  const bridgeStatus = buildBridgeStatus(runtimeDir, envMap, knownDevices);
  const experiencePrecedence = buildExperiencePrecedence(settings, userProfile);

  printSection('Platform', platformInfo);
  printSection('Node', nodeInfo);
  printSection('App Status', appStatus);
  printSection('Pane Role/Model Mapping', paneRoleModelMapping);
  printSection('Supervisor / Daemon Task State', supervisorState);
  printSection('Bridge / Relay Status', bridgeStatus);
  printSection('User Experience Level Precedence', experiencePrecedence);
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
