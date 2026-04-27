#!/usr/bin/env node
// DISABLED: races with supervisor-daemon getUpdates, causes 은별 messages to be lost.
// Do not re-enable unless supervisor Telegram polling is fully removed.
process.exit(0);
/**
 * Standalone Telegram inbound relay with FIXED UTF-8 chunk handling.
 * Runs separately from SquidRun to bypass the running poller's old code.
 * Writes full untruncated inbound text to a file for Architect to read.
 *
 * Usage: node ui/scripts/hm-telegram-longpoll-relay.js
 * Output: D:\projects\squidrun\.squidrun\runtime\telegram-relay-inbox.jsonl
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const JAMES_CHAT_ID = Number.parseInt(process.env.TELEGRAM_CHAT_ID || '0', 10);
const POLL_INTERVAL_MS = 2000;
const OUT_PATH = path.resolve(__dirname, '..', '..', '.squidrun', 'runtime', 'telegram-relay-inbox.jsonl');

if (!BOT_TOKEN || !Number.isFinite(JAMES_CHAT_ID) || JAMES_CHAT_ID === 0) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

let nextOffset = 0;

function requestTelegram(method, requestPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.telegram.org', port: 443, path: requestPath, method },
      (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function pollOnce() {
  try {
    const q = new URLSearchParams();
    q.append('offset', String(nextOffset));
    q.append('timeout', '0');
    q.append('limit', '20');
    const { body } = await requestTelegram('GET', `/bot${BOT_TOKEN}/getUpdates?${q.toString()}`);
    const payload = JSON.parse(body || '{}');
    const updates = Array.isArray(payload.result) ? payload.result : [];
    for (const update of updates) {
      const id = Number(update.update_id);
      if (!Number.isFinite(id)) continue;
      nextOffset = Math.max(nextOffset, id + 1);
      const msg = update.message || update.edited_message;
      if (!msg || !msg.chat || Number(msg.chat.id) !== JAMES_CHAT_ID) continue;
      const text = typeof msg.text === 'string' ? msg.text : (typeof msg.caption === 'string' ? msg.caption : '');
      if (!text) continue;
      const record = {
        ts: new Date().toISOString(),
        updateId: id,
        messageId: msg.message_id,
        text,
        textLen: text.length,
      };
      fs.appendFileSync(OUT_PATH, JSON.stringify(record) + '\n');
      console.log(`[relay] ${record.ts} len=${text.length} :: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
    }
  } catch (err) {
    console.error('[relay] poll error:', err.message);
  }
}

console.log(`[relay] Starting FIXED poller. Writing to ${OUT_PATH}`);
console.log(`[relay] Bot token: ${BOT_TOKEN.slice(0, 10)}... Chat ID: ${JAMES_CHAT_ID}`);
console.log(`[relay] Poll interval: ${POLL_INTERVAL_MS}ms`);

(async function loop() {
  while (true) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
})();
