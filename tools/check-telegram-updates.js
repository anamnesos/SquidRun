const https = require('https');
const path = require('path');
require(path.join(__dirname, '..', 'ui', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', '.env') });
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

https.get('https://api.telegram.org/bot' + TOKEN + '/getUpdates?offset=-20&limit=20', (res) => {
  let b = '';
  res.on('data', c => b += c);
  res.on('end', () => {
    const data = JSON.parse(b);
    if (!data.ok) { console.log('FAIL:', JSON.stringify(data)); return; }
    console.log('Total updates:', data.result.length);
    for (const u of data.result) {
      const m = u.message || u.edited_message;
      if (!m) continue;
      const hasPhoto = m.photo ? 'PHOTO(' + m.photo.length + ' sizes)' : '';
      const hasDoc = m.document ? 'DOC(' + m.document.file_name + ')' : '';
      const hasText = m.text ? 'TEXT:' + m.text.substring(0, 50) : '';
      console.log('update_id=' + u.update_id, 'chat=' + m.chat.id, hasPhoto || hasDoc || hasText);
    }
  });
});
