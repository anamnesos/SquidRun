#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LAB_PATH = path.join('mira', 'voice', 'voice-lab-v0.jsonl');

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    labPath: DEFAULT_LAB_PATH,
    candidate: '',
    caseId: '',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--lab' && next) {
      parsed.labPath = next;
      index += 1;
      continue;
    }
    if (token === '--case' && next) {
      parsed.caseId = next;
      index += 1;
      continue;
    }
    if (token === '--candidate' && next) {
      parsed.candidate = next;
      index += 1;
      continue;
    }
    if (token === '--stdin') {
      parsed.candidate = fs.readFileSync(0, 'utf8');
      continue;
    }
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${token}`);
  }

  return parsed;
}

function readVoiceLab(labPath = DEFAULT_LAB_PATH) {
  const resolved = path.resolve(labPath);
  const lines = fs.readFileSync(resolved, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${resolved}:${index + 1}: invalid JSON: ${error.message}`);
    }
  });
}

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function wordCount(value = '') {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(/\s+/).length : 0;
}

function includesPhrase(text, phrase) {
  return normalizeText(text).toLowerCase().includes(normalizeText(phrase).toLowerCase());
}

function stripAllowedBannedContexts(text, testCase) {
  let stripped = text;
  for (const phrase of testCase.allowed_banned_contexts || []) {
    const escaped = normalizeText(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    stripped = stripped.replace(new RegExp(escaped, 'gi'), '');
  }
  return stripped;
}

function evaluateCandidate(testCase, candidate) {
  const text = normalizeText(candidate);
  const bannedScope = stripAllowedBannedContexts(text, testCase);
  const bannedHits = (testCase.banned_phrases || []).filter((phrase) => includesPhrase(bannedScope, phrase));
  const requiredAny = testCase.required_any || [];
  const requiredHit = requiredAny.length === 0 || requiredAny.some((phrase) => includesPhrase(text, phrase));
  const words = wordCount(text);
  const maxWords = Number.isFinite(testCase.max_words) ? Number(testCase.max_words) : 80;
  const failures = [];

  if (!text) failures.push('empty_candidate');
  if (bannedHits.length > 0) failures.push(`banned_phrase:${bannedHits.join('|')}`);
  if (!requiredHit) failures.push(`missing_required_any:${requiredAny.join('|')}`);
  if (words > maxWords) failures.push(`too_long:${words}>${maxWords}`);

  return {
    ok: failures.length === 0,
    case_id: testCase.id,
    prompt: testCase.prompt,
    word_count: words,
    max_words: maxWords,
    banned_hits: bannedHits,
    required_hit: requiredHit,
    failures,
  };
}

function validateVoiceLab(cases) {
  const results = [];
  const ids = new Set();

  for (const testCase of cases) {
    const structuralFailures = [];
    if (testCase.schema !== 'mira.voice_lab.case.v0') structuralFailures.push('schema');
    if (!testCase.id || ids.has(testCase.id)) structuralFailures.push('id');
    if (!testCase.prompt) structuralFailures.push('prompt');
    if (!Array.isArray(testCase.target_rewrites) || testCase.target_rewrites.length < 1) structuralFailures.push('target_rewrites');
    if (!Array.isArray(testCase.banned_phrases) || testCase.banned_phrases.length < 1) structuralFailures.push('banned_phrases');
    if (!Array.isArray(testCase.source_notes) || testCase.source_notes.length < 1) structuralFailures.push('source_notes');
    ids.add(testCase.id);

    const rewriteResults = (testCase.target_rewrites || []).map((candidate) => evaluateCandidate(testCase, candidate));
    results.push({
      ok: structuralFailures.length === 0 && rewriteResults.every((result) => result.ok),
      case_id: testCase.id,
      structural_failures: structuralFailures,
      rewrite_results: rewriteResults,
    });
  }

  return {
    ok: results.every((result) => result.ok),
    case_count: cases.length,
    results,
  };
}

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cases = readVoiceLab(args.labPath);

  if (args.candidate || args.caseId) {
    if (!args.caseId) throw new Error('--case is required when evaluating a candidate.');
    const testCase = cases.find((item) => item.id === args.caseId);
    if (!testCase) throw new Error(`Voice lab case not found: ${args.caseId}`);
    return evaluateCandidate(testCase, args.candidate);
  }

  return validateVoiceLab(cases);
}

function main() {
  try {
    const result = run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_LAB_PATH,
  evaluateCandidate,
  readVoiceLab,
  run,
  validateVoiceLab,
};
