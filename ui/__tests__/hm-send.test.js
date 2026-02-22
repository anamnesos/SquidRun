/**
 * hm-send retry/backoff integration tests
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { WORKSPACE_PATH, resolveCoordPath } = require('../config');

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
      stdio: ['ignore', 'pipe', 'pipe'],
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
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('hm-send retry behavior', () => {
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

  test('allows telegram target even when health-check reports invalid_target', async () => {
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
      ['telegram', '(TEST #2e): telegram special target', '--timeout', '80', '--retries', '1', '--no-fallback'],
      { HM_SEND_PORT: String(port) }
    );

    await new Promise((resolve) => server.close(resolve));

    expect(result.code).toBe(0);
    expect(sendAttempts).toHaveLength(1);
    expect(sendAttempts[0].target).toBe('telegram');
    expect(result.stdout).toContain('ack: telegram_delivered');
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

  test('falls back to trigger file with complete message after websocket retries exhaust', async () => {
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
      expect(fs.existsSync(triggerPath)).toBe(true);
      const fallbackContent = fs.readFileSync(triggerPath, 'utf8');
      expect(fallbackContent).toContain(`\n${message}`);
      expect(fallbackContent.startsWith(`${FALLBACK_MESSAGE_ID_PREFIX}${sendAttempts[0].messageId}]`)).toBe(true);
      expect(fallbackContent).toContain('[PROJECT CONTEXT] name=');
      expect(fallbackContent).toContain('path=');
    } finally {
      if (hadOriginal) {
        fs.writeFileSync(triggerPath, originalContent, 'utf8');
      } else if (fs.existsSync(triggerPath)) {
        fs.unlinkSync(triggerPath);
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
    const triggerPath = getTriggerPath('architect.txt');
    const hadOriginal = fs.existsSync(triggerPath);
    const originalContent = hadOriginal ? fs.readFileSync(triggerPath, 'utf8') : null;
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
      expect(fs.existsSync(triggerPath)).toBe(true);
      const fallbackContent = fs.readFileSync(triggerPath, 'utf8');
      expect(fallbackContent).toContain(message);
    } finally {
      if (hadOriginal) {
        fs.writeFileSync(triggerPath, originalContent, 'utf8');
      } else if (fs.existsSync(triggerPath)) {
        fs.unlinkSync(triggerPath);
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
});
