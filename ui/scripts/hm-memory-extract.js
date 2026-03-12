#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { CognitiveMemoryStore } = require('../modules/cognitive-memory-store');
const DEFAULT_FRAGMENT_CHARS = 900;
const DEFAULT_FRAGMENT_OVERLAP_CHARS = 140;

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const positional = [];
  const flags = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !String(next).startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { positional, flags };
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function findFragmentBoundaryBefore(text, index, window = 80) {
  const target = Math.max(0, Math.min(text.length, Number(index) || 0));
  const min = Math.max(0, target - Math.max(8, window));
  for (let cursor = target; cursor > min; cursor -= 1) {
    if (/\s/.test(text[cursor - 1] || '')) {
      return cursor;
    }
  }
  return target;
}

function findFragmentBoundaryAfter(text, index, window = 80) {
  const target = Math.max(0, Math.min(text.length, Number(index) || 0));
  const max = Math.min(text.length, target + Math.max(8, window));
  for (let cursor = target; cursor < max; cursor += 1) {
    if (/\s/.test(text[cursor] || '')) {
      return cursor;
    }
  }
  return target;
}

function chunkFragment(text, options = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const maxChars = Math.max(200, Number.parseInt(String(options.maxChars || DEFAULT_FRAGMENT_CHARS), 10) || DEFAULT_FRAGMENT_CHARS);
  const overlapChars = Math.max(
    0,
    Math.min(
      Math.floor(maxChars / 2),
      Number.parseInt(String(options.overlapChars || DEFAULT_FRAGMENT_OVERLAP_CHARS), 10) || DEFAULT_FRAGMENT_OVERLAP_CHARS
    )
  );

  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + maxChars);
    if (end < normalized.length) {
      const adjustedEnd = findFragmentBoundaryBefore(normalized, end);
      if (adjustedEnd > start + Math.floor(maxChars * 0.65)) {
        end = adjustedEnd;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end >= normalized.length) break;

    const overlapStart = Math.max(start + 1, end - overlapChars);
    const adjustedStart = findFragmentBoundaryAfter(normalized, overlapStart);
    start = adjustedStart > start ? adjustedStart : end;
  }

  return chunks;
}

function collectTextFragments(payload) {
  const fragments = [];
  const pushValue = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      const normalized = normalizeText(value);
      if (!normalized) return;
      const chunked = chunkFragment(normalized);
      for (const chunk of chunked) {
        if (chunk) fragments.push(chunk);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(pushValue);
      return;
    }
    if (typeof value === 'object') {
      pushValue(value.content);
      pushValue(value.text);
      pushValue(value.message);
      pushValue(value.summary);
      pushValue(value.notes);
    }
  };

  pushValue(payload.summary);
  pushValue(payload.context);
  pushValue(payload.transcript);
  pushValue(payload.messages);
  pushValue(payload.recent_messages);
  pushValue(payload.events);
  return fragments;
}

function classifyFragment(fragment) {
  const text = normalizeText(fragment);
  if (!text || text.length < 20) return null;
  const lowered = text.toLowerCase();

  if (/james prefers|user prefers|prefers .* over|prefers direct|prefers concise/.test(lowered)) {
    return { category: 'preference', confidence_score: 0.72, domain: 'user_preferences' };
  }
  if (/plumbing business|runs a plumbing business|workers comp|insurance workflow/.test(lowered)) {
    return { category: 'fact', confidence_score: 0.68, domain: 'business_context' };
  }
  if (/configured|deployed|path|scheduled task|supervisor|sqlite|hook|watcher/.test(lowered)) {
    return { category: 'system_state', confidence_score: 0.62, domain: 'system_architecture' };
  }
  if (/need to|should|must|workflow|command|script|task/.test(lowered)) {
    return { category: 'workflow', confidence_score: 0.58, domain: 'workflows' };
  }
  if (text.length <= 240) {
    return { category: 'observation', confidence_score: 0.45, domain: 'session_observations' };
  }
  return null;
}

function extractCandidates(payload = {}, options = {}) {
  const fragments = collectTextFragments(payload);
  const seen = new Set();
  const candidates = [];
  const sessionId = String(payload.session_id || payload.sessionId || options.sessionId || 'unknown');
  const proposedBy = String(options.proposedBy || payload.hook_event || payload.hookEventName || 'precompact-hook');

  fragments.forEach((fragment, index) => {
    const classification = classifyFragment(fragment);
    if (!classification) return;
    const statement = normalizeText(fragment);
    const key = `${classification.category}:${statement.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      category: classification.category,
      statement,
      confidence_score: classification.confidence_score,
      review_count: 0,
      domain: classification.domain,
      proposed_by: proposedBy,
      source_trace: `${sessionId}:${index}`,
      source_payload: {
        hook_event: payload.hook_event || payload.hookEventName || null,
        session_id: sessionId,
        fragment,
      },
    });
  });

  return candidates.slice(0, Math.max(1, Math.min(25, Number.parseInt(options.limit || '12', 10) || 12)));
}

async function readPayload(flags) {
  if (typeof flags.input === 'string' && flags.input.trim()) {
    return JSON.parse(fs.readFileSync(path.resolve(String(flags.input)), 'utf8'));
  }
  const input = await new Promise((resolve) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buffer += chunk; });
    process.stdin.on('end', () => resolve(buffer));
    process.stdin.resume();
  });
  return input.trim() ? JSON.parse(input) : {};
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const payload = await readPayload(flags);
  const candidates = extractCandidates(payload, {
    proposedBy: flags['proposed-by'],
    limit: flags.limit,
  });

  const store = new CognitiveMemoryStore();
  try {
    const staged = store.stageMemoryPRs(candidates);
    const output = {
      ok: true,
      candidates: candidates.length,
      staged: staged.staged.length,
      merged: staged.merged.length,
      pendingCount: staged.pendingCount,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    store.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  collectTextFragments,
  chunkFragment,
  extractCandidates,
};
