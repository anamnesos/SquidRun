#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_REVIEW_PATH = path.join('mira', 'voice', 'review', 'candidates.jsonl');

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    path: DEFAULT_REVIEW_PATH,
    pendingOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--path' && next) {
      parsed.path = next;
      index += 1;
      continue;
    }
    if (token === '--pending-only') {
      parsed.pendingOnly = true;
      continue;
    }
    throw Object.assign(new Error(`Unknown or incomplete argument: ${token}`), { code: 'invalid_argument' });
  }

  return parsed;
}

function readRecords(reviewPath = DEFAULT_REVIEW_PATH) {
  const resolvedPath = path.resolve(reviewPath);
  if (!fs.existsSync(resolvedPath)) return { resolvedPath, records: [] };
  const records = fs.readFileSync(resolvedPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { resolvedPath, records };
}

function listVoiceCorrections(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { resolvedPath, records } = readRecords(args.path);
  const visibleRecords = args.pendingOnly
    ? records.filter((record) => record.review_status === 'pending_review')
    : records;

  return {
    ok: true,
    protocol: 'mira.voice_review_list.v0',
    path: resolvedPath,
    count: visibleRecords.length,
    pending_count: visibleRecords.filter((record) => record.review_status === 'pending_review').length,
    live_voice_mutated: false,
    records: visibleRecords,
  };
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(listVoiceCorrections(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_REVIEW_PATH,
  listVoiceCorrections,
  parseArgs,
  readRecords,
};
