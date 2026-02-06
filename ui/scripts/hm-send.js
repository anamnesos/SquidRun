#!/usr/bin/env node
/**
 * hm-send: CLI tool for instant WebSocket messaging between agents
 * Usage: node hm-send.js <target> <message> [--role <role>] [--priority urgent]
 */

const WebSocket = require('ws');

const PORT = 9900;
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('Usage: node hm-send.js <target> <message> [--role <role>] [--priority urgent]');
  console.log('  target: paneId (1,2,5) or role name (architect, devops, analyst)');
  console.log('  message: text to send');
  console.log('  --role: your role (for identification)');
  console.log('  --priority: normal or urgent');
  process.exit(1);
}

const target = args[0];
const message = args[1];
let role = 'cli';
let priority = 'normal';

for (let i = 2; i < args.length; i++) {
  if (args[i] === '--role' && args[i+1]) {
    role = args[i+1];
    i++;
  }
  if (args[i] === '--priority' && args[i+1]) {
    priority = args[i+1];
    i++;
  }
}

const ws = new WebSocket('ws://127.0.0.1:' + PORT);

ws.on('open', () => {
  // Register first
  ws.send(JSON.stringify({ type: 'register', role }));
  
  // Then send
  ws.send(JSON.stringify({
    type: 'send',
    target,
    content: message,
    priority
  }));
  
  // Close after brief delay
  setTimeout(() => {
    ws.close();
    console.log('Sent to ' + target + ': ' + message.substring(0, 50) + '...');
    process.exit(0);
  }, 100);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  console.error('Is Hivemind running?');
  process.exit(1);
});

// Timeout if server doesn't respond
setTimeout(() => {
  console.error('Connection timeout');
  process.exit(1);
}, 3000);
