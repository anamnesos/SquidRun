const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const websocketRuntime = require('../modules/websocket-runtime');
const SquidRunApp = require('../modules/main/squidrun-app');
const { createBridgeClient } = require('../modules/bridge-client');
const { parseCrossDeviceTarget } = require('../modules/cross-device-target');
const triggers = require('../modules/triggers');
const { executeEvidenceLedgerOperation } = require('../modules/ipc/evidence-ledger-handlers');

jest.mock('../modules/triggers', () => ({
  sendDirectMessage: jest.fn(() => ({ success: true })),
}));

jest.mock('../modules/ipc/evidence-ledger-handlers', () => ({
  executeEvidenceLedgerOperation: jest.fn().mockResolvedValue({ ok: true }),
  closeSharedRuntime: jest.fn(),
}));

function runHmSend(args, env = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-send.js');
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        SQUIDRUN_ROLE: '',
        SQUIDRUN_PANE_ID: '',
        ...env,
      },
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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = Number(address && address.port);
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

function waitFor(predicate, timeoutMs = 10000, pollMs = 25) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
      if ((Date.now() - started) > timeoutMs) {
        reject(new Error(`Timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

function startRelayServer({ port, sharedSecret }) {
  return new Promise((resolve, reject) => {
    const relayPath = path.join(__dirname, '..', '..', 'relay', 'server.js');
    const child = spawn(process.execPath, [relayPath], {
      cwd: path.join(__dirname, '..', '..'),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        RELAY_SHARED_SECRET: sharedSecret,
        NODE_PATH: [
          path.join(__dirname, '..', 'node_modules'),
          process.env.NODE_PATH || '',
        ].filter(Boolean).join(path.delimiter),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Relay startup timed out. stdout=${stdout} stderr=${stderr}`));
    }, 10000);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (text.includes(`[relay] listening on ws://127.0.0.1:${port}`) && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          child,
          stop: () => new Promise((stopResolve) => {
            child.once('exit', () => stopResolve());
            child.kill();
          }),
        });
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Relay exited before ready (code=${code}). stderr=${stderr}`));
    });
  });
}

function createMockManagers() {
  return {
    settings: {
      readAppStatus: () => ({ session: 191 }),
      writeAppStatus: jest.fn(),
      loadSettings: jest.fn(),
    },
    activity: {
      logActivity: jest.fn(),
      loadActivityLog: jest.fn(),
    },
    usage: {
      loadUsageStats: jest.fn(),
    },
    cliIdentity: {},
    firmwareManager: {},
  };
}

function createAppInstance() {
  return new SquidRunApp(
    {
      mainWindow: null,
      daemonClient: null,
      currentSettings: {},
      agentRunning: new Map(),
    },
    createMockManagers()
  );
}

describe('cross-device bridge lifecycle e2e', () => {
  jest.setTimeout(45000);

  let relay = null;
  let senderBridge = null;
  let receiverBridge = null;

  afterEach(async () => {
    if (senderBridge) senderBridge.stop();
    if (receiverBridge) receiverBridge.stop();
    senderBridge = null;
    receiverBridge = null;

    await websocketRuntime.stop();

    if (relay) {
      await relay.stop();
      relay = null;
    }
  });

  test('routes hm-send bridge target through app -> relay -> app -> pane injection', async () => {
    const relayPort = await getFreePort();
    const localWsPort = await getFreePort();
    const sharedSecret = `bridge-secret-${Date.now()}`;
    relay = await startRelayServer({
      port: relayPort,
      sharedSecret,
    });

    const senderApp = createAppInstance();
    const receiverApp = createAppInstance();
    senderApp.bridgeEnabled = true;
    receiverApp.bridgeEnabled = true;
    senderApp.commsSessionScopeId = 'app-session-test-sender';
    receiverApp.commsSessionScopeId = 'app-session-test-receiver';

    const relayUrl = `ws://127.0.0.1:${relayPort}`;
    senderBridge = createBridgeClient({
      relayUrl,
      deviceId: 'local',
      sharedSecret,
    });
    receiverBridge = createBridgeClient({
      relayUrl,
      deviceId: 'peer',
      sharedSecret,
      onMessage: (payload = {}) => receiverApp.handleBridgeInboundMessage(payload),
    });

    senderBridge.start();
    receiverBridge.start();
    await waitFor(() => senderBridge.isReady() && receiverBridge.isReady(), 12000);
    senderApp.bridgeClient = senderBridge;

    await websocketRuntime.start({
      port: localWsPort,
      onMessage: async (data) => {
        if (data?.message?.type !== 'send') return null;
        const target = String(data.message.target || '');
        const bridgeTarget = parseCrossDeviceTarget(target);
        if (!bridgeTarget) {
          return {
            ok: false,
            accepted: false,
            queued: false,
            verified: false,
            status: 'invalid_target',
          };
        }

        const senderRole = String(data.role || '').trim().toLowerCase();
        if (senderRole !== 'architect') {
          return {
            ok: false,
            accepted: false,
            queued: false,
            verified: false,
            status: 'bridge_architect_only',
          };
        }

        return senderApp.routeBridgeMessage({
          targetDevice: bridgeTarget.toDevice,
          content: data.message.content,
          fromRole: senderRole,
          messageId: data.message.messageId || null,
          traceContext: data.traceContext || data.message.traceContext || null,
          structuredMessage: data.message?.metadata?.structured || null,
        });
      },
    });

    const payload = `(ARCHITECT #150): bridge e2e ${Date.now()}`;
    const hmSendResult = await runHmSend(
      ['@peer-arch', payload, '--role', 'architect', '--timeout', '2000', '--retries', '0', '--no-fallback'],
      {
        HM_SEND_PORT: String(localWsPort),
        SQUIDRUN_CROSS_DEVICE: '1',
      }
    );

    expect(hmSendResult.code).toBe(0);
    expect(hmSendResult.stdout).toContain('Delivered to @peer-arch');
    expect(hmSendResult.stdout).toContain('bridge_delivered');

    expect(triggers.sendDirectMessage).toHaveBeenCalledWith(
      ['1'],
      expect.stringContaining(`[Bridge FYI from LOCAL]: ${payload}`),
      null
    );

    expect(executeEvidenceLedgerOperation).toHaveBeenCalledWith(
      'upsert-comms-journal',
      expect.objectContaining({
        direction: 'inbound',
        channel: 'ws',
        metadata: expect.objectContaining({
          routeKind: 'bridge',
          fromDevice: 'LOCAL',
        }),
      }),
      expect.any(Object)
    );
  });
});
