#!/usr/bin/env node

const { DEFAULT_OLLAMA_BASE_URL, DEFAULT_EXTRACTION_TIMEOUT_MS, fetchJson } = require('../modules/local-model-capabilities');

const DEFAULT_MODEL = String(process.env.SQUIDRUN_OLLAMA_MODEL || 'llama3:8b').trim();
const VALID_CATEGORIES = new Set(['fact', 'preference', 'workflow', 'system_state', 'observation']);

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
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(1, numeric));
}

function buildTranscriptFromPayload(payload = {}) {
  if (Array.isArray(payload.episodes) && payload.episodes.length > 0) {
    return payload.episodes
      .map((episode, index) => {
        const sender = normalizeText(episode?.senderRole || episode?.sender || 'unknown');
        const target = normalizeText(episode?.targetRole || episode?.target || 'unknown');
        const body = normalizeText(episode?.rawBody || episode?.message || '');
        if (!body) return null;
        return `${index + 1}. ${sender} -> ${target}: ${body}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  if (Array.isArray(payload.transcript)) {
    return payload.transcript.map((entry) => normalizeText(entry)).filter(Boolean).join('\n');
  }

  return normalizeText(payload.transcript || payload.summary || payload.text || '');
}

function buildExtractionPrompt(payload = {}) {
  const transcript = buildTranscriptFromPayload(payload);
  return [
    'You extract durable, structured facts from SquidRun transcripts.',
    'Return JSON only.',
    'Return an array of objects with exactly these keys: fact, category, confidence.',
    'Use category values from: fact, preference, workflow, system_state, observation.',
    'Confidence must be a number between 0 and 1.',
    'Keep only durable facts, stable preferences, established workflow rules, or concrete system state.',
    'Do not invent facts.',
    'Transcript:',
    transcript || '[empty transcript]',
  ].join('\n');
}

function parseOllamaResponse(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.candidates)) return response.candidates;
  const raw = typeof response?.response === 'string'
    ? response.response
    : (typeof response === 'string' ? response : '');
  if (!raw) {
    throw new Error('ollama_response_missing_payload');
  }
  return JSON.parse(raw);
}

function validateExtractionArray(items) {
  if (!Array.isArray(items)) {
    throw new Error('extraction_output_not_array');
  }
  return items.map((item) => {
    const fact = normalizeText(item?.fact);
    const category = normalizeText(item?.category);
    const confidence = clampConfidence(item?.confidence);
    if (!fact) {
      throw new Error('extraction_item_missing_fact');
    }
    if (!category || !VALID_CATEGORIES.has(category)) {
      throw new Error(`extraction_item_invalid_category:${category || 'missing'}`);
    }
    if (confidence === null) {
      throw new Error('extraction_item_invalid_confidence');
    }
    return {
      fact,
      category,
      confidence,
    };
  });
}

function dedupeFacts(items) {
  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const key = `${item.category}:${item.fact.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(item);
  }
  return normalized.slice(0, 32);
}

async function runOllamaExtraction(payload = {}, options = {}) {
  const model = normalizeText(options.model) || DEFAULT_MODEL;
  const baseUrl = normalizeText(options.baseUrl) || DEFAULT_OLLAMA_BASE_URL;
  const timeoutMs = Math.max(1000, Number.parseInt(String(options.timeoutMs || DEFAULT_EXTRACTION_TIMEOUT_MS), 10) || DEFAULT_EXTRACTION_TIMEOUT_MS);
  const result = await fetchJson(`${baseUrl}/api/generate`, {
    fetchImpl: options.fetchImpl,
    timeoutMs,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      prompt: buildExtractionPrompt(payload),
    }),
  });
  return dedupeFacts(validateExtractionArray(parseOllamaResponse(result)));
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
  const extracted = await runOllamaExtraction(payload, {
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
  VALID_CATEGORIES,
  buildExtractionPrompt,
  buildTranscriptFromPayload,
  dedupeFacts,
  parseOllamaResponse,
  runOllamaExtraction,
  validateExtractionArray,
};
