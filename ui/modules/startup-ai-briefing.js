'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

const fs = require('fs');
const path = require('path');
const { getProjectRoot, resolveCoordPath } = require('../config');
const { resolveClaudeTranscriptProjectsDir } = require('./transcript-index');

const DEFAULT_MODEL = String(process.env.SQUIDRUN_STARTUP_BRIEFING_MODEL || 'claude-opus-4-6').trim();
const DEFAULT_BASE_URL = String(process.env.SQUIDRUN_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').trim();
const DEFAULT_MAX_TRANSCRIPTS = 3;
const DEFAULT_MAX_CHARS_PER_TRANSCRIPT = 80000;
const DEFAULT_MAX_TOTAL_CHARS = 220000;
const DEFAULT_OUTPUT_RELATIVE_PATH = path.join('handoffs', 'ai-briefing.md');
const DEFAULT_STATUS_RELATIVE_PATH = path.join('runtime', 'startup-briefing-status.json');
const RECALL_BLOCK_RE = /\[SQUIDRUN RECALL START\][\s\S]*?\[SQUIDRUN RECALL END\]\s*/gi;
const CANONICAL_SOURCE_RELATIVE_PATHS = [
  path.join('workspace', 'knowledge', 'case-operations.md'),
  path.join('workspace', 'knowledge', 'handoff-corrections.md'),
];

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function resolveCoordFile(relativePath, options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  try {
    return resolveCoordPath(relativePath, { forWrite: true });
  } catch (_) {
    return path.join(projectRoot, '.squidrun', relativePath);
  }
}

function resolveBriefingPath(options = {}) {
  return path.resolve(String(options.outputPath || resolveCoordFile(DEFAULT_OUTPUT_RELATIVE_PATH, options)));
}

function resolveStatusPath(options = {}) {
  return path.resolve(String(options.statusPath || resolveCoordFile(DEFAULT_STATUS_RELATIVE_PATH, options)));
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeFileAtomic(filePath, content) {
  ensureParentDir(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readStartupBriefing(options = {}) {
  const briefingPath = resolveBriefingPath(options);
  try {
    if (!fs.existsSync(briefingPath)) return '';
    return String(fs.readFileSync(briefingPath, 'utf8') || '').trim();
  } catch (_) {
    return '';
  }
}

function stripLiveAccountBlocks(markdown) {
  const out = [];
  let skip = false;
  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (/^#{1,3}\s+/.test(line)) {
      const lower = line.toLowerCase();
      skip = /live account|verified live|live positions|open positions|[private-live-ops].*snapshot/.test(lower);
    }
    if (!skip) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function resolveNowMs(options = {}) {
  const explicitNowMs = Number(options.nowMs);
  if (Number.isFinite(explicitNowMs)) return explicitNowMs;

  const explicitNow = options.now instanceof Date
    ? options.now.getTime()
    : Date.parse(String(options.now || ''));
  return Number.isFinite(explicitNow) ? explicitNow : Date.now();
}

function readStartupBriefingForInjection(options = {}) {
  let body = readStartupBriefing(options).trim();
  if (!body) return '';

  const status = safeReadJson(resolveStatusPath(options));
  const generatedAtMs = Date.parse(status?.generatedAt || '');
  const ageMinutes = Number.isFinite(generatedAtMs)
    ? Math.max(0, Math.round((resolveNowMs(options) - generatedAtMs) / 60000))
    : null;

  const notes = [];
  if (ageMinutes === null) {
    notes.push('STALE SNAPSHOT generated at unknown time, account values may have moved.');
  } else if (ageMinutes > 60) {
    notes.push(`STALE SNAPSHOT generated ${ageMinutes} minutes ago; live-account block omitted, account values may have moved.`);
    body = stripLiveAccountBlocks(body);
  } else if (ageMinutes > 15) {
    notes.push(`STALE SNAPSHOT generated ${ageMinutes} minutes ago, account values may have moved.`);
  } else {
    notes.push(`AI startup briefing age: ${ageMinutes} minutes.`);
  }

  return `${notes.join('\n')}\n\n${body}\n`;
}

function readFileIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8') || '').trim();
  } catch (_) {
    return '';
  }
}

function resolveCanonicalSourceFiles(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  return CANONICAL_SOURCE_RELATIVE_PATHS
    .map((relativePath) => {
      const filePath = path.join(projectRoot, relativePath);
      const content = readFileIfExists(filePath);
      if (!content) return null;
      return {
        relativePath: relativePath.replace(/\\/g, '/'),
        path: filePath,
        content,
      };
    })
    .filter(Boolean);
}

function extractSection(content = '', headingPattern) {
  const lines = String(content || '').split(/\r?\n/);
  const startIndex = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (startIndex < 0) return '';
  const section = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > startIndex && /^#{1,2}\s+/.test(line.trim())) break;
    section.push(line);
  }
  return section.join('\n').trim();
}

function extractCanonicalHighlights(source = {}) {
  const content = String(source.content || '');
  if (!content) return [];

  const highlights = [];
  for (const section of [
    extractSection(content, /^##\s+Hard Error Rules$/i),
    extractSection(content, /^##\s+Fast Use$/i),
  ]) {
    if (section) highlights.push(section);
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      /registration|eligibility|Startup Program|PrivateCase|postpartum|care|Channel A|broadcast confirmed|ExampleProperty Mailing|delivered|14-day/i.test(trimmed)
    ) {
      highlights.push(trimmed);
    }
  }

  return Array.from(new Set(highlights)).slice(0, 32);
}

function buildCanonicalSourceBlock(sources = [], options = {}) {
  const maxChars = Math.max(1200, Number.parseInt(String(options.maxChars || 12000), 10) || 12000);
  const sections = [];
  for (const source of sources) {
    const highlights = extractCanonicalHighlights(source);
    if (highlights.length === 0) continue;
    sections.push([
      `### ${source.relativePath}`,
      ...highlights.map((line) => `- ${line.replace(/^-+\s*/, '')}`),
    ].join('\n'));
  }
  const block = sections.join('\n\n').trim();
  return block.length > maxChars ? block.slice(0, maxChars).trim() : block;
}

function deriveCanonicalBriefingOverrides(sources = []) {
  const content = sources.map((source) => source.content || '').join('\n');
  return {
    businessRegistrationOnOrBefore20260603: (
      /registration[\s\S]{0,240}(before|on or before)\s+2026-06-03/i.test(content)
      || /registration[\s\S]{0,240}2026-06-03[\s\S]{0,160}(전|이전|on or before|before)/i.test(content)
    ),
    modueuiChangupSubmitted20260429: (
      /Startup Program 2026 1기\s*\|\s*\*\*Submitted 2026-04-29\*\*/i.test(content)
      || /Startup Program[\s\S]{0,160}Submitted 2026-04-29/i.test(content)
    ),
  };
}

function applyCanonicalBriefingOverrides(body = '', sources = []) {
  const overrides = deriveCanonicalBriefingOverrides(sources);
  let output = String(body || '');

  if (overrides.businessRegistrationOnOrBefore20260603) {
    output = output
      .replace(
        /(registration timing\s*\|\s*)Must be\s*\*\*?after\s+6\/3\*\*?[^\n]*/gi,
        '$1Must be **on or before 2026-06-03** to preserve eligibility benefit eligibility'
      )
      .replace(
        /(registration[^|\n]*\|\s*)Must be\s*\*\*?after\s+2026-06-03\*\*?[^\n]*/gi,
        '$1Must be **on or before 2026-06-03** to preserve eligibility benefit eligibility'
      )
      .replace(
        /business registration must happen\s+\*\*?after\s+(?:6\/3|2026-06-03)\*\*?/gi,
        'business registration must happen **on or before 2026-06-03**'
      )
      .replace(
        /coordinate registration timing \(must be after 6\/3\)/gi,
        'coordinate registration timing (must be on or before 2026-06-03)'
      );
  }

  if (overrides.modueuiChangupSubmitted20260429) {
    output = output
      .replace(
        /-\s+\*\*Status uncertain\*\*\s*[^\n]*Unknown if she completed submission\./gi,
        '- **Submitted 2026-04-29** (Scoped confirmed via Telegram).'
      )
      .replace(
        /Confirm Startup Program submission status[^\n]*/gi,
        'Monitor Startup Program Stage 1 announcement'
      )
      .replace(
        /did she finish and submit, or is it still in progress\?/gi,
        'submission is complete; monitor Stage 1 result.'
      );
  }

  return output;
}

function stripRecallNoise(value) {
  return String(value || '')
    .replace(RECALL_BLOCK_RE, '')
    .replace(/\r/g, '')
    .trim();
}

function extractTranscriptContentText(content) {
  if (typeof content === 'string') {
    return stripRecallNoise(content);
  }
  if (!Array.isArray(content)) return '';

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      if (String(item.type || '').toLowerCase() === 'text') {
        return stripRecallNoise(item.text);
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeTranscriptEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  const message = rawEntry.message && typeof rawEntry.message === 'object'
    ? rawEntry.message
    : rawEntry;
  const role = toText(message.role || rawEntry.role || rawEntry.type, '').toLowerCase();
  if (role !== 'user' && role !== 'assistant') return null;

  const text = extractTranscriptContentText(
    message.content ?? rawEntry.content ?? message.text ?? rawEntry.text ?? ''
  );
  if (!text) return null;

  return {
    role,
    text,
    timestamp: toText(rawEntry.timestamp || message.timestamp || rawEntry.created_at || message.created_at, ''),
  };
}

function listRecentTranscriptFiles(options = {}) {
  const projectsDir = resolveClaudeTranscriptProjectsDir(options);
  const maxTranscripts = Math.max(1, Number.parseInt(String(options.maxTranscripts || DEFAULT_MAX_TRANSCRIPTS), 10) || DEFAULT_MAX_TRANSCRIPTS);
  if (!fs.existsSync(projectsDir)) return [];

  return fs.readdirSync(projectsDir)
    .filter((name) => name.toLowerCase().endsWith('.jsonl'))
    .map((name) => {
      const filePath = path.join(projectsDir, name);
      const stats = fs.statSync(filePath);
      return {
        name,
        path: filePath,
        modifiedAt: new Date(stats.mtimeMs).toISOString(),
        mtimeMs: stats.mtimeMs,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxTranscripts);
}

function renderTranscriptForPrompt(fileInfo, options = {}) {
  const maxChars = Math.max(4000, Number.parseInt(String(options.maxChars || DEFAULT_MAX_CHARS_PER_TRANSCRIPT), 10) || DEFAULT_MAX_CHARS_PER_TRANSCRIPT);
  const raw = String(fs.readFileSync(fileInfo.path, 'utf8') || '');
  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .map((entry) => normalizeTranscriptEntry(entry))
    .filter(Boolean);

  if (entries.length === 0) return '';

  let body = entries
    .map((entry) => {
      const speaker = entry.role === 'user' ? 'USER' : 'ASSISTANT';
      const timestamp = entry.timestamp ? ` [${entry.timestamp}]` : '';
      return `${speaker}${timestamp}: ${entry.text}`;
    })
    .join('\n\n');

  let note = '';
  if (body.length > maxChars) {
    body = body.slice(-maxChars).trim();
    note = `Note: truncated to the most recent ${maxChars} characters to stay within the input budget.\n\n`;
  }

  return [
    `## Transcript ${fileInfo.name}`,
    `Modified: ${fileInfo.modifiedAt}`,
    '',
    note ? note.trimEnd() : '',
    body,
  ].filter(Boolean).join('\n');
}

function buildTranscriptCorpus(files = [], options = {}) {
  const maxTotalChars = Math.max(12000, Number.parseInt(String(options.maxTotalChars || DEFAULT_MAX_TOTAL_CHARS), 10) || DEFAULT_MAX_TOTAL_CHARS);
  const maxCharsPerTranscript = Math.max(4000, Number.parseInt(String(options.maxCharsPerTranscript || DEFAULT_MAX_CHARS_PER_TRANSCRIPT), 10) || DEFAULT_MAX_CHARS_PER_TRANSCRIPT);
  const sections = [];
  let remaining = maxTotalChars;

  for (const fileInfo of files) {
    if (remaining < 4000) break;
    const section = renderTranscriptForPrompt(fileInfo, {
      ...options,
      maxChars: Math.min(maxCharsPerTranscript, remaining),
    });
    if (!section) continue;
    sections.push(section);
    remaining -= section.length;
  }

  return sections.join('\n\n');
}

function safeReadJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(String(fs.readFileSync(filePath, 'utf8') || 'null'));
  } catch (_) {
    return null;
  }
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function load[private-live-ops]Client() {
  try {
    return require('./trading/[private-live-ops]-client');
  } catch (error) {
    return {
      __loadError: error,
    };
  }
}

function normalizeBriefingPosition(position = {}) {
  const ticker = toText(position.ticker || (position.coin ? `${position.coin}/USD` : ''), '');
  const side = toText(position.side, '').toLowerCase();
  return {
    ticker,
    side: side || (toNumber(position.size, 0) < 0 ? 'short' : 'long'),
    size: toNumber(position.size, 0),
    entryPx: toNumber(position.entryPx ?? position.entryPrice, 0),
    unrealizedPnl: toNumber(position.unrealizedPnl, 0),
    liquidationPx: toNumber(position.liquidationPx, 0),
    stopLossPrice: toNumber(position.stopLossPrice ?? position.stopLoss, 0) || null,
  };
}

async function resolveLiveDefiSnapshot(options = {}) {
  if (options.liveSnapshot && typeof options.liveSnapshot === 'object') {
    return options.liveSnapshot;
  }

  try {
    const [private-live-ops]Client = load[private-live-ops]Client();
    if ([private-live-ops]Client?.__loadError) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: [private-live-ops]Client.__loadError.message || '[private-live-ops]_client_load_failed',
        positions: [],
      };
    }
    const walletAddress = typeof [private-live-ops]Client.resolveWalletAddress === 'function'
      ? [private-live-ops]Client.resolveWalletAddress(options.env || process.env)
      : '';
    if (!walletAddress) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: 'missing_wallet_address',
        positions: [],
      };
    }

    const [account, positions] = await Promise.all([
      [private-live-ops]Client.getAccountSnapshot({
        env: options.env || process.env,
        walletAddress,
      }),
      [private-live-ops]Client.getOpenPositions({
        env: options.env || process.env,
        walletAddress,
      }),
    ]);

    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      walletAddress,
      accountValue: toNumber(account?.equity, 0),
      withdrawable: toNumber(account?.cash, 0),
      positions: (Array.isArray(positions) ? positions : []).map((position) => normalizeBriefingPosition(position)),
    };
  } catch (error) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      error: error.message,
      positions: [],
    };
  }
}

