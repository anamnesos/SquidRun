const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildStartupTranscriptContext } = require('../../ui/modules/startup-transcript-context');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const COORD_ROOT = path.join(PROJECT_ROOT, '.squidrun');
const LEGACY_WORKSPACE_ROOT = path.join(PROJECT_ROOT, 'workspace');
const EVIDENCE_LEDGER_DB_PATH = path.join(PROJECT_ROOT, '.squidrun', 'runtime', 'evidence-ledger.db');
const HM_MEMORY_SCRIPT = path.join(PROJECT_ROOT, 'ui', 'scripts', 'hm-memory.js');
const EVENT = process.argv[2];

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
  try {
    const content = fs.readFileSync(resolveCoordFile(path.join('context-snapshots', '5.md')), 'utf8');
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

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

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
    const stdout = e.stdout ? e.stdout.toString().trim() : '';
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch {
        // fallthrough to null
      }
    }
    return null;
  }
}

function buildLedgerSnapshotContext(sessionNum = 0) {
  const snapshotPath = resolveCoordFile(path.join('context-snapshots', '5.md'));
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

function syncSessionToLedger(sessionNum) {
  const snapshotContext = buildLedgerSnapshotContext(Number.parseInt(sessionNum, 10));
  const num = Number.parseInt(snapshotContext.session, 10);

  if (!Number.isInteger(num) || num <= 0) {
    return;
  }

  const sessionId = `s_${num}`;
  queryLedger('session-start', [
    '--number', String(num),
    '--mode', String(snapshotContext.mode || 'PTY'),
    '--session', sessionId,
  ]);

  queryLedger('snapshot', [
    '--session', sessionId,
    '--trigger', 'session_end',
    '--content-json', JSON.stringify(snapshotContext),
  ]);
}

function emitSessionStartContext() {
  try {
    const result = buildStartupTranscriptContext({ projectRoot: PROJECT_ROOT });
    const additionalContext = String(result?.context || '').trim();
    if (!additionalContext) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    }));
  } catch (_) {
    // Best effort only.
  }
}

async function handleEvent() {
  switch (EVENT) {
    case 'SessionStart': {
      const sessionNum = getSessionNumber();
      if (sessionNum > 0) {
        queryLedger('session-start', [
          '--number', String(sessionNum),
          '--mode', 'PTY',
          '--session', `s_${sessionNum}`,
        ]);
      }
      emitSessionStartContext();
      break;
    }

    case 'SessionEnd':
      syncSessionToLedger(getSessionNumber());
      break;

    case 'AfterTool':
      // Intent-file tracking removed. Hook retained for compatibility.
      break;

    default:
      break;
  }
}

handleEvent();
