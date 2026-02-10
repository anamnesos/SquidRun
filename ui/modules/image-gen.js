/**
 * Image Generation Module
 * Primary: Recraft V3, Fallback: OpenAI gpt-image-1
 * Auto-fallback logic, image download+save, history.
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE_PATH } = require('../config');
const log = require('./logger');

const REQUEST_TIMEOUT_MS = Number(process.env.IMAGE_GEN_TIMEOUT_MS || 60000);
const RATE_LIMIT_RETRY_DELAYS_MS = [1000, 2000, 4000];

const GENERATED_IMAGES_DIR = path.join(WORKSPACE_PATH, 'generated-images');
const IMAGE_HISTORY_PATH = path.join(WORKSPACE_PATH, 'image-gen-history.json');

const RECRAFT_STYLES = ['realistic_image', 'digital_illustration', 'vector_illustration'];
const RECRAFT_SIZES = ['1024x1024', '1365x1024', '1024x1365', '1536x1024', '1024x1536'];
const OPENAI_SIZES = ['1024x1024', '1536x1024', '1024x1536'];

function resolveRecraftKey() {
  return process.env.RECRAFT_API_KEY || '';
}

function resolveOpenAiKey() {
  return process.env.OPENAI_API_KEY || '';
}

function resolveProvider(preferred) {
  if (preferred === 'recraft' && resolveRecraftKey()) return 'recraft';
  if (preferred === 'openai' && resolveOpenAiKey()) return 'openai';
  if (resolveRecraftKey()) return 'recraft';
  if (resolveOpenAiKey()) return 'openai';
  return null;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    log.warn('ImageGen', 'Failed to read history file', err.message);
    return fallback;
  }
}

function safeWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function appendHistory(entry) {
  const history = safeReadJson(IMAGE_HISTORY_PATH, []);
  history.unshift(entry);
  safeWriteJson(IMAGE_HISTORY_PATH, history);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateFilename() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const hash = Math.random().toString(36).slice(2, 8);
  return `${ts}-${hash}.png`;
}

async function fetchWithRetry(url, options) {
  const fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
  if (!fetchFn) {
    throw new Error('global fetch is unavailable in this runtime');
  }

  let lastError;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetchFn(url, { ...options, signal: controller.signal });
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new Error(`API timeout after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json().catch(() => ({}));
    if (response.status === 429) {
      const message = payload?.error?.message || 'API rate limited (429)';
      const err = new Error(message);
      err.status = response.status;
      lastError = err;
      if (attempt < RATE_LIMIT_RETRY_DELAYS_MS.length) {
        const delay = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
        log.warn('ImageGen', `Rate limited (429). Retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw err;
    }

    if (!response.ok || payload?.error) {
      const message = payload?.error?.message || `API error (${response.status})`;
      const err = new Error(message);
      err.status = response.status;
      throw err;
    }

    return payload;
  }

  if (lastError) throw lastError;
  throw new Error('API request failed after retries');
}

async function callRecraftApi({ prompt, style, size }) {
  const apiKey = resolveRecraftKey();
  if (!apiKey) throw new Error('RECRAFT_API_KEY is not set');

  const effectiveStyle = RECRAFT_STYLES.includes(style) ? style : 'realistic_image';
  const effectiveSize = RECRAFT_SIZES.includes(size) ? size : '1024x1024';

  const payload = await fetchWithRetry('https://external.api.recraft.ai/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'recraftv3',
      prompt,
      style: effectiveStyle,
      size: effectiveSize,
    }),
  });

  const imageUrl = payload?.data?.[0]?.url;
  if (!imageUrl) throw new Error('Recraft returned no image URL');
  return { imageUrl, provider: 'recraft' };
}

async function callOpenAiImageApi({ prompt, size }) {
  const apiKey = resolveOpenAiKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const effectiveSize = OPENAI_SIZES.includes(size) ? size : '1024x1024';

  const payload = await fetchWithRetry('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      n: 1,
      size: effectiveSize,
      quality: 'auto',
    }),
  });

  const b64 = payload?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image data');
  return { b64, provider: 'openai' };
}

async function downloadImage(url, destPath) {
  const fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
  if (!fetchFn) throw new Error('global fetch is unavailable in this runtime');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetchFn(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`Image download timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Image download failed (${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

async function generateImage({ prompt, provider: preferredProvider, style, size } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('prompt is required');
  }

  const effectivePrompt = String(prompt).trim();
  const resolvedProvider = resolveProvider(preferredProvider);

  if (!resolvedProvider) {
    throw new Error('No image generation API key available. Set RECRAFT_API_KEY or OPENAI_API_KEY.');
  }

  ensureDir(GENERATED_IMAGES_DIR);
  const filename = generateFilename();
  const destPath = path.join(GENERATED_IMAGES_DIR, filename);

  let result;
  let usedProvider;

  if (resolvedProvider === 'recraft') {
    try {
      const recraftResult = await callRecraftApi({ prompt: effectivePrompt, style, size });
      await downloadImage(recraftResult.imageUrl, destPath);
      usedProvider = 'recraft';
    } catch (err) {
      log.warn('ImageGen', `Recraft failed: ${err.message}. Trying OpenAI fallback...`);
      if (!resolveOpenAiKey()) {
        throw new Error(`Recraft failed: ${err.message}. No OpenAI fallback key available.`);
      }
      const openaiResult = await callOpenAiImageApi({ prompt: effectivePrompt, size });
      const buffer = Buffer.from(openaiResult.b64, 'base64');
      fs.writeFileSync(destPath, buffer);
      usedProvider = 'openai';
    }
  } else {
    const openaiResult = await callOpenAiImageApi({ prompt: effectivePrompt, size });
    const buffer = Buffer.from(openaiResult.b64, 'base64');
    fs.writeFileSync(destPath, buffer);
    usedProvider = 'openai';
  }

  const entry = {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    provider: usedProvider,
    prompt: effectivePrompt,
    style: style || null,
    size: size || '1024x1024',
    imagePath: destPath,
  };

  try {
    appendHistory(entry);
  } catch (err) {
    log.warn('ImageGen', 'Failed to write history', err.message);
  }

  return { imagePath: destPath, provider: usedProvider };
}

module.exports = {
  generateImage,
  resolveProvider,
  RECRAFT_STYLES,
  RECRAFT_SIZES,
  OPENAI_SIZES,
  GENERATED_IMAGES_DIR,
  IMAGE_HISTORY_PATH,
};
