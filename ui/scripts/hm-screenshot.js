#!/usr/bin/env node
/**
 * hm-screenshot: CLI tool for agents to capture screenshots
 * Usage: node hm-screenshot.js
 *
 * Captures the Hivemind window and saves to workspace/screenshots/latest.png
 * Agents can then read this file to see the UI state.
 */

const WebSocket = require('ws');

const PORT = 9900;

const ws = new WebSocket('ws://127.0.0.1:' + PORT);

ws.on('open', () => {
  // Register as screenshot tool
  ws.send(JSON.stringify({ type: 'register', role: 'screenshot-tool' }));

  // Request screenshot capture
  ws.send(JSON.stringify({
    type: 'screenshot',
    action: 'capture'
  }));
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'screenshot-result') {
      if (msg.success) {
        console.log('Screenshot saved to: ' + msg.path);
        console.log('View with: Read workspace/screenshots/latest.png');
      } else {
        console.error('Screenshot failed: ' + msg.error);
      }
      ws.close();
      process.exit(msg.success ? 0 : 1);
    }
  } catch (e) {
    // Ignore non-JSON messages
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  console.error('Is Hivemind running?');
  process.exit(1);
});

// Timeout if no response
setTimeout(() => {
  console.error('Screenshot timeout - no response from Hivemind');
  process.exit(1);
}, 5000);
