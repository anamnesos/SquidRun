'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MIRA_CALENDAR_MESSAGE_CURIOSITY_SCHEMA = 'squidrun.mira.calendar_message_curiosity_read_v0';
const CALENDAR_EXTENSIONS = new Set(['.ics', '.json', '.jsonl', '.md', '.txt']);
const MESSAGE_EXTENSIONS = new Set(['.json', '.jsonl', '.md', '.txt']);
const CALENDAR_NAME_PATTERN = /\b(calendar|agenda|meeting|invite|availability|event)\b/i;
const MESSAGE_NAME_PATTERN = /\b(message|messages|comms|telegram|sms|reply|inbound|outbound|journal)\b/i;
const DEFAULT_COMMS_HISTORY_LIMIT = 50;

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeRelativePath(projectRoot, filePath) {
  const relative = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}

function defaultCalendarMessageRoots(projectRoot) {
  return [
    { bucket: 'runtime_calendar', kind: 'calendar', dir: path.join(projectRoot, '.squidrun', 'runtime') },
    { bucket: 'workspace_calendar', kind: 'calendar', dir: path.join(projectRoot, 'workspace', 'calendar') },
    { bucket: 'workspace_calendars', kind: 'calendar', dir: path.join(projectRoot, 'workspace', 'calendars') },
    { bucket: 'runtime_messages', kind: 'message', dir: path.join(projectRoot, '.squidrun', 'runtime') },
    { bucket: 'local_messages', kind: 'message', dir: path.join(projectRoot, '.squidrun', 'messages') },
    { bucket: 'workspace_messages', kind: 'message', dir: path.join(projectRoot, 'workspace', 'messages') },
  ];
}

function normalizeRoots(payload = {}, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const raw = options.calendarMessageRoots || payload.calendarMessageRoots || payload.roots;
  if (!raw) return defaultCalendarMessageRoots(projectRoot);
  return asArray(raw).map((entry, index) => {
    if (entry && typeof entry === 'object') {
      return {
        bucket: trimText(entry.bucket || entry.source || `calendar_message_${index + 1}`) || `calendar_message_${index + 1}`,
        kind: trimText(entry.kind || entry.type || 'message').toLowerCase() === 'calendar' ? 'calendar' : 'message',
        dir: path.resolve(projectRoot, trimText(entry.dir || entry.path || entry.root)),
      };
    }
    return {
      bucket: `calendar_message_${index + 1}`,
      kind: 'message',
      dir: path.resolve(projectRoot, trimText(entry)),
    };
  }).filter((entry) => entry.dir);
}

function shouldSkipDir(name) {
  return /^(node_modules|\.git|backups|private-overlays|profiles|dist|coverage)$/i.test(name);
}

function fileMatches(root, filePath) {
  const name = path.basename(filePath);
  const ext = path.extname(name).toLowerCase();
  if (root.kind === 'calendar') {
    return CALENDAR_EXTENSIONS.has(ext) && (ext === '.ics' || CALENDAR_NAME_PATTERN.test(name));
  }
  return MESSAGE_EXTENSIONS.has(ext) && (MESSAGE_NAME_PATTERN.test(name) || /^(architect|builder|oracle|all)\.txt$/i.test(name));
}