function formatLiveSnapshotBlock(liveSnapshot = {}) {
  if (liveSnapshot?.ok !== true) {
    return [
      'Verified live account snapshot: unavailable.',
      `Reason: ${toText(liveSnapshot?.error, 'unknown_error')}`,
    ].join('\n');
  }

  const positions = Array.isArray(liveSnapshot.positions) ? liveSnapshot.positions : [];
  const lines = [
    'Verified live [private-live-ops] snapshot:',
    `- checkedAt: ${toText(liveSnapshot.checkedAt, 'unknown')}`,
    `- accountValue: ${toNumber(liveSnapshot.accountValue, 0)}`,
    `- withdrawable: ${toNumber(liveSnapshot.withdrawable, 0)}`,
  ];

  if (positions.length === 0) {
    lines.push('- openPositions: none');
  } else {
    lines.push('- openPositions:');
    for (const position of positions) {
      lines.push(`  - ${position.ticker} ${position.side} size=${position.size} entry=${position.entryPx} unrealizedPnl=${position.unrealizedPnl} liquidationPx=${position.liquidationPx}`);
    }
  }

  return lines.join('\n');
}

function buildBriefingPrompt(files = [], transcriptCorpus = '', context = {}) {
  const sourceList = files.map((file, index) => `${index + 1}. ${file.name} | modified ${file.modifiedAt}`).join('\n');
  const liveSnapshotBlock = formatLiveSnapshotBlock(context.liveSnapshot);
  const canonicalSourceBlock = String(context.canonicalSourceBlock || '').trim();
  return [
    'Read these conversations and write a briefing for the agents starting up: what happened, what\'s unfinished, what decisions were made, what the user cares about right now.',
    '',
    'Requirements:',
    '- Output markdown only.',
    '- Keep it under 2000 tokens.',
    '- Be concrete about current priorities, unfinished work, decisions, user preferences, blockers, and risks.',
    '- Prefer recent facts when the transcripts disagree, but call out uncertainty when needed.',
    '- Treat the Canonical source-of-truth block below as higher priority than transcripts, memories, and prior handoffs.',
    '- If transcript summaries conflict with canonical source-of-truth, use the canonical fact and briefly note that stale transcript summaries were overridden.',
    '- Write for the SquidRun startup context so Architect, Builder, and Oracle can act immediately.',
    '- Use the verified live snapshot for any live-position or live-account prose.',
    '- Do not include analysis process or mention token budgets.',
    '',
    'Transcript order: newest first.',
    '',
    liveSnapshotBlock,
    '',
    'Source transcripts:',
    sourceList || 'None found.',
    '',
    'Canonical source-of-truth (highest priority):',
    canonicalSourceBlock || 'No canonical source-of-truth files found.',
    '',
    'Conversations:',
    transcriptCorpus || 'No usable transcript content found.',
  ].join('\n');
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

async function requestStartupBriefing(prompt, options = {}) {
  const apiKey = toText(options.apiKey || process.env.ANTHROPIC_API_KEY, '');
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch_unavailable');
  }

  const model = toText(options.model || DEFAULT_MODEL, DEFAULT_MODEL);
  const baseUrl = toText(options.baseUrl || DEFAULT_BASE_URL, DEFAULT_BASE_URL);
  const response = await fetchImpl(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.max(512, Number.parseInt(String(options.maxTokens || 1800), 10) || 1800),
      temperature: 0,
      system: [
        'You write concise, high-signal operational briefings for agents starting a new SquidRun session.',
        'Focus on what matters now, not generic summaries.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: buildBriefingPrompt(options.transcriptFiles || [], prompt, {
            liveSnapshot: options.liveSnapshot,
            canonicalSourceBlock: options.canonicalSourceBlock,
          }),
        },
      ],
    }),
  });

  if (!response || response.ok !== true) {
    const errorText = typeof response?.text === 'function' ? await response.text() : '';
    throw new Error(`http_${response?.status || 'unknown'}${errorText ? `:${errorText}` : ''}`);
  }

  const payload = await response.json();
  return extractTextFromAnthropicResponse(payload);
}

