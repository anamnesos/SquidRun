const https = require('https');
const fs = require('fs');
const path = require('path');
try { require('dotenv').config({path: path.join(__dirname, '..', 'ui', '.env')}); } catch (_) {
  // dotenv not available in tools/, load .env manually
  const envPath = path.join(__dirname, '..', 'ui', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
    });
  }
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.argv[2];
const filePath = process.argv[3];
const caption = process.argv[4] || '';

if (!token || !chatId || !filePath) {
  console.error('Usage: node send-telegram-document.js <chatId> <filePath> [caption]');
  process.exit(1);
}

const fileData = fs.readFileSync(filePath);
const fileName = path.basename(filePath);
const boundary = '----FormBoundary' + Date.now();

let body = '';
body += `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
if (caption) body += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
body += `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: text/markdown\r\n\r\n`;
const ending = `\r\n--${boundary}--\r\n`;

const bodyBuffer = Buffer.concat([
  Buffer.from(body, 'utf-8'),
  fileData,
  Buffer.from(ending, 'utf-8')
]);

const options = {
  hostname: 'api.telegram.org',
  path: `/bot${token}/sendDocument`,
  method: 'POST',
  headers: {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': bodyBuffer.length,
  },
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    const result = JSON.parse(data);
    if (result.ok) {
      console.log(`Document sent to ${chatId}, message_id: ${result.result.message_id}`);
    } else {
      console.error('Failed:', result.description);
    }
  });
});

req.write(bodyBuffer);
req.end();
