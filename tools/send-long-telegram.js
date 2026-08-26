require(require('path').join(__dirname, '..', 'ui', 'node_modules', 'dotenv')).config({ path: require('path').join(__dirname, '..', 'ui', '.env') });
const https = require('https');
const fs = require('fs');

const chatId = process.argv[2];
const filePath = process.argv[3];

if (!chatId || !filePath) {
  console.error('Usage: node send-long-telegram.js <chatId> <filePath>');
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const text = fs.readFileSync(filePath, 'utf8');

// Telegram max is 4096 chars. Split on double newlines near limit.
function splitMessage(msg, maxLen = 4000) {
  const chunks = [];
  let remaining = msg;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function send(chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const chunks = splitMessage(text);
  console.log(`Sending ${chunks.length} message(s) to ${chatId}`);
  for (let i = 0; i < chunks.length; i++) {
    const result = await send(chatId, chunks[i]);
    console.log(`Chunk ${i+1}/${chunks.length}: ${result.ok ? 'sent' : 'FAILED'} (msg_id: ${result.result?.message_id || 'n/a'})`);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}
main();