function formatBriefingDocument(body = '', files = [], options = {}) {
  const generatedAt = toText(options.generatedAt || new Date().toISOString(), new Date().toISOString());
  const model = toText(options.model || DEFAULT_MODEL, DEFAULT_MODEL);
  const canonicalSourceBlock = String(options.canonicalSourceBlock || '').trim();
  const lines = [
    '# AI Startup Briefing',
    '',
    `Generated: ${generatedAt}`,
    `Model: ${model}`,
    '',
    'Source transcripts (newest first):',
    ...(files.length > 0
      ? files.map((file, index) => `${index + 1}. ${file.name} | modified ${file.modifiedAt}`)
      : ['1. None found']),
    '',
    ...(canonicalSourceBlock
      ? [
        '## Canonical Source-Of-Truth Overrides',
        '',
        'These local files override stale transcript summaries and generated prose when they conflict:',
        '',
        canonicalSourceBlock,
        '',
      ]
      : []),
    body.trim(),
  ];
  return lines.join('\n').trim();
}

function writeStatusFile(statusPath, payload) {
  writeFileAtomic(statusPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function generateStartupBriefing(options = {}) {
  const generatedAt = toText(options.generatedAt || new Date().toISOString(), new Date().toISOString());
  const transcriptFiles = listRecentTranscriptFiles(options);
  const transcriptCorpus = buildTranscriptCorpus(transcriptFiles, options);
  const outputPath = resolveBriefingPath(options);
  const statusPath = resolveStatusPath(options);
  const liveSnapshot = await resolveLiveDefiSnapshot(options);
  const canonicalSources = resolveCanonicalSourceFiles(options);
  const canonicalSourceBlock = buildCanonicalSourceBlock(canonicalSources, options);

  try {
    const generatedBody = await requestStartupBriefing(transcriptCorpus, {
      ...options,
      transcriptFiles,
      liveSnapshot,
      canonicalSourceBlock,
    });
    const body = applyCanonicalBriefingOverrides(generatedBody, canonicalSources);
    const document = formatBriefingDocument(body, transcriptFiles, {
      ...options,
      generatedAt,
      canonicalSourceBlock,
    });

    writeFileAtomic(outputPath, `${document}\n`);
    writeStatusFile(statusPath, {
      ok: true,
      generatedAt,
      outputPath,
      transcriptCount: transcriptFiles.length,
      transcriptFiles,
      promptChars: transcriptCorpus.length,
      source: toText(options.source, 'manual'),
      model: toText(options.model || DEFAULT_MODEL, DEFAULT_MODEL),
      liveSnapshotOk: liveSnapshot?.ok === true,
      liveOpenPositionCount: Array.isArray(liveSnapshot?.positions) ? liveSnapshot.positions.length : 0,
      canonicalSourceCount: canonicalSources.length,
      canonicalSourceFiles: canonicalSources.map((source) => source.relativePath),
    });

    return {
      ok: true,
      generatedAt,
      outputPath,
      statusPath,
      transcriptFiles,
      promptChars: transcriptCorpus.length,
      content: document,
      liveSnapshot,
    };
  } catch (error) {
    writeStatusFile(statusPath, {
      ok: false,
      generatedAt,
      outputPath,
      transcriptCount: transcriptFiles.length,
      transcriptFiles,
      promptChars: transcriptCorpus.length,
      source: toText(options.source, 'manual'),
      error: error.message,
      liveSnapshotOk: liveSnapshot?.ok === true,
      liveOpenPositionCount: Array.isArray(liveSnapshot?.positions) ? liveSnapshot.positions.length : 0,
      canonicalSourceCount: canonicalSources.length,
      canonicalSourceFiles: canonicalSources.map((source) => source.relativePath),
    });
    return {
      ok: false,
      generatedAt,
      outputPath,
      statusPath,
      transcriptFiles,
      promptChars: transcriptCorpus.length,
      error: error.message,
      liveSnapshot,
    };
  }
}

module.exports = {
  generateStartupBriefing,
  readStartupBriefing,
  readStartupBriefingForInjection,
  resolveBriefingPath,
  _internals: {
    listRecentTranscriptFiles,
    renderTranscriptForPrompt,
    buildTranscriptCorpus,
    normalizeTranscriptEntry,
    extractTranscriptContentText,
    buildBriefingPrompt,
    formatBriefingDocument,
    requestStartupBriefing,
    resolveLiveDefiSnapshot,
    formatLiveSnapshotBlock,
    stripLiveAccountBlocks,
    resolveCanonicalSourceFiles,
    buildCanonicalSourceBlock,
    deriveCanonicalBriefingOverrides,
    applyCanonicalBriefingOverrides,
  },
};
