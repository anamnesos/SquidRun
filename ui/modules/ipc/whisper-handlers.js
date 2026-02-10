/**
 * Whisper Voice Input IPC Handlers
 * Channels: voice:transcribe
 * Uses OpenAI Whisper API for speech-to-text transcription.
 */

const https = require('https');
const log = require('../logger');

function mapWhisperError(err) {
  const message = err && err.message ? err.message : 'Whisper transcription failed';
  const normalized = message.toLowerCase();

  if (normalized.includes('timeout')) {
    return { code: 'WHISPER_TIMEOUT', error: 'Whisper API request timed out.' };
  }
  if (normalized.includes('whisper api 401') || normalized.includes('whisper api 403')) {
    return { code: 'OPENAI_AUTH_ERROR', error: 'OpenAI API key was rejected by Whisper.' };
  }
  if (normalized.includes('failed to parse whisper response')) {
    return { code: 'WHISPER_RESPONSE_INVALID', error: 'Whisper API returned an invalid response.' };
  }

  return { code: 'WHISPER_TRANSCRIPTION_FAILED', error: message };
}

function registerWhisperHandlers(ctx, deps = {}) {
  const { ipcMain } = ctx;
  const transcribeFn = typeof deps.callWhisperApi === 'function' ? deps.callWhisperApi : callWhisperAPI;

  ipcMain.handle('voice:transcribe', async (_event, audioBuffer) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { success: false, code: 'MISSING_OPENAI_KEY', error: 'OPENAI_API_KEY is not configured.' };
    }

    if (!audioBuffer || !Buffer.isBuffer(audioBuffer) && !(audioBuffer instanceof Uint8Array)) {
      return { success: false, code: 'INVALID_AUDIO_DATA', error: 'Invalid audio data.' };
    }

    const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);

    try {
      const transcript = await transcribeFn(apiKey, buf);
      return { success: true, text: transcript };
    } catch (err) {
      log.error('Whisper', 'Transcription failed:', err.message);
      const mapped = mapWhisperError(err);
      return { success: false, code: mapped.code, error: mapped.error };
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
