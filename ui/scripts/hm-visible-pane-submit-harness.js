#!/usr/bin/env node
'use strict';

/**
 * hm-visible-pane-submit-harness
 *
 * Sends a prompt into a visible SquidRun pane, waits for real terminal activity,
 * captures the exact app window/pane through Electron's screenshot route, and
 * writes provenance the outbound surface guard can validate.
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { DaemonClient } = require('../daemon-client');
const { ROLE_ID_MAP, getSquidrunRoot } = require('../config');
const { getProfileWebSocketPort } = require('../profile');
const { run: captureScreenshot } = require('./hm-screenshot');
const {
  TRUSTQUOTE_WORKSPACE_KEY,
  isTrustQuoteWorkspace,
} = require('../modules/work-room-terminal-visibility');

const MANIFEST_SCHEMA = 'squidrun.visible_pane_submit_harness.v0';
const PRODUCER = 'hm-visible-pane-submit-harness';
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 15000;
const DEFAULT_WAIT_MS = 8000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_OUTPUT_DELTA_CHARS = 20;

const TRUSTQUOTE_PANE_BY_ROLE = Object.freeze({
  builder: 'trustquote-builder',
  oracle: 'trustquote-oracle',
});

function usage() {
  console.log('Usage: node hm-visible-pane-submit-harness.js run --window-key <key> --target-role <role> --message <text> [options]');
  console.log('Options:');
  console.log('  --pane-id <id>              Explicit pane/terminal id');
  console.log('  --wait-ms <ms>              Max wait for output after submit (default 8000)');
  console.log('  --poll-ms <ms>              Terminal poll interval (default 500)');
  console.log('  --label <name>              Artifact label (default visible-pane-submit)');
  console.log('  --artifact-root <path>      Root for run artifacts (default .squidrun/screenshots/visible-pane-submit)');
  console.log('  --port <port>               WebSocket port (default from window profile)');
  console.log('  --role <role>               Sender role (default builder)');
  console.log('  --timeout <ms>              WebSocket response timeout (default 15000)');
}

function parseArgs(argv = []) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[index + 1];
    const value = (!next || String(next).startsWith('--')) ? true : next;
    if (value !== true) index += 1;
    options.set(key, value);
  }
  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options.has(key)) return fallback;
  return options.get(key);
}

function asText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function asPositiveInt(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function safeSegment(value, fallback = 'run') {
  return asText(value, fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

function resolveDefaultArtifactRoot(options = {}) {
  if (asText(options.artifactRoot, '')) return path.resolve(options.artifactRoot);
  const root = asText(options.projectPath, '') || getSquidrunRoot();
  return path.join(path.resolve(root), '.squidrun', 'screenshots', 'visible-pane-submit');
}

function resolvePaneId({ windowKey = 'main', targetRole = '', paneId = '' } = {}) {
  const explicit = asText(paneId, '');
  if (explicit) return explicit;
  const normalizedWindow = asText(windowKey, 'main').toLowerCase();
  const normalizedRole = asText(targetRole, '').toLowerCase();
  if (isTrustQuoteWorkspace(normalizedWindow)) {
    return TRUSTQUOTE_PANE_BY_ROLE[normalizedRole] || '';
  }
  return asText(ROLE_ID_MAP?.[normalizedRole], '');
}

function collectHarnessOptions(parsed) {
  const options = parsed?.options || new Map();
  const command = asText(parsed?.positional?.[0], 'run').toLowerCase();
  const windowKey = asText(getOption(options, 'window-key', getOption(options, 'window', 'main')), 'main').toLowerCase();
  const targetRole = asText(getOption(options, 'target-role', getOption(options, 'target', '')), '').toLowerCase();
  const paneId = resolvePaneId({
    windowKey,
    targetRole,
    paneId: getOption(options, 'pane-id', getOption(options, 'pane', '')),
  });
  const message = asText(getOption(options, 'message', parsed?.positional?.slice(1).join(' ')), '');
  return {
    command,
    windowKey,
    targetRole,
    paneId,
    terminalId: paneId,
    message,
    role: asText(getOption(options, 'role', 'builder'), 'builder').toLowerCase(),
    port: asPositiveInt(
      getOption(options, 'port', ''),
      getProfileWebSocketPort(isTrustQuoteWorkspace(windowKey) ? TRUSTQUOTE_WORKSPACE_KEY : windowKey)
    ),
    waitMs: asPositiveInt(getOption(options, 'wait-ms', ''), DEFAULT_WAIT_MS),
    pollMs: asPositiveInt(getOption(options, 'poll-ms', ''), DEFAULT_POLL_MS),
    timeoutMs: asPositiveInt(getOption(options, 'timeout', ''), DEFAULT_RESPONSE_TIMEOUT_MS),
    connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    label: safeSegment(getOption(options, 'label', 'visible-pane-submit'), 'visible-pane-submit'),
    artifactRoot: resolveDefaultArtifactRoot({
      artifactRoot: getOption(options, 'artifact-root', ''),
      projectPath: getOption(options, 'project-path', ''),
    }),
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function waitForMatch(ws, predicate, timeoutMs, timeoutLabel) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutLabel || 'Timed out waiting for socket response'));
    }, Math.max(100, Number(timeoutMs) || DEFAULT_RESPONSE_TIMEOUT_MS));

    const onMessage = (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Socket closed before response'));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    function cleanup() {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    }
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

function closeSocket(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === ws.CLOSED) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      try {
        ws.terminate();
      } catch {}
      resolve();
    }, 250);
    ws.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      ws.close();
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function sendHarnessMessage(params, deps = {}) {
  const WebSocketImpl = deps.WebSocketImpl || WebSocket;
  const requestId = `visible-submit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const messageId = `visible-submit-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ws = new WebSocketImpl(`ws://127.0.0.1:${params.port}`);
  await waitForMatch(ws, (msg) => msg.type === 'welcome', params.connectTimeoutMs, 'Connection timeout');
  ws.send(JSON.stringify({ type: 'register', role: params.role }));
  await waitForMatch(ws, (msg) => msg.type === 'registered', params.connectTimeoutMs, 'Registration timeout');

  ws.send(JSON.stringify({
    type: 'send',
    target: params.targetRole,
    content: params.message,
    requestId,
    messageId,
    traceContext: {
      messageId,
      traceId: messageId,
      correlationId: messageId,
      source: PRODUCER,
      windowKey: params.windowKey,
      paneId: params.paneId,
    },
    metadata: {
      windowKey: params.windowKey,
      targetRole: params.targetRole,
      visiblePaneSubmitHarness: true,
    },
  }));

  const response = await waitForMatch(
    ws,
    (msg) => msg.type === 'response' && msg.requestId === requestId,
    params.timeoutMs,
    `Response timeout after ${params.timeoutMs}ms`
  );
  await closeSocket(ws);
  return {
    requestId,
    messageId,
    result: response?.result || null,
    ok: response?.ok !== false,
  };
}

function waitForDaemonEvent(emitter, eventName, predicate, timeoutMs = 2000) {
  if (!emitter || typeof emitter.on !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, Math.max(100, Number(timeoutMs) || 2000));
    const onEvent = (...args) => {
      const result = predicate(...args);
      if (!result) return;
      cleanup();
      resolve(result);
    };
    function cleanup() {
      clearTimeout(timer);
      if (typeof emitter.off === 'function') emitter.off(eventName, onEvent);
      else if (typeof emitter.removeListener === 'function') emitter.removeListener(eventName, onEvent);
    }
    emitter.on(eventName, onEvent);
  });
}

async function readTerminalSnapshot(client, paneId, timeoutMs = 2000) {
  const attached = waitForDaemonEvent(
    client,
    'attached',
    (eventPaneId, pid, alive, scrollback) => {
      if (String(eventPaneId) !== String(paneId)) return null;
      return {
        paneId: String(eventPaneId),
        pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
        alive: alive !== false,
        scrollback: typeof scrollback === 'string' ? scrollback : '',
      };
    },
    timeoutMs
  );
  if (typeof client.attach === 'function') client.attach(paneId);
  const result = await attached;
  if (result) return result;
  const fallback = typeof client.getTerminal === 'function' ? client.getTerminal(paneId) : null;
  return {
    paneId,
    pid: Number.isFinite(Number(fallback?.pid)) ? Number(fallback.pid) : null,
    alive: fallback?.alive !== false,
    scrollback: typeof fallback?.scrollback === 'string' ? fallback.scrollback : '',
  };
}

async function waitForPostSubmitOutput(client, paneId, beforeSnapshot, sentAtMs, options = {}) {
  const waitMs = Math.max(100, Number(options.waitMs) || DEFAULT_WAIT_MS);
  const pollMs = Math.max(100, Number(options.pollMs) || DEFAULT_POLL_MS);
  const minDeltaChars = Math.max(1, Number(options.minDeltaChars) || DEFAULT_OUTPUT_DELTA_CHARS);
  const beforeLength = String(beforeSnapshot?.scrollback || '').length;
  const deadline = Date.now() + waitMs;
  let latest = beforeSnapshot || null;
  let outputDeltaChars = 0;
  while (Date.now() <= deadline) {
    await wait(pollMs);
    latest = await readTerminalSnapshot(client, paneId, Math.min(2000, pollMs + 500));
    outputDeltaChars = Math.max(0, String(latest?.scrollback || '').length - beforeLength);
    const lastActivity = Number(typeof client.getLastActivity === 'function' ? client.getLastActivity(paneId) : 0) || 0;
    if (outputDeltaChars >= minDeltaChars || lastActivity >= sentAtMs) {
      break;
    }
  }
  const lastActivity = Number(typeof client.getLastActivity === 'function' ? client.getLastActivity(paneId) : 0) || 0;
  return {
    snapshot: latest,
    outputDeltaChars,
    lastActivityAtMs: lastActivity || null,
    observedOutputAfterSubmit: outputDeltaChars >= minDeltaChars || lastActivity >= sentAtMs,
  };
}

function buildRunLayout(params, nowMs = Date.now()) {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const runId = `${safeSegment(params.label, 'visible-pane-submit')}-${safeSegment(params.windowKey, 'main')}-${safeSegment(params.paneId, 'pane')}-${stamp}`;
  const runDir = path.join(path.resolve(params.artifactRoot), runId);
  return {
    runId,
    runDir,
    currentDir: path.join(runDir, 'current'),
    manifestPath: path.join(runDir, 'manifest.json'),
    summaryPath: path.join(runDir, 'summary.json'),
    screenshotPath: path.join(runDir, 'current', 'screenshot.png'),
  };
}

function tailText(value, maxChars = 1200) {
  const text = String(value || '');
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

function buildObservedStateSummary(params, submit, beforeSnapshot, outputResult) {
  const delivery = submit?.result || {};
  const beforeLength = String(beforeSnapshot?.scrollback || '').length;
  const afterLength = String(outputResult?.snapshot?.scrollback || '').length;
  const delta = Math.max(0, afterLength - beforeLength);
  const accepted = delivery.accepted !== false;
  const verified = delivery.verified === true;
  const outputObserved = outputResult?.observedOutputAfterSubmit === true;
  return [
    `target=${params.targetRole}`,
    `pane=${params.paneId}`,
    `window=${params.windowKey}`,
    `delivery=${delivery.status || (verified ? 'verified' : (accepted ? 'accepted' : 'unknown'))}`,
    `outputDeltaChars=${delta}`,
    outputObserved ? 'postSubmitOutputObserved=true' : 'postSubmitOutputObserved=false',
  ].join('; ');
}

function writeHarnessManifest(params, layout, captureResult, submit, beforeSnapshot, outputResult, nowMs = Date.now()) {
  const generatedAt = new Date(nowMs).toISOString();
  const screenshotPath = path.resolve(layout.screenshotPath);
  const beforeLength = String(beforeSnapshot?.scrollback || '').length;
  const afterLength = String(outputResult?.snapshot?.scrollback || '').length;
  const observedStateSummary = buildObservedStateSummary(params, submit, beforeSnapshot, outputResult);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    producer: PRODUCER,
    runId: layout.runId,
    generatedAt,
    windowKey: params.windowKey,
    paneId: params.paneId,
    terminalId: params.terminalId || params.paneId,
    targetRole: params.targetRole,
    screenshotPath,
    observedStateSummary,
    surface: {
      kind: 'visible_pane_submit',
      source: 'same-window-user-surface',
      sameWindowUserSurface: true,
      forbiddenSubstitute: false,
      windowKey: params.windowKey,
      paneId: params.paneId,
      terminalId: params.terminalId || params.paneId,
      targetRole: params.targetRole,
    },
    capture: {
      provider: 'squidrun-app-websocket-screenshot',
      source: 'electron.capturePage',
      requestedWindowKey: params.windowKey,
      windowKey: params.windowKey,
      requestedPaneId: params.paneId,
      paneId: captureResult?.paneId || params.paneId,
      scope: captureResult?.scope || 'pane',
      returnedPath: captureResult?.path || null,
    },
    submit: {
      requestId: submit?.requestId || null,
      messageId: submit?.messageId || null,
      deliveryId: submit?.result?.deliveryId || null,
      accepted: submit?.result?.accepted === true,
      verified: submit?.result?.verified === true,
      status: submit?.result?.status || null,
      sentAt: new Date(Number(submit?.sentAtMs || nowMs)).toISOString(),
      waitMs: params.waitMs,
    },
    terminal: {
      before: {
        paneId: beforeSnapshot?.paneId || params.paneId,
        alive: beforeSnapshot?.alive !== false,
        scrollbackLength: beforeLength,
      },
      after: {
        paneId: outputResult?.snapshot?.paneId || params.paneId,
        alive: outputResult?.snapshot?.alive !== false,
        scrollbackLength: afterLength,
        lastActivityAtMs: outputResult?.lastActivityAtMs || null,
      },
      outputDeltaChars: Math.max(0, afterLength - beforeLength),
      observedOutputAfterSubmit: outputResult?.observedOutputAfterSubmit === true,
      postTail: tailText(outputResult?.snapshot?.scrollback || ''),
    },
    files: {
      screenshot: screenshotPath,
      manifest: path.resolve(layout.manifestPath),
      summary: path.resolve(layout.summaryPath),
    },
    summary: {
      screenshotPath,
      observedStateSummary,
    },
  };
  fs.mkdirSync(layout.currentDir, { recursive: true });
  if (captureResult?.path && path.resolve(captureResult.path) !== screenshotPath) {
    fs.copyFileSync(captureResult.path, screenshotPath);
  } else if (!fs.existsSync(screenshotPath)) {
    throw new Error('capture did not produce screenshot file');
  }
  fs.writeFileSync(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(layout.summaryPath, `${JSON.stringify(manifest.summary, null, 2)}\n`, 'utf8');
  return manifest;
}

async function runHarness(params, deps = {}) {
  if (!params.windowKey) throw new Error('windowKey is required');
  if (!params.targetRole) throw new Error('targetRole is required');
  if (!params.paneId) throw new Error('paneId is required');
  if (!params.message) throw new Error('message is required');

  const nowMs = typeof deps.nowMs === 'function' ? deps.nowMs() : Date.now();
  const DaemonClientImpl = deps.DaemonClient || DaemonClient;
  const client = deps.daemonClient || new DaemonClientImpl({
    profileName: isTrustQuoteWorkspace(params.windowKey) ? TRUSTQUOTE_WORKSPACE_KEY : undefined,
  });
  if (typeof client.connect === 'function') {
    const connected = await client.connect();
    if (connected === false) throw new Error('terminal daemon unavailable');
  }

  const before = await readTerminalSnapshot(client, params.paneId, 2000);
  const sentAtMs = typeof deps.nowMs === 'function' ? deps.nowMs() : Date.now();
  const submit = deps.sendHarnessMessage
    ? await deps.sendHarnessMessage(params)
    : await sendHarnessMessage(params, deps);
  submit.sentAtMs = sentAtMs;
  const outputResult = await waitForPostSubmitOutput(client, params.paneId, before, sentAtMs, {
    waitMs: params.waitMs,
    pollMs: params.pollMs,
  });
  const captureRun = deps.captureScreenshot || captureScreenshot;
  const captureResponse = await captureRun({
    windowKey: params.windowKey,
    paneId: params.paneId,
  }, {
    role: params.role,
    port: params.port,
    timeoutMs: params.timeoutMs,
  });
  const captureResult = captureResponse?.result || captureResponse;
  if (!captureResult?.success || !captureResult?.path) {
    throw new Error(`screenshot capture failed: ${captureResult?.error || 'unknown_error'}`);
  }

  const layout = buildRunLayout(params, nowMs);
  const manifest = writeHarnessManifest(params, layout, captureResult, submit, before, outputResult, nowMs);
  if (typeof client.disconnect === 'function' && !deps.daemonClient) client.disconnect();
  return {
    ok: true,
    runId: layout.runId,
    runDir: layout.runDir,
    screenshotPath: manifest.screenshotPath,
    manifestPath: layout.manifestPath,
    summaryPath: layout.summaryPath,
    observedStateSummary: manifest.observedStateSummary,
    submit: manifest.submit,
    terminal: {
      outputDeltaChars: manifest.terminal.outputDeltaChars,
      observedOutputAfterSubmit: manifest.terminal.observedOutputAfterSubmit,
    },
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.positional.length === 0 || parsed.positional.includes('--help') || parsed.positional.includes('-h')) {
    usage();
    process.exit(0);
  }
  const options = collectHarnessOptions(parsed);
  if (options.command !== 'run') {
    throw new Error(`unsupported command: ${options.command}`);
  }
  const result = await runHarness(options);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`hm-visible-pane-submit-harness failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  MANIFEST_SCHEMA,
  PRODUCER,
  parseArgs,
  collectHarnessOptions,
  resolvePaneId,
  buildRunLayout,
  buildObservedStateSummary,
  writeHarnessManifest,
  runHarness,
};
