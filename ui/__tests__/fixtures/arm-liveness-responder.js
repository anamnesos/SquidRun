'use strict';

const { spawn } = require('child_process');

const PONG_MARKER = '[SQUIDRUN_ARM_LIVENESS_PONG]';
let buffer = '';
let replied = false;
let replyInFlight = false;

function toText(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function extractReceipt(text) {
  const markerIndex = text.indexOf(PONG_MARKER);
  if (markerIndex < 0) return null;
  const remainder = text.slice(markerIndex + PONG_MARKER.length).trimStart();
  const jsonLine = remainder.split(/[\r\n]/, 1)[0].trim();
  if (!jsonLine.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(jsonLine);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeReply(receipt) {
  if (replied || replyInFlight) return;
  if (receipt?.schema !== 'squidrun.arm_liveness_pong.v0') return;
  if (Object.prototype.hasOwnProperty.call(receipt, 'whoFailed')
    || Object.prototype.hasOwnProperty.call(receipt, 'who_failed')) return;
  const role = toText(process.env.SQUIDRUN_ROLE);
  const paneId = toText(process.env.SQUIDRUN_PANE_ID);
  const hmSendPath = toText(process.env.SQUIDRUN_BUILD1A_HM_SEND);
  const brokerPort = toText(process.env.HM_SEND_PORT);
  if (!role || !paneId || receipt.paneId !== paneId || !hmSendPath || !brokerPort) return;

  const body = `(${role.toUpperCase()} #1): ${PONG_MARKER} ${JSON.stringify(receipt)}`;
  replyInFlight = true;
  const child = spawn(process.execPath, [
    hmSendPath,
    'architect',
    body,
    '--role', role,
    '--no-fallback',
    '--retries', '0',
    '--timeout', '3000',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, HM_SEND_PORT: brokerPort },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  child.once('exit', (code) => {
    replyInFlight = false;
    if (code === 0) {
      replied = true;
      process.stdout.write('LIVENESS_REPLIED_VIA_HM_SEND\n');
      return;
    }
    process.stdout.write(`LIVENESS_REPLY_ROUTE_ERROR ${code} ${output.slice(-500)}\n`);
  });
}

process.stdin.setEncoding('utf8');
if (typeof process.stdin.setRawMode === 'function') {
  try { process.stdin.setRawMode(true); } catch {}
}
process.stdin.on('data', (chunk) => {
  buffer = `${buffer}${chunk}`.slice(-32_768);
  const receipt = extractReceipt(buffer);
  if (receipt) writeReply(receipt);
});
process.stdin.resume();
process.stdout.write('BUILD_1A_TEST_COPY_READY\n');

const keepAlive = setInterval(() => {}, 60_000);
function shutdown() {
  clearInterval(keepAlive);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
