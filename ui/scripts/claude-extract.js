#!/usr/bin/env node

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const { DEFAULT_EXTRACTION_TIMEOUT_MS } = require('../modules/local-model-capabilities');
const {
  VALID_CATEGORIES,
  buildExtractionPrompt,
  dedupeFacts,
  validateExtractionArray,
} = require('./ollama-extract');

const DEFAULT_MODEL = String(process.env.SQUIDRUN_SLEEP_EXTRACTION_MODEL || 'claude-opus-4-6').trim();
const DEFAULT_BASE_URL = String(process.env.SQUIDRUN_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').trim();

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !String(next).startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function extractTextFromAnthropicResponse(payload = {}) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const text = blocks
    .filter((block) => String(block?.type || '') === 'text')
    .map((block) => String(block?.text || ''))
    .join('\n')
    .trim();
  if (!text) {
    throw new Error('anthropic_response_missing_text');
  }
  return text;
}

function extractJsonPayload(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) {
    throw new Error('anthropic_response_missing_payload');
  }
  const unfenced = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (unfenced.startsWith('[') || unfenced.startsWith('{')) {
    return JSON.parse(unfenced);
  }

  const firstArray = unfenced.indexOf('[');
  const lastArray = unfenced.lastIndexOf(']');
  if (firstArray >= 0 && lastArray > firstArray) {
    return JSON.parse(unfenced.slice(firstArray, lastArray + 1));
  }

  const firstObject = unfenced.indexOf('{');
  const lastObject = unfenced.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    return JSON.parse(unfenced.slice(firstObject, lastObject + 1));
  }

  throw new Error('anthropic_response_invalid_json');
}

async function runClaudeExtraction(payload = {}, options = {}) {
  const apiKey = normalizeText(options.apiKey || process.env.ANTHROPIC_API_KEY);
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch_unavailable');
  }

  const model = normalizeText(options.model) || DEFAULT_MODEL;
  const baseUrl = normalizeText(options.baseUrl) || DEFAULT_BASE_URL;
  const timeoutMs = Math.max(
    1000,
    Number.parseInt(String(options.timeoutMs || DEFAULT_EXTRACTION_TIMEOUT_MS), 10) || DEFAULT_EXTRACTION_TIMEOUT_MS
  );
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutHandle = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        temperature: 0,
        system: [
          'You extract durable, structured facts from SquidRun transcripts.',
          'Return JSON only.',
          `Return an array of objects with exactly these keys: fact, category, confidence.`,
          `Use category values from: ${Array.from(VALID_CATEGORIES).join(', ')}.`,
          'Confidence must be a number between 0 and 1.',
          'Keep only durable facts, stable preferences, established workflow rules, or concrete system state.',
          'Do not invent facts.',
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: buildExtractionPrompt(payload),
          },
        ],
      }),
      signal: controller ? controller.signal : undefined,
    });

    if (!response || response.ok !== true) {
      const errorText = typeof response?.text === 'function' ? await response.text() : '';
      throw new Error(`http_${response?.status || 'unknown'}${errorText ? `:${errorText}` : ''}`);
    }

    const raw = await response.json();
    const parsed = extractJsonPayload(extractTextFromAnthropicResponse(raw));
    const candidates = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.candidates) ? parsed.candidates : Object.values(parsed).find((value) => Array.isArray(value)));
    return dedupeFacts(validateExtractionArray(candidates));
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function readStdinJson() {
  const buffer = await new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.resume();
  });
  return buffer.trim() ? JSON.parse(buffer) : {};
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const payload = await readStdinJson();
  const extracted = await runClaudeExtraction(payload, {
    apiKey: flags['api-key'],
    model: flags.model,
    baseUrl: flags['base-url'],
    timeoutMs: flags.timeout,
  });
  process.stdout.write(`${JSON.stringify(extracted, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  extractJsonPayload,
  extractTextFromAnthropicResponse,
  runClaudeExtraction,
};
