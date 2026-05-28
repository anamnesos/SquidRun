/**
 * hm-send retry/backoff integration tests
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { WORKSPACE_PATH, resolveCoordPath } = require('../config');
const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');

const FALLBACK_MESSAGE_ID_PREFIX = '[HM-MESSAGE-ID:';

function findNearestProjectLinkFile(startDir) {
  let currentDir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(currentDir, '.squidrun', 'link.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function getTriggerPath(filename, options = {}) {
  const startDir = options.cwd || path.join(__dirname, '..');
  const linkPath = findNearestProjectLinkFile(startDir);
  if (linkPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(linkPath, 'utf8'));
      const fallbackProjectPath = path.resolve(path.join(path.dirname(linkPath), '..'));
      const declaredProjectPath = typeof parsed?.workspace === 'string' && parsed.workspace.trim()
        ? path.resolve(parsed.workspace.trim())
        : fallbackProjectPath;
      const projectPath = fs.existsSync(declaredProjectPath)
        ? declaredProjectPath
        : fallbackProjectPath;
      return path.join(projectPath, '.squidrun', 'triggers', filename);
    } catch {
      // Fall through to config-based fallback below.
    }
  }
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('triggers', filename), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, 'triggers', filename);
}

function runHmSend(args, env = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-send.js');
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: {
        ...process.env,
        SQUIDRUN_ROLE: '',
        SQUIDRUN_PANE_ID: '',
        ...env,
      },
      cwd: options.cwd || path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    if (options.stdin !== undefined) {
      child.stdin.end(String(options.stdin));
    } else {
      child.stdin.end();
    }
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function extractFallbackPath(stderr) {
  const match = String(stderr || '').match(/Wrote trigger fallback:\s*([^\r\n]+)/i);
  return match && match[1] ? match[1].trim() : null;
}

function createLinkedProject(options = {}) {
  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-send-guard-'));
  const includeSquidrunRoot = options.squidrunRoot !== null;
  const squidrunRoot = typeof options.squidrunRoot === 'string'
    ? options.squidrunRoot
    : path.join(__dirname, '..', '..');
  fs.mkdirSync(path.join(tempProject, '.squidrun'), { recursive: true });
  const linkPayload = {
    workspace: tempProject,
    version: 1,
  };
  if (includeSquidrunRoot) {
    linkPayload.squidrun_root = squidrunRoot;
  }
  fs.writeFileSync(path.join(tempProject, '.squidrun', 'link.json'), JSON.stringify(linkPayload, null, 2));
  return tempProject;
}

function writeAppStatus(tempProject, sessionId = 'app-session-777') {
  fs.writeFileSync(path.join(tempProject, '.squidrun', 'app-status.json'), JSON.stringify({
    session_id: sessionId,
  }, null, 2));
  return sessionId;
}

function seedCommsJournal(tempProject, entry = {}, nowMs = Date.now()) {
  const dbPath = path.join(tempProject, '.squidrun', 'runtime', 'evidence-ledger.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new EvidenceLedgerStore({ dbPath, enabled: true });
  expect(store.init().ok).toBe(true);
  try {
    const result = store.upsertCommsJournal(entry, { nowMs });
    expect(result.ok).toBe(true);
  } finally {
    store.close();
  }
  return dbPath;
}

function createTelegramHttpsMockPreload() {
  const tempRoot = fs.mkdtempSync(path.join(path.parse(__dirname).root, 'hm-send-telegram-mock-'));
  const preloadPath = path.join(tempRoot, 'mock-telegram-https.js');
fs.writeFileSync(preloadPath, `
const https = require('https');
const fs = require('fs');
const { EventEmitter } = require('events');
const originalRequest = https.request;
https.request = function patchedTelegramRequest(options, callback) {
  const hostname = typeof options === 'string'
    ? new URL(options).hostname
    : (options && options.hostname);
  if (hostname !== 'api.telegram.org') {
    return originalRequest.apply(this, arguments);
  }
  const request = new EventEmitter();
  let body = '';
  request.write = (chunk) => {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
  };
  request.end = () => {
    const response = new EventEmitter();
    response.statusCode = Number(process.env.HM_SEND_TELEGRAM_MOCK_STATUS_CODE || 200);
    process.nextTick(() => {
      if (process.env.HM_SEND_TELEGRAM_MOCK_LOG) {
        fs.appendFileSync(process.env.HM_SEND_TELEGRAM_MOCK_LOG, JSON.stringify({
          path: options && options.path,
          body,
        }) + '\\n');
      }
      callback(response);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch {}
        response.emit('data', JSON.stringify({
          ok: true,
          result: { message_id: 77, chat: { id: parsed.chat_id || 12345 } },
        }));
      } else {
        response.emit('data', JSON.stringify({
          ok: false,
          description: 'mock telegram failure',
        }));
      }
      response.emit('end');
    });
  };
  request.setTimeout = () => request;
  request.destroy = () => {};
  return request;
};
`, 'utf8');
  return { tempRoot, preloadPath };
}

async function startAckServer(sendAttempts = []) {
  let server;
  await new Promise((resolve, reject) => {
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    server.once('listening', resolve);
    server.once('error', reject);
  });

  server.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'register') {
        ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
        return;
      }
      if (msg.type === 'health-check') {
        ws.send(JSON.stringify({
          type: 'health-check-result',
          requestId: msg.requestId,
          target: msg.target,
          healthy: true,
          status: 'healthy',
          staleThresholdMs: 60000,
          timestamp: Date.now(),
        }));
        return;
      }
      if (msg.type === 'send') {
        sendAttempts.push(msg);
        ws.send(JSON.stringify({
          type: 'send-ack',
          messageId: msg.messageId,
          ok: true,
          accepted: true,
          queued: true,
          verified: true,
          userVisible: true,
          status: 'delivered.verified',
          timestamp: Date.now(),
        }));
      }
    });
  });

  return {
    server,
    port: server.address().port,
  };
}

describe('hm-send retry behavior', () => {
  test('blocks permission-ask phrases before websocket send and logs the violation', async () => {
    const tempProject = createLinkedProject();
    const logPath = path.join(tempProject, '.squidrun', 'runtime', 'permission-ask-violations.jsonl');

    try {
      const result = await runHmSend(
        ['architect', 'test should I send this?', '--timeout', '80', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: '1' },
        { cwd: tempProject }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('BLOCKED: permission-ask phrase detected');
      expect(result.stderr).toContain('Rewrite as a decision');
      expect(fs.existsSync(logPath)).toBe(true);
      const entries = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: 'permission_ask',
        targetRole: 'architect',
        phrase: 'should I',
      });
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test('allows permission-ask phrases with bypass flag and logs the bypass', async () => {
    const tempProject = createLinkedProject();
    const sendAttempts = [];
    const { server, port } = await startAckServer(sendAttempts);
    const bypassLogPath = path.join(tempProject, '.squidrun', 'runtime', 'permission-ask-bypasses.jsonl');

    try {
      const result = await runHmSend(
        ['architect', 'test should I send this?', '--bypass-guard', '--timeout', '80', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: String(port) },
        { cwd: tempProject }
      );

      expect(result.code).toBe(0);
      expect(sendAttempts).toHaveLength(1);
      expect(result.stdout).toContain('Delivered to architect');
      expect(fs.existsSync(bypassLogPath)).toBe(true);
      const entries = fs.readFileSync(bypassLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: 'permission_ask_bypass',
        targetRole: 'architect',
        phrase: 'should I',
      });
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('blocks user-facing done or visible claims without a surface artifact before send', async () => {
    const tempProject = createLinkedProject({ squidrunRoot: null });
    writeAppStatus(tempProject, 'app-session-781');
    const logPath = path.join(tempProject, '.squidrun', 'runtime', 'surface-claim-violations.jsonl');

    try {
      const result = await runHmSend(
        ['telegram', 'Done: the demo invoice is visible in the TrustQuote dashboard.', '--role', 'architect', '--timeout', '80', '--retries', '0', '--no-fallback'],
        {
          HM_SEND_PORT: '65534',
          SQUIDRUN_PROJECT_ROOT: tempProject,
        },
        { cwd: tempProject }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('BLOCKED: user-facing done/visible claim has no fresh visible-pane-submit artifact');
      expect(result.stderr).toContain('This blocks the claim, not the work needed to make it true');
      expect(fs.existsSync(logPath)).toBe(true);
      const [entry] = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(entry).toMatchObject({
        violation_class: 'surface_done_claim_without_artifact',
        targetRole: 'telegram',
      });
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test('writes delivery trace events with payload bytes and ACK timing', async () => {
    const tempProject = createLinkedProject();
    const sendAttempts = [];
    const { server, port } = await startAckServer(sendAttempts);
    const tracePath = path.join(tempProject, '.squidrun', 'coord', 'bus-reliability-trace.jsonl');

    try {
      const message = '(TEST #9): trace sentinel head middle tail';
      const result = await runHmSend(
        ['architect', message, '--timeout', '120', '--retries', '0', '--no-fallback'],
        {
          HM_SEND_PORT: String(port),
          SQUIDRUN_BUS_TRACE_PATH: tracePath,
        },
        { cwd: tempProject }
      );

      expect(result.code).toBe(0);
      expect(sendAttempts).toHaveLength(1);
      expect(sendAttempts[0].traceContext).toEqual(expect.objectContaining({
        messageId: expect.stringMatching(/^hm-/),
        traceId: expect.stringMatching(/^hm-/),
      }));
      expect(fs.existsSync(tracePath)).toBe(true);
      const entries = fs.readFileSync(tracePath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      const attempt = entries.find((entry) => entry.eventType === 'hm_send_attempt');
      const ack = entries.find((entry) => entry.eventType === 'hm_send_ack');
      const complete = entries.find((entry) => entry.eventType === 'hm_send_complete');

      expect(attempt).toEqual(expect.objectContaining({
        recipient: 'architect',
        payloadBytes: Buffer.byteLength(message, 'utf8'),
        dispatchBytes: expect.any(Number),
      }));
      expect(ack).toEqual(expect.objectContaining({
        recipient: 'architect',
        success: true,
        ackLatencyMs: expect.any(Number),
      }));
      expect(complete).toEqual(expect.objectContaining({
        recipient: 'architect',
        success: true,
        delivered: true,
        payloadFingerprint: expect.objectContaining({
          sha256: expect.any(String),
          head: expect.stringContaining('(TEST #9)'),
          tail: expect.stringContaining('tail'),
        }),
      }));
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('blocks case context in the main profile and logs the violation', async () => {
    const tempProject = createLinkedProject();
    const logPath = path.join(tempProject, '.squidrun', 'runtime', 'context-leak-violations.jsonl');

    try {
      const result = await runHmSend(
        ['architect', '(BUILDER #1): PrivateCase status update', '--timeout', '80', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: '1', SQUIDRUN_PROFILE: 'main' },
        { cwd: tempProject }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('BLOCKED: Scoped/case context in main pane');
      expect(fs.existsSync(logPath)).toBe(true);
      const entries = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: 'context_leak',
        profile: 'main',
        phrase: 'PrivateCase',
      });
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test('allows internal operational routing messages that name the scoped side window', async () => {
    const tempProject = createLinkedProject();
    const sendAttempts = [];
    const { server, port } = await startAckServer(sendAttempts);
    const logPath = path.join(tempProject, '.squidrun', 'runtime', 'context-leak-violations.jsonl');

    try {
      const result = await runHmSend(
        [
          'builder',
          '(ARCH #16): TASK - Scoped window slow startup + Telegram lane sanity. OBJECTIVE: diagnose queued replay and scoped windowKey routing.',
          '--timeout',
          '80',
          '--retries',
          '0',
          '--no-fallback',
        ],
        { HM_SEND_PORT: String(port), SQUIDRUN_PROFILE: 'main', SQUIDRUN_ROLE: 'architect' },
        { cwd: tempProject }
      );

      expect(result.code).toBe(0);
      expect(sendAttempts).toHaveLength(1);
      expect(result.stdout).toContain('Delivered to builder');
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('still blocks operational messages when they include case facts', async () => {
    const tempProject = createLinkedProject();
    const logPath = path.join(tempProject, '.squidrun', 'runtime', 'context-leak-violations.jsonl');

    try {
      const result = await runHmSend(
        [
          'builder',
          '(ARCH #16): TASK - Scoped window status. Check PrivateCase case notes.',
          '--timeout',
          '80',
          '--retries',
          '0',
          '--no-fallback',
        ],
        { HM_SEND_PORT: '1', SQUIDRUN_PROFILE: 'main', SQUIDRUN_ROLE: 'architect' },
        { cwd: tempProject }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('BLOCKED: Scoped/case context in main pane');
      expect(fs.existsSync(logPath)).toBe(true);
      const entries = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: 'context_leak',
        profile: 'main',
        phrase: 'PrivateCase',
      });
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test('allows case context in the scoped profile', async () => {
    const tempProject = createLinkedProject();
    const sendAttempts = [];
    const { server, port } = await startAckServer(sendAttempts);

    try {
      const result = await runHmSend(
        ['architect', '(BUILDER #1): PrivateCase status update', '--timeout', '80', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: String(port), SQUIDRUN_PROFILE: 'scoped' },
        { cwd: tempProject }
      );

      expect(result.code).toBe(0);
      expect(sendAttempts).toHaveLength(1);
      expect(result.stdout).toContain('Delivered to architect');
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('allows side-profile --no-fallback delivery when health reports same-profile handler route', async () => {
    const sendAttempts = [];
    const registerAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          registerAttempts.push(msg);
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'handler_route_available',
            source: 'local_message_handler',
            routeScope: {
              profileName: 'eunbyeol',
              windowKey: 'eunbyeol',
            },
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            accepted: true,
            queued: true,
            verified: true,
            status: 'delivered.verified',
            wsDeliveryCount: 0,
            timestamp: Date.now(),
          }));
        }
      });
    });

    try {
      const result = await runHmSend(
        ['builder', '(EUNBYEOL #1): same profile handler route', '--role', 'architect', '--timeout', '120', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: String(port), SQUIDRUN_PROFILE: 'eunbyeol' }
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Delivered to builder');
      expect(registerAttempts[0]).toEqual(expect.objectContaining({
        role: 'architect',
        profileName: 'eunbyeol',
        windowKey: 'eunbyeol',
      }));
      expect(sendAttempts).toHaveLength(1);
      expect(sendAttempts[0].target).toBe('builder');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('blocks side-profile --no-fallback delivery when no same-profile route is available', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: false,
            status: 'scope_route_unavailable',
            failClosed: true,
            routeScope: {
              profileName: 'eunbyeol',
              windowKey: 'eunbyeol',
            },
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
        }
      });
    });

    try {
      const result = await runHmSend(
        ['builder', '(EUNBYEOL #2): should fail closed', '--role', 'architect', '--timeout', '120', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: String(port), SQUIDRUN_PROFILE: 'eunbyeol' }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Send blocked by profile isolation (scope_route_unavailable)');
      expect(sendAttempts).toHaveLength(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('relays TrustQuote Builder replies to main Architect with room attribution', async () => {
    const registerAttempts = [];
    const healthChecks = [];
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          registerAttempts.push(msg);
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          healthChecks.push(msg);
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            accepted: true,
            queued: true,
            verified: true,
            status: 'delivered.verified',
            timestamp: Date.now(),
          }));
        }
      });
    });

    try {
      const result = await runHmSend(
        ['architect', '(BUILDER #1): reverse relay proof', '--timeout', '120', '--retries', '0', '--no-fallback'],
        {
          HM_SEND_PORT: '65534',
          HM_SEND_TRUSTQUOTE_REVERSE_PORT: String(port),
          SQUIDRUN_PROFILE: 'trustquote',
          SQUIDRUN_ROLE: 'builder',
          SQUIDRUN_PANE_ID: 'trustquote-builder',
          SQUIDRUN_SESSION_SCOPE_ID: 'app-session-384:trustquote',
          SQUIDRUN_PROJECT_ROOT: 'D:/projects/TrustQuote',
        }
      );

      expect(result.code).toBe(0);
      expect(registerAttempts).toEqual([
        expect.objectContaining({
          role: 'builder',
          profileName: 'main',
          windowKey: 'main',
          sessionScopeId: null,
        }),
      ]);
      expect(healthChecks).toEqual([
        expect.objectContaining({
          target: 'architect',
        }),
      ]);
      expect(sendAttempts).toHaveLength(1);
      expect(sendAttempts[0]).toEqual(expect.objectContaining({
        target: 'architect',
        content: '(TRUSTQUOTE-BUILDER #1): reverse relay proof',
      }));
      expect(sendAttempts[0].metadata).toEqual(expect.objectContaining({
        sender: expect.objectContaining({
          role: 'builder',
          roomRole: 'builder',
          profileName: 'trustquote',
          paneId: 'trustquote-builder',
        }),
        room: expect.objectContaining({
          id: 'trustquote',
          sourceRoomId: 'trustquote',
          targetRoomId: 'main',
          targetRole: 'architect',
          dispatch: 'trustquote_reverse_relay',
        }),
        trustQuoteReverseRelay: expect.objectContaining({
          sourceRole: 'builder',
          sourcePaneId: 'trustquote-builder',
          targetProfile: 'main',
          targetRole: 'architect',
        }),
      }));
      expect(sendAttempts[0].metadata.routing).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('does not reverse-relay TrustQuote Builder messages to non-coordinator targets', async () => {
    const sideRegisters = [];
    const mainConnections = [];
    let sideServer;
    let mainServer;

    await new Promise((resolve, reject) => {
      sideServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      sideServer.once('listening', resolve);
      sideServer.once('error', reject);
    });
    await new Promise((resolve, reject) => {
      mainServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      mainServer.once('listening', resolve);
      mainServer.once('error', reject);
    });

    const sidePort = sideServer.address().port;
    const mainPort = mainServer.address().port;

    sideServer.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          sideRegisters.push(msg);
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: false,
            status: 'scope_route_unavailable',
            failClosed: true,
            routeScope: { profileName: 'trustquote', windowKey: 'trustquote' },
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
        }
      });
    });
    mainServer.on('connection', (ws) => {
      mainConnections.push(ws);
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));
    });

    try {
      const result = await runHmSend(
        ['oracle', '(BUILDER #2): should stay in TrustQuote scope', '--timeout', '120', '--retries', '0', '--no-fallback'],
        {
          HM_SEND_PORT: String(sidePort),
          HM_SEND_TRUSTQUOTE_REVERSE_PORT: String(mainPort),
          SQUIDRUN_PROFILE: 'trustquote',
          SQUIDRUN_ROLE: 'builder',
          SQUIDRUN_PANE_ID: 'trustquote-builder',
        }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Send blocked by profile isolation (scope_route_unavailable)');
      expect(sideRegisters).toEqual([
        expect.objectContaining({
          role: 'builder',
          profileName: 'trustquote',
          windowKey: 'trustquote',
        }),
      ]);
      expect(mainConnections).toHaveLength(0);
    } finally {
      await Promise.all([
        new Promise((resolve) => sideServer.close(resolve)),
        new Promise((resolve) => mainServer.close(resolve)),
      ]);
    }
  });

  test('surfaces content_context_mismatch as content-guard error, not profile isolation', async () => {
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'handler_route_available',
            source: 'local_message_handler',
            routeScope: { profileName: 'eunbyeol', windowKey: 'eunbyeol' },
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: false,
            accepted: false,
            queued: false,
            verified: false,
            status: 'routing_error',
            error: 'Main SquidRun context cannot be delivered to a side-profile Builder or Oracle',
            routingError: true,
            failClosed: true,
            contextGuard: {
              reason: 'content_context_mismatch',
              targetRole: 'builder',
              targetProfile: 'eunbyeol',
              profileHints: [],
            },
            timestamp: Date.now(),
          }));
        }
      });
    });

    try {
      const result = await runHmSend(
        ['builder', '(EUNBYEOL #99): squidrun trading hood path leaked into the body', '--role', 'architect', '--timeout', '120', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: String(port), SQUIDRUN_PROFILE: 'eunbyeol' }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Send blocked by content guard (content_context_mismatch)');
      expect(result.stderr).toContain('MAIN_CONTEXT_PATTERN');
      expect(result.stderr).toContain("target role 'builder'");
      expect(result.stderr).toContain("profile 'eunbyeol'");
      expect(result.stderr).not.toContain('Send blocked by profile isolation');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('surfaces profile_metadata_mismatch as metadata-guard error, not profile isolation', async () => {
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'handler_route_available',
            source: 'local_message_handler',
            routeScope: { profileName: 'eunbyeol', windowKey: 'eunbyeol' },
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: false,
            accepted: false,
            queued: false,
            verified: false,
            status: 'routing_error',
            error: 'Main SquidRun context cannot be delivered to a side-profile Builder or Oracle',
            routingError: true,
            failClosed: true,
            contextGuard: {
              reason: 'profile_metadata_mismatch',
              targetRole: 'builder',
              targetProfile: 'eunbyeol',
              profileHints: ['main'],
            },
            timestamp: Date.now(),
          }));
        }
      });
    });

    try {
      const result = await runHmSend(
        ['builder', '(EUNBYEOL #100): metadata mismatch test', '--role', 'architect', '--timeout', '120', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: String(port), SQUIDRUN_PROFILE: 'eunbyeol' }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Send blocked by profile metadata guard (profile_metadata_mismatch)');
      expect(result.stderr).toContain('[main]');
      expect(result.stderr).toContain("target role 'builder'");
      expect(result.stderr).not.toContain('Send blocked by profile isolation');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('applies exponential backoff between retries before succeeding', async () => {
    const attempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'send') {
          attempts.push(Date.now());
          // First attempt intentionally receives no ACK (forces timeout + retry).
          if (attempts.length === 2) {
            ws.send(JSON.stringify({
              type: 'send-ack',
              messageId: msg.messageId,
              ok: true,
              status: 'routed',
              timestamp: Date.now(),
            }));
          }
        }
      });
    });

    const result = await runHmSend(
      ['builder', '(TEST #1): retry backoff', '--timeout', '80', '--retries', '1', '--no-fallback'],
      { HM_SEND_PORT: String(port) }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(0);
    expect(attempts).toHaveLength(2);

    const retryGapMs = attempts[1] - attempts[0];
    // attempt 2 should wait ~80ms timeout + 80ms backoff before retrying
    expect(retryGapMs).toBeGreaterThanOrEqual(140);
    expect(result.stdout).toContain('attempt 2');
  });

  test('does not retry when ACK status is submit_not_accepted', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: false,
            accepted: false,
            verified: false,
            status: 'submit_not_accepted',
            timestamp: Date.now(),
          }));
        }
      });
    });

    const result = await runHmSend(
      ['builder', '(TEST #1b): no retry submit_not_accepted', '--timeout', '80', '--retries', '2', '--no-fallback'],
      { HM_SEND_PORT: String(port) }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(1);
    expect(sendAttempts).toHaveLength(1);
    expect(result.stderr).toContain('submit_not_accepted');
  });

  test('does not retry when ACK status is accepted.unverified', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: false,
            accepted: false,
            verified: false,
            status: 'accepted.unverified',
            timestamp: Date.now(),
          }));
        }
      });
    });

    const result = await runHmSend(
      ['builder', '(TEST #1c): no retry accepted.unverified', '--timeout', '80', '--retries', '2', '--no-fallback'],
      { HM_SEND_PORT: String(port) }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(1);
    expect(sendAttempts).toHaveLength(1);
    expect(result.stderr).toContain('accepted.unverified');
  });

  test('continues with websocket send attempts when target health is stale', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'heartbeat') {
          ws.send(JSON.stringify({
            type: 'heartbeat-ack',
            role: msg.role || null,
            paneId: msg.paneId || null,
            status: 'ok',
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: false,
            status: 'stale',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            status: 'routed',
            timestamp: Date.now(),
          }));
        }
      });
    });

    const result = await runHmSend(
      ['builder', '(TEST #2): health stale', '--timeout', '80', '--retries', '1', '--no-fallback'],
      { HM_SEND_PORT: String(port) }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(0);
    expect(sendAttempts).toHaveLength(1);
    expect(result.stdout).toContain('ack: routed');
  });

  test('treats accepted-but-unverified ack as success without fallback and reports truthful status', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'heartbeat') {
          ws.send(JSON.stringify({
            type: 'heartbeat-ack',
            role: msg.role || null,
            paneId: msg.paneId || null,
            status: 'ok',
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: false,
            accepted: true,
            queued: true,
            verified: false,
            status: 'routed_unverified',
            timestamp: Date.now(),
          }));
        }
      });
    });

    const result = await runHmSend(
      ['builder', '(TEST #2c): accepted-unverified', '--timeout', '80', '--retries', '1', '--no-fallback'],
      { HM_SEND_PORT: String(port) }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(0);
    expect(sendAttempts).toHaveLength(1);
    expect(result.stdout).toContain('Accepted by builder but unverified');
    expect(result.stdout).toContain('ack: routed_unverified');
  });

  test('does not trigger fallback for accepted-but-unverified delivery by default', async () => {
    const tempProject = createLinkedProject();
    const triggerPath = path.join(tempProject, '.squidrun', 'triggers', 'builder.txt');
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'heartbeat') {
          ws.send(JSON.stringify({
            type: 'heartbeat-ack',
            role: msg.role || null,
            paneId: msg.paneId || null,
            status: 'ok',
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            accepted: true,
            queued: true,
            verified: false,
            userVisible: false,
            status: 'routed_unverified_timeout',
            timestamp: Date.now(),
          }));
        }
      });
    });

    try {
      const result = await runHmSend(
        ['builder', '(TEST #2c2): accepted-unverified no fallback', '--timeout', '80', '--retries', '0'],
        { HM_SEND_PORT: String(port) },
        { cwd: tempProject }
      );

      expect(result.code).toBe(0);
      expect(sendAttempts).toHaveLength(1);
      expect(result.stdout).toContain('Accepted by builder but unverified');
      expect(result.stderr).not.toContain('Forced trigger fallback');
      expect(result.stderr).not.toContain('Wrote trigger fallback');
      expect(fs.existsSync(triggerPath)).toBe(false);
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('does not report websocket-only ack as visible delivery', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'heartbeat') {
          ws.send(JSON.stringify({
            type: 'heartbeat-ack',
            role: msg.role || null,
            paneId: msg.paneId || null,
            status: 'ok',
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            accepted: true,
            queued: true,
            verified: false,
            userVisible: false,
            status: 'delivered.websocket',
            timestamp: Date.now(),
          }));
        }
      });
    });

    const result = await runHmSend(
      ['builder', '(TEST #2d): websocket-only', '--timeout', '80', '--retries', '1', '--no-fallback'],
      { HM_SEND_PORT: String(port) }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(0);
    expect(sendAttempts).toHaveLength(1);
    expect(result.stdout).toContain('Accepted by builder but unverified');
    expect(result.stdout).toContain('ack: delivered.websocket');
    expect(result.stdout).not.toContain('Delivered to builder');
  });

  test('does not report accepted.unverified ack as visible delivery', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'heartbeat') {
          ws.send(JSON.stringify({
            type: 'heartbeat-ack',
            role: msg.role || null,
            paneId: msg.paneId || null,
            status: 'ok',
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            accepted: true,
            queued: true,
            verified: false,
            userVisible: false,
            status: 'accepted.unverified',
            timestamp: Date.now(),
          }));
        }
      });
    });

    const result = await runHmSend(
      ['builder', '(TEST #2e): accepted unverified', '--timeout', '80', '--retries', '1', '--no-fallback'],
      { HM_SEND_PORT: String(port) }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(0);
    expect(sendAttempts).toHaveLength(1);
    expect(result.stdout).toContain('Accepted by builder but unverified');
    expect(result.stdout).toContain('ack: accepted.unverified');
    expect(result.stdout).not.toContain('Delivered to builder');
  });

  test('blocks websocket send attempts when target health is invalid_target', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'heartbeat') {
          ws.send(JSON.stringify({
            type: 'heartbeat-ack',
            role: msg.role || null,
            paneId: msg.paneId || null,
            status: 'ok',
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: false,
            status: 'invalid_target',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
        }
      });
    });

    const result = await runHmSend(
      ['builder', '(TEST #2b): health invalid target', '--timeout', '80', '--retries', '1', '--no-fallback'],
      { HM_SEND_PORT: String(port) }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(1);
    expect(sendAttempts).toHaveLength(0);
    expect(result.stderr.toLowerCase()).toContain('invalid_target');
  });

  test('allows user target even when health-check reports invalid_target', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: false,
            status: 'invalid_target',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            status: 'telegram_delivered',
            timestamp: Date.now(),
          }));
        }
      });
    });

    const result = await runHmSend(
      ['user', '(TEST #2d): user special target', '--timeout', '80', '--retries', '1', '--no-fallback'],
      { HM_SEND_PORT: String(port) }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(0);
    expect(sendAttempts).toHaveLength(1);
    expect(sendAttempts[0].target).toBe('user');
    expect(result.stdout).toContain('ack: telegram_delivered');
  });

  test('blocks user target after current-session Telegram inbound evidence even outside reply window', async () => {
    const tempProject = createLinkedProject({ squidrunRoot: null });
    const sessionId = writeAppStatus(tempProject, 'app-session-777');
    const nowMs = Date.now();
    const olderThanDefaultReplyWindowMs = nowMs - (10 * 60 * 1000);
    seedCommsJournal(tempProject, {
      messageId: 'telegram-in-guard-1',
      sessionId,
      senderRole: 'user',
      targetRole: 'architect',
      channel: 'telegram',
      direction: 'inbound',
      sentAtMs: olderThanDefaultReplyWindowMs,
      brokeredAtMs: olderThanDefaultReplyWindowMs,
      rawBody: 'raw unwrapped Telegram body',
      status: 'brokered',
    }, nowMs);

    const result = await runHmSend(
      ['user', '(ARCHITECT #55): Reply that must not go app-only', '--role', 'architect', '--timeout', '80', '--retries', '0', '--no-fallback'],
      {
        HM_SEND_PORT: '65534',
        SQUIDRUN_PROJECT_ROOT: tempProject,
      },
      { cwd: tempProject }
    );

    try {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('BLOCKED: current-session Telegram inbound detected');
      expect(result.stderr).toContain("Use explicit target 'telegram'");
      expect(result.stderr).toContain('telegram-in-guard-1');
      expect(result.stdout).not.toContain('Delivered to user');
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test('allows explicit telegram target after recent Telegram inbound evidence', async () => {
    const tempProject = createLinkedProject({ squidrunRoot: null });
    const telegramMock = createTelegramHttpsMockPreload();
    const mockLogPath = path.join(telegramMock.tempRoot, 'telegram-requests.jsonl');
    const sessionId = writeAppStatus(tempProject, 'app-session-778');
    const nowMs = Date.now();
    const olderThanDefaultReplyWindowMs = nowMs - (10 * 60 * 1000);
    seedCommsJournal(tempProject, {
      messageId: 'telegram-in-guard-telegram-ok',
      sessionId,
      senderRole: 'user',
      targetRole: 'architect',
      channel: 'telegram',
      direction: 'inbound',
      sentAtMs: olderThanDefaultReplyWindowMs,
      brokeredAtMs: olderThanDefaultReplyWindowMs,
      rawBody: 'telegram body without visible wrapper',
      status: 'brokered',
    }, nowMs);

    const result = await runHmSend(
      ['telegram', '--stdin', '--role', 'architect', '--timeout', '80', '--retries', '0', '--no-fallback'],
      {
        HM_SEND_PORT: '65534',
        SQUIDRUN_PROJECT_ROOT: tempProject,
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '12345',
        TELEGRAM_CHAT_ALLOWLIST: '12345',
        HM_SEND_TELEGRAM_MOCK_LOG: mockLogPath,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${telegramMock.preloadPath}`.trim(),
      },
      { cwd: tempProject, stdin: '(ARCHITECT #56): Explicit Telegram reply' }
    );

    try {
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Delivered to telegram');
      expect(result.stdout).toContain('ack: telegram_delivered');
      expect(result.stderr).not.toContain('BLOCKED: current-session Telegram inbound detected');
      const [request] = fs.readFileSync(mockLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(JSON.parse(request.body)).toEqual(expect.objectContaining({
        chat_id: '12345',
        text: 'Explicit Telegram reply',
      }));
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      fs.rmSync(telegramMock.tempRoot, { recursive: true, force: true });
    }
  });

  test('keeps non-Telegram user target behavior intact', async () => {
    const tempProject = createLinkedProject({ squidrunRoot: null });
    const sessionId = writeAppStatus(tempProject, 'app-session-779');
    const nowMs = Date.now();
    seedCommsJournal(tempProject, {
      messageId: 'ws-in-guard-non-telegram',
      sessionId,
      senderRole: 'user',
      targetRole: 'architect',
      channel: 'ws',
      direction: 'inbound',
      sentAtMs: nowMs - 1000,
      brokeredAtMs: nowMs - 1000,
      rawBody: 'normal app user message',
      status: 'brokered',
    }, nowMs);

    const result = await runHmSend(
      ['user', '(ARCHITECT #57): Normal user route still works', '--role', 'architect', '--timeout', '80', '--retries', '0'],
      {
        HM_SEND_PORT: '65534',
        SQUIDRUN_PROJECT_ROOT: tempProject,
      },
      { cwd: tempProject }
    );

    try {
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(result.code).toBe(0);
      expect(combinedOutput).toContain('voice egress');
      expect(combinedOutput).not.toContain('BLOCKED: current-session Telegram inbound detected');
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test('does not block user target when a newer current-session user inbound is not Telegram', async () => {
    const tempProject = createLinkedProject({ squidrunRoot: null });
    const sessionId = writeAppStatus(tempProject, 'app-session-780');
    const nowMs = Date.now();
    const olderThanDefaultReplyWindowMs = nowMs - (10 * 60 * 1000);
    seedCommsJournal(tempProject, {
      messageId: 'telegram-in-guard-older',
      sessionId,
      senderRole: 'user',
      targetRole: 'architect',
      channel: 'telegram',
      direction: 'inbound',
      sentAtMs: olderThanDefaultReplyWindowMs,
      brokeredAtMs: olderThanDefaultReplyWindowMs,
      rawBody: 'older telegram body',
      status: 'brokered',
    }, nowMs);
    seedCommsJournal(tempProject, {
      messageId: 'ws-in-guard-newer',
      sessionId,
      senderRole: 'user',
      targetRole: 'architect',
      channel: 'ws',
      direction: 'inbound',
      sentAtMs: nowMs - 500,
      brokeredAtMs: nowMs - 500,
      rawBody: 'newer app body',
      status: 'brokered',
    }, nowMs);

    const result = await runHmSend(
      ['user', '(ARCHITECT #58): Newer app-origin reply stays on user route', '--role', 'architect', '--timeout', '80', '--retries', '0'],
      {
        HM_SEND_PORT: '65534',
        SQUIDRUN_PROJECT_ROOT: tempProject,
      },
      { cwd: tempProject }
    );

    try {
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(result.code).toBe(0);
      expect(combinedOutput).toContain('voice egress');
      expect(combinedOutput).not.toContain('BLOCKED: current-session Telegram inbound detected');
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test('explicit telegram --stdin uses Bot API direct delivery and does not append voice egress', async () => {
    const tempProject = createLinkedProject();
    const telegramMock = createTelegramHttpsMockPreload();
    const mockLogPath = path.join(telegramMock.tempRoot, 'telegram-requests.jsonl');
    const evidenceDbPath = path.join(tempProject, '.squidrun', 'runtime', 'evidence-ledger.db');
    const message = '(ARCH #54): Clean Telegram proof path';

    const result = await runHmSend(
      ['telegram', '--stdin', '--role', 'architect', '--timeout', '80', '--retries', '0', '--no-fallback'],
      {
        HM_SEND_PORT: '65534',
        SQUIDRUN_PROJECT_ROOT: tempProject,
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '12345',
        TELEGRAM_CHAT_ALLOWLIST: '12345',
        HM_SEND_TELEGRAM_MOCK_LOG: mockLogPath,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${telegramMock.preloadPath}`.trim(),
      },
      { cwd: tempProject, stdin: message }
    );

    let store;
    try {
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Delivered to telegram');
      expect(result.stdout).toContain('ack: telegram_delivered');
      expect(result.stdout).toContain('message_id: 77');
      expect(result.stderr).not.toContain('voice fallback');
      expect(result.stderr).not.toContain('via voice');
      expect(fs.existsSync(mockLogPath)).toBe(true);
      const [request] = fs.readFileSync(mockLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(request.path).toContain('/sendMessage');
      expect(JSON.parse(request.body)).toEqual(expect.objectContaining({
        chat_id: '12345',
        text: 'Clean Telegram proof path',
      }));

      store = new EvidenceLedgerStore({ dbPath: evidenceDbPath, enabled: true });
      expect(store.init().ok).toBe(true);
      expect(store.queryCommsJournal({ channel: 'voice', limit: 1 })).toEqual([]);
      expect(store.queryCommsJournal({ channel: 'telegram', limit: 1 })[0]).toEqual(expect.objectContaining({
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'telegram',
        rawBody: 'Clean Telegram proof path',
        status: 'acked',
      }));
    } finally {
      if (store) store.close();
      fs.rmSync(tempProject, { recursive: true, force: true });
      fs.rmSync(telegramMock.tempRoot, { recursive: true, force: true });
    }
  });

  test('routes architect user fallback into voice egress before Telegram fallback', async () => {
    const tempProject = createLinkedProject();
    const evidenceDbPath = path.join(tempProject, '.squidrun', 'runtime', 'evidence-ledger.db');

    const result = await runHmSend(
      ['user', '(ARCH #52): Mira: Clean spoken reply', '--role', 'architect', '--timeout', '80', '--retries', '0'],
      {
        HM_SEND_PORT: '65534',
        SQUIDRUN_PROJECT_ROOT: tempProject,
      },
      { cwd: tempProject }
    );

    let store;
    try {
      expect(result.code).toBe(0);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).toContain('voice egress');
      expect(combinedOutput).toContain(`Delivered to user`);
      expect(combinedOutput).not.toMatch(/^WebSocket send unverified/m);
      expect(combinedOutput).not.toContain('Send failed');
      expect(combinedOutput).not.toContain('telegram fallback');
      expect(fs.existsSync(evidenceDbPath)).toBe(true);

      store = new EvidenceLedgerStore({ dbPath: evidenceDbPath, enabled: true });
      expect(store.init().ok).toBe(true);
      const [entry] = store.queryCommsJournal({
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'voice',
        limit: 1,
      });
      expect(entry).toEqual(expect.objectContaining({
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'voice',
        rawBody: '(ARCH #52): Mira: Clean spoken reply',
      }));
    } finally {
      if (store) store.close();
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test('marks Telegram backup as degraded when architect voice egress fails', async () => {
    const tempProject = createLinkedProject();
    const telegramMock = createTelegramHttpsMockPreload();
    const result = await runHmSend(
      ['user', '(ARCH #53): Voice backup should be explicit', '--role', 'architect', '--timeout', '80', '--retries', '0'],
      {
        HM_SEND_PORT: '65534',
        SQUIDRUN_PROJECT_ROOT: tempProject,
        SQUIDRUN_EVIDENCE_LEDGER_ENABLED: '0',
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '12345',
        TELEGRAM_CHAT_ALLOWLIST: '12345',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${telegramMock.preloadPath}`.trim(),
      },
      { cwd: tempProject }
    );

    try {
      expect(result.code).toBe(0);
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).toContain('voice_failed_telegram_backup_used');
      expect(combinedOutput).toContain('via telegram fallback');
      expect(combinedOutput).not.toContain('via voice egress');
      expect(combinedOutput).not.toMatch(/^WebSocket send unverified/m);
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      fs.rmSync(telegramMock.tempRoot, { recursive: true, force: true });
    }
  });

  test('explicit telegram direct delivery makes Bot API failure visible', async () => {
    const tempProject = createLinkedProject();
    const telegramMock = createTelegramHttpsMockPreload();
    const result = await runHmSend(
      ['telegram', '(TEST #2e-fail): telegram should fail visibly', '--timeout', '80', '--retries', '0', '--no-fallback'],
      {
        HM_SEND_PORT: '65534',
        SQUIDRUN_PROJECT_ROOT: tempProject,
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '12345',
        TELEGRAM_CHAT_ALLOWLIST: '12345',
        HM_SEND_TELEGRAM_MOCK_STATUS_CODE: '500',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${telegramMock.preloadPath}`.trim(),
      },
      { cwd: tempProject }
    );

    try {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Telegram send failed: mock telegram failure');
      expect(result.stdout).not.toContain('Delivered to telegram');
      expect(result.stdout).not.toContain('ack: telegram_delivered');
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      fs.rmSync(telegramMock.tempRoot, { recursive: true, force: true });
    }
  });

  test('passes --chat-id through the direct telegram Bot API path', async () => {
    const tempProject = createLinkedProject();
    const telegramMock = createTelegramHttpsMockPreload();
    const mockLogPath = path.join(telegramMock.tempRoot, 'telegram-override-requests.jsonl');
    const result = await runHmSend(
      ['telegram', '--chat-id', '2222222222', '(TEST #2f): telegram override', '--timeout', '80', '--retries', '0', '--no-fallback'],
      {
        HM_SEND_PORT: '65534',
        SQUIDRUN_PROJECT_ROOT: tempProject,
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '12345',
        TELEGRAM_CHAT_ALLOWLIST: '12345,2222222222',
        HM_SEND_TELEGRAM_MOCK_LOG: mockLogPath,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${telegramMock.preloadPath}`.trim(),
      },
      { cwd: tempProject }
    );

    try {
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('ack: telegram_delivered');
      const [request] = fs.readFileSync(mockLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(JSON.parse(request.body)).toEqual(expect.objectContaining({
        chat_id: '2222222222',
        text: '(TEST #2f): telegram override',
      }));
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      fs.rmSync(telegramMock.tempRoot, { recursive: true, force: true });
    }
  });

  test('continues with websocket send when health-check is unsupported', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'heartbeat') {
          ws.send(JSON.stringify({
            type: 'heartbeat-ack',
            role: msg.role || null,
            paneId: msg.paneId || null,
            status: 'ok',
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            status: 'routed',
            timestamp: Date.now(),
          }));
        }
      });
    });

    const result = await runHmSend(
      ['builder', '(TEST #3): health unsupported', '--timeout', '80', '--retries', '0', '--no-fallback'],
      { HM_SEND_PORT: String(port) }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(0);
    expect(sendAttempts).toHaveLength(1);
    expect(result.stdout).toContain('ack: routed');
  });

  test('includes project context metadata in websocket send payload', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-send-meta-'));
    const externalProjectPath = path.join(tempRoot, 'external-project');
    const externalCoordPath = path.join(externalProjectPath, '.squidrun');
    fs.mkdirSync(externalCoordPath, { recursive: true });
    fs.writeFileSync(path.join(externalCoordPath, 'link.json'), JSON.stringify({
      workspace: externalProjectPath,
      session_id: 'session-meta-123',
      version: 1,
    }, null, 2));

    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            status: 'routed',
            timestamp: Date.now(),
          }));
        }
      });
    });

    try {
      const result = await runHmSend(
        ['builder', '(TEST #3b): metadata', '--timeout', '80', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: String(port) },
        { cwd: externalProjectPath }
      );

      expect(result.code).toBe(0);
      expect(sendAttempts).toHaveLength(1);
      expect(sendAttempts[0].metadata).toEqual(expect.objectContaining({
        envelope_version: 'hm-envelope-v1',
        session_id: 'session-meta-123',
        sender: expect.objectContaining({
          role: 'cli',
        }),
        target: expect.objectContaining({
          raw: 'builder',
          role: 'builder',
          pane_id: '2',
        }),
        project: expect.objectContaining({
          name: 'external-project',
          path: path.resolve(externalProjectPath),
          session_id: 'session-meta-123',
        }),
      }));
      expect(sendAttempts[0].metadata.envelope).toEqual(expect.objectContaining({
        version: 'hm-envelope-v1',
        session_id: 'session-meta-123',
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('refreshes stale app-session link metadata from current app-status session', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-send-session-refresh-'));
    const externalProjectPath = path.join(tempRoot, 'external-project');
    const externalCoordPath = path.join(externalProjectPath, '.squidrun');
    const fakeSquidRunRoot = path.join(tempRoot, 'squidrun-root');
    const fakeSquidRunCoord = path.join(fakeSquidRunRoot, '.squidrun');
    fs.mkdirSync(externalCoordPath, { recursive: true });
    fs.mkdirSync(fakeSquidRunCoord, { recursive: true });
    fs.writeFileSync(path.join(externalCoordPath, 'link.json'), JSON.stringify({
      workspace: externalProjectPath,
      squidrun_root: fakeSquidRunRoot,
      session_id: 'app-session-159',
      version: 1,
    }, null, 2));
    fs.writeFileSync(path.join(fakeSquidRunCoord, 'app-status.json'), JSON.stringify({
      session: 186,
    }, null, 2));

    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            status: 'routed',
            timestamp: Date.now(),
          }));
        }
      });
    });

    try {
      const result = await runHmSend(
        ['builder', '(TEST #3c): refresh session id', '--timeout', '80', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: String(port) },
        { cwd: externalProjectPath }
      );

      expect(result.code).toBe(0);
      expect(sendAttempts).toHaveLength(1);
      expect(sendAttempts[0]?.metadata?.project?.session_id).toBe('app-session-186');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('refreshes legacy bootstrap app link metadata from current app-status session', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-send-session-refresh-legacy-'));
    const externalProjectPath = path.join(tempRoot, 'external-project');
    const externalCoordPath = path.join(externalProjectPath, '.squidrun');
    const fakeSquidRunRoot = path.join(tempRoot, 'squidrun-root');
    const fakeSquidRunCoord = path.join(fakeSquidRunRoot, '.squidrun');
    fs.mkdirSync(externalCoordPath, { recursive: true });
    fs.mkdirSync(fakeSquidRunCoord, { recursive: true });
    fs.writeFileSync(path.join(externalCoordPath, 'link.json'), JSON.stringify({
      workspace: externalProjectPath,
      squidrun_root: fakeSquidRunRoot,
      session_id: 'app-7736-1771709282380',
      version: 1,
    }, null, 2));
    fs.writeFileSync(path.join(fakeSquidRunCoord, 'app-status.json'), JSON.stringify({
      session: 186,
    }, null, 2));

    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            status: 'routed',
            timestamp: Date.now(),
          }));
        }
      });
    });

    try {
      const result = await runHmSend(
        ['builder', '(TEST #3d): refresh legacy session id', '--timeout', '80', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: String(port) },
        { cwd: externalProjectPath }
      );

      expect(result.code).toBe(0);
      expect(sendAttempts).toHaveLength(1);
      expect(sendAttempts[0]?.metadata?.project?.session_id).toBe('app-session-186');
      expect(sendAttempts[0]?.metadata?.envelope?.session_id).toBe('app-session-186');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('loads outbound message content from --file when provided', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-send-file-'));
    const messageFilePath = path.join(tempDir, 'payload.txt');
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const messageFromFile = `(TEST #3e): file payload ${uniqueSuffix}\nline two\nline three`;
    fs.writeFileSync(messageFilePath, messageFromFile, 'utf8');

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            status: 'routed',
            timestamp: Date.now(),
          }));
        }
      });
    });

    try {
      const result = await runHmSend(
        ['builder', '--file', messageFilePath, '--timeout', '80', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: String(port) }
      );

      expect(result.code).toBe(0);
      expect(sendAttempts).toHaveLength(1);
      expect(sendAttempts[0].content).toBe(messageFromFile);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('falls back to trigger file with complete message after websocket retries exhaust', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;
    const triggerPath = path.resolve(getTriggerPath('builder.txt'));
    const cwdTriggerPath = path.resolve(path.join(path.join(__dirname, '..'), '.squidrun', 'triggers', 'builder.txt'));
    const trackedPaths = Array.from(new Set([triggerPath, cwdTriggerPath]));
    const originalContentByPath = new Map();
    for (const candidatePath of trackedPaths) {
      if (fs.existsSync(candidatePath)) {
        originalContentByPath.set(candidatePath, fs.readFileSync(candidatePath, 'utf8'));
      }
    }
    let actualTriggerPath = null;
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const message = `(TEST #4): fallback-integrity ${uniqueSuffix} ${'A'.repeat(1200)}`;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'heartbeat') {
          ws.send(JSON.stringify({
            type: 'heartbeat-ack',
            role: msg.role || null,
            paneId: msg.paneId || null,
            status: 'ok',
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          // Intentionally do not ACK so hm-send exhausts retries and uses fallback.
          sendAttempts.push(msg);
        }
      });
    });

    try {
      const result = await runHmSend(
        ['builder', message, '--role', 'builder', '--timeout', '80', '--retries', '1'],
        { HM_SEND_PORT: String(port) }
      );

      expect(result.code).toBe(0);
      expect(sendAttempts).toHaveLength(2);
      expect(sendAttempts[0].target).toBe('builder');
      expect(result.stderr).toContain('Wrote trigger fallback');
      const reportedFallbackPath = extractFallbackPath(result.stderr);
      expect(reportedFallbackPath).toBeTruthy();
      actualTriggerPath = path.resolve(reportedFallbackPath);
      expect(path.basename(actualTriggerPath).toLowerCase()).toBe('builder.txt');
      expect(fs.existsSync(actualTriggerPath)).toBe(true);
      const fallbackContent = fs.readFileSync(actualTriggerPath, 'utf8');
      expect(fallbackContent).toContain(`\n${message}`);
      expect(fallbackContent.startsWith(`${FALLBACK_MESSAGE_ID_PREFIX}${sendAttempts[0].messageId}]`)).toBe(true);
      expect(fallbackContent).toContain('[CURRENT PROJECT] name=');
      expect(fallbackContent).toContain('path=');
    } finally {
      const cleanupPaths = new Set(trackedPaths);
      if (actualTriggerPath) {
        cleanupPaths.add(actualTriggerPath);
      }
      for (const cleanupPath of cleanupPaths) {
        if (originalContentByPath.has(cleanupPath)) {
          fs.writeFileSync(cleanupPath, originalContentByPath.get(cleanupPath), 'utf8');
        } else if (fs.existsSync(cleanupPath)) {
          fs.unlinkSync(cleanupPath);
        }
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('skips trigger fallback when delivery-check confirms prior delivery despite missing ACK', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;
    const triggerPath = getTriggerPath('builder.txt');
    const hadOriginal = fs.existsSync(triggerPath);
    const originalContent = hadOriginal ? fs.readFileSync(triggerPath, 'utf8') : null;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'heartbeat') {
          ws.send(JSON.stringify({
            type: 'heartbeat-ack',
            role: msg.role || null,
            paneId: msg.paneId || null,
            status: 'ok',
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          // Intentionally skip send-ack to emulate lost ACK.
          return;
        }
        if (msg.type === 'delivery-check') {
          ws.send(JSON.stringify({
            type: 'delivery-check-result',
            requestId: msg.requestId,
            messageId: msg.messageId,
            known: true,
            status: 'cached',
            pending: false,
            ack: {
              type: 'send-ack',
              messageId: msg.messageId,
              ok: true,
              verified: true,
              userVisible: true,
              status: 'delivered.websocket',
              timestamp: Date.now(),
            },
            timestamp: Date.now(),
          }));
        }
      });
    });

    try {
      const result = await runHmSend(
        ['builder', '(TEST #5): delivery-check-guard', '--timeout', '80', '--retries', '1'],
        { HM_SEND_PORT: String(port) }
      );

      expect(result.code).toBe(0);
      expect(sendAttempts).toHaveLength(2);
      expect(result.stderr).not.toContain('Wrote trigger fallback');
      if (hadOriginal) {
        expect(fs.readFileSync(triggerPath, 'utf8')).toBe(originalContent);
      } else {
        expect(fs.existsSync(triggerPath)).toBe(false);
      }
    } finally {
      if (hadOriginal) {
        fs.writeFileSync(triggerPath, originalContent, 'utf8');
      } else if (fs.existsSync(triggerPath)) {
        fs.unlinkSync(triggerPath);
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('routes director target alias to architect fallback path when using --role director', async () => {
    const triggerPath = path.resolve(getTriggerPath('architect.txt'));
    const cwdTriggerPath = path.resolve(path.join(path.join(__dirname, '..'), '.squidrun', 'triggers', 'architect.txt'));
    const trackedPaths = Array.from(new Set([triggerPath, cwdTriggerPath]));
    const originalContentByPath = new Map();
    for (const candidatePath of trackedPaths) {
      if (fs.existsSync(candidatePath)) {
        originalContentByPath.set(candidatePath, fs.readFileSync(candidatePath, 'utf8'));
      }
    }
    let actualTriggerPath = null;
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const message = `(TEST #6): director-alias ${uniqueSuffix}`;

    try {
      const result = await runHmSend(
        ['director', message, '--role', 'director', '--timeout', '80', '--retries', '0'],
        { HM_SEND_PORT: '65534' } // force websocket failure -> trigger fallback
      );

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("rerouted target 'director' to 'builder'");
      expect(result.stderr.toLowerCase()).toContain('architect.txt');
      const reportedFallbackPath = extractFallbackPath(result.stderr);
      expect(reportedFallbackPath).toBeTruthy();
      actualTriggerPath = path.resolve(reportedFallbackPath);
      expect(path.basename(actualTriggerPath).toLowerCase()).toBe('architect.txt');
      expect(fs.existsSync(actualTriggerPath)).toBe(true);
      const fallbackContent = fs.readFileSync(actualTriggerPath, 'utf8');
      expect(fallbackContent).toContain(message);
    } finally {
      const cleanupPaths = new Set(trackedPaths);
      if (actualTriggerPath) {
        cleanupPaths.add(actualTriggerPath);
      }
      for (const cleanupPath of cleanupPaths) {
        if (originalContentByPath.has(cleanupPath)) {
          fs.writeFileSync(cleanupPath, originalContentByPath.get(cleanupPath), 'utf8');
        } else if (fs.existsSync(cleanupPath)) {
          fs.unlinkSync(cleanupPath);
        }
      }
    }
  });

  test('reroutes builder-bg sender messages from architect target to builder target', async () => {
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            status: 'routed',
            timestamp: Date.now(),
          }));
        }
      });
    });

    const result = await runHmSend(
      ['architect', '(TEST #8): background routing guard', '--role', 'builder-bg-1', '--timeout', '80', '--retries', '0', '--no-fallback'],
      { HM_SEND_PORT: String(port) }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(0);
    expect(sendAttempts).toHaveLength(1);
    expect(sendAttempts[0].target).toBe('builder');
    expect(result.stderr).toContain("rerouted target 'architect' to 'builder'");
  });

  test('uses project-scoped trigger fallback path when project link.json is present', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-send-link-'));
    const externalProjectPath = path.join(tempRoot, 'external-project');
    const externalCoordPath = path.join(externalProjectPath, '.squidrun');
    const linkPath = path.join(externalCoordPath, 'link.json');
    const expectedTriggerPath = path.join(externalCoordPath, 'triggers', 'builder.txt');
    const hadOriginal = fs.existsSync(expectedTriggerPath);
    const originalContent = hadOriginal ? fs.readFileSync(expectedTriggerPath, 'utf8') : null;
    fs.mkdirSync(externalCoordPath, { recursive: true });
    fs.writeFileSync(linkPath, JSON.stringify({
      workspace: externalProjectPath,
      version: 1,
    }, null, 2));

    try {
      const result = await runHmSend(
        ['builder', '(TEST #7): link-scoped fallback', '--timeout', '80', '--retries', '0'],
        { HM_SEND_PORT: '65534' },
        { cwd: externalProjectPath }
      );

      expect(result.code).toBe(0);
      expect(fs.existsSync(expectedTriggerPath)).toBe(true);
      const fallbackContent = fs.readFileSync(expectedTriggerPath, 'utf8');
      expect(fallbackContent).toContain('(TEST #7): link-scoped fallback');
      expect(result.stderr.replace(/\\/g, '/')).toContain(expectedTriggerPath.replace(/\\/g, '/'));
    } finally {
      if (hadOriginal) {
        fs.writeFileSync(expectedTriggerPath, originalContent, 'utf8');
      } else if (fs.existsSync(expectedTriggerPath)) {
        fs.unlinkSync(expectedTriggerPath);
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('routes @device-arch target through bridge path and skips health-check', async () => {
    const healthChecks = [];
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          healthChecks.push(msg);
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            accepted: true,
            queued: true,
            verified: true,
            userVisible: true,
            status: 'bridge_delivered',
            timestamp: Date.now(),
          }));
        }
      });
    });

    const result = await runHmSend(
      ['@peer-arch', '(ARCHITECT #100): bridge route test', '--role', 'architect', '--timeout', '80', '--retries', '0', '--no-fallback'],
      { HM_SEND_PORT: String(port), SQUIDRUN_CROSS_DEVICE: '1' }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(0);
    expect(healthChecks).toHaveLength(0);
    expect(sendAttempts).toHaveLength(1);
    expect(sendAttempts[0].target).toBe('@peer-arch');
    expect(sendAttempts[0]?.metadata?.envelope?.target?.role).toBe('architect');
    expect(result.stdout).toContain('Delivered to @peer-arch');
  });

  test.skip('--list-devices queries discovery, prints table, and writes cache', async () => {
    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-send-discovery-'));
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'register-ack', ok: true, deviceId: msg.deviceId }));
          return;
        }
        if (msg.type === 'xdiscovery') {
          ws.send(JSON.stringify({
            type: 'xdiscovery',
            requestId: msg.requestId,
            ok: true,
            devices: [
              { device_id: 'VIGIL', roles: ['architect'], connected_since: '2026-02-25T21:00:00.000Z' },
              { device_id: 'MACBOOK', roles: ['builder'], connected_since: '2026-02-25T21:01:00.000Z' },
            ],
          }));
        }
      });
    });

    try {
      const relayUrl = `ws://127.0.0.1:${port}`;
      const result = await runHmSend(
        ['--list-devices', '--role', 'architect', '--timeout', '250'],
        {
          SQUIDRUN_PROJECT_ROOT: tempProject,
          HM_SEND_PORT: '65534',
          SQUIDRUN_CROSS_DEVICE: '1',
          SQUIDRUN_RELAY_URL: relayUrl,
          SQUIDRUN_DEVICE_ID: 'MACBOOK',
          SQUIDRUN_RELAY_SECRET: 'relay-secret',
        },
        { cwd: tempProject }
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Online devices');
      expect(result.stdout).toContain('DEVICE_ID');
      expect(result.stdout).toContain('MACBOOK');
      expect(result.stdout).toContain('VIGIL');

      const cachePath = path.join(tempProject, '.squidrun', 'bridge', 'known-devices.json');
      expect(fs.existsSync(cachePath)).toBe(true);
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      expect(Array.isArray(cached.devices)).toBe(true);
      expect(cached.devices).toHaveLength(2);
      expect(cached.updated_at).toBeTruthy();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test('--list-devices prefers runtime bridge discovery over direct relay registration', async () => {
    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-send-runtime-discovery-'));
    let runtimeServer;

    await new Promise((resolve, reject) => {
      runtimeServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      runtimeServer.once('listening', resolve);
      runtimeServer.once('error', reject);
    });

    const runtimePort = runtimeServer.address().port;

    runtimeServer.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role || 'architect', paneId: '1' }));
          return;
        }
        if (msg.type === 'bridge-discovery') {
          ws.send(JSON.stringify({
            type: 'response',
            requestId: msg.requestId,
            ok: true,
            result: {
              ok: true,
              status: 'bridge_discovery_ok',
              devices: [
                { device_id: 'VIGIL', roles: ['architect'], connected_since: '2026-02-25T22:00:00.000Z' },
                { device_id: 'MACBOOK', roles: ['architect'], connected_since: '2026-02-25T22:01:00.000Z' },
              ],
            },
          }));
        }
      });
    });

    try {
      const result = await runHmSend(
        ['--list-devices', '--role', 'architect', '--timeout', '250'],
        {
          HM_SEND_PORT: String(runtimePort),
        },
        { cwd: tempProject }
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Online devices');
      expect(result.stdout).toContain('MACBOOK');
      expect(result.stdout).toContain('VIGIL');
      expect(result.stderr).not.toContain('Device discovery failed');
    } finally {
      await new Promise((resolve) => runtimeServer.close(resolve));
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test.skip('--list-devices falls back to cache when relay is unreachable', async () => {
    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-send-discovery-cache-'));
    const cachePath = path.join(tempProject, '.squidrun', 'bridge', 'known-devices.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      updated_at: '2026-02-25T22:22:22.000Z',
      source: 'relay',
      devices: [
        { device_id: 'VIGIL', roles: ['architect'], connected_since: '2026-02-25T21:00:00.000Z' },
      ],
    }, null, 2), 'utf8');

    try {
      const result = await runHmSend(
        ['--list-devices', '--role', 'architect', '--timeout', '120'],
        {
          SQUIDRUN_PROJECT_ROOT: tempProject,
          HM_SEND_PORT: '65534',
          SQUIDRUN_CROSS_DEVICE: '1',
          SQUIDRUN_RELAY_URL: 'ws://127.0.0.1:65534',
          SQUIDRUN_DEVICE_ID: 'MACBOOK',
          SQUIDRUN_RELAY_SECRET: 'relay-secret',
        },
        { cwd: tempProject }
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Online devices (cached)');
      expect(result.stdout).toContain('2026-02-25T22:22:22.000Z');
      expect(result.stdout).toContain('VIGIL');
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test.skip('--list-devices reports clear unsupported discovery error when relay lacks xdiscovery', async () => {
    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-send-discovery-unsupported-'));
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'register-ack', ok: true, deviceId: msg.deviceId }));
          return;
        }
        if (msg.type === 'xdiscovery') {
          ws.send(JSON.stringify({ type: 'error', error: 'unsupported_type:xdiscovery' }));
        }
      });
    });

    try {
      const relayUrl = `ws://127.0.0.1:${port}`;
      const result = await runHmSend(
        ['--list-devices', '--role', 'architect', '--timeout', '250'],
        {
          SQUIDRUN_PROJECT_ROOT: tempProject,
          HM_SEND_PORT: '65534',
          SQUIDRUN_CROSS_DEVICE: '1',
          SQUIDRUN_RELAY_URL: relayUrl,
          SQUIDRUN_DEVICE_ID: 'MACBOOK',
          SQUIDRUN_RELAY_SECRET: 'relay-secret',
        },
        { cwd: tempProject }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Device discovery failed: Relay discovery failed: Relay does not support device discovery (xdiscovery)');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test('prints connected device guidance for unknown @device-arch bridge target', async () => {
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'send') {
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: false,
            accepted: false,
            queued: false,
            verified: false,
            status: 'target_offline',
            handlerResult: {
              ok: false,
              accepted: false,
              queued: false,
              verified: false,
              status: 'target_offline',
              toDevice: 'WINDOWS',
              unknownDevice: 'WINDOWS',
              connectedDevices: ['VIGIL', 'MACBOOK'],
            },
            timestamp: Date.now(),
          }));
        }
      });
    });

    const result = await runHmSend(
      ['@windows-arch', '(ARCHITECT #102): bridge unknown target', '--role', 'architect', '--timeout', '80', '--retries', '0', '--no-fallback'],
      { HM_SEND_PORT: String(port), SQUIDRUN_CROSS_DEVICE: '1' }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown device 'WINDOWS'. Connected devices: MACBOOK, VIGIL");
  });

  test('rejects non-architect @device targets via invalid_target health preflight', async () => {
    const healthChecks = [];
    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          healthChecks.push(msg);
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: false,
            status: 'invalid_target',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
        }
      });
    });

    const invalidTargets = ['@peer-builder', '@peer-oracle'];
    for (const invalidTarget of invalidTargets) {
      const result = await runHmSend(
        [invalidTarget, '(ARCHITECT #101): should reject', '--role', 'architect', '--timeout', '80', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: String(port) }
      );

      expect(result.code).toBe(1);
      expect(result.stderr.toLowerCase()).toContain('invalid_target');
    }

    await new Promise((resolve) => server.close(resolve));

    expect(healthChecks).toHaveLength(2);
    expect(healthChecks[0].target).toBe('@peer-builder');
    expect(healthChecks[1].target).toBe('@peer-oracle');
    expect(sendAttempts).toHaveLength(0);
  });

  test('prefers link.json project metadata over stale state.json project metadata', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-send-project-priority-'));
    const linkedProjectPath = path.join(tempRoot, 'linked-project');
    const staleProjectPath = path.join(tempRoot, 'stale-project');
    const coordPath = path.join(linkedProjectPath, '.squidrun');
    const squidrunRoot = path.join(tempRoot, 'squidrun-root');
    fs.mkdirSync(coordPath, { recursive: true });
    fs.mkdirSync(path.join(squidrunRoot, '.squidrun'), { recursive: true });
    fs.mkdirSync(staleProjectPath, { recursive: true });
    fs.writeFileSync(path.join(coordPath, 'link.json'), JSON.stringify({
      workspace: linkedProjectPath,
      squidrun_root: squidrunRoot,
      version: 1,
    }, null, 2));
    fs.writeFileSync(path.join(coordPath, 'state.json'), JSON.stringify({
      project: staleProjectPath,
    }, null, 2));

    const sendAttempts = [];
    let server;

    await new Promise((resolve, reject) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const port = server.address().port;

    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', clientId: 1 }));

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
          return;
        }
        if (msg.type === 'health-check') {
          ws.send(JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            staleThresholdMs: 60000,
            timestamp: Date.now(),
          }));
          return;
        }
        if (msg.type === 'send') {
          sendAttempts.push(msg);
          ws.send(JSON.stringify({
            type: 'send-ack',
            messageId: msg.messageId,
            ok: true,
            status: 'routed',
            timestamp: Date.now(),
          }));
        }
      });
    });

    try {
      const result = await runHmSend(
        ['builder', '(TEST #9): prefer link metadata', '--timeout', '80', '--retries', '0', '--no-fallback'],
        { HM_SEND_PORT: String(port) },
        { cwd: linkedProjectPath }
      );

      expect(result.code).toBe(0);
      expect(sendAttempts).toHaveLength(1);
      expect(sendAttempts[0]?.metadata?.project?.path).toBe(linkedProjectPath);
      expect(sendAttempts[0]?.metadata?.project?.path).not.toBe(staleProjectPath);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
