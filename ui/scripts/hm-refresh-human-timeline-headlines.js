#!/usr/bin/env node
'use strict';

const {
  extractResponseText,
  OPENAI_RESPONSES_URL,
} = require('../modules/mira-core/text-model-attachment-v1');
const {
  collectHumanTimelineHeadlineSources,
} = require('../modules/main/human-timeline');
const {
  approveHeadlineCandidate,
  cachedHeadlineForSource,
  refreshHeadlineCache,
  resolveHeadlineCachePath,
  sourceKey,
} = require('../modules/main/human-timeline-headline-cache');
const { gateHeadline } = require('./hm-timeline-gate');

const DEFAULT_MODEL = 'gpt-5.5';

function argValue(args, name, fallback = null) {
  const prefix = `${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  return fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function cleanCandidate(value) {
  return String(value || '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] || '';
}

async function generateOpenAiHeadline(source, options = {}) {
  const apiKey = options.apiKey || process.env.SQUIDRUN_HUMAN_TIMELINE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');
  const model = options.model || process.env.SQUIDRUN_HUMAN_TIMELINE_HEADLINE_MODEL || DEFAULT_MODEL;
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions: [
        'Write one plain-English sentence for James about a SquidRun Today item.',
        'Keep it truthful to the source. Do not add specific facts, names, counts, products, or entities that are not in the source.',
        'Do not write "SquidRun", "James", "TrustQuote", "Telegram", "Today", or any other proper noun unless that exact word appears in the source text.',
        'Do not mention commits, files, scripts, panes, guards, launchers, fallbacks, env leaks, or internal implementation jargon.',
        'The acceptance gate rejects these words and ideas: sidecar, launcher, launchers, guard, guards, env leak, fallback, handler, daemon, poller, websocket, root-coherence, hm-*. Avoid them.',
        'Use a natural sentence with an actor. Under 95 characters. Output only the sentence.',
        options.rejectionHint ? `Previous attempt was rejected by the gate: ${options.rejectionHint}` : '',
      ].join('\n'),
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `Source kind: ${source.kind}`,
                `Source id: ${source.id}`,
                `Source text: ${source.sourceText}`,
              ].join('\n'),
            },
          ],
        },
      ],
      tools: [],
      store: false,
      max_output_tokens: 240,
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
      metadata: {
        surface: 'human_timeline_headline_cache',
        source_kind: String(source.kind || '').slice(0, 64),
      },
    }),
  });
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    const message = body?.error?.message || body?.error || `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return cleanCandidate(extractResponseText(body));
}

async function generateGatedOpenAiHeadline(source, options = {}) {
  let lastCandidate = '';
  let lastFailures = [];
  const attempts = Math.max(1, Math.min(5, Number(options.attempts) || 5));
  for (let index = 0; index < attempts; index += 1) {
    const candidate = await generateOpenAiHeadline(source, {
      ...options,
      rejectionHint: lastFailures.join(', '),
    });
    lastCandidate = candidate;
    const gate = gateHeadline(candidate, source.sourceText || '');
    if (gate.pass) return candidate;
    lastFailures = gate.failures || ['gate_failed'];
  }
  return lastCandidate;
}

async function main(argv = process.argv.slice(2)) {
  const limit = Math.max(1, Math.min(100, Number(argValue(argv, '--limit', 40)) || 40));
  const dryRun = hasFlag(argv, '--dry-run');
  const force = hasFlag(argv, '--force');
  const model = argValue(argv, '--model', null);
  const sources = collectHumanTimelineHeadlineSources({ maxFeedItems: limit }).slice(0, limit);
  const selected = force
    ? sources
    : sources.filter((source) => !cachedHeadlineForSource(source));
  const results = await refreshHeadlineCache(selected, {
    force,
    write: !dryRun,
    generatedBy: model ? `openai:${model}` : 'openai:gpt-5.5',
    generateHeadline: (source) => generateGatedOpenAiHeadline(source, { model }),
  });
  const rejected = results.results.filter((result) => result.status === 'rejected');
  const approved = results.results.filter((result) => result.status === 'approved');
  const cached = sources.length - selected.length;
  console.log(JSON.stringify({
    ok: rejected.length === 0,
    cachePath: resolveHeadlineCachePath(),
    dryRun,
    sourceCount: sources.length,
    skippedCachedCount: cached,
    approvedCount: approved.length,
    rejectedCount: rejected.length,
    results: results.results.map((result) => ({
      status: result.status,
      key: result.key || sourceKey(result.source) || null,
      headline: result.entry?.headline || result.headline || null,
      failures: result.gate?.failures || [],
    })),
  }, null, 2));
  if (rejected.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`headline refresh failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  cleanCandidate,
  generateGatedOpenAiHeadline,
  generateOpenAiHeadline,
  main,
  approveHeadlineCandidate,
};
