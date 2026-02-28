const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');
const log = require('../logger');
const { resolveCoordPath, getProjectRoot } = require('../../config');
const { getLocalDeviceId, isCrossDeviceEnabled } = require('../cross-device-target');

const RELAY_TIMEOUT_MS = 2500;
const EXPECTED_NODE_MAJOR = 22;
const CLI_TIMEOUT_MS = 2000;
const LOGIN_SHELL_PATH_TIMEOUT_MS = 3000;

function collectPathEntries(...rawValues) {
  const seen = new Set();
  const entries = [];
  for (const value of rawValues) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const parts = value.split(path.delimiter);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      entries.push(trimmed);
    }
  }
  return entries;
}

function resolveLoginShellPath() {
  if (process.platform === 'win32') return '';
  const shellsToTry = process.platform === 'darwin'
    ? [process.env.SHELL, '/bin/zsh', '/bin/bash']
    : [process.env.SHELL];
  for (const shellPath of shellsToTry) {
    if (typeof shellPath !== 'string' || !shellPath.trim()) continue;
    const result = spawnSync(shellPath.trim(), ['-ilc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: LOGIN_SHELL_PATH_TIMEOUT_MS,
    });
    const output = String(result?.stdout || '').trim();
    if (result?.status === 0 && output) return output;
  }
  return '';
}

function resolvePreflightPath() {
  const projectRoot = typeof getProjectRoot === 'function' ? getProjectRoot() : '';
  const packagedWorkspaceBin = path.join(os.homedir(), 'SquidRun', '.squidrun', 'bin');
  const projectWorkspaceBin = projectRoot ? path.join(projectRoot, '.squidrun', 'bin') : '';
  const extraPaths = process.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')]
    : [];
  const loginShellPath = resolveLoginShellPath();
  return collectPathEntries(
    packagedWorkspaceBin,
    projectWorkspaceBin,
    ...extraPaths,
    loginShellPath,
    process.env.PATH || ''
  ).join(path.delimiter);
}

function resolvePreflightEnv() {
  const resolvedPath = resolvePreflightPath();
  return {
    ...process.env,
    PATH: resolvedPath || process.env.PATH || '',
  };
}

function makeCheck(id, label, ok, detail, extra = {}) {
  return {
    id,
    label,
    ok: ok === true,
    status: ok ? 'pass' : 'fail',
    detail: String(detail || ''),
    ...extra,
  };
}

function detectCliBinary(binaryName, env = process.env) {
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'where' : 'which';
  const result = spawnSync(command, [binaryName], {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env,
  });

  const foundPath = String(result?.stdout || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || null;
  const ok = result?.status === 0 && Boolean(foundPath);
  return makeCheck(
    `cli:${binaryName}`,
    `CLI: ${binaryName}`,
    ok,
    ok ? `Found at ${foundPath}` : `${binaryName} not found in PATH`
  );
}

function parseNodeVersionOutput(rawOutput) {
  const text = String(rawOutput || '').trim();
  if (!text) return null;
  const match = text.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    normalized: `v${match[1]}.${match[2]}.${match[3]}`,
  };
}

function checkSystemNodeVersion(env = process.env) {
  const result = spawnSync('node', ['-v'], {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env,
  });
  const stdout = String(result?.stdout || '').trim();
  const stderr = String(result?.stderr || '').trim();
  const output = [stdout, stderr].filter(Boolean).join('\n').trim();
  const parsed = parseNodeVersionOutput(output);
  const major = parsed?.major;
  const ok = result?.status === 0 && Number.isFinite(major) && major >= EXPECTED_NODE_MAJOR;
  const detectedVersion = parsed?.normalized || null;
  const outputSummary = output.split(/\r?\n/).find(Boolean) || '';
  const notFound = result?.error?.code === 'ENOENT';
  let detail = '';
  if (ok) {
    detail = `Detected ${detectedVersion} (meets >= v${EXPECTED_NODE_MAJOR})`;
  } else if (notFound) {
    detail = `Detected unknown (node binary not found in PATH; requires >= v${EXPECTED_NODE_MAJOR} for CLI SQLite tooling)`;
  } else {
    detail = `Detected ${detectedVersion || outputSummary || 'unknown'} (requires >= v${EXPECTED_NODE_MAJOR} for CLI SQLite tooling)`;
  }
  return makeCheck(
    'system-node',
    'System Node Version',
    ok,
    detail,
    {
      detectedVersion,
      requiredMajor: EXPECTED_NODE_MAJOR,
      rawOutput: output || null,
      errorCode: result?.error?.code || null,
    }
  );
}

