#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_OUT_PATH = path.join('mira', 'voice', 'review', 'candidates.jsonl');

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    prompt: '',
    soundedFake: '',
    better: '',
    caseId: null,
    source: 'cli',
    outPath: DEFAULT_OUT_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--prompt' && next) {
      parsed.prompt = next;
      index += 1;
      continue;
    }
    if (token === '--sounded-fake' && next) {
      parsed.soundedFake = next;
      index += 1;
      continue;
    }
    if (token === '--better' && next) {
      parsed.better = next;
      index += 1;
      continue;
    }
    if (token === '--case' && next) {
      parsed.caseId = next;
      index += 1;
      continue;
    }
    if (token === '--source' && next) {
      parsed.source = next;
      index += 1;
      continue;
    }
    if (token === '--out' && next) {
      parsed.outPath = next;
      index += 1;
      continue;
    }
    throw Object.assign(new Error(`Unknown or incomplete argument: ${token}`), { code: 'invalid_argument' });
  }

  return parsed;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function requireText(value, fieldName) {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw Object.assign(new Error(`${fieldName} is required.`), { code: `missing_${fieldName}` });
  }
  return normalized;
}

function buildRecord(args, now = new Date()) {
  const prompt = requireText(args.prompt, 'prompt');
  const soundedFake = requireText(args.soundedFake, 'sounded_fake');
  const better = requireText(args.better, 'better');

  return {
    schema: 'mira.voice_review_candidate.v0',
    id: `voice-review-${crypto.randomUUID()}`,
    created_at: now.toISOString(),
    source: normalizeText(args.source) || 'cli',
    prompt,
    sounded_fake: soundedFake,
    better_phrasing: better,
    suggested_case_id: args.caseId ? normalizeText(args.caseId) : null,
    review_status: 'pending_review',
    live_voice_mutated: false,
  };
}

function appendRecord(record, outPath = DEFAULT_OUT_PATH) {
  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.appendFileSync(resolved, `${JSON.stringify(record)}\n`, 'utf8');
  return resolved;
}

function captureVoiceCorrection(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const record = buildRecord(args, options.now || new Date());
  const resolvedOutPath = appendRecord(record, args.outPath);
  return {
    ok: true,
    protocol: 'mira.voice_review_capture.v0',
    out_path: resolvedOutPath,
    record,
    live_voice_mutated: false,
  };
}

function main() {
  try {
    const result = captureVoiceCorrection();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_OUT_PATH,
  buildRecord,
  captureVoiceCorrection,
  parseArgs,
};
