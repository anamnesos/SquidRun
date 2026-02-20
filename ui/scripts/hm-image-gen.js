#!/usr/bin/env node
/**
 * hm-image-gen: CLI tool for agents to trigger image generation via the SquidRun app.
 * Usage: node ui/scripts/hm-image-gen.js "a flaming gear icon" [--style realistic_image] [--size 1024x1024]
 *
 * Sends a WebSocket message to the main process, which generates the image
 * using the configured API keys and pushes the result to the Image tab UI.
 */

const WebSocket = require('ws');

const PORT = 9900;
const TIMEOUT_MS = 90000; // 90s — image gen can be slow
const args = process.argv.slice(2);

if (args.length < 1 || args[0] === '--help') {
  console.log('Usage: node hm-image-gen.js <prompt> [--style <style>] [--size <size>]');
  console.log('  prompt: Text description of the image to generate');
  console.log('  --style: Image style (realistic_image, digital_illustration, vector_illustration)');
  console.log('  --size: Image size (1024x1024, 1365x1024, 1024x1365, 1536x1024, 1024x1536)');
  console.log('\nExamples:');
  console.log('  node hm-image-gen.js "a red fox in a forest"');
  console.log('  node hm-image-gen.js "logo design" --style vector_illustration --size 1024x1024');
  process.exit(1);
}

// Collect prompt from args before first --flag
const promptParts = [];
let i = 0;
for (; i < args.length; i++) {
  if (args[i].startsWith('--')) break;
  promptParts.push(args[i]);
}
const prompt = promptParts.join(' ');

// Parse --flags
let style = null;
let size = null;
for (; i < args.length; i++) {
  if (args[i] === '--style' && args[i + 1]) {
    style = args[++i];
  } else if (args[i] === '--size' && args[i + 1]) {
    size = args[++i];
  }
}

if (!prompt.trim()) {
  console.error('[ERROR] Prompt is required');
  process.exit(1);
}

const ws = new WebSocket('ws://127.0.0.1:' + PORT);
let done = false;

ws.on('open', () => {
  // Register as image-gen client
  ws.send(JSON.stringify({ type: 'register', role: 'image-gen-cli' }));

  // Send image generation request
  const payload = { type: 'image-gen', prompt: prompt.trim() };
  if (style) payload.style = style;
  if (size) payload.size = size;

  ws.send(JSON.stringify(payload));
  console.log('[hm-image-gen] Request sent: "%s"', prompt.trim());
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    // sendToTarget wraps content in { type: 'message', content: '...' }
    let result = msg;
    if (msg.type === 'message' && typeof msg.content === 'string') {
      try { result = JSON.parse(msg.content); } catch { return; }
    }
    if (result.type === 'image-gen-result') {
      done = true;
      if (result.success) {
        console.log('[hm-image-gen] Image generated successfully');
        console.log('  Provider: %s', result.provider);
        console.log('  Path: %s', result.imagePath);
      } else {
        console.error('[hm-image-gen] Generation failed: %s', result.error);
      }
      ws.close();
      process.exit(result.success ? 0 : 1);
    }
  } catch {
    // Ignore non-JSON messages (welcome, etc.)
  }
});

ws.on('error', (err) => {
  console.error('[hm-image-gen] WebSocket error:', err.message);
  console.error('Is SquidRun running?');
  process.exit(1);
});

ws.on('close', () => {
  if (!done) {
    console.error('[hm-image-gen] Connection closed before result received');
    process.exit(1);
  }
});

// Timeout
setTimeout(() => {
  if (!done) {
    console.error('[hm-image-gen] Timeout after %ds', TIMEOUT_MS / 1000);
    ws.close();
    process.exit(1);
  }
}, TIMEOUT_MS);
