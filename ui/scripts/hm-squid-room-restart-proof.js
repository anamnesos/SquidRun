#!/usr/bin/env node
/**
 * Build and verify Squid Room restart-survival proof without visual pane watching.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { getProjectRoot, resolveCoordPath } = require('../config');
const log = require('../modules/logger');
const {
  buildArmStateProjection,
  closeArmStateProjectionStores,
} = require('../modules/main/arm-state-projection');
const {
  closeCommsJournalStores,
  queryCommsJournalEntries,
} = require('../modules/main/comms-journal');

const SCHEMA = 'squidrun.squid_room.restart_survival_proof.v0';
const DEFAULT_BASELINE_PATH = resolveCoordPath('runtime/squid-room-restart-survival-baseline.json', { forWrite: true });
const DEFAULT_PROOF_PATH = resolveCoordPath('runtime/squid-room-restart-survival-proof.json', { forWrite: true });
const DEFAULT_STREAMING_FIT_PROOF_PATH = resolveCoordPath('runtime/squid-room-streaming-fit-proof.json', { forWrite: true });

const REQUIRED_MAIN_PANES = ['1', '2', '3'];
const TRUSTQUOTE_CWD = 'D:/projects/TrustQuote';
const REQUIRED_ARMS = [
  { paneId: 'trustquote-lead', role: 'trustquote-lead', cwd: TRUSTQUOTE_CWD },
  { paneId: 'trustquote-schedule-dispatch', role: 'trustquote-schedule-dispatch', cwd: TRUSTQUOTE_CWD },
  { paneId: 'trustquote-app', role: 'trustquote-app', cwd: TRUSTQUOTE_CWD },
  { paneId: 'trustquote-invoice', role: 'trustquote-invoice', cwd: TRUSTQUOTE_CWD },
];
const REQUIRED_PANES = [...REQUIRED_MAIN_PANES, ...REQUIRED_ARMS.map((arm) => arm.paneId)];

const DEFAULT_TAIL_CHARS = 700;
const DEFAULT_MIN_BODY_CHARS = 20;
const DEFAULT_EVENT_WINDOW_SEC = 30;
const DEFAULT_RECEIPT_WAIT_MS = 10000;
const RECEIPT_POLL_MS = 500;
const RESIZE_STEADY_STATE_LIMIT_PER_SEC = 1;

function usage() {
  return [
    'Usage:',
    '  node ui/scripts/hm-squid-room-restart-proof.js baseline [--json] [--out <path>]',
    '  node ui/scripts/hm-squid-room-restart-proof.js verify [--json] [--baseline <path>] [--out <path>] [--allow-same-session]',
    '  node ui/scripts/hm-squid-room-restart-proof.js streaming-fit [--json] [--out <path>]   (Bug A: fit-coherence + redraw outcome)',
    '',
    'The intended gate flow is:',
    '  1. Run baseline before the restart.',
    '  2. Restart once after the comms fix is loaded.',
    '  3. Run verify after the app settles.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    command: argv[2] || 'verify',
    json: false,
    baselinePath: DEFAULT_BASELINE_PATH,
    outPath: null,
    allowSameSession: false,
    allowNoBaseline: false,
    commsRowsPath: null,
    eventWindowSec: DEFAULT_EVENT_WINDOW_SEC,
    receiptWaitMs: DEFAULT_RECEIPT_WAIT_MS,
  };

  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--baseline') {
      args.baselinePath = argv[++index];
    } else if (arg === '--out') {
      args.outPath = argv[++index];
    } else if (arg === '--allow-same-session') {
      args.allowSameSession = true;
    } else if (arg === '--allow-no-baseline') {
      args.allowNoBaseline = true;
    } else if (arg === '--comms-rows') {
      args.commsRowsPath = argv[++index];
    } else if (arg === '--event-window-sec') {
      args.eventWindowSec = Number(argv[++index]);
    } else if (arg === '--receipt-wait-ms') {
      args.receiptWaitMs = Number(argv[++index]);
    } else if (arg === '--help' || arg === '-h') {
      args.command = 'help';
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (fallback !== null) return fallback;
    throw error;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function parseIsoMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePathText(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

function pathsMatch(actual, expected) {
  return normalizePathText(actual) === normalizePathText(expected);
}

function stripPathToken(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/[)\].,;]+$/g, '');
}

function stripAnsi(text) {
  return String(text || '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function normalizeBodyText(text) {
  return stripAnsi(text).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function summarizeTerminal(terminal, options = {}) {
  const tailChars = Number(options.tailChars || DEFAULT_TAIL_CHARS);
  const rawScrollback = Array.isArray(terminal?.scrollback)
    ? terminal.scrollback.join('')
    : String(terminal?.scrollback || '');
  const bodyText = normalizeBodyText(rawScrollback);
  const tailText = bodyText.slice(-tailChars);
  const lastActivityMs = Number(terminal?.lastActivity || 0);
  const lastInputMs = Number(terminal?.lastInputTime || 0);

  return {
    paneId: String(terminal?.paneId || ''),
    cwd: terminal?.cwd || null,
    alive: Boolean(terminal?.alive),
    dryRun: Boolean(terminal?.dryRun),
    printableChars: bodyText.length,
    hasRenderableBody: bodyText.length >= Number(options.minBodyChars || DEFAULT_MIN_BODY_CHARS),
    bodyText,
    bodySha256: sha256(bodyText),
    tailChars: tailText.length,
    tailSha256: sha256(tailText),
    tailText,
    lastActivityMs,
    lastInputMs,
  };
}

function summarizeSessionState(sessionState, options = {}) {
  const terminals = Array.isArray(sessionState?.terminals) ? sessionState.terminals : [];
  const byPane = {};
  for (const terminal of terminals) {
    const summary = summarizeTerminal(terminal, options);
    if (summary.paneId) {
      byPane[summary.paneId] = summary;
    }
  }
  return {
    savedAt: sessionState?.savedAt || null,
    daemonPid: sessionState?.daemonPid || null,
    panes: byPane,
  };
}

function getSessionScopeForSquidRoom(appStatus) {
  const session = Number(appStatus?.session || 0);
  return session ? `app-session-${session}:squid-room` : null;
}

function getBaseAppSessionScope(appStatus) {
  const session = Number(appStatus?.session || 0);
  return session ? `app-session-${session}` : null;
}

function getExpectedWindowScopes(appStatus) {
  return [getBaseAppSessionScope(appStatus), getSessionScopeForSquidRoom(appStatus)].filter(Boolean);
}

function getArmProjectionSession(appStatus) {
  const session = Number(appStatus?.session || 0);
  return session ? `app-session-${session}:trustquote` : null;
}

function getReadyPanes(appStatus) {
  const topLevel = Array.isArray(appStatus?.readyPanes) ? appStatus.readyPanes : [];
  const paneHost = Array.isArray(appStatus?.paneHost?.readyPanes) ? appStatus.paneHost.readyPanes : [];
  return topLevel.length ? topLevel : paneHost;
}

function getGitHead(projectRoot = getProjectRoot()) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    return null;
  }
}

function readLogLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch (error) {
    return [];
  }
}

function parseLineTimestampMs(line) {
  const bracket = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
  if (bracket) return parseIsoMs(bracket[1]);
  const iso = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
  if (iso) return parseIsoMs(iso[1]);
  return 0;
}

function parseDaemonEvents(lines, sinceMs = 0, nowMs = Date.now(), eventWindowSec = DEFAULT_EVENT_WINDOW_SEC) {
  const eventsByPane = {};
  for (const line of lines) {
    const timestampMs = parseLineTimestampMs(line);
    if (timestampMs && timestampMs < sinceMs) continue;
    const received = line.match(/Received:\s*([a-z-]+)\s+from\s+pane\s+([^\s]+)/i);
    if (!received) continue;
    const action = received[1];
    const paneId = received[2];
    if (!eventsByPane[paneId]) {
      eventsByPane[paneId] = {};
    }
    eventsByPane[paneId][action] = (eventsByPane[paneId][action] || 0) + 1;
    eventsByPane[paneId].total = (eventsByPane[paneId].total || 0) + 1;
    if (timestampMs) {
      const trailingKey = nowMs - timestampMs <= eventWindowSec * 1000
        ? `${action}_trailing`
        : null;
      if (trailingKey) {
        eventsByPane[paneId][trailingKey] = (eventsByPane[paneId][trailingKey] || 0) + 1;
      }
    }
  }
  return eventsByPane;
}

function parseBusTraceLines(lines, sinceMs = 0) {
  const byPane = {};
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      continue;
    }
    const timestampMs = Number(row.timestampMs || parseIsoMs(row.timestamp));
    if (timestampMs && timestampMs < sinceMs) continue;
    const paneId = String(row.paneId || row.payload?.paneId || '');
    const event = String(row.event || row.type || '');
    if (!paneId || !event) continue;
    if (!byPane[paneId]) byPane[paneId] = {};
    byPane[paneId][event] = (byPane[paneId][event] || 0) + 1;
    byPane[paneId].total = (byPane[paneId].total || 0) + 1;
  }
  return byPane;
}

// Bug A: parse renderer-side fit telemetry (terminal-fit-telemetry.jsonl). Returns the
// LATEST settle record per pane — fit-coherence + paint outcome (painted boolean).
function parseFitTelemetryLines(lines, sinceMs = 0) {
  const byPane = {};
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Number(row.ts) || 0;
    if (sinceMs && ts && ts < sinceMs) continue;
    const paneId = String(row.paneId || '');
    if (!paneId) continue;
    const prev = byPane[paneId];
    if (!prev || ts >= (Number(prev.ts) || 0)) {
      byPane[paneId] = row;
    }
  }
  return byPane;
}

function buildEventRates({ daemonEventsByPane, busEventsByPane, sinceMs, nowMs, eventWindowSec }) {
  const elapsedSec = Math.max((Number(nowMs || Date.now()) - Number(sinceMs || 0)) / 1000, 1);
  const trailingWindowSec = Math.max(Number(eventWindowSec || DEFAULT_EVENT_WINDOW_SEC), 1);
  const panes = {};
  for (const paneId of new Set([
    ...Object.keys(daemonEventsByPane || {}),
    ...Object.keys(busEventsByPane || {}),
    ...REQUIRED_PANES,
  ])) {
    const daemon = daemonEventsByPane?.[paneId] || {};
    const bus = busEventsByPane?.[paneId] || {};
    panes[paneId] = {
      daemonCounts: daemon,
      daemonResizePerSec: Number(((daemon.resize || 0) / elapsedSec).toFixed(3)),
      daemonResizeTrailingPerSec: Number(((daemon.resize_trailing || 0) / trailingWindowSec).toFixed(3)),
      busCounts: bus,
    };
  }
  return {
    sinceMs,
    nowMs,
    elapsedSec: Number(elapsedSec.toFixed(3)),
    trailingWindowSec,
    panes,
  };
}

function extractField(rawBody, fieldName) {
  const pattern = new RegExp(`${fieldName}=([^;\\r\\n]+)`);
  const match = String(rawBody || '').match(pattern);
  return match ? match[1].trim().split(/\s+/)[0].replace(/[.,]+$/g, '') : null;
}

function extractBinding(rawBody, fieldName) {
  const pattern = new RegExp(`\\b${fieldName}\\s*=\\s*([^,;\\r\\n]+)`, 'i');
  const match = String(rawBody || '').match(pattern);
  return match ? match[1].trim().split(/\s+/)[0].replace(/[.,]+$/g, '') : null;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return asObject(parsed);
  } catch {
    return {};
  }
}

function getRowMetadata(row = {}) {
  return parseJsonObject(row.metadata || row.meta || row.metadata_json || row.metadataJson);
}

function extractMetadataValue(metadata = {}, candidates = []) {
  const direct = asObject(metadata);
  const envelope = asObject(direct.envelope);
  for (const key of candidates) {
    if (direct[key] !== undefined && direct[key] !== null && String(direct[key]).trim()) {
      return String(direct[key]).trim();
    }
    if (envelope[key] !== undefined && envelope[key] !== null && String(envelope[key]).trim()) {
      return String(envelope[key]).trim();
    }
  }
  return null;
}

function extractMetadataRole(metadata = {}, kind = 'sender') {
  const direct = asObject(metadata);
  const envelope = asObject(direct.envelope);
  const directValue = asObject(direct[kind]).role || direct[`${kind}Role`] || direct[`${kind}_role`];
  const envelopeValue = asObject(envelope[kind]).role || envelope[`${kind}Role`] || envelope[`${kind}_role`];
  return (directValue || envelopeValue || null);
}

function normalizeArmIdentity(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  const arm = REQUIRED_ARMS.find((candidate) => (
    candidate.role === text
    || candidate.paneId === text
  ));
  return arm ? arm.role : null;
}

function extractCwd(rawBody, expectedCwd = null) {
  const envValue = extractField(rawBody, 'SQUIDRUN_WORKING_DIR');
  if (envValue) return stripPathToken(envValue);
  const body = String(rawBody || '');
  const cwdMatch = body.match(/cwd=([A-Za-z]:[\\/][^\s;|]+)/i);
  if (cwdMatch) return stripPathToken(cwdMatch[1]);
  if (expectedCwd) {
    const pathMentions = body.match(/[A-Za-z]:[\\/][^\s;|]+/g) || [];
    const expectedMention = pathMentions
      .map(stripPathToken)
      .find((candidate) => pathsMatch(candidate, expectedCwd));
    if (expectedMention) return expectedMention;
  }
  const footerMatch = body.match(/\[CURRENT PROJECT\][^\r\n|]*\|\s*path=([A-Za-z]:[\\/][^\r\n]+)/i);
  if (footerMatch) return stripPathToken(footerMatch[1]);
  return null;
}

function extractProjectCwdFromMetadata(metadata = {}, expectedCwd = null) {
  const direct = asObject(metadata);
  const envelope = asObject(direct.envelope);
  const candidates = [
    asObject(direct.project).path,
    asObject(envelope.project).path,
    direct.projectPath,
    direct.project_path,
    envelope.projectPath,
    envelope.project_path,
  ];
  for (const candidate of candidates) {
    const cwd = stripPathToken(candidate || '');
    if (!cwd) continue;
    if (!expectedCwd || pathsMatch(cwd, expectedCwd)) return cwd;
  }
  return null;
}

function normalizeCommsHistoryPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (Array.isArray(payload?.entries)) return payload.entries;
  return [];
}

function hasAllArmReceipts(rows, sessionScope) {
  const receipts = parseArmReceipts(rows, { sessionScope });
  return REQUIRED_ARMS.every((arm) => receipts[arm.paneId]);
}

function queryCommsRowsFromLedger(sessionScope, limit = 200) {
  try {
    return queryCommsJournalEntries({
      sessionId: sessionScope,
      order: 'asc',
      limit,
    });
  } catch (error) {
    return null;
  } finally {
    if (typeof closeCommsJournalStores === 'function') {
      closeCommsJournalStores();
    }
  }
}

function queryCommsRowsFromCli(scriptPath, sessionScope) {
  const output = execFileSync(process.execPath, [
    scriptPath,
    'history',
    '--scope',
    'squid-room',
    '--session',
    sessionScope,
    '--last',
    '200',
    '--json',
  ], {
    cwd: getProjectRoot(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  });
  return normalizeCommsHistoryPayload(JSON.parse(output));
}

function readCommsRows(options = {}) {
  if (options.commsRowsPath) {
    return normalizeCommsHistoryPayload(readJson(options.commsRowsPath, []));
  }

  const sessionScope = options.sessionScope;
  if (!sessionScope) return [];

  const scriptPath = path.resolve(__dirname, 'hm-comms.js');
  const waitMs = Math.max(Number(options.receiptWaitMs || 0), 0);
  const deadline = Date.now() + waitMs;
  let lastRows = [];

  try {
    do {
      const ledgerRows = queryCommsRowsFromLedger(sessionScope);
      lastRows = Array.isArray(ledgerRows)
        ? ledgerRows
        : queryCommsRowsFromCli(scriptPath, sessionScope);
      if (hasAllArmReceipts(lastRows, sessionScope)) return lastRows;
      if (Date.now() >= deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RECEIPT_POLL_MS);
    } while (true);
    return lastRows;
  } catch (error) {
    return lastRows;
  }
}

function isActiveCurrentLane(currentLane) {
  if (!currentLane || typeof currentLane !== 'object') return false;
  if (currentLane.status === 'active') return true;
  if (currentLane.activeLane || currentLane.activeLanePresent) return true;
  if (currentLane.objective) return true;
  const activeWork = currentLane.activeWorkReconciliation || {};
  return Array.isArray(activeWork.activeWorkItemIds) && activeWork.activeWorkItemIds.length > 0;
}

function parseArmReceipts(rows, options = {}) {
  const expectedSessionScope = options.sessionScope || null;
  const receipts = {};
  const sortedRows = [...(rows || [])].sort((a, b) => Number(a.rowId || a.row_id || 0) - Number(b.rowId || b.row_id || 0));

  for (const row of sortedRows) {
    const metadata = getRowMetadata(row);
    const rawBody = row.rawBody || row.raw_body || row.body || row.message || '';
    const rowStatus = String(row.status || '').toLowerCase();
    const rowSessionScope = row.session_id
      || row.sessionId
      || extractMetadataValue(metadata, ['session_id', 'sessionId'])
      || null;
    const senderRole = normalizeArmIdentity(
      row.senderRole
      || row.sender_role
      || row.sender
      || extractMetadataRole(metadata, 'sender')
    );
    const routedSenderMatchesSession = rowStatus === 'routed'
      && senderRole
      && (!expectedSessionScope || rowSessionScope === expectedSessionScope);
    const role = normalizeArmIdentity(
      extractField(rawBody, 'SQUIDRUN_ROLE')
      || extractBinding(rawBody, 'role')
      || (routedSenderMatchesSession ? senderRole : null)
    );
    const paneId = normalizeArmIdentity(
      extractField(rawBody, 'SQUIDRUN_PANE_ID')
      || extractBinding(rawBody, 'pane')
      || role
      || (routedSenderMatchesSession ? senderRole : null)
    );
    const sessionScope = extractField(rawBody, 'SQUIDRUN_SESSION_SCOPE_ID')
      || extractBinding(rawBody, 'session')
      || rowSessionScope
      || null;
    const windowKey = extractField(rawBody, 'SQUIDRUN_WINDOW_KEY')
      || extractBinding(rawBody, 'window')
      || row.scope
      || row.windowKey
      || null;
    const expectedArm = REQUIRED_ARMS.find((arm) => arm.paneId === paneId || arm.role === role);
    if (!expectedArm) continue;
    if (expectedSessionScope && sessionScope !== expectedSessionScope) continue;
    const cwd = extractCwd(rawBody, expectedArm.cwd)
      || extractProjectCwdFromMetadata(metadata, expectedArm.cwd);
    receipts[expectedArm.paneId] = {
      rowId: row.rowId || row.row_id || null,
      timestampMs: Number(
        row.timestampMs
        || row.timestamp_ms
        || row.brokeredAtMs
        || row.brokered_at_ms
        || row.sentAtMs
        || row.sent_at_ms
        || row.updatedAtMs
        || row.updated_at_ms
        || parseIsoMs(row.timestamp)
      ),
      sender: row.sender || row.senderRole || row.sender_role || senderRole || null,
      role,
      paneId,
      sessionScope,
      windowKey,
      cwd,
      status: row.status || null,
    };
  }

  return receipts;
}

function getArmProjection(appStatus, override) {
  if (override) return override;
  const sessionId = getArmProjectionSession(appStatus);
  if (!sessionId) return null;
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };
  try {
    log.setLevel('warn');
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    return buildArmStateProjection({
      appRoomId: 'trustquote',
      sessionId,
    });
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      error: error.message,
      sessionId,
    };
  } finally {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    if (typeof closeArmStateProjectionStores === 'function') {
      closeArmStateProjectionStores();
    }
  }
}

function collectEvidence(options = {}) {
  const nowMs = Date.now();
  const appStatusPath = options.appStatusPath || resolveCoordPath('app-status.json');
  const windowStatePath = options.windowStatePath || resolveCoordPath('runtime/squid-room-window-state.json');
  const sessionStatePath = options.sessionStatePath || resolveCoordPath('runtime/session-state.json');
  const daemonLogPath = options.daemonLogPath || resolveCoordPath('runtime/daemon.log');
  const busTracePath = options.busTracePath || resolveCoordPath('runtime/bus-reliability-trace.jsonl');
  const fitTelemetryPath = options.fitTelemetryPath || resolveCoordPath('runtime/terminal-fit-telemetry.jsonl');
  const currentLanePath = options.currentLanePath || resolveCoordPath('handoffs/current-lane.json');

  const appStatus = readJson(appStatusPath, {});
  const windowState = readJson(windowStatePath, {});
  const sessionState = readJson(sessionStatePath, {});
  const currentLane = readJson(currentLanePath, {});
  const sessionScope = getSessionScopeForSquidRoom(appStatus);
  const startedMs = parseIsoMs(appStatus?.started);
  const eventWindowSec = options.eventWindowSec || DEFAULT_EVENT_WINDOW_SEC;
  const daemonEventsByPane = parseDaemonEvents(readLogLines(daemonLogPath), startedMs, nowMs, eventWindowSec);
  const busEventsByPane = parseBusTraceLines(readLogLines(busTracePath), startedMs);
  const fitTelemetryByPane = parseFitTelemetryLines(readLogLines(fitTelemetryPath), startedMs);
  const commsRows = readCommsRows({
    sessionScope,
    commsRowsPath: options.commsRowsPath,
    receiptWaitMs: options.receiptWaitMs,
  });

  return {
    schema: SCHEMA,
    generatedAt: new Date(nowMs).toISOString(),
    nowMs,
    projectRoot: getProjectRoot(),
    gitHead: getGitHead(),
    paths: {
      appStatusPath,
      windowStatePath,
      sessionStatePath,
      daemonLogPath,
      busTracePath,
      fitTelemetryPath,
      currentLanePath,
    },
    fitTelemetryByPane,
    appStatus,
    windowState,
    currentLane,
    sessionScope,
    terminalSummary: summarizeSessionState(sessionState, {
      tailChars: options.tailChars || DEFAULT_TAIL_CHARS,
      minBodyChars: options.minBodyChars || DEFAULT_MIN_BODY_CHARS,
    }),
    armProjection: getArmProjection(appStatus, options.armProjection),
    commsRows,
    armReceipts: parseArmReceipts(commsRows, { sessionScope }),
    eventRates: buildEventRates({
      daemonEventsByPane,
      busEventsByPane,
      sinceMs: startedMs,
      nowMs,
      eventWindowSec,
    }),
  };
}

function buildBaselineSnapshot(evidence) {
  return {
    schema: SCHEMA,
    kind: 'baseline',
    generatedAt: evidence.generatedAt,
    gitHead: evidence.gitHead,
    appStatus: {
      session: evidence.appStatus?.session || null,
      started: evidence.appStatus?.started || null,
      readyPanes: getReadyPanes(evidence.appStatus),
      paneHost: {
        degraded: Boolean(evidence.appStatus?.paneHost?.degraded),
        hiddenModeEnabled: Boolean(evidence.appStatus?.paneHost?.hiddenModeEnabled),
      },
    },
    sessionScope: evidence.sessionScope,
    windowState: evidence.windowState || {},
    currentLane: evidence.currentLane || {},
    terminalSummary: evidence.terminalSummary,
    armProjection: evidence.armProjection,
    armReceipts: evidence.armReceipts,
    eventRates: evidence.eventRates,
  };
}

function check(status, id, why, evidence = {}, hard = true) {
  return { id, status, hard, why, evidence };
}

function statusRank(status) {
  if (status === 'FAIL') return 3;
  if (status === 'WARN') return 2;
  if (status === 'UNKNOWN') return 1;
  return 0;
}

function latestOverallStatus(checks) {
  if (checks.some((entry) => entry.hard && entry.status === 'FAIL')) return 'FAIL';
  if (checks.some((entry) => entry.status === 'WARN')) return 'WARN';
  if (checks.some((entry) => entry.status === 'UNKNOWN')) return 'UNKNOWN';
  return 'PASS';
}

function verifySessionBump(baseline, evidence, options) {
  const before = Number(baseline?.appStatus?.session || 0);
  const after = Number(evidence.appStatus?.session || 0);
  const startedBefore = baseline?.appStatus?.started || null;
  const startedAfter = evidence.appStatus?.started || null;
  if (!before || !after) {
    return check('FAIL', 'session_bump', 'Missing app session values.', { before, after });
  }
  if (after > before || (startedBefore && startedAfter && startedBefore !== startedAfter)) {
    return check('PASS', 'session_bump', 'App session advanced or app started timestamp changed.', {
      before,
      after,
      startedBefore,
      startedAfter,
    });
  }
  if (options.allowSameSession) {
    return check('WARN', 'session_bump', 'Same app session accepted only because --allow-same-session was used.', {
      before,
      after,
      startedBefore,
      startedAfter,
    }, false);
  }
  return check('FAIL', 'session_bump', 'Post-run app session did not advance from baseline.', {
    before,
    after,
      startedBefore,
      startedAfter,
  });
}

function verifyWindowRestore(baseline, evidence) {
  const baselineOpen = Boolean(baseline?.windowState?.open);
  const current = evidence.windowState || {};
  const appStartedMs = parseIsoMs(evidence.appStatus?.started);
  const updatedMs = parseIsoMs(current.updatedAt);
  const expectedScopes = getExpectedWindowScopes(evidence.appStatus);

  if (!current.open) {
    return check('FAIL', 'squid_room_window_restore', 'Squid Room is not open after restart; use on-demand open before proving the surface.', {
      baselineOpen,
      open: Boolean(current.open),
      reason: current.reason || null,
      expectedCommand: 'node ui/scripts/hm-app.js open-squid-room',
    });
  }

  if (current.windowKey !== 'squid-room') {
    return check('FAIL', 'squid_room_window_restore', 'Window state is open but not keyed to squid-room.', current);
  }

  if (expectedScopes.length && current.sessionScopeId && !expectedScopes.includes(current.sessionScopeId)) {
    return check('FAIL', 'squid_room_window_restore', 'Window state session scope does not match the current app session.', {
      actual: current.sessionScopeId,
      expected: expectedScopes,
    });
  }

  if (baselineOpen && current.reason === 'startup_restore' && updatedMs >= appStartedMs) {
    return check('PASS', 'squid_room_window_restore', 'Squid Room auto-reopened from persisted window state after this app start.', {
      reason: current.reason,
      updatedAt: current.updatedAt,
      appStarted: evidence.appStatus?.started,
      sessionScopeId: current.sessionScopeId || null,
    });
  }

  if (!baselineOpen) {
    return check('WARN', 'squid_room_window_restore', 'Baseline did not have Squid Room open, so the proof class is on-demand open rather than auto-restore.', {
      reason: current.reason || null,
      updatedAt: current.updatedAt || null,
    }, false);
  }

  return check('WARN', 'squid_room_window_restore', 'Squid Room is open, but this run does not prove startup_restore ownership.', {
    reason: current.reason || null,
    updatedAt: current.updatedAt || null,
    appStarted: evidence.appStatus?.started || null,
  });
}

function verifyReadyPanes(evidence) {
  const readyPanes = new Set(getReadyPanes(evidence.appStatus).map(String));
  const missing = REQUIRED_PANES.filter((paneId) => !readyPanes.has(paneId));
  const paneHost = evidence.appStatus?.paneHost || {};
  if (missing.length) {
    return check('FAIL', 'pane_host_ready_panes', 'Pane host is missing required Squid Room panes.', {
      missing,
      readyPanes: [...readyPanes],
    });
  }
  if (paneHost.degraded) {
    return check('FAIL', 'pane_host_ready_panes', 'Pane host is degraded after restart.', {
      readyPanes: [...readyPanes],
      paneHost,
    });
  }
  return check('PASS', 'pane_host_ready_panes', 'Pane host reports all main panes and TrustQuote arms ready.', {
    readyPanes: [...readyPanes],
    paneHost: {
      degraded: Boolean(paneHost.degraded),
      hiddenModeEnabled: Boolean(paneHost.hiddenModeEnabled),
    },
  });
}

function verifyTerminalBodies(evidence) {
  const panes = evidence.terminalSummary?.panes || {};
  const missing = [];
  const empty = [];
  const cwdMismatch = [];

  for (const paneId of ['2', '3']) {
    const pane = panes[paneId];
    if (!pane) missing.push(paneId);
    else if (!pane.alive || !pane.hasRenderableBody) empty.push(paneId);
  }

  for (const arm of REQUIRED_ARMS) {
    const pane = panes[arm.paneId];
    if (!pane) {
      missing.push(arm.paneId);
    } else {
      if (!pane.alive || !pane.hasRenderableBody) empty.push(arm.paneId);
      if (pane.cwd && !pathsMatch(pane.cwd, arm.cwd)) {
        cwdMismatch.push({ paneId: arm.paneId, actual: pane.cwd, expected: arm.cwd });
      }
    }
  }

  if (missing.length || empty.length || cwdMismatch.length) {
    return check('FAIL', 'terminal_bodies_live', 'Session-state terminals are missing, empty, dead, or cwd-mismatched.', {
      missing,
      empty,
      cwdMismatch,
      summaries: Object.fromEntries(REQUIRED_PANES.map((paneId) => [
        paneId,
        panes[paneId]
          ? {
              alive: panes[paneId].alive,
              printableChars: panes[paneId].printableChars,
              cwd: panes[paneId].cwd,
              lastActivityMs: panes[paneId].lastActivityMs,
            }
          : null,
      ])),
    });
  }

  return check('PASS', 'terminal_bodies_live', 'Builder, Oracle, and TrustQuote arm bodies have live renderable terminal state.', {
    summaries: Object.fromEntries([...['2', '3'], ...REQUIRED_ARMS.map((arm) => arm.paneId)].map((paneId) => [
      paneId,
      {
        alive: panes[paneId].alive,
        printableChars: panes[paneId].printableChars,
        cwd: panes[paneId].cwd,
        lastActivityMs: panes[paneId].lastActivityMs,
      },
    ])),
  });
}

function verifyArmManifest(evidence) {
  const projection = evidence.armProjection || {};
  const registryArms = Array.isArray(projection.registryArms)
    ? projection.registryArms
    : (Array.isArray(projection.arms) ? projection.arms : []);
  const registeredPaneIds = new Set(registryArms.map((arm) => arm.paneId));
  const missing = REQUIRED_ARMS.map((arm) => arm.paneId).filter((paneId) => !registeredPaneIds.has(paneId));

  if (projection.ok === false && !registryArms.length) {
    return check('FAIL', 'trustquote_arm_registry_manifest', 'TrustQuote arm projection could not be loaded.', {
      status: projection.status || null,
      error: projection.error || null,
    });
  }

  if (missing.length) {
    return check('FAIL', 'trustquote_arm_registry_manifest', 'TrustQuote arm registry is missing required arms.', {
      missing,
      desiredCount: projection.desiredCount || null,
      readyCount: projection.readyCount || null,
      status: projection.status || null,
    });
  }

  return check('PASS', 'trustquote_arm_registry_manifest', 'TrustQuote arm registry contains the four required arms.', {
    desiredCount: projection.desiredCount || registryArms.length,
    readyCount: projection.readyCount || 0,
    status: projection.status || null,
    sessionId: projection.sessionId || null,
  });
}

function verifyArmReceipts(evidence) {
  const receipts = evidence.armReceipts || {};
  const expectedScope = getSessionScopeForSquidRoom(evidence.appStatus);
  const missing = [];
  const mismatches = [];

  for (const arm of REQUIRED_ARMS) {
    const receipt = receipts[arm.paneId];
    if (!receipt) {
      missing.push(arm.paneId);
      continue;
    }
    if (receipt.role !== arm.role) {
      mismatches.push({ paneId: arm.paneId, field: 'SQUIDRUN_ROLE', actual: receipt.role, expected: arm.role });
    }
    if (receipt.paneId !== arm.paneId) {
      mismatches.push({ paneId: arm.paneId, field: 'SQUIDRUN_PANE_ID', actual: receipt.paneId, expected: arm.paneId });
    }
    if (expectedScope && receipt.sessionScope !== expectedScope) {
      mismatches.push({ paneId: arm.paneId, field: 'SQUIDRUN_SESSION_SCOPE_ID', actual: receipt.sessionScope, expected: expectedScope });
    }
    if (receipt.windowKey && receipt.windowKey !== 'squid-room') {
      mismatches.push({ paneId: arm.paneId, field: 'SQUIDRUN_WINDOW_KEY', actual: receipt.windowKey, expected: 'squid-room' });
    }
    if (!receipt.cwd || !pathsMatch(receipt.cwd, arm.cwd)) {
      mismatches.push({ paneId: arm.paneId, field: 'cwd', actual: receipt.cwd, expected: arm.cwd });
    }
  }

  if (missing.length || mismatches.length) {
    return check('FAIL', 'trustquote_arm_startup_receipts', 'TrustQuote arm startup receipts are missing or role/env/cwd mismatched.', {
      expectedScope,
      missing,
      mismatches,
      receipts,
    });
  }

  return check('PASS', 'trustquote_arm_startup_receipts', 'All four TrustQuote arms emitted role-bound startup receipts for this Squid Room session.', {
    expectedScope,
    receipts,
  });
}

function verifyNoSilentDrop(baseline, evidence) {
  const baselinePanes = baseline?.terminalSummary?.panes || {};
  const currentPanes = evidence.terminalSummary?.panes || {};
  const dropped = [];
  const checked = [];
  const panesToCheck = ['2', '3', ...REQUIRED_ARMS.map((arm) => arm.paneId)];

  if (!isActiveCurrentLane(baseline?.currentLane)) {
    return check('FAIL', 'in_progress_not_silently_dropped', 'Baseline did not prove an active current lane with in-progress pane output.', {
      baselineCurrentLaneStatus: baseline?.currentLane?.status || null,
      baselineActiveLanePresent: Boolean(baseline?.currentLane?.activeLane || baseline?.currentLane?.activeLanePresent),
    });
  }

  for (const paneId of panesToCheck) {
    const before = baselinePanes[paneId];
    const after = currentPanes[paneId];
    if (!before || before.printableChars < DEFAULT_MIN_BODY_CHARS) continue;
    checked.push(paneId);
    if (!after || after.printableChars < DEFAULT_MIN_BODY_CHARS) {
      dropped.push({ paneId, reason: 'post_restart_body_missing' });
      continue;
    }
    const beforeTail = normalizeBodyText(before.tailText || '');
    const afterSearchArea = normalizeBodyText(after.bodyText || after.tailText || '');
    if (beforeTail && !afterSearchArea.includes(beforeTail)) {
      dropped.push({
        paneId,
        reason: 'baseline_tail_not_found_in_restored_body',
        baselineTailSha256: before.tailSha256,
        currentBodySha256: after.bodySha256 || null,
        currentTailSha256: after.tailSha256 || null,
        beforePrintableChars: before.printableChars,
        afterPrintableChars: after.printableChars,
      });
    }
  }

  if (!checked.length) {
    return check('UNKNOWN', 'in_progress_not_silently_dropped', 'Baseline did not contain enough body text to prove in-progress continuity.', {}, false);
  }

  if (dropped.length) {
    return check('FAIL', 'in_progress_not_silently_dropped', 'At least one baseline pane body was not preserved across restart.', {
      checked,
      dropped,
    });
  }

  return check('PASS', 'in_progress_not_silently_dropped', 'Baseline terminal body tails are still present after restart.', {
    checked,
  });
}

function verifyEventRates(evidence, options = {}) {
  const rates = evidence.eventRates || {};
  const panes = rates.panes || {};
  const eventWindowSec = Number(options.eventWindowSec || rates.trailingWindowSec || DEFAULT_EVENT_WINDOW_SEC);
  const offenders = [];

  for (const paneId of REQUIRED_PANES) {
    const pane = panes[paneId] || {};
    const resizeRate = Number(pane.daemonResizeTrailingPerSec || 0);
    if (resizeRate > RESIZE_STEADY_STATE_LIMIT_PER_SEC) {
      offenders.push({ paneId, resizeRate });
    }
  }

  if (offenders.length) {
    return check('FAIL', 'steady_state_event_rates', 'Trailing resize rate is above the steady-state limit.', {
      eventWindowSec,
      limitPerSec: RESIZE_STEADY_STATE_LIMIT_PER_SEC,
      offenders,
    });
  }

  return check('PASS', 'steady_state_event_rates', 'Trailing resize rate is steady for main panes and TrustQuote arms.', {
    eventWindowSec,
    limitPerSec: RESIZE_STEADY_STATE_LIMIT_PER_SEC,
    panes: Object.fromEntries(REQUIRED_PANES.map((paneId) => [
      paneId,
      {
        daemonResizePerSec: panes[paneId]?.daemonResizePerSec || 0,
        daemonResizeTrailingPerSec: panes[paneId]?.daemonResizeTrailingPerSec || 0,
        daemonCounts: panes[paneId]?.daemonCounts || {},
        busCounts: panes[paneId]?.busCounts || {},
      },
    ])),
  });
}

// Bug A check 1: fit-coherence. After a settle redraw the renderer's xterm geometry
// must agree with the container-proposed dims and the last PTY-applied dims (no drift).
function verifyFitCoherence(evidence) {
  const telemetry = evidence.fitTelemetryByPane || {};
  const present = REQUIRED_MAIN_PANES.filter((paneId) => telemetry[paneId]);
  if (present.length === 0) {
    return check('UNKNOWN', 'fit_coherence_during_streaming',
      'No settle-redraw fit telemetry recorded yet. Stream output in a pane, then re-run.', {
        expectedPath: evidence.paths?.fitTelemetryPath || null,
      }, false);
  }
  const incoherent = present.filter((paneId) => telemetry[paneId]?.coherent !== true);
  if (incoherent.length) {
    return check('FAIL', 'fit_coherence_during_streaming',
      'A pane reported incoherent viewport geometry after the settle redraw (xterm/proposed/applied disagree).', {
        offenders: Object.fromEntries(incoherent.map((paneId) => [paneId, {
          xterm: [telemetry[paneId]?.xtermCols, telemetry[paneId]?.xtermRows],
          proposed: [telemetry[paneId]?.proposedCols, telemetry[paneId]?.proposedRows],
          applied: [telemetry[paneId]?.appliedCols, telemetry[paneId]?.appliedRows],
        }])),
      });
  }
  return check('PASS', 'fit_coherence_during_streaming',
    'Viewport geometry is coherent (xterm == proposed == applied) for all panes with telemetry.', {
      panes: Object.fromEntries(present.map((paneId) => [paneId, {
        xterm: [telemetry[paneId]?.xtermCols, telemetry[paneId]?.xtermRows],
      }])),
    });
}

// Bug A check 2: redraw OUTCOME. The forced same-dims re-poke must produce an actual
// paint delta (painted=true) — evidence the agent TUI repainted on Windows ConPTY (X).
// painted=false => (X) is inert on this platform; iterate to the (Y) xterm recompute.
function verifyRedrawOutcome(evidence) {
  const telemetry = evidence.fitTelemetryByPane || {};
  // painted is ONLY evidence-grade on a quiet settle: if the burst was still streaming
  // into the re-poke, concurrent writes flip painted regardless of the re-poke (false-X).
  // Confounded (quietSettle!==true) records are excluded entirely, never counted as PASS.
  const quiet = REQUIRED_MAIN_PANES.filter((paneId) => telemetry[paneId]?.quietSettle === true);
  const confounded = REQUIRED_MAIN_PANES.filter((paneId) => telemetry[paneId] && telemetry[paneId].quietSettle !== true);
  if (quiet.length === 0) {
    return check('UNKNOWN', 'redraw_outcome_on_settle',
      'No quiet-settle paint-outcome telemetry yet (only mid-stream/confounded records). Stream output, let it go quiet, then re-run.', {
        expectedPath: evidence.paths?.fitTelemetryPath || null,
        confoundedPanes: confounded,
      }, false);
  }
  const noPaint = quiet.filter((paneId) => telemetry[paneId]?.painted !== true);
  if (noPaint.length) {
    return check('FAIL', 'redraw_outcome_on_settle',
      'Quiet-settle re-poke produced NO paint delta on some panes — same-dims ConPTY re-poke (X) is inert here; iterate to (Y) xterm dimension recompute.', {
        offenders: Object.fromEntries(noPaint.map((paneId) => [paneId, {
          beforeSignature: telemetry[paneId]?.beforeSignature || null,
          afterSignature: telemetry[paneId]?.afterSignature || null,
        }])),
        confoundedExcluded: confounded,
      });
  }
  return check('PASS', 'redraw_outcome_on_settle',
    'Quiet-settle re-poke produced a paint delta (TUI repainted) for all evaluated panes — (X) works on this platform; confounded mid-stream records excluded.', {
      panes: quiet,
      confoundedExcluded: confounded,
    });
}

function verifyStreamingFit(evidence) {
  const checks = [verifyFitCoherence(evidence), verifyRedrawOutcome(evidence)];
  checks.sort((a, b) => statusRank(b.status) - statusRank(a.status));
  const status = latestOverallStatus(checks);
  return {
    schema: SCHEMA,
    kind: 'streaming_fit_verification',
    generatedAt: evidence.generatedAt,
    status,
    decision: status === 'PASS'
      ? 'streaming_fit_gate_met'
      : 'streaming_fit_gate_not_met',
    gitHead: evidence.gitHead,
    appSession: evidence.appStatus?.session || null,
    sessionScope: evidence.sessionScope || null,
    summary: {
      pass: checks.filter((entry) => entry.status === 'PASS').length,
      warn: checks.filter((entry) => entry.status === 'WARN').length,
      fail: checks.filter((entry) => entry.status === 'FAIL').length,
      unknown: checks.filter((entry) => entry.status === 'UNKNOWN').length,
    },
    checks,
    sourceRefs: {
      fitTelemetryPath: evidence.paths?.fitTelemetryPath || null,
    },
  };
}

function verifyRestartSurvival(evidence, baseline, options = {}) {
  const checks = [];

  if (!baseline && !options.allowNoBaseline) {
    checks.push(check('FAIL', 'baseline_loaded', 'No baseline snapshot was supplied. Run baseline before the restart.', {
      expectedPath: DEFAULT_BASELINE_PATH,
    }));
  } else if (baseline) {
    checks.push(check('PASS', 'baseline_loaded', 'Baseline snapshot loaded.', {
      generatedAt: baseline.generatedAt || null,
      session: baseline.appStatus?.session || null,
      gitHead: baseline.gitHead || null,
    }, false));
  } else {
    checks.push(check('UNKNOWN', 'baseline_loaded', 'No baseline snapshot supplied; continuity checks are disabled by --allow-no-baseline.', {}, false));
  }

  if (baseline) {
    checks.push(verifySessionBump(baseline, evidence, options));
    checks.push(verifyWindowRestore(baseline, evidence));
    checks.push(verifyNoSilentDrop(baseline, evidence));
  }

  checks.push(verifyReadyPanes(evidence));
  checks.push(verifyTerminalBodies(evidence));
  checks.push(verifyArmManifest(evidence));
  checks.push(verifyArmReceipts(evidence));
  checks.push(verifyEventRates(evidence, options));

  checks.sort((a, b) => statusRank(b.status) - statusRank(a.status));

  const status = latestOverallStatus(checks);
  return {
    schema: SCHEMA,
    kind: 'verification',
    generatedAt: evidence.generatedAt,
    status,
    decision: status === 'PASS'
      ? 'restart_survival_gate_met'
      : 'restart_survival_gate_not_met',
    gitHead: evidence.gitHead,
    appSession: evidence.appStatus?.session || null,
    sessionScope: evidence.sessionScope || null,
    summary: {
      pass: checks.filter((entry) => entry.status === 'PASS').length,
      warn: checks.filter((entry) => entry.status === 'WARN').length,
      fail: checks.filter((entry) => entry.status === 'FAIL').length,
      unknown: checks.filter((entry) => entry.status === 'UNKNOWN').length,
    },
    checks,
    sourceRefs: {
      appStatusPath: evidence.paths?.appStatusPath || null,
      windowStatePath: evidence.paths?.windowStatePath || null,
      sessionStatePath: evidence.paths?.sessionStatePath || null,
      daemonLogPath: evidence.paths?.daemonLogPath || null,
      busTracePath: evidence.paths?.busTracePath || null,
    },
  };
}

function formatTextReport(result, outputPath) {
  const lines = [
    `Squid Room restart-survival proof: ${result.status}`,
    `decision: ${result.decision}`,
    `session: ${result.appSession || 'unknown'}`,
    `sessionScope: ${result.sessionScope || 'unknown'}`,
    outputPath ? `proof: ${outputPath}` : null,
    '',
  ].filter(Boolean);

  for (const entry of result.checks || []) {
    lines.push(`${entry.status} ${entry.id}: ${entry.why}`);
  }
  return lines.join('\n');
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    console.log(usage());
    return 0;
  }

  if (args.command === 'baseline') {
    const evidence = collectEvidence({
      commsRowsPath: args.commsRowsPath,
      eventWindowSec: args.eventWindowSec,
      receiptWaitMs: args.receiptWaitMs,
    });
    const baseline = buildBaselineSnapshot(evidence);
    const outputPath = args.outPath || DEFAULT_BASELINE_PATH;
    writeJson(outputPath, baseline);
    if (args.json) {
      console.log(JSON.stringify(baseline, null, 2));
    } else {
      console.log(`Squid Room restart baseline written: ${outputPath}`);
      console.log(`session: ${baseline.appStatus.session || 'unknown'}`);
      console.log(`windowOpen: ${Boolean(baseline.windowState.open)}`);
      console.log(`readyPanes: ${(baseline.appStatus.readyPanes || []).join(',')}`);
    }
    return 0;
  }

  if (args.command === 'verify') {
    const baseline = fs.existsSync(args.baselinePath)
      ? readJson(args.baselinePath)
      : null;
    const evidence = collectEvidence({
      commsRowsPath: args.commsRowsPath,
      eventWindowSec: args.eventWindowSec,
      receiptWaitMs: args.receiptWaitMs,
    });
    const result = verifyRestartSurvival(evidence, baseline, {
      allowSameSession: args.allowSameSession,
      allowNoBaseline: args.allowNoBaseline,
      eventWindowSec: args.eventWindowSec,
    });
    const outputPath = args.outPath || DEFAULT_PROOF_PATH;
    writeJson(outputPath, result);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatTextReport(result, outputPath));
    }
    return result.status === 'FAIL' ? 1 : 0;
  }

  if (args.command === 'streaming-fit') {
    const evidence = collectEvidence({
      commsRowsPath: args.commsRowsPath,
      eventWindowSec: args.eventWindowSec,
      receiptWaitMs: args.receiptWaitMs,
    });
    const result = verifyStreamingFit(evidence);
    const outputPath = args.outPath || DEFAULT_STREAMING_FIT_PROOF_PATH;
    writeJson(outputPath, result);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Squid Room streaming-fit (Bug A) proof: ${result.status}`);
      console.log(`decision: ${result.decision}`);
      console.log(outputPath ? `proof: ${outputPath}` : '');
      for (const entry of result.checks || []) {
        console.log(`${entry.status} ${entry.id}: ${entry.why}`);
      }
    }
    return result.status === 'FAIL' ? 1 : 0;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
  }
}

module.exports = {
  SCHEMA,
  REQUIRED_ARMS,
  REQUIRED_PANES,
  buildBaselineSnapshot,
  verifyRestartSurvival,
  verifyStreamingFit,
  verifyFitCoherence,
  verifyRedrawOutcome,
  collectEvidence,
  parseArmReceipts,
  summarizeTerminal,
  summarizeSessionState,
  normalizeBodyText,
  buildEventRates,
  parseDaemonEvents,
  parseBusTraceLines,
  parseFitTelemetryLines,
};
