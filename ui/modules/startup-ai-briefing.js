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

function loadHyperliquidClient() {
  try {
    return require('./trading/hyperliquid-client');
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
    const hyperliquidClient = loadHyperliquidClient();
    if (hyperliquidClient?.__loadError) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: hyperliquidClient.__loadError.message || 'hyperliquid_client_load_failed',
        positions: [],
      };
    }
    const walletAddress = typeof hyperliquidClient.resolveWalletAddress === 'function'
      ? hyperliquidClient.resolveWalletAddress(options.env || process.env)
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
      hyperliquidClient.getAccountSnapshot({
        env: options.env || process.env,
        walletAddress,
      }),
      hyperliquidClient.getOpenPositions({
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

function resolvePaperPortfolioDir(options = {}) {
  if (options.paperPortfolioDir) return path.resolve(String(options.paperPortfolioDir));
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  return path.join(projectRoot, 'workspace', 'agent-trading');
}

function normalizePaperPortfolioSummary(portfolio = {}, fallbackAgentId = '') {
  const openPositions = Array.isArray(portfolio.openPositions)
    ? portfolio.openPositions.map((position) => normalizeBriefingPosition(position)).filter((position) => position.ticker)
    : [];
  const recentClosedTrades = Array.isArray(portfolio.closedTrades)
    ? portfolio.closedTrades
      .slice()
      .sort((left, right) => {
        const leftMs = Date.parse(left?.closedAt || left?.openedAt || 0) || 0;
        const rightMs = Date.parse(right?.closedAt || right?.openedAt || 0) || 0;
        return rightMs - leftMs;
      })
      .slice(0, 3)
      .map((trade) => ({
        ticker: toText(trade?.ticker || (trade?.symbol ? `${trade.symbol}/USD` : ''), ''),
        side: toText(trade?.side || trade?.direction, ''),
        exitPrice: toNumber(trade?.exitPrice ?? trade?.exit, 0),
        realizedPnl: toNumber(trade?.realizedPnl, 0),
        closedAt: toText(trade?.closedAt, ''),
      }))
      .filter((trade) => trade.ticker)
    : [];

  return {
    agentId: toText(portfolio.agentId || portfolio.agent || fallbackAgentId, fallbackAgentId || 'unknown'),
    equity: toNumber(portfolio.equity ?? portfolio.currentEquity, 0),
    cashBalance: toNumber(portfolio.cashBalance, 0),
    totalPnl: toNumber(portfolio.totalPnl, 0),
    openPositions,
    recentClosedTrades,
  };
}

function resolvePaperPortfolioSummary(options = {}) {
  if (options.paperPortfolioSummary && typeof options.paperPortfolioSummary === 'object') {
    return options.paperPortfolioSummary;
  }

  const portfolioDir = resolvePaperPortfolioDir(options);
  if (!fs.existsSync(portfolioDir)) {
    return {
      ok: false,
      portfolioDir,
      portfolios: [],
    };
  }

  const files = fs.readdirSync(portfolioDir)
    .filter((name) => name.toLowerCase().endsWith('-portfolio.json'))
    .sort();

  const portfolios = files
    .map((name) => {
      const fullPath = path.join(portfolioDir, name);
      const parsed = safeReadJson(fullPath);
      if (!parsed) return null;
      return normalizePaperPortfolioSummary(parsed, name.replace(/-portfolio\.json$/i, ''));
    })
    .filter(Boolean);

  return {
    ok: true,
    portfolioDir,
    portfolios,
  };
}

function detectLivePaperConflicts(liveSnapshot = {}, paperSummary = {}) {
  const livePositions = Array.isArray(liveSnapshot?.positions) ? liveSnapshot.positions : [];
  const portfolios = Array.isArray(paperSummary?.portfolios) ? paperSummary.portfolios : [];
  const conflicts = [];

  for (const livePosition of livePositions) {
    const ticker = toText(livePosition?.ticker, '');
    if (!ticker) continue;
    for (const portfolio of portfolios) {
      const openMatch = (portfolio.openPositions || []).some((position) => position.ticker === ticker);
      if (openMatch) continue;
      const recentClosedMatch = (portfolio.recentClosedTrades || []).find((trade) => trade.ticker === ticker);
      if (!recentClosedMatch) continue;
      conflicts.push({
        ticker,
        liveState: 'open',
        paperState: 'closed',
        agentId: portfolio.agentId,
        paperClosedAt: recentClosedMatch.closedAt || null,
        paperExitPrice: recentClosedMatch.exitPrice || null,
      });
    }
  }

  return conflicts;
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
    'Verified live Hyperliquid snapshot:',
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

function formatPaperSummaryBlock(paperSummary = {}) {
  const portfolios = Array.isArray(paperSummary?.portfolios) ? paperSummary.portfolios : [];
  if (portfolios.length === 0) {
    return 'Paper trading state: unavailable.';
  }

  const lines = ['Paper trading state (keep separate from live account state):'];
  for (const portfolio of portfolios) {
    lines.push(`- ${portfolio.agentId}: equity=${portfolio.equity}, totalPnl=${portfolio.totalPnl}, openPositions=${portfolio.openPositions.length}`);
    for (const position of portfolio.openPositions) {
      lines.push(`  - OPEN ${position.ticker} ${position.side} entry=${position.entryPx}`);
    }
    for (const trade of portfolio.recentClosedTrades || []) {
      lines.push(`  - RECENT_CLOSED ${trade.ticker} exit=${trade.exitPrice} closedAt=${toText(trade.closedAt, 'unknown')}`);
    }
  }
  return lines.join('\n');
}

function formatConflictBlock(conflicts = []) {
  if (!Array.isArray(conflicts) || conflicts.length === 0) return '';
  const lines = [
    'Live/Paper conflict warnings:',
    'Do not describe any paper trade or paper account number as live state.',
  ];
  for (const conflict of conflicts) {
    lines.push(`- ${conflict.ticker}: live is OPEN, but ${conflict.agentId} paper is CLOSED at ${toText(conflict.paperClosedAt, 'unknown')} exit=${toNumber(conflict.paperExitPrice, 0)}`);
  }
  return lines.join('\n');
}

function buildBriefingPrompt(files = [], transcriptCorpus = '', context = {}) {
  const sourceList = files.map((file, index) => `${index + 1}. ${file.name} | modified ${file.modifiedAt}`).join('\n');
  const liveSnapshotBlock = formatLiveSnapshotBlock(context.liveSnapshot);
  const paperSummaryBlock = formatPaperSummaryBlock(context.paperSummary);
  const conflictBlock = formatConflictBlock(context.livePaperConflicts);
  return [
    'Read these conversations and write a briefing for the agents starting up: what happened, what\'s unfinished, what decisions were made, what James cares about right now.',
    '',
    'Requirements:',
    '- Output markdown only.',
    '- Keep it under 2000 tokens.',
    '- Be concrete about current priorities, unfinished work, decisions, user preferences, blockers, and risks.',
    '- Prefer recent facts when the transcripts disagree, but call out uncertainty when needed.',
    '- Write for the SquidRun startup context so Architect, Builder, and Oracle can act immediately.',
    '- Use the verified live snapshot for any live-position or live-account prose.',
    '- Keep live trading state and paper trading state in separate sections.',
    '- Never use paper trades, paper exits, or paper account balances to describe the live account.',
    '- If live and paper mention the same ticker, call out the distinction explicitly instead of merging them.',
    '- Do not include analysis process or mention token budgets.',
    '',
    'Transcript order: newest first.',
    '',
    liveSnapshotBlock,
    '',
    paperSummaryBlock,
    '',
    conflictBlock,
    '',
    'Source transcripts:',
    sourceList || 'None found.',
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
            paperSummary: options.paperSummary,
            livePaperConflicts: options.livePaperConflicts,
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
  const paperSummary = resolvePaperPortfolioSummary(options);
  const livePaperConflicts = detectLivePaperConflicts(liveSnapshot, paperSummary);

  try {
    if (liveSnapshot?.ok !== true && livePaperConflicts.length > 0) {
      throw new Error('live_paper_conflict_requires_live_snapshot');
    }

    const body = await requestStartupBriefing(transcriptCorpus, {
      ...options,
      transcriptFiles,
      liveSnapshot,
      paperSummary,
      livePaperConflicts,
    });
    const document = formatBriefingDocument(body, transcriptFiles, {
      ...options,
      generatedAt,
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
      livePaperConflictCount: livePaperConflicts.length,
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
      paperSummary,
      livePaperConflicts,
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
      livePaperConflictCount: livePaperConflicts.length,
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
      paperSummary,
      livePaperConflicts,
    };
  }
}

module.exports = {
  generateStartupBriefing,
  readStartupBriefing,
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
    resolvePaperPortfolioSummary,
    detectLivePaperConflicts,
    formatLiveSnapshotBlock,
    formatPaperSummaryBlock,
    formatConflictBlock,
  },
};
