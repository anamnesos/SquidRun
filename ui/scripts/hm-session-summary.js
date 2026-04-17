#!/usr/bin/env node

/**
 * hm-session-summary.js — Session-end summary writer.
 *
 * Queries the comms_journal for the current session's messages,
 * filters test noise, builds a concise summary, and writes it to:
 *   1. Cognitive memory (category: 'session_summary')
 *   2. Flat file fallback (.squidrun/handoffs/last-session-summary.md)
 *
 * Usage:
 *   node ui/scripts/hm-session-summary.js [--session <N>] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot, resolveCoordPath } = require('../config');
const { queryCommsJournalEntries } = require('../modules/main/comms-journal');
const { CognitiveMemoryApi } = require('../modules/cognitive-memory-api');

const DEFAULT_QUERY_LIMIT = 5000;
const FALLBACK_RELATIVE_PATH = path.join('handoffs', 'last-session-summary.md');
const NOISE_SENDER_ROLE = 'cli';
const NOISE_BODY_PREFIX = '(TEST ';

/**
 * @param {string | number | null | undefined} value
 * @returns {number | null}
 */
function parseSessionNumber(value) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

/**
 * Read the current session number from app-status.json.
 * @returns {number | null}
 */
function readCurrentSessionNumber() {
  try {
    const appStatusPath = resolveCoordPath('app-status.json');
    if (!appStatusPath || !fs.existsSync(appStatusPath)) return null;
    const raw = fs.readFileSync(appStatusPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parseSessionNumber(parsed?.session ?? parsed?.sessionNumber ?? parsed?.session_number);
  } catch {
    return null;
  }
}

/**
 * Filter out test noise from comms rows.
 * Noise = sender_role is 'cli' AND rawBody starts with '(TEST '.
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Array<Record<string, unknown>>}
 */
function filterNoise(rows) {
  return rows.filter((row) => {
    const senderRole = String(row?.senderRole || '').toLowerCase();
    const body = String(row?.rawBody || '');
    if (senderRole === NOISE_SENDER_ROLE && body.startsWith(NOISE_BODY_PREFIX)) {
      return false;
    }
    return true;
  });
}

/**
 * Build a concise text summary from filtered rows.
 * @param {Array<Record<string, unknown>>} rows
 * @param {number} sessionNumber
 * @param {number} [nowMs]
 * @returns {string}
 */
function buildSummaryText(rows, sessionNumber, nowMs = Date.now()) {
  if (rows.length === 0) {
    return `# Session ${sessionNumber} Summary\n\nNo messages recorded in this session.\n`;
  }

  // Collect sender roles
  const senderCounts = {};
  const channelCounts = {};
  const taggedDecisions = [];
  const taggedTasks = [];
  const taggedFindings = [];
  const taggedBlockers = [];
  const TAG_PATTERN = /^(?:\[[^\]]*\]\s*)?(?:\([^)]*\)\s*:?\s*)?[-*]?\s*(DECISION|TASK|FINDING|BLOCKER)\s*:\s*(.+)$/im;

  let earliestMs = Number.MAX_SAFE_INTEGER;
  let latestMs = 0;

  for (const row of rows) {
    const sender = String(row?.senderRole || 'unknown').toLowerCase();
    senderCounts[sender] = (senderCounts[sender] || 0) + 1;

    const channel = String(row?.channel || 'unknown').toLowerCase();
    channelCounts[channel] = (channelCounts[channel] || 0) + 1;

    const tsMs = Number(row?.brokeredAtMs || row?.sentAtMs || row?.updatedAtMs || 0);
    if (tsMs > 0 && tsMs < earliestMs) earliestMs = tsMs;
    if (tsMs > latestMs) latestMs = tsMs;

    // Extract tagged items
    const body = String(row?.rawBody || '');
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      const match = line.trim().match(TAG_PATTERN);
      if (!match) continue;
      const tag = match[1].toUpperCase();
      const detail = match[2].trim();
      if (!detail) continue;
      if (tag === 'DECISION') taggedDecisions.push(detail);
      else if (tag === 'TASK') taggedTasks.push(detail);
      else if (tag === 'FINDING') taggedFindings.push(detail);
      else if (tag === 'BLOCKER') taggedBlockers.push(detail);
    }
  }

  const senderSummary = Object.entries(senderCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([role, count]) => `${role} (${count})`)
    .join(', ');

  const channelSummary = Object.entries(channelCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([ch, count]) => `${ch} (${count})`)
    .join(', ');

  const iso = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return '-';
    try { return new Date(ms).toISOString(); } catch { return '-'; }
  };

  const lines = [
    `# Session ${sessionNumber} Summary`,
    '',
    `- Generated: ${iso(nowMs)}`,
    `- Session window: ${iso(earliestMs)} to ${iso(latestMs)}`,
    `- Total messages: ${rows.length}`,
    `- Participants: ${senderSummary}`,
    `- Channels: ${channelSummary}`,
  ];

  if (taggedDecisions.length > 0) {
    lines.push('', '## Decisions');
    for (const d of taggedDecisions.slice(0, 20)) {
      lines.push(`- ${d}`);
    }
  }

  if (taggedTasks.length > 0) {
    lines.push('', '## Active Tasks');
    for (const t of taggedTasks.slice(0, 20)) {
      lines.push(`- ${t}`);
    }
  }

  if (taggedFindings.length > 0) {
    lines.push('', '## Findings');
    for (const f of taggedFindings.slice(0, 20)) {
      lines.push(`- ${f}`);
    }
  }

  if (taggedBlockers.length > 0) {
    lines.push('', '## Blockers');
    for (const b of taggedBlockers.slice(0, 10)) {
      lines.push(`- ${b}`);
    }
  }

  // Add recent message excerpts (last 10 non-noise messages for quick context)
  const recentRows = rows.slice(Math.max(0, rows.length - 10));
  if (recentRows.length > 0) {
    lines.push('', '## Recent Activity (last messages)');
    for (const row of recentRows) {
      const sender = String(row?.senderRole || '?');
      const target = String(row?.targetRole || '?');
      const body = String(row?.rawBody || '').replace(/\s+/g, ' ').trim();
      const excerpt = body.length > 120 ? `${body.slice(0, 117)}...` : body;
      lines.push(`- [${sender} -> ${target}] ${excerpt}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Resolve the fallback file path.
 * @returns {string}
 */
function resolveFallbackPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(FALLBACK_RELATIVE_PATH, { forWrite: true });
  }
  const projectRoot = getProjectRoot() || process.cwd();
  return path.join(projectRoot, '.squidrun', FALLBACK_RELATIVE_PATH);
}

/**
 * Write the summary to cognitive memory.
 * @param {string} summaryText
 * @param {number} sessionNumber
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<{ ok: boolean, nodeId?: string, error?: string }>}
 */
async function writeToMemory(summaryText, sessionNumber, options = {}) {
  let api;
  try {
    api = options.cognitiveMemoryApi || new CognitiveMemoryApi();
    const result = await api.ingest({
      category: 'session_summary',
      content: summaryText,
      confidence: 0.7,
      sourceType: 'session-summary',
      sourcePath: `session:${sessionNumber}`,
      title: `Session ${sessionNumber} Summary`,
      heading: 'session_summary',
      isImmune: true,
      metadata: {
        sessionNumber,
        generatedAt: new Date().toISOString(),
        command: 'session-summary',
        ingestedVia: 'hm-session-summary',
      },
    });

    if (!result?.ok || !result?.node) {
      return { ok: false, error: 'ingest did not create a node' };
    }
    return { ok: true, nodeId: result.node.nodeId };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (!options.cognitiveMemoryApi && api) {
      try { api.close(); } catch {}
    }
  }
}

/**
 * Write the summary as a flat file fallback.
 * @param {string} summaryText
 * @param {string} [fallbackPath]
 * @returns {{ ok: boolean, path: string, error?: string }}
 */
function writeFallbackFile(summaryText, fallbackPath) {
  const targetPath = fallbackPath || resolveFallbackPath();
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, summaryText, 'utf8');
    return { ok: true, path: targetPath };
  } catch (err) {
    return { ok: false, path: targetPath, error: err.message };
  }
}

/**
 * Read the fallback summary file.
 * @param {string} [fallbackPath]
 * @returns {string | null}
 */
function readFallbackSummary(fallbackPath) {
  const targetPath = fallbackPath || resolveFallbackPath();
  try {
    if (!fs.existsSync(targetPath)) return null;
    return fs.readFileSync(targetPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Query session summaries from cognitive memory by category.
 * @param {number} limit
 * @param {Record<string, unknown>} [options]
 * @returns {Array<{ nodeId: string, content: string, sessionNumber: number | null, createdAtMs: number }>}
 */
function querySessionSummariesFromMemory(limit = 3, options = {}) {
  let api;
  try {
    api = options.cognitiveMemoryApi || new CognitiveMemoryApi();
    api.init();

    // Direct SQL query against the nodes table for session_summary category
    const rows = api.db.prepare(`
      SELECT node_id, content, metadata_json, created_at_ms
      FROM nodes
      WHERE category = 'session_summary'
        AND (antibody_status IS NULL OR antibody_status = 'clear')
      ORDER BY created_at_ms DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(20, limit)));

    return rows.map((row) => {
      let sessionNumber = null;
      try {
        const meta = JSON.parse(row.metadata_json || '{}');
        sessionNumber = parseSessionNumber(meta.sessionNumber);
      } catch {}
      return {
        nodeId: row.node_id,
        content: row.content || '',
        sessionNumber,
        createdAtMs: Number(row.created_at_ms || 0),
      };
    });
  } catch {
    return [];
  } finally {
    if (!options.cognitiveMemoryApi && api) {
      try { api.close(); } catch {}
    }
  }
}

