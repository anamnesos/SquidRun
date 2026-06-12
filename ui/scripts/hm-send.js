#!/usr/bin/env node
/**
 * hm-send: CLI tool for instant WebSocket messaging between agents
 * Usage: node hm-send.js <target> <message> [--role <role>] [--priority urgent]
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  LEGACY_ROLE_ALIASES,
  ROLE_ID_MAP,
  getSquidrunRoot,
  setProjectRoot,
  resolveCoordPath,
} = require('../config');
const {
  getActiveProfileName,
  getProfileWebSocketPort,
  isMainProfile,
  namespaceCoordRelPath,
  normalizeProfileName,
} = require('../profile');
const {
  appendCommsJournalEntry,
  queryCommsJournalEntries,
  closeCommsJournalStores,
} = require('../modules/main/comms-journal');
const { sendTelegram, sendTelegramPhoto, normalizeChatId } = require('./hm-telegram');
const { resolveCliWebSocketPort } = require('./hm-ws-port');
const { appendVoiceEgressMessage } = require('../modules/voice-broker');
const {
  detectPermissionAskViolation,
  appendPermissionAskViolation,
  appendPermissionAskBypass,
} = require('./hm-send-permission-guard');
const {
  detectContextLeakViolation,
  appendContextLeakViolation,
  appendContextLeakBypass,
} = require('./hm-send-context-leak-guard');
const {
  detectCoworkerLintViolation,
  appendCoworkerLintViolation,
  appendCoworkerLintBypass,
} = require('./hm-send-coworker-output-lint');
const {
  detectCommsLivenessViolation,
  appendCommsLivenessViolation,
} = require('./hm-comms-liveness-guard');
const {
  collectSurfaceCaptureEventRequests,
  detectSurfaceClaimGuardViolation,
} = require('./hm-send-surface-claim-guard');
const {
  buildOutboundMessageEnvelope,
  buildCanonicalEnvelopeMetadata,
  buildWebSocketDispatchMessage,
  buildTriggerFallbackDescriptor,
  buildSpecialTargetRequest,
} = require('../modules/comms/message-envelope');
const {
  appendBusTraceEvent,
  createPayloadFingerprint,
  getUtf8ByteLength,
} = require('../modules/bus-reliability-trace');
const { createBridgeClient } = require('../modules/bridge-client');
let parseCrossDeviceTarget = () => null;
let isCrossDeviceEnabled = () => false;
try {
  const cdt = require('../modules/cross-device-target');
  parseCrossDeviceTarget = cdt.parseCrossDeviceTarget;
  isCrossDeviceEnabled = cdt.isCrossDeviceEnabled;
} catch (e) {
  const missingCrossDeviceModule = e?.code === 'MODULE_NOT_FOUND'
    && String(e?.message || '').includes('cross-device-target');
  if (!missingCrossDeviceModule) {
    throw e;
  }
}

function inferProfileNameFromPathValue(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const normalized = text.replace(/\\/g, '/');
  const match = normalized.match(/\/\.squidrun\/profiles\/([^/]+)\/workspace(?:\/|$)/i);
  if (!match || !match[1]) return null;
  return normalizeProfileName(match[1]);
}

function resolveEffectiveProfileName(env = process.env, cwd = process.cwd(), context = null) {
  const envProfile = normalizeProfileName(env?.SQUIDRUN_PROFILE || '');
  if (!isMainProfile(envProfile)) return envProfile;
  const contextProfile = inferProfileNameFromPathValue(context?.projectPath);
  if (contextProfile && !isMainProfile(contextProfile)) return contextProfile;
  const cwdProfile = inferProfileNameFromPathValue(cwd);
  if (cwdProfile && !isMainProfile(cwdProfile)) return cwdProfile;
  return envProfile || 'main';
}

function resolveDefaultPort() {
  if (process.env.HM_SEND_PORT) return process.env.HM_SEND_PORT;
  try {
    const profilePort = resolveCliWebSocketPort({
      profileName: resolveEffectiveProfileName(process.env, process.cwd()),
      cwd: process.cwd(),
    });
    if (Number.isFinite(profilePort)) return String(profilePort);
  } catch {}
  return '9900';
}
const parsedPort = Number.parseInt(resolveDefaultPort(), 10);
const PORT = Number.isFinite(parsedPort) ? parsedPort : 9900;
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_HEALTH_TIMEOUT_MS = 500;
const TARGET_HEARTBEAT_STALE_MS = 60000;
const DEFAULT_TRIGGER_VERIFY_TIMEOUT_MS = Number.parseInt(
  process.env.SQUIDRUN_DELIVERY_VERIFY_TIMEOUT_MS || '7000',
  10
);
const DEFAULT_ACK_TIMEOUT_BUFFER_MS = Number.parseInt(
  process.env.HM_SEND_ACK_TIMEOUT_BUFFER_MS || '1500',
  10
);
const DEFAULT_ACK_TIMEOUT_MS = Math.max(
  1200,
  (Number.isFinite(DEFAULT_TRIGGER_VERIFY_TIMEOUT_MS) ? DEFAULT_TRIGGER_VERIFY_TIMEOUT_MS : 5000)
    + (Number.isFinite(DEFAULT_ACK_TIMEOUT_BUFFER_MS) ? DEFAULT_ACK_TIMEOUT_BUFFER_MS : 1500)
);
const AGENT_TO_AGENT_TARGETS = new Set(['architect', 'builder', 'oracle']);
const SURFACE_CAPTURE_VERIFY_PORT = Number.parseInt(
  process.env.HM_SEND_SURFACE_CAPTURE_VERIFY_PORT
    || process.env.HM_SEND_CAPTURE_PORT
    || process.env.HM_SEND_MAIN_PORT
    || String(resolveCliWebSocketPort({ profileName: 'main', cwd: process.cwd() })),
  10
);
const DEFAULT_DELIVERY_CHECK_TIMEOUT_MS = Number.parseInt(
  process.env.HM_SEND_DELIVERY_CHECK_TIMEOUT_MS || '1200',
  10
);
const DEFAULT_DELIVERY_CHECK_MAX_CHECKS = Number.parseInt(
  process.env.HM_SEND_DELIVERY_CHECK_MAX_CHECKS || '6',
  10
);
const DELIVERY_CHECK_RETRY_DELAY_MS = Number.parseInt(
  process.env.HM_SEND_DELIVERY_CHECK_RETRY_MS || '250',
  10
);
const FORCE_FALLBACK_ON_UNVERIFIED = process.env.HM_SEND_FORCE_FALLBACK_ON_UNVERIFIED === '1';
const DEFAULT_RETRIES = 3;
const MAX_RETRIES = 5;
const FALLBACK_MESSAGE_ID_PREFIX = '[HM-MESSAGE-ID:';
const SPECIAL_USER_TARGETS = new Set(['user', 'telegram']);
const INTERNAL_INBOX_TARGETS = new Set(['mira']);
const TRUSTQUOTE_PROFILE_NAME = 'trustquote';
const TRUSTQUOTE_ROUTE_OWNER_ID = 'trustquote-work-room-route-owner';
const TRUSTQUOTE_REVERSE_TARGETS = new Set(['architect']);
const TRUSTQUOTE_REVERSE_SOURCE_ROLES = new Set(['builder', 'oracle']);
const args = process.argv.slice(2);
const listDevicesMode = args.includes('--list-devices');
const DEFAULT_ROLE_BY_PANE = Object.freeze({
  '1': 'architect',
  '2': 'builder',
  '3': 'oracle',
});

if (!listDevicesMode && args.length < 2) {
  console.log('Usage: node hm-send.js <target> <message> [--role <role>] [--priority urgent]');
  console.log('   or: node hm-send.js <target> --file <message-file> [--role <role>] [--priority urgent]');
  console.log('   or: node hm-send.js <target> --stdin [--role <role>] [--priority urgent]');
  console.log('   or: node hm-send.js telegram --photo <image-path> [caption] [--role <role>] [--priority urgent]');
  console.log('   or: node hm-send.js --list-devices [--timeout <ms>] [--role <role>]');
  console.log('  target: paneId (1,2,3), role name (architect, builder, oracle), internal inbox (mira), user/telegram, or @<device>-arch');
  console.log('  message: text to send');
  console.log('  --photo: send a Telegram photo (telegram/user target only); message is used as caption');
  console.log('  --file: read full message body from a UTF-8 text file');
  console.log('  --stdin: read full message body from stdin (pipe or heredoc)');
  console.log('  --list-devices: query relay for connected cross-device peers');
  console.log('  --role: your role (for identification)');
  console.log('  --priority: normal or urgent');
  console.log(`  --timeout: ack timeout in ms (default: ${DEFAULT_ACK_TIMEOUT_MS})`);
  console.log('  --retries: retry count after first send (default: 3)');
  console.log('  --no-fallback: disable trigger file fallback');
  console.log('  --source-profile: explicitly pin sender profile for cross-profile architect routes');
  console.log('  --target-profile: route to a non-main profile/work-room without changing sender identity');
  console.log('  --bypass-guard: bypass outbound guardrails and log any would-block match');
  process.exit(1);
}

let target = listDevicesMode ? null : args[0];
const envPaneId = String(process.env.SQUIDRUN_PANE_ID || '').trim();
let role = normalizeRole(process.env.SQUIDRUN_ROLE || '') || DEFAULT_ROLE_BY_PANE[envPaneId] || 'cli';
let priority = 'normal';
let ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS;
let retries = DEFAULT_RETRIES;
let enableFallback = true;
let messageFilePath = null;
let resolvedMessageFilePath = null;
let cleanupMessageFilePathOnSuccess = null;
let useStdin = false;
let telegramPhotoPath = null;
let telegramChatIdOverride = null;
let sourceProfileOverride = null;
let sourceWindowKeyOverride = null;
let sourceSessionScopeIdOverride = null;
let targetProfileOverride = null;
let targetWindowKeyOverride = null;
let targetSessionScopeIdOverride = null;
let bypassGuard = String(process.env.HM_SEND_BYPASS_GUARD || '').trim() === '1';

// Known flags that signal end of inline message content.
// Words starting with "--" that are NOT in this set are treated as message text,
// which prevents accidental truncation when message content contains "--something".
const KNOWN_FLAGS = new Set([
  '--role', '--file', '--stdin', '--photo', '--priority', '--timeout', '--retries', '--no-fallback', '--list-devices', '--chat-id', '--source-profile', '--source-window', '--source-session', '--source-session-scope', '--target-profile', '--route-profile', '--target-window', '--target-session', '--target-session-scope', '--bypass-guard',
]);

function shouldCleanupMessageFile(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return false;
  const baseName = path.basename(filePath).toLowerCase();
  return /^tmp-.*\.txt$/i.test(baseName) || /^hm-msg-.*\.txt$/i.test(baseName);
}

process.on('exit', (code) => {
  if (Number(code) !== 0) return;
  if (!cleanupMessageFilePathOnSuccess) return;
  try {
    if (fs.existsSync(cleanupMessageFilePathOnSuccess)) {
      fs.unlinkSync(cleanupMessageFilePathOnSuccess);
    }
  } catch (_) {
    // Best-effort cleanup only.
  }
});

// Collect message from all args between target and first known --flag
// This handles PowerShell splitting quoted strings into multiple args
const messageParts = [];
let i = listDevicesMode ? 0 : 1;
for (; i < args.length; i++) {
  if (KNOWN_FLAGS.has(args[i])) break;
  messageParts.push(args[i]);
}

// Parse remaining --flags
for (; i < args.length; i++) {
  const token = args[i];
  if (token === '--role' && args[i + 1]) {
    role = args[i + 1];
    i++;
    continue;
  }
  if (token === '--file') {
    if (!args[i + 1]) {
      console.error('--file requires a file path.');
      process.exit(1);
    }
    messageFilePath = args[i + 1];
    i++;
    continue;
  }
  if (token === '--stdin') {
    useStdin = true;
    continue;
  }
  if (token === '--photo') {
    if (!args[i + 1]) {
      console.error('--photo requires an image path.');
      process.exit(1);
    }
    telegramPhotoPath = args[i + 1];
    i++;
    continue;
  }
  if (token === '--chat-id' && args[i + 1]) {
    telegramChatIdOverride = args[i + 1];
    i++;
    continue;
  }
  if (token === '--source-profile' && args[i + 1]) {
    sourceProfileOverride = normalizeProfileName(args[i + 1]);
    i++;
    continue;
  }
  if (token === '--source-window' && args[i + 1]) {
    sourceWindowKeyOverride = normalizeProfileName(args[i + 1]);
    i++;
    continue;
  }
  if ((token === '--source-session' || token === '--source-session-scope') && args[i + 1]) {
    sourceSessionScopeIdOverride = String(args[i + 1] || '').trim() || null;
    i++;
    continue;
  }
  if (token === '--priority' && args[i + 1]) {
    priority = args[i + 1];
    i++;
    continue;
  }
  if (token === '--timeout' && args[i + 1]) {
    const parsed = Number.parseInt(args[i + 1], 10);
    if (Number.isFinite(parsed) && parsed >= 10) {
      ackTimeoutMs = parsed;
    }
    i++;
    continue;
  }
  if (token === '--retries' && args[i + 1]) {
    const parsed = Number.parseInt(args[i + 1], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      retries = Math.min(parsed, MAX_RETRIES);
    }
    i++;
    continue;
  }
  if (token === '--no-fallback') {
    enableFallback = false;
    continue;
  }
  if ((token === '--target-profile' || token === '--route-profile') && args[i + 1]) {
    targetProfileOverride = normalizeProfileName(args[i + 1]);
    i++;
    continue;
  }
  if (token === '--target-window' && args[i + 1]) {
    targetWindowKeyOverride = normalizeProfileName(args[i + 1]);
    i++;
    continue;
  }
  if ((token === '--target-session' || token === '--target-session-scope') && args[i + 1]) {
    targetSessionScopeIdOverride = String(args[i + 1] || '').trim() || null;
    i++;
    continue;
  }
  if (token === '--bypass-guard') {
    bypassGuard = true;
    continue;
  }
  if (token === '--list-devices') {
    // Flag consumed here so list mode can coexist with other flags.
    continue;
  }
  messageParts.push(token);
}

let message = messageParts.join(' ');
if (!listDevicesMode && useStdin) {
  try {
    message = fs.readFileSync('/dev/stdin', 'utf8');
  } catch (err) {
    // Fallback for Windows where /dev/stdin may not exist
    try {
      message = fs.readFileSync(0, 'utf8');
    } catch (err2) {
      console.error(`Failed to read from stdin: ${err2.message}`);
      process.exit(1);
    }
  }
}
if (!listDevicesMode && messageFilePath) {
  resolvedMessageFilePath = path.resolve(messageFilePath);
  try {
    message = fs.readFileSync(resolvedMessageFilePath, 'utf8');
    if (shouldCleanupMessageFile(resolvedMessageFilePath)) {
      cleanupMessageFilePathOnSuccess = resolvedMessageFilePath;
    }
  } catch (err) {
    console.error(`Failed to read message file '${resolvedMessageFilePath}': ${err.message}`);
    process.exit(1);
  }
}
if (!listDevicesMode && telegramPhotoPath) {
  const normalizedTarget = String(target || '').trim().toLowerCase();
  if (!SPECIAL_USER_TARGETS.has(normalizedTarget)) {
    console.error('--photo is supported only for telegram/user targets.');
    process.exit(1);
  }
  telegramPhotoPath = path.resolve(telegramPhotoPath);
}
if (!listDevicesMode && !message && !telegramPhotoPath) {
  console.error('Message cannot be empty.');
  process.exit(1);
}

function inferRoleFromMessage(content) {
  if (typeof content !== 'string') return null;
  const match = content.match(/\(([A-Za-z-]+)(?:\s+#\d+)?\):/i);
  if (!match || !match[1]) return null;
  return normalizeRole(match[1]);
}

if (!listDevicesMode && role === 'cli') {
  const inferred = inferRoleFromMessage(message);
  if (inferred) {
    role = inferred;
  }
}

if (!listDevicesMode) {
  const backgroundRoutingOverride = enforceBackgroundBuilderTargetRouting(role, target);
  if (backgroundRoutingOverride.redirected) {
    console.warn(
      `Background-builder owner binding override: rerouted target `
      + `'${backgroundRoutingOverride.originalTarget}' to '${backgroundRoutingOverride.reroutedTarget}' `
      + `for sender role '${backgroundRoutingOverride.senderRole}'.`
    );
    target = backgroundRoutingOverride.reroutedTarget;
  }
}
const bridgeTarget = listDevicesMode ? null : parseCrossDeviceTarget(target);
if (bridgeTarget) {
  enableFallback = false;
}

function parseJSON(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch (_err) {
    return null;
  }
}

function readJsonFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function findNearestProjectLinkFile(startDir = process.cwd()) {
  let currentDir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(currentDir, '.squidrun', 'link.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function resolveProjectContextFromLink(startDir = process.cwd()) {
  const linkPath = findNearestProjectLinkFile(startDir);
  if (!linkPath) return null;

  const payload = readJsonFileSafe(linkPath);
  if (!payload || typeof payload !== 'object') return null;

  const fallbackProjectPath = path.resolve(path.join(path.dirname(linkPath), '..'));
  const workspaceValue = typeof payload.workspace === 'string'
    ? payload.workspace.trim()
    : '';
  const declaredProjectPath = workspaceValue
    ? path.resolve(workspaceValue)
    : fallbackProjectPath;
  const projectPath = (workspaceValue && !fs.existsSync(declaredProjectPath))
    ? fallbackProjectPath
    : declaredProjectPath;
  const sessionId = typeof payload.session_id === 'string'
    ? payload.session_id.trim()
    : (typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '');
  const squidrunRoot = (
    (typeof payload.squidrun_root === 'string' ? payload.squidrun_root.trim() : '')
    || (typeof payload.squidrunRoot === 'string' ? payload.squidrunRoot.trim() : '')
  );

  if (!projectPath) return null;

  return {
    source: 'link.json',
    linkPath,
    projectPath,
    projectName: path.basename(projectPath),
    sessionId: sessionId || null,
    squidrunRoot: squidrunRoot ? path.resolve(squidrunRoot) : null,
  };
}

function resolveProjectContextFromEnv(env = process.env) {
  const explicitProjectRoot = String(env?.SQUIDRUN_PROJECT_ROOT || '').trim();
  if (!explicitProjectRoot) return null;
  const projectPath = path.resolve(explicitProjectRoot);
  return {
    source: 'env',
    projectPath,
    projectName: path.basename(projectPath),
    squidrunRoot: null,
  };
}

function readProjectContextFromState() {
  const candidates = [];
  if (typeof resolveCoordPath === 'function') {
    candidates.push(resolveCoordPath('state.json'));
  }

  for (const candidate of candidates) {
    const parsed = readJsonFileSafe(candidate);
    const projectValue = typeof parsed?.project === 'string'
      ? parsed.project.trim()
      : '';
    if (!projectValue) continue;
    const projectPath = path.resolve(projectValue);
    return {
      source: 'state.json',
      statePath: candidate,
      projectPath,
      projectName: path.basename(projectPath),
    };
  }

  return null;
}

function isPathInside(parentDir, candidatePath) {
  if (!parentDir || !candidatePath) return false;
  const relativePath = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function shouldUseGlobalStateProjectContext(startDir = process.cwd()) {
  if (typeof getSquidrunRoot !== 'function') return false;
  try {
    const squidrunRoot = getSquidrunRoot();
    return Boolean(squidrunRoot && isPathInside(squidrunRoot, startDir));
  } catch (_) {
    return false;
  }
}

function resolveLocalProjectContext(startDir = process.cwd()) {
  const fromLink = resolveProjectContextFromLink(startDir);
  if (fromLink?.projectPath) return fromLink;

  const fromEnv = resolveProjectContextFromEnv(process.env);
  if (fromEnv?.projectPath) return fromEnv;

  // link.json is the canonical agent workspace bootstrap. state.json tracks
  // mutable UI project selection and can legitimately lag across sessions.
  if (shouldUseGlobalStateProjectContext(startDir)) {
    const fromState = readProjectContextFromState();
    if (fromState?.projectPath) return fromState;
  }

  const cwdPath = path.resolve(startDir);
  return {
    source: 'cwd',
    projectPath: cwdPath,
    projectName: path.basename(cwdPath),
  };
}

function applyProjectContext(projectContext = null) {
  if (!projectContext?.projectPath) return null;
  const explicitProjectRoot = String(process.env.SQUIDRUN_PROJECT_ROOT || '').trim();
  if (explicitProjectRoot) {
    return projectContext;
  }
  if (typeof setProjectRoot === 'function') {
    try {
      setProjectRoot(projectContext.projectPath);
    } catch (_) {
      // Best-effort only; keep hm-send resilient.
    }
  }
  return projectContext;
}

const localProjectContext = applyProjectContext(resolveLocalProjectContext(process.cwd()));
const effectiveProfileName = sourceProfileOverride
  || resolveEffectiveProfileName(process.env, process.cwd(), localProjectContext);

function getLocalCoordRoot(context = localProjectContext) {
  if (context?.projectPath) {
    return path.join(context.projectPath, '.squidrun');
  }
  return path.join(process.cwd(), '.squidrun');
}

function resolveLocalCoordPath(relativePath, options = {}) {
  const relPath = String(relativePath || '').trim();
  if (!relPath) return getLocalCoordRoot();
  const scopedRelPath = namespaceCoordRelPath(relPath, effectiveProfileName);
  const localCoordRoot = getLocalCoordRoot();
  const preferLocal = options.preferLocal !== false;
  if (preferLocal && localCoordRoot) {
    return path.join(localCoordRoot, scopedRelPath);
  }
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(relPath, options);
  }
  return path.join(localCoordRoot, scopedRelPath);
}

function resolveGuardLogPath(fileName) {
  return resolveLocalCoordPath(path.join('runtime', fileName), { forWrite: true });
}

function resolveLocalEvidenceLedgerDbPath() {
  const explicitDbPath = String(process.env.SQUIDRUN_COMMS_JOURNAL_DB_PATH || '').trim();
  if (explicitDbPath) return path.resolve(explicitDbPath);
  return resolveLocalCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true });
}

function queryLocalCommsJournalEntries(filters = {}, options = {}) {
  return queryCommsJournalEntries(filters, {
    ...options,
    dbPath: resolveLocalEvidenceLedgerDbPath(),
  });
}

function appendLocalCommsJournalEntry(entry = {}, options = {}) {
  return appendCommsJournalEntry(entry, {
    ...options,
    dbPath: resolveLocalEvidenceLedgerDbPath(),
  });
}

function writeGuardBlock(messageLines = []) {
  const lines = Array.isArray(messageLines) ? messageLines : [String(messageLines || '')];
  console.error('');
  for (const line of lines) {
    if (line) console.error(line);
  }
  console.error('');
}

function appendGuardJsonl(fileName, payload = {}) {
  const logPath = resolveGuardLogPath(fileName);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        ...payload,
      })}\n`,
      'utf8'
    );
    return { ok: true, path: logPath };
  } catch (err) {
    return { ok: false, path: logPath, error: err.message };
  }
}

function buildGuardBodyLogFields(content, maxChars = 500) {
  const text = String(content || '');
  const snippet = text.length > maxChars ? text.slice(0, maxChars) : text;
  return {
    bodySnippet: snippet,
    bodySha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    bodyBytes: Buffer.byteLength(text, 'utf8'),
    bodyTruncated: text.length > maxChars,
  };
}

function enrichSurfaceClaimGuardLog(payload = {}) {
  return {
    ...payload,
    ...buildGuardBodyLogFields(message),
  };
}

function buildCurrentRoleEvidenceTargets(senderRole) {
  const targets = new Set();
  const rawRole = String(senderRole || '').trim().toLowerCase();
  const normalizedRole = normalizeRole(rawRole) || normalizeBackgroundBuilderRole(rawRole) || rawRole;
  const add = (value) => {
    const text = String(value || '').trim().toLowerCase();
    if (text) targets.add(text);
  };

  add(rawRole);
  add(normalizedRole);
  add(resolvePaneIdForRole(normalizedRole));
  add(envPaneId);

  return targets;
}

function getCommsRowTimestampMs(row = {}) {
  for (const value of [row.brokeredAtMs, row.sentAtMs, row.updatedAtMs]) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

function detectTelegramUserTargetGuard({ messageId } = {}) {
  if (String(target || '').trim().toLowerCase() !== 'user') return null;

  const sessionId = normalizeSessionId(projectMetadata?.session_id || '');
  if (!sessionId) return null;

  const currentTargets = buildCurrentRoleEvidenceTargets(role || 'cli');
  if (currentTargets.size === 0) return null;

  let rows = [];
  try {
    rows = queryLocalCommsJournalEntries({
      sessionId,
      direction: 'inbound',
      senderRole: 'user',
      order: 'desc',
      limit: 500,
    });
  } catch (_) {
    return null;
  }

  const latestUserInboundForRole = rows.find((row) => {
    const rowSessionId = normalizeSessionId(row?.sessionId || '');
    if (rowSessionId !== sessionId) return false;
    const rowTimestampMs = getCommsRowTimestampMs(row);
    if (!rowTimestampMs) return false;

    const rawTarget = String(row?.targetRole || '').trim().toLowerCase();
    const normalizedTarget = normalizeRole(rawTarget) || normalizeBackgroundBuilderRole(rawTarget) || rawTarget;
    return currentTargets.has(rawTarget) || currentTargets.has(normalizedTarget);
  });

  const inboundMessageId = String(latestUserInboundForRole?.messageId || '');
  if (
    String(latestUserInboundForRole?.channel || '').toLowerCase() !== 'telegram'
    || !/^telegram-in-/i.test(inboundMessageId)
  ) {
    return null;
  }

  return {
    violation_class: 'telegram_user_target_requires_explicit_telegram',
    messageId,
    inboundMessageId: latestUserInboundForRole.messageId || null,
    inboundTargetRole: latestUserInboundForRole.targetRole || null,
    inboundAtMs: getCommsRowTimestampMs(latestUserInboundForRole) || null,
    sessionId,
    senderRole: role || 'cli',
    targetRaw: target,
  };
}

function readRecentUserInboundRows() {
  const sessionId = normalizeSessionId(projectMetadata?.session_id || '');
  if (!sessionId) return [];
  try {
    return queryLocalCommsJournalEntries({
      sessionId,
      direction: 'inbound',
      senderRole: 'user',
      order: 'desc',
      limit: 80,
    });
  } catch (_) {
    return [];
  }
}

function detectSurfaceClaimGuard({ messageId, targetRole, captureEventVerifier = null } = {}) {
  return detectSurfaceClaimGuardViolation({
    content: message,
    messageId,
    senderRole: role || 'cli',
    targetRole,
    targetRaw: target,
    sessionId: normalizeSessionId(projectMetadata?.session_id || ''),
    profile: effectiveProfileName,
    recentUserRows: readRecentUserInboundRows(),
    existsSync: fs.existsSync,
    captureEventVerifier,
  });
}

async function runOutputGuards({ messageId, targetRole } = {}) {
  const guardInput = {
    content: message,
    messageId,
    senderRole: role || 'cli',
    targetRole,
    targetRaw: target,
    profile: effectiveProfileName,
  };
  const normalizedGuardTarget = normalizeRole(targetRole) || normalizeRole(target);
  const captureEventVerifier = ['user', 'telegram'].includes(normalizedGuardTarget)
    ? await buildSurfaceCaptureEventVerifierForContent(message)
    : null;

  if (bypassGuard) {
    const surfaceClaimBypass = detectSurfaceClaimGuard({ messageId, targetRole, captureEventVerifier });
    if (surfaceClaimBypass) {
      appendGuardJsonl('surface-claim-bypasses.jsonl', {
        ...enrichSurfaceClaimGuardLog(surfaceClaimBypass),
        bypassReason: process.env.HM_SEND_BYPASS_GUARD === '1' ? 'env' : 'flag',
      });
    }

    const telegramUserTargetBypass = detectTelegramUserTargetGuard({ messageId });
    if (telegramUserTargetBypass) {
      appendGuardJsonl('telegram-user-target-bypasses.jsonl', {
        ...telegramUserTargetBypass,
        bypassReason: process.env.HM_SEND_BYPASS_GUARD === '1' ? 'env' : 'flag',
      });
    }

    const permissionBypass = detectPermissionAskViolation({
      ...guardInput,
      bypass: '0',
    });
    if (permissionBypass) {
      appendPermissionAskBypass(
        {
          ...permissionBypass,
          messageId,
          bypassReason: process.env.HM_SEND_BYPASS_GUARD === '1' ? 'env' : 'flag',
        },
        { logPath: resolveGuardLogPath('permission-ask-bypasses.jsonl') }
      );
    }

    const contextBypass = detectContextLeakViolation({
      ...guardInput,
      bypass: '0',
    });
    if (contextBypass) {
      appendContextLeakBypass(
        {
          ...contextBypass,
          messageId,
          bypassReason: process.env.HM_SEND_BYPASS_GUARD === '1' ? 'env' : 'flag',
        },
        { logPath: resolveGuardLogPath('context-leak-bypasses.jsonl') }
      );
    }

    const coworkerBypass = detectCoworkerLintViolation({
      ...guardInput,
      bypass: '0',
    });
    if (coworkerBypass) {
      appendCoworkerLintBypass(
        {
          ...coworkerBypass,
          messageId,
          bypassReason: process.env.HM_SEND_BYPASS_GUARD === '1' ? 'env' : 'flag',
        },
        { logPath: resolveGuardLogPath('coworker-lint-bypasses.jsonl') }
      );
    }

    const commsLivenessBypass = detectCommsLivenessViolation({
      ...guardInput,
      bypass: '0',
    });
    if (commsLivenessBypass) {
      appendCommsLivenessViolation(
        {
          ...commsLivenessBypass,
          messageId,
          bypassReason: process.env.HM_SEND_BYPASS_GUARD === '1' ? 'env' : 'flag',
        },
        { logPath: resolveGuardLogPath('comms-liveness-bypasses.jsonl') }
      );
    }

    return { ok: true, bypassed: true };
  }

  const surfaceClaimViolation = detectSurfaceClaimGuard({ messageId, targetRole, captureEventVerifier });
  if (surfaceClaimViolation) {
    const surfaceClaimLogPayload = enrichSurfaceClaimGuardLog(surfaceClaimViolation);
    const logResult = appendGuardJsonl('surface-claim-violations.jsonl', surfaceClaimLogPayload);
    if (surfaceClaimViolation.violation_class === 'james_repeat_requires_surface_concession') {
      writeGuardBlock([
        'BLOCKED: James repeated the same unresolved point.',
        'Concede/name the unresolved surface first, or include a fresh visible-pane-submit artifact from the surface James can inspect.',
        'This blocks claims/status only; focus windows, run visible harnesses, inspect surfaces, and fix reversible route bugs directly.',
        `Log: ${logResult.path}`,
      ]);
    } else if (surfaceClaimViolation.violation_class === 'surface_done_claim_without_artifact') {
      writeGuardBlock([
        'BLOCKED: user-facing done/visible claim has no fresh visible-pane-submit artifact.',
        'Include a fresh visible-pane-submit screenshot artifact path from the surface James can inspect, or say the real thing is not visible yet.',
        'This blocks the claim, not the work needed to make it true.',
        `Log: ${logResult.path}`,
      ]);
    } else if (surfaceClaimViolation.violation_class === 'substitute_as_surface_proof') {
      writeGuardBlock([
        'BLOCKED: local/emulator/private/demo surface is being used as proof for James-visible or production reality.',
        'Use the real surface, or say the substitute does not count before doing substitute work.',
        'This blocks the substitute claim/instruction, not reversible action on the real surface.',
        `Log: ${logResult.path}`,
      ]);
    } else {
      writeGuardBlock([
        `BLOCKED: surface-claim-guard '${surfaceClaimViolation.violation_class || 'violation'}'.`,
        `Log: ${logResult.path}`,
      ]);
    }
    return { ok: false, type: 'surface_claim', violation: surfaceClaimViolation };
  }

  const telegramUserTargetViolation = detectTelegramUserTargetGuard({ messageId });
  if (telegramUserTargetViolation) {
    const logResult = appendGuardJsonl('telegram-user-target-violations.jsonl', telegramUserTargetViolation);
    writeGuardBlock([
      'BLOCKED: current-session Telegram inbound detected.',
      "Use explicit target 'telegram' instead of ambiguous target 'user' so the reply egresses to Telegram.",
      `Latest inbound: ${telegramUserTargetViolation.inboundMessageId || 'unknown'} -> ${telegramUserTargetViolation.inboundTargetRole || 'unknown'}`,
      'Intentional bypass: add --bypass-guard and accept the logged same-channel risk.',
      `Log: ${logResult.path}`,
    ]);
    return { ok: false, type: 'telegram_user_target', violation: telegramUserTargetViolation };
  }

  const permissionViolation = detectPermissionAskViolation({
    ...guardInput,
    bypass: '0',
  });
  if (permissionViolation) {
    const permissionWarnOnly = AGENT_TO_AGENT_TARGETS.has(normalizedGuardTarget);
    const logResult = appendPermissionAskViolation(
      {
        ...permissionViolation,
        messageId,
        enforcement_mode: permissionWarnOnly ? 'soft_warn' : 'hard_block',
      },
      { logPath: resolveGuardLogPath('permission-ask-violations.jsonl') }
    );
    if (permissionWarnOnly) {
      writeGuardBlock([
        `WARN: permission-ask phrase detected '${permissionViolation.phrase}' for agent-to-agent send - logged, send continuing.`,
        'User-facing targets still hard-block permission asks.',
        `Log: ${logResult.path}`,
      ]);
    } else {
      writeGuardBlock([
        `BLOCKED: permission-ask phrase detected '${permissionViolation.phrase}'. Rewrite as a decision.`,
        `Log: ${logResult.path}`,
      ]);
      return { ok: false, type: 'permission_ask', violation: permissionViolation };
    }
  }

  const coworkerLintViolation = detectCoworkerLintViolation({
    ...guardInput,
    bypass: '0',
  });
  if (coworkerLintViolation) {
    const logResult = appendCoworkerLintViolation(
      {
        ...coworkerLintViolation,
        messageId,
      },
      { logPath: resolveGuardLogPath('coworker-lint-violations.jsonl') }
    );
    writeGuardBlock([
      `WARN: coworker-output-lint '${coworkerLintViolation.violation_class}' opener '${coworkerLintViolation.phrase}' — logged, send continuing.`,
      'Agent-to-agent style lint is warn-only; user-facing permission asks still hard-block.',
      `Log: ${logResult.path}`,
    ]);
  }

  const commsLivenessViolation = detectCommsLivenessViolation({
    ...guardInput,
    bypass: '0',
  });
  if (commsLivenessViolation) {
    const logResult = appendCommsLivenessViolation(
      {
        ...commsLivenessViolation,
        messageId,
      },
      { logPath: resolveGuardLogPath('comms-liveness-violations.jsonl') }
    );
    writeGuardBlock([
      `WARN: comms-liveness '${commsLivenessViolation.violation_class}' phrase '${commsLivenessViolation.phrase}' - logged, send continuing.`,
      'Smoke alarm only: the human wrapper is reading dead. Add the emotion the moment actually earned; do not fake a profanity quota.',
      `Log: ${logResult.path}`,
    ]);
  }

  const contextViolation = detectContextLeakViolation({
    ...guardInput,
    bypass: '0',
  });
  if (contextViolation) {
    const logResult = appendContextLeakViolation(
      {
        ...contextViolation,
        messageId,
      },
      { logPath: resolveGuardLogPath('context-leak-violations.jsonl') }
    );
    writeGuardBlock([
      'BLOCKED: Scoped/case context in main pane. This belongs in the Scoped window.',
      `Phrase: '${contextViolation.phrase}'`,
      `Log: ${logResult.path}`,
    ]);
    return { ok: false, type: 'context_leak', violation: contextViolation };
  }

  return { ok: true };
}

function normalizeSessionId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^app-session-/i.test(text)) return text;
  if (/^\d+$/.test(text)) return `app-session-${text}`;
  return text;
}

function looksLikeAppSessionId(value) {
  return /^app-session-/i.test(String(value || '').trim());
}

function looksLikeLegacyBootstrapSessionId(value) {
  return /^app-\d+-\d+$/i.test(String(value || '').trim());
}

function resolveCurrentSessionId(context = localProjectContext) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (candidatePath) => {
    if (!candidatePath) return;
    const resolved = path.resolve(candidatePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push(resolved);
  };

  if (context?.squidrunRoot) {
    addCandidate(path.join(context.squidrunRoot, '.squidrun', 'app-status.json'));
  }
  if (context?.projectPath) {
    addCandidate(path.join(context.projectPath, '.squidrun', 'app-status.json'));
  }
  if (typeof getSquidrunRoot === 'function') {
    try {
      const root = getSquidrunRoot();
      if (root) {
        addCandidate(path.join(root, '.squidrun', 'app-status.json'));
      }
    } catch (_) {
      // best-effort lookup only
    }
  }
  if (typeof resolveCoordPath === 'function') {
    addCandidate(resolveCoordPath('app-status.json'));
  }

  for (const candidate of candidates) {
    const parsed = readJsonFileSafe(candidate);
    if (!parsed || typeof parsed !== 'object') continue;
    const rawSession = parsed.session_id ?? parsed.sessionId ?? parsed.session ?? parsed.sessionNumber;
    const normalized = normalizeSessionId(rawSession);
    if (normalized) return normalized;
  }
  return null;
}

function chooseSessionId(linkSessionId, runtimeSessionId) {
  const normalizedLinkSessionId = normalizeSessionId(linkSessionId);
  const normalizedRuntimeSessionId = normalizeSessionId(runtimeSessionId);
  if (!normalizedLinkSessionId) return normalizedRuntimeSessionId;
  if (!normalizedRuntimeSessionId) return normalizedLinkSessionId;
  if (
    looksLikeAppSessionId(normalizedRuntimeSessionId)
    && looksLikeLegacyBootstrapSessionId(normalizedLinkSessionId)
  ) {
    return normalizedRuntimeSessionId;
  }
  if (
    looksLikeAppSessionId(normalizedLinkSessionId)
    && looksLikeAppSessionId(normalizedRuntimeSessionId)
    && normalizedLinkSessionId !== normalizedRuntimeSessionId
  ) {
    return normalizedRuntimeSessionId;
  }
  return normalizedLinkSessionId;
}

function getExplicitSessionScopeId(env = process.env) {
  return normalizeSessionId(sourceSessionScopeIdOverride || env?.SQUIDRUN_SESSION_SCOPE_ID || env?.SQUIDRUN_SESSION_ID || '');
}

function scopeSessionIdForEffectiveProfile(sessionId, profileName = effectiveProfileName) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return null;
  if (normalizeProfileName(profileName) !== TRUSTQUOTE_PROFILE_NAME) return normalizedSessionId;
  if (normalizedSessionId.endsWith(`:${TRUSTQUOTE_PROFILE_NAME}`)) return normalizedSessionId;
  return `${normalizedSessionId}:${TRUSTQUOTE_PROFILE_NAME}`;
}

function buildProjectMetadata(context = localProjectContext) {
  if (!context?.projectPath) return null;
  const projectPath = String(context.projectPath || '').trim();
  const projectName = String(context.projectName || path.basename(projectPath) || '').trim();
  const explicitSessionScopeId = getExplicitSessionScopeId();
  const sessionId = explicitSessionScopeId || chooseSessionId(
    typeof context.sessionId === 'string' ? context.sessionId.trim() : '',
    resolveCurrentSessionId(context)
  );
  if (!projectPath && !projectName) return null;
  return {
    name: projectName || null,
    path: projectPath || null,
    session_id: scopeSessionIdForEffectiveProfile(sessionId) || null,
    source: String(context.source || 'unknown'),
  };
}

const projectMetadata = buildProjectMetadata(localProjectContext);

function buildTargetProfileRouteContext() {
  const profileName = normalizeProfileName(targetProfileOverride || '');
  const senderProfileName = normalizeProfileName(effectiveProfileName);
  if (!targetProfileOverride) return null;
  if (isMainProfile(profileName) && isMainProfile(senderProfileName)) return null;
  const windowKey = normalizeProfileName(targetWindowKeyOverride || profileName);
  const sessionScopeId = targetSessionScopeIdOverride
    || (profileName === TRUSTQUOTE_PROFILE_NAME
      ? scopeSessionIdForEffectiveProfile(projectMetadata?.session_id || getExplicitSessionScopeId(), profileName)
      : null);
  return {
    port: process.env.HM_SEND_PORT ? PORT : getProfileWebSocketPort(profileName),
    targetProfileName: profileName,
    metadata: {
      routing: {
        profileName,
        windowKey,
        ...(sessionScopeId ? { sessionScopeId } : {}),
      },
    },
  };
}

const targetProfileRouteContext = buildTargetProfileRouteContext();

function buildProfileRouteAttributionMetadata(targetRole, routeContext = null) {
  if (!routeContext && isMainProfile(effectiveProfileName)) return null;
  const sourceProfileName = normalizeProfileName(effectiveProfileName || 'main');
  const sourceWindowKey = normalizeProfileName(
    sourceWindowKeyOverride
    || process.env.SQUIDRUN_WINDOW_KEY
    || sourceProfileName
  );
  const targetProfileName = normalizeProfileName(routeContext?.targetProfileName || sourceProfileName);
  const targetWindowKey = normalizeProfileName(
    routeContext?.metadata?.routing?.windowKey
    || targetProfileName
  );
  const sourceRole = normalizeRole(role) || String(role || 'cli').trim().toLowerCase() || 'cli';
  const normalizedTargetRole = normalizeRole(targetRole)
    || String(targetRole || target || 'unknown').trim().toLowerCase()
    || 'unknown';
  const sourceSessionScopeId = projectMetadata?.session_id || null;
  const targetSessionScopeId = routeContext?.metadata?.routing?.sessionScopeId || null;

  return {
    sourceAddress: `${sourceRole}@${sourceWindowKey}`,
    targetAddress: `${normalizedTargetRole}@${targetWindowKey}`,
    routeAttribution: {
      sourceProfileName,
      sourceWindowKey,
      sourceSessionScopeId,
      sourceAddress: `${sourceRole}@${sourceWindowKey}`,
      targetProfileName,
      targetWindowKey,
      targetSessionScopeId,
      targetAddress: `${normalizedTargetRole}@${targetWindowKey}`,
    },
  };
}

function buildRegisterPayload(envelope = null, options = {}) {
  const registerOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const profileName = normalizeProfileName(registerOptions.profileName || effectiveProfileName);
  const windowKey = normalizeProfileName(registerOptions.windowKey || sourceWindowKeyOverride || profileName);
  const sessionScopeId = Object.prototype.hasOwnProperty.call(registerOptions, 'sessionScopeId')
    ? registerOptions.sessionScopeId
    : (envelope?.session_id || projectMetadata?.session_id || null);
  return {
    type: 'register',
    role: registerOptions.role || role,
    profileName,
    windowKey,
    sessionScopeId,
  };
}

function getTrustQuoteReverseMainPort() {
  const explicit = Number.parseInt(
    String(process.env.HM_SEND_TRUSTQUOTE_REVERSE_PORT || process.env.HM_SEND_MAIN_PORT || ''),
    10
  );
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return resolveCliWebSocketPort({ profileName: 'main', cwd: process.cwd() });
}

function getTrustQuoteSourcePaneId(sourceRole) {
  const envPane = String(process.env.SQUIDRUN_PANE_ID || '').trim();
  if (envPane) return envPane;
  if (sourceRole === 'builder') return 'trustquote-builder';
  if (sourceRole === 'oracle') return 'trustquote-oracle';
  return null;
}

function formatTrustQuoteReverseContent(content, sourceRole) {
  const text = String(content || '');
  const normalizedRole = normalizeRole(sourceRole);
  if (!TRUSTQUOTE_REVERSE_SOURCE_ROLES.has(normalizedRole)) return text;
  if (/^\(TRUSTQUOTE-(?:BUILDER|ORACLE)(?:\s+#[^)]+)?\):/i.test(text.trimStart())) {
    return text;
  }
  const roleLabel = normalizedRole.toUpperCase();
  const replaced = text.replace(
    new RegExp(`^\\((${roleLabel})([^)]*)\\):`, 'i'),
    `(TRUSTQUOTE-${roleLabel}$2):`
  );
  if (replaced !== text) return replaced;
  return `(TRUSTQUOTE-${roleLabel}): ${text}`;
}

function buildTrustQuoteReverseRouteContext(targetRole) {
  const normalizedSourceRole = normalizeRole(role);
  if (normalizeProfileName(effectiveProfileName) !== TRUSTQUOTE_PROFILE_NAME) return null;
  if (!TRUSTQUOTE_REVERSE_TARGETS.has(targetRole)) return null;
  if (!TRUSTQUOTE_REVERSE_SOURCE_ROLES.has(normalizedSourceRole)) return null;

  const sourcePaneId = getTrustQuoteSourcePaneId(normalizedSourceRole);
  const sessionScopeId = String(process.env.SQUIDRUN_SESSION_SCOPE_ID || projectMetadata?.session_id || '').trim() || null;
  const sourceProjectPath = String(projectMetadata?.path || process.env.SQUIDRUN_PROJECT_ROOT || '').trim() || null;
  return {
    port: getTrustQuoteReverseMainPort(),
    register: {
      profileName: 'main',
      windowKey: 'main',
      sessionScopeId: null,
      role: normalizedSourceRole,
    },
    metadata: {
      sender: {
        role: normalizedSourceRole,
        roomRole: normalizedSourceRole,
        profileName: TRUSTQUOTE_PROFILE_NAME,
        windowKey: TRUSTQUOTE_PROFILE_NAME,
        paneId: sourcePaneId,
        terminalPaneId: sourcePaneId,
      },
      room: {
        id: TRUSTQUOTE_PROFILE_NAME,
        sourceRoomId: TRUSTQUOTE_PROFILE_NAME,
        sourceWindowKey: TRUSTQUOTE_PROFILE_NAME,
        sourceProjectPath,
        targetRoomId: 'main',
        targetRole: 'architect',
        visibility: 'cross_room_summary',
        sessionScopeId,
        dispatch: 'trustquote_reverse_relay',
      },
      trustQuoteReverseRelay: {
        sourceProfile: TRUSTQUOTE_PROFILE_NAME,
        sourceWindowKey: TRUSTQUOTE_PROFILE_NAME,
        sourceRole: normalizedSourceRole,
        sourcePaneId,
        targetProfile: 'main',
        targetRole: 'architect',
        sessionScopeId,
      },
    },
  };
}

function mergeDispatchMetadata(baseMetadata = {}, extraMetadata = null) {
  if (!extraMetadata || typeof extraMetadata !== 'object' || Array.isArray(extraMetadata)) {
    return baseMetadata;
  }
  return {
    ...baseMetadata,
    ...extraMetadata,
    sender: {
      ...(baseMetadata.sender && typeof baseMetadata.sender === 'object' ? baseMetadata.sender : {}),
      ...(extraMetadata.sender && typeof extraMetadata.sender === 'object' ? extraMetadata.sender : {}),
    },
  };
}

function writeJsonAtomic(filePath, payload) {
  try {
    const dirPath = path.dirname(filePath);
    fs.mkdirSync(dirPath, { recursive: true });
    const tempPath = path.join(
      dirPath,
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getBridgeKnownDevicesCachePath() {
  return resolveLocalCoordPath(path.join('bridge', 'known-devices.json'), { forWrite: true });
}

function normalizeDeviceDiscoveryEntry(input = {}) {
  const entry = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const deviceId = String(entry.device_id || entry.deviceId || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!deviceId) return null;
  const rolesRaw = Array.isArray(entry.roles) ? entry.roles : [];
  const roles = Array.from(new Set(
    rolesRaw
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  )).sort();
  const connectedSince = String(entry.connected_since || entry.connectedSince || '').trim() || null;
  return {
    device_id: deviceId,
    roles,
    connected_since: connectedSince,
  };
}

function normalizeDiscoveredDevices(input) {
  if (!Array.isArray(input)) return [];
  const deduped = new Map();
  for (const entry of input) {
    const normalized = normalizeDeviceDiscoveryEntry(entry);
    if (!normalized) continue;
    deduped.set(normalized.device_id, normalized);
  }
  return Array.from(deduped.values()).sort((a, b) => a.device_id.localeCompare(b.device_id));
}

function formatCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return text.trim() || '-';
}

function printDeviceDiscoveryTable(devices = [], options = {}) {
  const normalizedDevices = normalizeDiscoveredDevices(devices);
  const fetchedAt = String(options.fetchedAt || '').trim();
  const cached = options.cached === true;
  const headerBits = ['Online devices'];
  if (cached) headerBits.push('(cached)');
  if (fetchedAt) headerBits.push(`updated ${fetchedAt}`);
  console.log(`${headerBits.join(' ')}`);

  const columns = [
    { key: 'device_id', label: 'DEVICE_ID' },
    { key: 'roles', label: 'ROLES' },
    { key: 'connected_since', label: 'CONNECTED_SINCE' },
  ];
  const rows = normalizedDevices.map((device) => ({
    device_id: formatCell(device.device_id),
    roles: formatCell(Array.isArray(device.roles) ? device.roles.join(', ') : ''),
    connected_since: formatCell(device.connected_since),
  }));
  const widths = columns.map((column) => {
    const rowMax = rows.reduce((max, row) => Math.max(max, String(row[column.key]).length), 0);
    return Math.max(column.label.length, rowMax);
  });
  const header = columns
    .map((column, index) => column.label.padEnd(widths[index]))
    .join('  ');
  console.log(header);
  const separator = widths.map((width) => '-'.repeat(width)).join('  ');
  console.log(separator);
  for (const row of rows) {
    console.log(columns.map((column, index) => String(row[column.key]).padEnd(widths[index])).join('  '));
  }
  if (rows.length === 0) {
    console.log('(no devices)');
  }
}

async function waitForBridgeReady(client, timeoutMs) {
  const deadline = Date.now() + Math.max(500, timeoutMs);
  while (Date.now() < deadline) {
    if (client.isReady()) return true;
    await sleep(50);
  }
  return false;
}

function readDeviceCache(cachePath) {
  const payload = readJsonFileSafe(cachePath);
  if (!payload || typeof payload !== 'object') return null;
  const updatedAt = String(payload.updated_at || payload.updatedAt || '').trim();
  const devices = normalizeDiscoveredDevices(payload.devices);
  if (!updatedAt && devices.length === 0) return null;
  return {
    updatedAt: updatedAt || null,
    devices,
  };
}

function writeDeviceCache(cachePath, devices) {
  const payload = {
    updated_at: new Date().toISOString(),
    source: 'relay',
    devices: normalizeDiscoveredDevices(devices),
  };
  const result = writeJsonAtomic(cachePath, payload);
  if (!result.ok) {
    console.warn(`Failed to update device cache: ${result.error}`);
  }
  return payload;
}

async function runListDevicesMode() {
  const cachePath = getBridgeKnownDevicesCachePath();
  const runtimeDiscovery = await runListDevicesViaRuntimeBridge();
  if (runtimeDiscovery?.ok) {
    const normalizedDevices = normalizeDiscoveredDevices(runtimeDiscovery.devices);
    const cachePayload = writeDeviceCache(cachePath, normalizedDevices);
    printDeviceDiscoveryTable(normalizedDevices, {
      cached: false,
      fetchedAt: cachePayload.updated_at,
    });
    return { ok: true, cached: false };
  }

  const relayUrl = String(process.env.SQUIDRUN_RELAY_URL || '').trim();
  const deviceId = String(process.env.SQUIDRUN_DEVICE_ID || '').trim();
  const sharedSecret = String(process.env.SQUIDRUN_RELAY_SECRET || '').trim();

  if (!relayUrl || !deviceId || !sharedSecret || !isCrossDeviceEnabled(process.env)) {
    const cached = readDeviceCache(cachePath);
    if (cached) {
      printDeviceDiscoveryTable(cached.devices, {
        cached: true,
        fetchedAt: cached.updatedAt || 'unknown',
      });
      return { ok: true, cached: true };
    }
    const missing = [];
    if (!isCrossDeviceEnabled(process.env)) missing.push('SQUIDRUN_CROSS_DEVICE=1');
    if (!relayUrl) missing.push('SQUIDRUN_RELAY_URL');
    if (!deviceId) missing.push('SQUIDRUN_DEVICE_ID');
    if (!sharedSecret) missing.push('SQUIDRUN_RELAY_SECRET');
    return {
      ok: false,
      error: `Bridge discovery unavailable (${missing.join(', ')})`,
    };
  }

  const bridgeClient = createBridgeClient({
    relayUrl,
    deviceId,
    sharedSecret,
    availableRoles: ['architect'],
  });

  try {
    if (!bridgeClient.start()) {
      throw new Error('Bridge client failed to start');
    }
    const ready = await waitForBridgeReady(bridgeClient, ackTimeoutMs);
    if (!ready) {
      throw new Error('Relay connection timeout');
    }
    const discovery = await bridgeClient.discoverDevices({ timeoutMs: ackTimeoutMs });
    if (!discovery?.ok) {
      throw new Error(discovery?.error || discovery?.status || 'discovery_failed');
    }
    const normalizedDevices = normalizeDiscoveredDevices(discovery.devices);
    const cachePayload = writeDeviceCache(cachePath, normalizedDevices);
    printDeviceDiscoveryTable(normalizedDevices, {
      cached: false,
      fetchedAt: cachePayload.updated_at,
    });
    return { ok: true, cached: false };
  } catch (err) {
    const cached = readDeviceCache(cachePath);
    if (cached) {
      printDeviceDiscoveryTable(cached.devices, {
        cached: true,
        fetchedAt: cached.updatedAt || 'unknown',
      });
      console.warn(`Relay discovery failed (${err.message}). Showing cached results.`);
      return { ok: true, cached: true };
    }
    return { ok: false, error: `Relay discovery failed: ${err.message}` };
  } finally {
    bridgeClient.stop();
  }
}

async function runListDevicesViaRuntimeBridge() {
  const socketUrl = `ws://127.0.0.1:${PORT}`;
  let ws = null;
  const requestId = `bridge-discovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    ws = new WebSocket(socketUrl);
    await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');

    ws.send(JSON.stringify(buildRegisterPayload()));
    await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

    ws.send(JSON.stringify({
      type: 'bridge-discovery',
      requestId,
      timeoutMs: ackTimeoutMs,
    }));

    const response = await waitForMatch(
      ws,
      (msg) => msg.type === 'response' && msg.requestId === requestId,
      Math.max(ackTimeoutMs + 500, DEFAULT_CONNECT_TIMEOUT_MS),
      'Bridge discovery timeout'
    );

    const result = (response && typeof response.result === 'object') ? response.result : null;
    if (response?.ok !== true || !result) {
      return { ok: false };
    }
    if (result.ok !== true) {
      return {
        ok: false,
        error: result.error || result.status || 'discovery_failed',
      };
    }
    return {
      ok: true,
      devices: result.devices,
      fetchedAt: result.fetchedAt || Date.now(),
    };
  } catch (_err) {
    return { ok: false };
  } finally {
    if (ws) {
      await closeSocket(ws);
    }
  }
}

function waitForMatch(ws, predicate, timeoutMs, timeoutLabel) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutLabel || 'Timed out waiting for socket response'));
    }, timeoutMs);

    const onMessage = (raw) => {
      const msg = parseJSON(raw);
      if (!msg) return;
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('Socket closed before response'));
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    function cleanup() {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

function closeSocket(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === ws.CLOSED) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      try {
        ws.terminate();
      } catch (_err) {
        // no-op
      }
      resolve();
    }, 250);

    ws.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });

    try {
      ws.close();
    } catch (_err) {
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function verifySurfaceCaptureEventViaRuntime(request = {}) {
  const port = Number.isFinite(SURFACE_CAPTURE_VERIFY_PORT)
    ? SURFACE_CAPTURE_VERIFY_PORT
    : resolveCliWebSocketPort({ profileName: 'main', cwd: process.cwd() });
  const socketUrl = `ws://127.0.0.1:${port}`;
  const requestId = `surface-capture-event-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let ws = null;
  try {
    ws = new WebSocket(socketUrl);
    await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');
    ws.send(JSON.stringify({
      type: 'register',
      role: role || 'cli',
      profileName: 'main',
      windowKey: 'main',
    }));
    await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');
    ws.send(JSON.stringify({
      type: 'surface-capture-event-verify',
      requestId,
      payload: request,
    }));
    const response = await waitForMatch(
      ws,
      (msg) => msg.type === 'response' && msg.requestId === requestId,
      Math.max(ackTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
      'Surface capture event verification timeout'
    );
    if (response?.ok === false) {
      return { ok: false, reason: response.error || 'surface_capture_event_runtime_rejected' };
    }
    return response?.result && typeof response.result === 'object'
      ? response.result
      : { ok: false, reason: 'surface_capture_event_runtime_invalid_response' };
  } catch (err) {
    return { ok: false, reason: 'surface_capture_event_runtime_unavailable', error: err.message };
  } finally {
    if (ws) await closeSocket(ws);
  }
}

async function buildSurfaceCaptureEventVerifierForContent(content) {
  const requests = collectSurfaceCaptureEventRequests(content);
  if (!requests.length) return () => ({ ok: false, reason: 'surface_capture_event_not_requested' });
  const results = new Map();
  for (const request of requests) {
    const key = `${request.eventId}|${path.resolve(request.screenshotPath || '')}`;
    results.set(key, await verifySurfaceCaptureEventViaRuntime(request));
  }
  return (request = {}) => {
    const key = `${request.eventId}|${path.resolve(request.screenshotPath || '')}`;
    return results.get(key) || { ok: false, reason: 'surface_capture_event_not_verified' };
  };
}

function normalizeRole(targetInput) {
  const paneToRole = {
    '1': 'architect',
    '2': 'builder',
    '3': 'oracle',
  };

  const targetValue = String(targetInput || '').trim().toLowerCase();
  if (!targetValue) return null;

  const backgroundRole = normalizeBackgroundBuilderRole(targetValue);
  if (backgroundRole) return backgroundRole;

  if (paneToRole[targetValue]) return paneToRole[targetValue];

  if (targetValue === 'architect' || targetValue === 'builder' || targetValue === 'oracle') {
    return targetValue;
  }

  if (INTERNAL_INBOX_TARGETS.has(targetValue)) {
    return targetValue;
  }

  if (LEGACY_ROLE_ALIASES[targetValue]) {
    return LEGACY_ROLE_ALIASES[targetValue];
  }

  const mappedPane = ROLE_ID_MAP[targetValue];
  if (mappedPane && paneToRole[String(mappedPane)]) {
    return paneToRole[String(mappedPane)];
  }

  return null;
}

function resolvePaneIdForRole(roleName) {
  const normalized = String(roleName || '').trim().toLowerCase();
  if (normalized === 'architect') return '1';
  if (normalized === 'builder') return '2';
  if (normalized === 'oracle') return '3';
  const backgroundMatch = normalized.match(/^builder-bg-(\d+)$/);
  if (backgroundMatch && backgroundMatch[1]) {
    return `bg-2-${backgroundMatch[1]}`;
  }
  return null;
}

function normalizeBackgroundBuilderRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (/^builder-bg-\d+$/.test(normalized)) return normalized;
  const paneMatch = normalized.match(/^bg-2-(\d+)$/);
  if (paneMatch && paneMatch[1]) return `builder-bg-${paneMatch[1]}`;
  return null;
}

function enforceBackgroundBuilderTargetRouting(senderRole, targetInput) {
  const normalizedSenderRole = normalizeBackgroundBuilderRole(senderRole);
  if (!normalizedSenderRole) {
    return { redirected: false, senderRole: null, originalTarget: targetInput, reroutedTarget: targetInput };
  }
  const normalizedTargetRole = normalizeRole(targetInput);
  if (normalizedTargetRole === 'architect') {
    return {
      redirected: true,
      senderRole: normalizedSenderRole,
      originalTarget: targetInput,
      reroutedTarget: 'builder',
    };
  }
  return {
    redirected: false,
    senderRole: normalizedSenderRole,
    originalTarget: targetInput,
    reroutedTarget: targetInput,
  };
}

function isSpecialTarget(targetInput) {
  const normalized = String(targetInput || '').trim().toLowerCase();
  return SPECIAL_USER_TARGETS.has(normalized);
}

function isMiraInboxTarget(targetInput) {
  const normalized = String(targetInput || '').trim().toLowerCase();
  return normalized === 'mira';
}

function isExplicitTelegramTarget(targetInput) {
  return String(targetInput || '').trim().toLowerCase() === 'telegram';
}

function metadataIndicatesTelegramOrigin(metadata = null) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const values = [
    metadata.source,
    metadata.routeSource,
    metadata.origin,
    metadata.channel,
    metadata.routeMethod,
    metadata?.project?.source,
    metadata?.envelope?.project?.source,
    metadata?.envelope?.target?.raw,
    metadata?.envelope?.target?.role,
  ];
  if (metadata.telegram || metadata.replyContext || metadata.telegramUpdateId || metadata.telegramFileId) {
    return true;
  }
  return values.some((value) => /telegram/i.test(String(value || '')));
}

async function sendSpecialTargetFallback(targetInput, request = null) {
  const normalized = String(targetInput || '').trim().toLowerCase();
  if (!SPECIAL_USER_TARGETS.has(normalized)) {
    return { ok: false, error: `Unsupported special target '${targetInput}'` };
  }

  const specialRequest = (request && typeof request === 'object' && !Array.isArray(request))
    ? request
    : buildSpecialTargetRequest({
      content: typeof request === 'string' ? request : '',
      sender: { role: role || 'system' },
      session_id: projectMetadata?.session_id || null,
      project: projectMetadata || null,
    });

  try {
    const photoPath = typeof specialRequest.photoPath === 'string'
      ? specialRequest.photoPath.trim()
      : '';
    let voiceFallbackFailure = null;
    if (
      !photoPath
      && normalized === 'user'
      && specialRequest.senderRole === 'architect'
      && !metadataIndicatesTelegramOrigin(specialRequest.metadata)
    ) {
      const originalMessageId = specialRequest.messageId || null;
      const voiceResult = appendVoiceEgressMessage({
        text: specialRequest.content,
        messageId: originalMessageId ? `${originalMessageId}-voice-egress` : null,
        sessionId: specialRequest.sessionId || null,
        source: 'hm-send-user-voice-egress',
        metadata: {
          ...(specialRequest.metadata && typeof specialRequest.metadata === 'object' ? specialRequest.metadata : {}),
          originalMessageId,
          fallbackTarget: normalized,
          fallbackSuppressed: 'telegram',
          wrapper: 'cli_voice_egress',
        },
      });
      if (voiceResult?.ok) {
        return {
          ok: true,
          channel: 'voice',
          mode: 'egress',
          messageId: voiceResult.message?.messageId || specialRequest.messageId || null,
        };
      }
      voiceFallbackFailure = voiceResult?.reason || voiceResult?.error || 'voice_egress_failed';
    }
    const sendOperation = photoPath
      ? sendTelegramPhoto(photoPath, specialRequest.content, process.env, {
        messageId: specialRequest.messageId || null,
        senderRole: specialRequest.senderRole || role || 'system',
        sessionId: specialRequest.sessionId || null,
        metadata: specialRequest.metadata || null,
        chatId: telegramChatIdOverride || null,
      })
      : sendTelegram(specialRequest.content, process.env, {
        messageId: specialRequest.messageId || null,
        senderRole: specialRequest.senderRole || role || 'system',
        sessionId: specialRequest.sessionId || null,
        metadata: specialRequest.metadata || null,
        chatId: telegramChatIdOverride || null,
      });
    const result = await sendOperation;
    if (!result?.ok) {
      return { ok: false, error: result?.error || 'telegram_fallback_failed' };
    }
    return {
      ok: true,
      channel: 'telegram',
      mode: photoPath ? 'photo' : 'message',
      status: voiceFallbackFailure ? 'voice_failed_telegram_backup_used' : 'telegram_fallback_used',
      fallbackUsed: true,
      primaryChannel: voiceFallbackFailure ? 'voice' : null,
      primaryFailure: voiceFallbackFailure,
      chatId: result.chatId || null,
      statusCode: result.statusCode || null,
      messageId: result.messageId || null,
    };
  } catch (_err) {
    return { ok: false, error: _err?.message || 'telegram_fallback_exception' };
  }
}

function buildTelegramPhotoDeliveryRequest(envelope) {
  const specialRequest = buildSpecialTargetRequest(envelope);
  return {
    ...specialRequest,
    photoPath: telegramPhotoPath,
  };
}

async function sendTelegramPhotoDirect(envelope) {
  const result = await sendSpecialTargetFallback(target, buildTelegramPhotoDeliveryRequest(envelope));
  if (!result.ok) {
    console.error(`Telegram photo send failed: ${result.error}`);
    closeCommsJournalStores();
    process.exit(1);
  }
  const photoLabel = telegramPhotoPath ? path.basename(telegramPhotoPath) : '(unknown)';
  console.log(
    `Delivered to ${target}: --photo ${photoLabel}`
    + `${message ? ` (${previewMessage(message)})` : ''}`
    + ` (ack: telegram_delivered, attempt 1)`
  );
  closeCommsJournalStores();
  process.exit(0);
}

function isTelegramPhotoModeActive() {
  return Boolean(telegramPhotoPath) && isSpecialTarget(target);
}

async function sendTelegramTextDirect(envelope) {
  const specialRequest = buildSpecialTargetRequest(envelope);
  try {
    const result = await sendTelegram(specialRequest.content, process.env, {
      messageId: specialRequest.messageId || null,
      senderRole: specialRequest.senderRole || role || 'system',
      sessionId: specialRequest.sessionId || null,
      metadata: {
        ...(specialRequest.metadata || {}),
        directTarget: 'telegram',
        routeMethod: 'hm-send-telegram-direct',
      },
      chatId: telegramChatIdOverride || null,
    });
    if (!result?.ok) {
      console.error(`Telegram send failed: ${result?.error || 'telegram_delivery_failed'}`);
      closeCommsJournalStores();
      process.exit(1);
    }
    console.log(
      `Delivered to telegram: ${previewMessage(message)}`
      + ` (ack: telegram_delivered${result.messageId ? `, message_id: ${result.messageId}` : ''}, attempt 1)`
    );
    closeCommsJournalStores();
    process.exit(0);
  } catch (err) {
    console.error(`Telegram send failed: ${err?.message || 'telegram_delivery_exception'}`);
    closeCommsJournalStores();
    process.exit(1);
  }
}

function isTelegramTextDirectModeActive() {
  return !telegramPhotoPath && isExplicitTelegramTarget(target);
}

function formatSpecialTargetDeliveryLine(targetName, fallbackResult, options = {}) {
  const channel = fallbackResult.channel || 'fallback';
  const channelLabel = channel === 'voice' ? 'voice egress' : `${channel} fallback`;
  const statusSuffix = fallbackResult.status ? ` (${fallbackResult.status})` : '';
  const chatSuffix = fallbackResult.chatId ? ` (chat ${fallbackResult.chatId})` : '';
  const messageIdSuffix = fallbackResult.messageId ? `, messageId: ${fallbackResult.messageId}` : '';
  const wsContext = options.wsUnverifiedReason ? ` (WS context: ${options.wsUnverifiedReason})` : '';
  const wsExpectedNote = ` WS direct route remains in use for '${targetName}' app-routing; any 'No connected client for target: ${targetName}' warn is expected when no WS client is registered as that target.`;
  return `Delivered to ${targetName} via ${channelLabel}${statusSuffix}${chatSuffix}${messageIdSuffix}${wsContext}.${wsExpectedNote}`;
}

function appendProjectContextMarker(content, metadata = null) {
  const text = typeof content === 'string' ? content : String(content ?? '');
  if (!text) return text;

  const project = (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
    ? (metadata.project && typeof metadata.project === 'object' ? metadata.project : metadata)
    : null;
  if (!project || typeof project !== 'object') return text;

  const name = typeof project.name === 'string' ? project.name.trim() : '';
  const projectPath = typeof project.path === 'string' ? project.path.trim() : '';
  if (!name && !projectPath) return text;

  const marker = '[CURRENT PROJECT]';
  if (text.includes(marker) || text.includes('[PROJECT CONTEXT SWITCHED]')) return text;

  const fields = [];
  if (name) fields.push(`name=${name}`);
  if (projectPath) fields.push(`path=${projectPath}`);
  if (fields.length === 0) return text;

  return `${text}\n${marker} ${fields.join(' | ')}`;
}

function buildTriggerFallbackContent(content, messageId, metadata = null) {
  const withProjectContext = appendProjectContextMarker(content, metadata);
  if (typeof messageId !== 'string' || !messageId.trim()) {
    return withProjectContext;
  }
  return `${FALLBACK_MESSAGE_ID_PREFIX}${messageId.trim()}]\n${withProjectContext}`;
}

function writeTriggerFallback(targetInput, descriptorOrContent, options = {}) {
  const roleName = normalizeRole(targetInput);
  if (!roleName) {
    return {
      ok: false,
      error: `Cannot map target '${targetInput}' to trigger file`,
    };
  }

  const descriptor = (descriptorOrContent && typeof descriptorOrContent === 'object' && !Array.isArray(descriptorOrContent))
    ? descriptorOrContent
    : {
      content: typeof descriptorOrContent === 'string' ? descriptorOrContent : String(descriptorOrContent ?? ''),
      messageId: typeof options.messageId === 'string' ? options.messageId : null,
      metadata: (options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata))
        ? options.metadata
        : buildCanonicalEnvelopeMetadata({
          message_id: typeof options.messageId === 'string' ? options.messageId : null,
          content: typeof descriptorOrContent === 'string' ? descriptorOrContent : String(descriptorOrContent ?? ''),
          sender: { role: role || 'cli' },
          target: {
            raw: String(targetInput || '').trim() || null,
            role: roleName,
            pane_id: resolvePaneIdForRole(roleName),
          },
          session_id: projectMetadata?.session_id || null,
          project: projectMetadata || null,
          timestamp_ms: Date.now(),
        }),
    };

  const triggersDir = resolveLocalCoordPath('triggers', { forWrite: true });
  const triggerPath = path.join(triggersDir, `${roleName}.txt`);
  const tempPath = path.join(
    triggersDir,
    `.${roleName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  const payload = buildTriggerFallbackContent(descriptor.content, descriptor.messageId, descriptor.metadata);
  try {
    fs.mkdirSync(triggersDir, { recursive: true });
    fs.writeFileSync(tempPath, payload, 'utf8');
    try {
      fs.renameSync(tempPath, triggerPath);
    } catch (renameErr) {
      // Windows rename does not replace existing files; unlink then retry.
      if (renameErr.code === 'EEXIST' || renameErr.code === 'EPERM' || renameErr.code === 'EACCES') {
        try {
          fs.unlinkSync(triggerPath);
        } catch (unlinkErr) {
          if (unlinkErr.code !== 'ENOENT') {
            throw unlinkErr;
          }
        }
        fs.renameSync(tempPath, triggerPath);
      } else {
        throw renameErr;
      }
    }
    return { ok: true, role: roleName, path: triggerPath };
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Best-effort cleanup only.
    }
    return { ok: false, error: err.message };
  }
}

function shouldRetryAck(ack) {
  if (!ack || ack.ok) return false;
  if (ack.accepted === true) return false;
  const status = String(ack.status || '').toLowerCase();
  if (!status) return true;
  if (
    status === 'invalid_target'
    || status === 'submit_not_accepted'
    || status === 'submit_pending_input'
    || status === 'accepted.unverified'
  ) return false;
  return true;
}

function previewMessage(content) {
  if (content.length <= 50) return content;
  return `${content.substring(0, 50)}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldFallbackForUnverifiedSend(result, targetInput) {
  if (!FORCE_FALLBACK_ON_UNVERIFIED) return false;
  if (!result || result.ok !== true) return false;
  if (result.delivered !== false) return false;
  if (isSpecialTarget(targetInput)) return false;
  const status = String(result?.ack?.status || '').toLowerCase();
  if (!status) return true;
  return (
    status.includes('unverified')
    || status.includes('timeout')
    || status.includes('pending')
    || status.includes('routed')
    || status === 'delivered.websocket'
  );
}

function ackIndicatesVisibleDelivery(ack = null) {
  if (!ack || ack.ok !== true) return false;
  const status = String(ack.status || '').toLowerCase();
  return ack.verified === true
    || ack.userVisible === true
    || status === 'delivered.verified'
    || status === 'telegram_delivered';
}

function normalizeConnectedDevices(input) {
  if (!Array.isArray(input)) return [];
  const deduped = new Set();
  for (const value of input) {
    const normalized = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (normalized) deduped.add(normalized);
  }
  return Array.from(deduped).sort();
}

function buildBridgeTargetOfflineReason(ack, bridgeInfo = null) {
  if (!ack || String(ack.status || '').toLowerCase() !== 'target_offline') return null;
  const details = ack.handlerResult && typeof ack.handlerResult === 'object' ? ack.handlerResult : null;
  const unknownDevice = String(
    ack.unknownDevice
    || details?.unknownDevice
    || ack.toDevice
    || details?.toDevice
    || bridgeInfo?.toDevice
    || ''
  ).trim().toUpperCase();
  const connectedDevices = normalizeConnectedDevices(
    ack.connectedDevices
    || details?.connectedDevices
  );
  if (!unknownDevice && connectedDevices.length === 0) return null;
  return `Unknown device '${unknownDevice || 'UNKNOWN'}'. Connected devices: ${connectedDevices.length > 0 ? connectedDevices.join(', ') : 'none'}`;
}

function getBackoffDelayMs(baseTimeoutMs, attempt) {
  return baseTimeoutMs * Math.pow(2, attempt - 1);
}

function normalizePositiveInt(value, fallback, min = 1) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

function getDeliveryCheckOptions(ackTimeoutValue) {
  const ackTimeout = Number.isFinite(ackTimeoutValue) ? ackTimeoutValue : DEFAULT_ACK_TIMEOUT_MS;
  const perCheckTimeoutMs = Math.max(
    200,
    Math.min(
      normalizePositiveInt(DEFAULT_DELIVERY_CHECK_TIMEOUT_MS, 1200),
      Math.max(DEFAULT_HEALTH_TIMEOUT_MS, ackTimeout)
    )
  );
  const maxChecks = ackTimeout < 1000
    ? 2
    : normalizePositiveInt(DEFAULT_DELIVERY_CHECK_MAX_CHECKS, 6);
  return {
    perCheckTimeoutMs,
    maxChecks,
    retryDelayMs: normalizePositiveInt(DELIVERY_CHECK_RETRY_DELAY_MS, 250, 0),
  };
}

async function queryTargetHealthBestEffort(ws, options = {}) {
  const requestId = `health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};

  try {
    const payload = {
      type: 'health-check',
      target,
      requestId,
      staleAfterMs: TARGET_HEARTBEAT_STALE_MS,
    };
    if (opts.metadata && typeof opts.metadata === 'object') {
      payload.metadata = opts.metadata;
    }
    ws.send(JSON.stringify(payload));

    const health = await waitForMatch(
      ws,
      (msg) => msg.type === 'health-check-result' && msg.requestId === requestId,
      DEFAULT_HEALTH_TIMEOUT_MS,
      'Health check timeout'
    );
    return health;
  } catch (_err) {
    return null;
  }
}

async function queryDeliveryCheckBestEffort(ws, messageId, options = {}) {
  if (!messageId) return null;
  const maxChecks = normalizePositiveInt(options.maxChecks, 2);
  const perCheckTimeoutMs = normalizePositiveInt(options.perCheckTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS);
  const retryDelayMs = normalizePositiveInt(options.retryDelayMs, DELIVERY_CHECK_RETRY_DELAY_MS, 0);

  for (let check = 1; check <= maxChecks; check++) {
    const requestId = `delivery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      ws.send(JSON.stringify({
        type: 'delivery-check',
        requestId,
        messageId,
      }));

      const result = await waitForMatch(
        ws,
        (msg) => msg.type === 'delivery-check-result' && msg.requestId === requestId,
        perCheckTimeoutMs,
        'Delivery check timeout'
      );

      if (result?.status === 'pending' && check < maxChecks) {
        await sleep(retryDelayMs);
        continue;
      }

      return result;
    } catch (_err) {
      return null;
    }
  }

  return null;
}

function isTrustQuoteRouteOwnerTarget(targetInput = target, routeContext = null) {
  const routeProfile = normalizeProfileName(routeContext?.targetProfileName || '');
  if (
    normalizeProfileName(effectiveProfileName) !== TRUSTQUOTE_PROFILE_NAME
    && routeProfile !== TRUSTQUOTE_PROFILE_NAME
  ) {
    return false;
  }
  const normalizedTarget = normalizeRole(targetInput);
  return normalizedTarget === 'builder' || normalizedTarget === 'oracle';
}

function normalizeTrustQuoteRouteOwnerHealth(health, targetInput = target, routeContext = null) {
  if (!isTrustQuoteRouteOwnerTarget(targetInput, routeContext)) return health;
  const normalizedTarget = normalizeRole(targetInput) || String(targetInput || '').trim().toLowerCase();
  const expectedSessionScopeId = routeContext?.metadata?.routing?.sessionScopeId
    || scopeSessionIdForEffectiveProfile(projectMetadata?.session_id || getExplicitSessionScopeId());
  const base = health && typeof health === 'object' ? health : {};
  const routeBinding = base.routeBinding && typeof base.routeBinding === 'object' ? base.routeBinding : null;
  const blocked = (status, error) => ({
    ...base,
    type: base.type || 'health-check-result',
    target: base.target || normalizedTarget || targetInput || null,
    healthy: false,
    status,
    error,
    failClosed: true,
    routeOwnerRequired: TRUSTQUOTE_ROUTE_OWNER_ID,
    expectedSessionScopeId: expectedSessionScopeId || null,
  });

  if (!health) {
    return blocked(
      'trustquote_route_owner_health_unavailable',
      `TrustQuote route-owner health check did not return for target '${normalizedTarget}'.`
    );
  }
  if (base.healthy === true && String(base.source || '').toLowerCase() !== 'client_activity') {
    return blocked(
      'trustquote_route_owner_unhealthy',
      `TrustQuote target '${normalizedTarget}' must be backed by route-owner client_activity; got ${base.source || base.status || 'unknown'}.`
    );
  }
  if (base.healthy !== true || String(base.status || '').toLowerCase() !== 'healthy') {
    const status = String(base.status || '').toLowerCase();
    return blocked(
      status === 'scope_route_unavailable' || status === 'cross_profile_scope_mismatch'
        ? status
        : 'trustquote_route_owner_unhealthy',
      `TrustQuote route-owner target '${normalizedTarget}' is not healthy (${base.status || 'unknown'}).`
    );
  }
  if (
    !routeBinding
    || routeBinding.routeOwner !== TRUSTQUOTE_ROUTE_OWNER_ID
    || routeBinding.roomId !== TRUSTQUOTE_PROFILE_NAME
  ) {
    return blocked(
      'trustquote_route_owner_unhealthy',
      `TrustQuote target '${normalizedTarget}' is not bound to ${TRUSTQUOTE_ROUTE_OWNER_ID}.`
    );
  }
  if (
    expectedSessionScopeId
    && routeBinding.sessionScopeId !== expectedSessionScopeId
  ) {
    return blocked(
      'trustquote_route_owner_session_mismatch',
      `TrustQuote route-owner target '${normalizedTarget}' is scoped to '${routeBinding.sessionScopeId || '<missing>'}', expected '${expectedSessionScopeId}'.`
    );
  }
  return health;
}

function isTargetHealthBlocking(health, targetInput = target) {
  if (!health || typeof health !== 'object') return false;
  const status = String(health.status || '').toLowerCase();
  if (status === 'invalid_target') {
    if (isSpecialTarget(targetInput)) {
      return false;
    }
    return true;
  }
  if (
    status === 'scope_route_unavailable'
    || status === 'cross_profile_scope_mismatch'
    || status === 'trustquote_route_owner_health_unavailable'
    || status === 'trustquote_route_owner_unhealthy'
    || status === 'trustquote_route_owner_session_mismatch'
  ) {
    return true;
  }
  return false;
}

function isProfileScopedCanonicalTarget(targetInput) {
  if (isMainProfile(effectiveProfileName)) return false;
  return Boolean(normalizeRole(targetInput));
}

function getIsolationFailureStatus(result = null) {
  const status = String(
    result?.ack?.status
    || result?.health?.status
    || result?.deliveryCheck?.ack?.status
    || result?.deliveryCheck?.status
    || ''
  ).toLowerCase();
  if (status === 'scope_route_unavailable' || status === 'cross_profile_scope_mismatch') {
    return status;
  }
  return null;
}

function shouldFailClosedWithoutFallback(result = null, error = null) {
  const status = String(result?.ack?.status || '').toLowerCase();
  if (status === 'submit_pending_input') return true;
  if (getIsolationFailureStatus(result)) return true;
  if (targetProfileRouteContext && (error || !result?.ok)) return true;
  if (isProfileScopedCanonicalTarget(target) && (error || !result?.ok)) return true;
  return false;
}

async function emitCommsEventBestEffort(eventType, payload = {}) {
  const socketUrl = `ws://127.0.0.1:${PORT}`;
  let ws = null;
  try {
    ws = new WebSocket(socketUrl);
    await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');

    ws.send(JSON.stringify(buildRegisterPayload()));
    await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

    ws.send(JSON.stringify({
      type: 'comms-event',
      eventType,
      payload,
    }));

    // Give the socket a short tick to flush before closing.
    await sleep(25);
    await closeSocket(ws);
    return true;
  } catch (_err) {
    if (ws) {
      try {
        await closeSocket(ws);
      } catch {
        // ignore close failures
      }
    }
    return false;
  }
}

async function sendViaWebSocketWithAck(envelope, options = {}) {
  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  const skipHealthCheck = opts.skipHealthCheck === true;
  const socketPort = Number.isFinite(Number(opts.port)) ? Number(opts.port) : PORT;
  const socketUrl = `ws://127.0.0.1:${socketPort}`;
  const ws = new WebSocket(socketUrl);
  const sendStartedAtMs = Date.now();
  const payloadBytes = getUtf8ByteLength(envelope?.content || '');
  const payloadFingerprint = createPayloadFingerprint(envelope?.content || '');
  const traceBase = {
    messageId: envelope.message_id,
    recipient: target,
    senderRole: role,
    payloadBytes,
    payloadFingerprint,
    priority,
    sendStartedAtMs,
  };
  const traceComplete = (details = {}) => {
    const ackReceivedAtMs = Number.isFinite(Number(details.ackReceivedAtMs))
      ? Number(details.ackReceivedAtMs)
      : null;
    appendBusTraceEvent({
      eventType: 'hm_send_complete',
      ...traceBase,
      ...details,
      ackReceivedAtMs,
      ackLatencyMs: ackReceivedAtMs === null ? null : ackReceivedAtMs - sendStartedAtMs,
    });
  };

  await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');

  ws.send(JSON.stringify(buildRegisterPayload(envelope, opts.register)));
  await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

  if (!skipHealthCheck) {
    const health = normalizeTrustQuoteRouteOwnerHealth(
      await queryTargetHealthBestEffort(ws, opts),
      target,
      targetProfileRouteContext
    );
    if (isTargetHealthBlocking(health, target)) {
      await closeSocket(ws);
      traceComplete({
        success: false,
        status: 'skipped_by_health',
        attemptsUsed: 0,
        healthStatus: health?.status || null,
      });
      return {
        ok: false,
        skippedByHealth: true,
        health,
        attemptsUsed: 0,
        messageId: envelope.message_id,
      };
    }
  }

  const attempts = retries + 1;
  let lastAck = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const dispatchMessage = buildWebSocketDispatchMessage(envelope, {
      target,
      priority,
      ackRequired: true,
      attempt,
      maxAttempts: attempts,
    });
    dispatchMessage.metadata = mergeDispatchMetadata(dispatchMessage.metadata, opts.metadata);
    dispatchMessage.traceContext = {
      ...(dispatchMessage.traceContext && typeof dispatchMessage.traceContext === 'object'
        ? dispatchMessage.traceContext
        : {}),
      traceId: envelope.message_id,
      correlationId: envelope.message_id,
      messageId: envelope.message_id,
    };
    const resolvedTelegramChatId = normalizeChatId(telegramChatIdOverride);
    if (resolvedTelegramChatId && isSpecialTarget(target)) {
      dispatchMessage.metadata = {
        ...(dispatchMessage.metadata || {}),
        chatId: resolvedTelegramChatId,
        telegram: {
          chatId: resolvedTelegramChatId,
        },
      };
    }
    const serializedDispatch = JSON.stringify(dispatchMessage);
    const attemptStartedAtMs = Date.now();
    appendBusTraceEvent({
      eventType: 'hm_send_attempt',
      ...traceBase,
      attempt,
      maxAttempts: attempts,
      attemptStartedAtMs,
      dispatchBytes: getUtf8ByteLength(serializedDispatch),
    });
    ws.send(serializedDispatch);

    try {
      const ack = await waitForMatch(
        ws,
        (msg) => msg.type === 'send-ack' && msg.messageId === envelope.message_id,
        ackTimeoutMs,
        `ACK timeout after ${ackTimeoutMs}ms`
      );
      lastAck = ack;
      const ackReceivedAtMs = Date.now();
      appendBusTraceEvent({
        eventType: 'hm_send_ack',
        ...traceBase,
        attempt,
        maxAttempts: attempts,
        ackReceivedAtMs,
        ackLatencyMs: ackReceivedAtMs - attemptStartedAtMs,
        success: Boolean(ack.ok),
        accepted: ack.accepted === true,
        status: ack.status || null,
      });

      if (ack.ok) {
        const delivered = ackIndicatesVisibleDelivery(ack);
        await closeSocket(ws);
        traceComplete({
          success: true,
          delivered,
          accepted: true,
          status: ack.status || 'delivered',
          ackReceivedAtMs,
          attemptsUsed: attempt,
        });
        return {
          ok: true,
          delivered,
          accepted: true,
          messageId: envelope.message_id,
          ack,
          attemptsUsed: attempt,
        };
      }

      if (ack.accepted === true) {
        await closeSocket(ws);
        traceComplete({
          success: true,
          delivered: false,
          accepted: true,
          status: ack.status || 'accepted_unverified',
          ackReceivedAtMs,
          attemptsUsed: attempt,
        });
        return {
          ok: true,
          delivered: false,
          accepted: true,
          messageId: envelope.message_id,
          ack,
          attemptsUsed: attempt,
        };
      }

      if (attempt >= attempts || !shouldRetryAck(ack)) {
        break;
      }

      const backoffDelay = getBackoffDelayMs(ackTimeoutMs, attempt);
      await sleep(backoffDelay);
    } catch (err) {
      lastError = err;
      appendBusTraceEvent({
        eventType: 'hm_send_attempt_error',
        ...traceBase,
        attempt,
        maxAttempts: attempts,
        success: false,
        status: 'ack_timeout_or_error',
        error: err.message,
      });
      if (attempt >= attempts) {
        break;
      }

      const backoffDelay = getBackoffDelayMs(ackTimeoutMs, attempt);
      await sleep(backoffDelay);
    }
  }

  const deliveryCheck = await queryDeliveryCheckBestEffort(
    ws,
    envelope.message_id,
    getDeliveryCheckOptions(ackTimeoutMs)
  );
  if (deliveryCheck?.known && (deliveryCheck?.ack?.ok || deliveryCheck?.ack?.accepted === true)) {
    const delivered = ackIndicatesVisibleDelivery(deliveryCheck.ack);
    await closeSocket(ws);
    traceComplete({
      success: true,
      delivered,
      accepted: true,
      status: 'delivery_check_confirmed',
      attemptsUsed: attempts,
      deliveryCheckStatus: deliveryCheck.status || null,
    });
    return {
      ok: true,
      delivered,
      accepted: true,
      messageId: envelope.message_id,
      ack: deliveryCheck.ack,
      attemptsUsed: attempts,
      deliveryCheck,
    };
  }

  await closeSocket(ws);
  traceComplete({
    success: false,
    delivered: false,
    accepted: false,
    status: lastAck?.status || deliveryCheck?.status || 'failed',
    attemptsUsed: attempts,
    error: lastError ? lastError.message : null,
    deliveryCheckStatus: deliveryCheck?.status || null,
  });
  return {
    ok: false,
    messageId: envelope.message_id,
    ack: lastAck,
    deliveryCheck,
    error: lastError ? lastError.message : null,
    attemptsUsed: attempts,
  };
}

async function main() {
  if (listDevicesMode) {
    const discoveryResult = await runListDevicesMode();
    if (discoveryResult?.ok) {
      closeCommsJournalStores();
      process.exit(0);
    }
    closeCommsJournalStores();
    console.error(`Device discovery failed: ${discoveryResult?.error || 'unknown error'}`);
    process.exit(1);
  }

  const bridgeMode = Boolean(bridgeTarget);
  const messageId = `hm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const targetRole = normalizeRole(target)
    || (isSpecialTarget(target) ? String(target).trim().toLowerCase() : null)
    || (bridgeTarget ? bridgeTarget.targetRole : null);
  const trustQuoteReverseRoute = buildTrustQuoteReverseRouteContext(targetRole);
  const forwardProfileRoute = trustQuoteReverseRoute ? null : targetProfileRouteContext;
  const targetProfileIsCrossProfileArchitectRoute = Boolean(
    targetProfileOverride
    && targetRole === 'architect'
    && normalizeProfileName(targetProfileOverride) !== normalizeProfileName(effectiveProfileName)
  );
  if (targetProfileIsCrossProfileArchitectRoute && !sourceProfileOverride) {
    console.error('Cross-profile architect routes require --source-profile so cwd/env cannot choose sender profile.');
    closeCommsJournalStores();
    process.exit(1);
  }
  const profileRouteAttributionMetadata = buildProfileRouteAttributionMetadata(targetRole, forwardProfileRoute);
  const profileRouteDispatchMetadata = {
    ...(profileRouteAttributionMetadata || {}),
    ...(trustQuoteReverseRoute ? trustQuoteReverseRoute.metadata : {}),
    ...(forwardProfileRoute ? forwardProfileRoute.metadata : {}),
  };
  const outboundMessage = trustQuoteReverseRoute
    ? formatTrustQuoteReverseContent(message, role)
    : message;
  const miraInboxMode = isMiraInboxTarget(targetRole);
  const guardResult = await runOutputGuards({ messageId, targetRole });
  if (guardResult?.ok !== true) {
    closeCommsJournalStores();
    process.exit(1);
  }
  const envelope = buildOutboundMessageEnvelope({
    message_id: messageId,
    session_id: projectMetadata?.session_id || null,
    sender: {
      role: role || 'cli',
    },
    target: {
      raw: target || null,
      role: targetRole,
      pane_id: resolvePaneIdForRole(targetRole),
    },
    content: outboundMessage,
    priority,
    timestamp_ms: Date.now(),
    project: projectMetadata || null,
  });
  if (isTelegramPhotoModeActive()) {
    await sendTelegramPhotoDirect(envelope);
  }
  if (isTelegramTextDirectModeActive()) {
    await sendTelegramTextDirect(envelope);
  }
  const envelopeMetadata = buildCanonicalEnvelopeMetadata(envelope);
  const preSendJournal = appendLocalCommsJournalEntry({
    messageId: envelope.message_id,
    sessionId: envelope.session_id || null,
    senderRole: envelope.sender?.role || (role || 'cli'),
    targetRole: envelope.target?.role || targetRole,
    channel: miraInboxMode ? 'mira-inbox' : 'ws',
    direction: 'outbound',
    sentAtMs: envelope.timestamp_ms,
    rawBody: envelope.content,
    status: miraInboxMode ? 'mira_inbox_recorded' : 'recorded',
    attempt: 1,
    metadata: {
      source: 'hm-send',
      maxAttempts: retries + 1,
      routeKind: miraInboxMode ? 'mira-inbox' : (bridgeMode ? 'bridge' : (forwardProfileRoute ? 'profile' : 'local')),
      bridgeTarget: bridgeMode ? bridgeTarget.toDevice : null,
      bridgeEnabled: bridgeMode ? isCrossDeviceEnabled(process.env) : null,
      ...envelopeMetadata,
      ...profileRouteDispatchMetadata,
    },
  });

  if (preSendJournal?.ok !== true) {
    console.warn(`Comms journal pre-send record unavailable: ${preSendJournal?.reason || 'unknown'}`);
  }

  if (miraInboxMode) {
    console.log(`Recorded to mira inbox: ${previewMessage(message)} (message_id: ${envelope.message_id})`);
    closeCommsJournalStores();
    process.exit(0);
  }

  let sendResult = null;
  let wsError = null;

  try {
    sendResult = await sendViaWebSocketWithAck(envelope, {
      skipHealthCheck: bridgeMode,
      ...(trustQuoteReverseRoute || forwardProfileRoute || {}),
      metadata: Object.keys(profileRouteDispatchMetadata).length > 0
        ? profileRouteDispatchMetadata
        : null,
    });
  } catch (err) {
    wsError = err;
  }

  if (sendResult?.ok) {
    if (enableFallback && shouldFallbackForUnverifiedSend(sendResult, target)) {
      const fallbackResult = writeTriggerFallback(target, buildTriggerFallbackDescriptor(envelope));
      if (fallbackResult.ok) {
        const reason = sendResult?.ack?.status
          ? `ack=${sendResult.ack.status}`
          : 'accepted_unverified';
        await emitCommsEventBestEffort('comms.delivery.failed', {
          messageId: envelope.message_id,
          target: envelope.target?.raw || target,
          role: envelope.sender?.role || role,
          sender: envelope.sender,
          target_meta: envelope.target,
          session_id: envelope.session_id,
          timestamp_ms: envelope.timestamp_ms,
          project: envelope.project,
          reason,
          attemptsUsed: sendResult?.attemptsUsed ?? (retries + 1),
          maxAttempts: retries + 1,
          fallbackUsed: true,
          fallbackPath: fallbackResult.path,
          ts: Date.now(),
        });
        console.warn(
          `Accepted by ${target} but unverified: ${previewMessage(message)} `
          + `(ack: ${sendResult.ack.status}, attempt ${sendResult.attemptsUsed}). `
          + `Forced trigger fallback: ${fallbackResult.path}`
        );
        closeCommsJournalStores();
        process.exit(0);
      }
      console.warn(
        `Accepted by ${target} but unverified: ${previewMessage(message)} `
        + `(ack: ${sendResult.ack.status}, attempt ${sendResult.attemptsUsed}). `
        + `Forced fallback failed: ${fallbackResult.error}`
      );
      closeCommsJournalStores();
      process.exit(0);
    }

    if (sendResult.delivered === false) {
      console.log(
        `Accepted by ${target} but unverified: ${previewMessage(message)} `
        + `(ack: ${sendResult.ack.status}, attempt ${sendResult.attemptsUsed}). `
        + 'Delivery may already have happened; avoid immediate resend.'
      );
    } else {
      console.log(`Delivered to ${target}: ${previewMessage(message)} (ack: ${sendResult.ack.status}, attempt ${sendResult.attemptsUsed})`);
    }
    closeCommsJournalStores();
    process.exit(0);
  }

  if (shouldFailClosedWithoutFallback(sendResult, wsError)) {
    const contextGuard = sendResult?.ack?.contextGuard || null;
    if (contextGuard && contextGuard.reason === 'content_context_mismatch') {
      const family = contextGuard.targetProfile === 'main'
        ? 'SIDE_CONTEXT_PATTERN'
        : 'MAIN_CONTEXT_PATTERN';
      console.error(
        `Send blocked by content guard (content_context_mismatch). `
        + `Body matched ${family} for target role '${contextGuard.targetRole || 'unknown'}' `
        + `in profile '${contextGuard.targetProfile || 'unknown'}'. `
        + `Move details into a file and pass via --file, or address the message to architect.`
      );
    } else if (contextGuard && contextGuard.reason === 'profile_metadata_mismatch') {
      const hints = Array.isArray(contextGuard.profileHints) && contextGuard.profileHints.length > 0
        ? contextGuard.profileHints.join(', ')
        : '<none>';
      console.error(
        `Send blocked by profile metadata guard (profile_metadata_mismatch). `
        + `Message metadata hints [${hints}] do not match target role '${contextGuard.targetRole || 'unknown'}' `
        + `in profile '${contextGuard.targetProfile || 'unknown'}'.`
      );
    } else {
      const status = getIsolationFailureStatus(sendResult)
        || sendResult?.health?.status
        || sendResult?.ack?.status
        || sendResult?.error
        || wsError?.message
        || 'profile_route_unavailable';
      const reason = sendResult?.health?.error || sendResult?.ack?.error || null;
      console.error(
        `Send blocked by profile isolation (${status}). `
        + (reason ? `${reason} ` : '')
        + `Profile '${effectiveProfileName}' cannot fall back to main target '${target}'.`
      );
    }
    closeCommsJournalStores();
    process.exit(1);
  }

  if (enableFallback) {
    if (isSpecialTarget(target)) {
      const fallbackResult = await sendSpecialTargetFallback(target, buildSpecialTargetRequest(envelope));
      if (fallbackResult.ok) {
        const wsUnverifiedReason = sendResult?.ack
          ? `ack=${sendResult.ack.status}`
          : sendResult?.deliveryCheck
            ? `delivery-check=${sendResult.deliveryCheck.status || 'unknown'}`
            : sendResult?.skippedByHealth
              ? `health=${sendResult?.health?.status || 'unknown'}`
              : (sendResult?.error || wsError?.message || 'no_ack');
        console.log(formatSpecialTargetDeliveryLine(target, fallbackResult, { wsUnverifiedReason }));
        closeCommsJournalStores();
        process.exit(0);
      }
      console.error(`WebSocket failed and special-target fallback failed: ${fallbackResult.error}`);
      closeCommsJournalStores();
      process.exit(1);
    }

    const fallbackResult = writeTriggerFallback(target, buildTriggerFallbackDescriptor(envelope));
    if (fallbackResult.ok) {
      const reason = sendResult?.ack
        ? `ack=${sendResult.ack.status}`
        : sendResult?.deliveryCheck
          ? `delivery-check=${sendResult.deliveryCheck.status || 'unknown'}`
        : sendResult?.skippedByHealth
          ? `health=${sendResult?.health?.status || 'unknown'}`
        : (sendResult?.error || wsError?.message || 'no_ack');
      await emitCommsEventBestEffort('comms.delivery.failed', {
        messageId: envelope.message_id,
        target: envelope.target?.raw || target,
        role: envelope.sender?.role || role,
        sender: envelope.sender,
        target_meta: envelope.target,
        session_id: envelope.session_id,
        timestamp_ms: envelope.timestamp_ms,
        project: envelope.project,
        reason,
        attemptsUsed: sendResult?.attemptsUsed ?? (retries + 1),
        maxAttempts: retries + 1,
        fallbackUsed: true,
        fallbackPath: fallbackResult.path,
        ts: Date.now(),
      });
      console.warn(`WebSocket send unverified (${reason}). Wrote trigger fallback: ${fallbackResult.path}`);
      closeCommsJournalStores();
      process.exit(0);
    }
    console.error(`WebSocket failed and fallback failed: ${fallbackResult.error}`);
    closeCommsJournalStores();
    process.exit(1);
  }

  const bridgeReason = bridgeMode ? buildBridgeTargetOfflineReason(sendResult?.ack, bridgeTarget) : null;
  const reason = bridgeReason || (sendResult?.ack
    ? `ACK failed (${sendResult.ack.status})`
    : sendResult?.deliveryCheck
      ? `delivery-check ${sendResult.deliveryCheck.status || 'unknown'}`
    : sendResult?.skippedByHealth
      ? `target health ${sendResult?.health?.status || 'unhealthy'}`
    : (sendResult?.error || wsError?.message || 'unknown error'));
  console.error(`Send failed: ${reason}`);
  closeCommsJournalStores();
  process.exit(1);
}

main().catch((err) => {
  closeCommsJournalStores();
  console.error('Fatal error:', err.message);
  process.exit(1);
});
