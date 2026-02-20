/**
 * Evidence Ledger Integration Test
 * Verifies end-to-end traceId continuity across:
 * WS ingress -> routing -> triggers -> daemon handlers -> injection -> PTY writes
 */

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../config', () => require('./helpers/real-config').mockDefaultConfig);

jest.mock('electron', () => ({
  ipcRenderer: {
    on: jest.fn(),
    invoke: jest.fn().mockResolvedValue({}),
    send: jest.fn(),
  },
}));

jest.mock('../modules/notifications', () => ({
  showToast: jest.fn(),
}));

jest.mock('../modules/ui-view', () => ({
  init: jest.fn(),
  updateSyncChip: jest.fn(),
  showDeliveryIndicator: jest.fn(),
  showDeliveryFailed: jest.fn(),
  updateAgentStatus: jest.fn(),
  flashPaneHeader: jest.fn(),
  updateProjectDisplay: jest.fn(),
  showCostAlert: jest.fn(),
  showConflictNotification: jest.fn(),
  showHandoffNotification: jest.fn(),
  showAutoTriggerFeedback: jest.fn(),
  showRollbackUI: jest.fn(),
  hideRollbackUI: jest.fn(),
  updatePaneProject: jest.fn(),
  updateAgentTasks: jest.fn(),
  PANE_ROLES: { '1': 'Architect', '2': 'Builder', '3': 'Oracle' },
  SYNC_FILES: { 'shared_context.md': { label: 'CTX' } },
  _resetForTesting: jest.fn(),
}));

var mockInjectionController = null;

jest.mock('../modules/terminal', () => ({
  sendToPane: jest.fn((paneId, message, options = {}) => {
    if (!mockInjectionController) {
      if (options.onComplete) options.onComplete({ success: false, reason: 'missing_injection_controller' });
      return;
    }
    mockInjectionController.sendToPane(String(paneId), message, options);
  }),
  sendUnstick: jest.fn(),
  aggressiveNudge: jest.fn(),
  initTerminal: jest.fn().mockResolvedValue(),
  spawnAgent: jest.fn().mockResolvedValue(),
  restartPane: jest.fn(),
  freshStartAll: jest.fn(),
  nudgePane: jest.fn(),
}));

const WebSocket = require('ws');
const { ipcRenderer } = require('electron');
const bus = require('../modules/event-bus');
const websocketServer = require('../modules/websocket-server');
const triggers = require('../modules/triggers');
const daemonHandlers = require('../modules/daemon-handlers');
const terminal = require('../modules/terminal');
const { createInjectionController } = require('../modules/terminal/injection');

function connectAndRegister({ port, role, paneId }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    ws.on('error', reject);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'welcome') {
        ws.send(JSON.stringify({ type: 'register', role, paneId }));
        return;
      }

      if (msg.type === 'registered') {
        resolve(ws);
      }
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout waiting for websocket message')), timeoutMs);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (predicate(msg)) {
        clearTimeout(timeout);
        resolve(msg);
      }
    });
  });
}

function closeClient(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === ws.CLOSED) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      if (ws.readyState !== ws.CLOSED) ws.terminate();
      resolve();
    }, 500);

    ws.on('close', () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.close();
  });
}