/**
 * Main entry point: generate and persist session summary.
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<{ ok: boolean, sessionNumber: number | null, messageCount: number, memoryResult: object, fallbackResult: object }>}
 */
async function generateSessionSummary(options = {}) {
  const sessionNumber = parseSessionNumber(options.sessionNumber) || readCurrentSessionNumber();
  if (!sessionNumber) {
    return {
      ok: false,
      sessionNumber: null,
      messageCount: 0,
      error: 'Could not determine session number from app-status.json',
      memoryResult: { ok: false },
      fallbackResult: { ok: false },
    };
  }

  const sessionId = `app-session-${sessionNumber}`;
  const queryFn = typeof options.queryCommsJournal === 'function'
    ? options.queryCommsJournal
    : queryCommsJournalEntries;

  const rawRows = await Promise.resolve(queryFn({
    sessionId,
    order: 'asc',
    limit: options.queryLimit || DEFAULT_QUERY_LIMIT,
  }, {
    dbPath: options.dbPath || null,
  }));

  const rows = filterNoise(Array.isArray(rawRows) ? rawRows : []);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const summaryText = buildSummaryText(rows, sessionNumber, nowMs);

  let memoryResult = { ok: false, skipped: true };
  if (options.dryRun !== true) {
    memoryResult = await writeToMemory(summaryText, sessionNumber, {
      cognitiveMemoryApi: options.cognitiveMemoryApi,
    });
  }

  let fallbackResult = { ok: false, skipped: true };
  if (options.dryRun !== true) {
    fallbackResult = writeFallbackFile(summaryText, options.fallbackPath);
  }

  return {
    ok: true,
    sessionNumber,
    messageCount: rows.length,
    summaryText: options.includeSummaryText === true ? summaryText : undefined,
    memoryResult,
    fallbackResult,
  };
}

function parseArgs(argv) {
  const flags = {};
  const args = Array.isArray(argv) ? argv.slice() : [];
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

async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const result = await generateSessionSummary({
    sessionNumber: flags.session || null,
    dryRun: flags['dry-run'] === true,
    includeSummaryText: flags['dry-run'] === true,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildSummaryText,
  filterNoise,
  generateSessionSummary,
  parseSessionNumber,
  querySessionSummariesFromMemory,
  readCurrentSessionNumber,
  readFallbackSummary,
  resolveFallbackPath,
  writeFallbackFile,
  writeToMemory,
};
