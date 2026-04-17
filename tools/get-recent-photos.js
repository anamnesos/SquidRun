const https = require('https');
require('dotenv').config({path: 'D:/projects/squidrun/ui/.env'});
const token = process.env.TELEGRAM_BOT_TOKEN;

function apiCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const url = `https://api.telegram.org/bot${token}/${method}?${qs}`;
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function main() {
  // Try getting updates
  const r = await apiCall('getUpdates', { limit: 100, timeout: 1 });
  console.log('ok:', r.ok, 'count:', r.result?.length);
  if (r.result) {
    for (const u of r.result) {
      const m = u.message;
      if (!m) continue;
      console.log(`update_id=${u.update_id} from=${m.from?.username} chat=${m.chat?.id} date=${new Date(m.date*1000).toISOString()}`);
      if (m.photo) {
        const largest = m.photo[m.photo.length - 1];
        console.log(`  PHOTO file_id=${largest.file_id}`);
      }
      if (m.document) {
        console.log(`  DOC file_name=${m.document.file_name} file_id=${m.document.file_id}`);
      }
      if (m.text) {
        console.log(`  text: ${m.text.substring(0, 100)}`);
      }
    }
  }
}

main().catch(console.error);
