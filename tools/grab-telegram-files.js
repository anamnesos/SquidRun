const https = require('https');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', 'ui', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', '.env') });
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = '8754356993';
const OUT_DIR = 'D:/projects/Korean Fraud/telegram-photos';

function apiGet(urlPath) {
  return new Promise((resolve) => {
    const r = https.request({ hostname: 'api.telegram.org', path: urlPath, method: 'GET' }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(JSON.parse(b)));
    });
    r.end();
  });
}

function downloadFile(fileId, savePath) {
  return apiGet('/bot' + TOKEN + '/getFile?file_id=' + fileId).then((fileInfo) => {
    if (fileInfo.ok === false) {
      console.log('getFile failed:', JSON.stringify(fileInfo));
      return false;
    }
    const filePath = fileInfo.result.file_path;
    return new Promise((resolve) => {
      const file = fs.createWriteStream(savePath);
      https.get('https://api.telegram.org/file/bot' + TOKEN + '/' + filePath, (res) => {
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('Downloaded:', savePath, '(' + fs.statSync(savePath).size + ' bytes)');
          resolve(true);
        });
      });
    });
  });
}

async function main() {
  const updates = await apiGet('/bot' + TOKEN + '/getUpdates?offset=-20&limit=20');
  if (updates.ok === false) {
    console.log('Failed:', JSON.stringify(updates));
    return;
  }
  let idx = 11;
  let found = 0;
  for (const u of updates.result) {
    const m = u.message || u.edited_message;
    if (m === undefined || m === null) continue;
    if (String(m.chat.id) !== CHAT_ID) continue;

    if (m.photo && m.photo.length > 0) {
      const best = m.photo[m.photo.length - 1];
      const savePath = path.join(OUT_DIR, 'photo-' + String(idx).padStart(2, '0') + '.jpg');
      await downloadFile(best.file_id, savePath);
      idx++;
      found++;
    } else if (m.document) {
      const ext = path.extname(m.document.file_name || '.bin') || '.bin';
      const savePath = path.join(OUT_DIR, 'doc-' + String(idx).padStart(2, '0') + ext);
      await downloadFile(m.document.file_id, savePath);
      idx++;
      found++;
    } else if (m.text) {
      console.log('Text message:', m.text.substring(0, 100));
    }
  }
  if (found === 0) console.log('No photos or documents from private-profile in recent updates');
  else console.log('Total downloaded:', found);
}

main();
