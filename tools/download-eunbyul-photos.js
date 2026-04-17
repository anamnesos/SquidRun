require(require('path').join(__dirname, '..', 'ui', 'node_modules', 'dotenv')).config({ path: require('path').join(__dirname, '..', 'ui', '.env') });
const token = process.env.TELEGRAM_BOT_TOKEN;
const fs = require('fs');
const path = require('path');

async function checkAndDownload() {
  const res = await fetch('https://api.telegram.org/bot'+token+'/getUpdates?offset=-20&limit=20');
  const d = await res.json();
  if (d.ok === false) { console.log('API error', d); return; }
  console.log('Updates:', d.result.length);
  const downloaded = [];
  for (const u of d.result) {
    const m = u.message;
    if (!m || String(m.chat.id) !== '8754356993') continue;
    const date = new Date(m.date*1000).toLocaleString();
    const text = m.text || '';
    const hasPhoto = m.photo && m.photo.length > 0;
    console.log('update:'+u.update_id, date, text, hasPhoto ? '[PHOTO]' : '');

    if (hasPhoto) {
      const biggest = m.photo[m.photo.length-1];
      const fileRes = await fetch('https://api.telegram.org/bot'+token+'/getFile?file_id='+biggest.file_id);
      const fileData = await fileRes.json();
      if (fileData.ok) {
        const dlUrl = 'https://api.telegram.org/file/bot'+token+'/'+fileData.result.file_path;
        const imgRes = await fetch(dlUrl);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const outPath = path.join('D:', 'projects', 'Korean Fraud', 'dalser-police-text-'+u.update_id+'.jpg');
        fs.writeFileSync(outPath, buf);
        console.log('Downloaded to', outPath);
        downloaded.push(outPath);
      }
    }
  }
  console.log('Total photos downloaded:', downloaded.length);
  return downloaded;
}
checkAndDownload();