function checkWorkspaceWritable() {
  const probePath = resolveCoordPath(path.join('runtime', `preflight-write-${Date.now()}.tmp`), { forWrite: true });
  try {
    fs.mkdirSync(path.dirname(probePath), { recursive: true });
    fs.writeFileSync(probePath, 'ok', 'utf8');
    fs.unlinkSync(probePath);
    return makeCheck('workspace-writable', 'Workspace Writable', true, `Writable: ${path.dirname(probePath)}`);
  } catch (err) {
    return makeCheck('workspace-writable', 'Workspace Writable', false, `Write failed: ${err?.message || err}`);
  }
}

function checkEnvVariables() {
  const crossDeviceEnabled = isCrossDeviceEnabled(process.env);
  const relayUrl = String(process.env.SQUIDRUN_RELAY_URL || '').trim();
  const deviceId = getLocalDeviceId(process.env);

  const missing = [];
  if (crossDeviceEnabled && !relayUrl) missing.push('SQUIDRUN_RELAY_URL');
  if (crossDeviceEnabled && !deviceId) missing.push('SQUIDRUN_DEVICE_ID');

  const ok = missing.length === 0;
  const detail = ok
    ? `Required vars present${crossDeviceEnabled ? ' for cross-device mode' : ''}`
    : `Missing required env vars: ${missing.join(', ')}`;

  return makeCheck('env-vars', 'Environment Variables', ok, detail, {
    crossDeviceEnabled,
    relayUrl: relayUrl || null,
    deviceId: deviceId || null,
  });
}

function checkRelayConnectivity() {
  return new Promise((resolve) => {
    const relayUrl = String(process.env.SQUIDRUN_RELAY_URL || '').trim();
    if (!relayUrl) {
      resolve(makeCheck('relay', 'Relay Connectivity', false, 'SQUIDRUN_RELAY_URL is not set'));
      return;
    }

    let settled = false;
    let ws = null;
    const finish = (check) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (ws) {
        try { ws.terminate(); } catch (_) {}
      }
      resolve(check);
    };

    const timer = setTimeout(() => {
      finish(makeCheck('relay', 'Relay Connectivity', false, `Connection timed out after ${RELAY_TIMEOUT_MS}ms`));
    }, RELAY_TIMEOUT_MS);

    try {
      ws = new WebSocket(relayUrl, { handshakeTimeout: RELAY_TIMEOUT_MS });
      ws.once('open', () => {
        finish(makeCheck('relay', 'Relay Connectivity', true, `Connected to ${relayUrl}`));
      });
      ws.once('error', (err) => {
        finish(makeCheck('relay', 'Relay Connectivity', false, `Connect failed: ${err?.message || err}`));
      });
    } catch (err) {
      finish(makeCheck('relay', 'Relay Connectivity', false, `Connect failed: ${err?.message || err}`));
    }
  });
}

async function runPreflightChecks() {
  const preflightEnv = resolvePreflightEnv();
  const checks = [
    checkEnvVariables(),
    detectCliBinary('claude', preflightEnv),
    detectCliBinary('codex', preflightEnv),
    detectCliBinary('gemini', preflightEnv),
    await checkRelayConnectivity(),
    checkWorkspaceWritable(),
    checkSystemNodeVersion(preflightEnv),
  ];

  const passed = checks.filter(check => check.ok).length;
  const failed = checks.length - passed;
  return {
    ok: failed === 0,
    generatedAt: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()}`,
    checks,
    summary: {
      total: checks.length,
      passed,
      failed,
    },
  };
}

function registerPreflightHandlers(ctx) {
  const { ipcMain } = ctx;
  if (!ipcMain) return;

  ipcMain.handle('run-preflight-check', async () => {
    try {
      return await runPreflightChecks();
    } catch (err) {
      log.error('Preflight', 'Failed running startup preflight checks', err);
      return {
        ok: false,
        generatedAt: new Date().toISOString(),
        checks: [],
        summary: { total: 0, passed: 0, failed: 1 },
        error: err?.message || 'preflight_failed',
      };
    }
  });
}

function unregisterPreflightHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  ipcMain.removeHandler('run-preflight-check');
}

registerPreflightHandlers.unregister = unregisterPreflightHandlers;

module.exports = {
  registerPreflightHandlers,
  runPreflightChecks,
};
