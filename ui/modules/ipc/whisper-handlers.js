/**
 * Whisper Voice Input IPC Handlers
 * Channels: voice:transcribe
 * Uses OpenAI Whisper API for speech-to-text transcription.
 */

const https = require('https');
const log = require('../logger');

function registerWhisperHandlers(ctx) {
  const { ipcMain } = ctx;

  ipcMain.handle('voice:transcribe', async (_event, audioBuffer) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { success: false, error: 'OPENAI_API_KEY not set in .env' };
    }

    if (!audioBuffer || !Buffer.isBuffer(audioBuffer) && !(audioBuffer instanceof Uint8Array)) {
      return { success: false, error: 'Invalid audio data' };
    }

    const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);

    try {
      const transcript = await callWhisperAPI(apiKey, buf);
      return { success: true, text: transcript };
    } catch (err) {
      log.error('Whisper', 'Transcription failed:', err.message);
      return { success: false, error: err.message };
    }
  });
}

function callWhisperAPI(apiKey, audioBuffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----WhisperBoundary' + Date.now();
    const parts = [];

    // model field
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`);

    // audio file field
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`);
    const fileEnd = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(parts.join(''), 'utf-8');
    const endBuf = Buffer.from(fileEnd, 'utf-8');
    const body = Buffer.concat([headerBuf, audioBuffer, endBuf]);

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Whisper API ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(json.text || '');
        } catch (e) {
          reject(new Error('Failed to parse Whisper response'));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Whisper API timeout (30s)'));
    });

    req.write(body);
    req.end();
  });
}

module.exports = { registerWhisperHandlers };
