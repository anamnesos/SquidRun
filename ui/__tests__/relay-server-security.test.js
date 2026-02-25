const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

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

function startRelayServer({ port, sharedSecret, allowlist = '' }) {
  return new Promise((resolve, reject) => {
    const relayPath = path.join(__dirname, '..', '..', 'relay', 'server.js');
    const child = spawn(process.execPath, [relayPath], {
      cwd: path.join(__dirname, '..', '..'),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        RELAY_SHARED_SECRET: sharedSecret,
        RELAY_DEVICE_ALLOWLIST: allowlist,
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
      reject(new Error(`Relay startup timeout. stdout=${stdout} stderr=${stderr}`));
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

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      ws.off('error', onError);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for message`));
    }, timeoutMs);

    function done(err, payload) {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      if (err) reject(err);
      else resolve(payload);
    }

    function onError(err) {
      done(err);
    }

    function onMessage(raw) {
      let parsed = null;
      try {
        parsed = JSON.parse(raw.toString());
      } catch (_err) {
        return;
      }
      if (predicate(parsed)) {
        done(null, parsed);
      }
    }

    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

describe('relay server security controls', () => {
  jest.setTimeout(30000);

  let relay = null;
  const sockets = [];

  async function openSocket(url) {
    const ws = await connectWs(url);
    sockets.push(ws);
    return ws;
  }

  afterEach(async () => {
    for (const ws of sockets.splice(0, sockets.length)) {
      try {
        ws.close();
      } catch (_err) {
        // best effort
      }
    }
    if (relay) {
      await relay.stop();
      relay = null;
    }
  });

  test('rejects registration for device IDs outside allowlist', async () => {
    const port = await getFreePort();
    relay = await startRelayServer({
      port,
      sharedSecret: 'relay-secret',
      allowlist: 'LOCAL,PEER',
    });
    const url = `ws://127.0.0.1:${port}`;
    const ws = await openSocket(url);

    ws.send(JSON.stringify({
      type: 'register',
      deviceId: 'UNKNOWN_DEVICE',
      sharedSecret: 'relay-secret',
    }));

    const ack = await waitForMessage(ws, (msg) => msg.type === 'register-ack');
    expect(ack.ok).toBe(false);
    expect(String(ack.error || '')).toContain('allowlist');
  });

  test('rejects xsend payloads targeting non-architect roles', async () => {
    const port = await getFreePort();
    relay = await startRelayServer({
      port,
      sharedSecret: 'relay-secret',
      allowlist: 'LOCAL,PEER',
    });
    const url = `ws://127.0.0.1:${port}`;
    const sender = await openSocket(url);
    const receiver = await openSocket(url);

    sender.send(JSON.stringify({ type: 'register', deviceId: 'LOCAL', sharedSecret: 'relay-secret' }));
    receiver.send(JSON.stringify({ type: 'register', deviceId: 'PEER', sharedSecret: 'relay-secret' }));
    await waitForMessage(sender, (msg) => msg.type === 'register-ack' && msg.ok === true);
    await waitForMessage(receiver, (msg) => msg.type === 'register-ack' && msg.ok === true);

    sender.send(JSON.stringify({
      type: 'xsend',
      messageId: 'role-block-1',
      fromDevice: 'LOCAL',
      toDevice: 'PEER',
      fromRole: 'architect',
      targetRole: 'builder',
      content: 'should not forward',
      metadata: {},
    }));

    const senderAck = await waitForMessage(sender, (msg) => msg.type === 'xack' && msg.messageId === 'role-block-1');
    expect(senderAck.ok).toBe(false);
    expect(senderAck.status).toBe('target_role_rejected');

    await expect(
      waitForMessage(receiver, (msg) => msg.type === 'xdeliver', 700)
    ).rejects.toThrow(/Timed out/);
  });

  test('returns connected device list when xsend targets unknown device id', async () => {
    const port = await getFreePort();
    relay = await startRelayServer({
      port,
      sharedSecret: 'relay-secret',
      allowlist: 'LOCAL,PEER',
    });
    const url = `ws://127.0.0.1:${port}`;
    const sender = await openSocket(url);
    const receiver = await openSocket(url);

    sender.send(JSON.stringify({ type: 'register', deviceId: 'LOCAL', sharedSecret: 'relay-secret' }));
    receiver.send(JSON.stringify({ type: 'register', deviceId: 'PEER', sharedSecret: 'relay-secret' }));
    await waitForMessage(sender, (msg) => msg.type === 'register-ack' && msg.ok === true);
    await waitForMessage(receiver, (msg) => msg.type === 'register-ack' && msg.ok === true);

    sender.send(JSON.stringify({
      type: 'xsend',
      messageId: 'unknown-device-1',
      fromDevice: 'LOCAL',
      toDevice: 'WINDOWS',
      fromRole: 'architect',
      targetRole: 'architect',
      content: 'route this',
      metadata: {},
    }));

    const senderAck = await waitForMessage(sender, (msg) => msg.type === 'xack' && msg.messageId === 'unknown-device-1');
    expect(senderAck.ok).toBe(false);
    expect(senderAck.status).toBe('target_offline');
    expect(senderAck.unknownDevice).toBe('WINDOWS');
    expect(senderAck.connectedDevices).toEqual(['LOCAL', 'PEER']);
    expect(String(senderAck.error || '')).toContain('Connected devices: LOCAL, PEER');
  });

  test('forwards architect-targeted payloads and relays delivery ack', async () => {
    const port = await getFreePort();
    relay = await startRelayServer({
      port,
      sharedSecret: 'relay-secret',
      allowlist: 'LOCAL,PEER',
    });
    const url = `ws://127.0.0.1:${port}`;
    const sender = await openSocket(url);
    const receiver = await openSocket(url);

    sender.send(JSON.stringify({ type: 'register', deviceId: 'LOCAL', sharedSecret: 'relay-secret' }));
    receiver.send(JSON.stringify({ type: 'register', deviceId: 'PEER', sharedSecret: 'relay-secret' }));
    await waitForMessage(sender, (msg) => msg.type === 'register-ack' && msg.ok === true);
    await waitForMessage(receiver, (msg) => msg.type === 'register-ack' && msg.ok === true);

    sender.send(JSON.stringify({
      type: 'xsend',
      messageId: 'role-pass-1',
      fromDevice: 'LOCAL',
      toDevice: 'PEER',
      fromRole: 'architect',
      targetRole: 'architect',
      content: 'deliver this',
      metadata: {},
    }));

    const delivered = await waitForMessage(receiver, (msg) => msg.type === 'xdeliver' && msg.messageId === 'role-pass-1');
    expect(delivered.targetRole).toBe('architect');
    expect(delivered.content).toBe('deliver this');

    receiver.send(JSON.stringify({
      type: 'xack',
      messageId: 'role-pass-1',
      ok: true,
      accepted: true,
      queued: true,
      verified: true,
      status: 'bridge_delivered',
    }));

    const senderAck = await waitForMessage(sender, (msg) => msg.type === 'xack' && msg.messageId === 'role-pass-1');
    expect(senderAck).toMatchObject({
      ok: true,
      status: 'bridge_delivered',
      fromDevice: 'LOCAL',
      toDevice: 'PEER',
    });
  });
});
