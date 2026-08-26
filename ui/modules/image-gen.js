/**
 * Image Generation Module
 * Recraft V3 and OpenAI gpt-image-1 with explicit, fail-closed provider
 * selection. Provider failures never switch the requested craft path.
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
  const requested = String(preferred || '').trim().toLowerCase();
  if (requested === 'recraft') return resolveRecraftKey() ? 'recraft' : null;
  if (requested === 'openai') return resolveOpenAiKey() ? 'openai' : null;
  if (requested) return null;
  if (resolveRecraftKey()) return 'recraft';
  if (resolveOpenAiKey()) return 'openai';
  return null;
}

function validateImageRequest({ provider, style, size } = {}) {
  if (!['recraft', 'openai'].includes(provider)) {
    throw new Error(`Unsupported image provider '${provider || 'unknown'}'. Use recraft or openai.`);
  }
  if (provider === 'recraft') {
    if (style && !RECRAFT_STYLES.includes(style)) {
      throw new Error(`Unsupported Recraft style '${style}'. Allowed: ${RECRAFT_STYLES.join(', ')}.`);
    }
    if (size && !RECRAFT_SIZES.includes(size)) {
      throw new Error(`Unsupported Recraft size '${size}'. Allowed: ${RECRAFT_SIZES.join(', ')}.`);
    }
    return;
  }
  if (style) {
    throw new Error('The --style option is Recraft-only. Choose provider recraft or express the style in the OpenAI prompt.');
  }
  if (size && !OPENAI_SIZES.includes(size)) {
    throw new Error(`Unsupported OpenAI size '${size}'. Allowed: ${OPENAI_SIZES.join(', ')}.`);
  }
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

function removeHistoryEntryByPath(imagePath) {
  if (!imagePath) return;
  const resolved = path.resolve(String(imagePath));
  const history = safeReadJson(IMAGE_HISTORY_PATH, []);
  const filtered = history.filter((entry) => {
    if (!entry || !entry.imagePath) return false;
    return path.resolve(String(entry.imagePath)) !== resolved;
  });
  safeWriteJson(IMAGE_HISTORY_PATH, filtered);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function detectImageExt(buffer) {
  if (!buffer || buffer.length < 12) return '.png';
  // WEBP: starts with RIFF....WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return '.webp';
  }
  // JPEG: starts with FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return '.jpg';
  // GIF: starts with GIF8
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return '.gif';
  // PNG: starts with 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return '.png';
  return '.png';
}

function generateBasename() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const hash = Math.random().toString(36).slice(2, 8);
  return `${ts}-${hash}`;
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

  const effectiveStyle = style || 'realistic_image';
  const effectiveSize = size || '1024x1024';

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

  const effectiveSize = size || '1024x1024';

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
  const requestedProvider = String(preferredProvider || '').trim().toLowerCase();
  if (requestedProvider && !['recraft', 'openai'].includes(requestedProvider)) {
    throw new Error(`Unsupported image provider '${preferredProvider}'. Use recraft or openai.`);
  }
  const resolvedProvider = resolveProvider(requestedProvider);

  if (!resolvedProvider) {
    if (requestedProvider) {
      const keyName = requestedProvider === 'recraft' ? 'RECRAFT_API_KEY' : 'OPENAI_API_KEY';
      throw new Error(`${keyName} is not set; automatic provider fallback is disabled.`);
    }
    throw new Error('No image generation API key available. Set RECRAFT_API_KEY or OPENAI_API_KEY.');
  }
  validateImageRequest({ provider: resolvedProvider, style, size });

  ensureDir(GENERATED_IMAGES_DIR);
  const basename = generateBasename();
  let destPath = path.join(GENERATED_IMAGES_DIR, basename + '.png');

  let usedProvider;

  if (resolvedProvider === 'recraft') {
    try {
      const recraftResult = await callRecraftApi({ prompt: effectivePrompt, style, size });
      await downloadImage(recraftResult.imageUrl, destPath);
      usedProvider = 'recraft';
    } catch (err) {
      throw new Error(`Recraft failed: ${err.message}. Automatic provider fallback is disabled.`);
    }
  } else {
    const openaiResult = await callOpenAiImageApi({ prompt: effectivePrompt, size });
    const buffer = Buffer.from(openaiResult.b64, 'base64');
    fs.writeFileSync(destPath, buffer);
    usedProvider = 'openai';
  }

  // Detect actual image type and rename if extension is wrong
  try {
    const savedBuffer = fs.readFileSync(destPath);
    const correctExt = detectImageExt(savedBuffer);
    if (correctExt !== '.png') {
      const correctedPath = path.join(GENERATED_IMAGES_DIR, basename + correctExt);
      fs.renameSync(destPath, correctedPath);
      destPath = correctedPath;
    }
  } catch (renameErr) {
    log.warn('ImageGen', `MIME detection/rename failed: ${renameErr.message}`);
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
  removeHistoryEntryByPath,
  resolveProvider,
  validateImageRequest,
  detectImageExt,
  RECRAFT_STYLES,
  RECRAFT_SIZES,
  OPENAI_SIZES,
  GENERATED_IMAGES_DIR,
  IMAGE_HISTORY_PATH,
};
