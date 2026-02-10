/**
 * hm-send retry/backoff integration tests
 */

const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

function runHmSend(args, env = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-send.js');
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...env },
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
      ['devops', '(TEST #1): retry backoff', '--timeout', '80', '--retries', '1', '--no-fallback'],
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
});

