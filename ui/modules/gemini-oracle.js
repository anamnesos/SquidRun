/**
 * Gemini Oracle - Visual QA helper for screenshots.
 * Uses Gemini API (HTTP) with inline base64 image input.
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE_PATH } = require('../config');
const log = require('./logger');

const DEFAULT_MODEL = process.env.GEMINI_ORACLE_MODEL || 'gemini-2.5-pro';
const DEFAULT_PROMPT = 'Analyze this UI screenshot for visual or layout issues.';
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_ORACLE_TIMEOUT_MS || 60000);
const RATE_LIMIT_RETRY_DELAYS_MS = [1000, 2000, 4000];

const ORACLE_HISTORY_PATH = path.join(WORKSPACE_PATH, 'oracle-history.json');

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function resolveApiKey() {
  return process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY
    || process.env.GOOGLE_AI_API_KEY
    || '';
}

function detectMimeType(imagePath) {
  const ext = path.extname(imagePath || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'image/png';
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    log.warn('Oracle', 'Failed to read history file', err.message);
    return fallback;
  }
}

function safeWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function appendHistory(entry) {
  const history = safeReadJson(ORACLE_HISTORY_PATH, []);
  history.unshift(entry);
  safeWriteJson(ORACLE_HISTORY_PATH, history);
}

function buildRequestBody(prompt, base64Image, mimeType) {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64Image } },
        ],
      },
    ],
  };
}

function extractAnalysis(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(part => part.text || '').join('').trim();
  return text || '';
}

function extractUsage(payload) {
  const usage = payload?.usageMetadata || payload?.usage || {};
  const total = usage.totalTokenCount ?? usage.totalTokens ?? null;
  const prompt = usage.promptTokenCount ?? usage.promptTokens ?? null;
  const output = usage.candidatesTokenCount ?? usage.outputTokens ?? null;
  return {
    tokens: total,
    promptTokens: prompt,
    outputTokens: output,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callGeminiApi({ model, prompt, base64Image, mimeType }) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
  if (!fetchFn) {
    throw new Error('global fetch is unavailable in this runtime');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = buildRequestBody(prompt, base64Image, mimeType);

  let lastError;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Gemini API timeout after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json().catch(() => ({}));
    if (response.status === 429) {
      const message = payload?.error?.message || 'Gemini API rate limited (429)';
      const err = new Error(message);
      err.status = response.status;
      lastError = err;
      if (attempt < RATE_LIMIT_RETRY_DELAYS_MS.length) {
        const delay = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
        log.warn('Oracle', `Rate limited (429). Retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw err;
    }

    if (!response.ok || payload?.error) {
      const message = payload?.error?.message || `Gemini API error (${response.status})`;
      const err = new Error(message);
      err.status = response.status;
      throw err;
    }

    return payload;
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Gemini API request failed after retries');
}

async function analyzeScreenshot({ imagePath, prompt, model } = {}) {
  if (!imagePath) {
    throw new Error('imagePath required');
  }
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }

  const buffer = fs.readFileSync(imagePath);
  const mimeType = detectMimeType(imagePath);
  const base64Image = buffer.toString('base64');

  const effectivePrompt = (prompt && String(prompt).trim()) || DEFAULT_PROMPT;
  const effectiveModel = (model && String(model).trim()) || DEFAULT_MODEL;

  const payload = await callGeminiApi({
    model: effectiveModel,
    prompt: effectivePrompt,
    base64Image,
    mimeType,
  });

  const analysis = extractAnalysis(payload);
  if (!analysis) {
    throw new Error('Gemini returned no analysis text');
  }

  const usage = extractUsage(payload);
  const entry = {
    id: `oracle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    model: effectiveModel,
    imagePath,
    prompt: effectivePrompt,
    analysis,
    usage,
  };

  try {
    appendHistory(entry);
  } catch (err) {
    log.warn('Oracle', 'Failed to write history', err.message);
  }

  return { analysis, usage, model: effectiveModel };
}

module.exports = {
  analyzeScreenshot,
  DEFAULT_MODEL,
};
