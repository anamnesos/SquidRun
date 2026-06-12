/**
 * WebSocket Delivery Audit
 * Ensures agent-to-agent delivery reaches the target pane.
 */

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

process.env.SQUIDRUN_MODEL_PROMPT_RECEIPT_WAIT_MS = '25';

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const websocketServer = require('../modules/websocket-server');

function connectAndRegister({
  port,
  role,
  paneId,
  profileName = 'main',
  windowKey = profileName,
  sessionScopeId = null,
  routeBinding = null,
}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    ws.on('error', reject);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return;
      }

      if (msg.type === 'welcome') {
        ws.send(JSON.stringify({
          type: 'register',
          role,
          paneId,
          profileName,
          windowKey,
          sessionScopeId,
          ...(routeBinding ? { routeBinding } : {}),
        }));
        return;
      }

      if (msg.type === 'registered') {
        resolve(ws);
      }
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
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
      if (ws.readyState !== ws.CLOSED) {
        ws.terminate();
      }
      resolve();
    }, 500);

    ws.on('close', () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.close();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('WebSocket Delivery Audit', () => {
  let port;
  let activeClients = new Set();
  let onMessageSpy;

  beforeAll(async () => {
    onMessageSpy = jest.fn();
    await websocketServer.start({
      port: 0,
      onMessage: (payload) => onMessageSpy(payload),
    });
    port = websocketServer.getPort();
    if (!port || port === 0) {
      throw new Error('WebSocket server failed to bind an ephemeral port');
    }
  });

  beforeEach(() => {
    activeClients = new Set();
    onMessageSpy.mockReset();
  });

  afterEach(async () => {
    const clients = Array.from(activeClients);
    activeClients.clear();
    await Promise.all(clients.map(closeClient));
  });

  afterAll(async () => {
    await websocketServer.stop();
  });

  test('delivers send message to target pane', async () => {
    const receiver = await connectAndRegister({ port, role: 'builder', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const delivery = waitForMessage(receiver, (msg) => msg.type === 'message' && msg.content === 'ping');

    sender.send(JSON.stringify({
      type: 'send',
      target: '2',
      content: 'ping',
      priority: 'normal',
    }));

    const received = await delivery;
    expect(received.from).toBe('architect');
  });

  test('delivers send message to target role', async () => {
    const receiver = await connectAndRegister({ port, role: 'builder', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const delivery = waitForMessage(receiver, (msg) => msg.type === 'message' && msg.content === 'role-ping');

    sender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'role-ping',
      priority: 'normal',
    }));

    const received = await delivery;
    expect(received.from).toBe('architect');
  });

  test('blocks non-main canonical target from falling back to main profile', async () => {
    const mainReceiver = await connectAndRegister({ port, role: 'builder', paneId: '2', profileName: 'main' });
    activeClients.add(mainReceiver);
    const scopedSender = await connectAndRegister({
      port,
      role: 'architect',
      paneId: '1',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedSender);

    let leakedToMain = false;
    mainReceiver.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.content === 'no-main-leak') leakedToMain = true;
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    });

    const messageId = 'scope-block-1';
    const ackPromise = waitForMessage(
      scopedSender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    scopedSender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'no-main-leak',
      messageId,
      ackRequired: true,
    }));

    const ack = await ackPromise;
    await sleep(100);
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('scoped_route_not_ready');
    expect(ack.failClosed).toBe(true);
    expect(ack.routeScope).toEqual(expect.objectContaining({ profileName: 'eunbyeol' }));
    expect(leakedToMain).toBe(false);
  });

  test('routes side-profile canonical target through same-profile local handler when no scoped WebSocket client is registered', async () => {
    const mainReceiver = await connectAndRegister({ port, role: 'builder', paneId: '2', profileName: 'main' });
    activeClients.add(mainReceiver);
    const scopedSender = await connectAndRegister({
      port,
      role: 'architect',
      paneId: '1',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedSender);

    let leakedToMain = false;
    mainReceiver.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.content === 'local-handler-scope-delivery') leakedToMain = true;
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    });

    onMessageSpy.mockImplementation((payload) => {
      if (payload?.message?.type === 'send' && payload?.message?.messageId === 'scope-handler-route-1') {
        return {
          ok: true,
          accepted: true,
          queued: true,
          verified: true,
          status: 'delivered.verified',
          paneId: '2',
          mode: 'local-terminal',
        };
      }
      return undefined;
    });

    const messageId = 'scope-handler-route-1';
    const ackPromise = waitForMessage(
      scopedSender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    scopedSender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'local-handler-scope-delivery',
      messageId,
      ackRequired: true,
    }));

    const ack = await ackPromise;
    await sleep(100);

    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('delivered.verified');
    expect(ack.wsDeliveryCount).toBe(0);
    expect(ack.handlerResult).toEqual(expect.objectContaining({
      mode: 'local-terminal',
      paneId: '2',
    }));
    expect(onMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
      role: 'architect',
      paneId: '1',
      message: expect.objectContaining({
        target: 'builder',
        messageId,
      }),
    }));
    expect(leakedToMain).toBe(false);
  });

  test('routes side-profile pane target through same-profile local handler when no scoped WebSocket client is registered', async () => {
    const scopedSender = await connectAndRegister({
      port,
      role: 'architect',
      paneId: '1',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedSender);

    onMessageSpy.mockImplementation((payload) => {
      if (payload?.message?.type === 'send' && payload?.message?.messageId === 'scope-pane-handler-route-1') {
        return {
          ok: true,
          accepted: true,
          queued: true,
          verified: true,
          status: 'delivered.verified',
          paneId: '2',
          mode: 'local-terminal',
        };
      }
      return undefined;
    });

    const messageId = 'scope-pane-handler-route-1';
    const ackPromise = waitForMessage(
      scopedSender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    scopedSender.send(JSON.stringify({
      type: 'send',
      target: '2',
      content: 'local-handler-pane-scope-delivery',
      messageId,
      ackRequired: true,
    }));

    const ack = await ackPromise;

    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('delivered.verified');
    expect(ack.wsDeliveryCount).toBe(0);
    expect(onMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        target: '2',
        messageId,
      }),
    }));
  });

  test('delivers scoped canonical target only to matching profile client', async () => {
    const scopedReceiver = await connectAndRegister({
      port,
      role: 'builder',
      paneId: '2',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedReceiver);
    const scopedSender = await connectAndRegister({
      port,
      role: 'architect',
      paneId: '1',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedSender);

    const delivery = waitForMessage(
      scopedReceiver,
      (msg) => msg.type === 'message' && msg.content === 'scoped-ping'
    );
    const messageId = 'scope-deliver-1';
    const ackPromise = waitForMessage(
      scopedSender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    scopedSender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'scoped-ping',
      messageId,
      ackRequired: true,
    }));

    const [ack, received] = await Promise.all([ackPromise, delivery]);
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('delivered.websocket');
    expect(received.from).toBe('architect');
  });

  test('Eunbyeol restart-readiness handshake proves scoped back-and-forth without main leak', async () => {
    const mainBuilder = await connectAndRegister({ port, role: 'builder', paneId: '2', profileName: 'main' });
    activeClients.add(mainBuilder);
    const mainArchitect = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainArchitect);
    const eunbyeolArchitect = await connectAndRegister({
      port,
      role: 'architect',
      paneId: '1',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(eunbyeolArchitect);
    const eunbyeolBuilder = await connectAndRegister({
      port,
      role: 'builder',
      paneId: '2',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(eunbyeolBuilder);

    const leakedToMain = [];
    mainBuilder.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && /Eunbyeol restart handshake/.test(msg.content || '')) {
          leakedToMain.push(msg);
        }
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    });

    const helloMessageId = 'eunbyeol-handshake-builder-1';
    const builderDelivery = waitForMessage(
      eunbyeolBuilder,
      (msg) => msg.type === 'message' && /profile=eunbyeol window=eunbyeol/.test(msg.content || '')
    );
    const helloAck = waitForMessage(
      eunbyeolArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === helloMessageId
    );

    eunbyeolArchitect.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'Eunbyeol restart handshake: profile=eunbyeol window=eunbyeol context=Eunbyeol/Rachel; plain builder/oracle targets stay same-profile only.',
      messageId: helloMessageId,
      ackRequired: true,
      metadata: {
        sender: {
          profileName: 'eunbyeol',
          windowKey: 'eunbyeol',
        },
        handshake: {
          profileName: 'eunbyeol',
          windowKey: 'eunbyeol',
          notMainContext: true,
          sameProfileTargetsOnly: true,
        },
      },
    }));

    const [helloAckMsg, builderMsg] = await Promise.all([helloAck, builderDelivery]);
    expect(helloAckMsg.ok).toBe(true);
    expect(helloAckMsg.status).toBe('delivered.websocket');
    expect(builderMsg.metadata).toEqual(expect.objectContaining({
      sender: expect.objectContaining({ profileName: 'eunbyeol', windowKey: 'eunbyeol' }),
      handshake: expect.objectContaining({ notMainContext: true, sameProfileTargetsOnly: true }),
    }));

    const replyMessageId = 'eunbyeol-handshake-architect-1';
    const architectReplyDelivery = waitForMessage(
      eunbyeolArchitect,
      (msg) => msg.type === 'message' && /same-profile canonical reply path confirmed/.test(msg.content || '')
    );
    const replyAck = waitForMessage(
      eunbyeolBuilder,
      (msg) => msg.type === 'send-ack' && msg.messageId === replyMessageId
    );

    eunbyeolBuilder.send(JSON.stringify({
      type: 'send',
      target: 'architect',
      content: 'Eunbyeol restart handshake received: same-profile canonical reply path confirmed.',
      messageId: replyMessageId,
      ackRequired: true,
      metadata: {
        sender: {
          profileName: 'eunbyeol',
          windowKey: 'eunbyeol',
        },
        handshake: {
          received: true,
          sameProfileReply: true,
        },
      },
    }));

    const [replyAckMsg, replyMsg] = await Promise.all([replyAck, architectReplyDelivery]);
    expect(replyAckMsg.ok).toBe(true);
    expect(replyAckMsg.status).toBe('delivered.websocket');
    expect(replyMsg.metadata).toEqual(expect.objectContaining({
      sender: expect.objectContaining({ profileName: 'eunbyeol', windowKey: 'eunbyeol' }),
      handshake: expect.objectContaining({ received: true, sameProfileReply: true }),
    }));

    const diagnosticMessageId = 'eunbyeol-handshake-diagnostic-1';
    const diagnosticDelivery = waitForMessage(
      eunbyeolArchitect,
      (msg) => msg.type === 'message' && /diagnostic path from main Architect/.test(msg.content || '')
    );
    const diagnosticAck = waitForMessage(
      mainArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === diagnosticMessageId
    );

    mainArchitect.send(JSON.stringify({
      type: 'send',
      target: 'architect',
      content: 'Eunbyeol restart handshake diagnostic path from main Architect.',
      messageId: diagnosticMessageId,
      ackRequired: true,
      metadata: {
        routing: {
          profileName: 'eunbyeol',
          windowKey: 'eunbyeol',
          channel: 'scoped-diagnostic',
        },
      },
    }));

    const [diagnosticAckMsg, diagnosticMsg] = await Promise.all([diagnosticAck, diagnosticDelivery]);
    expect(diagnosticAckMsg.ok).toBe(true);
    expect(diagnosticMsg.metadata).toEqual(expect.objectContaining({
      routing: expect.objectContaining({
        profileName: 'eunbyeol',
        windowKey: 'eunbyeol',
        channel: 'scoped-diagnostic',
      }),
    }));

    await sleep(100);
    expect(leakedToMain).toHaveLength(0);
  });

  test('main plain canonical target does not route into scoped profile', async () => {
    const scopedReceiver = await connectAndRegister({
      port,
      role: 'builder',
      paneId: '2',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
    });
    activeClients.add(scopedReceiver);
    const mainSender = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainSender);

    let leakedToScoped = false;
    scopedReceiver.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.content === 'plain-main-target') leakedToScoped = true;
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    });

    const messageId = 'main-plain-no-scope-1';
    const ackPromise = waitForMessage(
      mainSender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    mainSender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'plain-main-target',
      messageId,
      ackRequired: true,
    }));

    const ack = await ackPromise;
    await sleep(100);
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('unrouted');
    expect(leakedToScoped).toBe(false);
  });

  test('main explicit scoped route fails closed when the scoped profile has no registered route', async () => {
    const mainSender = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainSender);
    const mainReceiver = await connectAndRegister({ port, role: 'builder', paneId: '2', profileName: 'main' });
    activeClients.add(mainReceiver);

    let leakedToMain = false;
    mainReceiver.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.content === 'explicit-scope-no-main-handler') leakedToMain = true;
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    });
    onMessageSpy.mockImplementation((payload) => {
      if (payload?.message?.type === 'send' && payload?.message?.messageId === 'main-explicit-scope-missing-1') {
        return {
          ok: true,
          accepted: true,
          queued: true,
          verified: true,
          status: 'delivered.verified',
        };
      }
      return undefined;
    });

    const messageId = 'main-explicit-scope-missing-1';
    const ackPromise = waitForMessage(
      mainSender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    mainSender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'explicit-scope-no-main-handler',
      messageId,
      ackRequired: true,
      metadata: {
        routing: {
          profileName: 'eunbyeol',
          windowKey: 'eunbyeol',
        },
      },
    }));

    const ack = await ackPromise;
    await sleep(100);

    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('scope_route_unavailable');
    expect(ack.failClosed).toBe(true);
    expect(onMessageSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ messageId }),
    }));
    expect(leakedToMain).toBe(false);
  });

  test('rejects Eunbyeol/Rachel context aimed at main Builder and notifies main Architect', async () => {
    const mainArchitect = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainArchitect);
    const mainReceiver = await connectAndRegister({ port, role: 'builder', paneId: '2', profileName: 'main' });
    activeClients.add(mainReceiver);

    let executedByMainBuilder = false;
    mainReceiver.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.content.includes('Rachel')) executedByMainBuilder = true;
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    });

    const messageId = 'wrong-context-metadata-1';
    const ackPromise = waitForMessage(
      mainArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );
    const routingErrorPromise = waitForMessage(
      mainArchitect,
      (msg) => msg.type === 'routing_error' && msg.status === 'routing_error'
    );

    mainArchitect.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'Eunbyeol Rachel case follow-up belongs in the side window',
      messageId,
      ackRequired: true,
      metadata: {
        sender: {
          profileName: 'eunbyeol',
        },
      },
    }));

    const [ack, routingError] = await Promise.all([ackPromise, routingErrorPromise]);
    await sleep(100);
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('routing_error');
    expect(ack.contextGuard).toEqual(expect.objectContaining({
      reason: 'profile_metadata_mismatch',
      targetRole: 'builder',
    }));
    expect(routingError.error).toContain('Side-profile/case context');
    expect(executedByMainBuilder).toBe(false);
  });

  test('rejects missing-scope side-window content aimed at main Builder', async () => {
    const mainArchitect = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainArchitect);
    const mainReceiver = await connectAndRegister({ port, role: 'builder', paneId: '2', profileName: 'main' });
    activeClients.add(mainReceiver);

    let executedByMainBuilder = false;
    mainReceiver.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.content.includes('Eunbyeol')) executedByMainBuilder = true;
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    });

    const messageId = 'wrong-context-content-1';
    const ackPromise = waitForMessage(
      mainArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    mainArchitect.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'Eunbyeol side-window case context with no scope metadata',
      messageId,
      ackRequired: true,
    }));

    const ack = await ackPromise;
    await sleep(100);
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('routing_error');
    expect(ack.contextGuard).toEqual(expect.objectContaining({
      reason: 'content_context_mismatch',
      targetRole: 'builder',
    }));
    expect(executedByMainBuilder).toBe(false);
  });

  test('rejects main SquidRun context aimed at side Builder', async () => {
    const scopedReceiver = await connectAndRegister({
      port,
      role: 'builder',
      paneId: '2',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
    });
    activeClients.add(scopedReceiver);
    const mainSender = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainSender);

    let executedByScopedBuilder = false;
    scopedReceiver.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.content.includes('SquidRun trading')) executedByScopedBuilder = true;
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    });

    const messageId = 'wrong-context-main-to-side-1';
    const ackPromise = waitForMessage(
      mainSender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    mainSender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'SquidRun trading/HOOD task belongs in main',
      messageId,
      ackRequired: true,
      metadata: {
        routing: {
          profileName: 'eunbyeol',
          windowKey: 'eunbyeol',
        },
      },
    }));

    const ack = await ackPromise;
    await sleep(100);
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('routing_error');
    expect(ack.contextGuard).toEqual(expect.objectContaining({
      reason: 'content_context_mismatch',
      targetRole: 'builder',
    }));
    expect(executedByScopedBuilder).toBe(false);
  });

  test('allows side-profile builder to receive repo-relative implementation diagnostic', async () => {
    const scopedArchitect = await connectAndRegister({
      port, role: 'architect', paneId: '1', profileName: 'eunbyeol', windowKey: 'eunbyeol',
    });
    activeClients.add(scopedArchitect);
    const scopedBuilder = await connectAndRegister({
      port, role: 'builder', paneId: '2', profileName: 'eunbyeol', windowKey: 'eunbyeol',
    });
    activeClients.add(scopedBuilder);

    const messageId = 'allow-repo-relative-diag-1';
    const deliveryPromise = waitForMessage(
      scopedBuilder,
      (msg) => msg.type === 'message' && msg.content.includes('websocket-runtime.js:1742')
    );
    const ackPromise = waitForMessage(
      scopedArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    scopedArchitect.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'ui/modules/websocket-runtime.js:1742 has the wrongContext block',
      messageId,
      ackRequired: true,
    }));

    const [ack, delivered] = await Promise.all([ackPromise, deliveryPromise]);
    expect(ack.ok).toBe(true);
    expect(ack.status).not.toBe('routing_error');
    expect(delivered.content).toContain('websocket-runtime.js:1742');
  });

  test('allows side-profile builder to receive generic operational words like worktree', async () => {
    const scopedArchitect = await connectAndRegister({
      port, role: 'architect', paneId: '1', profileName: 'eunbyeol', windowKey: 'eunbyeol',
    });
    activeClients.add(scopedArchitect);
    const scopedBuilder = await connectAndRegister({
      port, role: 'builder', paneId: '2', profileName: 'eunbyeol', windowKey: 'eunbyeol',
    });
    activeClients.add(scopedBuilder);

    const messageId = 'allow-worktree-word-1';
    const deliveryPromise = waitForMessage(
      scopedBuilder,
      (msg) => msg.type === 'message' && msg.content.includes('worktree state')
    );
    const ackPromise = waitForMessage(
      scopedArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    scopedArchitect.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'worktree state for the eunbyeol profile got out of sync',
      messageId,
      ackRequired: true,
    }));

    const [ack, delivered] = await Promise.all([ackPromise, deliveryPromise]);
    expect(ack.ok).toBe(true);
    expect(ack.status).not.toBe('routing_error');
    expect(delivered.content).toContain('worktree state');
  });

  test('allows side-profile builder to receive within-profile absolute path', async () => {
    const scopedArchitect = await connectAndRegister({
      port, role: 'architect', paneId: '1', profileName: 'eunbyeol', windowKey: 'eunbyeol',
    });
    activeClients.add(scopedArchitect);
    const scopedBuilder = await connectAndRegister({
      port, role: 'builder', paneId: '2', profileName: 'eunbyeol', windowKey: 'eunbyeol',
    });
    activeClients.add(scopedBuilder);

    const messageId = 'allow-within-profile-path-1';
    const deliveryPromise = waitForMessage(
      scopedBuilder,
      (msg) => msg.type === 'message' && msg.content.includes('/profiles/eunbyeol/workspace/')
    );
    const ackPromise = waitForMessage(
      scopedArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    scopedArchitect.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'open D:/projects/squidrun/.squidrun/profiles/eunbyeol/workspace/notes/draft.md',
      messageId,
      ackRequired: true,
    }));

    const [ack, delivered] = await Promise.all([ackPromise, deliveryPromise]);
    expect(ack.ok).toBe(true);
    expect(ack.status).not.toBe('routing_error');
    expect(delivered.content).toContain('/profiles/eunbyeol/workspace/');
  });

  test('allows side-profile builder to receive the word fixture in implementation notes', async () => {
    const scopedArchitect = await connectAndRegister({
      port, role: 'architect', paneId: '1', profileName: 'eunbyeol', windowKey: 'eunbyeol',
    });
    activeClients.add(scopedArchitect);
    const scopedBuilder = await connectAndRegister({
      port, role: 'builder', paneId: '2', profileName: 'eunbyeol', windowKey: 'eunbyeol',
    });
    activeClients.add(scopedBuilder);

    const messageId = 'allow-fixture-word-1';
    const deliveryPromise = waitForMessage(
      scopedBuilder,
      (msg) => msg.type === 'message' && msg.content.includes('test fixture')
    );
    const ackPromise = waitForMessage(
      scopedArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    scopedArchitect.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'the test fixture at __tests__/hm-send.test.js needs an extra assertion',
      messageId,
      ackRequired: true,
    }));

    const [ack, delivered] = await Promise.all([ackPromise, deliveryPromise]);
    expect(ack.ok).toBe(true);
    expect(ack.status).not.toBe('routing_error');
    expect(delivered.content).toContain('test fixture');
  });

  test('still rejects main-bound trading term aimed at side-profile builder', async () => {
    const scopedReceiver = await connectAndRegister({
      port, role: 'builder', paneId: '2', profileName: 'eunbyeol', windowKey: 'eunbyeol',
    });
    activeClients.add(scopedReceiver);
    const mainSender = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainSender);

    const messageId = 'reject-hyperliquid-1';
    const ackPromise = waitForMessage(
      mainSender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    mainSender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'hyperliquid order failed retry now',
      messageId,
      ackRequired: true,
      metadata: { routing: { profileName: 'eunbyeol', windowKey: 'eunbyeol' } },
    }));

    const ack = await ackPromise;
    await sleep(100);
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('routing_error');
    expect(ack.contextGuard).toEqual(expect.objectContaining({
      reason: 'content_context_mismatch',
      pattern: 'MAIN_CONTEXT_PATTERN',
      targetRole: 'builder',
      targetProfile: 'eunbyeol',
    }));
  });

  test('rejects foreign main-tree absolute path aimed at side-profile builder', async () => {
    const scopedReceiver = await connectAndRegister({
      port, role: 'builder', paneId: '2', profileName: 'eunbyeol', windowKey: 'eunbyeol',
    });
    activeClients.add(scopedReceiver);
    const mainSender = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainSender);

    const messageId = 'reject-foreign-main-path-1';
    const ackPromise = waitForMessage(
      mainSender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    mainSender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'look at D:/projects/squidrun/ui/scripts/hm-send.js for the patch',
      messageId,
      ackRequired: true,
      metadata: { routing: { profileName: 'eunbyeol', windowKey: 'eunbyeol' } },
    }));

    const ack = await ackPromise;
    await sleep(100);
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('routing_error');
    expect(ack.contextGuard).toEqual(expect.objectContaining({
      reason: 'content_context_mismatch',
      pattern: 'foreign_main_tree_path',
      targetRole: 'builder',
      targetProfile: 'eunbyeol',
    }));
  });

  test('rejects side context aimed at main builder with SIDE_CONTEXT_PATTERN', async () => {
    const mainArchitect = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainArchitect);
    const mainReceiver = await connectAndRegister({ port, role: 'builder', paneId: '2', profileName: 'main' });
    activeClients.add(mainReceiver);

    const messageId = 'reject-side-pattern-on-main-1';
    const ackPromise = waitForMessage(
      mainArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    mainArchitect.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'eunbyeol case file is at ./notes/draft.md',
      messageId,
      ackRequired: true,
    }));

    const ack = await ackPromise;
    await sleep(100);
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('routing_error');
    expect(ack.contextGuard).toEqual(expect.objectContaining({
      reason: 'content_context_mismatch',
      pattern: 'SIDE_CONTEXT_PATTERN',
      targetRole: 'builder',
      targetProfile: 'main',
    }));
  });

  test('allows scoped diagnostic channel only between architects', async () => {
    const scopedArchitect = await connectAndRegister({
      port,
      role: 'architect',
      paneId: '1',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
    });
    activeClients.add(scopedArchitect);
    const scopedBuilder = await connectAndRegister({
      port,
      role: 'builder',
      paneId: '2',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
    });
    activeClients.add(scopedBuilder);
    const mainArchitect = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainArchitect);

    const delivery = waitForMessage(
      scopedArchitect,
      (msg) => msg.type === 'message' && msg.content === 'diagnostic-only'
    );
    const architectAckPromise = waitForMessage(
      mainArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === 'scoped-diagnostic-ok'
    );

    mainArchitect.send(JSON.stringify({
      type: 'send',
      target: 'architect',
      content: 'diagnostic-only',
      messageId: 'scoped-diagnostic-ok',
      ackRequired: true,
      metadata: {
        routing: {
          profileName: 'eunbyeol',
          windowKey: 'eunbyeol',
          channel: 'scoped-diagnostic',
        },
      },
    }));

    const [architectAck, received] = await Promise.all([architectAckPromise, delivery]);
    expect(architectAck.ok).toBe(true);
    expect(received.from).toBe('architect');

    let leakedToScopedBuilder = false;
    scopedBuilder.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.content === 'diagnostic-to-builder') leakedToScopedBuilder = true;
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    });

    const builderAckPromise = waitForMessage(
      mainArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === 'scoped-diagnostic-blocked'
    );

    mainArchitect.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'diagnostic-to-builder',
      messageId: 'scoped-diagnostic-blocked',
      ackRequired: true,
      metadata: {
        routing: {
          profileName: 'eunbyeol',
          windowKey: 'eunbyeol',
          channel: 'scoped-diagnostic',
        },
      },
    }));

    const builderAck = await builderAckPromise;
    await sleep(100);
    expect(builderAck.ok).toBe(false);
    expect(builderAck.status).toBe('routing_error');
    expect(builderAck.contextGuard).toEqual(expect.objectContaining({
      reason: 'invalid_scoped_diagnostic_target',
      targetRole: 'builder',
    }));
    expect(leakedToScopedBuilder).toBe(false);
  });

  test('routes main architect to side architect with explicit profile routing metadata', async () => {
    const scopedArchitect = await connectAndRegister({
      port,
      role: 'architect',
      paneId: '1',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedArchitect);
    const scopedBuilder = await connectAndRegister({
      port,
      role: 'builder',
      paneId: '2',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedBuilder);
    const mainArchitect = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainArchitect);

    let leakedToScopedBuilder = false;
    scopedBuilder.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.content === 'architect-profile-route-main-to-side') {
          leakedToScopedBuilder = true;
        }
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    });

    const messageId = 'architect-profile-route-main-to-side-1';
    const delivery = waitForMessage(
      scopedArchitect,
      (msg) => msg.type === 'message' && msg.content === 'architect-profile-route-main-to-side'
    );
    const ackPromise = waitForMessage(
      mainArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    mainArchitect.send(JSON.stringify({
      type: 'send',
      target: 'architect',
      content: 'architect-profile-route-main-to-side',
      messageId,
      ackRequired: true,
      metadata: {
        routing: {
          profileName: 'eunbyeol',
          windowKey: 'eunbyeol',
        },
        sourceAddress: 'architect@main',
        targetAddress: 'architect@eunbyeol',
        routeAttribution: {
          sourceProfileName: 'main',
          sourceWindowKey: 'main',
          sourceAddress: 'architect@main',
          targetProfileName: 'eunbyeol',
          targetWindowKey: 'eunbyeol',
          targetAddress: 'architect@eunbyeol',
        },
      },
    }));

    const [ack, received] = await Promise.all([ackPromise, delivery]);
    await sleep(100);
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('delivered.websocket');
    expect(received.from).toBe('architect');
    expect(received.metadata).toEqual(expect.objectContaining({
      sourceAddress: 'architect@main',
      targetAddress: 'architect@eunbyeol',
      routeAttribution: expect.objectContaining({
        sourceAddress: 'architect@main',
        targetAddress: 'architect@eunbyeol',
      }),
    }));
    expect(leakedToScopedBuilder).toBe(false);
  });

  test('routes main architect to side architect through side local handler when no scoped client is registered', async () => {
    const mainArchitect = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainArchitect);

    onMessageSpy.mockImplementation((payload) => {
      if (payload?.message?.type === 'send' && payload?.message?.messageId === 'architect-profile-route-main-to-side-handler-1') {
        return {
          ok: true,
          accepted: true,
          queued: true,
          verified: true,
          status: 'delivered.verified',
          paneId: '1',
          mode: 'side-terminal',
        };
      }
      return undefined;
    });

    const messageId = 'architect-profile-route-main-to-side-handler-1';
    const ackPromise = waitForMessage(
      mainArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    mainArchitect.send(JSON.stringify({
      type: 'send',
      target: 'architect',
      content: 'architect-profile-route-main-to-side-handler',
      messageId,
      ackRequired: true,
      metadata: {
        routing: {
          profileName: 'eunbyeol',
          windowKey: 'eunbyeol',
        },
        sourceAddress: 'architect@main',
        targetAddress: 'architect@eunbyeol',
        routeAttribution: {
          sourceProfileName: 'main',
          sourceWindowKey: 'main',
          sourceAddress: 'architect@main',
          targetProfileName: 'eunbyeol',
          targetWindowKey: 'eunbyeol',
          targetAddress: 'architect@eunbyeol',
        },
      },
    }));

    const ack = await ackPromise;
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('delivered.verified');
    expect(ack.wsDeliveryCount).toBe(0);
    expect(onMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
      role: 'architect',
      paneId: '1',
      message: expect.objectContaining({
        target: 'architect',
        messageId,
      }),
    }));
  });

  test('routes side architect to main architect through explicit main profile route', async () => {
    const scopedArchitect = await connectAndRegister({
      port,
      role: 'architect',
      paneId: '1',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedArchitect);

    onMessageSpy.mockImplementation((payload) => {
      if (payload?.message?.type === 'send' && payload?.message?.messageId === 'architect-profile-route-side-to-main-1') {
        return {
          ok: true,
          accepted: true,
          queued: true,
          verified: true,
          status: 'delivered.verified',
          paneId: '1',
          mode: 'main-terminal',
        };
      }
      return undefined;
    });

    const messageId = 'architect-profile-route-side-to-main-1';
    const ackPromise = waitForMessage(
      scopedArchitect,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    scopedArchitect.send(JSON.stringify({
      type: 'send',
      target: 'architect',
      content: 'architect-profile-route-side-to-main',
      messageId,
      ackRequired: true,
      metadata: {
        routing: {
          profileName: 'main',
          windowKey: 'main',
        },
        sourceAddress: 'architect@eunbyeol',
        targetAddress: 'architect@main',
        routeAttribution: {
          sourceProfileName: 'eunbyeol',
          sourceWindowKey: 'eunbyeol',
          sourceAddress: 'architect@eunbyeol',
          targetProfileName: 'main',
          targetWindowKey: 'main',
          targetAddress: 'architect@main',
        },
      },
    }));

    const ack = await ackPromise;
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('delivered.verified');
    expect(ack.wsDeliveryCount).toBe(0);
    expect(onMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
      role: 'architect',
      paneId: '1',
      message: expect.objectContaining({
        target: 'architect',
        messageId,
      }),
    }));
  });

  test('blocks non-architect side senders from using the cross-profile architect route', async () => {
    const mainArchitect = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainArchitect);
    const scopedBuilder = await connectAndRegister({
      port,
      role: 'builder',
      paneId: '2',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedBuilder);

    let leakedToMain = false;
    mainArchitect.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.content === 'builder-cross-profile-not-allowed') {
          leakedToMain = true;
        }
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    });

    const messageId = 'architect-profile-route-block-builder-1';
    const ackPromise = waitForMessage(
      scopedBuilder,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    scopedBuilder.send(JSON.stringify({
      type: 'send',
      target: 'architect',
      content: 'builder-cross-profile-not-allowed',
      messageId,
      ackRequired: true,
      metadata: {
        routing: {
          profileName: 'main',
          windowKey: 'main',
        },
      },
    }));

    const ack = await ackPromise;
    await sleep(100);
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('cross_profile_scope_mismatch');
    expect(ack.routeScope).toEqual(expect.objectContaining({ profileName: 'main' }));
    expect(leakedToMain).toBe(false);
  });

  test('blocks non-architect main senders from using the cross-profile architect route', async () => {
    const scopedArchitect = await connectAndRegister({
      port,
      role: 'architect',
      paneId: '1',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedArchitect);
    const mainBuilder = await connectAndRegister({ port, role: 'builder', paneId: '2', profileName: 'main' });
    activeClients.add(mainBuilder);

    let leakedToSide = false;
    scopedArchitect.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message' && msg.content === 'main-builder-cross-profile-not-allowed') {
          leakedToSide = true;
        }
      } catch (_err) {
        // Ignore non-JSON frames.
      }
    });

    const messageId = 'architect-profile-route-block-main-builder-1';
    const ackPromise = waitForMessage(
      mainBuilder,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    mainBuilder.send(JSON.stringify({
      type: 'send',
      target: 'architect',
      content: 'main-builder-cross-profile-not-allowed',
      messageId,
      ackRequired: true,
      metadata: {
        routing: {
          profileName: 'eunbyeol',
          windowKey: 'eunbyeol',
        },
      },
    }));

    const ack = await ackPromise;
    await sleep(100);
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('cross_profile_scope_mismatch');
    expect(ack.routeScope).toEqual(expect.objectContaining({ profileName: 'eunbyeol' }));
    expect(leakedToSide).toBe(false);
  });

  test('main can route to scoped profile only with explicit routing metadata', async () => {
    const scopedReceiver = await connectAndRegister({
      port,
      role: 'builder',
      paneId: '2',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
    });
    activeClients.add(scopedReceiver);
    const mainSender = await connectAndRegister({ port, role: 'architect', paneId: '1', profileName: 'main' });
    activeClients.add(mainSender);

    const delivery = waitForMessage(
      scopedReceiver,
      (msg) => msg.type === 'message' && msg.content === 'explicit-scoped-route'
    );
    const messageId = 'main-explicit-scope-1';
    const ackPromise = waitForMessage(
      mainSender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    mainSender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'explicit-scoped-route',
      messageId,
      ackRequired: true,
      metadata: {
        routing: {
          profileName: 'eunbyeol',
          windowKey: 'eunbyeol',
        },
      },
    }));

    const [ack, received] = await Promise.all([ackPromise, delivery]);
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('delivered.websocket');
    expect(received.from).toBe('architect');
  });

  test('forwards send metadata payload to websocket recipients', async () => {
    const receiver = await connectAndRegister({ port, role: 'builder', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const delivery = waitForMessage(receiver, (msg) => msg.type === 'message' && msg.content === 'meta-ping');

    sender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'meta-ping',
      metadata: {
        project: {
          name: 'sample-project',
          path: '/tmp/sample-project',
        },
      },
    }));

    const received = await delivery;
    expect(received.metadata).toEqual(expect.objectContaining({
      project: expect.objectContaining({
        name: 'sample-project',
        path: '/tmp/sample-project',
      }),
    }));
  });

  test('normalizes sender role alias director to architect on registration', async () => {
    const receiver = await connectAndRegister({ port, role: 'builder', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'director', paneId: '1' });
    activeClients.add(sender);

    const delivery = waitForMessage(receiver, (msg) => msg.type === 'message' && msg.content === 'alias-role-ping');

    sender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'alias-role-ping',
      priority: 'normal',
    }));

    const received = await delivery;
    expect(received.from).toBe('architect');
  });

  test('returns send-ack when ackRequired is true and route is delivered', async () => {
    const receiver = await connectAndRegister({ port, role: 'builder', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const messageId = 'ack-delivered-1';
    const ackPromise = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);
    const delivery = waitForMessage(receiver, (msg) => msg.type === 'message' && msg.content === 'needs-ack');

    sender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'needs-ack',
      messageId,
      ackRequired: true,
    }));

    const [ack, received] = await Promise.all([ackPromise, delivery]);
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('delivered.websocket');
    expect(ack.verified).toBe(false);
    expect(ack.userVisible).toBe(false);
    expect(ack.traceId).toBe(messageId);
    expect(received.from).toBe('architect');
  });

  test('does not let unverified local-role websocket delivery short-circuit local pane handler', async () => {
    const receiver = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'oracle', paneId: '3' });
    activeClients.add(sender);

    onMessageSpy.mockImplementation((payload) => {
      if (payload?.message?.type === 'send' && /^oracle-(86|91)-pass-/.test(payload.message.messageId || '')) {
        return {
          ok: true,
          accepted: true,
          queued: true,
          verified: false,
          status: 'accepted.unverified',
          mode: 'local-pane-injection',
        };
      }
      return undefined;
    });

    const cases = [
      {
        messageId: 'oracle-86-pass-short',
        content: '(ORACLE 86): PASS',
      },
      {
        messageId: 'oracle-91-pass-recorded',
        content: '(ORACLE 91): PASS. Builder packet meets all criteria and should not stop at recorded-only websocket delivery.',
      },
    ];

    for (const current of cases) {
      const ackPromise = waitForMessage(
        sender,
        (msg) => msg.type === 'send-ack' && msg.messageId === current.messageId
      );
      const delivery = waitForMessage(
        receiver,
        (msg) => msg.type === 'message' && msg.content === current.content
      );

      sender.send(JSON.stringify({
        type: 'send',
        target: 'architect',
        content: current.content,
        messageId: current.messageId,
        ackRequired: true,
      }));

      const [ack, received] = await Promise.all([ackPromise, delivery]);
      expect(ack.ok).toBe(true);
      expect(ack.status).toBe('delivered.websocket');
      expect(ack.verified).toBe(false);
      expect(ack.userVisible).toBe(false);
      expect(ack.wsDeliveryCount).toBe(1);
      expect(received.from).toBe('oracle');
    }

    const localHandlerCalls = onMessageSpy.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => /^oracle-(86|91)-pass-/.test(payload?.message?.messageId || ''));
    expect(localHandlerCalls).toHaveLength(2);
    expect(localHandlerCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'oracle',
        paneId: '3',
        message: expect.objectContaining({
          target: 'architect',
          messageId: 'oracle-86-pass-short',
        }),
      }),
      expect.objectContaining({
        role: 'oracle',
        paneId: '3',
        message: expect.objectContaining({
          target: 'architect',
          messageId: 'oracle-91-pass-recorded',
        }),
      }),
    ]));
  });

  test('does not count a self-targeted transient websocket client as pane-visible delivery', async () => {
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const messageId = 'self-target-not-visible-1';
    const ackPromise = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);

    sender.send(JSON.stringify({
      type: 'send',
      target: 'architect',
      content: 'self-target should fall through to handler, not echo to transient client',
      messageId,
      ackRequired: true,
    }));

    const ack = await ackPromise;
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('unrouted');
    expect(ack.wsDeliveryCount).toBe(0);
    expect(ack.verified).toBe(false);
    expect(ack.userVisible).toBe(false);
    expect(onMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
      clientId: expect.any(Number),
      role: 'architect',
      message: expect.objectContaining({
        target: 'architect',
        messageId,
      }),
    }));
  });

  test('forwards trace context to message handler for routed send', async () => {
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);
    const messageId = 'trace-forward-1';

    const ackPromise = waitForMessage(
      sender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    sender.send(JSON.stringify({
      type: 'send',
      target: 'missing-role',
      content: 'trace-forward',
      messageId,
      ackRequired: true,
    }));

    await ackPromise;
    const routedSend = onMessageSpy.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.message?.messageId === messageId);

    expect(routedSend).toBeDefined();
    expect(routedSend.traceContext).toEqual(expect.objectContaining({
      traceId: messageId,
      correlationId: messageId,
    }));
    expect(routedSend.message.traceContext).toEqual(expect.objectContaining({
      traceId: messageId,
      correlationId: messageId,
    }));
  });

  test('returns unrouted send-ack when ackRequired is true and no route exists', async () => {
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const messageId = 'ack-unrouted-1';
    const ackPromise = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);

    sender.send(JSON.stringify({
      type: 'send',
      target: 'missing-role',
      content: 'no-route',
      messageId,
      ackRequired: true,
    }));

    const ack = await ackPromise;
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('unrouted');
  });

  test('treats accepted.unverified as successful send-ack (ok=true)', async () => {
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);
    onMessageSpy.mockImplementation(() => ({
      accepted: true,
      queued: true,
      verified: false,
      status: 'accepted.unverified',
    }));

    const messageId = 'ack-accepted-unverified-1';
    const ackPromise = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);

    sender.send(JSON.stringify({
      type: 'send',
      target: 'missing-role',
      content: 'accepted-unverified',
      messageId,
      ackRequired: true,
    }));

    const ack = await ackPromise;
    expect(ack.ok).toBe(true);
    expect(ack.accepted).toBe(true);
    expect(ack.queued).toBe(true);
    expect(ack.verified).toBe(false);
    expect(ack.status).toBe('accepted.unverified');
  });

  test('deduplicates ackRequired send by messageId and reuses prior ack', async () => {
    const receiver = await connectAndRegister({ port, role: 'builder', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const messageId = 'ack-dedup-1';
    let deliveredCount = 0;
    receiver.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'message' && msg.content === 'dedup-payload') {
        deliveredCount++;
      }
    });

    const firstAck = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);
    const firstDelivery = waitForMessage(receiver, (msg) => msg.type === 'message' && msg.content === 'dedup-payload');
    sender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'dedup-payload',
      messageId,
      ackRequired: true,
    }));
    await Promise.all([firstAck, firstDelivery]);

    const secondAckPromise = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);
    sender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'dedup-payload',
      messageId,
      ackRequired: true,
    }));
    const secondAck = await secondAckPromise;

    await new Promise((resolve) => setTimeout(resolve, 100));

    const routedSendCalls = onMessageSpy.mock.calls
      .map(([payload]) => payload?.message)
      .filter((msg) => msg?.type === 'send' && msg?.messageId === messageId);
    const dedupeMetricCalls = onMessageSpy.mock.calls
      .map(([payload]) => payload?.message)
      .filter((msg) => msg?.type === 'comms-metric' && msg?.eventType === 'comms.dedupe.hit');

    expect(deliveredCount).toBe(1);
    // Canonical local role targets must still reach the app handler; cached resend does not.
    expect(routedSendCalls).toHaveLength(1);
    expect(dedupeMetricCalls).toHaveLength(1);
    expect(dedupeMetricCalls[0].payload.mode).toBe('cache');
    expect(secondAck.ok).toBe(true);
    expect(secondAck.status).toBe('delivered.websocket');
  });

  test('deduplicates reconnect resend by sender/target/content signature when messageId changes', async () => {
    const receiver = await connectAndRegister({ port, role: 'builder', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'oracle', paneId: '3' });
    activeClients.add(sender);

    const firstMessageId = 'ack-signature-dedup-1';
    const secondMessageId = 'ack-signature-dedup-2';
    let deliveredCount = 0;
    receiver.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'message' && msg.content === 'signature-dedup-payload') {
        deliveredCount++;
      }
    });

    const firstAckPromise = waitForMessage(
      sender,
      (msg) => msg.type === 'send-ack' && msg.messageId === firstMessageId
    );
    const firstDeliveryPromise = waitForMessage(
      receiver,
      (msg) => msg.type === 'message' && msg.content === 'signature-dedup-payload'
    );
    sender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'signature-dedup-payload',
      messageId: firstMessageId,
      ackRequired: true,
    }));
    await Promise.all([firstAckPromise, firstDeliveryPromise]);

    const secondAckPromise = waitForMessage(
      sender,
      (msg) => msg.type === 'send-ack' && msg.messageId === secondMessageId
    );
    sender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'signature-dedup-payload',
      messageId: secondMessageId,
      ackRequired: true,
    }));
    const secondAck = await secondAckPromise;

    await new Promise((resolve) => setTimeout(resolve, 100));

    const routedSendCalls = onMessageSpy.mock.calls
      .map(([payload]) => payload?.message)
      .filter((msg) => msg?.type === 'send' && msg?.content === 'signature-dedup-payload');
    const signatureDedupeMetricCalls = onMessageSpy.mock.calls
      .map(([payload]) => payload?.message)
      .filter((msg) => msg?.type === 'comms-metric' && msg?.eventType === 'comms.dedupe.hit')
      .filter((msg) => msg?.payload?.mode === 'signature_cache');

    expect(deliveredCount).toBe(1);
    // Canonical local role targets must still reach the app handler; signature-cached resend does not.
    expect(routedSendCalls).toHaveLength(1);
    expect(signatureDedupeMetricCalls).toHaveLength(1);
    expect(secondAck.ok).toBe(true);
    expect(secondAck.status).toBe('delivered.websocket');
    expect(secondAck.messageId).toBe(secondMessageId);
  });

  test('returns cached delivery-check result for previously ACKed messageId', async () => {
    const receiver = await connectAndRegister({ port, role: 'builder', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const messageId = 'delivery-check-cached-1';
    const ackPromise = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);
    sender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: 'delivery-check-payload',
      messageId,
      ackRequired: true,
    }));
    const ack = await ackPromise;
    expect(ack.ok).toBe(true);

    const requestId = 'delivery-check-request-1';
    const checkPromise = waitForMessage(
      sender,
      (msg) => msg.type === 'delivery-check-result' && msg.requestId === requestId
    );
    sender.send(JSON.stringify({
      type: 'delivery-check',
      requestId,
      messageId,
    }));

    const check = await checkPromise;
    expect(check.known).toBe(true);
    expect(check.status).toBe('cached');
    expect(check.pending).toBe(false);
    expect(check.ack).toEqual(expect.objectContaining({
      type: 'send-ack',
      messageId,
      ok: true,
    }));
  });

  test('overlays cached delivery-check ACK with modelPromptReceipt proof', async () => {
    const tempReceiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-ws-receipts-'));
    process.env.SQUIDRUN_MODEL_PROMPT_RECEIPT_DIR = tempReceiptDir;
    try {
      const receiver = await connectAndRegister({ port, role: 'builder', paneId: '2' });
      activeClients.add(receiver);
      const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
      activeClients.add(sender);

      const messageId = 'delivery-check-receipt-overlay-1';
      const ackPromise = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);
      sender.send(JSON.stringify({
        type: 'send',
        target: 'builder',
        content: 'receipt-overlay-payload',
        messageId,
        ackRequired: true,
      }));
      const ack = await ackPromise;
      expect(ack.ok).toBe(true);

      const { appendModelPromptReceipt } = require('../modules/model-prompt-receipt');
      appendModelPromptReceipt({
        runtime: 'codex',
        hookEventName: 'UserPromptSubmit',
        payload: {
          prompt: `receipt\n[SQUIDRUN_RECEIPT event=prompt_submit deliveryId=${messageId} messageId=${messageId}]`,
        },
      });

      const requestId = 'delivery-check-receipt-overlay-request-1';
      const checkPromise = waitForMessage(
        sender,
        (msg) => msg.type === 'delivery-check-result' && msg.requestId === requestId
      );
      sender.send(JSON.stringify({
        type: 'delivery-check',
        requestId,
        messageId,
      }));

      const check = await checkPromise;
      expect(check.ack).toEqual(expect.objectContaining({
        type: 'send-ack',
        messageId,
        status: 'prompt_submitted.in_band',
        verified: true,
      }));
      expect(check.ack.modelPromptReceipt).toEqual(expect.objectContaining({
        semanticEvent: 'prompt_submit',
        payloadDropped: true,
      }));
    } finally {
      delete process.env.SQUIDRUN_MODEL_PROMPT_RECEIPT_DIR;
      fs.rmSync(tempReceiptDir, { recursive: true, force: true });
    }
  });

  test('tracks routing health and reports stale targets by threshold', async () => {
    const targetClient = await connectAndRegister({ port, role: 'builder', paneId: '2' });
    activeClients.add(targetClient);
    const probeClient = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(probeClient);

    const freshRequestId = 'health-fresh-1';
    const freshHealthPromise = waitForMessage(
      probeClient,
      (msg) => msg.type === 'health-check-result' && msg.requestId === freshRequestId
    );
    probeClient.send(JSON.stringify({
      type: 'health-check',
      target: 'builder',
      requestId: freshRequestId,
    }));
    const freshHealth = await freshHealthPromise;
    expect(freshHealth.healthy).toBe(true);
    expect(freshHealth.status).toBe('healthy');
    expect(freshHealth.role).toBe('builder');
    expect(freshHealth.paneId).toBe('2');

    await new Promise((resolve) => setTimeout(resolve, 5));
    const staleRequestId = 'health-stale-1';
    const staleHealthPromise = waitForMessage(
      probeClient,
      (msg) => msg.type === 'health-check-result' && msg.requestId === staleRequestId
    );
    probeClient.send(JSON.stringify({
      type: 'health-check',
      target: 'builder',
      requestId: staleRequestId,
      staleAfterMs: 1,
    }));
    const staleHealth = await staleHealthPromise;
    expect(staleHealth.healthy).toBe(false);
    expect(staleHealth.status).toBe('stale');
  });

  test('reports local handler route when registered main target client disconnects', async () => {
    const targetClient = await connectAndRegister({ port, role: 'builder', paneId: '2' });
    activeClients.add(targetClient);
    const probeClient = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(probeClient);

    await closeClient(targetClient);
    activeClients.delete(targetClient);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const requestId = 'health-after-disconnect-1';
    const healthPromise = waitForMessage(
      probeClient,
      (msg) => msg.type === 'health-check-result' && msg.requestId === requestId
    );
    probeClient.send(JSON.stringify({
      type: 'health-check',
      target: 'builder',
      requestId,
    }));

    const health = await healthPromise;
    expect(health.healthy).toBe(true);
    expect(health.status).toBe('handler_route_available');
    expect(health.source).toBe('local_message_handler');
    expect(health.paneId).toBe('2');
    expect(health.role).toBe('builder');
  });

  test('health exposes terminal-backed work-room route binding for client_activity routes', async () => {
    const routeBinding = {
      clientKind: 'work_room_route_client',
      routeOwner: 'trustquote-work-room-route-owner',
      roomId: 'trustquote',
      role: 'builder',
      paneId: 'trustquote-builder',
      terminalPaneId: 'trustquote-builder',
      terminalBacked: true,
      agentProcessStarted: true,
      profileName: 'trustquote',
      windowKey: 'trustquote',
      sessionScopeId: 'app-test:trustquote',
      workspace: 'D:/projects/TrustQuote',
      startupBundlePath: 'D:/projects/squidrun/.squidrun/runtime/window-teams/trustquote/startup-bundle.md',
      workstreamPath: 'D:/projects/TrustQuote/.squidrun/work-rooms/trustquote/current-workstream.json',
    };
    const targetClient = await connectAndRegister({
      port,
      role: 'builder',
      paneId: '2',
      profileName: 'trustquote',
      windowKey: 'trustquote',
      sessionScopeId: 'app-test:trustquote',
      routeBinding,
    });
    activeClients.add(targetClient);
    const probeClient = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(probeClient);

    const heartbeatId = 'route-heartbeat-1';
    const heartbeatPromise = waitForMessage(
      targetClient,
      (msg) => msg.type === 'route-heartbeat-ack' && msg.requestId === heartbeatId
    );
    targetClient.send(JSON.stringify({ type: 'route-heartbeat', requestId: heartbeatId }));
    const heartbeat = await heartbeatPromise;
    expect(heartbeat.routeBinding).toEqual(expect.objectContaining({
      clientKind: 'work_room_route_client',
      terminalBacked: true,
      agentProcessStarted: true,
      sessionScopeId: 'app-test:trustquote',
    }));

    const requestId = 'health-work-room-route-1';
    const healthPromise = waitForMessage(
      probeClient,
      (msg) => msg.type === 'health-check-result' && msg.requestId === requestId
    );
    probeClient.send(JSON.stringify({
      type: 'health-check',
      target: 'builder',
      requestId,
      metadata: {
        routing: {
          profileName: 'trustquote',
          windowKey: 'trustquote',
          sessionScopeId: 'app-test:trustquote',
        },
      },
    }));

    const health = await healthPromise;
    expect(health.healthy).toBe(true);
    expect(health.source).toBe('client_activity');
    expect(health.clientKind).toBe('work_room_route_client');
    expect(health.routeBinding).toEqual(expect.objectContaining(routeBinding));
  });

  test('scoped main-to-room websocket delivery skips main handler fallback for canonical targets', async () => {
    const routeBinding = {
      clientKind: 'work_room_route_client',
      routeOwner: 'trustquote-work-room-route-owner',
      roomId: 'trustquote',
      role: 'builder',
      paneId: 'trustquote-builder',
      terminalPaneId: 'trustquote-builder',
      terminalBacked: true,
      agentProcessStarted: true,
      profileName: 'trustquote',
      windowKey: 'trustquote',
      sessionScopeId: 'app-test:trustquote',
      workspace: 'D:/projects/TrustQuote',
    };
    const receiver = await connectAndRegister({
      port,
      role: 'builder',
      paneId: 'trustquote-builder',
      profileName: 'trustquote',
      windowKey: 'trustquote',
      sessionScopeId: 'app-test:trustquote',
      routeBinding,
    });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    onMessageSpy.mockClear();
    const messageId = 'trustquote-forward-no-main-fallback-1';
    const routedMessagePromise = waitForMessage(
      receiver,
      (msg) => msg.type === 'message' && msg.traceId === messageId
    );
    const ackPromise = waitForMessage(
      sender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );
    sender.send(JSON.stringify({
      type: 'send',
      target: 'builder',
      content: '(ARCHITECT): TrustQuote scoped route proof',
      messageId,
      ackRequired: true,
      metadata: {
        routing: {
          profileName: 'trustquote',
          windowKey: 'trustquote',
          sessionScopeId: 'app-test:trustquote',
        },
      },
    }));

    const routedMessage = await routedMessagePromise;
    const ack = await ackPromise;
    expect(routedMessage.content).toBe('(ARCHITECT): TrustQuote scoped route proof');
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('delivered.websocket');
    expect(ack.wsDeliveryCount).toBe(1);
    const handlerSendCalls = onMessageSpy.mock.calls
      .map((call) => call[0])
      .filter((payload) => payload?.message?.type === 'send');
    expect(handlerSendCalls).toHaveLength(0);
  });

  test('side-profile health exposes local handler route readiness before scoped terminal delivery', async () => {
    const scopedProbe = await connectAndRegister({
      port,
      role: 'architect',
      paneId: '1',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedProbe);

    const requestId = 'health-side-handler-route-1';
    const healthPromise = waitForMessage(
      scopedProbe,
      (msg) => msg.type === 'health-check-result' && msg.requestId === requestId
    );
    scopedProbe.send(JSON.stringify({
      type: 'health-check',
      target: 'builder',
      requestId,
    }));

    const health = await healthPromise;
    expect(health.healthy).toBe(true);
    expect(health.status).toBe('handler_route_available');
    expect(health.source).toBe('local_message_handler');
    expect(health.routeScope).toEqual(expect.objectContaining({
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
    }));
  });

  test('side-profile health does not count the probing client as its own target route', async () => {
    const scopedProbe = await connectAndRegister({
      port,
      role: 'architect',
      paneId: '1',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedProbe);

    const requestId = 'health-side-self-route-1';
    const healthPromise = waitForMessage(
      scopedProbe,
      (msg) => msg.type === 'health-check-result' && msg.requestId === requestId
    );
    scopedProbe.send(JSON.stringify({
      type: 'health-check',
      target: 'architect',
      requestId,
    }));

    const health = await healthPromise;
    expect(health.healthy).toBe(true);
    expect(health.status).toBe('handler_route_available');
    expect(health.source).toBe('local_message_handler');
    expect(health.role).toBe('architect');
    expect(health.paneId).toBe('1');
  });

  test('side-profile send to same role uses local handler instead of websocket self-ack', async () => {
    onMessageSpy.mockResolvedValue({
      ok: true,
      accepted: true,
      queued: true,
      verified: true,
      status: 'delivered.verified',
    });
    const scopedSender = await connectAndRegister({
      port,
      role: 'architect',
      paneId: '1',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
    });
    activeClients.add(scopedSender);

    const messageId = 'self-route-handler-1';
    const ackPromise = waitForMessage(
      scopedSender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );
    scopedSender.send(JSON.stringify({
      type: 'send',
      target: 'architect',
      content: 'must reach pane handler, not sender websocket',
      messageId,
      ackRequired: true,
    }));

    const ack = await ackPromise;
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('delivered.verified');
    expect(ack.wsDeliveryCount).toBe(0);
    const sendCalls = onMessageSpy.mock.calls
      .map((call) => call[0])
      .filter((payload) => payload?.message?.type === 'send');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].message.target).toBe('architect');
  });

  test('treats background alias targets as valid for health checks', async () => {
    const probeClient = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(probeClient);

    const requestId = 'health-bg-alias-1';
    const healthPromise = waitForMessage(
      probeClient,
      (msg) => msg.type === 'health-check-result' && msg.requestId === requestId
    );
    probeClient.send(JSON.stringify({
      type: 'health-check',
      target: 'builder-bg-1',
      requestId,
    }));

    const health = await healthPromise;
    expect(health.status).toBe('no_route');
    expect(health.paneId).toBe('bg-2-1');
    expect(health.role).toBe('builder-bg-1');
  });

  test('refreshes target health on message activity', async () => {
    const targetClient = await connectAndRegister({ port, role: 'builder', paneId: '2' });
    activeClients.add(targetClient);
    const probeClient = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(probeClient);

    await new Promise((resolve) => setTimeout(resolve, 5));

    const staleRequestId = 'health-before-send-1';
    const staleHealthPromise = waitForMessage(
      probeClient,
      (msg) => msg.type === 'health-check-result' && msg.requestId === staleRequestId
    );
    probeClient.send(JSON.stringify({
      type: 'health-check',
      target: 'builder',
      requestId: staleRequestId,
      staleAfterMs: 1,
    }));
    const staleHealth = await staleHealthPromise;
    expect(staleHealth.healthy).toBe(false);

    targetClient.send(JSON.stringify({
      type: 'send',
      target: 'missing-role',
      content: 'presence-refresh-ping',
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const freshRequestId = 'health-after-send-1';
    const freshHealthPromise = waitForMessage(
      probeClient,
      (msg) => msg.type === 'health-check-result' && msg.requestId === freshRequestId
    );
    probeClient.send(JSON.stringify({
      type: 'health-check',
      target: 'builder',
      requestId: freshRequestId,
      staleAfterMs: 100,
    }));
    const freshHealth = await freshHealthPromise;
    expect(freshHealth.healthy).toBe(true);
    expect(freshHealth.status).toBe('healthy');
  });

  test('includes handler error details in send-ack when message handler throws', async () => {
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    onMessageSpy.mockImplementation((payload) => {
      if (payload?.message?.type === 'send' && payload?.message?.messageId === 'ack-handler-error-1') {
        throw new Error('simulated handler failure');
      }
      return undefined;
    });

    const ackPromise = waitForMessage(
      sender,
      (msg) => msg.type === 'send-ack' && msg.messageId === 'ack-handler-error-1'
    );

    sender.send(JSON.stringify({
      type: 'send',
      target: 'missing-role',
      content: 'handler-should-fail',
      messageId: 'ack-handler-error-1',
      ackRequired: true,
    }));

    const ack = await ackPromise;
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('handler_error');
    expect(ack.error).toBe('simulated handler failure');

    onMessageSpy.mockImplementation(() => undefined);
  });

  test('evicts pending ACK state when sender disconnects so reused messageId can proceed', async () => {
    const senderA = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(senderA);

    let firstDispatch = true;
    onMessageSpy.mockImplementation((payload) => {
      if (payload?.message?.type === 'send' && payload?.message?.messageId === 'pending-disconnect-ack-1') {
        if (firstDispatch) {
          firstDispatch = false;
          return new Promise(() => {});
        }
        return {
          accepted: false,
          queued: false,
          verified: false,
          status: 'unrouted',
        };
      }
      return undefined;
    });

    senderA.send(JSON.stringify({
      type: 'send',
      target: 'missing-role',
      content: 'stuck-first-dispatch',
      messageId: 'pending-disconnect-ack-1',
      ackRequired: true,
    }));

    await new Promise((resolve) => setTimeout(resolve, 25));
    await closeClient(senderA);
    activeClients.delete(senderA);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const senderB = await connectAndRegister({ port, role: 'oracle', paneId: '3' });
    activeClients.add(senderB);

    const ackPromise = waitForMessage(
      senderB,
      (msg) => msg.type === 'send-ack' && msg.messageId === 'pending-disconnect-ack-1'
    );
    senderB.send(JSON.stringify({
      type: 'send',
      target: 'missing-role',
      content: 'reused-id-after-disconnect',
      messageId: 'pending-disconnect-ack-1',
      ackRequired: true,
    }));

    const ack = await ackPromise;
    expect(ack.status).toBe('unrouted');
    expect(ack.ok).toBe(false);

    onMessageSpy.mockImplementation(() => undefined);
  });
});