function collectFiles(projectRoot, roots, limit) {
  const files = [];
  for (const root of roots) {
    if (!root.dir || !fs.existsSync(root.dir)) continue;
    const stack = [{ dir: root.dir, depth: 0 }];
    while (stack.length > 0 && files.length < limit * 5) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current.dir, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < 2 && !shouldSkipDir(entry.name)) stack.push({ dir: fullPath, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile() || !fileMatches(root, fullPath)) continue;
        try {
          const stat = fs.statSync(fullPath);
          files.push({
            bucket: root.bucket,
            kind: root.kind,
            path: fullPath,
            name: entry.name,
            ext: path.extname(entry.name).toLowerCase(),
            size: stat.size,
            modifiedMs: stat.mtimeMs,
            modified: stat.mtime.toISOString(),
          });
        } catch {}
      }
    }
  }
  const seen = new Set();
  return files
    .filter((file) => {
      const key = `${file.kind}:${file.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.modifiedMs - left.modifiedMs || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function readSnippet(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.slice(0, bytes).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function compactDate(value) {
  const text = trimText(value);
  if (!text) return null;
  const isoLike = text.match(/(\d{4})-?(\d{2})-?(\d{2})(?:[T\s]?(\d{2})?:?(\d{2})?)?/);
  if (!isoLike) return null;
  const [, year, month, day, hour = '00', minute = '00'] = isoLike;
  return `${year}-${month}-${day}T${hour.padEnd(2, '0')}:${minute.padEnd(2, '0')}:00.000Z`;
}

function summarizeCalendarText(text, ext) {
  const source = String(text || '');
  if (ext === '.ics') {
    const events = (source.match(/BEGIN:VEVENT/g) || []).length;
    const starts = Array.from(source.matchAll(/^DTSTART[^:]*:(.+)$/gmi)).map((match) => compactDate(match[1])).filter(Boolean);
    return {
      record_count: events,
      first_start: starts.sort()[0] || null,
      last_start: starts.sort().slice(-1)[0] || null,
    };
  }
  try {
    const parsed = JSON.parse(source);
    const records = Array.isArray(parsed)
      ? parsed
      : asArray(parsed.events || parsed.items || parsed.calendar || parsed.entries);
    const starts = records
      .map((entry) => compactDate(entry?.start || entry?.start_time || entry?.date || entry?.time))
      .filter(Boolean)
      .sort();
    return {
      record_count: records.length || (parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0),
      first_start: starts[0] || null,
      last_start: starts.slice(-1)[0] || null,
    };
  } catch {
    const starts = Array.from(source.matchAll(/\b(?:date|start|dtstart)\b[^0-9]*(\d{4}[-]?\d{2}[-]?\d{2}(?:[T\s]?\d{2}:?\d{2})?)/gi))
      .map((match) => compactDate(match[1]))
      .filter(Boolean)
      .sort();
    return {
      record_count: starts.length,
      first_start: starts[0] || null,
      last_start: starts.slice(-1)[0] || null,
    };
  }
}

function summarizeMessageText(text, ext) {
  const source = String(text || '');
  if (ext === '.jsonl') {
    const rows = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const channels = {};
    for (const row of rows.slice(0, 200)) {
      try {
        const parsed = JSON.parse(row);
        const channel = trimText(parsed.channel || parsed.source || parsed.target || parsed.sender_role || parsed.senderRole || 'unknown');
        channels[channel] = (channels[channel] || 0) + 1;
      } catch {}
    }
    return { record_count: rows.length, channel_counts: channels };
  }
  try {
    const parsed = JSON.parse(source);
    const records = Array.isArray(parsed)
      ? parsed
      : asArray(parsed.messages || parsed.items || parsed.entries || parsed.history);
    const channels = {};
    for (const entry of records.slice(0, 200)) {
      const channel = trimText(entry?.channel || entry?.source || entry?.target || entry?.sender_role || entry?.senderRole || 'unknown');
      channels[channel] = (channels[channel] || 0) + 1;
    }
    return {
      record_count: records.length || (parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0),
      channel_counts: channels,
    };
  } catch {
    const lines = source.split(/\r?\n/).filter((line) => trimText(line));
    return { record_count: lines.length, channel_counts: {} };
  }
}

function summarizeFile(file, projectRoot, maxBytes) {
  let summary = {};
  try {
    const text = readSnippet(file.path, maxBytes);
    summary = file.kind === 'calendar'
      ? summarizeCalendarText(text, file.ext)
      : summarizeMessageText(text, file.ext);
  } catch {
    summary = {};
  }
  return {
    source_bucket: file.bucket,
    kind: file.kind,
    path: safeRelativePath(projectRoot, file.path),
    name: file.name,
    ext: file.ext,
    modified_at: file.modified,
    size_bytes: file.size,
    record_count: Number(summary.record_count || 0),
    first_start: summary.first_start || null,
    last_start: summary.last_start || null,
    channel_counts: summary.channel_counts || {},
  };
}

function compactConnectorCandidates() {
  return [
    {
      candidate: 'native_squidrun_comms',
      seam: 'ui/scripts/hm-comms.js history --last 50 --json compact metadata',
      reads: ['sender_role', 'target_role', 'channel', 'timestamp', 'delivery_status'],
      writes_or_sends: false,
    },
    {
      candidate: 'calendar_connector',
      seam: 'MCP-compatible calendar provider or local ICS/cache reader',
      reads: ['event_time', 'calendar_id', 'status', 'busy/free metadata'],
      writes_or_sends: false,
    },
    {
      candidate: 'message_connector',
      seam: 'Telegram/SMS/Gmail metadata snapshots before body reads or sends',
      reads: ['thread/message metadata', 'label/channel counts', 'timestamps'],
      writes_or_sends: false,
    },
  ];
}

function clampLimit(value, fallback, max) {
  return Math.max(1, Math.min(max, Number(value || fallback) || fallback));
}

function parseJsonStdout(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function defaultCommsHistoryReader(payload = {}, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const limit = clampLimit(payload.limit || options.limit, DEFAULT_COMMS_HISTORY_LIMIT, 200);
  const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-comms.js');
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, reason: 'hm_comms_script_missing', rows: [], limit };
  }
  const run = spawnSync(process.execPath, [scriptPath, 'history', '--last', String(limit), '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    env: {
      ...process.env,
      SQUIDRUN_PROJECT_ROOT: projectRoot,
    },
  });
  if (run.status !== 0) {
    return {
      ok: false,
      reason: 'hm_comms_history_failed',
      status: run.status,
      stderr: trimText(run.stderr).slice(0, 240),
      rows: [],
      limit,
    };
  }
  const parsed = parseJsonStdout(run.stdout);
  if (!parsed || parsed.ok === false) {
    return {
      ok: false,
      reason: trimText(parsed?.reason || parsed?.error || 'hm_comms_history_parse_failed'),
      rows: [],
      limit,
    };
  }
  return {
    ok: true,
    limit: Number(parsed.limit || limit),
    count: Number(parsed.count || asArray(parsed.rows).length || 0),
    scope: trimText(parsed.scope || 'main') || null,
    rows: asArray(parsed.rows),
  };
}

function compactCounter(counter, limit = 12) {
  return Object.fromEntries(Object.entries(counter || {})
    .filter(([, count]) => Number(count || 0) > 0)
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0) || String(left[0]).localeCompare(String(right[0])))
    .slice(0, limit));
}

function addCount(counter, key) {
  const value = trimText(key) || 'unknown';
  counter[value] = (counter[value] || 0) + 1;
}

function compactCommsRow(row) {
  const timestampMs = Number(row?.timestampMs ?? row?.timestamp_ms);
  return {
    row_id: Number(row?.rowId ?? row?.row_id) || null,
    message_id: trimText(row?.messageId || row?.message_id) || null,
    session_id: trimText(row?.sessionId || row?.session_id) || null,
    sender: trimText(row?.sender) || 'unknown',
    target: trimText(row?.target) || 'unknown',
    status: trimText(row?.status) || 'unknown',
    scope: trimText(row?.scope) || 'main',
    timestamp_ms: Number.isFinite(timestampMs) ? timestampMs : null,
    timestamp: trimText(row?.timestamp) || null,
  };
}

function compactCommsHistoryMetadata(history = {}, options = {}) {
  const limit = clampLimit(options.limit || history.limit, DEFAULT_COMMS_HISTORY_LIMIT, 200);
  if (!history || history.ok !== true) {
    return {
      ok: false,
      source: 'hm-comms',
      reason: trimText(history?.reason || history?.error || 'hm_comms_history_unavailable'),
      history_limit: limit,
      row_count: 0,
      latest_rows: [],
      latest_message_ids: [],
    };
  }
  const rows = asArray(history.rows)
    .map(compactCommsRow)
    .filter((row) => row.message_id || row.row_id)
    .sort((left, right) => Number(right.timestamp_ms || 0) - Number(left.timestamp_ms || 0) || Number(right.row_id || 0) - Number(left.row_id || 0))
    .slice(0, limit);
  const senderCounts = {};
  const targetCounts = {};
  const statusCounts = {};
  const scopeCounts = {};
  const rolePairCounts = {};
  const pairLatest = {};
  for (const row of rows) {
    addCount(senderCounts, row.sender);
    addCount(targetCounts, row.target);
    addCount(statusCounts, row.status);
    addCount(scopeCounts, row.scope);
    const pair = `${row.sender}->${row.target}`;
    rolePairCounts[pair] = (rolePairCounts[pair] || 0) + 1;
    pairLatest[pair] = Math.max(Number(pairLatest[pair] || 0), Number(row.timestamp_ms || 0));
  }
  return {
    ok: true,
    source: 'hm-comms',
    scope: trimText(history.scope || rows[0]?.scope || 'main') || 'main',
    history_limit: limit,
    row_count: rows.length,
    latest_timestamp_ms: rows[0]?.timestamp_ms || null,
    latest_timestamp: rows[0]?.timestamp || null,
    latest_message_ids: rows.map((row) => row.message_id).filter(Boolean).slice(0, 12),
    sender_counts: compactCounter(senderCounts),
    target_counts: compactCounter(targetCounts),
    status_counts: compactCounter(statusCounts),
    scope_counts: compactCounter(scopeCounts),
    role_pair_counts: compactCounter(rolePairCounts, 16),
    thread_pressure: Object.entries(rolePairCounts)
      .map(([pair, count]) => ({
        pair,
        count,
        latest_timestamp_ms: pairLatest[pair] || null,
      }))
      .sort((left, right) => right.count - left.count || Number(right.latest_timestamp_ms || 0) - Number(left.latest_timestamp_ms || 0))
      .slice(0, 8),
    mira_route_count: rows.filter((row) => row.sender === 'mira' && ['builder', 'oracle', 'architect'].includes(row.target)).length,
    latest_rows: rows.slice(0, 12),
  };
}

function selectConnectorCandidate(candidates, result, nativeCommsMetadata) {
  const nativeCandidate = candidates.find((entry) => entry.candidate === 'native_squidrun_comms') || candidates[0] || null;
  const calendarCandidate = candidates.find((entry) => entry.candidate === 'calendar_connector') || null;
  const messageCount = Number(result.message_artifact_count || 0);
  const calendarCount = Number(result.calendar_artifact_count || 0);
  if (nativeCandidate && (messageCount > 0 || Number(nativeCommsMetadata?.row_count || 0) > 0)) {
    return {
      candidate: nativeCandidate.candidate,
      seam: nativeCandidate.seam,
      reason: 'Local message artifacts plus hm-comms metadata make native SquidRun comms the first read-only seam before calendar or Gmail APIs.',
      evidence: {
        message_artifact_count: messageCount,
        native_comms_row_count: Number(nativeCommsMetadata?.row_count || 0),
        role_pair_count: Object.keys(nativeCommsMetadata?.role_pair_counts || {}).length,
      },
      writes_or_sends: false,
    };
  }
  if (calendarCandidate && calendarCount > 0) {
    return {
      candidate: calendarCandidate.candidate,
      seam: calendarCandidate.seam,
      reason: 'Calendar artifacts exist but no native comms pressure is available in this runtime.',
      evidence: {
        calendar_artifact_count: calendarCount,
        native_comms_row_count: Number(nativeCommsMetadata?.row_count || 0),
      },
      writes_or_sends: false,
    };
  }
  if (!nativeCandidate) return null;
  return {
    candidate: nativeCandidate.candidate,
    seam: nativeCandidate.seam,
    reason: 'No local calendar/message artifacts were found yet, so keep the native comms seam as the first connector candidate.',
    evidence: {
      message_artifact_count: messageCount,
      calendar_artifact_count: calendarCount,
      native_comms_row_count: Number(nativeCommsMetadata?.row_count || 0),
    },
    writes_or_sends: false,
  };
}

function readMiraCalendarMessageCuriosity(payload = {}, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const roots = normalizeRoots(payload, { ...options, projectRoot });
  const limit = Math.max(1, Math.min(80, Number(payload.limit || options.limit || 24) || 24));
  const maxBytes = Math.max(512, Math.min(32000, Number(payload.maxBytes || options.maxBytes || 12000) || 12000));
  const commsHistoryLimit = clampLimit(payload.commsHistoryLimit || options.commsHistoryLimit, DEFAULT_COMMS_HISTORY_LIMIT, 200);
  const commsHistoryReader = typeof options.commsHistoryReader === 'function'
    ? options.commsHistoryReader
    : (typeof payload.commsHistoryReader === 'function' ? payload.commsHistoryReader : defaultCommsHistoryReader);
  const files = collectFiles(projectRoot, roots, limit);
  const results = files
    .map((file) => summarizeFile(file, projectRoot, maxBytes))
    .filter((entry) => entry.path);
  const calendarResults = results.filter((entry) => entry.kind === 'calendar');
  const messageResults = results.filter((entry) => entry.kind === 'message');
  const buckets = results.reduce((acc, entry) => {
    acc[entry.source_bucket] = (acc[entry.source_bucket] || 0) + 1;
    return acc;
  }, {});
  const channelCounts = messageResults.reduce((acc, entry) => {
    for (const [channel, count] of Object.entries(entry.channel_counts || {})) {
      const key = trimText(channel) || 'unknown';
      acc[key] = (acc[key] || 0) + Number(count || 0);
    }
    return acc;
  }, {});
  const starts = calendarResults.flatMap((entry) => [entry.first_start, entry.last_start]).filter(Boolean).sort();
  const connectorCandidates = compactConnectorCandidates();
  const nativeCommsMetadata = compactCommsHistoryMetadata(
    commsHistoryReader({ projectRoot, limit: commsHistoryLimit }, { projectRoot, limit: commsHistoryLimit }),
    { limit: commsHistoryLimit },
  );
  const selectedConnector = selectConnectorCandidate(connectorCandidates, {
    message_artifact_count: messageResults.length,
    calendar_artifact_count: calendarResults.length,
  }, nativeCommsMetadata);

  return {
    schema: MIRA_CALENDAR_MESSAGE_CURIOSITY_SCHEMA,
    ok: true,
    decision: 'calendar_message_metadata_read_only',
    result_count: results.length,
    calendar_artifact_count: calendarResults.length,
    message_artifact_count: messageResults.length,
    buckets,
    message_channel_counts: channelCounts,
    calendar_first_start: starts[0] || null,
    calendar_last_start: starts.slice(-1)[0] || null,
    connector_candidates: connectorCandidates,
    selected_connector_candidate: selectedConnector,
    native_comms_metadata: nativeCommsMetadata,
    results,
    no_mutation_performed: true,
    consequence_controls: {
      internal_only: true,
      read_only: true,
      calendar_write_performed: false,
      message_send_performed: false,
      message_body_export_performed: false,
      network_performed: false,
      external_send_performed: false,
    },
  };
}

module.exports = {
  MIRA_CALENDAR_MESSAGE_CURIOSITY_SCHEMA,
  compactCommsHistoryMetadata,
  defaultCalendarMessageRoots,
  defaultCommsHistoryReader,
  readMiraCalendarMessageCuriosity,
};
