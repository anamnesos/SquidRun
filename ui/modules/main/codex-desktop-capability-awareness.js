'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getProjectRoot, resolveCoordPath } = require('../../config');
const {
  DEFAULT_REPORT_RELATIVE_PATH: CODEX_DESKTOP_TRANSPORT_REPORT_RELATIVE_PATH,
} = require('./codex-desktop-inbound-transport');

const STATUS_SCHEMA = 'squidrun.codex_desktop_capability_awareness.v0';
const DEFAULT_STATUS_RELATIVE_PATH = path.join('runtime', 'codex-desktop-capability-status-v0.json');
const USER_CORRECTION_SOURCE_MESSAGE_ID = 'telegram-in-808498547';
const DEFAULT_INBOX_STALE_MINUTES = 30;

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function asIso(value, fallbackMs = Date.now()) {
  if (value instanceof Date) return value.toISOString();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  const text = toOptionalString(value, null);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

function normalizePathForMetadata(value) {
  return toOptionalString(value, '')?.replace(/\\/g, '/') || '';
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (_) {
    return null;
  }
}

function parseJson(value, fallback = null) {
  const text = toOptionalString(value, null);
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function minutesSince(timestamp, nowMs) {
  const parsed = Date.parse(String(timestamp || ''));
  if (!Number.isFinite(parsed)) return null;
  return Number(((Number(nowMs) - parsed) / 60_000).toFixed(2));
}

function resolveNowMs(value, fallback = Date.now()) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function defaultRunner(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 5000,
    windowsHide: true,
    env: options.env || process.env,
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    signal: result.signal || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? (result.error.message || String(result.error)) : null,
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

function run(runner, command, args = [], options = {}) {
  try {
    const result = (runner || defaultRunner)(command, args, options) || {};
    return {
      ok: result.status === 0 && !result.error,
      status: typeof result.status === 'number' ? result.status : null,
      signal: result.signal || null,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error || null,
      timedOut: result.timedOut === true,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: err.message || String(err),
      timedOut: false,
    };
  }
}

function runPowerShell(runner, script, options = {}) {
  return run(runner, 'powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], { timeoutMs: options.timeoutMs || 5000 });
}

function resolveRuntimePath(projectRoot, relativePath) {
  return path.join(projectRoot, '.squidrun', relativePath);
}

function resolveScriptPath(projectRoot, scriptName) {
  return path.join(projectRoot, 'ui', 'scripts', scriptName);
}

function inspectScriptRoute(projectRoot, scriptName, command, description) {
  const scriptPath = resolveScriptPath(projectRoot, scriptName);
  const present = safeStat(scriptPath)?.isFile() === true;
  return {
    status: present ? 'available' : 'missing_script',
    script: normalizePathForMetadata(scriptPath),
    command,
    description,
  };
}

function inspectCodexProcessAvailability(projectRoot, options = {}) {
  if (options.processAvailability && typeof options.processAvailability === 'object') {
    return options.processAvailability;
  }

  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    return {
      status: 'not_proven',
      supported: false,
      reason: 'non_windows_host',
      process_count: 0,
      visible_window_count: 0,
      processes: [],
    };
  }

  const script = `
$rows = Get-Process -Name Codex,codex -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, MainWindowTitle, Path, StartTime
$rows | ConvertTo-Json -Depth 4
`;
  const result = runPowerShell(options.runner || defaultRunner, script, { timeoutMs: options.processTimeoutMs || 3500 });
  const parsed = parseJson(result.stdout, []);
  const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  const processes = rows.map((row) => ({
    pid: row.Id || row.id || null,
    process_name: row.ProcessName || row.processName || null,
    main_window_title: toOptionalString(row.MainWindowTitle || row.mainWindowTitle, null),
    path: normalizePathForMetadata(row.Path || row.path || ''),
    start_time: toOptionalString(row.StartTime || row.startTime, null),
  }));
  const visibleWindowCount = processes.filter((entry) => entry.main_window_title).length;
  const processCount = processes.length;

  return {
    status: processCount > 0 ? 'available' : (result.ok ? 'not_running' : 'unknown'),
    supported: true,
    reason: processCount > 0
      ? 'codex_process_observed'
      : (result.ok ? 'no_codex_process_observed' : 'process_probe_failed'),
    process_count: processCount,
    visible_window_count: visibleWindowCount,
    desktop_process_count: processes.filter((entry) => String(entry.process_name || '') === 'Codex').length,
    cli_or_helper_process_count: processes.filter((entry) => String(entry.process_name || '') === 'codex').length,
    processes: processes.slice(0, 12),
    probe: {
      ok: result.ok,
      status: result.status,
      error: result.error,
      timed_out: result.timedOut === true,
      source: 'Get-Process Codex,codex',
    },
  };
}

function inspectAttentionInbox(projectRoot, options = {}) {
  if (options.attentionInbox && typeof options.attentionInbox === 'object') {
    return options.attentionInbox;
  }

  const nowMs = resolveNowMs(options.nowMs);
  const bridgeRoot = path.resolve(options.bridgeRoot || resolveRuntimePath(
    projectRoot,
    path.join('runtime', 'codex-attention-bridge')
  ));
  const indexPath = path.join(bridgeRoot, 'index.json');
  const index = readJsonFile(indexPath);
  if (!index || typeof index !== 'object') {
    return {
      status: 'missing_index',
      polling_freshness: 'not_proven',
      source_ref: normalizePathForMetadata(indexPath),
      bridge_root: normalizePathForMetadata(bridgeRoot),
      updated_at: null,
      age_minutes: null,
      active_count: 0,
      completed_count: 0,
      total_count: 0,
      active_request_ids: [],
    };
  }

  const requests = Array.isArray(index.requests) ? index.requests : [];
  const activeRequestIds = Array.isArray(index.active_request_ids)
    ? index.active_request_ids.filter(Boolean)
    : requests
      .filter((entry) => ['requested', 'acknowledged', 'in_progress'].includes(String(entry.status || '')))
      .map((entry) => entry.id)
      .filter(Boolean);
  const completedCount = requests.filter((entry) => String(entry.status || '') === 'completed').length;
  const updatedAt = toOptionalString(index.updated_at || index.updatedAt, null);
  const ageMinutes = minutesSince(updatedAt, nowMs);
  const staleMinutes = Number.isFinite(Number(options.inboxStaleMinutes))
    ? Number(options.inboxStaleMinutes)
    : DEFAULT_INBOX_STALE_MINUTES;
  const pollingFreshness = activeRequestIds.length > 0 && Number.isFinite(ageMinutes) && ageMinutes > staleMinutes
    ? 'active_requests_index_stale'
    : (updatedAt ? 'index_loaded' : 'timestamp_missing');

  return {
    status: 'loaded',
    polling_freshness: pollingFreshness,
    source_ref: normalizePathForMetadata(indexPath),
    bridge_root: normalizePathForMetadata(bridgeRoot),
    updated_at: updatedAt,
    age_minutes: ageMinutes,
    stale_minutes: staleMinutes,
    active_count: activeRequestIds.length,
    completed_count: completedCount,
    total_count: requests.length,
    active_request_ids: activeRequestIds,
  };
}

function inspectDesktopTransportRoute(projectRoot, options = {}) {
  const route = inspectScriptRoute(
    projectRoot,
    'hm-codex-desktop-transport.js',
    'node ui/scripts/hm-codex-desktop-transport.js probe',
    'Probe or summon Codex Desktop workspace focus without claiming visible message injection.'
  );
  const reportPath = path.resolve(options.transportReportPath || resolveRuntimePath(
    projectRoot,
    CODEX_DESKTOP_TRANSPORT_REPORT_RELATIVE_PATH
  ));
  const report = options.transportReport && typeof options.transportReport === 'object'
    ? options.transportReport
    : readJsonFile(reportPath);
  return {
    ...route,
    report_ref: normalizePathForMetadata(reportPath),
    report_present: Boolean(report && typeof report === 'object'),
    report_generated_at: report?.generated_at || null,
    can_summon_workspace: report?.can_summon_workspace === true
      || report?.classification?.canSummonWorkspace === true,
    can_inject_visible_message: report?.can_inject_visible_message === true
      || report?.classification?.canInjectVisibleMessage === true,
    visible_injection_proven: report?.can_inject_visible_message === true
      || report?.classification?.canInjectVisibleMessage === true,
    decision: report?.decision || null,
  };
}

function resolveAggregateStatus(processAvailability, attentionInbox) {
  if (processAvailability?.status === 'available') {
    return 'process_available_not_monitored';
  }
  if (attentionInbox?.status === 'loaded') {
    return 'routes_discoverable_process_not_running_or_unproven';
  }
  return 'routes_partially_discoverable';
}

function buildCodexDesktopCapabilityStatus(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || getProjectRoot() || process.cwd());
  const nowMs = resolveNowMs(options.nowMs);
  const generatedAt = toOptionalString(options.generatedAt, null) || asIso(options.now || nowMs, nowMs);
  const processAvailability = inspectCodexProcessAvailability(projectRoot, { ...options, nowMs });
  const attentionInbox = inspectAttentionInbox(projectRoot, { ...options, nowMs });
  const desktopTransport = inspectDesktopTransportRoute(projectRoot, options);
  const capabilityStatusRoute = inspectScriptRoute(
    projectRoot,
    'hm-codex-capability-status.js',
    'node ui/scripts/hm-codex-capability-status.js status --json',
    'Single discoverable Codex Desktop capability/status seam for startup and agent tool awareness.'
  );
  // hm-codex-attention.js was DELETED (S464 adjudication: bridge retired).
  // The route reports itself retired so no agent discovers a dead tool;
  // the archived inbox files remain readable for history.
  const attentionRoute = {
    status: 'retired',
    script: null,
    command: null,
    description: 'RETIRED (S464): the codex-attention inbox script was deleted; archived request/proof files remain under runtime history only.',
  };
  return {
    ok: true,
    schema: STATUS_SCHEMA,
    version: 1,
    generated_at: generatedAt,
    status: resolveAggregateStatus(processAvailability, attentionInbox),
    project_root: normalizePathForMetadata(projectRoot),
    acceptance_context: {
      user_correction_source: USER_CORRECTION_SOURCE_MESSAGE_ID,
      decision: 'surface_existing_codex_desktop_computer_use_app_control_and_attention_inbox_routes_not_new_transport',
      summary: 'Existing Codex Desktop plus Codex-owned Computer Use/app-control is a usable route to operate SquidRun; this status does not invent push injection into an existing Codex thread.',
    },
    availability: {
      codexDesktopProcess: processAvailability,
      computerUseAppControl: {
        status: 'known_route',
        source_message_id: USER_CORRECTION_SOURCE_MESSAGE_ID,
        route: 'Codex Desktop + Codex-owned Computer Use/app-control into SquidRun surfaces',
        use_when: [
          'visual desktop or browser QA needs Codex eyes and interaction',
          'SquidRun app-control or Computer Use can operate the visible app instead of inventing a new message transport',
          'James needs Codex to inspect current UI state, screenshots, browser surfaces, or foreground app behavior',
        ],
        not_a_heartbeat: true,
      },
      hmCodexCapabilityStatus: capabilityStatusRoute,
      hmCodexAttention: {
        ...attentionRoute,
        active_count: attentionInbox.active_count,
        total_count: attentionInbox.total_count,
      },
      hmCodexDesktopTransport: desktopTransport,
    },
    freshness: {
      attentionInbox,
    },
    recommended_routes: [
      {
        id: 'hm_codex_capability_status',
        use_for: 'Discover current Codex Desktop/process route availability, app-control route, attention inbox counts, and desktop transport boundary.',
        command: capabilityStatusRoute.command,
      },
      {
        id: 'codex_desktop_computer_use_app_control',
        use_for: 'Visible app/browser/desktop QA, app-control work, screenshot-backed inspection, and foreground SquidRun interaction.',
        readiness_source: 'process availability plus current Codex agent session capability; dead legacy heartbeat files are not used.',
      },
      {
        id: 'hm_codex_desktop_transport',
        use_for: 'Probe or focus/summon a Codex workspace; not a visible thread injection path.',
        command: desktopTransport.command,
      },
    ],
    boundaries: [
      'Do not use the retired codex-heartbeat.json file as live Codex Desktop availability proof.',
      'Do not treat process presence or route definitions as proof of visible message injection.',
      'Do not claim local SquidRun can push a visible message into an already-running Codex Desktop thread unless a future supported hook proves it.',
      'Do not change credentials, OpenAI account state, relay settings, TrustQuote, or trading/account actions from this status path.',
    ],
  };
}

function renderCodexDesktopCapabilityMarkdown(status = {}) {
  const processAvailability = status.availability?.codexDesktopProcess || {};
  const appControl = status.availability?.computerUseAppControl || {};
  const inbox = status.freshness?.attentionInbox || {};
  const desktopTransport = status.availability?.hmCodexDesktopTransport || {};
  const statusLabel = status.status === 'process_available_not_monitored'
    ? 'available, not monitored'
    : (status.status || 'unknown');
  return [
    'CODEX DESKTOP CAPABILITY',
    `- Status: ${statusLabel}${statusLabel !== status.status && status.status ? ` (${status.status})` : ''}`,
    `- Process/App: ${processAvailability.status || 'unknown'} (processes=${Number(processAvailability.process_count || 0)}, visible_windows=${Number(processAvailability.visible_window_count || 0)})`,
    `- App-Control Route: ${appControl.status || 'unknown'} (source=${appControl.source_message_id || 'unknown'})`,
    `- Attention Inbox: active=${Number(inbox.active_count || 0)}, completed=${Number(inbox.completed_count || 0)}, total=${Number(inbox.total_count || 0)}, freshness=${inbox.polling_freshness || 'unknown'}`,
    `- Desktop Transport: summon=${desktopTransport.can_summon_workspace === true ? 'yes' : 'no'}, visible_injection=${desktopTransport.visible_injection_proven === true ? 'proven' : 'not_proven'}`,
    '- Tools: hm-codex-capability-status, hm-codex-desktop-transport',
    `- Boundary: ${Array.isArray(status.boundaries) && status.boundaries.length > 0 ? status.boundaries[0] : 'route availability and freshness are separate facts.'}`,
    '',
  ].join('\n');
}

function resolveStatusPath(options = {}) {
  if (toOptionalString(options.outPath, null)) return path.resolve(options.outPath);
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(DEFAULT_STATUS_RELATIVE_PATH, { forWrite: true });
  }
  return path.join(getProjectRoot(), '.squidrun', DEFAULT_STATUS_RELATIVE_PATH);
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath, payload) {
  ensureDirForFile(filePath);
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
  return filePath;
}

function writeStatusReport(payload, options = {}) {
  const statusPath = resolveStatusPath(options);
  writeJsonAtomic(statusPath, payload);
  return {
    ok: true,
    status_path: normalizePathForMetadata(statusPath),
  };
}

module.exports = {
  DEFAULT_INBOX_STALE_MINUTES,
  DEFAULT_STATUS_RELATIVE_PATH,
  STATUS_SCHEMA,
  USER_CORRECTION_SOURCE_MESSAGE_ID,
  buildCodexDesktopCapabilityStatus,
  defaultRunner,
  inspectAttentionInbox,
  inspectCodexProcessAvailability,
  renderCodexDesktopCapabilityMarkdown,
  resolveStatusPath,
  writeStatusReport,
};
