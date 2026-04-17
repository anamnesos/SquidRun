'use strict';

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('../config');
const { getDatabaseSync } = require('./sqlite-compat');
const {
  buildTranscriptIndex,
  readTranscriptIndex,
  resolveClaudeTranscriptProjectsDir,
  extractEntities,
  searchTranscriptIndex,
} = require('./transcript-index');

const DEFAULT_MAX_ACTIVE_ITEMS = 8;
const DEFAULT_MAX_QUERIES = 12;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_RECENT_COMMS_LIMIT = 8;
const EUNBYEOL_CHAT_ID = '8754356993';
const DatabaseSync = getDatabaseSync();

function normalizeWindowKey(value) {
  const normalized = trimText(value).toLowerCase();
  return normalized || 'main';
}

function trimText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function shorten(value, maxChars = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function unique(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function normalizeQuery(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function resolveKnowledgePath(projectRoot, filename) {
  return path.join(projectRoot, 'workspace', 'knowledge', filename);
}

function resolveEvidenceLedgerDbPath(projectRoot, explicitPath = null) {
  return explicitPath
    ? path.resolve(explicitPath)
    : path.join(projectRoot, '.squidrun', 'runtime', 'evidence-ledger.db');
}

function readFileIfExists(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch (_) {
    return '';
  }
}

function extractTradingActiveItems(content = '') {
  const lines = String(content || '').split(/\r?\n/);
  const results = [];
  for (const line of lines) {
    const trimmed = trimText(line);
    if (!trimmed) continue;
    if (/^- \*\*(Open positions|Hyperliquid balance|Thesis|Stop loss|Take profit)\*\*:/i.test(trimmed)) {
      results.push(trimmed.replace(/^- /, ''));
      continue;
    }
    if (/^- (ETH bounced|If bounce fades|Cascading liquidation)/i.test(trimmed)) {
      results.push(trimmed.replace(/^- /, ''));
    }
  }
  return results;
}

function extractCaseActiveItems(content = '') {
  const lines = String(content || '').split(/\r?\n/);
  const results = [];
  let currentSection = '';
  for (const line of lines) {
    const trimmed = trimText(line);
    if (!trimmed) continue;
    const headingMatch = trimmed.match(/^###\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[1];
      continue;
    }
    if (trimmed.startsWith('|') && /(WAITING|BLOCKED|FIXED)/i.test(trimmed)) {
      const parts = trimmed.split('|').map((part) => trimText(part)).filter(Boolean);
      const item = parts[1] || '';
      const status = parts[3] || parts[parts.length - 1] || '';
      if (!item || /^item$/i.test(item) || /^-+$/.test(item)) {
        continue;
      }
      if (item) {
        results.push(`${currentSection || 'Case'}: ${item}${status ? ` (${status})` : ''}`);
      }
    }
  }
  return results;
}

function readRecentComms(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  const dbPath = resolveEvidenceLedgerDbPath(projectRoot, options.evidenceLedgerDbPath);
  const limit = Math.max(1, Number.parseInt(options.limit, 10) || DEFAULT_RECENT_COMMS_LIMIT);
  if (typeof DatabaseSync !== 'function' || !fs.existsSync(dbPath)) {
    return [];
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath);
    const rows = db.prepare(`
      SELECT row_id, sender_role, target_role, channel, raw_body
           , session_id, metadata_json
      FROM comms_journal
      WHERE raw_body IS NOT NULL
        AND TRIM(raw_body) <> ''
      ORDER BY row_id DESC
      LIMIT ?
    `).all(limit);
    const mappedRows = rows.map((row) => ({
      rowId: Number(row.row_id || 0),
      senderRole: trimText(row.sender_role),
      targetRole: trimText(row.target_role),
      channel: trimText(row.channel),
      body: trimText(row.raw_body),
      sessionId: trimText(row.session_id),
      metadata: (() => {
        try {
          return JSON.parse(String(row.metadata_json || '{}'));
        } catch (_) {
          return {};
        }
      })(),
    }));
    const windowKey = normalizeWindowKey(options.windowKey);
    return mappedRows.filter((row) => {
      const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      const chatId = trimText(metadata.chatId || metadata.telegramChatId);
      const commsWindowKey = trimText(metadata.windowKey).toLowerCase();
      const isEunbyeolRow = (
        chatId === EUNBYEOL_CHAT_ID
        || commsWindowKey === 'eunbyeol'
        || trimText(row.sessionId).toLowerCase().endsWith(':eunbyeol')
      );
      return windowKey === 'eunbyeol' ? isEunbyeolRow : !isEunbyeolRow;
    });
  } catch (_) {
    return [];
  } finally {
    try {
      db?.close?.();
    } catch (_) {
      // best effort
    }
  }
}

function extractCommsActiveItems(rows = []) {
  return rows
    .map((row) => {
      const body = shorten(row.body, 180);
      if (!body) return '';
      return `Recent comms: ${row.senderRole || 'unknown'} -> ${row.targetRole || 'unknown'}: ${body}`;
    })
    .filter(Boolean);
}

function buildActiveItems(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  const tradingPath = resolveKnowledgePath(projectRoot, 'trading-operations.md');
  const casePath = resolveKnowledgePath(projectRoot, 'case-operations.md');
  const tradingContent = readFileIfExists(tradingPath);
  const caseContent = readFileIfExists(casePath);
  const recentComms = readRecentComms({
    projectRoot,
    evidenceLedgerDbPath: options.evidenceLedgerDbPath,
    limit: options.recentCommsLimit,
  });

  const tradingItems = extractTradingActiveItems(tradingContent).slice(0, 4);
  const caseItems = extractCaseActiveItems(caseContent).slice(0, 3);
  const commsItems = extractCommsActiveItems(recentComms).slice(0, 2);
  const windowKey = normalizeWindowKey(options.windowKey);
  const items = windowKey === 'eunbyeol'
    ? [
      ...caseItems,
      ...commsItems,
    ]
    : (windowKey === 'main'
      ? [
        ...tradingItems,
        ...commsItems,
      ]
      : [
        ...tradingItems,
        ...caseItems,
        ...commsItems,
      ]);

  return {
    items: unique(items).slice(0, Math.max(1, Number.parseInt(options.maxActiveItems, 10) || DEFAULT_MAX_ACTIVE_ITEMS)),
    sources: {
      tradingPath,
      casePath,
      recentCommsCount: recentComms.length,
    },
  };
}

function buildQueryCandidates(activeItems = [], options = {}) {
  const queries = [];
  for (const item of activeItems) {
    const normalized = normalizeQuery(item.replace(/\*\*/g, ''));
    if (!normalized) continue;
    const entities = extractEntities(normalized);
    queries.push(...entities);
    queries.push(normalized.length <= 140 ? normalized : shorten(normalized, 120));
  }
  return unique(queries)
    .filter((query) => query.length >= 3)
    .slice(0, Math.max(1, Number.parseInt(options.maxQueries, 10) || DEFAULT_MAX_QUERIES));
}

function getLatestTranscriptSourceMtimeMs(projectsDir) {
  if (!fs.existsSync(projectsDir)) return 0;
  return fs.readdirSync(projectsDir)
    .filter((name) => name.toLowerCase().endsWith('.jsonl'))
    .map((name) => {
      try {
        return fs.statSync(path.join(projectsDir, name)).mtimeMs;
      } catch (_) {
        return 0;
      }
    })
    .reduce((max, value) => Math.max(max, value), 0);
}

function ensureTranscriptIndexAvailable(options = {}) {
  const { meta, indexPath, metaPath } = readTranscriptIndex(options);
  const projectsDir = resolveClaudeTranscriptProjectsDir(options);
  const latestSourceMtimeMs = getLatestTranscriptSourceMtimeMs(projectsDir);
  const builtAtMs = Number.isFinite(Date.parse(meta?.builtAt)) ? Date.parse(meta.builtAt) : 0;
  const indexMissing = !fs.existsSync(indexPath) || !fs.existsSync(metaPath);
  const stale = latestSourceMtimeMs > builtAtMs;

  if (indexMissing || stale) {
    return {
      rebuilt: true,
      result: buildTranscriptIndex(options),
    };
  }

  return {
    rebuilt: false,
    result: meta || {
      ok: true,
      indexPath,
      metaPath,
      transcriptDir: projectsDir,
    },
  };
}

function retrieveTranscriptMatches(queries = [], options = {}) {
  const aggregate = new Map();
  const maxResults = Math.max(1, Number.parseInt(options.maxResults, 10) || DEFAULT_MAX_RESULTS);
  for (const query of queries) {
    const result = searchTranscriptIndex(query, {
      ...options,
      limit: Math.max(maxResults, 3),
    });
    for (const row of result.results || []) {
      if (/^This session is being continued from a previous conversation/i.test(String(row.text || ''))) {
        continue;
      }
      const existing = aggregate.get(row.id) || { ...row, score: 0, matchedQueries: [] };
      let nextScore = Math.max(existing.score || 0, Number(row.score || 0)) + 2;
      if (String(row.text || '').length > 1600) {
        nextScore -= 6;
      }
      existing.score = nextScore;
      existing.matchedQueries = unique([...(existing.matchedQueries || []), query]);
      existing.excerpt = row.excerpt || existing.excerpt || '';
      aggregate.set(row.id, existing);
    }
  }
  return Array.from(aggregate.values())
    .sort((left, right) => (right.score || 0) - (left.score || 0) || String(right.timestamp || '').localeCompare(String(left.timestamp || '')))
    .slice(0, maxResults);
}

function formatStartupTranscriptContext(payload = {}) {
  const activeItems = Array.isArray(payload.activeItems) ? payload.activeItems : [];
  const results = Array.isArray(payload.results) ? payload.results : [];
  const lines = [];
  lines.push('## Recovered Transcript Context');
  lines.push(`Generated: ${new Date().toISOString()} | Source: transcript-index`);
  lines.push('');

  if (activeItems.length > 0) {
    lines.push('### Active Items Detected');
    for (const item of activeItems.slice(0, DEFAULT_MAX_ACTIVE_ITEMS)) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  lines.push('### Relevant Transcript Recalls');
  if (results.length === 0) {
    lines.push('- No matching transcript recalls found for the current active items.');
    return lines.join('\n').trim();
  }

  results.forEach((result, index) => {
    const matched = (result.matchedQueries || []).slice(0, 3).join(' | ');
    lines.push(`${index + 1}. [${result.speaker || 'unknown'} | ${result.timestamp || 'unknown'}] ${matched || 'matched recall'}`);
    lines.push(`Source: ${result.sourceCitation}`);
    lines.push(`${result.excerpt || shorten(result.text, 260)}`);
    lines.push('');
  });

  return lines.join('\n').trim();
}

function buildStartupTranscriptContext(options = {}) {
  const ensureResult = ensureTranscriptIndexAvailable(options);
  const activeInfo = buildActiveItems(options);
  const queries = buildQueryCandidates(activeInfo.items, options);
  const results = retrieveTranscriptMatches(queries, options);

  return {
    ok: true,
    rebuiltIndex: ensureResult.rebuilt,
    indexSummary: ensureResult.result,
    activeItems: activeInfo.items,
    activeSources: activeInfo.sources,
    queries,
    results,
    context: formatStartupTranscriptContext({
      activeItems: activeInfo.items,
      results,
    }),
  };
}

module.exports = {
  buildStartupTranscriptContext,
  formatStartupTranscriptContext,
  buildActiveItems,
  buildQueryCandidates,
  ensureTranscriptIndexAvailable,
  readRecentComms,
  _internals: {
    extractTradingActiveItems,
    extractCaseActiveItems,
    extractCommsActiveItems,
    retrieveTranscriptMatches,
    getLatestTranscriptSourceMtimeMs,
    normalizeWindowKey,
  },
};
