const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildStartupTranscriptContext } = require('../../ui/modules/startup-transcript-context');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const COORD_ROOT = path.join(PROJECT_ROOT, '.squidrun');
const LEGACY_WORKSPACE_ROOT = path.join(PROJECT_ROOT, 'workspace');
const EVIDENCE_LEDGER_DB_PATH = path.join(PROJECT_ROOT, '.squidrun', 'runtime', 'evidence-ledger.db');
const HM_MEMORY_SCRIPT = path.join(PROJECT_ROOT, 'ui', 'scripts', 'hm-memory.js');
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

function resolveCoordFile(relPath, options = {}) {
  const normalizedRelPath = String(relPath || '').replace(/^[\\/]+/, '').replace(/[\\/]+/g, path.sep);
  const preferred = path.join(COORD_ROOT, normalizedRelPath);
  const legacy = path.join(LEGACY_WORKSPACE_ROOT, normalizedRelPath);

  if (options.forWrite !== true) {
    if (fs.existsSync(preferred)) return preferred;
    if (fs.existsSync(legacy)) return legacy;
  }

  return preferred;
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function parseSessionNumberFromText(content) {
  const text = String(content || '');
  const patterns = [
    /Session:\s*(\d+)/i,
    /\|\s*Session\s+(\d+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }

  return 0;
}

function getSessionNumberFromSnapshot() {
  const snapshotPath = resolveCoordFile(path.join('context-snapshots', '1.md'));
  try {
    const content = fs.readFileSync(snapshotPath, 'utf8');
    return parseSessionNumberFromText(content);
  } catch {
    return 0;
  }
}

function getSessionNumberFromLedger() {
  if (typeof DatabaseSync !== 'function') return 0;
  if (!fs.existsSync(EVIDENCE_LEDGER_DB_PATH)) return 0;

  let db = null;
  try {
    db = new DatabaseSync(EVIDENCE_LEDGER_DB_PATH);
    const row = db.prepare(`
      SELECT MAX(session_number) AS latest
      FROM ledger_sessions
      WHERE session_number IS NOT NULL
        AND session_number > 0
    `).get();
    const parsed = Number.parseInt(row?.latest, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  } finally {
    try {
      db?.close?.();
    } catch {
      // best effort
    }
  }
}

function getSessionNumber() {
  const ledgerSession = getSessionNumberFromLedger();
  const snapshotSession = getSessionNumberFromSnapshot();
  return Math.max(ledgerSession, snapshotSession, 0);
}

/**
 * Query the Evidence Ledger via hm-memory.js CLI.
 * Uses execFileSync to avoid shell quoting issues on Windows.
 * Returns parsed JSON or null on failure.
 */
function queryLedger(command, args = []) {
  try {
    const result = execFileSync('node', [HM_MEMORY_SCRIPT, command, '--timeout', '3000', ...args], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return JSON.parse(result);
  } catch (e) {
    // hm-memory.js exits with code 1 for {ok: false} results (e.g., conflict on session-start).
    // Try to parse stdout — the JSON result may still be useful.
    const stdout = e.stdout ? e.stdout.toString().trim() : '';
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch {}
    }
    process.stderr.write(`[arch-hooks] queryLedger(${command}) FAILED: ${e.message.slice(0, 100)}\n`);
    return null;
  }
}

function formatTeamStatusFromLedger(ctx) {
  const team = (ctx && typeof ctx.team === 'object' && !Array.isArray(ctx.team))
    ? ctx.team
    : {};
  const entries = Object.entries(team)
    .map(([paneId, role]) => [String(paneId).trim(), String(role || '').trim()])
    .filter(([paneId, role]) => paneId.length > 0 && role.length > 0)
    .sort((a, b) => Number(a[0]) - Number(b[0]));

  if (entries.length === 0) {
    return ['- Team status unavailable in Evidence Ledger'];
  }

  return entries.map(([paneId, role]) => `- Pane ${paneId}: ${role}`);
}

/**
 * Format ledger context JSON as markdown for Claude's additionalContext.
 */
function formatLedgerContext(ctx) {
  const lines = [];
  lines.push('## Context Restoration (auto-generated)');
  lines.push(`Generated: ${new Date().toISOString()} | Session ${ctx.session || '?'} | Source: evidence-ledger`);
  lines.push('');
  lines.push('### Team Status');
  lines.push(...formatTeamStatusFromLedger(ctx));
  lines.push('');

  const completions = Array.isArray(ctx.completed) ? ctx.completed : [];
  if (completions.length > 0) {
    lines.push('### Recent Completions');
    for (const c of completions.slice(0, 10)) {
      lines.push(`- ${c}`);
    }
    lines.push('');
  }

  const issues = ctx.known_issues && typeof ctx.known_issues === 'object' ? ctx.known_issues : {};
  const issueEntries = Object.entries(issues);
  if (issueEntries.length > 0) {
    lines.push('### Known Issues');
    for (const [k, v] of issueEntries.slice(0, 8)) {
      lines.push(`- ${k}: ${v}`);
    }
    lines.push('');
  }

  const roadmap = Array.isArray(ctx.not_yet_done) ? ctx.not_yet_done : [];
  if (roadmap.length > 0) {
    lines.push('### Roadmap');
    for (const r of roadmap.slice(0, 5)) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }

  const directives = Array.isArray(ctx.important_notes) ? ctx.important_notes : [];
  if (directives.length > 0) {
    lines.push('### Key Directives');
    for (const d of directives.slice(0, 8)) {
      lines.push(`- ${d}`);
    }
    lines.push('');
  }

  const stats = ctx.stats && typeof ctx.stats === 'object' ? ctx.stats : {};
  if (stats.test_suites || stats.tests_passed) {
    lines.push('### Stats');
    lines.push(`Tests: ${stats.test_suites || '?'} suites, ${stats.tests_passed || '?'} passed`);
    lines.push('');
  }

  return lines.join('\n');
}

function appendTranscriptStartupContext(baseContext) {
  try {
    const transcriptContext = buildStartupTranscriptContext({ projectRoot: PROJECT_ROOT });
    const transcriptBlock = String(transcriptContext?.context || '').trim();
    if (!transcriptBlock) return baseContext;
    return `${baseContext}\n\n${transcriptBlock}`;
  } catch (error) {
    process.stderr.write(`[arch-hooks] transcript startup context failed: ${error.message}\n`);
    return baseContext;
  }
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildLedgerSnapshotContext(sessionNum = 0) {
  const snapshotPath = resolveCoordFile(path.join('context-snapshots', '1.md'));
  const fallbackSession = Number.isInteger(sessionNum) && sessionNum > 0 ? sessionNum : getSessionNumber();

  try {
    const raw = fs.readFileSync(snapshotPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const completedLine = lines.find((line) => /^Completed:\s*/i.test(line));
    const nextLine = lines.find((line) => /^Next:\s*/i.test(line));
    const testsLine = lines.find((line) => /^Tests:\s*/i.test(line));
    const parsedSession = parseSessionNumberFromText(raw);
    const testMatch = testsLine ? testsLine.match(/(\d+)\s+suites,\s*(\d+)\s+tests/i) : null;

    return {
      session: parsedSession || fallbackSession || 0,
      mode: 'PTY',
      completed: completedLine ? parseList(completedLine.replace(/^Completed:\s*/i, '')) : [],
      roadmap: nextLine ? parseList(nextLine.replace(/^Next:\s*/i, '')) : [],
      not_yet_done: nextLine ? parseList(nextLine.replace(/^Next:\s*/i, '')) : [],
      stats: testMatch
        ? {
            test_suites: Number.parseInt(testMatch[1], 10) || 0,
            tests_passed: Number.parseInt(testMatch[2], 10) || 0,
          }
        : {},
      source: 'context-snapshot',
      source_path: snapshotPath,
      timestamp: new Date().toISOString(),
    };
  } catch {
    return {
      session: fallbackSession || 0,
      mode: 'PTY',
      completed: [],
      roadmap: [],
      not_yet_done: [],
      stats: {},
      source: 'ledger-session',
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Snapshot context state to the Evidence Ledger.
 * Ensures the session exists first, then saves a context snapshot payload.
 */
function syncSessionToLedger(sessionNum) {
  const snapshotContext = buildLedgerSnapshotContext(Number.parseInt(sessionNum, 10));
  const num = Number.parseInt(snapshotContext.session, 10);

  if (!Number.isInteger(num) || num <= 0) {
    process.stderr.write('[arch-hooks] syncSessionToLedger: invalid session number\n');
    return;
  }

  const sessionId = `s_${num}`;

  const startResult = queryLedger('session-start', [
    '--number', String(num),
    '--mode', String(snapshotContext.mode || 'PTY'),
    '--session', sessionId,
  ]);
  process.stderr.write(`[arch-hooks] session-start(${sessionId}): ${JSON.stringify(startResult)}\n`);

  const contentJson = JSON.stringify(snapshotContext);
  process.stderr.write(`[arch-hooks] snapshot content length: ${contentJson.length}\n`);
  const snapResult = queryLedger('snapshot', [
    '--session', sessionId,
    '--trigger', 'session_end',
    '--content-json', contentJson,
  ]);
  process.stderr.write(`[arch-hooks] snapshot(${sessionId}): ${JSON.stringify(snapResult)}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    const timer = setTimeout(() => { process.stdin.destroy(); done(input); }, 2000);
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); done(input); });
  });
}

async function main() {
  const input = await readStdin();
  let data = {};
  try { data = JSON.parse(input); } catch (e) { /* no stdin data */ }

  const event = data.hook_event_name || process.argv[2];

  switch (event) {
    case 'SessionStart': {
      const sessionNum = getSessionNumber();
      let additionalContext = null;

      // Priority 1: Evidence Ledger (persistent cross-session memory)
      const ledgerCtx = queryLedger('context', ['--prefer-snapshot', '--timeout', '3000']);
      if (ledgerCtx && typeof ledgerCtx === 'object' && ledgerCtx.ok !== false) {
        if (ledgerCtx.session && ledgerCtx.session >= sessionNum - 1) {
          additionalContext = formatLedgerContext(ledgerCtx);
        }
      }

      // Priority 2: context snapshot markdown
      if (!additionalContext) {
        const snapshotPath = resolveCoordFile(path.join('context-snapshots', '1.md'));
        try {
          const snapshot = fs.readFileSync(snapshotPath, 'utf8');
          if (snapshot.trim()) {
            additionalContext = snapshot;
          }
        } catch {
          // Snapshot not available
        }
      }

      // Priority 3: minimal fallback when ledger + snapshot are unavailable
      if (!additionalContext) {
        additionalContext = [
          '## Context Restoration (auto-generated)',
          `Generated: ${new Date().toISOString()} | Session ${sessionNum || '?'} | Source: fallback`,
          '',
          'Evidence Ledger context unavailable; no snapshot context found.',
        ].join('\n');
      }

      additionalContext = appendTranscriptStartupContext(additionalContext);

      const output = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext,
        }
      };
      process.stdout.write(JSON.stringify(output));
      break;
    }

    case 'SessionEnd': {
      syncSessionToLedger(getSessionNumber());
      break;
    }

    case 'PostToolUse': {
      // Intent-file tracking removed. Hook retained for compatibility.
      break;
    }

    case 'PreCompact': {
      syncSessionToLedger(getSessionNumber());

      const markerPath = resolveCoordFile(path.join('context-snapshots', '1.compacted'), { forWrite: true });
      try {
        ensureParentDir(markerPath);
        fs.writeFileSync(markerPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          messageCount: data.transcript?.length || 0,
        }));
      } catch {
        // Non-critical - ignore marker write failures
      }
      break;
    }
  }
}

main();
