'use strict';

const net = require('net');
const { PIPE_PATH } = require('../config');

function parseDaemonLine(line) {
  try {
    return JSON.parse(String(line || ''));
  } catch (_) {
    return null;
  }
}

function requestDaemonTerminalSnapshot(options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(250, Number(options.timeoutMs))
    : 1500;

  return new Promise((resolve) => {
    const client = net.createConnection(PIPE_PATH);
    let settled = false;
    let buffer = '';
    let timeout = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try { client.destroy(); } catch (_) {}
      resolve(result);
    }

    timeout = setTimeout(() => {
      finish({ ok: false, reason: 'daemon_snapshot_timeout', terminals: [] });
    }, timeoutMs);

    client.on('connect', () => {
      try {
        client.write(`${JSON.stringify({ action: 'list' })}\n`);
      } catch (_) {
        // The daemon also sends an initial connected snapshot on connect.
      }
    });

    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const msg = parseDaemonLine(line.trim());
        if (!msg) continue;
        if (msg.event === 'connected' || msg.event === 'list') {
          finish({
            ok: true,
            source: 'terminal-daemon',
            event: msg.event,
            terminals: Array.isArray(msg.terminals) ? msg.terminals : [],
          });
          return;
        }
      }
    });

    client.on('error', (err) => {
      finish({
        ok: false,
        reason: 'daemon_snapshot_connect_failed',
        error: err.message,
        terminals: [],
      });
    });

    client.on('close', () => {
      finish({ ok: false, reason: 'daemon_snapshot_closed', terminals: [] });
    });
  });
}

module.exports = {
  requestDaemonTerminalSnapshot,
};