function waitForCondition(checkFn, timeoutMs = 3000, pollMs = 25) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (checkFn()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timeout waiting for condition'));
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

describe('evidence-ledger integration: trace continuity', () => {
  let port;
  let activeClients;
  let injectedPayloads;
  let ptyWrites;
  let messageHandlerCalls;
  let ipcHandlers;

  beforeAll(async () => {
    await websocketServer.start({
      port: 0,
      onMessage: async (payload) => {
        messageHandlerCalls.push(payload);
        if (payload?.message?.type !== 'send') return { success: true, status: 'ignored_non_send' };

        const rawTarget = String(payload.message.target || '').toLowerCase();
        const paneIdByTarget = {
          architect: '1',
          builder: '2',
          oracle: '3',
          '1': '1',
          '2': '2',
          '3': '3',
        };
        const targetPane = paneIdByTarget[rawTarget] || String(payload.message.target || '3');

        return triggers.sendDirectMessage(
          [targetPane],
          payload.message.content,
          payload.role || 'architect',
          { traceContext: payload.traceContext || payload?.message?.traceContext || null }
        );
      },
    });

    port = websocketServer.getPort();
    if (!port || port === 0) {
      throw new Error('Failed to bind websocket server port');
    }
  });

  beforeEach(() => {
    bus.reset();

    activeClients = new Set();
    injectedPayloads = [];
    ptyWrites = [];
    messageHandlerCalls = [];
    ipcHandlers = {};

    global.document = {
      querySelector: jest.fn().mockReturnValue(null),
      querySelectorAll: jest.fn().mockReturnValue([]),
      getElementById: jest.fn().mockReturnValue(null),
      body: { contains: jest.fn().mockReturnValue(false) },
      activeElement: null,
    };

    global.window = {
      hivemind: {
        pty: {
          write: jest.fn(async (paneId, data, kernelMeta = null) => {
            ptyWrites.push({ paneId: String(paneId), data, kernelMeta });
            return { success: true };
          }),
          writeChunked: jest.fn(async () => ({ success: true, chunks: 1 })),
          sendTrustedEnter: jest.fn(async () => ({ success: true })),
        },
        project: {
          select: jest.fn().mockResolvedValue({ canceled: true }),
          get: jest.fn().mockResolvedValue('<project-root>'),
        },
      },
    };

    let injectionInFlight = false;
    const lastOutputTime = {};
    const lastTypedTime = {};
    const messageQueue = {};

    mockInjectionController = createInjectionController({
      terminals: new Map(),
      lastOutputTime,
      lastTypedTime,
      messageQueue,
      isCodexPane: () => false,
      isGeminiPane: (paneId) => String(paneId) === '3',
      buildCodexExecPrompt: (_paneId, text) => text,
      userIsTyping: () => false,
      userInputFocused: () => false,
      updatePaneStatus: jest.fn(),
      markPotentiallyStuck: jest.fn(),
      getInjectionInFlight: () => injectionInFlight,
      setInjectionInFlight: (value) => { injectionInFlight = Boolean(value); },
      constants: {
        QUEUE_RETRY_MS: 1,
        GEMINI_ENTER_DELAY_MS: 0,
        INJECTION_LOCK_TIMEOUT_MS: 2000,
        FOCUS_RETRY_DELAY_MS: 0,
        MAX_FOCUS_RETRIES: 0,
      },
    });

    ipcRenderer.on.mockImplementation((channel, handler) => {
      ipcHandlers[channel] = handler;
    });

    daemonHandlers.setupDaemonListeners(jest.fn(), jest.fn(), jest.fn(), jest.fn());

    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => {
          if (channel === 'inject-message') {
            injectedPayloads.push(payload);
            const handler = ipcHandlers['inject-message'];
            if (handler) handler({}, payload);
          }
        },
      },
    };

    triggers.init(
      mainWindow,
      new Map([
        ['1', 'running'],
        ['2', 'running'],
        ['3', 'running'],
      ]),
      jest.fn()
    );
  });

  afterEach(async () => {
    const clients = Array.from(activeClients);
    activeClients.clear();
    await Promise.all(clients.map(closeClient));

    mockInjectionController = null;
    if (typeof bus.reset === 'function') bus.reset();

    jest.clearAllMocks();
  });

  afterAll(async () => {
    await websocketServer.stop();
  });

  test('preserves traceId across WS ingress -> trigger route -> daemon -> injection -> PTY', async () => {
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const traceId = 'trace-int-e2e-1';
    const ackPromise = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === traceId, 4000);

    sender.send(JSON.stringify({
      type: 'send',
      target: 'oracle',
      content: '(ARCH #INT): trace continuity probe',
      messageId: traceId,
      ackRequired: true,
    }));

    const ack = await ackPromise;

    await waitForCondition(() => {
      const correlationEvents = bus.query({ correlationId: traceId, limit: 200 });
      const hasSubmit = correlationEvents.some((event) => event.type === 'inject.submit.sent');
      return injectedPayloads.length > 0 && ptyWrites.length >= 2 && hasSubmit;
    }, 4000);

    const routedPayload = injectedPayloads[0];
    const injectedTraceId = routedPayload?.traceContext?.traceId || routedPayload?.traceCtx?.traceId || null;

    const correlationEvents = bus.query({ correlationId: traceId, limit: 300 });
    const expectedHopTypes = [
      'inject.route.received',
      'inject.route.dispatched',
      'inject.requested',
      'inject.queued',
      'inject.applied',
      'inject.submit.requested',
      'inject.submit.sent',
    ];

    for (const type of expectedHopTypes) {
      const hop = correlationEvents.find((event) => event.type === type);
      expect(hop).toBeDefined();
      expect(hop.correlationId).toBe(traceId);
    }

    const ptyTraceIds = ptyWrites
      .map((call) => call.kernelMeta?.traceId || call.kernelMeta?.correlationId)
      .filter(Boolean);

    expect(ack.ok).toBe(false);
    expect(ack.accepted).toBe(true);
    expect(ack.verified).toBe(false);
    expect(ack.traceId).toBe(traceId);

    expect(messageHandlerCalls.length).toBeGreaterThan(0);
    expect(messageHandlerCalls[0]?.traceContext?.traceId).toBe(traceId);

    expect(injectedTraceId).toBe(traceId);

    expect(terminal.sendToPane).toHaveBeenCalled();
    const sendToPaneTrace = terminal.sendToPane.mock.calls[0]?.[2]?.traceContext?.traceId;
    expect(sendToPaneTrace).toBe(traceId);

    expect(ptyWrites.length).toBeGreaterThanOrEqual(2); // text + Enter on Gemini PTY path
    expect(ptyTraceIds.length).toBeGreaterThanOrEqual(2);
    expect(ptyTraceIds.every((id) => id === traceId)).toBe(true);
  });
});
