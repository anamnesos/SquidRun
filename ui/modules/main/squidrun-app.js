/**
 * SquidRun Application
 * Main process application controller
 */

const { app, BrowserWindow, dialog, ipcMain, session, powerMonitor, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createHash } = require('crypto');
const { spawn } = require('child_process');
const log = require('../logger');
const { getDaemonClient } = require('../../daemon-client');
const {
  WORKSPACE_PATH,
  PANE_IDS,
  ROLE_ID_MAP,
  BACKWARD_COMPAT_ROLE_ALIASES,
  BACKGROUND_BUILDER_OWNER_PANE_ID,
  resolveBackgroundBuilderAlias,
  resolveBackgroundBuilderPaneId,
  getProjectRoot,
  setProjectRoot,
  resolveCoordPath,
} = require('../../config');
const {
  getActiveProfileName,
  isMainProfile,
  buildProfileTelegramEnv,
  resolveProfileInstructionPath,
} = require('../../profile');
const { createPluginManager } = require('../plugins');
const { createBackupManager } = require('../backup-manager');
const { createRecoveryManager } = require('../recovery-manager');
const { createExternalNotifier } = require('../external-notifications');
const { stripAnsi } = require('../ansi');
const { createKernelBridge } = require('./kernel-bridge');
const { createBackgroundAgentManager } = require('./background-agent-manager');
const { createPaneHostWindowManager } = require('./pane-host-window-manager');
const { resolveRuntimeInt } = require('../runtime-config');
const AGENT_MESSAGE_PREFIX = '[AGENT MSG - reply via hm-send.js] ';
const TEAM_MEMORY_BELIEF_SWEEP_ENABLED = process.env.SQUIDRUN_TEAM_MEMORY_BELIEF_SWEEP === '1';

// Import sub-modules
const triggers = require('../triggers');
const watcher = require('../watcher');
const ipcHandlers = require('../ipc-handlers');
const websocketServer = require('../websocket-server');
const organicUI = require('../ipc/organic-ui-handlers');
const pipeline = require('../pipeline');
const sharedState = require('../shared-state');
const contextCompressor = require('../context-compressor');
const smsPoller = require('../sms-poller');
const telegramPoller = require('../telegram-poller');
const { normalizeChatId } = require('../../scripts/hm-telegram');
const { sendTelegram } = require('../../scripts/hm-telegram');
const { sendRoutedTelegramMessage } = require('../../scripts/hm-telegram-routing');
const {
  shouldTriggerAutonomousSmoke,
  buildSmokeRunnerArgs,
  formatSmokeResultMessage,
} = require('./autonomous-smoke');
const {
  createBridgeClient,
  DEFAULT_BRIDGE_RELAY_URL,
  normalizeBridgeMetadata,
} = require('../bridge-client');
const {
  normalizeDeviceId,
  parseCrossDeviceTarget,
  getLocalDeviceId,
  getProfileDeviceId,
  isCrossDeviceEnabled,
} = require('../cross-device-target');
const {
  buildOutboundMessageEnvelope,
  buildCanonicalEnvelopeMetadata,
} = require('../comms/message-envelope');
const teamMemory = require('../team-memory');
const experiment = require('../experiment');
const {
  materializeSessionHandoff,
  removeLegacyPaneHandoffFiles,
} = require('./auto-handoff-materializer');
const {
  closeCommsJournalStores,
  queryCommsJournalEntries,
} = require('./comms-journal');
const {
  buildGuardFiringPatternEvent,
  buildGuardPreflightEvent,
  buildSessionLifecyclePatternEvent,
  isDeliveryFailureResult,
  buildDeliveryOutcomePatternEvent,
  buildDeliveryFailurePatternEvent,
  buildIntentUpdatePatternEvent,
} = require('../team-memory/daily-integration');
const {
  executeEvidenceLedgerOperation,
  closeSharedRuntime,
} = require('../ipc/evidence-ledger-handlers');
const {
  executeCognitiveMemoryOperation,
  closeSharedCognitiveMemoryRuntime,
} = require('../ipc/cognitive-memory-handlers');
const { executeTransitionLedgerOperation } = require('../ipc/transition-ledger-handlers');
const { executeGitHubOperation } = require('../ipc/github-handlers');
const { executePaneControlAction } = require('./pane-control-service');
const { executeAppControlAction } = require('./app-control-service');
const { captureScreenshot } = require('../ipc/screenshot-handlers');
const { executeContractPromotionAction } = require('../contract-promotion-service');
const { createBufferedFileWriter } = require('../buffered-file-writer');
const {
  createHealthSnapshot,
  renderStartupHealthMarkdown,
} = require('../../scripts/hm-health-snapshot');
const {
  generateSessionSummary,
} = require('../../scripts/hm-session-summary');
const {
  generateStartupBriefing,
} = require('../startup-ai-briefing');
const {
  buildSystemCapabilitiesSnapshot,
  resolveSleepExtractionCommandFromSnapshot,
  writeSystemCapabilitiesSnapshot,
} = require('../local-model-capabilities');
const { createProblemOrchestrator } = require('../problem-orchestrator');
const {
  recordRecallUsageFromMessage,
} = require('../memory-recall');
const {
  readPairedConfig,
  writePairedConfig,
} = require('./device-pairing-store');
const {
  DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES,
  DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES,
  buildInjectMessageIpcPackets,
  getUtf8ByteLength,
} = require('../inject-message-ipc');
const {
  appendBusTraceEvent,
  createPayloadFingerprint,
} = require('../bus-reliability-trace');
const { createPtyOutputFilter } = require('./pty-output-filter');
const IS_DARWIN = process.platform === 'darwin';
const PANE_HOST_BOOTSTRAP_VERIFY_DELAY_MS = IS_DARWIN ? 900 : 1500;
const PANE_HOST_BOOTSTRAP_LOADING_GRACE_MS = IS_DARWIN ? 20000 : 45000;
const PANE_HOST_READY_GRACE_AFTER_LOAD_MS = IS_DARWIN ? 1500 : 4000;
const APP_IDLE_THRESHOLD_MS = 30000;
const DEFAULT_AGENT_RESPONSE_WATCHDOG_MS = 15 * 60 * 1000;
const CONSOLE_LOG_FLUSH_INTERVAL_MS = 500;
const PTY_DATA_IPC_BATCH_INTERVAL_MS = Number.parseInt(
  process.env.SQUIDRUN_PTY_DATA_IPC_BATCH_INTERVAL_MS || '16',
  10
);
const STARTUP_READY_BUFFER_MAX = 4096;
const TELEGRAM_REPLY_WINDOW_MS = Number.parseInt(
  process.env.SQUIDRUN_TELEGRAM_REPLY_WINDOW_MS || String(5 * 60 * 1000),
  10
);
const TEAM_MEMORY_BACKFILL_LIMIT = Number.parseInt(process.env.SQUIDRUN_TEAM_MEMORY_BACKFILL_LIMIT || '5000', 10);
const TEAM_MEMORY_INTEGRITY_SWEEP_INTERVAL_MS = Number.parseInt(
  process.env.SQUIDRUN_TEAM_MEMORY_INTEGRITY_SWEEP_MS || String(24 * 60 * 60 * 1000),
  10
);
const TEAM_MEMORY_BELIEF_SNAPSHOT_INTERVAL_MS = Number.parseInt(
  process.env.SQUIDRUN_TEAM_MEMORY_BELIEF_SWEEP_MS || String(5 * 60 * 1000),
  10
);
const TEAM_MEMORY_PATTERN_MINING_INTERVAL_MS = Number.parseInt(
  process.env.SQUIDRUN_TEAM_MEMORY_PATTERN_SWEEP_MS || String(60 * 1000),
  10
);
const TEAM_MEMORY_BLOCK_GUARD_PROFILE = String(process.env.SQUIDRUN_TEAM_MEMORY_BLOCK_GUARD_PROFILE || 'jest-suite').trim() || 'jest-suite';
const APP_STARTUP_SESSION_RETRY_LIMIT = 3;
const APP_SESSION_COUNTER_FLOOR = Math.max(
  1,
  Number.parseInt(process.env.SQUIDRUN_SESSION_COUNTER_FLOOR || '170', 10) || 170
);
const AUTO_HANDOFF_INTERVAL_MS = Number.parseInt(process.env.SQUIDRUN_AUTO_HANDOFF_INTERVAL_MS || '30000', 10);
const AUTO_HANDOFF_ENABLED = process.env.SQUIDRUN_AUTO_HANDOFF_ENABLED !== '0';
const BRIDGE_FLAP_WINDOW_MS = Number.parseInt(process.env.SQUIDRUN_BRIDGE_FLAP_WINDOW_MS || '60000', 10);
const TEAM_MEMORY_TAGGED_CLAIM_SWEEP_INTERVAL_MS = Number.parseInt(
  process.env.SQUIDRUN_TEAM_MEMORY_TAGGED_CLAIM_SWEEP_MS || '30000',
  10
);
const BRIDGE_READY_WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.SQUIDRUN_BRIDGE_READY_WAIT_TIMEOUT_MS || '5000',
  10
);
const WEBSOCKET_START_RETRY_BASE_MS = Number.parseInt(
  process.env.SQUIDRUN_WEBSOCKET_START_RETRY_BASE_MS || '500',
  10
);
const WEBSOCKET_START_RETRY_MAX_MS = Number.parseInt(
  process.env.SQUIDRUN_WEBSOCKET_START_RETRY_MAX_MS || '10000',
  10
);
const DAEMON_CONNECT_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.SQUIDRUN_DAEMON_CONNECT_TIMEOUT_MS || '15000', 10) || 15000
);
const DAEMON_PID_FILE = resolveCoordPath('runtime/daemon.pid', { forWrite: true });
const SUPERVISOR_DAEMON_SCRIPT = path.join(__dirname, '..', '..', 'supervisor-daemon.js');
const SUPERVISOR_PID_FILE = resolveCoordPath('runtime/supervisor.pid', { forWrite: true });
const SUPERVISOR_STATUS_FILE = resolveCoordPath('runtime/supervisor-status.json', { forWrite: true });
const SUPERVISOR_LOG_FILE = resolveCoordPath('runtime/supervisor.log', { forWrite: true });
const SUPERVISOR_STATUS_STALE_MULTIPLIER = Math.max(
  3,
  Number.parseInt(process.env.SQUIDRUN_SUPERVISOR_STATUS_STALE_MULTIPLIER || '4', 10) || 4
);
const SUPERVISOR_STATUS_STALE_MIN_MS = Math.max(
  15000,
  Number.parseInt(process.env.SQUIDRUN_SUPERVISOR_STATUS_STALE_MIN_MS || '15000', 10) || 15000
);
const RENDERER_ENTRY_HTML = path.join(__dirname, '..', '..', 'index.html');
const SHUTDOWN_CONFIRM_MESSAGE = 'All active agent sessions will be terminated.\n\nContinue?';
const EXTERNAL_WORKSPACE_DIRNAME = 'SquidRun';
const ONBOARDING_STATE_FILENAME = 'onboarding-state.json';
const FRESH_INSTALL_MARKER_FILENAME = 'fresh-install.json';
const PACKAGED_BIN_RUNTIME_RELATIVE = path.join('.squidrun', 'bin', 'runtime', 'ui');
const WINDOWS_APP_USER_MODEL_ID = 'com.squidrun.app';
const AUTONOMOUS_SMOKE_RUNNER_PATH = path.join(__dirname, '..', '..', 'scripts', 'hm-smoke-runner.js');
const HM_SEND_SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'hm-send.js');
const AUTONOMOUS_SMOKE_TIMEOUT_MS = Math.max(
  15000,
  Number.parseInt(process.env.SQUIDRUN_AUTONOMOUS_SMOKE_TIMEOUT_MS || '120000', 10) || 120000
);
const AUTONOMOUS_SMOKE_COOLDOWN_MS = Math.max(
  0,
  Number.parseInt(process.env.SQUIDRUN_AUTONOMOUS_SMOKE_COOLDOWN_MS || '15000', 10) || 15000
);
const EUNBYEOL_CHAT_ID = '8754356993';
const EUNBYEOL_CONFIRMED_FACT_PATHS = Object.freeze([
  'D:\\projects\\Jeon Myeongsam Case\\reference\\confirmed-facts.md',
  'D:\\projects\\Hillstate Case\\reference\\confirmed-facts.md',
  'D:\\projects\\Korean Fraud\\reference\\confirmed-facts.md',
]);

function asPositiveInt(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function asString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function resolveSupervisorLaunchExecutable() {
  const override = toNonEmptyString(process.env.SQUIDRUN_SUPERVISOR_NODE_PATH);
  if (override) {
    return {
      executable: override,
      env: { ...process.env },
    };
  }

  const currentExecPath = String(process.execPath || '').trim();
  const execBaseName = path.basename(currentExecPath).toLowerCase();
  const runningInsideElectron = Boolean(process.versions?.electron);
  const currentExecIsNode = execBaseName === 'node' || execBaseName === 'node.exe';

  if (!runningInsideElectron || currentExecIsNode) {
    return {
      executable: currentExecPath,
      env: { ...process.env },
    };
  }

  const fallbackExecutable = process.platform === 'win32' ? 'node.exe' : 'node';
  const fallbackEnv = { ...process.env };
  delete fallbackEnv.ELECTRON_RUN_AS_NODE;

  return {
    executable: fallbackExecutable,
    env: fallbackEnv,
  };
}

function stripAnsiForStartupReady(value) {
  return stripAnsi(value);
}

function hasCliStartupReadySignal(buffer = '') {
  const text = stripAnsiForStartupReady(buffer);
  if (!text) return false;
  return (
    /(^|\n)\s*>\s*(?:\n|$)/m.test(text)
    || /(^|\n)\s*(?:codex|claude|gemini|cursor)>\s*/im.test(text)
    || /how can i help/i.test(text)
    || /gemini cli/i.test(text)
  );
}

function parseStructuredJsonOutput(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_) {
    // Fall through.
  }

  const starts = [];
  for (let idx = 0; idx < text.length; idx += 1) {
    const char = text[idx];
    if (char === '{' || char === '[') {
      starts.push(idx);
    }
  }

  const extractBalancedJson = (startIndex) => {
    const opening = text[startIndex];
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let idx = startIndex; idx < text.length; idx += 1) {
      const char = text[idx];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = inString;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === opening) {
        depth += 1;
      } else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          return text.slice(startIndex, idx + 1);
        }
      }
    }
    return null;
  };

  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const candidate = extractBalancedJson(starts[index]);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (_) {
      // Keep scanning until a balanced JSON block parses.
    }
  }
  return null;
}

function normalizeStartupSummaryLine(value, fallback = 'none') {
  if (typeof value === 'string') {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized || fallback;
  }
  if (value && typeof value === 'object') {
    const candidates = [
      value.summary,
      value.title,
      value.body,
      value.detail,
      value.message,
      value.id,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeStartupSummaryLine(candidate, '');
      if (normalized) return normalized;
    }
  }
  return fallback;
}

function takeStartupSummaryItems(items, limit = 2) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items
    .map((item) => normalizeStartupSummaryLine(item, ''))
    .filter(Boolean)
    .slice(0, limit);
}

const RUNTIME_LIFECYCLE_STATE = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
});

const ALLOWED_RUNTIME_LIFECYCLE_TRANSITIONS = Object.freeze({
  [RUNTIME_LIFECYCLE_STATE.STOPPED]: new Set([RUNTIME_LIFECYCLE_STATE.STARTING]),
  [RUNTIME_LIFECYCLE_STATE.STARTING]: new Set([RUNTIME_LIFECYCLE_STATE.RUNNING, RUNTIME_LIFECYCLE_STATE.STOPPED]),
  [RUNTIME_LIFECYCLE_STATE.RUNNING]: new Set([RUNTIME_LIFECYCLE_STATE.STOPPING]),
  [RUNTIME_LIFECYCLE_STATE.STOPPING]: new Set([RUNTIME_LIFECYCLE_STATE.STOPPED]),
});

function toNonEmptyString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function formatLocalClockTime(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function stripLeadingAgentSequencePrefix(text = '') {
  return String(text || '')
    .replace(/^\([A-Z][A-Z0-9 _-]*#?\d+\):\s*/i, '')
    .trim();
}

function isStructuredConsultationReplyPayload(content) {
  const text = toNonEmptyString(content);
  if (!text) return false;
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return false;
  try {
    const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
    return Boolean(
      toNonEmptyString(parsed?.requestId)
      && toNonEmptyString(parsed?.agentId)
      && Array.isArray(parsed?.signals)
    );
  } catch {
    return false;
  }
}

function isAcknowledgementOnlyAgentUpdate(content) {
  const text = stripLeadingAgentSequencePrefix(content);
  if (!text) return false;
  if (/\bno substantive task\b/i.test(text)) return true;
  if (/\bno resend needed\b/i.test(text)) return true;
  if (/\bnothing substantive missed\b/i.test(text)) return true;
  if (/\bnothing additional to resend\b/i.test(text)) return true;

  if (!/^(copy|ack(?:nowledged)?|confirmed|received|aligned|alignment confirmed|stand(?:ing)? by)\b/i.test(text)) {
    return false;
  }

  return !/\b(task|proof|investigat|analy[sz]e|review|write|implement|urgent|priority|objective|scope|validation|acceptance|deadline|reply|resend|please|need|check if)\b/i.test(text);
}

function isExplicitAgentTaskRequest(content) {
  const text = stripLeadingAgentSequencePrefix(content);
  if (!text) return false;
  if (/^\[TASK\]/i.test(text)) return true;
  if (/\bneed from you\b/i.test(text)) return true;
  if (/\b(can|could|would) you\b/i.test(text)) return true;
  if (/\bplease\b/i.test(text)) return true;
  if (/\bcheck if\b/i.test(text)) return true;
  if (/\breply via\b/i.test(text)) return true;
  if (/\bdeadline:\b/i.test(text)) return true;
  if (/[?]\s*$/.test(text)) return true;

  return /^(analy[sz]e|review|investigat(?:e|ion)?|check|verify|confirm|resend|reply|read|write|implement|fix|summari[sz]e|ask|send)\b/i.test(text);
}

function shouldWatchdogAgentTask(content) {
  const text = toNonEmptyString(content);
  if (!text) return false;
  if (isStructuredConsultationReplyPayload(text)) return false;
  if (isAcknowledgementOnlyAgentUpdate(text)) return false;
  if (/\bno (further )?(acknowledg(e)?ment|reply) needed\b/i.test(text)) return false;
  if (/\bno reply needed\b/i.test(text)) return false;
  if (/\bstanding by\b/i.test(text)) return false;
  if (/\[WATCHDOG\]/i.test(text)) return false;
  return isExplicitAgentTaskRequest(text);
}

const WATCHDOG_ELIGIBLE_AGENT_ROLES = new Set(['architect', 'builder', 'oracle']);

function normalizeWatchdogAgentRole(role) {
  const normalized = toNonEmptyString(role)?.toLowerCase();
  if (!normalized || !WATCHDOG_ELIGIBLE_AGENT_ROLES.has(normalized)) return null;
  return normalized;
}

function createAgentResponseWatchdogKey(senderRole, targetRole) {
  const normalizedSenderRole = normalizeWatchdogAgentRole(senderRole);
  const normalizedTargetRole = normalizeWatchdogAgentRole(targetRole);
  if (!normalizedSenderRole || !normalizedTargetRole) return null;
  return `${normalizedSenderRole}->${normalizedTargetRole}`;
}

class SquidRunApp {
  constructor(appContext, managers) {
    if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
      app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
    }

    this.ctx = appContext;
    this.settings = managers.settings;
    this.activity = managers.activity;
    this.usage = managers.usage;
    this.cliIdentity = managers.cliIdentity;
    this.firmwareManager = managers.firmwareManager;
    this.kernelBridge = createKernelBridge(() => this.ctx.mainWindow);
    this.paneHostWindowManager = createPaneHostWindowManager({
      getCurrentSettings: () => this.ctx.currentSettings || {},
      onLifecycleEvent: (event) => this.handlePaneHostLifecycleEvent(event),
    });
    this.backgroundAgentManager = createBackgroundAgentManager({
      getDaemonClient: () => this.ctx.daemonClient,
      getSettings: () => this.ctx.currentSettings || {},
      getSessionScopeId: () => this.commsSessionScopeId,
      resolveBuilderCwd: () => {
        const configured = this.ctx.currentSettings?.paneProjects?.[BACKGROUND_BUILDER_OWNER_PANE_ID];
        const normalized = typeof configured === 'string' ? configured.trim() : '';
        return normalized || path.resolve(path.join(WORKSPACE_PATH, '..'));
      },
      logActivity: (type, paneId, message, details) => this.activity.logActivity(type, paneId, message, details),
      onStateChanged: (agents) => {
        if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
          this.ctx.mainWindow.webContents.send('background-agents-state', {
            agents,
            targetMap: this.backgroundAgentManager.getTargetMap(),
          });
        }
      },
    });
    this.problemOrchestrator = createProblemOrchestrator();
    this.pendingAgentResponseWatchdogs = new Map();
    try {
      this.problemOrchestrator.ensureState();
    } catch (error) {
      log.warn('ProblemOrchestrator', `Failed ensuring active-cases state at startup: ${error.message}`);
    }
    this.lastDaemonOutputAtMs = Date.now();
    this.daemonClientListeners = [];
    this.consoleLogPath = path.join(WORKSPACE_PATH, 'console.log');
    this.consoleLogWriter = createBufferedFileWriter({
      filePath: this.consoleLogPath,
      flushIntervalMs: CONSOLE_LOG_FLUSH_INTERVAL_MS,
      ensureDir: () => {
        fs.mkdirSync(path.dirname(this.consoleLogPath), { recursive: true });
      },
      onError: (err) => {
        log.warn('App', `Failed to append to console.log: ${err.message}`);
      },
    });

    this.cliIdentityForwarderRegistered = false;
    this.triggerAckForwarderRegistered = false;
    this.startupReadyBuffers = new Map();
    this.pendingPtyDataByPane = new Map();
    this.ptyDataFlushTimer = null;
    this.ptyVisibleReleaseTimer = null;
    this.visiblePtyOutputFilter = createPtyOutputFilter();
    this.teamMemoryInitialized = false;
    this.teamMemoryInitPromise = null;
    this.teamMemoryInitFailed = false;
    this.teamMemoryDeferredStartupStarted = false;
    this.experimentInitialized = false;
    this.experimentInitPromise = null;
    this.experimentInitFailed = false;
    this.intentStateByPane = new Map();
    this.ledgerAppSession = null;
    this.commsSessionScopeId = `app-${process.pid}-${Date.now()}`;
    this.telegramInboundContext = {
      lastInboundAtMs: 0,
      sender: null,
      chatId: null,
    };
    this.autonomousSmoke = {
      inFlight: false,
      queuedRun: null,
      lastStartedAtMs: 0,
      sequence: 0,
    };
    this.bridgeClient = null;
    this.bridgeRuntimeConfig = this.resolveBridgeRuntimeConfig();
    this.pendingPaneDeliveryQueuePath = path.join(WORKSPACE_PATH, '.squidrun', 'runtime', 'pending-pane-deliveries.json');
    this.pendingPaneDeliveryReplayPromise = Promise.resolve();
    this.bridgeEnabled = Boolean(this.bridgeRuntimeConfig) || isCrossDeviceEnabled(process.env);
    this.bridgeDeviceId = this.bridgeRuntimeConfig?.deviceId || getProfileDeviceId(process.env, getActiveProfileName()) || null;
    this.bridgeRelayStatus = {
      enabled: this.bridgeEnabled === true,
      configured: Boolean(this.bridgeRuntimeConfig?.relayUrl && this.bridgeDeviceId),
      running: false,
      relayUrl: this.bridgeRuntimeConfig?.relayUrl || null,
      deviceId: this.bridgeDeviceId,
      state: 'disconnected',
      status: 'relay_not_started',
      error: null,
      lastUpdateAt: null,
      lastStatusChangeAt: null,
      lastConnectedAt: null,
      connectedSinceAt: null,
      lastDisconnectedAt: null,
      lastDisconnectReason: null,
      lastDisconnectCode: null,
      lastErrorAt: null,
      lastReconnectScheduledAt: null,
      nextReconnectDelayMs: null,
      nextReconnectAt: null,
      reconnectAttempt: 0,
      disconnectCount: 0,
      flapCount: 0,
      replacedConflictCount: 0,
      lastDispatchAt: null,
      lastDispatchStatus: null,
      lastDispatchTarget: null,
    };
    this.bridgePairingState = {
      mode: null,
      code: null,
      expiresAt: null,
      status: 'idle',
      error: null,
      reason: null,
      paired: null,
      updatedAt: Date.now(),
    };
    this.powerMonitorListeners = [];
    this.lastSystemSuspendAtMs = null;
    this.lastSystemResumeAtMs = null;
    this.wakeRecoveryInFlight = false;
    this.autoHandoffTimer = null;
    this.autoHandoffWriteInFlight = false;
    this.autoHandoffWritePromise = null;
    this.autoHandoffEnabled = AUTO_HANDOFF_ENABLED && process.env.NODE_ENV !== 'test';
    this.paneHostReady = new Set();
    this.paneHostMissingPanes = new Set();
    this.paneHostLastErrorReason = null;
    this.paneHostLastErrorAt = null;
    this.paneHostBootstrapTimer = null;
    this.paneHostBootstrapVerifyTimer = null;
    this.paneHostRecoveryTimer = null;
    this.paneHostReadyIpcRegistered = false;
    this.paneHostReadyListener = null;
    this.mainWindowSendRaw = null;
    this.mainWindowSendInterceptInstalled = false;
    this.websocketStartRetryTimer = null;
    this.websocketStartRetryAttempt = 0;
    this.supervisorBootstrapPromise = null;
    this.startupBriefingPromise = null;
    this.lastSystemCapabilities = null;
    this.daemonConnectTimeoutTimer = null;
    this.daemonConnectedForStartup = false;
    this.daemonTimeoutTriggered = false;
    this.daemonTimeoutNotified = false;
    this.packagedOnboardingState = null;
    this.shuttingDown = false;
    this.fullShutdownPromise = null;
    this.sessionEndCapturePromise = null;
    this.runtimeLifecycleState = RUNTIME_LIFECYCLE_STATE.STOPPED;
    this.runtimeLifecycleQueue = Promise.resolve();
    this.activeProfileName = getActiveProfileName();
    this.launchWindowProfile = {
      profileName: this.activeProfileName,
      windowKey: 'main',
      standaloneWindow: false,
    };
  }

  isBundledRuntimePath(targetPath = '') {
    const normalized = String(targetPath || '')
      .replace(/\\/g, '/')
      .toLowerCase();
    if (!normalized) return false;
    return normalized.includes('.app/contents/') || normalized.includes('app.asar');
  }

  getDefaultExternalWorkspacePath() {
    const homePath = (app && typeof app.getPath === 'function')
      ? app.getPath('home')
      : os.homedir();
    return path.join(homePath, EXTERNAL_WORKSPACE_DIRNAME);
  }

  resolveWorkspaceTemplateRoot() {
    const candidates = [
      path.resolve(path.join(__dirname, '..', '..', 'workspace-template')),
      path.resolve(path.join(process.resourcesPath || '', 'app.asar', 'ui', 'workspace-template')),
      path.resolve(path.join(process.resourcesPath || '', 'app.asar.unpacked', 'ui', 'workspace-template')),
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  copyFileIfMissing(sourcePath, destinationPath) {
    if (!sourcePath || !destinationPath) return false;
    if (!fs.existsSync(sourcePath)) return false;
    if (fs.existsSync(destinationPath)) return false;
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    return true;
  }

  copyDirectoryIfMissing(sourceDir, destinationDir) {
    if (!sourceDir || !destinationDir || !fs.existsSync(sourceDir)) return 0;
    let copied = 0;
    fs.mkdirSync(destinationDir, { recursive: true });
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const destinationPath = path.join(destinationDir, entry.name);
      if (entry.isDirectory()) {
        copied += this.copyDirectoryIfMissing(sourcePath, destinationPath);
        continue;
      }
      if (entry.isFile() && this.copyFileIfMissing(sourcePath, destinationPath)) {
        copied += 1;
      }
    }
    return copied;
  }

  writeFileAtomic(destinationPath, content, mode = undefined) {
    if (!destinationPath) return false;
    const resolved = path.resolve(destinationPath);
    const tempPath = `${resolved}.tmp`;
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(tempPath, content, mode !== undefined ? { encoding: 'utf8', mode } : 'utf8');
    fs.renameSync(tempPath, resolved);
    return true;
  }

  getStartupHealthPath() {
    return resolveCoordPath(path.join('build', 'startup-health.md'), { forWrite: true });
  }

  buildStartupHealthInventoryContent(snapshot = {}, sessionNumber = null) {
    const tests = Number(snapshot.tests?.testFileCount || 0);
    const suites = Number(snapshot.tests?.jestList?.count || 0);
    const modules = Number(snapshot.modules?.moduleFileCount || 0);
    const presentModules = Object.entries(snapshot.modules?.keyModules || {})
      .filter(([, value]) => value?.exists === true)
      .map(([key]) => key.replace(/_/g, '-'));
    const sessionLabel = Number.isInteger(sessionNumber) ? `Session ${sessionNumber}` : 'Current session';
    return `${sessionLabel} startup inventory: ${tests} test files, ${suites} Jest-discoverable suites, ${modules} JS modules under ui/modules. Key runtime modules present: ${presentModules.join(', ') || 'none'}.`;
  }

  buildStartupHealthStateContent(snapshot = {}, ledgerContext = {}, sessionNumber = null) {
    const level = String(snapshot.status?.level || 'unknown').toUpperCase();
    const score = Number.isFinite(Number(snapshot.status?.score)) ? Number(snapshot.status.score) : null;
    const evidenceRows = Number(snapshot.databases?.evidenceLedger?.rowCount || 0);
    const cognitiveRows = Number(snapshot.databases?.cognitiveMemory?.rowCount || 0);
    const bridgeMode = typeof snapshot.bridge?.mode === 'string' ? snapshot.bridge.mode : 'unknown';
    const bridgeState = typeof snapshot.bridge?.state === 'string'
      ? snapshot.bridge.state
      : (typeof snapshot.bridge?.status === 'string' ? snapshot.bridge.status : 'unknown');
    const memoryConsistencyStatus = typeof snapshot.memoryConsistency?.status === 'string'
      ? snapshot.memoryConsistency.status
      : 'unknown';
    const memoryConsistencySummary = snapshot.memoryConsistency?.summary || {};
    const canonicalSessionNumber = Number.isInteger(Number(sessionNumber))
      ? Number(sessionNumber)
      : (Number.isInteger(Number(snapshot.appStatus?.sessionNumber)) ? Number(snapshot.appStatus.sessionNumber) : null);
    const ledgerSession = canonicalSessionNumber ?? (Number.isInteger(Number(ledgerContext?.session)) ? Number(ledgerContext.session) : null);
    const ledgerMode = typeof ledgerContext?.mode === 'string' ? ledgerContext.mode : 'unknown';
    const ledgerStatus = typeof ledgerContext?.status === 'string' ? ledgerContext.status : 'unknown';
    return `Startup health ${Number.isInteger(canonicalSessionNumber) ? `for session ${canonicalSessionNumber}` : 'snapshot'}: overall ${level}${score !== null ? ` score=${score}/100` : ''}. Evidence ledger rows=${evidenceRows}, cognitive memory rows=${cognitiveRows}. Memory consistency=${memoryConsistencyStatus} (entries=${Number(memoryConsistencySummary.knowledgeEntryCount || 0)}, nodes=${Number(memoryConsistencySummary.knowledgeNodeCount || 0)}, missing=${Number(memoryConsistencySummary.missingInCognitiveCount || 0)}, orphans=${Number(memoryConsistencySummary.orphanedNodeCount || 0)}, duplicates=${Number(memoryConsistencySummary.duplicateKnowledgeHashCount || 0)}). Bridge mode=${bridgeMode}, connection=${bridgeState}. Ledger context: session ${ledgerSession ?? 'unknown'} ${ledgerStatus} (${ledgerMode}).`;
  }

  buildStartupHealthReport(snapshot = {}, ledgerContext = {}, sessionNumber = null) {
    const healthBody = String(renderStartupHealthMarkdown(snapshot) || '').trim();
    const lines = [healthBody];
    const ledgerLines = [];
    const canonicalSessionNumber = Number.isInteger(Number(sessionNumber))
      ? Number(sessionNumber)
      : (Number.isInteger(Number(snapshot.appStatus?.sessionNumber)) ? Number(snapshot.appStatus.sessionNumber) : null);
    const ledgerSession = canonicalSessionNumber ?? (Number.isInteger(Number(ledgerContext?.session)) ? Number(ledgerContext.session) : null);
    const ledgerStatus = typeof ledgerContext?.status === 'string' ? ledgerContext.status : null;
    const ledgerMode = typeof ledgerContext?.mode === 'string' ? ledgerContext.mode : null;
    if (ledgerSession !== null || ledgerStatus || ledgerMode) {
      ledgerLines.push(`- Session context: ${ledgerSession !== null ? `session ${ledgerSession}` : 'unknown'}${ledgerStatus ? ` ${ledgerStatus}` : ''}${ledgerMode ? ` (${ledgerMode})` : ''}`);
    }

    const recentCompletions = takeStartupSummaryItems(ledgerContext?.completed, 2);
    if (recentCompletions.length > 0) {
      ledgerLines.push(`- Recent completions: ${recentCompletions.join(' | ')}`);
    }

    const openWork = takeStartupSummaryItems(ledgerContext?.roadmap || ledgerContext?.not_yet_done, 2);
    if (openWork.length > 0) {
      ledgerLines.push(`- Open work: ${openWork.join(' | ')}`);
    }

    const notes = takeStartupSummaryItems(ledgerContext?.important_notes, 2);
    if (notes.length > 0) {
      ledgerLines.push(`- Important notes: ${notes.join(' | ')}`);
    }

    if (ledgerLines.length > 0) {
      lines.push('', 'STARTUP LEDGER', ...ledgerLines);
    }
    return `${lines.filter(Boolean).join('\n').trim()}\n`;
  }

  buildStartupHealthPlaceholderReport(sessionNumber = null, options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
    const generatedAt = typeof options.generatedAt === 'string' && options.generatedAt.trim()
      ? options.generatedAt.trim()
      : new Date(nowMs).toISOString();
    const canonicalSessionNumber = asPositiveInt(
      sessionNumber ?? this.getCurrentAppStatusSessionNumber(),
      null
    );
    const sessionLabel = canonicalSessionNumber !== null
      ? `session ${canonicalSessionNumber}`
      : 'unknown';
    return [
      'STARTUP HEALTH',
      '- Overall: REFRESHING',
      `- Generated: ${generatedAt}`,
      `- App Session: ${sessionLabel}`,
      '',
      'STARTUP LEDGER',
      `- Session context: ${sessionLabel} ACTIVE (APP)`,
      '- Snapshot status: refreshing current-session startup health...',
      '',
    ].join('\n');
  }

  async ingestStartupHealthSnapshot(snapshot = {}, ledgerContext = {}, options = {}) {
    const ready = await this.ensureTeamMemoryInitialized('startup-health');
    if (!ready) {
      return { ok: false, reason: 'team_memory_unavailable' };
    }

    const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
    const sessionNumber = asPositiveInt(options.sessionNumber ?? this.getCurrentAppStatusSessionNumber(), null);
    const sessionId = this.ledgerAppSession?.sessionId || this.commsSessionScopeId || null;
    const provenance = {
      source: 'startup-health-snapshot',
      kind: 'observed',
      actor: 'system',
    };

    const sharedPayload = {
      provenance,
      session_id: sessionId,
      session_ordinal: sessionNumber,
      confidence: 0.58,
      nowMs,
      scope: {
        project: 'squidrun',
        source: 'startup-health',
        generated_at: snapshot.generatedAt || new Date(nowMs).toISOString(),
      },
    };

    const inventoryResult = await teamMemory.executeTeamMemoryOperation('ingest-memory', {
      ...sharedPayload,
      confidence: 0.56,
      memory_class: 'codebase_inventory',
      source_trace: `startup-health:inventory:${sessionNumber || 'unknown'}:${nowMs}`,
      content: this.buildStartupHealthInventoryContent(snapshot, sessionNumber),
    });
    const healthResult = await teamMemory.executeTeamMemoryOperation('ingest-memory', {
      ...sharedPayload,
      confidence: 0.57,
      memory_class: 'system_health_state',
      source_trace: `startup-health:state:${sessionNumber || 'unknown'}:${nowMs}`,
      content: this.buildStartupHealthStateContent(snapshot, ledgerContext, sessionNumber),
    });

    if (inventoryResult?.ok === false || healthResult?.ok === false) {
      return {
        ok: false,
        reason: 'startup_health_ingest_failed',
        inventoryResult,
        healthResult,
      };
    }

    return {
      ok: true,
      inventoryResult,
      healthResult,
    };
  }

  async refreshStartupHealthArtifacts(options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
    const canonicalSessionNumber = asPositiveInt(
      options.sessionNumber ?? this.getCurrentAppStatusSessionNumber(),
      null
    );
    const generatedAt = typeof options.generatedAt === 'string' && options.generatedAt.trim()
      ? options.generatedAt.trim()
      : new Date(nowMs).toISOString();
    const outputPath = this.getStartupHealthPath();
    this.writeFileAtomic(
      outputPath,
      this.buildStartupHealthPlaceholderReport(canonicalSessionNumber, {
        nowMs,
        generatedAt,
      })
    );

    const snapshot = createHealthSnapshot({
      projectRoot: options.projectRoot || getProjectRoot(),
      jestTimeoutMs: options.jestTimeoutMs,
      bridgeStatus: this.getBridgeStatus(),
      systemCapabilities: this.lastSystemCapabilities,
      nowMs,
      generatedAt,
    });
    const resolvedSessionNumber = asPositiveInt(
      canonicalSessionNumber
      ?? snapshot.appStatus?.sessionNumber
      ?? this.getCurrentAppStatusSessionNumber(),
      null
    );
    const ledgerContext = await executeEvidenceLedgerOperation(
      'get-context',
      resolvedSessionNumber ? { sessionNumber: resolvedSessionNumber } : {},
      {
        source: {
          via: 'startup-health',
          role: 'system',
          paneId: null,
        },
      }
    );
    const report = this.buildStartupHealthReport(
      snapshot,
      ledgerContext && ledgerContext.ok === false ? {} : (ledgerContext || {}),
      resolvedSessionNumber
    );
    this.writeFileAtomic(outputPath, report);

    let ingestResult = {
      ok: false,
      skipped: true,
      reason: 'team_memory_not_initialized',
    };
    if (options.ingestToMemory === true || this.teamMemoryInitialized) {
      ingestResult = await this.ingestStartupHealthSnapshot(
        snapshot,
        ledgerContext && ledgerContext.ok === false ? {} : (ledgerContext || {}),
        {
          nowMs,
          sessionNumber: resolvedSessionNumber,
        }
      );
    }

    return {
      ok: true,
      outputPath,
      snapshot,
      ledgerContext,
      ingestResult,
    };
  }

  applyLocalModelEnvironment(snapshot = null) {
    const extractionCommand = resolveSleepExtractionCommandFromSnapshot(snapshot);
    if (extractionCommand) {
      process.env.SQUIDRUN_SLEEP_EXTRACTION_COMMAND = extractionCommand;
    } else {
      delete process.env.SQUIDRUN_SLEEP_EXTRACTION_COMMAND;
    }
    return extractionCommand;
  }

  async refreshSystemCapabilities(options = {}) {
    const projectRoot = options.projectRoot || getProjectRoot();
    const snapshot = buildSystemCapabilitiesSnapshot({
      projectRoot,
      nowMs: options.nowMs,
      settings: this.ctx.currentSettings,
    });
    writeSystemCapabilitiesSnapshot(snapshot, snapshot.path);
    this.lastSystemCapabilities = snapshot;
    this.applyLocalModelEnvironment(snapshot);
    return snapshot;
  }

  copyPathRecursive(sourcePath, destinationPath) {
    if (!sourcePath || !destinationPath || !fs.existsSync(sourcePath)) return false;
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      fs.mkdirSync(destinationPath, { recursive: true });
      const entries = fs.readdirSync(sourcePath, { withFileTypes: true });
      for (const entry of entries) {
        this.copyPathRecursive(
          path.join(sourcePath, entry.name),
          path.join(destinationPath, entry.name)
        );
      }
      return true;
    }
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    return true;
  }

  resolvePackagedUiRoot() {
    const candidates = [
      path.resolve(path.join(__dirname, '..', '..')),
      path.resolve(path.join(process.resourcesPath || '', 'app.asar', 'ui')),
      path.resolve(path.join(process.resourcesPath || '', 'app.asar.unpacked', 'ui')),
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  ensurePackagedCommsBin(workspacePath) {
    if (!workspacePath) return null;
    const uiRoot = this.resolvePackagedUiRoot();
    if (!uiRoot) {
      log.warn('ProjectLifecycle', 'Unable to resolve packaged UI root for hm-send/hm-comms bootstrap');
      return null;
    }

    const runtimeRoot = path.join(workspacePath, PACKAGED_BIN_RUNTIME_RELATIVE);
    const binRoot = path.join(workspacePath, '.squidrun', 'bin');
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });

    const requiredFiles = [
      'config.js',
      path.join('scripts', 'hm-send.js'),
      path.join('scripts', 'hm-comms.js'),
      path.join('scripts', 'hm-telegram.js'),
      path.join('modules', 'cross-device-target.js'),
      path.join('modules', 'bridge-client.js'),
      path.join('modules', 'logger.js'),
      path.join('modules', 'buffered-file-writer.js'),
      path.join('modules', 'comms', 'message-envelope.js'),
      path.join('modules', 'main', 'comms-journal.js'),
      path.join('modules', 'main', 'evidence-ledger-store.js'),
      path.join('modules', 'main', 'evidence-ledger-ingest.js'),
    ];
    for (const relPath of requiredFiles) {
      const sourcePath = path.join(uiRoot, relPath);
      const destinationPath = path.join(runtimeRoot, relPath);
      this.copyPathRecursive(sourcePath, destinationPath);
    }

    const moduleDeps = ['ws', 'dotenv'];
    for (const depName of moduleDeps) {
      this.copyPathRecursive(
        path.join(uiRoot, 'node_modules', depName),
        path.join(runtimeRoot, 'node_modules', depName)
      );
    }

    const unixLaunchers = {
      'hm-send': 'hm-send.js',
      'hm-comms': 'hm-comms.js',
    };
    for (const [commandName, scriptName] of Object.entries(unixLaunchers)) {
      const launcherPath = path.join(binRoot, commandName);
      const launcherScript = [
        '#!/usr/bin/env sh',
        'SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
        '# Resolve workspace root (2 levels up from .squidrun/bin/)',
        'SQUIDRUN_PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"',
        'export SQUIDRUN_PROJECT_ROOT',
        '# Suppress node:sqlite ExperimentalWarning noise',
        'NODE_NO_WARNINGS=1',
        'export NODE_NO_WARNINGS',
        `node "$SCRIPT_DIR/runtime/ui/scripts/${scriptName}" "$@"`,
        '',
      ].join('\n');
      this.writeFileAtomic(launcherPath, launcherScript, 0o755);
      try {
        fs.chmodSync(launcherPath, 0o755);
      } catch (_) {
        // Best-effort chmod for non-POSIX hosts.
      }

      const windowsLauncherPath = path.join(binRoot, `${commandName}.cmd`);
      const windowsLauncher = [
        '@echo off',
        'set "SCRIPT_DIR=%~dp0"',
        ':: Resolve workspace root (2 levels up from .squidrun\\bin\\)',
        'for %%I in ("%SCRIPT_DIR%..\\..") do set "SQUIDRUN_PROJECT_ROOT=%%~fI"',
        ':: Suppress node:sqlite ExperimentalWarning noise',
        'set "NODE_NO_WARNINGS=1"',
        `node "%SCRIPT_DIR%runtime\\ui\\scripts\\${scriptName}" %*`,
        '',
      ].join('\r\n');
      this.writeFileAtomic(windowsLauncherPath, windowsLauncher);
    }

    return binRoot;
  }

  getOnboardingStatePath(workspacePath = null) {
    const baseWorkspace = workspacePath || this.getDefaultExternalWorkspacePath();
    return path.join(baseWorkspace, '.squidrun', ONBOARDING_STATE_FILENAME);
  }

  getFreshInstallMarkerPath(workspacePath = null) {
    const baseWorkspace = workspacePath || this.getDefaultExternalWorkspacePath();
    return path.join(baseWorkspace, '.squidrun', FRESH_INSTALL_MARKER_FILENAME);
  }

  readOnboardingState(workspacePath = null) {
    const onboardingPath = this.getOnboardingStatePath(workspacePath);
    if (!fs.existsSync(onboardingPath)) return null;
    try {
      const raw = fs.readFileSync(onboardingPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (err) {
      log.warn('ProjectLifecycle', `Failed to parse onboarding state: ${err.message}`);
      return null;
    }
  }

  deriveConfiguredFeatures(payload = {}) {
    const explicit = Array.isArray(payload?.configured_features)
      ? payload.configured_features
      : null;
    if (explicit) {
      return Array.from(new Set(explicit.map((value) => String(value || '').trim()).filter(Boolean)));
    }

    const settings = this.ctx?.currentSettings || {};
    const features = [];
    if (settings.autoSpawn !== false) features.push('auto-spawn');
    if (settings.autonomyConsentGiven === true) features.push('autonomy-consent');
    if (settings.allowAllPermissions === true) features.push('autonomy-enabled');
    if (settings.externalNotificationsEnabled === true) features.push('external-notifications');
    if (settings.mcpAutoConfig === true) features.push('mcp-autoconfig');
    if (settings.firmwareInjectionEnabled === true) features.push('firmware-injection');
    return features;
  }

  writeOnboardingState(payload = {}, workspacePath = null) {
    const effectiveWorkspacePath = workspacePath || this.getDefaultExternalWorkspacePath();
    const onboardingPath = this.getOnboardingStatePath(effectiveWorkspacePath);
    const userName = String(
      payload.user_name
      || payload.userName
      || this.ctx?.currentSettings?.userName
      || ''
    ).trim();
    const state = {
      onboarding_complete: true,
      completed_at: new Date().toISOString(),
      user_name: userName,
      workspace_path: path.resolve(effectiveWorkspacePath),
      configured_features: this.deriveConfiguredFeatures(payload),
    };
    this.writeFileAtomic(onboardingPath, `${JSON.stringify(state, null, 2)}\n`);
    this.packagedOnboardingState = state;
    this.clearFreshInstallMarker(effectiveWorkspacePath);
    return {
      state,
      path: onboardingPath,
    };
  }

  writeFreshInstallMarker(workspacePath = null) {
    const effectiveWorkspacePath = workspacePath || this.getDefaultExternalWorkspacePath();
    const markerPath = this.getFreshInstallMarkerPath(effectiveWorkspacePath);
    const payload = {
      fresh_install: true,
      created_at: new Date().toISOString(),
      workspace_path: path.resolve(effectiveWorkspacePath),
      source: 'packaged-bootstrap',
    };
    this.writeFileAtomic(markerPath, `${JSON.stringify(payload, null, 2)}\n`);
    return markerPath;
  }

  clearFreshInstallMarker(workspacePath = null) {
    const effectiveWorkspacePath = workspacePath || this.getDefaultExternalWorkspacePath();
    const markerPath = this.getFreshInstallMarkerPath(effectiveWorkspacePath);
    try {
      if (fs.existsSync(markerPath)) {
        fs.rmSync(markerPath, { force: true });
      }
    } catch (err) {
      log.warn('ProjectLifecycle', `Failed clearing fresh-install marker: ${err.message}`);
    }
  }

  ensurePackagedWorkspaceBootstrap() {
    if (!app || app.isPackaged !== true) {
      return null;
    }

    const workspacePath = this.getDefaultExternalWorkspacePath();
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(path.join(workspacePath, '.squidrun'), { recursive: true });

    const templateRoot = this.resolveWorkspaceTemplateRoot();
    if (templateRoot) {
      this.copyFileIfMissing(
        path.join(templateRoot, 'CLAUDE.md'),
        path.join(workspacePath, 'CLAUDE.md')
      );
      this.copyFileIfMissing(
        path.join(templateRoot, 'CLAUDE.eunbyeol.md'),
        path.join(workspacePath, 'CLAUDE.eunbyeol.md')
      );
      this.copyFileIfMissing(
        path.join(templateRoot, 'ROLES.md'),
        path.join(workspacePath, 'ROLES.md')
      );
      this.copyFileIfMissing(
        path.join(templateRoot, 'ROLES.eunbyeol.md'),
        path.join(workspacePath, 'ROLES.eunbyeol.md')
      );
      this.copyFileIfMissing(
        path.join(templateRoot, 'PRODUCT-GUIDE.md'),
        path.join(workspacePath, 'PRODUCT-GUIDE.md')
      );
      this.copyFileIfMissing(
        path.join(templateRoot, 'user-profile.json'),
        path.join(workspacePath, 'user-profile.json')
      );
      this.copyFileIfMissing(
        path.join(templateRoot, 'GEMINI.md'),
        path.join(workspacePath, 'GEMINI.md')
      );
      this.copyFileIfMissing(
        path.join(templateRoot, 'CODEX.md'),
        path.join(workspacePath, 'CODEX.md')
      );
      this.copyFileIfMissing(
        path.join(templateRoot, 'AGENTS.md'),
        path.join(workspacePath, 'AGENTS.md')
      );
      this.copyDirectoryIfMissing(
        path.join(templateRoot, '.squidrun'),
        path.join(workspacePath, '.squidrun')
      );
    } else {
      log.warn('ProjectLifecycle', 'Workspace template bundle missing; skipping seed file copy');
    }

    if (typeof setProjectRoot === 'function') {
      setProjectRoot(workspacePath);
    }

    this.ensurePackagedCommsBin(workspacePath);

    const onboardingSnapshot = this.readPersistedOnboardingState();
    const onboardingState = onboardingSnapshot?.state || null;
    const onboardingComplete = this.isOnboardingComplete(onboardingState);

    // Packaged-first-run guard: always reset app-status when onboarding is incomplete.
    // This prevents stale packaged app-status payloads from leaking prior dev sessions.
    const appStatusPath = path.join(workspacePath, '.squidrun', 'app-status.json');
    if (!onboardingComplete || !fs.existsSync(appStatusPath)) {
      try {
        let appVersion = 'unknown';
        try { appVersion = require('../../package.json').version || appVersion; } catch (_) {}
        const initialStatus = {
          started: new Date().toISOString(),
          mode: this.ctx.currentSettings?.dryRun ? 'dry-run' : 'pty',
          dryRun: this.ctx.currentSettings?.dryRun === true,
          autoSpawn: this.ctx.currentSettings?.autoSpawn !== false,
          version: appVersion,
          platform: process.platform,
          nodeVersion: process.version,
          session: 0,
          lastUpdated: new Date().toISOString(),
        };
        this.writeFileAtomic(appStatusPath, `${JSON.stringify(initialStatus, null, 2)}\n`);
        log.info(
          'ProjectLifecycle',
          onboardingComplete
            ? 'Created missing app-status.json for packaged workspace'
            : 'Reset app-status.json for packaged fresh-install bootstrap'
        );
      } catch (err) {
        log.warn('ProjectLifecycle', `Failed creating app-status.json: ${err.message}`);
      }
    }

    this.packagedOnboardingState = onboardingState;
    if (onboardingComplete) {
      this.clearFreshInstallMarker(workspacePath);
    } else {
      this.writeFreshInstallMarker(workspacePath);
    }

    try {
      const currentState = (typeof watcher.readState === 'function' ? watcher.readState() : {}) || {};
      const currentProject = typeof currentState.project === 'string' ? currentState.project.trim() : '';
      if (
        typeof watcher.writeState === 'function'
        && (!currentProject || this.isBundledRuntimePath(currentProject))
      ) {
        watcher.writeState({
          ...currentState,
          project: workspacePath,
        });
      }
    } catch (err) {
      log.warn('ProjectLifecycle', `Failed writing packaged workspace state: ${err.message}`);
    }

    return workspacePath;
  }

  async initializeStartupSessionScope(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const finalizeSessionScope = async (result) => {
      try {
        await this.backgroundAgentManager.handleSessionScopeChange(this.commsSessionScopeId || null);
      } catch (err) {
        log.warn('BackgroundAgent', `Session scope cleanup failed: ${err.message}`);
      }
      return result;
    };
    const startupSource = {
      via: 'app-startup',
      role: 'system',
      paneId: null,
    };
    const fallbackScope = `app-${process.pid}-${Date.now()}`;
    this.commsSessionScopeId = fallbackScope;

    const preferredSessionNumber = asPositiveInt(opts.sessionNumber ?? opts.session, null);
    const hasPreferredSessionNumber = Number.isInteger(preferredSessionNumber);
    const preferredScopeId = hasPreferredSessionNumber
      ? `app-session-${preferredSessionNumber}`
      : null;

    if (preferredScopeId) {
      this.commsSessionScopeId = preferredScopeId;
    }

    let nextSessionNumber = preferredSessionNumber || 1;
    if (!preferredSessionNumber) {
      try {
        const latestSessions = await executeEvidenceLedgerOperation(
          'list-sessions',
          { limit: 1, order: 'desc' },
          { source: startupSource }
        );
        if (Array.isArray(latestSessions) && latestSessions.length > 0) {
          const latestSessionNumber = asPositiveInt(latestSessions[0]?.sessionNumber, null);
          if (latestSessionNumber) {
            nextSessionNumber = latestSessionNumber + 1;
          }
        } else if (latestSessions?.ok === false) {
          log.warn('EvidenceLedger', `Unable to inspect prior sessions at startup: ${latestSessions.reason || 'unknown'}`);
        }
      } catch (err) {
        log.warn('EvidenceLedger', `Startup session lookup failed: ${err.message}`);
      }
    }

    for (let attempt = 0; attempt < APP_STARTUP_SESSION_RETRY_LIMIT; attempt += 1) {
      const sessionNumber = hasPreferredSessionNumber
        ? preferredSessionNumber
        : (nextSessionNumber + attempt);
      const startResult = await executeEvidenceLedgerOperation(
        'record-session-start',
        {
          sessionNumber,
          mode: 'APP',
          meta: {
            source: 'squidrun-app',
            pid: process.pid,
            startup: true,
          },
        },
        { source: startupSource }
      );

      if (startResult?.ok) {
        const sessionId = typeof startResult.sessionId === 'string' ? startResult.sessionId : null;
        this.ledgerAppSession = {
          sessionId,
          sessionNumber,
        };
        this.commsSessionScopeId = preferredScopeId || (sessionId
          ? `app-session-${sessionNumber}-${sessionId}`
          : `app-session-${sessionNumber}`);

        log.info('EvidenceLedger', `Recorded app startup session ${sessionNumber}${sessionId ? ` (${sessionId})` : ''}`);

        if (sessionId) {
          const snapshotResult = await executeEvidenceLedgerOperation(
            'snapshot-context',
            {
              sessionId,
              trigger: 'session_start',
            },
            { source: startupSource }
          );
          if (snapshotResult?.ok === false) {
            log.warn('EvidenceLedger', `Startup session snapshot failed: ${snapshotResult.reason || 'unknown'}`);
          }
        }
        return finalizeSessionScope(this.ledgerAppSession);
      }

      if (startResult?.reason === 'conflict' && preferredScopeId) {
        // App status already established the canonical app session number.
        // If session-start for that number already exists, keep scope stable.
        this.ledgerAppSession = {
          sessionId: null,
          sessionNumber: preferredSessionNumber,
        };
        this.commsSessionScopeId = preferredScopeId;
        log.warn('EvidenceLedger', `Startup session ${preferredSessionNumber} already exists; reusing app-status scope.`);
        return finalizeSessionScope(this.ledgerAppSession);
      }

      if (startResult?.reason !== 'conflict') {
        log.warn('EvidenceLedger', `Startup session start failed: ${startResult?.reason || 'unknown'}`);
        break;
      }
    }

    log.warn('EvidenceLedger', `Falling back to ephemeral comms session scope (${fallbackScope})`);
    return finalizeSessionScope(null);
  }

  getCurrentAppStatusSessionNumber() {
    try {
      if (!this.settings || typeof this.settings.readAppStatus !== 'function') return null;
      const status = this.settings.readAppStatus();
      return asPositiveInt(status?.session ?? status?.session_number ?? status?.sessionNumber, null);
    } catch {
      return null;
    }
  }

  async resolveLedgerSessionForShutdown(sessionNumber = null) {
    const canonicalSessionNumber = asPositiveInt(
      sessionNumber ?? this.ledgerAppSession?.sessionNumber ?? this.getCurrentAppStatusSessionNumber(),
      null
    );
    if (this.ledgerAppSession?.sessionId && this.ledgerAppSession?.sessionNumber === canonicalSessionNumber) {
      return {
        sessionId: this.ledgerAppSession.sessionId,
        sessionNumber: canonicalSessionNumber,
      };
    }
    if (!canonicalSessionNumber) return null;

    const sessions = await executeEvidenceLedgerOperation(
      'list-sessions',
      { limit: 10, order: 'desc' },
      {
        source: {
          via: 'app-shutdown',
          role: 'system',
          paneId: null,
        },
      }
    );
    if (!Array.isArray(sessions)) return null;

    const match = sessions.find((entry) => {
      return asPositiveInt(entry?.sessionNumber, null) === canonicalSessionNumber;
    });
    if (!match?.sessionId) return null;
    return {
      sessionId: match.sessionId,
      sessionNumber: canonicalSessionNumber,
    };
  }

  async captureSessionEndState(options = {}) {
    if (this.sessionEndCapturePromise) {
      return this.sessionEndCapturePromise;
    }

    this.sessionEndCapturePromise = (async () => {
      const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
      const sessionNumber = asPositiveInt(
        options.sessionNumber ?? this.ledgerAppSession?.sessionNumber ?? this.getCurrentAppStatusSessionNumber(),
        null
      );
      if (!sessionNumber) {
        return {
          ok: false,
          skipped: true,
          reason: 'session_number_unavailable',
        };
      }

      const source = {
        via: 'app-shutdown',
        role: 'system',
        paneId: null,
      };
      const summaryResult = await generateSessionSummary({
        sessionNumber,
        includeSummaryText: true,
        queryCommsJournal: (filters, queryOptions) => queryCommsJournalEntries(filters, queryOptions),
        dbPath: options.dbPath || null,
        nowMs,
      });
      const summaryMarkdown = typeof summaryResult?.summaryText === 'string'
        ? summaryResult.summaryText
        : `# Session ${sessionNumber} Summary\n\nNo messages recorded in this session.\n`;
      const messageCount = Number.isFinite(Number(summaryResult?.messageCount))
        ? Math.max(0, Math.floor(Number(summaryResult.messageCount)))
        : 0;
      const sessionSummary = {
        sessionNumber,
        sessionScopeId: this.commsSessionScopeId || null,
        messageCount,
        generatedAt: new Date(nowMs).toISOString(),
        createdAtMs: nowMs,
        summaryMarkdown,
        fallbackPath: summaryResult?.fallbackResult?.path || null,
        memoryNodeId: summaryResult?.memoryResult?.nodeId || null,
      };
      const sessionSummaryLine = `Session ${sessionNumber} captured ${messageCount} message${messageCount === 1 ? '' : 's'} before shutdown.`;
      const ledgerSession = await this.resolveLedgerSessionForShutdown(sessionNumber);

      let precompactResult = {
        ok: false,
        skipped: true,
        reason: 'team_memory_not_initialized',
      };
      if (this.teamMemoryInitialized) {
        try {
          precompactResult = await teamMemory.executeTeamMemoryOperation('capture-precompact-memory', {
            session_id: this.commsSessionScopeId || null,
            session_ordinal: sessionNumber,
            summary: summaryMarkdown,
            reason: 'session_end',
            nowMs,
          });
        } catch (err) {
          precompactResult = { ok: false, reason: 'capture_failed', error: err.message };
        }
      }

      if (!ledgerSession?.sessionId) {
        return {
          ok: summaryResult?.ok !== false,
          skipped: true,
          reason: 'ledger_session_unavailable',
          summaryResult,
          precompactResult,
        };
      }

      const recordResult = await executeEvidenceLedgerOperation(
        'record-session-end',
        {
          sessionId: ledgerSession.sessionId,
          endedAtMs: nowMs,
          summary: sessionSummaryLine,
          stats: {
            messageCount,
          },
          meta: {
            source: 'squidrun-app',
            sessionScopeId: this.commsSessionScopeId || null,
            fallbackSummaryPath: sessionSummary.fallbackPath,
            memoryNodeId: sessionSummary.memoryNodeId,
          },
        },
        { source }
      );
      const snapshotResult = await executeEvidenceLedgerOperation(
        'snapshot-context',
        {
          sessionId: ledgerSession.sessionId,
          trigger: 'session_end',
          nowMs,
          content: {
            session: sessionNumber,
            date: new Date(nowMs).toISOString().slice(0, 10),
            mode: 'APP',
            status: 'READY',
            source: 'ledger.session_end',
            summary: sessionSummaryLine,
            summaryMarkdown,
            stats: {
              messageCount,
            },
            sessionSummary,
          },
        },
        { source }
      );

      return {
        ok: recordResult?.ok !== false && snapshotResult?.ok !== false,
        summaryResult,
        precompactResult,
        recordResult,
        snapshotResult,
        sessionSummary,
      };
    })();

    return this.sessionEndCapturePromise;
  }

  getStartupSessionFloor() {
    if (app && app.isPackaged === true) {
      return 0;
    }
    return APP_SESSION_COUNTER_FLOOR;
  }

  isOnboardingComplete(state = null) {
    if (!state || typeof state !== 'object') return false;
    return state.onboarding_complete === true || state.onboardingComplete === true;
  }

  resolveOnboardingWorkspaceCandidates() {
    const candidates = [];
    const defaultWorkspace = this.getDefaultExternalWorkspacePath();
    if (defaultWorkspace) {
      candidates.push(path.resolve(defaultWorkspace));
    }

    try {
      if (typeof getProjectRoot === 'function') {
        const activeRoot = getProjectRoot();
        if (typeof activeRoot === 'string' && activeRoot.trim()) {
          candidates.push(path.resolve(activeRoot));
        }
      }
    } catch (_) {
      // Best-effort only.
    }

    if (this.packagedOnboardingState?.workspace_path) {
      candidates.push(path.resolve(String(this.packagedOnboardingState.workspace_path)));
    }

    try {
      const state = (typeof watcher.readState === 'function' ? watcher.readState() : null) || null;
      const stateProject = typeof state?.project === 'string' ? state.project.trim() : '';
      if (stateProject && !this.isBundledRuntimePath(stateProject)) {
        candidates.push(path.resolve(stateProject));
      }
    } catch (_) {
      // Best-effort only.
    }

    return Array.from(new Set(candidates));
  }

  readPersistedOnboardingState() {
    const candidates = this.resolveOnboardingWorkspaceCandidates();
    let fallback = null;
    for (const workspacePath of candidates) {
      const state = this.readOnboardingState(workspacePath);
      if (!state) continue;
      const payload = {
        state,
        path: this.getOnboardingStatePath(workspacePath),
        workspacePath,
      };
      if (this.isOnboardingComplete(state)) {
        return payload;
      }
      if (!fallback) fallback = payload;
    }
    return fallback || {
      state: null,
      path: this.getOnboardingStatePath(this.getDefaultExternalWorkspacePath()),
      workspacePath: this.getDefaultExternalWorkspacePath(),
    };
  }

  isHiddenPaneHostModeEnabled() {
    if (process.env.SQUIDRUN_HIDDEN_PANE_HOSTS === '1') return true;
    return this.ctx?.currentSettings?.hiddenPaneHostsEnabled === true;
  }

  getHiddenPaneHostPaneIds() {
    if (!this.isHiddenPaneHostModeEnabled()) return [];
    return [...PANE_IDS];
  }

  updatePaneHostStatus() {
    if (!this.settings || typeof this.settings.writeAppStatus !== 'function') return;
    this.settings.writeAppStatus({
      statusPatch: {
        paneHost: {
          hiddenModeEnabled: this.isHiddenPaneHostModeEnabled(),
          degraded: this.paneHostMissingPanes.size > 0,
          missingPanes: Array.from(this.paneHostMissingPanes).sort(),
          readyPanes: Array.from(this.paneHostReady).sort(),
          lastErrorReason: this.paneHostLastErrorReason,
          lastErrorAt: this.paneHostLastErrorAt,
          lastCheckedAt: new Date().toISOString(),
        },
      },
    });
  }

  reportPaneHostDegraded({
    paneId = null,
    reason = 'unknown',
    message = '',
    details = null,
  } = {}) {
    const id = paneId === null || paneId === undefined ? null : String(paneId).trim();
    const normalizedReason = String(reason || 'unknown');
    const wasMissing = id ? this.paneHostMissingPanes.has(id) : false;
    const reasonChanged = this.paneHostLastErrorReason !== normalizedReason;
    const nowIso = new Date().toISOString();

    if (id) {
      this.paneHostMissingPanes.add(id);
    }
    this.paneHostLastErrorReason = normalizedReason;
    this.paneHostLastErrorAt = nowIso;

    const fallbackMessage = (typeof message === 'string' && message.trim())
      ? message.trim()
      : `Hidden pane host degraded for pane ${id || 'unknown'}.`;

    log.error('PaneHost', fallbackMessage);
    this.activity.logActivity('error', id || 'system', fallbackMessage, {
      subsystem: 'pane-host',
      reason: normalizedReason,
      paneId: id,
      ...(details && typeof details === 'object' ? details : {}),
    });
    if (this.ctx.externalNotifier && typeof this.ctx.externalNotifier.notify === 'function') {
      this.ctx.externalNotifier.notify({
        category: 'alert',
        title: 'Hidden Pane Host Degraded',
        message: fallbackMessage,
        meta: {
          reason: normalizedReason,
          paneId: id,
          ...(details && typeof details === 'object' ? details : {}),
        },
      }).catch((notifyErr) => {
        log.warn('PaneHost', `Failed to emit degraded notification: ${notifyErr.message}`);
      });
    }

    if (wasMissing && !reasonChanged) return;
    this.updatePaneHostStatus();
  }

  clearPaneHostDegraded(paneId) {
    const id = String(paneId || '').trim();
    if (!id) return;
    if (!this.paneHostMissingPanes.delete(id)) return;

    if (this.paneHostMissingPanes.size === 0) {
      this.paneHostLastErrorReason = null;
      this.paneHostLastErrorAt = null;
    }

    log.info('PaneHost', `Hidden pane host recovered for pane ${id}`);
    this.updatePaneHostStatus();
  }

  verifyPaneHostWindowsAfterBootstrap(source = 'startup') {
    if (!this.isHiddenPaneHostModeEnabled()) return;
    const paneIds = this.getHiddenPaneHostPaneIds();
    if (!paneIds.length) return;
    const diagnostics = this.paneHostWindowManager.getWindowDiagnostics?.() || null;
    const now = Date.now();
    const stillLoading = Boolean(diagnostics?.loading);
    const loadingAgeMs = diagnostics?.lastLoadStartedAt
      ? Math.max(0, now - diagnostics.lastLoadStartedAt)
      : null;
    const postLoadAgeMs = diagnostics?.lastDidFinishLoadAt
      ? Math.max(0, now - diagnostics.lastDidFinishLoadAt)
      : null;

    if (stillLoading && (loadingAgeMs === null || loadingAgeMs < PANE_HOST_BOOTSTRAP_LOADING_GRACE_MS)) {
      log.info(
        'PaneHost',
        `Hidden pane host still loading (${source}); deferring readiness check`
        + ` for ${paneIds.join(', ')}${loadingAgeMs !== null ? ` after ${loadingAgeMs}ms` : ''}`
      );
      this.updatePaneHostStatus();
      this.paneHostBootstrapVerifyTimer = setTimeout(() => {
        this.paneHostBootstrapVerifyTimer = null;
        this.verifyPaneHostWindowsAfterBootstrap('loading_wait');
      }, PANE_HOST_BOOTSTRAP_VERIFY_DELAY_MS);
      this.paneHostBootstrapVerifyTimer?.unref?.();
      return;
    }

    const missingWindows = paneIds.filter((paneId) => !this.paneHostWindowManager.getPaneWindow(paneId));
    const missingReady = paneIds.filter((paneId) => !this.paneHostReady.has(String(paneId)));

    if (
      missingWindows.length === 0
      && missingReady.length > 0
      && postLoadAgeMs !== null
      && postLoadAgeMs < PANE_HOST_READY_GRACE_AFTER_LOAD_MS
    ) {
      log.info(
        'PaneHost',
        `Hidden pane host finished loading but is still awaiting ready signal`
        + ` (${source}) for panes ${missingReady.join(', ')} after ${postLoadAgeMs}ms`
      );
      this.updatePaneHostStatus();
      this.paneHostBootstrapVerifyTimer = setTimeout(() => {
        this.paneHostBootstrapVerifyTimer = null;
        this.verifyPaneHostWindowsAfterBootstrap('ready_wait');
      }, PANE_HOST_BOOTSTRAP_VERIFY_DELAY_MS);
      this.paneHostBootstrapVerifyTimer?.unref?.();
      return;
    }

    if (missingWindows.length === 0 && missingReady.length === 0) {
      this.paneHostMissingPanes.clear();
      this.paneHostLastErrorReason = null;
      this.paneHostLastErrorAt = null;
      log.info('PaneHost', `Verified hidden pane host bootstrap (${source}): windows ready for panes ${paneIds.join(', ')}`);
      this.updatePaneHostStatus();
      return;
    }

    for (const paneId of missingWindows) {
      this.reportPaneHostDegraded({
        paneId,
        reason: 'bootstrap_window_missing',
        message: `Hidden pane host window missing after bootstrap for pane ${paneId}.`,
        details: { source },
      });
    }

    for (const paneId of missingReady) {
      this.reportPaneHostDegraded({
        paneId,
        reason: 'bootstrap_ready_signal_missing',
        message: `Hidden pane host did not report ready after bootstrap for pane ${paneId}.`,
        details: { source },
      });
    }

    if (missingWindows.length > 0 || missingReady.length > 0) {
      this.schedulePaneHostRecovery('bootstrap_verify');
    }
  }

  schedulePaneHostRecovery(reason = 'unknown', delayMs = 750) {
    if (!this.isHiddenPaneHostModeEnabled() || this.shuttingDown) return;
    if (this.paneHostRecoveryTimer) {
      clearTimeout(this.paneHostRecoveryTimer);
      this.paneHostRecoveryTimer = null;
    }
    const waitMs = Math.max(100, Number(delayMs) || 750);
    this.paneHostRecoveryTimer = setTimeout(() => {
      this.paneHostRecoveryTimer = null;
      if (this.shuttingDown) return;
      log.warn('PaneHost', `Scheduling hidden pane host recovery (${reason})`);
      this.schedulePaneHostBootstrap();
    }, waitMs);
    this.paneHostRecoveryTimer?.unref?.();
  }

  handlePaneHostLifecycleEvent(payload = {}) {
    const eventType = String(payload?.type || 'unknown').trim().toLowerCase();
    const paneIds = Array.isArray(payload?.paneIds)
      ? payload.paneIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];

    if (eventType === 'console-message') {
      const levelNames = ['verbose', 'info', 'warning', 'error'];
      const levelName = levelNames[Number(payload?.level)] || 'info';
      const message = String(payload?.message || '').trim();
      if (!message) return;
      const prefix = `PaneHost(${paneIds.join(',') || 'unknown'})`;
      if (levelName === 'error') {
        log.error('PaneHost', `${prefix}: ${message}`);
      } else if (levelName === 'warning') {
        log.warn('PaneHost', `${prefix}: ${message}`);
      } else {
        log.info('PaneHost', `${prefix}: ${message}`);
      }
      return;
    }

    if (eventType === 'did-finish-load' || eventType === 'window-created') {
      log.info('PaneHost', `Hidden pane host ${eventType} for panes: ${paneIds.join(', ')}`);
      return;
    }

    const detailParts = [];
    if (payload?.errorDescription) detailParts.push(`description=${payload.errorDescription}`);
    if (payload?.validatedURL) detailParts.push(`url=${payload.validatedURL}`);
    if (payload?.preloadPath) detailParts.push(`preload=${payload.preloadPath}`);
    if (payload?.error) detailParts.push(`error=${payload.error}`);
    if (payload?.reason) detailParts.push(`reason=${payload.reason}`);
    if (payload?.exitCode !== undefined && payload?.exitCode !== null) detailParts.push(`exitCode=${payload.exitCode}`);
    const detailsText = detailParts.length > 0 ? ` (${detailParts.join(', ')})` : '';
    const message = `Hidden pane host lifecycle event: ${eventType}${detailsText}`;

    for (const paneId of (paneIds.length > 0 ? paneIds : this.getHiddenPaneHostPaneIds())) {
      this.paneHostReady.delete(String(paneId));
      this.reportPaneHostDegraded({
        paneId,
        reason: `lifecycle_${eventType}`,
        message: `${message} for pane ${paneId}.`,
        details: payload,
      });
    }

    if (['closed', 'render-process-gone', 'did-fail-load', 'preload-error', 'unresponsive'].includes(eventType)) {
      this.schedulePaneHostRecovery(`lifecycle_${eventType}`);
    }
  }

  async ensurePaneHostWindows() {
    const paneIds = this.getHiddenPaneHostPaneIds();
    if (!paneIds.length) return;
    try {
      await this.paneHostWindowManager.ensurePaneWindows(paneIds);
      log.info('PaneHost', `Hidden pane host windows created for panes: ${paneIds.join(', ')}`);
      this.updatePaneHostStatus();
    } catch (err) {
      this.reportPaneHostDegraded({
        reason: 'bootstrap_ensure_failed',
        message: `Failed to create hidden pane host windows: ${err.message}`,
        details: { paneIds },
      });
    }
  }

  schedulePaneHostBootstrap() {
    if (this.paneHostBootstrapTimer) {
      clearTimeout(this.paneHostBootstrapTimer);
      this.paneHostBootstrapTimer = null;
    }
    if (this.paneHostBootstrapVerifyTimer) {
      clearTimeout(this.paneHostBootstrapVerifyTimer);
      this.paneHostBootstrapVerifyTimer = null;
    }
    if (this.paneHostRecoveryTimer) {
      clearTimeout(this.paneHostRecoveryTimer);
      this.paneHostRecoveryTimer = null;
    }
    if (this.paneHostRecoveryTimer) {
      clearTimeout(this.paneHostRecoveryTimer);
      this.paneHostRecoveryTimer = null;
    }

    this.paneHostBootstrapTimer = setTimeout(() => {
      this.paneHostBootstrapTimer = null;
      void this.ensurePaneHostWindows().finally(() => {
        this.paneHostBootstrapVerifyTimer = setTimeout(() => {
          this.paneHostBootstrapVerifyTimer = null;
          this.verifyPaneHostWindowsAfterBootstrap('createWindow');
        }, PANE_HOST_BOOTSTRAP_VERIFY_DELAY_MS);
        this.paneHostBootstrapVerifyTimer?.unref?.();
      });
    }, 0);
    this.paneHostBootstrapTimer?.unref?.();
  }

  sendPaneHostMessage(paneId, channel, payload = {}) {
    if (!this.isHiddenPaneHostModeEnabled()) return false;
    return this.paneHostWindowManager.sendToPaneWindow(String(paneId), channel, {
      ...payload,
      paneId: String(paneId),
    });
  }

  sendPaneHostBridgeEvent(paneId, type, payload = {}) {
    if (!this.isHiddenPaneHostModeEnabled()) return false;
    const data = (payload && typeof payload === 'object') ? payload : {};
    return this.sendPaneHostMessage(paneId, 'kernel:bridge-event', {
      source: 'pane-host',
      type: String(type || ''),
      ...data,
    });
  }

  isTrustedPaneHostSender(event, paneId) {
    const id = String(paneId || '').trim();
    if (!id || !event?.sender) return false;
    const paneWindow = this.paneHostWindowManager.getPaneWindow(id);
    if (!paneWindow || paneWindow.isDestroyed() || !paneWindow.webContents) return false;
    return event.sender.id === paneWindow.webContents.id;
  }

  handlePaneHostReadySignal(payload = {}) {
    const paneId = String(payload?.paneId || '').trim();
    if (!paneId) return;
    this.paneHostReady.add(paneId);
    this.clearPaneHostDegraded(paneId);
    this.updatePaneHostStatus();
    const terminal = this.ctx.daemonClient?.getTerminal?.(paneId);
    if (terminal?.scrollback) {
      this.sendPaneHostBridgeEvent(paneId, 'prime-scrollback', {
        scrollback: terminal.scrollback,
      });
    }
    void this.flushPendingPaneDeliveries({ paneId, reason: 'pane_host_ready' }).catch((err) => {
      log.warn('PendingPaneDelivery', `Replay on pane-host-ready failed for pane ${paneId}: ${err.message}`);
    });
  }

  dispatchPaneHostEnter(paneId) {
    const id = String(paneId || '').trim();
    if (!id) {
      return { success: false, reason: 'missing_pane_id' };
    }
    const dc = this.ctx.daemonClient;
    if (!dc || !dc.connected) {
      return { success: false, reason: 'daemon_not_connected', paneId: id };
    }
    try {
      const accepted = dc.write(id, '\r');
      if (!accepted) {
        return { success: false, reason: 'daemon_write_failed', paneId: id };
      }
      return { success: true, paneId: id };
    } catch (err) {
      return {
        success: false,
        reason: 'daemon_write_failed',
        paneId: id,
        error: err?.message || 'daemon_write_failed',
      };
    }
  }

  handleTriggerDeliveryAck(data = {}) {
    if (data?.deliveryId) triggers.handleDeliveryAck(data.deliveryId, data.paneId);
    appendBusTraceEvent({
      eventType: 'pane_delivery_ack',
      messageId: data?.messageId || data?.deliveryId || null,
      deliveryId: data?.deliveryId || null,
      paneId: data?.paneId || null,
      success: true,
      status: 'pane_delivery_ack',
      modelReceiptVerified: false,
    });
  }

  handleTriggerDeliveryOutcome(data = {}) {
    if (data?.deliveryId) triggers.handleDeliveryOutcome(data.deliveryId, data.paneId, data);
    appendBusTraceEvent({
      eventType: 'pane_delivery_outcome',
      messageId: data?.messageId || data?.deliveryId || null,
      deliveryId: data?.deliveryId || null,
      paneId: data?.paneId || null,
      success: data?.accepted !== false,
      accepted: data?.accepted === true,
      verified: data?.verified === true,
      status: data?.status || null,
      reason: data?.reason || null,
      modelReceiptVerified: false,
    });
    const statusLower = String(data?.status || '').toLowerCase();
    const isUnverified = (
      data?.verified === false
      || statusLower.includes('unverified')
      || statusLower === 'delivered.enter_sent'
    );
    if (isUnverified) {
      const paneId = String(data?.paneId || 'unknown');
      const status = data?.status || 'accepted.unverified';
      const reason = data?.reason || 'verification_unavailable';
      const warning = `Delivery remained unverified for pane ${paneId} (${status}${reason ? `: ${reason}` : ''})`;
      log.warn('Delivery', warning);
      this.activity.logActivity('warning', paneId, warning, {
        subsystem: 'delivery-verification',
        deliveryId: data?.deliveryId || null,
        status,
        reason,
      });
    }
  }

  sendToVisibleWindow(channel, payload, options = {}) {
    const requestedWindowKey = toNonEmptyString(options.windowKey)
      || toNonEmptyString(payload?.windowKey)
      || toNonEmptyString(payload?.meta?.windowKey)
      || 'main';
    const windowKey = String(requestedWindowKey).trim() || 'main';
    const window = this.getAppWindow(windowKey);
    if (!this.canSendToWindow(window)) return false;
    const sender = (windowKey === 'main' && typeof this.mainWindowSendRaw === 'function')
      ? this.mainWindowSendRaw
      : window.webContents.send.bind(window.webContents);
    try {
      sender(channel, payload);
      return true;
    } catch (err) {
      log.warn('RendererIPC', `Skipped send for ${channel}: ${err.message}`);
      return false;
    }
  }

  sendToAllWindows(channel, payload, options = {}) {
    const excludedWindowKey = toNonEmptyString(options.excludeWindowKey);
    let delivered = false;
    const seen = new Set();
    for (const [windowKey, windowRef] of this.getAppWindows()) {
      const normalizedWindowKey = String(windowKey || 'main').trim() || 'main';
      if (excludedWindowKey && normalizedWindowKey === excludedWindowKey) {
        continue;
      }
      if (seen.has(windowRef)) continue;
      seen.add(windowRef);
      delivered = this.sendToVisibleWindow(channel, payload, { windowKey: normalizedWindowKey }) || delivered;
    }
    return delivered;
  }

  canSendToWindow(windowRef) {
    if (!windowRef) return false;
    if (typeof windowRef.isDestroyed === 'function' && windowRef.isDestroyed()) {
      return false;
    }
    const webContents = windowRef.webContents;
    if (!webContents) return false;
    if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) {
      return false;
    }
    return typeof webContents.send === 'function';
  }

  clearDaemonConnectTimeout() {
    if (this.daemonConnectTimeoutTimer) {
      clearTimeout(this.daemonConnectTimeoutTimer);
      this.daemonConnectTimeoutTimer = null;
    }
  }

  notifyRendererDaemonTimeout(reason = 'daemon_connect_timeout') {
    if (this.daemonConnectedForStartup) return;
    const delivered = this.sendToAllWindows('daemon-timeout', {
      timeoutMs: DAEMON_CONNECT_TIMEOUT_MS,
      reason,
      message: "SquidRun couldn't start the background daemon.",
    });
    if (delivered) {
      this.daemonTimeoutNotified = true;
    }
  }

  scheduleDaemonConnectTimeout() {
    this.clearDaemonConnectTimeout();
    if (this.daemonConnectedForStartup) return;

    this.daemonConnectTimeoutTimer = setTimeout(() => {
      this.daemonConnectTimeoutTimer = null;
      if (this.daemonConnectedForStartup) return;
      this.daemonTimeoutTriggered = true;
      log.warn('Daemon', `No daemon connection within ${DAEMON_CONNECT_TIMEOUT_MS}ms`);
      this.notifyRendererDaemonTimeout('daemon_connect_timeout');
    }, DAEMON_CONNECT_TIMEOUT_MS);

    if (this.daemonConnectTimeoutTimer && typeof this.daemonConnectTimeoutTimer.unref === 'function') {
      this.daemonConnectTimeoutTimer.unref();
    }
  }

  installMainWindowSendInterceptor() {
    const window = this.ctx.mainWindow;
    if (!this.canSendToWindow(window)) return;
    if (this.mainWindowSendInterceptInstalled) return;

    const originalSend = window.webContents.send.bind(window.webContents);
    this.mainWindowSendRaw = originalSend;
    window.webContents.send = (channel, payload, ...rest) => {
      if (!this.canSendToWindow(window)) {
        return false;
      }
      if (channel === 'inject-message' && !payload?._ipcPacketized) {
        const handled = this.routeInjectMessage(payload || {});
        if (handled) return;
      }
      try {
        return originalSend(channel, payload, ...rest);
      } catch (err) {
        log.warn('RendererIPC', `Skipped send for ${channel}: ${err.message}`);
        return false;
      }
    };
    this.mainWindowSendInterceptInstalled = true;
  }

  primePaneHostFromTerminalSnapshot(terminals = []) {
    if (!this.isHiddenPaneHostModeEnabled()) return;
    const list = Array.isArray(terminals) ? terminals : [];
    for (const term of list) {
      const paneId = String(term?.paneId || '');
      if (!paneId) continue;
      if (!this.getHiddenPaneHostPaneIds().includes(paneId)) continue;
      const scrollback = typeof term?.scrollback === 'string' ? term.scrollback : '';
      if (!scrollback) continue;
      this.sendPaneHostBridgeEvent(paneId, 'prime-scrollback', { scrollback });
    }
  }

  routeInjectMessage(payload = {}) {
    if (!payload || typeof payload !== 'object') return false;
    const panes = Array.isArray(payload.panes)
      ? payload.panes.map((paneId) => String(paneId))
      : [];
    if (panes.length === 0) return false;
    const startupInjection = payload.startupInjection === true
      || payload?.meta?.startupInjection === true;
    const packets = buildInjectMessageIpcPackets(payload, {
      chunkThresholdBytes: DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES,
      chunkSizeBytes: DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES,
    });
    if (packets.length === 0) return false;
    const messageId = toNonEmptyString(payload?.traceContext?.messageId)
      || toNonEmptyString(payload?.traceContext?.traceId)
      || toNonEmptyString(payload?.traceContext?.correlationId)
      || toNonEmptyString(payload?.deliveryId);
    const originalMessage = String(payload?.message || '');
    appendBusTraceEvent({
      eventType: 'pane_ipc_packetized',
      messageId: messageId || null,
      deliveryId: payload?.deliveryId || null,
      paneCount: panes.length,
      packetCount: packets.length,
      payloadBytes: getUtf8ByteLength(originalMessage),
      payloadFingerprint: createPayloadFingerprint(originalMessage),
      startupInjection,
    });

    let routed = false;
    for (const packet of packets) {
      const paneId = Array.isArray(packet.panes) && packet.panes.length > 0
        ? String(packet.panes[0])
        : null;
      if (!paneId) continue;
      const packetBytes = Number(packet.messageBytes || getUtf8ByteLength(packet.message || ''));
      const totalBytes = Number(packet?.ipcChunk?.totalBytes || packet?.meta?.ipcOriginalBytes || packetBytes);
      const expectedPacketBytes = Number.isFinite(Number(packet.messageBytes)) ? Number(packet.messageBytes) : null;
      appendBusTraceEvent({
        eventType: 'pane_ipc_packet_routed',
        messageId: messageId || null,
        deliveryId: packet.deliveryId || null,
        paneId,
        packetBytes,
        expectedPacketBytes,
        totalBytes,
        byteMismatch: expectedPacketBytes !== null && expectedPacketBytes !== packetBytes,
        chunkIndex: packet.ipcChunk ? packet.ipcChunk.index : 0,
        chunkCount: packet.ipcChunk ? packet.ipcChunk.count : 1,
        payloadFingerprint: createPayloadFingerprint(packet.message || ''),
        startupInjection,
      });
      if (!packet.ipcChunk || packet.ipcChunk.index === 0) {
        log.info('InjectIPC', `Pre-IPC route pane ${paneId}: ${totalBytes} bytes -> ${packet.ipcChunk?.count || 1} packet(s) (startup=${startupInjection})`);
      }
      if (!this.isHiddenPaneHostModeEnabled() || startupInjection) {
        const delivered = this.sendToVisibleWindow('inject-message', {
          ...packet,
          startupInjection,
        }, {
          windowKey: packet?.windowKey || packet?.meta?.windowKey || 'main',
        });
        appendBusTraceEvent({
          eventType: 'pane_ipc_handoff',
          messageId: messageId || null,
          deliveryId: packet.deliveryId || null,
          paneId,
          deliveryPath: 'visible_window',
          success: Boolean(delivered),
          packetBytes,
          chunkIndex: packet.ipcChunk ? packet.ipcChunk.index : 0,
          chunkCount: packet.ipcChunk ? packet.ipcChunk.count : 1,
        });
        if (delivered) routed = true;
        continue;
      }

      const hostWindow = this.paneHostWindowManager.getPaneWindow(paneId);
      const hostWebContents = hostWindow && !hostWindow.isDestroyed()
        ? hostWindow.webContents
        : null;
      const hostWindowPresent = Boolean(hostWebContents && !hostWebContents.isDestroyed?.());
      const hostLoading = Boolean(
        hostWindowPresent
        && typeof hostWebContents.isLoadingMainFrame === 'function'
        && hostWebContents.isLoadingMainFrame()
      );
      const hostReady = this.paneHostReady.has(paneId);
      const canRouteToHiddenHost = hostWindowPresent && hostReady && !hostLoading;

      if (canRouteToHiddenHost) {
        const routedToHost = this.sendPaneHostBridgeEvent(paneId, 'inject-message', {
          message: packet.message,
          messageBytes: packet.messageBytes,
          ipcChunk: packet.ipcChunk || null,
          deliveryId: packet.deliveryId || null,
          traceContext: packet.traceContext || null,
          startupInjection,
          meta: packet.meta || null,
        });
        if (routedToHost) {
          appendBusTraceEvent({
            eventType: 'pane_ipc_handoff',
            messageId: messageId || null,
            deliveryId: packet.deliveryId || null,
            paneId,
            deliveryPath: 'hidden_pane_host',
            success: true,
            packetBytes,
            chunkIndex: packet.ipcChunk ? packet.ipcChunk.index : 0,
            chunkCount: packet.ipcChunk ? packet.ipcChunk.count : 1,
          });
          routed = true;
          this.clearPaneHostDegraded(paneId);
          continue;
        }
      }

      const fallbackMeta = (packet.meta && typeof packet.meta === 'object')
        ? { ...packet.meta }
        : {};
      fallbackMeta.deliveryPath = 'visible_fallback';
      fallbackMeta.hiddenHostReady = hostReady;
      fallbackMeta.hiddenHostWindowPresent = hostWindowPresent;
      fallbackMeta.hiddenHostLoading = hostLoading;

      const routedToVisible = this.sendToVisibleWindow('inject-message', {
        ...packet,
        panes: [paneId],
        meta: fallbackMeta,
      }, {
        windowKey: packet?.windowKey || fallbackMeta?.windowKey || 'main',
      });
      appendBusTraceEvent({
        eventType: 'pane_ipc_handoff',
        messageId: messageId || null,
        deliveryId: packet.deliveryId || null,
        paneId,
        deliveryPath: 'visible_fallback',
        success: Boolean(routedToVisible),
        packetBytes,
        chunkIndex: packet.ipcChunk ? packet.ipcChunk.index : 0,
        chunkCount: packet.ipcChunk ? packet.ipcChunk.count : 1,
        hiddenHostReady: hostReady,
        hiddenHostWindowPresent: hostWindowPresent,
        hiddenHostLoading: hostLoading,
      });

      if (routedToVisible) {
        routed = true;
        this.reportPaneHostDegraded({
          paneId,
          reason: canRouteToHiddenHost ? 'inject_hidden_send_failed' : 'inject_hidden_not_ready',
          message: `Hidden pane host unavailable/not ready for pane ${paneId}. Routed inject via visible renderer fallback.`,
          details: {
            deliveryId: packet.deliveryId || null,
            hiddenHostReady: hostReady,
            hiddenHostWindowPresent: hostWindowPresent,
            hiddenHostLoading: hostLoading,
            fallback: 'visible_renderer',
          },
        });
      } else {
        this.reportPaneHostDegraded({
          paneId,
          reason: 'inject_fallback_visible_unavailable',
          message: `Hidden pane host unavailable for pane ${paneId}; visible renderer fallback also unavailable. Delivery FAILED.`,
          details: {
            deliveryId: packet.deliveryId || null,
            hiddenHostReady: hostReady,
            hiddenHostWindowPresent: hostWindowPresent,
            hiddenHostLoading: hostLoading,
          },
        });
      }
    }
    return routed;
  }
  ensurePaneHostReadyForwarder() {
    if (this.paneHostReadyIpcRegistered) return;
    this.paneHostReadyIpcRegistered = true;

    this.paneHostReadyListener = (_event, payload = {}) => {
      this.handlePaneHostReadySignal(payload);
    };
    ipcMain.on('pane-host-ready', this.paneHostReadyListener);
  }

  clearWebSocketStartRetry() {
    if (this.websocketStartRetryTimer) {
      clearTimeout(this.websocketStartRetryTimer);
      this.websocketStartRetryTimer = null;
    }
    this.websocketStartRetryAttempt = 0;
  }

  isRetryableWebSocketStartError(err) {
    const message = String(err?.message || '');
    return (
      message.includes('EADDRINUSE')
      || message.includes('address already in use')
      || message.includes('EACCES')
      || message.includes('comms worker exited')
      || message.includes('comms worker timeout')
    );
  }

  getWebSocketStartRetryDelayMs(attempt) {
    const baseMs = Number.isFinite(WEBSOCKET_START_RETRY_BASE_MS) && WEBSOCKET_START_RETRY_BASE_MS > 0
      ? WEBSOCKET_START_RETRY_BASE_MS
      : 500;
    const maxMs = Number.isFinite(WEBSOCKET_START_RETRY_MAX_MS) && WEBSOCKET_START_RETRY_MAX_MS > 0
      ? WEBSOCKET_START_RETRY_MAX_MS
      : 10000;
    const exponent = Math.max(0, Number(attempt || 1) - 1);
    return Math.min(maxMs, baseMs * Math.pow(2, exponent));
  }

  scheduleWebSocketStartRetry(startOptions, err) {
    if (this.shuttingDown) return;
    if (!startOptions || !this.isRetryableWebSocketStartError(err)) return;
    if (this.websocketStartRetryTimer) return;

    this.websocketStartRetryAttempt += 1;
    const attempt = this.websocketStartRetryAttempt;
    const delayMs = this.getWebSocketStartRetryDelayMs(attempt);
    log.warn('WebSocket', `Retrying server start in ${delayMs}ms (attempt ${attempt + 1})`);
    this.websocketStartRetryTimer = setTimeout(async () => {
      this.websocketStartRetryTimer = null;
      if (this.shuttingDown) return;
      try {
        await websocketServer.start(startOptions);
        this.clearWebSocketStartRetry();
        log.info('WebSocket', 'Server start recovery succeeded');
      } catch (retryErr) {
        log.error('WebSocket', `Failed to start server: ${retryErr.message}`);
        this.scheduleWebSocketStartRetry(startOptions, retryErr);
      }
    }, delayMs);
  }

  async init() {
    log.info('App', 'Initializing SquidRun Application');

    // 1. Load settings
    this.settings.loadSettings();

    // 1.1 Packaged app bootstrap: ensure a writable external workspace exists.
    const packagedWorkspacePath = this.ensurePackagedWorkspaceBootstrap();
    if (packagedWorkspacePath) {
      log.info('ProjectLifecycle', `Using packaged external workspace: ${packagedWorkspacePath}`);
    }

    this.kickoffStartupBriefingGeneration('app-init');

    // 2. Create the requested startup window(s) as early as possible so users see immediate startup feedback.
    await this.launchWindowsForProfile(this.launchWindowProfile);

    // Eunbyeol desktop shortcut is owned manually by Launch-Eunbyeol-SquidRun.ps1
    // in D:\projects\eunbyeol-casework. Auto-creation here previously overwrote
    // it with a raw electron.exe launch that lacked SQUIDRUN_PROJECT_ROOT —
    // see memory feedback S294. Do not re-enable.

    // 3. Generate firmware files on startup when feature flag is enabled.
    if (this.firmwareManager && typeof this.firmwareManager.ensureStartupFirmwareIfEnabled === 'function') {
      try {
        const firmwareResult = this.firmwareManager.ensureStartupFirmwareIfEnabled({ preflight: true });
        if (firmwareResult?.ok === false) {
          log.warn('Firmware', `Startup generation failed: ${firmwareResult.reason || 'unknown'}`);
        }
      } catch (err) {
        log.warn('Firmware', `Startup generation error: ${err.message}`);
      }
    }

    // 4. Auto-detect installed CLIs and patch invalid paneCommands (startup only)
    if (typeof this.settings.autoDetectPaneCommandsOnStartup === 'function') {
      this.settings.autoDetectPaneCommandsOnStartup();
    }

    try {
      await this.refreshSystemCapabilities({ projectRoot: getProjectRoot() });
    } catch (err) {
      log.warn('LocalModels', `Capability detection failed: ${err.message}`);
      this.lastSystemCapabilities = buildSystemCapabilitiesSnapshot({
        projectRoot: getProjectRoot(),
        settings: this.ctx.currentSettings,
      });
      writeSystemCapabilitiesSnapshot(this.lastSystemCapabilities, this.lastSystemCapabilities.path);
      this.applyLocalModelEnvironment(this.lastSystemCapabilities);
    }

    // 5. Defer non-critical worker runtimes until first use.
    // Keep startup focused on rendering + core watchers.
    log.info(
      'App',
      'Deferring startup worker prewarm (evidence-ledger/team-memory/experiment/comms) until first use'
    );

    // 6. Setup external notifications
    this.ctx.setExternalNotifier(createExternalNotifier({
      getSettings: () => this.ctx.currentSettings,
      log,
      appName: 'SquidRun',
    }));

    ipcHandlers.setExternalNotifier(this.ctx.externalNotifier);
    if (watcher && typeof watcher.setExternalNotifier === 'function') {
      watcher.setExternalNotifier((payload) => this.ctx.externalNotifier?.notify(payload));
    }

    // 7. Load activity log
    this.activity.loadActivityLog();

    // 8. Load usage stats
    this.usage.loadUsageStats();

    // 9. Initialize PTY daemon connection (heavy startup work begins after window is shown).
    const daemonConnected = await this.initDaemonClient();
    if (!daemonConnected) {
      log.warn('Daemon', 'Initial daemon connect attempt failed; waiting for reconnect/timeout fallback');
    }
    const supervisorResult = await this.ensureSupervisorDaemonRunning('app-init');
    if (!supervisorResult?.ok) {
      log.warn(
        'Supervisor',
        `Bootstrap failed during init: ${supervisorResult?.error || supervisorResult?.reason || 'unknown'}`
      );
    }
    this.scheduleDaemonConnectTimeout();
    this.backgroundAgentManager.start();
    this.settings.writeAppStatus({
      incrementSession: true,
      sessionFloor: this.getStartupSessionFloor(),
    });
    // Notify renderer to refresh session badge after session number is written.
    this.sendToVisibleWindow('session-updated', {
      session: this.getCurrentAppStatusSessionNumber(),
    });
    await this.initializeStartupSessionScope({
      sessionNumber: this.getCurrentAppStatusSessionNumber(),
    });
    try {
      const startupHealthResult = await this.refreshStartupHealthArtifacts({
        sessionNumber: this.getCurrentAppStatusSessionNumber(),
      });
      if (
        startupHealthResult?.ingestResult?.ok === false
        && startupHealthResult?.ingestResult?.skipped !== true
      ) {
        log.warn(
          'StartupHealth',
          `Health artifact created but team-memory ingest degraded: ${startupHealthResult.ingestResult.reason || 'unknown'}`
        );
      }
    } catch (err) {
      log.warn('StartupHealth', `Startup health generation failed: ${err.message}`);
    }

    // 10. Register sleep/wake listeners for laptop resilience.
    this.setupPowerMonitorListeners();

    // 11. Setup global IPC forwarders
    this.ensureCliIdentityForwarder();
    this.ensureTriggerDeliveryAckForwarder();

    // 12. Start WebSocket server for instant agent messaging
    let webSocketStartOptions = null;
    try {
      webSocketStartOptions = {
        port: websocketServer.DEFAULT_PORT,
        sessionScopeId: this.commsSessionScopeId,
        onMessage: async (data) => {
          log.info('WebSocket', `Message from ${data.role || data.paneId || 'unknown'}: ${JSON.stringify(data.message).substring(0, 100)}`);

          if (!data.message) return;

          const emitKernelCommsEvent = (eventType, payload = {}, paneId = 'system', traceContext = null) => {
            if (typeof eventType !== 'string' || !eventType.startsWith('comms.')) {
              return {
                ok: false,
                status: 'invalid_comms_event',
                eventType,
              };
            }
            const traceId = traceContext?.traceId || traceContext?.correlationId || null;
            const parentEventId = traceContext?.parentEventId || traceContext?.causationId || null;
            this.kernelBridge.emitBridgeEvent(eventType, {
              ...payload,
              role: data.role || null,
              clientId: data.clientId,
              traceId,
              parentEventId,
              correlationId: traceId,
              causationId: parentEventId,
            }, paneId);
            return {
              ok: true,
              status: 'comms_event_emitted',
              eventType,
            };
          };

          const withAgentPrefix = (content) => {
            if (typeof content !== 'string') return content;
            if (content.startsWith(AGENT_MESSAGE_PREFIX)) return content;
            return `${AGENT_MESSAGE_PREFIX}${content}`;
          };

          const withProjectContext = (content, metadata = null) => {
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
          };

          if (data.message.type === 'evidence-ledger') {
            return executeEvidenceLedgerOperation(
              data.message.action,
              data.message.payload || {},
              {
                source: {
                  via: 'websocket',
                  role: data.role || 'system',
                  paneId: data.paneId || null,
                },
              }
            );
          }

          if (data.message.type === 'team-memory') {
            return teamMemory.executeTeamMemoryOperation(
              data.message.action,
              data.message.payload || {},
              {
                source: {
                  via: 'websocket',
                  role: data.role || 'system',
                  paneId: data.paneId || null,
                },
              }
            );
          }

          if (data.message.type === 'cognitive-memory') {
            return executeCognitiveMemoryOperation(
              data.message.action,
              data.message.payload || {},
              {
                source: {
                  via: 'websocket',
                  role: data.role || 'system',
                  paneId: data.paneId || null,
                },
              }
            );
          }

          if (data.message.type === 'contract-promotion') {
            return executeContractPromotionAction(
              data.message.action,
              data.message.payload || {},
              {
                source: {
                  via: 'websocket',
                  role: data.role || null,
                  paneId: data.paneId || null,
                  clientId: data.clientId || null,
                },
              }
            );
          }

          if (data.message.type === 'transition-ledger') {
            return executeTransitionLedgerOperation(
              data.message.action,
              data.message.payload || {}
            );
          }

          if (data.message.type === 'github') {
            return executeGitHubOperation(
              data.message.action,
              data.message.payload || {},
              { ctx: this.ctx }
            );
          }

          if (data.message.type === 'pane-control') {
            return executePaneControlAction(
              {
                daemonClient: this.ctx.daemonClient,
                mainWindow: this.ctx.mainWindow,
                currentSettings: this.ctx.currentSettings,
                recoveryManager: this.ctx.recoveryManager,
                agentRunning: this.ctx.agentRunning,
              },
              data.message.action,
              data.message.payload || {}
            );
          }

          if (data.message.type === 'app-control') {
            return executeAppControlAction(
              {
                mainWindow: this.ctx.mainWindow,
                getAppWindows: () => this.getAppWindows(),
                getPaneHostWindows: () => this.paneHostWindowManager?.getPaneHostWindows?.() || [],
              },
              data.message.action,
              data.message.payload || {}
            );
          }

          if (data.message.type === 'comms-event' || data.message.type === 'comms-metric') {
            return emitKernelCommsEvent(
              data.message.eventType,
              data.message.payload || {},
              data.message?.payload?.paneId || 'system'
            );
          }

          // Handle screenshot requests from agents
          if (data.message.type === 'screenshot') {
            try {
              const payload = data.message.payload || {};
              const paneId = payload.paneId || data.message.paneId || null;
              const result = await captureScreenshot({
                mainWindow: this.ctx.mainWindow,
                SCREENSHOTS_DIR: path.join(WORKSPACE_PATH, 'screenshots'),
              }, { paneId });

              // Legacy mode: if no requestId is present, push event result to requester role/client.
              if (!data.message.requestId) {
                websocketServer.sendToTarget(data.role || String(data.clientId), JSON.stringify({
                  type: 'screenshot-result',
                  success: Boolean(result?.success),
                  ...result,
                }));
              }
              return result;
            } catch (err) {
              log.error('WebSocket', `Screenshot failed: ${err.message}`);
              return { success: false, error: err.message };
            }
          }

          // Handle image generation requests from agents
          if (data.message.type === 'image-gen') {
            const { prompt, style, size } = data.message;
            log.info('WebSocket', `Image gen request from ${data.role || 'unknown'}: "${(prompt || '').substring(0, 60)}"`);
            try {
              const { generateImage } = require('../image-gen');
              const result = await generateImage({ prompt, style, size });
              // Push result to renderer UI
              if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
                this.ctx.mainWindow.webContents.send('oracle:image-generated', {
                  imagePath: result.imagePath,
                  provider: result.provider,
                  prompt: prompt,
                  time: new Date().toLocaleTimeString(),
                });
              }
              // Send result back to the requesting WebSocket client
              websocketServer.sendToTarget(data.role || String(data.clientId), JSON.stringify({
                type: 'image-gen-result',
                success: true,
                imagePath: result.imagePath,
                provider: result.provider,
              }));
            } catch (err) {
              log.error('WebSocket', `Image gen failed: ${err.message}`);
              websocketServer.sendToTarget(data.role || String(data.clientId), JSON.stringify({
                type: 'image-gen-result',
                success: false,
                error: err.message,
              }));
            }
            return;
          }

          if (data.message.type === 'background-agent') {
            const action = String(data.message.action || '').trim().toLowerCase();
            const payload = (data.message.payload && typeof data.message.payload === 'object' && !Array.isArray(data.message.payload))
              ? data.message.payload
              : {};
            const senderRole = String(data.role || '').trim().toLowerCase();
            const senderPaneId = String(data.paneId || '').trim();
            const isBuilderSender = (
              senderRole === 'builder'
              || senderPaneId === BACKGROUND_BUILDER_OWNER_PANE_ID
            );

            if (!isBuilderSender) {
              return {
                ok: false,
                accepted: false,
                status: 'owner_binding_violation',
                action: action || null,
                senderRole: data.role || null,
                senderPaneId: data.paneId || null,
              };
            }

            if (action === 'spawn') {
              const requestedSlot = Number.parseInt(String(payload.slot || ''), 10);
              const requestedAlias = typeof payload.alias === 'string'
                ? payload.alias
                : (Number.isFinite(requestedSlot) && requestedSlot > 0 ? `builder-bg-${requestedSlot}` : null);
              return this.backgroundAgentManager.spawnAgent({
                ownerPaneId: BACKGROUND_BUILDER_OWNER_PANE_ID,
                alias: requestedAlias,
              });
            }

            if (action === 'kill') {
              const target = payload.target || payload.alias || payload.paneId || null;
              if (!target) {
                return {
                  ok: false,
                  accepted: false,
                  status: 'invalid_target',
                  action,
                };
              }
              return this.backgroundAgentManager.killAgent(target, { reason: 'builder_cli' });
            }

            if (action === 'kill-all' || action === 'killall') {
              return this.backgroundAgentManager.killAll({ reason: 'builder_cli_kill_all' });
            }

            if (action === 'list' || action === 'status') {
              return {
                ok: true,
                accepted: true,
                status: 'ok',
                agents: this.backgroundAgentManager.listAgents(),
                targetMap: this.backgroundAgentManager.getTargetMap(),
              };
            }

            if (action === 'target-map' || action === 'map') {
              return {
                ok: true,
                accepted: true,
                status: 'ok',
                targetMap: this.backgroundAgentManager.getTargetMap(),
              };
            }

            return {
              ok: false,
              accepted: false,
              status: 'invalid_action',
              action: action || null,
            };
          }

          // Route WebSocket messages via triggers module (handles delivery)
          if (data.message.type === 'bridge-discovery') {
            const timeoutMs = Number.parseInt(String(data.message.timeoutMs || ''), 10);
            return this.discoverBridgeDevices({
              timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
            });
          }

          if (data.message.type === 'send') {
            const { target, content } = data.message;
            const bridgeTarget = parseCrossDeviceTarget(target);
            const routeKind = bridgeTarget ? 'bridge' : 'local';
            const attempt = Number(data.message.attempt || 1);
            const maxAttempts = Number(data.message.maxAttempts || 1);
            const messageId = data.message.messageId || null;
            const rawTraceContext = data.traceContext || data.message.traceContext || null;
            const traceContext = {
              ...(rawTraceContext && typeof rawTraceContext === 'object' ? rawTraceContext : {}),
              ...(messageId ? {
                messageId,
                traceId: rawTraceContext?.traceId || rawTraceContext?.correlationId || messageId,
                correlationId: rawTraceContext?.correlationId || rawTraceContext?.traceId || messageId,
              } : {}),
            };
            const nowMs = Date.now();
            const sentAtMs = Number(data.message.sentAtMs || data.message.timestamp || nowMs);
            const targetPaneIdForJournal = this.resolveTargetToPane(target);
            const targetRoleForJournal = (() => {
              if (bridgeTarget) return 'architect';
              if (targetPaneIdForJournal === '1') return 'architect';
              if (targetPaneIdForJournal === '2') return 'builder';
              if (targetPaneIdForJournal === '3') return 'oracle';
              const backgroundAlias = resolveBackgroundBuilderAlias(targetPaneIdForJournal || target);
              if (backgroundAlias) return backgroundAlias;
              if (this.isTelegramReplyTarget(target)) return this.normalizeOutboundTarget(target);
              return null;
            })();
            const canonicalEnvelope = buildOutboundMessageEnvelope({
              ...(data.message?.metadata?.envelope || {}),
              message_id: messageId,
              session_id: data.message?.metadata?.session_id || this.commsSessionScopeId || null,
              sender: data.message?.metadata?.sender || { role: data.role || 'unknown' },
              target: data.message?.metadata?.target || {
                raw: target || null,
                role: targetRoleForJournal,
                pane_id: targetPaneIdForJournal || null,
              },
              content: typeof content === 'string' ? content : String(content ?? ''),
              priority: data.message?.priority || null,
              timestamp_ms: sentAtMs,
              project: data.message?.metadata?.project || null,
            });
            const senderRoleForJournal = String(canonicalEnvelope.sender?.role || data.role || 'unknown').trim().toLowerCase();
            const canonicalMetadata = buildCanonicalEnvelopeMetadata(canonicalEnvelope);
            const contentWithProjectContext = withProjectContext(canonicalEnvelope.content, canonicalMetadata);
            appendBusTraceEvent({
              eventType: 'ws_broker_received',
              messageId: canonicalEnvelope.message_id,
              senderRole: canonicalEnvelope.sender?.role || data.role || 'unknown',
              recipient: canonicalEnvelope.target?.raw || target || null,
              targetPaneId: targetPaneIdForJournal || null,
              payloadBytes: getUtf8ByteLength(canonicalEnvelope.content),
              injectedPayloadBytes: getUtf8ByteLength(contentWithProjectContext),
              payloadFingerprint: createPayloadFingerprint(canonicalEnvelope.content),
              injectedPayloadFingerprint: createPayloadFingerprint(contentWithProjectContext),
              attempt,
              maxAttempts,
              traceId: traceContext?.traceId || traceContext?.correlationId || null,
            });
            const bridgeStructured = bridgeTarget
              ? (
                normalizeBridgeMetadata(
                  { structured: data.message?.metadata?.structured || null },
                  canonicalEnvelope.content,
                  { ensureStructured: true }
                )?.structured || null
              )
              : null;
            const maybeTriggerAutonomousSmoke = (deliveryResult) => {
              this.maybeTriggerAutonomousSmokeFromSend({
                senderRole: canonicalEnvelope.sender?.role || data.role || null,
                messageContent: canonicalEnvelope.content,
                projectMetadata: canonicalMetadata?.project || canonicalEnvelope.project || null,
                deliveryResult,
              });
            };
            const maybeRecordRecallUsage = async (deliveryResult) => {
              if (!deliveryResult) return;
              const accepted = deliveryResult.accepted === true || deliveryResult.queued === true || deliveryResult.verified === true || deliveryResult.ok === true;
              if (!accepted) return;
              try {
                await recordRecallUsageFromMessage(canonicalEnvelope.content, {
                  paneId: asString(data.paneId || ROLE_ID_MAP?.[senderRoleForJournal] || '', '') || null,
                  role: senderRoleForJournal,
                  target: canonicalEnvelope.target?.raw || target || null,
                  routeKind,
                  nowMs,
                });
              } catch (err) {
                log.warn('RecallFeedback', `Outbound recall usage tracking failed: ${err.message}`);
              }
            };

            if (canonicalEnvelope.message_id) {
              const journalResult = await executeEvidenceLedgerOperation(
                'upsert-comms-journal',
                {
                  messageId: canonicalEnvelope.message_id,
                  sessionId: canonicalEnvelope.session_id || this.commsSessionScopeId || null,
                  senderRole: canonicalEnvelope.sender?.role || data.role || 'unknown',
                  targetRole: canonicalEnvelope.target?.role || targetRoleForJournal,
                  channel: 'ws',
                  direction: 'outbound',
                  sentAtMs: canonicalEnvelope.timestamp_ms,
                  brokeredAtMs: nowMs,
                  rawBody: canonicalEnvelope.content,
                  status: 'brokered',
                  attempt,
                  metadata: {
                    source: 'websocket-broker',
                    ...canonicalMetadata,
                    routeKind,
                    targetRaw: canonicalEnvelope.target?.raw || target || null,
                    traceId: traceContext?.traceId || traceContext?.correlationId || null,
                    maxAttempts,
                    structured: bridgeStructured,
                    structuredType: bridgeStructured?.type || null,
                  },
                },
                {
                  source: {
                    via: 'websocket',
                    role: data.role || 'system',
                    paneId: data.paneId || null,
                  },
                }
              );
              if (journalResult?.ok === false) {
                log.warn('EvidenceLedger', `Comms journal broker upsert failed: ${journalResult.reason || 'unknown'}`);
              }
            }

            if (attempt === 1) {
              emitKernelCommsEvent('comms.send.started', {
                messageId: canonicalEnvelope.message_id,
                target: canonicalEnvelope.target?.raw || target || null,
                attempt,
                maxAttempts,
              }, 'system', traceContext);
            } else if (attempt > 1) {
              emitKernelCommsEvent('comms.retry.attempted', {
                messageId: canonicalEnvelope.message_id,
                target: canonicalEnvelope.target?.raw || target || null,
                attempt,
                maxAttempts,
              }, 'system', traceContext);
            }

            const senderBackgroundAlias = resolveBackgroundBuilderAlias(data.role || '');
            if (senderBackgroundAlias) {
              const resolvedTargetPane = this.resolveTargetToPane(target);
              const isBuilderTarget = (
                String(resolvedTargetPane || '') === BACKGROUND_BUILDER_OWNER_PANE_ID
                || String(target || '').trim().toLowerCase() === 'builder'
                || String(target || '').trim() === BACKGROUND_BUILDER_OWNER_PANE_ID
              );
              if (!isBuilderTarget) {
                const blocked = {
                  ok: false,
                  accepted: false,
                  queued: false,
                  verified: false,
                  status: 'owner_binding_violation',
                  target,
                  sender: senderBackgroundAlias,
                  traceId: traceContext?.traceId || traceContext?.correlationId || null,
                };
                await this.recordDeliveryOutcomePattern({
                  channel: 'send',
                  target: target || null,
                  fromRole: data.role || 'unknown',
                  result: blocked,
                  traceContext,
                });
                return blocked;
              }
            }

            if (bridgeTarget) {
              const senderRole = String(canonicalEnvelope.sender?.role || data.role || '').trim().toLowerCase();
              if (senderRole !== 'architect') {
                const blocked = {
                  ok: false,
                  accepted: false,
                  queued: false,
                  verified: false,
                  status: 'bridge_architect_only',
                  target: bridgeTarget.raw,
                  toDevice: bridgeTarget.toDevice,
                };
                await this.recordDeliveryOutcomePattern({
                  channel: 'send',
                  target: bridgeTarget.raw,
                  fromRole: data.role || 'unknown',
                  result: blocked,
                  traceContext,
                });
                return blocked;
              }

              const bridgeResult = await this.routeBridgeMessage({
                targetDevice: bridgeTarget.toDevice,
                content: canonicalEnvelope.content,
                fromRole: senderRole,
                messageId: canonicalEnvelope.message_id,
                traceContext,
                structuredMessage: bridgeStructured,
              });
              await this.recordDeliveryOutcomePattern({
                channel: 'send',
                target: bridgeTarget.raw,
                fromRole: data.role || 'unknown',
                result: bridgeResult,
                traceContext,
              });
              const payload = {
                ok: Boolean(bridgeResult?.ok),
                accepted: Boolean(bridgeResult?.accepted),
                queued: Boolean(bridgeResult?.queued),
                verified: Boolean(bridgeResult?.verified),
                status: bridgeResult?.status || 'bridge_unhandled',
                mode: 'bridge',
                routeKind: 'bridge',
                toDevice: bridgeTarget.toDevice,
                error: bridgeResult?.error || null,
                traceId: traceContext?.traceId || traceContext?.correlationId || null,
              };
              await maybeRecordRecallUsage(payload);
              maybeTriggerAutonomousSmoke(payload);
              return payload;
            }

            const telegramReplyTarget = this.isTelegramReplyTarget(target);
            if (telegramReplyTarget) {
              const normalizedTarget = this.normalizeOutboundTarget(target);
              const preflight = await this.evaluateTeamMemoryGuardPreflight({
                target: normalizedTarget,
                content: canonicalEnvelope.content,
                fromRole: data.role || 'unknown',
                traceContext,
              });
              if (preflight.blocked) {
                await this.recordDeliveryOutcomePattern({
                  channel: 'send',
                  target: normalizedTarget,
                  fromRole: data.role || 'unknown',
                  result: {
                    accepted: false,
                    queued: false,
                    verified: false,
                    status: 'guard_blocked',
                  },
                  traceContext,
                });
                return {
                  ok: false,
                  accepted: false,
                  queued: false,
                  verified: false,
                  status: 'guard_blocked',
                  target: normalizedTarget,
                  guardActions: preflight.actions,
                  traceId: traceContext?.traceId || traceContext?.correlationId || null,
                };
              }

              const telegramResult = await this.routeTelegramReply({
                target: normalizedTarget,
                content: canonicalEnvelope.content,
                fromRole: data.role || 'unknown',
                messageId: canonicalEnvelope.message_id,
                chatId: data.message?.metadata?.telegram?.chatId || data.message?.metadata?.chatId || null,
              });
              const deliveryResult = {
                accepted: Boolean(telegramResult?.accepted),
                queued: Boolean(telegramResult?.queued),
                verified: Boolean(telegramResult?.verified),
                status: telegramResult?.status || 'telegram_unhandled',
                error: telegramResult?.error || null,
              };
              await this.recordDeliveryOutcomePattern({
                channel: 'send',
                target: normalizedTarget,
                fromRole: data.role || 'unknown',
                result: deliveryResult,
                traceContext,
              });
              emitKernelCommsEvent(
                telegramResult?.ok ? 'comms.delivery.acked' : 'comms.delivery.failed',
                {
                  messageId: canonicalEnvelope.message_id,
                  target: normalizedTarget,
                  channel: 'telegram',
                  attempt,
                  maxAttempts,
                  status: telegramResult?.status || 'telegram_unhandled',
                  ackStatus: telegramResult?.ok ? (telegramResult?.status || 'telegram_delivered') : null,
                  errorCode: telegramResult?.ok ? null : (telegramResult?.error || telegramResult?.status || 'telegram_send_failed'),
                  error: telegramResult?.ok ? null : (telegramResult?.error || null),
                  chatId: telegramResult?.chatId || null,
                  telegramMessageId: telegramResult?.messageId || null,
                  summary: telegramResult?.ok
                    ? `Telegram delivery acknowledged${telegramResult?.chatId ? ` (chat ${telegramResult.chatId})` : ''}`
                    : `Telegram delivery failed: ${telegramResult?.error || telegramResult?.status || 'telegram_send_failed'}`,
                },
                'system',
                traceContext
              );
              const payload = {
                ok: Boolean(telegramResult?.ok),
                accepted: Boolean(telegramResult?.accepted),
                queued: Boolean(telegramResult?.queued),
                verified: Boolean(telegramResult?.verified),
                status: telegramResult?.status || 'telegram_unhandled',
                target: normalizedTarget,
                mode: 'telegram',
                messageId: telegramResult?.messageId || null,
                chatId: telegramResult?.chatId || null,
                error: telegramResult?.error || null,
                guardActions: preflight.actions,
                traceId: traceContext?.traceId || traceContext?.correlationId || null,
              };
              await maybeRecordRecallUsage(payload);
              maybeTriggerAutonomousSmoke(payload);
              return payload;
            }

            const paneId = this.resolveTargetToPane(target);
            if (paneId) {
              const preflight = await this.evaluateTeamMemoryGuardPreflight({
                target: target || String(paneId),
                content: contentWithProjectContext,
                fromRole: data.role || 'unknown',
                traceContext,
              });
              if (preflight.blocked) {
                await this.recordDeliveryOutcomePattern({
                  channel: 'send',
                  target: target || String(paneId),
                  fromRole: data.role || 'unknown',
                  result: {
                    accepted: false,
                    queued: false,
                    verified: false,
                    status: 'guard_blocked',
                  },
                  traceContext,
                });
                return {
                  ok: false,
                  accepted: false,
                  queued: false,
                  verified: false,
                  status: 'guard_blocked',
                  paneId: String(paneId),
                  guardActions: preflight.actions,
                  traceId: traceContext?.traceId || traceContext?.correlationId || null,
                };
              }

              if (this.backgroundAgentManager.isBackgroundPaneId(paneId)) {
                log.info('WebSocket', `Routing 'send' to background pane ${paneId} (direct daemon write)`);
                const result = await this.backgroundAgentManager.sendMessageToAgent(
                  paneId,
                  withAgentPrefix(contentWithProjectContext),
                  {
                    fromRole: data.role || 'unknown',
                    traceContext,
                  }
                );
                await this.recordDeliveryOutcomePattern({
                  channel: 'send',
                  target: String(paneId),
                  fromRole: data.role || 'unknown',
                  result,
                  traceContext,
                });
                const payload = {
                  ok: Boolean(result?.ok),
                  accepted: Boolean(result?.accepted),
                  queued: Boolean(result?.queued),
                  verified: Boolean(result?.verified),
                  status: result?.status || 'delivery_failed',
                  paneId: String(paneId),
                  mode: result?.mode || 'daemon-pty',
                  notified: Array.isArray(result?.notified) ? result.notified : [],
                  deliveryId: result?.deliveryId || null,
                  details: result?.details || null,
                  guardActions: preflight.actions,
                  traceId: traceContext?.traceId || traceContext?.correlationId || null,
                };
                await maybeRecordRecallUsage(payload);
                maybeTriggerAutonomousSmoke(payload);
                return payload;
              }

              log.info('WebSocket', `Routing 'send' to pane ${paneId} (via triggers)`);
              const result = await this.deliverPaneMessageReliably({
                paneId: String(paneId),
                message: withAgentPrefix(contentWithProjectContext),
                fromRole: data.role || 'unknown',
                traceContext,
                queueOnAcceptedUnverified: false,
                queueOnHardFailure: true,
                messageId: canonicalEnvelope.message_id || null,
                channel: 'ws',
                sender: senderRoleForJournal,
                logLabel: 'WebSocket',
              });
              await this.recordDeliveryOutcomePattern({
                channel: 'send',
                target: String(paneId),
                fromRole: data.role || 'unknown',
                result,
                traceContext,
              });
              await this.finalizeLocalTriggerDeliveryJournal({
                messageId: canonicalEnvelope.message_id,
                result,
                paneId: String(paneId),
                target: canonicalEnvelope.target?.role || targetRoleForJournal || String(paneId),
                senderRole: senderRoleForJournal,
                traceContext,
                routeKind: 'local',
              });
              this.scheduleAgentResponseWatchdog({
                senderRole: senderRoleForJournal,
                targetRole: canonicalEnvelope.target?.role || targetRoleForJournal || String(paneId),
                content: canonicalEnvelope.content,
                sentAtMs: canonicalEnvelope.timestamp_ms || nowMs,
              });
              this.maybeResolveAgentResponseWatchdog({
                senderRole: senderRoleForJournal,
                targetRole: canonicalEnvelope.target?.role || targetRoleForJournal || String(paneId),
                deliveryAccepted: result?.accepted !== false || result?.verified === true,
              });
              const payload = {
                ok: Boolean(result?.verified),
                accepted: Boolean(result?.accepted),
                queued: Boolean(result?.queued),
                verified: Boolean(result?.verified),
                status: result?.status || (result?.verified ? 'delivered.verified' : 'routed_unverified'),
                paneId: String(paneId),
                mode: result?.mode || null,
                notified: Array.isArray(result?.notified) ? result.notified : [],
                deliveryId: result?.deliveryId || null,
                details: result?.details || null,
                guardActions: preflight.actions,
                traceId: traceContext?.traceId || traceContext?.correlationId || null,
              };
              await maybeRecordRecallUsage(payload);
              maybeTriggerAutonomousSmoke(payload);
              return payload;
            } else {
              log.warn('WebSocket', `Unknown target for 'send': ${target}`);
              await this.recordDeliveryOutcomePattern({
                channel: 'send',
                target,
                fromRole: data.role || 'unknown',
                result: {
                  accepted: false,
                  queued: false,
                  verified: false,
                  status: 'invalid_target',
                },
                traceContext,
              });
              return {
                ok: false,
                accepted: false,
                queued: false,
                verified: false,
                status: 'invalid_target',
                target,
                traceId: traceContext?.traceId || traceContext?.correlationId || null,
              };
            }
          } else if (data.message.type === 'broadcast') {
            log.info('WebSocket', `Routing 'broadcast' (via triggers)`);
            const traceContext = data.traceContext || data.message.traceContext || null;
            const preflight = await this.evaluateTeamMemoryGuardPreflight({
              target: 'all',
              content: data.message.content,
              fromRole: data.role || 'unknown',
              traceContext,
            });
            if (preflight.blocked) {
              await this.recordDeliveryOutcomePattern({
                channel: 'broadcast',
                target: 'all',
                fromRole: data.role || 'unknown',
                result: {
                  accepted: false,
                  queued: false,
                  verified: false,
                  status: 'guard_blocked',
                },
                traceContext,
              });
              return {
                ok: false,
                accepted: false,
                queued: false,
                verified: false,
                status: 'guard_blocked',
                mode: 'pty',
                guardActions: preflight.actions,
                traceId: traceContext?.traceId || traceContext?.correlationId || null,
              };
            }
            const result = await triggers.broadcastToAllAgents(
              withAgentPrefix(data.message.content),
              data.role || 'unknown',
              { traceContext, awaitDelivery: true }
            );
            await this.recordDeliveryOutcomePattern({
              channel: 'broadcast',
              target: 'all',
              fromRole: data.role || 'unknown',
              result,
              traceContext,
            });
            await this.finalizeLocalTriggerDeliveryJournal({
              messageId: data.message.messageId || null,
              result,
              target: 'all',
              senderRole: data.role || 'unknown',
              traceContext,
              routeKind: 'local',
            });
            return {
              ok: Boolean(result?.verified),
              accepted: Boolean(result?.accepted),
              queued: Boolean(result?.queued),
              verified: Boolean(result?.verified),
              status: result?.status || (result?.verified ? 'delivered.verified' : 'broadcast_unverified'),
              mode: result?.mode || null,
              notified: Array.isArray(result?.notified) ? result.notified : [],
              deliveryId: result?.deliveryId || null,
              details: result?.details || null,
              guardActions: preflight.actions,
              traceId: traceContext?.traceId || traceContext?.correlationId || null,
            };
          }

          return null;
        }
      };
      await websocketServer.start(webSocketStartOptions);
      this.clearWebSocketStartRetry();
    } catch (err) {
      log.error('WebSocket', `Failed to start server: ${err.message}`);
      this.scheduleWebSocketStartRetry(webSocketStartOptions, err);
    }

    this.startSmsPoller();
    // Both windows poll Telegram. Profile-scoped chat filter (de033db) ensures
    // each window keeps only its own chats — eunbyeol window keeps eunbyeol-listed
    // chats, main window rejects them. The two pollers will race on getUpdates
    // and one will 409, but Telegram's offset semantics mean batches arrive at
    // whichever window wins each round; both windows still see all messages over
    // time and filter to keep what's theirs. The previous "eunbyeol-only poller"
    // experiment (5c83159) made James's chat inbound silently 100% lossy and is
    // reverted. Proper fix: forward non-window-owned chats to a shared inbox or
    // give 은별 her own bot (separate token, no shared poller).
    this.startTelegramPoller();
    this.startBridgeClient();
    this.startAutoHandoffMaterializer();

    log.info('App', 'Initialization complete');
  }

  kickoffStartupBriefingGeneration(reason = 'app-init') {
    if (this.startupBriefingPromise) {
      return this.startupBriefingPromise;
    }

    this.startupBriefingPromise = generateStartupBriefing({
      projectRoot: getProjectRoot(),
      source: reason,
    }).then((result) => {
      if (!result?.ok) {
        log.warn('StartupBriefing', `Generation failed: ${result?.error || 'unknown'}`);
      }
      return result;
    }).catch((err) => {
      log.warn('StartupBriefing', `Generation crashed: ${err.message}`);
      return { ok: false, error: err.message };
    });

    return this.startupBriefingPromise;
  }

  async runAutoHandoffMaterializer(reason = 'timer') {
    if (!this.autoHandoffEnabled) {
      return { ok: false, reason: 'disabled' };
    }
    if (this.autoHandoffWriteInFlight) {
      return this.autoHandoffWritePromise || { ok: false, reason: 'in_flight' };
    }

    this.autoHandoffWriteInFlight = true;
    this.autoHandoffWritePromise = (async () => {
      try {
        const result = await materializeSessionHandoff({
          sessionId: this.commsSessionScopeId || null,
          enableSessionHistory: true,
          querySessionSnapshot: ({ sessionId }) => executeEvidenceLedgerOperation(
            'get-context',
            {
              sessionId,
              preferSnapshot: true,
            },
            {
              source: {
                via: 'auto-handoff',
                role: 'system',
                paneId: null,
              },
            }
          ),
        });
        if (result?.ok === false) {
          log.warn('AutoHandoff', `Materialize failed (${reason}): ${result.reason || result.error || 'unknown'}`);
        } else if (result?.written) {
          log.info(
            'AutoHandoff',
            `Materialized session handoff (${reason}): ${result.outputPath} rows=${result.rowsScanned || 0}`
          );
        }
        return result;
      } catch (err) {
        log.warn('AutoHandoff', `Materialize error (${reason}): ${err.message}`);
        return { ok: false, reason: 'materialize_error', error: err.message };
      } finally {
        this.autoHandoffWriteInFlight = false;
        this.autoHandoffWritePromise = null;
      }
    })();

    return this.autoHandoffWritePromise;
  }

  startAutoHandoffMaterializer() {
    if (!this.autoHandoffEnabled) {
      return;
    }
    void this.stopAutoHandoffMaterializer({ flush: false });

    const cleanup = removeLegacyPaneHandoffFiles({ ignoreErrors: true });
    if (cleanup?.removed?.length > 0) {
      log.info('AutoHandoff', `Removed legacy pane handoff files (${cleanup.removed.length})`);
    }
    if (cleanup?.failed?.length > 0) {
      for (const failure of cleanup.failed) {
        log.warn('AutoHandoff', `Failed removing legacy handoff file ${failure.path}: ${failure.error}`);
      }
    }

    void this.runAutoHandoffMaterializer('startup');
    const intervalMs = Math.max(5000, Number.isFinite(AUTO_HANDOFF_INTERVAL_MS) ? AUTO_HANDOFF_INTERVAL_MS : 30000);
    this.autoHandoffTimer = setInterval(() => {
      void this.runAutoHandoffMaterializer('timer');
    }, intervalMs);
  }

  async stopAutoHandoffMaterializer(options = {}) {
    if (this.autoHandoffTimer) {
      clearInterval(this.autoHandoffTimer);
      this.autoHandoffTimer = null;
    }

    if (options.flush === true && this.autoHandoffEnabled) {
      if (this.autoHandoffWritePromise) {
        await this.autoHandoffWritePromise;
      }
      return this.runAutoHandoffMaterializer('shutdown');
    }

    return { ok: true, reason: 'stopped' };
  }

  /**
   * Deferred Team Memory tasks — runs AFTER window is visible.
   * Backfill, integrity check, and periodic sweeps are not time-critical
   * and should not block startup.
   */
  async _deferredTeamMemoryStartup() {
    const backfillResult = await teamMemory.runBackfill({
      payload: {
        limit: Number.isFinite(TEAM_MEMORY_BACKFILL_LIMIT) ? TEAM_MEMORY_BACKFILL_LIMIT : 5000,
      },
    });
    if (backfillResult?.ok) {
      log.info(
        'TeamMemory',
        `Backfill scan complete (events=${backfillResult.scannedEvents || 0}, inserted=${backfillResult.insertedClaims || 0}, duplicates=${backfillResult.duplicateClaims || 0})`
      );
    } else {
      log.warn('TeamMemory', `Backfill unavailable: ${backfillResult?.reason || 'unknown'}`);
    }

    const integrityResult = await teamMemory.runIntegrityCheck({});
    if (integrityResult?.ok === false) {
      log.warn('TeamMemory', `Initial integrity scan unavailable: ${integrityResult.reason || 'unknown'}`);
    }

    teamMemory.startIntegritySweep({
      intervalMs: TEAM_MEMORY_INTEGRITY_SWEEP_INTERVAL_MS,
      immediate: true,
    });
    if (TEAM_MEMORY_BELIEF_SWEEP_ENABLED) {
      teamMemory.startBeliefSnapshotSweep({
        intervalMs: TEAM_MEMORY_BELIEF_SNAPSHOT_INTERVAL_MS,
        immediate: true,
      });
    } else {
      log.info('TeamMemory', 'Belief snapshot sweep disabled by default; set SQUIDRUN_TEAM_MEMORY_BELIEF_SWEEP=1 to re-enable.');
    }
    teamMemory.startPatternMiningSweep({
      intervalMs: TEAM_MEMORY_PATTERN_MINING_INTERVAL_MS,
      immediate: true,
      onGuardAction: (entry) => {
        if (!entry || typeof entry !== 'object') return;
        const paneId = String(this.resolveTargetToPane(entry?.event?.target || '') || '1');
        const message = String(entry.message || 'Team memory guard fired');
        this.activity.logActivity('guard', paneId, message, entry);
        if ((entry.action === 'warn' || entry.action === 'block') && this.ctx.externalNotifier) {
          this.ctx.externalNotifier.notify({
            category: entry.action === 'block' ? 'alert' : 'warning',
            title: `Team Memory Guard (${entry.action})`,
            message,
            meta: {
              guardId: entry.guardId || null,
              scope: entry.scope || null,
              sourcePattern: entry.sourcePattern || null,
            },
          }).catch((notifyErr) => {
            log.warn('TeamMemoryGuard', `Guard notification failed: ${notifyErr.message}`);
          });
        }
        this.handleTeamMemoryGuardExperiment(entry).catch((err) => {
          log.warn('TeamMemoryGuard', `Failed block-guard experiment dispatch: ${err.message}`);
        });
        this.appendTeamMemoryPatternEvent(
          buildGuardFiringPatternEvent(entry, Date.now()),
          'guard-firing'
        ).catch((err) => {
          log.warn('TeamMemoryGuard', `Failed guard-firing pattern append: ${err.message}`);
        });
      },
    });
    if (typeof teamMemory.startCommsTaggedClaimsSweep === 'function') {
      teamMemory.startCommsTaggedClaimsSweep({
        intervalMs: TEAM_MEMORY_TAGGED_CLAIM_SWEEP_INTERVAL_MS,
        immediate: true,
        sessionId: this.commsSessionScopeId || null,
      });
    }

    log.info('TeamMemory', 'Deferred startup tasks complete (backfill + sweeps)');
  }

  async createWindow() {
    const rawOptions = arguments[0] && typeof arguments[0] === 'object' ? arguments[0] : {};
    const windowKey = String(rawOptions.windowKey || 'main').trim() || 'main';
    const lifecycleRoot = rawOptions.lifecycleRoot === true
      || (windowKey === 'main' && !this.canSendToWindow(this.ctx.mainWindow));
    const existingWindow = this.getAppWindow(windowKey);
    if (this.canSendToWindow(existingWindow)) {
      if (typeof existingWindow.show === 'function') existingWindow.show();
      return;
    }

    const isPrimaryWindow = windowKey === 'main';
    const windowTitle = rawOptions.title
      || (isPrimaryWindow
        ? (this.activeProfileName === 'eunbyeol' ? 'SquidRun - 은별' : 'SquidRun')
        : `SquidRun - ${this.formatWindowKeyLabel(windowKey)}`);
    const query = {
      windowKey,
      windowTeam: String(rawOptions.windowTeam || windowKey).trim() || windowKey,
      profileName: this.activeProfileName,
      profileLabel: this.activeProfileName === 'eunbyeol' ? 'Eunbyeol' : this.formatWindowKeyLabel(this.activeProfileName),
    };

    const windowRef = new BrowserWindow({
      width: 1400,
      height: 800,
      icon: path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'squidrun-favicon.ico' : 'squidrun-favicon-256.png'),
      backgroundColor: '#101523',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: path.join(__dirname, '..', '..', 'preload.js'),
      },
      title: windowTitle,
    });
    this.registerAppWindow(windowKey, windowRef, { lifecycleRoot });
    this.enforceMenuSuppression(windowRef);

    if (lifecycleRoot) {
      this.installMainWindowSendInterceptor();
      this.ensurePaneHostReadyForwarder();
      this.setupPermissions();

      // Register IPC handlers and load listeners before renderer startup to avoid startup races.
      this.initModules();
      this.setupWindowListeners(windowRef, { windowKey, lifecycleRoot });
    } else {
      this.setupWindowListeners(windowRef, { windowKey, lifecycleRoot });
    }

    windowRef.loadFile(RENDERER_ENTRY_HTML, { query }).catch((err) => {
      log.error('Window', `Failed to load renderer entry ${RENDERER_ENTRY_HTML}: ${err.message}`);
      this.activity.logActivity('error', 'system', 'Renderer failed to load', {
        reason: 'load_file_failed',
        filePath: RENDERER_ENTRY_HTML,
        error: err.message,
      });
    });

    if (lifecycleRoot) {
      // Hidden pane host windows are non-critical; defer to a separate task so
      // main-window listeners/post-load init always install first.
      this.schedulePaneHostBootstrap();

      const devToolsAllowedByEnv = process.env.SQUIDRUN_DEBUG === '1' || process.env.NODE_ENV === 'development';
      if (this.ctx.currentSettings.devTools && devToolsAllowedByEnv) {
        windowRef.webContents.openDevTools();
      }
    }

  }

  setLaunchWindowProfile(profile = {}) {
    const windowKey = toNonEmptyString(profile.windowKey) || 'main';
    const profileName = toNonEmptyString(profile.profileName) || this.activeProfileName;
    const includeMainWindow = windowKey === 'main'
      ? true
      : profile.includeMainWindow !== false && profile.standaloneWindow !== true;
    this.launchWindowProfile = {
      profileName,
      windowKey,
      includeMainWindow,
      standaloneWindow: includeMainWindow !== true,
      focusWindowKey: toNonEmptyString(profile.focusWindowKey) || windowKey,
    };
    return { ...this.launchWindowProfile };
  }

  getLaunchWindowProfile() {
    return { ...(this.launchWindowProfile || { windowKey: 'main', includeMainWindow: true, standaloneWindow: false, focusWindowKey: 'main' }) };
  }

  async launchWindowsForProfile(profile = null) {
    const nextProfile = profile && typeof profile === 'object'
      ? this.setLaunchWindowProfile(profile)
      : this.getLaunchWindowProfile();
    const windowKey = toNonEmptyString(nextProfile.windowKey) || 'main';
    const includeMainWindow = nextProfile.includeMainWindow === true || windowKey === 'main';

    if (includeMainWindow) {
      await this.openAppWindow('main', {
        lifecycleRoot: this.getOpenAppWindowCount() === 0,
      });
    }
    if (windowKey !== 'main') {
      await this.openAppWindow(windowKey, {
        lifecycleRoot: this.getOpenAppWindowCount() === 0,
      });
    }

    this.focusAppWindow(nextProfile.focusWindowKey || windowKey);
    return nextProfile;
  }

  focusAppWindow(rawWindowKey = 'main') {
    const windowKey = String(rawWindowKey || 'main').trim() || 'main';
    const window = this.getAppWindow(windowKey);
    if (!this.canSendToWindow(window)) return false;
    if (typeof window.isMinimized === 'function' && window.isMinimized()) {
      window.restore();
    }
    if (typeof window.isVisible === 'function' && !window.isVisible()) {
      window.show();
    } else if (typeof window.show === 'function') {
      window.show();
    }
    if (typeof window.moveTop === 'function') {
      window.moveTop();
    }
    if (typeof window.focus === 'function') {
      window.focus();
    }
    return true;
  }

  async openAppWindow(rawWindowKey = 'main', options = {}) {
    const windowKey = String(rawWindowKey || 'main').trim() || 'main';
    const windowTitle = windowKey === 'main'
      ? 'SquidRun'
      : `SquidRun - ${this.formatWindowKeyLabel(windowKey)}`;
    await this.createWindow({
      windowKey,
      windowTeam: windowKey,
      title: windowTitle,
      lifecycleRoot: options.lifecycleRoot === true,
    });
    this.focusAppWindow(windowKey);
    return {
      ok: true,
      windowKey,
      title: windowTitle,
    };
  }

  async closeAppWindow(rawWindowKey = 'main') {
    const windowKey = String(rawWindowKey || 'main').trim() || 'main';
    const window = this.getAppWindow(windowKey);
    if (!window) {
      return {
        ok: false,
        reason: 'window_not_found',
        windowKey,
      };
    }
    window.close();
    return {
      ok: true,
      windowKey,
    };
  }

  formatWindowKeyLabel(windowKey) {
    const raw = String(windowKey || 'main').trim();
    if (!raw) return 'Window';
    return raw
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  getWindowSessionScopeId(windowKey = 'main') {
    const normalizedWindowKey = String(windowKey || 'main').trim() || 'main';
    const baseScopeId = toNonEmptyString(this.commsSessionScopeId) || `app-${process.pid}-${Date.now()}`;
    if (normalizedWindowKey === 'main' && !isMainProfile(this.activeProfileName)) {
      return `${baseScopeId}:${this.activeProfileName}`;
    }
    return normalizedWindowKey === 'main'
      ? baseScopeId
      : `${baseScopeId}:${normalizedWindowKey}`;
  }

  getOpenAppWindowCount(excludedWindowKey = null) {
    const excludedKey = toNonEmptyString(excludedWindowKey);
    if (typeof this.ctx.getWindows === 'function') {
      return Array.from(this.ctx.getWindows().entries())
        .filter(([windowKey, windowRef]) => {
          if (excludedKey && String(windowKey || '').trim() === excludedKey) return false;
          return this.canSendToWindow(windowRef);
        })
        .length;
    }
    const fallbackWindow = excludedKey === 'main' ? null : this.ctx.mainWindow;
    return this.canSendToWindow(fallbackWindow) ? 1 : 0;
  }

  getFallbackMainWindow(excludedWindow = null) {
    const currentMainWindow = this.getAppWindow('main');
    if (this.canSendToWindow(currentMainWindow) && currentMainWindow !== excludedWindow) {
      return currentMainWindow;
    }
    if (typeof this.ctx.getWindows !== 'function') return null;
    for (const [, windowRef] of this.ctx.getWindows().entries()) {
      if (!this.canSendToWindow(windowRef)) continue;
      if (windowRef === excludedWindow) continue;
      return windowRef;
    }
    return null;
  }

  handleAppWindowClosed(windowKey, windowRef) {
    this.unregisterAppWindow(windowKey);
    if (this.ctx.mainWindow !== windowRef) return;
    const replacementWindow = this.getFallbackMainWindow(windowRef);
    if (typeof this.ctx.setMainWindow === 'function') {
      this.ctx.setMainWindow(replacementWindow || null);
      return;
    }
    this.ctx.mainWindow = replacementWindow || null;
  }

  seedRendererWindowState(window, options = {}) {
    if (!this.canSendToWindow(window)) return;
    const windowKey = String(options.windowKey || 'main').trim() || 'main';
    try {
      window.webContents.send('state-changed', watcher.readState());
    } catch (err) {
      log.warn('Window', `Failed to seed state for ${windowKey}: ${err.message}`);
    }

    if (this.ctx.daemonClient?.connected) {
      try {
        const terminals = this.ctx.daemonClient.getTerminals?.() || [];
        window.webContents.send('daemon-connected', { terminals, windowKey });
        return;
      } catch (err) {
        log.warn('Window', `Failed to seed daemon state for ${windowKey}: ${err.message}`);
      }
    }

    if (this.daemonTimeoutTriggered && !this.daemonConnectedForStartup) {
      try {
        window.webContents.send('daemon-timeout', {
          reason: 'daemon_connect_timeout_replay',
          windowKey,
        });
      } catch (err) {
        log.warn('Window', `Failed to replay daemon timeout for ${windowKey}: ${err.message}`);
      }
    }
  }

  getEunbyeolDesktopShortcutPath() {
    if (process.platform !== 'win32' || typeof app?.getPath !== 'function') return null;
    return path.join(app.getPath('desktop'), 'SquidRun - 은별.lnk');
  }

  buildEunbyeolDesktopShortcutOptions() {
    if (process.platform !== 'win32') return null;
    const uiRoot = path.resolve(path.join(__dirname, '..', '..'));
    const isPackaged = app.isPackaged === true;
    return {
      target: process.execPath,
      args: isPackaged
        ? '--profile=eunbyeol --window=eunbyeol --standalone-window'
        : `"${uiRoot}" --profile=eunbyeol --window=eunbyeol --standalone-window`,
      cwd: isPackaged ? path.dirname(process.execPath) : uiRoot,
      description: 'Open the Eunbyeol SquidRun profile.',
      icon: path.join(uiRoot, 'assets', 'squidrun-favicon.ico'),
      iconIndex: 0,
      appUserModelId: WINDOWS_APP_USER_MODEL_ID,
    };
  }

  ensureEunbyeolDesktopShortcut() {
    if (process.platform !== 'win32') {
      return { ok: false, skipped: true, reason: 'unsupported_platform' };
    }
    if (!shell || typeof shell.writeShortcutLink !== 'function') {
      return { ok: false, skipped: true, reason: 'shortcut_api_unavailable' };
    }
    const shortcutPath = this.getEunbyeolDesktopShortcutPath();
    const shortcutOptions = this.buildEunbyeolDesktopShortcutOptions();
    if (!shortcutPath || !shortcutOptions?.target) {
      return { ok: false, skipped: true, reason: 'shortcut_target_unavailable' };
    }
    const written = shell.writeShortcutLink(shortcutPath, 'create', shortcutOptions);
    return {
      ok: written === true,
      shortcutPath,
      shortcutOptions,
      reason: written === true ? null : 'write_shortcut_failed',
    };
  }

  getEunbyeolStartupBundlePath() {
    return resolveCoordPath(path.join('runtime', 'window-teams', 'eunbyeol', 'startup-bundle.md'), { forWrite: true });
  }

  getEunbyeolStartupSourcePaths() {
    return [
      resolveProfileInstructionPath(getProjectRoot() || process.cwd(), 'CLAUDE.md', 'eunbyeol'),
      resolveProfileInstructionPath(getProjectRoot() || process.cwd(), 'ROLES.md', 'eunbyeol'),
      path.join(getProjectRoot() || process.cwd(), 'workspace', 'knowledge', 'case-operations.md'),
      path.join(getProjectRoot() || process.cwd(), 'workspace', 'knowledge', 'handoff-corrections.md'),
      ...EUNBYEOL_CONFIRMED_FACT_PATHS,
    ];
  }

  async readRecentEunbyeolTelegramHistory(limit = 8) {
    const result = await executeEvidenceLedgerOperation(
      'query-comms-journal',
      {
        channel: 'telegram',
        order: 'desc',
        limit: Math.max(limit * 4, 24),
      },
      {
        source: {
          via: 'eunbyeol-startup-bundle',
          role: 'system',
          paneId: 'system',
        },
      }
    ).catch((err) => ({ ok: false, error: err.message, items: [] }));
    const rows = Array.isArray(result)
      ? result
      : (Array.isArray(result?.items) ? result.items : []);
    return rows
      .filter((row) => {
        const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
        const metadataChatId = normalizeChatId(metadata.chatId || metadata.telegramChatId || null);
        const windowKey = toNonEmptyString(metadata.windowKey) || null;
        const sessionId = toNonEmptyString(row?.sessionId) || null;
        return metadataChatId === EUNBYEOL_CHAT_ID
          || windowKey === 'eunbyeol'
          || sessionId === this.getWindowSessionScopeId('eunbyeol')
          || sessionId?.endsWith(':eunbyeol') === true;
      })
      .slice(0, limit);
  }

  async readEunbyeolCognitiveMemoryEntries(limit = 6) {
    const result = await executeCognitiveMemoryOperation(
      'retrieve',
      {
        agentId: 'architect',
        query: 'Eunbyeol Hillstate Jeon Qeline case operations handoff corrections',
        limit,
      },
      {
        source: {
          via: 'eunbyeol-startup-bundle',
          role: 'system',
          paneId: 'system',
        },
      }
    ).catch((err) => ({ ok: false, error: err.message, results: [] }));
    return Array.isArray(result?.results) ? result.results.slice(0, limit) : [];
  }

  async buildEunbyeolStartupBundle() {
    const sourcePaths = this.getEunbyeolStartupSourcePaths();
    const claudePath = sourcePaths[0];
    const rolesPath = sourcePaths[1];
    const caseOperationsPath = sourcePaths[2];
    const handoffCorrectionsPath = sourcePaths[3];
    const confirmedFactsPaths = sourcePaths.slice(4);
    const [telegramHistory, cognitiveEntries] = await Promise.all([
      this.readRecentEunbyeolTelegramHistory(8),
      this.readEunbyeolCognitiveMemoryEntries(6),
    ]);

    const claudeLines = this.readTextFileSafe(claudePath)
      .split(/\r?\n/)
      .filter((line) => /은별|eunbyeol|rachelchoi|case-operations|confirmed-facts|hillstate|jeon|qeline|korean fraud/i.test(line))
      .slice(0, 16);
    const rolesLines = this.readTextFileSafe(rolesPath)
      .split(/\r?\n/)
      .filter((line) => /은별|eunbyeol|telegram|8754356993|case|hillstate|jeon|qeline/i.test(line))
      .slice(0, 16);
    const caseOperationsPreview = this.readTextFileSafe(caseOperationsPath)
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 20);
    const handoffCorrectionsPreview = this.readTextFileSafe(handoffCorrectionsPath)
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 16);
    const confirmedFactsPreviews = confirmedFactsPaths.map((filePath) => ({
      filePath,
      lines: this.readTextFileSafe(filePath)
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 12),
    }));

    const lines = [
      '# Eunbyeol Startup Bundle',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Session Scope: ${this.getWindowSessionScopeId('eunbyeol')}`,
      '',
      'Window purpose:',
      '- This window is for Eunbyeol-only case work.',
      '- Keep focus on Hillstate, Jeon Myeongsam, Qeline/Korean Fraud, insurance, and competition docs.',
      '- Do not mix trading chatter into this lane.',
      '',
      'Authoritative source files:',
      ...sourcePaths.map((filePath) => `- ${filePath}`),
      '',
      'Scoped CLAUDE.md lines:',
      ...(claudeLines.length > 0 ? claudeLines.map((line) => `> ${line}`) : ['> No Eunbyeol-specific CLAUDE.md lines found.']),
      '',
      'Scoped ROLES.md lines:',
      ...(rolesLines.length > 0 ? rolesLines.map((line) => `> ${line}`) : ['> No Eunbyeol-specific ROLES.md lines found.']),
      '',
      `Case dashboard preview (${caseOperationsPath}):`,
      ...(caseOperationsPreview.length > 0 ? caseOperationsPreview.map((line) => `- ${line}`) : ['- Missing or empty case-operations.md']),
      '',
      `Handoff corrections preview (${handoffCorrectionsPath}):`,
      ...(handoffCorrectionsPreview.length > 0 ? handoffCorrectionsPreview.map((line) => `- ${line}`) : ['- Missing or empty handoff-corrections.md']),
    ];

    for (const preview of confirmedFactsPreviews) {
      lines.push('');
      lines.push(`Confirmed facts preview (${preview.filePath}):`);
      if (preview.lines.length > 0) {
        lines.push(...preview.lines.map((line) => `- ${line}`));
      } else {
        lines.push('- Missing or empty confirmed-facts.md');
      }
    }

    lines.push('');
    lines.push(`Recent Eunbyeol Telegram history (chat ${EUNBYEOL_CHAT_ID}):`);
    if (telegramHistory.length > 0) {
      for (const entry of telegramHistory) {
        const metadata = entry?.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
        const sender = toNonEmptyString(metadata.from) || toNonEmptyString(entry?.senderRole) || 'unknown';
        const body = String(entry?.rawBody || '').replace(/\s+/g, ' ').trim();
        if (!body) continue;
        lines.push(`- ${sender}: ${body.slice(0, 280)}`);
      }
    } else {
      lines.push('- No recent Telegram history found for Eunbyeol in the evidence ledger.');
    }

    lines.push('');
    lines.push('Relevant cognitive memory entries:');
    if (cognitiveEntries.length > 0) {
      for (const entry of cognitiveEntries) {
        const title = toNonEmptyString(entry?.title) || toNonEmptyString(entry?.heading) || 'Memory';
        const sourcePath = toNonEmptyString(entry?.sourcePath) || 'cognitive-memory';
        const content = String(entry?.content || '').replace(/\s+/g, ' ').trim();
        lines.push(`- ${title} (${sourcePath}): ${content.slice(0, 260)}`);
      }
    } else {
      lines.push('- No cognitive memory entries were retrieved for the Eunbyeol startup query.');
    }

    return {
      ok: true,
      sessionScopeId: this.getWindowSessionScopeId('eunbyeol'),
      sourcePaths,
      bundlePath: this.getEunbyeolStartupBundlePath(),
      text: lines.join('\n'),
    };
  }

  async writeEunbyeolStartupBundle(bundle = null) {
    const nextBundle = bundle && typeof bundle === 'object' ? bundle : await this.buildEunbyeolStartupBundle();
    if (!nextBundle?.bundlePath || !nextBundle?.text) return nextBundle;
    fs.mkdirSync(path.dirname(nextBundle.bundlePath), { recursive: true });
    fs.writeFileSync(nextBundle.bundlePath, `${nextBundle.text}\n`, 'utf8');
    return nextBundle;
  }

  async injectEunbyeolStartupBundle() {
    const bundle = await this.writeEunbyeolStartupBundle();
    const sessionScopeId = bundle?.sessionScopeId || this.getWindowSessionScopeId('eunbyeol');
    for (const paneId of ['1', '2', '3']) {
      this.routeInjectMessage({
        panes: [paneId],
        message: `${bundle.text}\r`,
        startupInjection: true,
        meta: {
          windowKey: 'eunbyeol',
          session_id: sessionScopeId,
          startupInjection: true,
          contextBundle: 'eunbyeol',
          authoritative: true,
          sourceFiles: bundle?.sourcePaths || [],
          bundlePath: bundle?.bundlePath || null,
        },
      });
    }
    return bundle;
  }

  getAppWindow(windowKey = 'main') {
    if (typeof this.ctx.getWindow === 'function') {
      return this.ctx.getWindow(windowKey);
    }
    return String(windowKey || 'main') === 'main' ? this.ctx.mainWindow : null;
  }

  getAppWindows() {
    if (typeof this.ctx.getWindows === 'function') {
      return Array.from(this.ctx.getWindows().entries());
    }
    if (this.canSendToWindow(this.ctx.mainWindow)) {
      return [['main', this.ctx.mainWindow]];
    }
    return [];
  }

  registerAppWindow(windowKey, windowRef, options = {}) {
    if (typeof this.ctx.setWindow === 'function') {
      this.ctx.setWindow(windowKey, windowRef);
    }
    if (String(windowKey || 'main') === 'main') {
      this.ctx.mainWindow = windowRef;
      if (typeof this.ctx.setMainWindow === 'function') {
        this.ctx.setMainWindow(windowRef);
      }
      return;
    }
    if (options.lifecycleRoot === true) {
      if (typeof this.ctx.setMainWindow === 'function') {
        this.ctx.setMainWindow(windowRef);
      } else {
        this.ctx.mainWindow = windowRef;
      }
    }
  }

  unregisterAppWindow(windowKey) {
    if (typeof this.ctx.deleteWindow === 'function') {
      this.ctx.deleteWindow(windowKey);
      return;
    }
    if (String(windowKey || 'main') === 'main') {
      this.ctx.mainWindow = null;
    }
  }

  enforceMenuSuppression(windowRef) {
    if (Menu && typeof Menu.setApplicationMenu === 'function') {
      try {
        Menu.setApplicationMenu(null);
      } catch (err) {
        log.warn('App', `Failed to clear application menu: ${err.message}`);
      }
    }

    if (!windowRef || (typeof windowRef.isDestroyed === 'function' && windowRef.isDestroyed())) {
      return;
    }

    if (typeof windowRef.removeMenu === 'function') {
      windowRef.removeMenu();
    } else if (typeof windowRef.setMenu === 'function') {
      windowRef.setMenu(null);
    }

    if (typeof windowRef.setAutoHideMenuBar === 'function') {
      windowRef.setAutoHideMenuBar(true);
    }
    if (typeof windowRef.setMenuBarVisibility === 'function') {
      windowRef.setMenuBarVisibility(false);
    }
  }

  setupPermissions() {
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {   
      const allowedPermissions = ['media', 'audioCapture', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];       
      const mediaTypes = details?.mediaTypes || [];
      if (allowedPermissions.includes(permission) || mediaTypes.includes('audio')) {
        return true;
      }
      return false;
    });

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowedPermissions = ['media', 'audioCapture', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];       
      if (allowedPermissions.includes(permission)) {
        callback(true);
      } else {
        callback(false);
      }
    });
  }

  initModules() {
    const window = this.ctx.mainWindow;

    // Triggers
    triggers.init(window, this.ctx.agentRunning, (type, paneId, msg, details) =>
      this.activity.logActivity(type, paneId, msg, details));
    triggers.setWatcher(watcher);
    if (typeof triggers.setInjectMessageRouter === 'function') {
      triggers.setInjectMessageRouter((payload) => this.routeInjectMessage(payload));
    }

    ipcMain.removeHandler('pane-host-inject');
    ipcMain.handle('pane-host-inject', async (event, paneId, payload = {}) => {
      const id = String(paneId || '').trim();
      if (!id) {
        return { success: false, reason: 'missing_pane_id' };
      }
      const action = String(payload?.action || '').trim().toLowerCase();
      if (action) {
        if (!this.isTrustedPaneHostSender(event, id)) {
          return { success: false, reason: 'unauthorized_sender', paneId: id, action };
        }

        if (action === 'ready') {
          this.handlePaneHostReadySignal({ paneId: id });
          return { success: true, paneId: id, action };
        }

        if (action === 'dispatch-enter') {
          const result = this.dispatchPaneHostEnter(id);
          return {
            ...result,
            action,
          };
        }

        if (action === 'delivery-ack') {
          this.handleTriggerDeliveryAck({
            deliveryId: payload?.deliveryId || null,
            paneId: id,
          });
          return { success: true, paneId: id, action };
        }

        if (action === 'delivery-outcome') {
          const outcome = (payload?.outcome && typeof payload.outcome === 'object')
            ? { ...payload.outcome }
            : {};
          Object.assign(outcome, payload, { paneId: id });
          delete outcome.action;
          this.handleTriggerDeliveryOutcome(outcome);
          return { success: true, paneId: id, action };
        }

        return { success: false, reason: 'unsupported_action', paneId: id, action };
      }

      if (!this.isHiddenPaneHostModeEnabled()) {
        return { success: false, reason: 'hidden_hosts_disabled' };
      }
      const routed = this.routeInjectMessage({
        panes: [id],
        message: payload?.message || '',
        deliveryId: payload?.deliveryId || null,
        traceContext: payload?.traceContext || null,
        meta: payload?.meta || null,
      });
      return routed
        ? { success: true, paneId: id, mode: 'routed-inject' }
        : { success: false, reason: 'inject_route_unavailable', paneId: id };
    });

    // Direct Enter dispatch for hidden pane hosts — bypasses pty-write IPC handler
    // to use the same direct daemonClient.write path as the working Enter button.
    ipcMain.removeHandler('pane-host-dispatch-enter');
    ipcMain.handle('pane-host-dispatch-enter', (_event, paneId) => this.dispatchPaneHostEnter(paneId));

    // Recovery
    this.ctx.setRecoveryManager(this.initRecoveryManager());
    triggers.setSelfHealing(this.ctx.recoveryManager);

    // Plugins
    this.ctx.setPluginManager(this.initPluginManager());
    triggers.setPluginManager(this.ctx.pluginManager);
    this.ctx.pluginManager.loadAll();

    // Backup
    this.ctx.setBackupManager(this.initBackupManager());

    // Watcher
    watcher.init(window, triggers, () => this.ctx.currentSettings);

    // IPC Handlers
    ipcHandlers.init({
      mainWindow: window,
      daemonClient: this.ctx.daemonClient,
      agentRunning: this.ctx.agentRunning,
      currentSettings: this.ctx.currentSettings,
      watcher,
      triggers,
      usageStats: this.ctx.usageStats,
      sessionStartTimes: this.ctx.sessionStartTimes,
      recoveryManager: this.ctx.recoveryManager,
      pluginManager: this.ctx.pluginManager,
      backupManager: this.ctx.backupManager,
    });

    ipcHandlers.setupIPCHandlers({
      loadSettings: () => this.settings.loadSettings(),
      saveSettings: (s) => this.settings.saveSettings(s),
      readAppStatus: () => this.settings.readAppStatus(),
      getStartupServicesStatus: () => this.getStartupServicesStatus(),
      getSessionId: () => this.commsSessionScopeId,
      recordSessionStart: (id) => this.usage.recordSessionStart(id),
      recordSessionEnd: (id) => this.usage.recordSessionEnd(id),
      recordSessionLifecycle: (payload = {}) => this.recordSessionLifecyclePattern(payload),
      updateIntentState: (payload = {}) => this.updateIntentStateAtomic(payload),
      saveUsageStats: () => this.usage.saveUsageStats(),
      broadcastClaudeState: () => this.broadcastClaudeState(),
      logActivity: (t, p, m, d) => this.activity.logActivity(t, p, m, d),
      getActivityLog: (f) => this.activity.getActivityLog(f),
      clearActivityLog: () => this.activity.clearActivityLog(),
      saveActivityLog: () => this.activity.saveActivityLog(),
      firmwareManager: this.firmwareManager,
      problemOrchestrator: this.problemOrchestrator,
      getBridgeDevices: (options = {}) => this.getBridgeDevices(options),
      getBridgeStatus: () => this.getBridgeStatus(),
      getBridgePairingState: () => this.getBridgePairingState(),
      initiateBridgePairing: (options = {}) => this.initiateBridgePairing(options),
      joinBridgePairing: (payload = {}) => this.joinBridgePairing(payload),
      startRuntimeLifecycle: (reason) => this.startRuntimeServices(reason || 'ipc-start'),
      stopRuntimeLifecycle: (reason) => this.stopRuntimeServices(reason || 'ipc-stop'),
      getRuntimeLifecycleState: () => this.runtimeLifecycleState,
      performFullShutdown: (reason) => this.performFullShutdown(reason || 'ipc-full-restart'),
    });

    ipcMain.removeHandler('get-onboarding-state');
    ipcMain.handle('get-onboarding-state', () => {
      const snapshot = this.readPersistedOnboardingState();
      const onboardingPath = snapshot?.path || this.getOnboardingStatePath(this.getDefaultExternalWorkspacePath());
      const state = snapshot?.state || null;
      return {
        success: true,
        path: onboardingPath,
        workspacePath: snapshot?.workspacePath || this.getDefaultExternalWorkspacePath(),
        onboardingComplete: this.isOnboardingComplete(state),
        state,
      };
    });

    ipcMain.removeHandler('complete-onboarding');
    ipcMain.handle('complete-onboarding', (_event, payload = {}) => {
      try {
        const snapshot = this.readPersistedOnboardingState();
        const snapshotWorkspace = typeof snapshot?.workspacePath === 'string'
          ? snapshot.workspacePath.trim()
          : '';
        const workspacePath = snapshotWorkspace && !this.isBundledRuntimePath(snapshotWorkspace)
          ? snapshotWorkspace
          : this.getDefaultExternalWorkspacePath();
        const result = this.writeOnboardingState(payload, workspacePath);
        return {
          success: true,
          state: result.state,
          path: result.path,
        };
      } catch (err) {
        return {
          success: false,
          error: err.message,
        };
      }
    });

    ipcMain.removeHandler('open-app-window');
    ipcMain.handle('open-app-window', async (_event, payload = {}) => {
      const requestedWindowKey = typeof payload === 'string'
        ? payload
        : (payload?.windowKey || payload?.key || 'main');
      return this.openAppWindow(requestedWindowKey);
    });

    ipcMain.removeHandler('close-app-window');
    ipcMain.handle('close-app-window', async (_event, payload = {}) => {
      const requestedWindowKey = typeof payload === 'string'
        ? payload
        : (payload?.windowKey || payload?.key || 'main');
      return this.closeAppWindow(requestedWindowKey);
    });

    // Pipeline
    pipeline.init({
      mainWindow: window,
      sendDirectMessage: (targets, message, fromRole) => triggers.sendDirectMessage(targets, message, fromRole),
    });
    // Pipeline IPC handlers
    ipcMain.removeHandler('pipeline-get-items');
    ipcMain.handle('pipeline-get-items', (event, stageFilter) => {
      return pipeline.getItems(stageFilter || null);
    });
    ipcMain.removeHandler('pipeline-get-active');
    ipcMain.handle('pipeline-get-active', () => {
      return pipeline.getActiveItems();
    });
    ipcMain.removeHandler('pipeline-mark-committed');
    ipcMain.handle('pipeline-mark-committed', (event, itemId) => {
      return pipeline.markCommitted(itemId);
    });

    // Shared State (P3)
    sharedState.init({
      watcher,
      mainWindow: window,
    });

    // Shared State IPC handlers
    ipcMain.removeHandler('shared-state-get');
    ipcMain.handle('shared-state-get', () => {
      return sharedState.getState();
    });
    ipcMain.removeHandler('shared-state-changelog');
    ipcMain.handle('shared-state-changelog', (event, { paneId, since } = {}) => {
      if (paneId) return sharedState.getChangelogForPane(paneId);
      return sharedState.getChangesSince(since || 0);
    });
    ipcMain.removeHandler('shared-state-mark-seen');
    ipcMain.handle('shared-state-mark-seen', (event, paneId) => {
      sharedState.markPaneSeen(paneId);
    });

    // Context Compressor (P4)
    contextCompressor.init({
      sharedState,
      mainWindow: window,
      watcher,
      isIdle: () => (Date.now() - this.lastDaemonOutputAtMs) > APP_IDLE_THRESHOLD_MS,
    });

    ipcMain.removeHandler('context-snapshot-refresh');
    ipcMain.handle('context-snapshot-refresh', (event, paneId) => {
      if (paneId) return contextCompressor.refresh(paneId);
      return contextCompressor.refreshAll();
    });
  }

  emitCommsBridgeEvent(eventType, payload = {}) {
    if (typeof eventType !== 'string' || !eventType.startsWith('comms.')) return false;
    this.kernelBridge.emitBridgeEvent(eventType, payload, 'system');
    return true;
  }

  schedulePtyDataFlush() {
    if (this.ptyDataFlushTimer) return;
    this.ptyDataFlushTimer = setTimeout(() => {
      this.ptyDataFlushTimer = null;
      this.flushBufferedPtyData();
    }, PTY_DATA_IPC_BATCH_INTERVAL_MS);
    if (typeof this.ptyDataFlushTimer.unref === 'function') {
      this.ptyDataFlushTimer.unref();
    }
  }

  queuePtyDataForUi(paneId, data) {
    const paneKey = String(paneId);
    const chunk = String(data ?? '');
    if (!chunk) return;
    const current = this.pendingPtyDataByPane.get(paneKey) || '';
    this.pendingPtyDataByPane.set(paneKey, current + chunk);
    this.schedulePtyDataFlush();
  }

  flushBufferedPtyData(targetPaneId = null) {
    if (this.pendingPtyDataByPane.size === 0) return;

    const paneIds = targetPaneId === null
      ? Array.from(this.pendingPtyDataByPane.keys())
      : [String(targetPaneId)];

    for (const paneId of paneIds) {
      const buffered = this.pendingPtyDataByPane.get(paneId);
      if (!buffered) continue;
      this.pendingPtyDataByPane.delete(paneId);

      if (this.isHiddenPaneHostModeEnabled()) {
        this.paneHostWindowManager.sendToPaneWindow(String(paneId), `pty-data-${paneId}`, buffered);
      }
      this.visiblePtyOutputFilter.ingest(paneId, buffered);
      this.flushVisibleFilteredPtyData(paneId);
    }

    this.refreshPtyVisibleReleaseTimer();
  }

  flushVisibleFilteredPtyData(targetPaneId = null, options = {}) {
    const releases = this.visiblePtyOutputFilter.releaseReady(targetPaneId, options);
    for (const entry of releases) {
      if (!entry || !entry.text) continue;
      this.sendToVisibleWindow(`pty-data-${entry.paneId}`, entry.text);
    }
  }

  refreshPtyVisibleReleaseTimer() {
    this.clearPtyVisibleReleaseTimer();
    const delay = this.visiblePtyOutputFilter.getNextReleaseDelayMs();
    if (delay === null) return;

    this.ptyVisibleReleaseTimer = setTimeout(() => {
      this.ptyVisibleReleaseTimer = null;
      this.flushVisibleFilteredPtyData();
      this.refreshPtyVisibleReleaseTimer();
    }, Math.max(0, delay));
    if (typeof this.ptyVisibleReleaseTimer.unref === 'function') {
      this.ptyVisibleReleaseTimer.unref();
    }
  }

  handlePtyDataKernelEvent(eventData = {}) {
    const result = this.visiblePtyOutputFilter.applyKernelEvent(eventData);
    if (result?.paneId && result.changed) {
      this.flushVisibleFilteredPtyData(result.paneId);
    }
    this.refreshPtyVisibleReleaseTimer();
    return result;
  }

  clearPtyDataFlushTimer() {
    if (!this.ptyDataFlushTimer) return;
    clearTimeout(this.ptyDataFlushTimer);
    this.ptyDataFlushTimer = null;
  }

  clearPtyVisibleReleaseTimer() {
    if (!this.ptyVisibleReleaseTimer) return;
    clearTimeout(this.ptyVisibleReleaseTimer);
    this.ptyVisibleReleaseTimer = null;
  }

  async requestDaemonTerminalSnapshot(timeoutMs = 2000) {
    const daemonClient = this.ctx.daemonClient;
    if (!daemonClient || typeof daemonClient.list !== 'function') return [];

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        daemonClient.off('list', handleList);
      };

      const finish = (terminals) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (Array.isArray(terminals)) {
          resolve(terminals);
          return;
        }
        resolve(daemonClient.getTerminals?.() || []);
      };

      const handleList = (terminals) => {
        finish(terminals);
      };

      daemonClient.on('list', handleList);
      timer = setTimeout(() => {
        finish(null);
      }, Math.max(250, Number(timeoutMs) || 2000));

      const sent = daemonClient.list();
      if (!sent) {
        finish(null);
      }
    });
  }

  async runWakeRecovery() {
    if (this.wakeRecoveryInFlight) {
      this.emitCommsBridgeEvent('comms.transport.recovery.skipped', {
        reason: 'already_in_flight',
      });
      return;
    }

    this.wakeRecoveryInFlight = true;
    const startedAtMs = Date.now();
    this.emitCommsBridgeEvent('comms.transport.recovery.started', {
      startedAtMs,
    });

    try {
      const supervisorResult = await this.ensureSupervisorDaemonRunning('wake-recovery');
      if (!supervisorResult?.ok) {
        log.warn(
          'Supervisor',
          `Wake recovery bootstrap failed: ${supervisorResult?.error || supervisorResult?.reason || 'unknown'}`
        );
      }

      const daemonClient = this.ctx.daemonClient;
      if (!daemonClient) {
        this.emitCommsBridgeEvent('comms.transport.recovery.failed', {
          reason: 'daemon_client_unavailable',
        });
        return;
      }

      if (!daemonClient.connected) {
        this.emitCommsBridgeEvent('comms.transport.reconnect.attempted', {
          reason: 'post_wake',
        });
        const connected = await daemonClient.connect();
        if (!connected) {
          this.emitCommsBridgeEvent('comms.transport.reconnect.failed', {
            reason: 'connect_failed',
          });
          this.emitCommsBridgeEvent('comms.transport.recovery.failed', {
            reason: 'connect_failed',
          });
          return;
        }
        this.emitCommsBridgeEvent('comms.transport.reconnect.succeeded', {
          reason: 'post_wake',
        });
      }

      const terminals = await this.requestDaemonTerminalSnapshot(2500);
      for (const paneId of PANE_IDS) {
        daemonClient.resume(String(paneId));
      }

      this.sendToAllWindows('daemon-connected', { terminals });
      this.primePaneHostFromTerminalSnapshot(terminals);

      this.emitCommsBridgeEvent('comms.transport.recovery.completed', {
        durationMs: Math.max(0, Date.now() - startedAtMs),
        terminalCount: Array.isArray(terminals) ? terminals.length : 0,
      });
    } catch (err) {
      this.emitCommsBridgeEvent('comms.transport.recovery.failed', {
        reason: err.message,
      });
    } finally {
      this.wakeRecoveryInFlight = false;
    }
  }

  setupPowerMonitorListeners() {
    if (!powerMonitor || typeof powerMonitor.on !== 'function') return;
    if (this.powerMonitorListeners.length > 0) return;

    const register = (eventName, handler) => {
      powerMonitor.on(eventName, handler);
      this.powerMonitorListeners.push({ eventName, handler });
    };

    register('suspend', () => {
      const suspendedAtMs = Date.now();
      this.lastSystemSuspendAtMs = suspendedAtMs;
      this.emitCommsBridgeEvent('comms.system.suspend', {
        timestamp: suspendedAtMs,
      });

      if (this.ctx.daemonClient?.connected) {
        this.ctx.daemonClient.saveSession();
      }
    });

    register('resume', () => {
      const resumedAtMs = Date.now();
      this.lastSystemResumeAtMs = resumedAtMs;
      const sleptMs = Number.isFinite(this.lastSystemSuspendAtMs)
        ? Math.max(0, resumedAtMs - this.lastSystemSuspendAtMs)
        : null;
      this.emitCommsBridgeEvent('comms.system.resume', {
        timestamp: resumedAtMs,
        sleptMs,
      });
      void this.runWakeRecovery();
    });
  }

  setupWindowListeners(window = this.ctx.mainWindow, options = {}) {
    const windowKey = String(options.windowKey || 'main').trim() || 'main';
    const isPrimaryWindow = windowKey === 'main';
    const lifecycleRoot = options.lifecycleRoot === true;

    if (!window) return;

    window.on('close', (event) => {
      if (!isPrimaryWindow || this.getOpenAppWindowCount(windowKey) > 0) {
        return;
      }
      if (this.shuttingDown || this.fullShutdownPromise) return;
      event.preventDefault();
      void (async () => {
        try {
          const confirmed = await this.confirmFullShutdown(window);
          if (!confirmed) return;
          await this.performFullShutdown('window-close');
        } catch (err) {
          log.error('Shutdown', `Window-close shutdown flow failed: ${err.message}`);
        }
      })();
    });

    window.on('closed', () => {
      this.handleAppWindowClosed(windowKey, window);
    });

    window.webContents.on('did-start-loading', () => {
      log.info('Window', 'did-start-loading');
    });

    window.webContents.on('dom-ready', () => {
      log.info('Window', 'dom-ready');
    });

    window.webContents.on('did-finish-load', async () => {
      log.info('Window', `did-finish-load${isPrimaryWindow ? '' : ` (${windowKey})`}`);
      if (lifecycleRoot) {
        await this.initPostLoad();
      }
      let eunbyeolBundle = null;
      if (this.activeProfileName === 'eunbyeol' || windowKey === 'eunbyeol') {
        try {
          eunbyeolBundle = await this.injectEunbyeolStartupBundle();
        } catch (err) {
          log.warn('Window', `Failed to build Eunbyeol startup bundle: ${err.message}`);
        }
      }
      try {
        window.webContents.send('window-context', {
          windowKey,
          windowTeam: this.activeProfileName === 'eunbyeol' && windowKey === 'main' ? 'eunbyeol' : windowKey,
          profileName: this.activeProfileName,
          profileLabel: this.activeProfileName === 'eunbyeol' ? 'Eunbyeol' : this.formatWindowKeyLabel(this.activeProfileName),
          roleLayout: 'standard',
          sessionScopeId: this.getWindowSessionScopeId(windowKey),
          startupBundlePath: eunbyeolBundle?.bundlePath || null,
          startupSourceFiles: eunbyeolBundle?.sourcePaths || [],
          autoBootAgents: this.activeProfileName === 'eunbyeol' || windowKey === 'eunbyeol',
        });
      } catch (err) {
        log.warn('Window', `Failed to seed window context for ${windowKey}: ${err.message}`);
      }
      if (!isPrimaryWindow) {
        try {
          this.seedRendererWindowState(window, { windowKey });
        } catch (err) {
          log.warn('Window', `Failed to seed secondary window runtime state for ${windowKey}: ${err.message}`);
        }
      }
    });

    window.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      log.error(
        'Window',
        `did-fail-load code=${errorCode} description=${errorDescription} url=${validatedURL || 'unknown'}`
      );
      this.activity.logActivity('error', 'system', 'Renderer did-fail-load', {
        errorCode,
        errorDescription,
        validatedURL: validatedURL || null,
      });
    });

    window.webContents.on('preload-error', (event, preloadPath, error) => {
      const errorMessage = error?.message || String(error || 'unknown_preload_error');
      log.error('Window', `preload-error path=${preloadPath} message=${errorMessage}`);
      this.activity.logActivity('error', 'system', 'Renderer preload failed', {
        preloadPath,
        error: errorMessage,
      });
    });

    window.webContents.on('render-process-gone', (event, details) => {
      log.error(
        'Window',
        `render-process-gone reason=${details?.reason || 'unknown'} exitCode=${details?.exitCode ?? 'unknown'}`
      );
      this.activity.logActivity('error', 'system', 'Renderer process terminated', {
        reason: details?.reason || 'unknown',
        exitCode: details?.exitCode ?? null,
      });
    });

    window.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'Escape' && input.type === 'keyDown') {
        window.webContents.send('global-escape-pressed');
      }
    });

    window.webContents.on('console-message', (event, level, message) => {
      const levelNames = ['verbose', 'info', 'warning', 'error'];
      const entry = `[${new Date().toISOString()}] [${levelNames[level] || level}] ${message}\n`;
      this.consoleLogWriter.write(entry);
    });
  }

  async confirmFullShutdown(window = this.ctx.mainWindow) {
    if (!window || window.isDestroyed()) return true;
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['Cancel', 'Shutdown'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Shutdown SquidRun',
      message: 'Shutdown SquidRun?',
      detail: SHUTDOWN_CONFIRM_MESSAGE,
    });
    return result.response === 1;
  }

  getSupervisorRuntimePaths() {
    return {
      daemonScriptPath: SUPERVISOR_DAEMON_SCRIPT,
      pidPath: SUPERVISOR_PID_FILE,
      statusPath: SUPERVISOR_STATUS_FILE,
      logPath: SUPERVISOR_LOG_FILE,
    };
  }

  readTextFileSafe(filePath, fallback = '') {
    try {
      return String(fs.readFileSync(filePath, 'utf8') || '');
    } catch {
      return fallback;
    }
  }

  readJsonFileSafe(filePath, fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return fallback;
    }
  }

  getPendingPaneDeliveryQueuePath() {
    return this.pendingPaneDeliveryQueuePath;
  }

  ensurePendingPaneDeliveryQueueDir() {
    const queuePath = this.getPendingPaneDeliveryQueuePath();
    try {
      fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    } catch (err) {
      if (err?.code === 'EACCES' || err?.code === 'ENOENT') {
        log.warn(
          'PendingPaneDelivery',
          `Pending delivery queue unavailable at ${queuePath}: ${err.message}`
        );
        return null;
      }
      throw err;
    }
    return queuePath;
  }

  buildPendingPaneDeliveryKey(entry = {}) {
    const explicit = toNonEmptyString(entry.messageId)
      || toNonEmptyString(entry.queueKey);
    if (explicit) return explicit;
    const hash = createHash('sha1');
    hash.update(JSON.stringify({
      paneId: toNonEmptyString(entry.paneId) || '1',
      message: toNonEmptyString(entry.message) || '',
      fromRole: toNonEmptyString(entry.fromRole) || '',
      channel: toNonEmptyString(entry.channel) || '',
      sender: toNonEmptyString(entry.sender) || '',
    }));
    return `pending-pane-${hash.digest('hex').slice(0, 16)}`;
  }

  normalizePendingPaneDeliveryEntry(entry = {}) {
    const message = toNonEmptyString(entry.message);
    const paneId = toNonEmptyString(entry.paneId) || '1';
    if (!message || !paneId) return null;
    const attemptCount = Number.isFinite(Number(entry.attemptCount))
      ? Math.max(0, Math.floor(Number(entry.attemptCount)))
      : 0;
    return {
      queueKey: this.buildPendingPaneDeliveryKey(entry),
      paneId,
      message,
      messageId: toNonEmptyString(entry.messageId) || null,
      fromRole: toNonEmptyString(entry.fromRole) || null,
      channel: toNonEmptyString(entry.channel) || null,
      sender: toNonEmptyString(entry.sender) || null,
      createdAt: toNonEmptyString(entry.createdAt) || new Date().toISOString(),
      lastAttemptAt: toNonEmptyString(entry.lastAttemptAt) || null,
      lastFailureReason: toNonEmptyString(entry.lastFailureReason) || null,
      attemptCount,
      traceContext: (entry.traceContext && typeof entry.traceContext === 'object')
        ? { ...entry.traceContext }
        : null,
      meta: (entry.meta && typeof entry.meta === 'object')
        ? { ...entry.meta }
        : null,
    };
  }

  readPendingPaneDeliveries() {
    const payload = this.readJsonFileSafe(this.getPendingPaneDeliveryQueuePath(), null);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items
      .map((item) => this.normalizePendingPaneDeliveryEntry(item))
      .filter(Boolean);
  }

  writePendingPaneDeliveries(items = []) {
    const queuePath = this.ensurePendingPaneDeliveryQueueDir();
    if (!queuePath) {
      return null;
    }
    const normalizedItems = Array.isArray(items)
      ? items.map((item) => this.normalizePendingPaneDeliveryEntry(item)).filter(Boolean)
      : [];
    fs.writeFileSync(queuePath, JSON.stringify({
      updatedAt: new Date().toISOString(),
      count: normalizedItems.length,
      items: normalizedItems,
    }, null, 2));
    return normalizedItems;
  }

  queuePendingPaneDelivery(entry = {}) {
    const normalized = this.normalizePendingPaneDeliveryEntry(entry);
    if (!normalized) {
      return { ok: false, reason: 'invalid_pending_delivery_entry' };
    }
    const items = this.readPendingPaneDeliveries();
    const existingIndex = items.findIndex((item) => item.queueKey === normalized.queueKey);
    if (existingIndex >= 0) {
      items[existingIndex] = {
        ...items[existingIndex],
        ...normalized,
        attemptCount: Math.max(items[existingIndex].attemptCount || 0, normalized.attemptCount || 0),
      };
    } else {
      items.push(normalized);
    }
    const persisted = this.writePendingPaneDeliveries(items);
    if (!persisted) {
      return { ok: false, reason: 'pending_delivery_queue_unavailable', queued: false, entry: normalized };
    }
    return { ok: true, queued: true, entry: normalized, count: items.length };
  }

  async deliverPaneMessageReliably({
    paneId = '1',
    message = '',
    fromRole = null,
    traceContext = null,
    meta = null,
    queueOnAcceptedUnverified = false,
    queueOnHardFailure = true,
    messageId = null,
    channel = null,
    sender = null,
    logLabel = 'PaneDelivery',
  } = {}) {
    const normalizedMessage = toNonEmptyString(message);
    const normalizedPaneId = toNonEmptyString(paneId) || '1';
    if (!normalizedMessage) {
      return { accepted: false, queued: false, verified: false, status: 'invalid_message' };
    }

    const result = await triggers.sendDirectMessage(
      [String(normalizedPaneId)],
      normalizedMessage,
      fromRole,
      { traceContext, awaitDelivery: true, meta }
    );

    const accepted = result?.accepted === true || result?.queued === true || result?.ok === true;
    const verified = result?.verified === true;
    const shouldQueue = verified
      ? false
      : ((queueOnAcceptedUnverified && accepted) || (queueOnHardFailure && !accepted));

    if (!shouldQueue) {
      return result;
    }

    const failureReason = toNonEmptyString(result?.status)
      || toNonEmptyString(result?.error)
      || toNonEmptyString(result?.reason)
      || toNonEmptyString(result?.details?.failureReason)
      || 'delivery_unverified';

    const queued = this.queuePendingPaneDelivery({
      paneId: normalizedPaneId,
      message: normalizedMessage,
      messageId,
      fromRole,
      channel,
      sender,
      traceContext,
      meta,
      lastAttemptAt: new Date().toISOString(),
      lastFailureReason: failureReason,
      attemptCount: 1,
    });

    if (queued?.ok) {
      log.warn(logLabel, `Queued pane ${normalizedPaneId} delivery for replay (${failureReason})`);
    }

    return {
      ...result,
      pendingQueued: queued?.ok === true,
      pendingQueueKey: queued?.entry?.queueKey || null,
      pendingFailureReason: failureReason,
    };
  }

  async flushPendingPaneDeliveries({ paneId = null, reason = 'manual-replay' } = {}) {
    const normalizedPaneId = paneId === null || paneId === undefined ? null : String(paneId).trim();
    const run = async () => {
      const items = this.readPendingPaneDeliveries();
      if (!items.length) {
        return { ok: true, deliveredCount: 0, remainingCount: 0, reason };
      }

      let deliveredCount = 0;
      const remaining = [];
      const MAX_PENDING_DELIVERY_RETRIES = 5;
      for (const item of items) {
        if (normalizedPaneId && item.paneId !== normalizedPaneId) {
          remaining.push(item);
          continue;
        }
        if ((item.attemptCount || 0) >= MAX_PENDING_DELIVERY_RETRIES) {
          log.warn('PendingPaneDelivery', `Dropping message after ${MAX_PENDING_DELIVERY_RETRIES} retries (last: ${item.lastFailureReason || 'unknown'})`);
          continue;
        }
        const result = await triggers.sendDirectMessage(
          [String(item.paneId)],
          item.message,
          item.fromRole || null,
          { traceContext: item.traceContext || null, awaitDelivery: true, meta: item.meta || null }
        );
        if (result?.verified === true) {
          deliveredCount += 1;
          continue;
        }
        remaining.push({
          ...item,
          attemptCount: (item.attemptCount || 0) + 1,
          lastAttemptAt: new Date().toISOString(),
          lastFailureReason: toNonEmptyString(result?.status)
            || toNonEmptyString(result?.error)
            || toNonEmptyString(result?.reason)
            || toNonEmptyString(result?.details?.failureReason)
            || 'delivery_unverified',
        });
      }

      this.writePendingPaneDeliveries(remaining);
      if (deliveredCount > 0) {
        log.info('PendingPaneDelivery', `Replayed ${deliveredCount} queued delivery(s) (${reason})`);
      }
      return {
        ok: true,
        deliveredCount,
        remainingCount: remaining.length,
        reason,
      };
    };

    const replayPromise = this.pendingPaneDeliveryReplayPromise.then(run, run);
    this.pendingPaneDeliveryReplayPromise = replayPromise.then(() => undefined, () => undefined);
    return replayPromise;
  }

  parseSupervisorPidPayload(rawValue = '') {
    const raw = String(rawValue || '').trim();
    if (!raw) {
      return { pid: null, payload: null };
    }

    try {
      const payload = JSON.parse(raw);
      return {
        pid: asPositiveInt(payload?.pid, null),
        payload,
      };
    } catch {
      return {
        pid: asPositiveInt(raw, null),
        payload: null,
      };
    }
  }

  isProcessAlive(pid) {
    const numeric = asPositiveInt(pid, null);
    if (!numeric) return false;
    try {
      process.kill(numeric, 0);
      return true;
    } catch {
      return false;
    }
  }

  getSupervisorStatusFreshnessWindowMs(status = {}) {
    const pollMs = asPositiveInt(
      status?.pollMs,
      Number.parseInt(process.env.SQUIDRUN_SUPERVISOR_POLL_MS || '4000', 10) || 4000
    );
    return Math.max(SUPERVISOR_STATUS_STALE_MIN_MS, pollMs * SUPERVISOR_STATUS_STALE_MULTIPLIER);
  }

  readSupervisorRuntimeSnapshot(options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
    const runtimePaths = this.getSupervisorRuntimePaths();
    const daemonScriptExists = fs.existsSync(runtimePaths.daemonScriptPath);
    const pidFilePresent = fs.existsSync(runtimePaths.pidPath);
    const statusFilePresent = fs.existsSync(runtimePaths.statusPath);
    const pidInfo = this.parseSupervisorPidPayload(this.readTextFileSafe(runtimePaths.pidPath, ''));
    const status = this.readJsonFileSafe(runtimePaths.statusPath, null);
    const pid = asPositiveInt(pidInfo.pid, null);
    const pidAlive = this.isProcessAlive(pid);
    const heartbeatAtMs = Number.isFinite(Number(status?.heartbeatAtMs))
      ? Math.floor(Number(status.heartbeatAtMs))
      : null;
    const freshnessWindowMs = this.getSupervisorStatusFreshnessWindowMs(status || {});
    const heartbeatAgeMs = heartbeatAtMs !== null ? Math.max(0, nowMs - heartbeatAtMs) : null;
    const heartbeatFresh = heartbeatAgeMs !== null ? heartbeatAgeMs <= freshnessWindowMs : false;
    const state = typeof status?.state === 'string' ? status.state.trim().toLowerCase() : null;
    const staleReasons = [];

    if (pid && !pidAlive) {
      staleReasons.push('pid_dead');
    }
    if (state === 'stopped') {
      staleReasons.push('status_stopped');
    }
    if (statusFilePresent && heartbeatAtMs !== null && !heartbeatFresh) {
      staleReasons.push('heartbeat_stale');
    }
    if (statusFilePresent && heartbeatAtMs === null) {
      staleReasons.push('missing_heartbeat');
    }

    const healthy = pidAlive
      && (state === null || state !== 'stopped')
      && (!statusFilePresent || heartbeatFresh);

    return {
      ...runtimePaths,
      daemonScriptExists,
      pidFilePresent,
      statusFilePresent,
      pid,
      pidAlive,
      status,
      state,
      heartbeatAtMs,
      heartbeatAgeMs,
      freshnessWindowMs,
      heartbeatFresh,
      healthy,
      stale: staleReasons.length > 0,
      staleReasons,
    };
  }

  async getStartupServicesStatus() {
    const appStatus = (typeof this.settings?.readAppStatus === 'function')
      ? (this.settings.readAppStatus() || null)
      : null;
    const supervisor = this.readSupervisorRuntimeSnapshot();
    const websocketClients = typeof websocketServer.getClients === 'function'
      ? websocketServer.getClients()
      : [];
    let memory = {
      ok: false,
      state: 'unknown',
      available: false,
      status: null,
      error: null,
    };

    try {
      const ingestStatus = await teamMemory.executeTeamMemoryOperation('get-memory-ingest-status', {
        nowMs: Date.now(),
      }, {
        source: 'startup-services-status',
      });
      const normalizedStatus = ingestStatus && typeof ingestStatus === 'object'
        ? ingestStatus
        : null;
      memory = {
        ok: Boolean(normalizedStatus && normalizedStatus.ok !== false),
        state: String(
          normalizedStatus?.state
          || normalizedStatus?.status?.state
          || normalizedStatus?.runtimeState
          || 'ready'
        ),
        available: normalizedStatus?.status?.available !== false,
        status: normalizedStatus?.status || null,
        error: normalizedStatus?.error || null,
      };
    } catch (err) {
      memory = {
        ok: false,
        state: 'error',
        available: false,
        status: null,
        error: err.message,
      };
    }

    return {
      startedAt: appStatus?.started || null,
      lastUpdated: appStatus?.lastUpdated || null,
      daemon: {
        connected: this.ctx?.daemonClient?.connected === true,
        startupConnected: this.daemonConnectedForStartup === true,
        timeoutTriggered: this.daemonTimeoutTriggered === true,
      },
      supervisor: {
        healthy: supervisor.healthy === true,
        pid: supervisor.pid || null,
        pidAlive: supervisor.pidAlive === true,
        staleReasons: supervisor.staleReasons || [],
        heartbeatAtMs: supervisor.heartbeatAtMs || null,
        heartbeatAgeMs: supervisor.heartbeatAgeMs || null,
        state: supervisor.state || null,
      },
      websocket: {
        running: typeof websocketServer.isRunning === 'function' ? websocketServer.isRunning() : false,
        port: typeof websocketServer.getPort === 'function'
          ? (websocketServer.getPort() || websocketServer.DEFAULT_PORT || null)
          : (websocketServer.DEFAULT_PORT || null),
        clientCount: Array.isArray(websocketClients) ? websocketClients.length : 0,
      },
      paneHost: appStatus?.paneHost || {
        hiddenModeEnabled: this.isHiddenPaneHostModeEnabled(),
        degraded: this.paneHostMissingPanes.size > 0,
        missingPanes: Array.from(this.paneHostMissingPanes).sort(),
        readyPanes: Array.from(this.paneHostReady).sort(),
        lastErrorReason: this.paneHostLastErrorReason,
        lastErrorAt: this.paneHostLastErrorAt,
      },
      memory,
      capabilities: {
        loaded: Boolean(this.lastSystemCapabilities),
        selectedModel: this.lastSystemCapabilities?.selectedModel || null,
      },
    };
  }

  removeFileIfPresent(filePath, context = 'runtime file') {
    if (!filePath || !fs.existsSync(filePath)) return false;
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (err) {
      log.warn('Supervisor', `Failed to remove ${context} ${filePath}: ${err.message}`);
      return false;
    }
  }

  cleanupStaleSupervisorRuntime(snapshot, reason = 'unknown') {
    const runtimeSnapshot = snapshot || this.readSupervisorRuntimeSnapshot();
    const cleaned = {
      pidFileRemoved: false,
      statusFileRemoved: false,
      processKilled: false,
    };

    if (runtimeSnapshot.pidAlive && runtimeSnapshot.pid) {
      try {
        process.kill(runtimeSnapshot.pid, 'SIGTERM');
        cleaned.processKilled = true;
      } catch (err) {
        log.warn(
          'Supervisor',
          `Failed to terminate stale supervisor pid ${runtimeSnapshot.pid} (${reason}): ${err.message}`
        );
      }
    }

    cleaned.pidFileRemoved = this.removeFileIfPresent(runtimeSnapshot.pidPath, 'supervisor pid file');
    cleaned.statusFileRemoved = this.removeFileIfPresent(
      runtimeSnapshot.statusPath,
      'supervisor status file'
    );
    return cleaned;
  }

  spawnSupervisorDaemon(reason = 'app-init') {
    const runtimePaths = this.getSupervisorRuntimePaths();
    if (!fs.existsSync(runtimePaths.daemonScriptPath)) {
      return { ok: false, reason: 'missing_supervisor_daemon_script' };
    }

    try {
      const { executable, env } = resolveSupervisorLaunchExecutable();
      const child = spawn(
        executable,
        [
          runtimePaths.daemonScriptPath,
          '--pid-path',
          runtimePaths.pidPath,
          '--status-path',
          runtimePaths.statusPath,
          '--log-path',
          runtimePaths.logPath,
        ],
        {
          cwd: getProjectRoot(),
          env,
          detached: true,
          windowsHide: true,
          stdio: 'ignore',
        }
      );
      if (child && typeof child.unref === 'function') {
        child.unref();
      }
      log.info(
        'Supervisor',
        `Spawned detached supervisor daemon via ${executable} (pid=${child?.pid || 'unknown'}, reason=${reason})`
      );
      return {
        ok: true,
        spawned: true,
        pid: asPositiveInt(child?.pid, null),
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'spawn_failed',
        error: err.message,
      };
    }
  }

  async ensureSupervisorDaemonRunning(reason = 'app-init') {
    if (this.supervisorBootstrapPromise) {
      return this.supervisorBootstrapPromise;
    }

    this.supervisorBootstrapPromise = (async () => {
      let snapshot = this.readSupervisorRuntimeSnapshot();
      if (!snapshot.daemonScriptExists) {
        return { ok: false, reason: 'missing_supervisor_daemon_script', snapshot };
      }

      if (snapshot.healthy) {
        return {
          ok: true,
          alreadyRunning: true,
          pid: snapshot.pid,
          snapshot,
        };
      }

      if (snapshot.stale) {
        log.warn(
          'Supervisor',
          `Found stale supervisor runtime (${snapshot.staleReasons.join(', ') || 'unknown'}); cleaning up before restart`
        );
        const cleaned = this.cleanupStaleSupervisorRuntime(snapshot, reason);
        snapshot = this.readSupervisorRuntimeSnapshot();
        if (snapshot.pidAlive) {
          return {
            ok: false,
            reason: 'stale_supervisor_still_running',
            snapshot,
            cleaned,
          };
        }
        return {
          ...this.spawnSupervisorDaemon(reason),
          cleaned,
          snapshot,
        };
      }

      if (snapshot.pidAlive) {
        log.warn(
          'Supervisor',
          `Supervisor pid ${snapshot.pid} is alive but status is incomplete; leaving existing process in place`
        );
        return {
          ok: true,
          alreadyRunning: true,
          partial: true,
          pid: snapshot.pid,
          snapshot,
        };
      }

      return this.spawnSupervisorDaemon(reason);
    })();

    try {
      return await this.supervisorBootstrapPromise;
    } finally {
      this.supervisorBootstrapPromise = null;
    }
  }

  forceKillDaemonFromPidFile() {
    if (!fs.existsSync(DAEMON_PID_FILE)) {
      return false;
    }

    const pidRaw = String(fs.readFileSync(DAEMON_PID_FILE, 'utf-8') || '').trim();
    if (!pidRaw) {
      return false;
    }

    try {
      if (process.platform === 'win32') {
        const child = spawn('taskkill', ['/pid', pidRaw, '/f', '/t'], {
          shell: true,
          detached: true,
          stdio: 'ignore',
        });
        if (child && typeof child.unref === 'function') {
          child.unref();
        }
      } else {
        const pid = Number.parseInt(pidRaw, 10);
        if (Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 'SIGTERM');
        }
      }
    } catch (err) {
      log.warn('Shutdown', `Failed to kill daemon from pid file: ${err.message}`);
    }

    try {
      fs.unlinkSync(DAEMON_PID_FILE);
    } catch (err) {
      log.warn('Shutdown', `Failed to remove daemon pid file: ${err.message}`);
    }
    return true;
  }

  async stopSupervisorFromPidFile(options = {}) {
    const waitMs = Math.max(250, Number(options.waitMs) || 4000);
    const pollMs = Math.max(50, Number(options.pollMs) || 100);
    const pidInfo = this.parseSupervisorPidPayload(this.readTextFileSafe(SUPERVISOR_PID_FILE, ''));
    const pid = asPositiveInt(pidInfo.pid, null);
    if (!pid) {
      return { ok: true, skipped: true, reason: 'missing_supervisor_pid' };
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      return {
        ok: false,
        reason: 'signal_failed',
        pid,
        error: err.message,
      };
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const pidAlive = this.isProcessAlive(pid);
      const pidFilePresent = fs.existsSync(SUPERVISOR_PID_FILE);
      if (!pidAlive && !pidFilePresent) {
        return {
          ok: true,
          pid,
          signal: 'SIGTERM',
          graceful: true,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const runtimeSnapshot = this.readSupervisorRuntimeSnapshot();
    const cleaned = this.cleanupStaleSupervisorRuntime(runtimeSnapshot, 'full-shutdown');
    return {
      ok: true,
      pid,
      signal: 'SIGTERM',
      graceful: false,
      cleaned,
    };
  }

  async performFullShutdown(reason = 'user-request') {
    if (this.fullShutdownPromise) {
      return this.fullShutdownPromise;
    }

    this.fullShutdownPromise = (async () => {
      log.info('Shutdown', `Initiating full shutdown (${reason})`);
      this.clearAllAgentResponseWatchdogs();

      if (this.ctx.daemonClient) {
        try {
          this.ctx.daemonClient.shutdown();
          log.info('Shutdown', 'Sent shutdown to daemon');
        } catch (err) {
          log.warn('Shutdown', `Failed requesting daemon shutdown: ${err.message}`);
        }
      }

      this.forceKillDaemonFromPidFile();

      try {
        await this.shutdown();
      } catch (err) {
        log.warn('Shutdown', `App cleanup reported an error: ${err.message}`);
      }

      const supervisorStopResult = await this.stopSupervisorFromPidFile();
      if (supervisorStopResult?.ok === false && supervisorStopResult?.skipped !== true) {
        log.warn(
          'Shutdown',
          `Supervisor stop reported ${supervisorStopResult.reason || 'unknown'}`
          + `${supervisorStopResult.error ? `: ${supervisorStopResult.error}` : ''}`
        );
      }

      app.exit(0);
      return { success: true, supervisorStopResult };
    })();

    try {
      return await this.fullShutdownPromise;
    } finally {
      this.fullShutdownPromise = null;
    }
  }

  transitionRuntimeLifecycle(nextState, reason = 'unspecified') {
    const currentState = this.runtimeLifecycleState;
    if (currentState === nextState) return true;
    const allowed = ALLOWED_RUNTIME_LIFECYCLE_TRANSITIONS[currentState];
    if (!allowed || !allowed.has(nextState)) {
      log.warn(
        'RuntimeLifecycle',
        `Illegal transition ${currentState} -> ${nextState} (${reason})`
      );
      return false;
    }
    this.runtimeLifecycleState = nextState;
    log.info('RuntimeLifecycle', `Transition ${currentState} -> ${nextState} (${reason})`);
    return true;
  }

  queueRuntimeLifecycleTask(taskName, taskFn) {
    const run = async () => taskFn(taskName);
    this.runtimeLifecycleQueue = this.runtimeLifecycleQueue.then(run, run);
    return this.runtimeLifecycleQueue;
  }

  async startRuntimeServices(reason = 'manual-start') {
    return this.queueRuntimeLifecycleTask('start', async () => {
      if (this.runtimeLifecycleState === RUNTIME_LIFECYCLE_STATE.RUNNING) {
        log.warn('RuntimeLifecycle', `Start ignored while already running (${reason})`);
        return { ok: true, state: this.runtimeLifecycleState, alreadyRunning: true };
      }
      if (!this.transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.STARTING, reason)) {
        return { ok: false, state: this.runtimeLifecycleState, reason: 'illegal_transition' };
      }

      try {
        watcher.startWatcher();
        watcher.startTriggerWatcher();
        const messageWatcherStart = await watcher.startMessageWatcher();
        if (!messageWatcherStart || messageWatcherStart.success !== true) {
          throw new Error(
            messageWatcherStart?.error || messageWatcherStart?.reason || 'message_watcher_start_failed'
          );
        }
        this.transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.RUNNING, reason);
        return { ok: true, state: this.runtimeLifecycleState };
      } catch (err) {
        try {
          watcher.stopMessageWatcher();
        } catch (stopErr) {
          log.warn('RuntimeLifecycle', `Failed stopping message watcher after start error: ${stopErr.message}`);
        }
        try {
          watcher.stopTriggerWatcher();
        } catch (stopErr) {
          log.warn('RuntimeLifecycle', `Failed stopping trigger watcher after start error: ${stopErr.message}`);
        }
        try {
          watcher.stopWatcher();
        } catch (stopErr) {
          log.warn('RuntimeLifecycle', `Failed stopping workspace watcher after start error: ${stopErr.message}`);
        }
        this.transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.STOPPED, `${reason}:start-error`);
        return { ok: false, state: this.runtimeLifecycleState, error: err.message };
      }
    });
  }

  async stopRuntimeServices(reason = 'manual-stop') {
    return this.queueRuntimeLifecycleTask('stop', async () => {
      const forceStop = reason === 'shutdown';
      if (this.runtimeLifecycleState === RUNTIME_LIFECYCLE_STATE.STOPPED) {
        if (!forceStop) {
          log.warn('RuntimeLifecycle', `Stop ignored while already stopped (${reason})`);
          return { ok: true, state: this.runtimeLifecycleState, alreadyStopped: true };
        }
        watcher.stopMessageWatcher();
        watcher.stopTriggerWatcher();
        watcher.stopWatcher();
        return { ok: true, state: this.runtimeLifecycleState, alreadyStopped: true, forced: true };
      }
      if (!this.transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.STOPPING, reason)) {
        return { ok: false, state: this.runtimeLifecycleState, reason: 'illegal_transition' };
      }

      try {
        watcher.stopMessageWatcher();
        watcher.stopTriggerWatcher();
        watcher.stopWatcher();
        this.transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.STOPPED, reason);
        return { ok: true, state: this.runtimeLifecycleState };
      } catch (err) {
        this.transitionRuntimeLifecycle(RUNTIME_LIFECYCLE_STATE.STOPPED, `${reason}:stop-error`);
        return { ok: false, state: this.runtimeLifecycleState, error: err.message };
      }
    });
  }

  async initPostLoad() {
    const window = this.ctx.mainWindow;

    const initAfterLoad = async (attempt = 1) => {
      try {
        const lifecycleResult = await this.startRuntimeServices('post-load-init');
        if (!lifecycleResult?.ok) {
          throw new Error(lifecycleResult?.error || lifecycleResult?.reason || 'runtime_start_failed');
        }

        const state = watcher.readState();
        if (window && !window.isDestroyed()) {
          window.webContents.send('state-changed', state);
        }

        if (this.daemonTimeoutTriggered && !this.daemonConnectedForStartup) {
          this.notifyRendererDaemonTimeout('daemon_connect_timeout_replay');
        }

        // Connect if not already connected, or resend state if already connected
        if (this.ctx.daemonClient) {
          if (!this.ctx.daemonClient.connected) {
            await this.ctx.daemonClient.connect();
          } else {
            // Daemon already connected before renderer loaded - resend the event
            log.info('App', 'Resending daemon-connected to renderer (was connected before load)');
            const terminals = this.ctx.daemonClient.getTerminals?.() || [];
            this.daemonConnectedForStartup = true;
            this.clearDaemonConnectTimeout();
            this.sendToAllWindows('daemon-connected', {
              terminals
            });
            this.primePaneHostFromTerminalSnapshot(terminals);
            this.kernelBridge.emitBridgeEvent('bridge.connected', {
              transport: 'daemon-client',
              terminalCount: terminals.length,
              resumed: true,
            });
          }
        }
        await this.flushPendingPaneDeliveries({ reason: 'renderer_post_load' });
      } catch (err) {
        log.error('App', 'Post-load init failed', err);
        this.activity.logActivity('error', null, 'Post-load init failed', {
          attempt,
          error: err.message,
        });

        if (attempt < 3) {
          const delay = Math.min(2000 * attempt, 10000);
          setTimeout(() => initAfterLoad(attempt + 1), delay);
        }
      }
    };

    initAfterLoad();
  }

  initRecoveryManager() {
    return createRecoveryManager({
      getSettings: () => this.ctx.currentSettings,
      getLastActivity: paneId => this.ctx.daemonClient?.getLastActivity?.(paneId),
      getAllActivity: () => this.ctx.daemonClient?.getAllActivity?.() || {},
      getDaemonTerminals: () => this.ctx.daemonClient?.getTerminals?.() || [],
      isPaneRunning: paneId => this.ctx.agentRunning.get(String(paneId)) === 'running',
      isCodexPane: paneId => {
        const cmd = this.ctx.currentSettings.paneCommands?.[String(paneId)] || '';
        return cmd.includes('codex');
      },
      requestRestart: (paneId, info = {}) => {
        if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
          this.ctx.mainWindow.webContents.send('restart-pane', {
            paneId: String(paneId),
            source: 'recovery',
            ...info,
          });
        }
      },
      requestUnstick: (paneId, info = {}) => {
        if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
          this.ctx.mainWindow.webContents.send('unstick-pane', {
            paneId: String(paneId),
            source: 'recovery',
            ...info,
          });
        }
      },
      beforeRestart: async (paneId, reason) => {
        if (this.ctx.daemonClient?.connected) {
          this.ctx.daemonClient.saveSession();
        }
        this.activity.logActivity('recovery', String(paneId), `Auto-restart requested (${reason})`, { reason }); 
      },
      resendTask: (paneId, message, meta = {}) => {
        if (triggers && typeof triggers.sendDirectMessage === 'function') {
          const recoveryMessage = `[RECOVERY] Resuming previous task\n${message}`;
          const result = triggers.sendDirectMessage([String(paneId)], recoveryMessage, 'Self-Healing');
          return Boolean(result && result.success);
        }
        return this.routeInjectMessage({
          panes: [String(paneId)],
          message: `[RECOVERY] Resuming previous task\n${message}\r`,
          meta,
        });
      },
      notifyEvent: (payload) => {
        const paneId = payload?.paneId ? String(payload.paneId) : 'system';
        this.activity.logActivity('recovery', paneId, payload?.message || 'Recovery event', payload);
        if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
          this.ctx.mainWindow.webContents.send('recovery-event', payload);
        }
      },
    });
  }

  initPluginManager() {
    return createPluginManager({
      workspacePath: WORKSPACE_PATH,
      getSettings: () => this.ctx.currentSettings,
      getState: () => watcher?.readState?.() || null,
      notifyAgents: (targets, message) => triggers.notifyAgents(targets, message),
      sendDirectMessage: (targets, message, fromRole) => triggers.sendDirectMessage(targets, message, fromRole), 

      broadcastMessage: (message) => triggers.broadcastToAllAgents(message),
      logActivity: (t, p, m, d) => this.activity.logActivity(t, p, m, d),
      getMainWindow: () => this.ctx.mainWindow,
    });
  }

  initBackupManager() {
    const manager = createBackupManager({
      workspacePath: WORKSPACE_PATH,
      repoRoot: path.join(WORKSPACE_PATH, '..'),
      logActivity: (t, p, m, d) => this.activity.logActivity(t, p, m, d),
    });
    manager.init();
    return manager;
  }

  clearDaemonClientListeners(client = this.ctx.daemonClient) {
    if (!client || this.daemonClientListeners.length === 0) {
      return;
    }

    const removeListener = typeof client.off === 'function'
      ? client.off.bind(client)
      : (typeof client.removeListener === 'function' ? client.removeListener.bind(client) : null);

    if (typeof removeListener !== 'function') {
      this.daemonClientListeners = [];
      return;
    }

    for (const { eventName, listener } of this.daemonClientListeners) {
      try {
        removeListener(eventName, listener);
      } catch (err) {
        log.warn('Daemon', `Failed removing listener ${eventName}: ${err.message}`);
      }
    }

    this.daemonClientListeners = [];
  }

  attachDaemonClientListener(eventName, listener) {
    if (!this.ctx.daemonClient || typeof this.ctx.daemonClient.on !== 'function') {
      return;
    }
    this.ctx.daemonClient.on(eventName, listener);
    this.daemonClientListeners.push({ eventName, listener });
  }

  async initDaemonClient() {
    this.clearDaemonConnectTimeout();
    this.daemonConnectedForStartup = false;
    this.daemonTimeoutTriggered = false;
    this.daemonTimeoutNotified = false;

    // Re-inits happen on reload; clear previously attached singleton listeners first.
    this.clearDaemonClientListeners(this.ctx.daemonClient);
    this.ctx.daemonClient = getDaemonClient();

    // Update IPC handlers with daemon client
    ipcHandlers.setDaemonClient(this.ctx.daemonClient);

    const handlePaneExit = (paneId, code) => {
      if (this.backgroundAgentManager.isBackgroundPaneId(paneId)) {
        return;
      }
      this.flushBufferedPtyData(paneId);
      this.flushVisibleFilteredPtyData(paneId, { force: true });
      this.visiblePtyOutputFilter.clearPane(paneId);
      this.ctx.recoveryManager?.handleExit(paneId, code);
      this.usage.recordSessionEnd(paneId);
      this.recordSessionLifecyclePattern({
        paneId,
        status: 'ended',
        exitCode: code,
        reason: 'pty_exit',
      }).catch((err) => {
        log.warn('TeamMemory', `Failed session end event for pane ${paneId}: ${err.message}`);
      });
      this.ctx.agentRunning.set(paneId, 'idle');
      organicUI.agentOffline(paneId);
      this.ctx.pluginManager?.dispatch('agent:stateChanged', { paneId: String(paneId), state: 'idle', exitCode: code })
        .catch(err => log.error('Plugins', `Error in agent:stateChanged hook: ${err.message}`));
      this.broadcastClaudeState();
      this.activity.logActivity('state', paneId, `Session ended (exit code: ${code})`, { exitCode: code });
      this.sendToVisibleWindow(`pty-exit-${paneId}`, code);
      if (this.isHiddenPaneHostModeEnabled()) {
        this.paneHostWindowManager.sendToPaneWindow(String(paneId), `pty-exit-${paneId}`, code);
      }
    };

    this.attachDaemonClientListener('data', (paneId, data) => {
      this.lastDaemonOutputAtMs = Date.now();
      const isBackgroundPane = this.backgroundAgentManager.isBackgroundPaneId(paneId);
      this.backgroundAgentManager.handleDaemonData(paneId, data);
      if (isBackgroundPane) {
        return;
      }

      this.ctx.recoveryManager?.recordActivity(paneId);
      this.ctx.recoveryManager?.recordPtyOutput?.(paneId, data);

      // Organic UI: Mark agent as active when outputting
      if (organicUI.getAgentState(paneId) !== 'offline') {
        organicUI.agentActive(paneId);
      }

      if (this.ctx.pluginManager?.hasHook('daemon:data')) {
        this.ctx.pluginManager.dispatch('daemon:data', { paneId: String(paneId), data })
          .catch(err => log.error('Plugins', `Error in daemon:data hook: ${err.message}`));
      }

      this.queuePtyDataForUi(paneId, data);

      if (data.includes('Error') || data.includes('error:') || data.includes('FAILED')) {
        this.activity.logActivity('error', paneId, 'Terminal error detected', { snippet: data.substring(0, 200) }
);
      } else if (data.includes('✅') || data.includes('DONE') || data.includes('Complete')) {
        this.activity.logActivity('terminal', paneId, 'Completion indicator detected', { snippet: data.substring(
0, 100) });
      }

      const currentState = this.ctx.agentRunning.get(paneId);
      if (currentState === 'starting' || currentState === 'idle') {
        const runningPaneId = String(paneId);
        const nextBuffer = `${this.startupReadyBuffers.get(runningPaneId) || ''}${stripAnsiForStartupReady(data)}`.slice(-STARTUP_READY_BUFFER_MAX);
        this.startupReadyBuffers.set(runningPaneId, nextBuffer);
        if (hasCliStartupReadySignal(nextBuffer)) {
          this.startupReadyBuffers.delete(runningPaneId);
          this.ctx.agentRunning.set(paneId, 'running');
          organicUI.agentOnline(paneId);
          this.ctx.pluginManager?.dispatch('agent:stateChanged', { paneId: runningPaneId, state: 'running' })
            .catch(err => log.error('Plugins', `Error in agent:stateChanged hook: ${err.message}`));
          this.broadcastClaudeState();
          this.activity.logActivity('state', paneId, 'Agent started', { status: 'running' });
          log.info('Agent', `Pane ${paneId} now running`);
          this.triggerProactiveMemoryInjection({
            paneId: runningPaneId,
            triggerType: 'session_rollover',
            payload: {
              session_id: this.commsSessionScopeId || null,
              session_ordinal: this.getCurrentAppStatusSessionNumber(),
              trigger_event_id: `session-rollover:${runningPaneId}:${this.commsSessionScopeId || 'app'}`,
              nowMs: Date.now(),
            },
          }).catch((err) => {
            log.warn('TeamMemory', `Failed session rollover memory injection for pane ${runningPaneId}: ${err.message}`);
          });
        }
      }
    });

    this.attachDaemonClientListener('exit', (paneId, code) => {
      this.startupReadyBuffers.delete(String(paneId));
      this.backgroundAgentManager.handleDaemonExit(paneId, code);
      handlePaneExit(paneId, code);
    });

    this.attachDaemonClientListener('killed', (paneId) => {
      this.startupReadyBuffers.delete(String(paneId));
      this.backgroundAgentManager.handleDaemonKilled(paneId);
      if (String(paneId) === BACKGROUND_BUILDER_OWNER_PANE_ID) {
        this.ctx.agentRunning.set(String(paneId), 'idle');
      }
    });

    this.attachDaemonClientListener('spawned', (paneId, pid) => {
      log.info('Daemon', `Terminal spawned for pane ${paneId}, PID: ${pid}`);
      if (this.backgroundAgentManager.isBackgroundPaneId(paneId)) {
        return;
      }
      const command = this.cliIdentity.getPaneCommandForIdentity(String(paneId));
      this.cliIdentity.inferAndEmitCliIdentity(paneId, command);
      this.ctx.recoveryManager?.recordActivity(paneId);
    });

    this.attachDaemonClientListener('connected', (terminals) => {
      log.info('Daemon', `Connected. Existing terminals: ${terminals.length}`);
      this.daemonConnectedForStartup = true;
      this.clearDaemonConnectTimeout();
      this.backgroundAgentManager.syncWithDaemonTerminals(terminals);

      if (terminals && terminals.length > 0) {
        for (const term of terminals) {
          if (this.backgroundAgentManager.isBackgroundPaneId(term?.paneId)) {
            continue;
          }
          if (term.alive) {
            // Refine: Check if terminal actually has CLI content
            // Simple check here as we don't want to duplicate all regexes from daemon-handlers
            const scrollback = String(term.scrollback || '').toLowerCase();
            const hasCli = scrollback.includes('claude code') || 
                           scrollback.includes('codex>') || 
                           scrollback.includes('gemini cli') ||
                           scrollback.includes('cursor>') ||
                           (scrollback.includes('>') && scrollback.length > 200);

            if (hasCli) {
              this.ctx.agentRunning.set(String(term.paneId), 'running');
              organicUI.agentOnline(String(term.paneId));
            } else {
              this.ctx.agentRunning.set(String(term.paneId), 'idle');
              organicUI.agentOffline(String(term.paneId));
            }
            
            const command = this.cliIdentity.getPaneCommandForIdentity(String(term.paneId));   
            this.cliIdentity.inferAndEmitCliIdentity(term.paneId, command);
          }
        }
        this.broadcastClaudeState();
      }
      if (terminals && terminals.length > 0) {
        const deadTerminals = terminals.filter(term => term.alive === false);
        for (const term of deadTerminals) {
          const paneId = String(term.paneId);
          log.warn('Daemon', `Detected dead terminal for pane ${paneId} on connect - scheduling recovery`);
          handlePaneExit(paneId, -1);
        }
      }
      this.sendToAllWindows('daemon-connected', { terminals });
      this.primePaneHostFromTerminalSnapshot(terminals);

      this.kernelBridge.emitBridgeEvent('bridge.connected', {
        transport: 'daemon-client',
        terminalCount: terminals?.length || 0,
      });
    });

    this.attachDaemonClientListener('disconnected', () => {
      log.warn('Daemon', 'Disconnected');
      void this.backgroundAgentManager.killAll({ reason: 'daemon_disconnected' });
      this.sendToAllWindows('daemon-disconnected');
      this.kernelBridge.emitBridgeEvent('bridge.disconnected', {
        transport: 'daemon-client',
      });
    });

    this.attachDaemonClientListener('reconnected', () => {
      this.sendToAllWindows('daemon-reconnected');
      this.kernelBridge.emitBridgeEvent('bridge.connected', {
        transport: 'daemon-client',
        resumed: true,
      });
    });

    this.attachDaemonClientListener('kernel-event', (eventData) => {
      this.handlePtyDataKernelEvent(eventData);
      this.kernelBridge.forwardDaemonEvent(eventData);
    });

    this.attachDaemonClientListener('kernel-stats', (stats) => {
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        try {
          this.ctx.mainWindow.webContents.send('kernel:bridge-stats', {
            source: 'daemon',
            ...stats,
          });
        } catch (err) {
          log.warn('KernelBridge', `Failed forwarding daemon kernel stats: ${err.message}`);
        }
      }
    });

    this.attachDaemonClientListener('heartbeat-state-changed', (state, interval) => {
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('heartbeat-state-changed', { state, interval });
      }
    });

    this.attachDaemonClientListener('watchdog-alert', (message, timestamp) => {
      log.warn('Watchdog', `Alert: ${message}`);
      if (this.ctx.externalNotifier && typeof this.ctx.externalNotifier.notify === 'function') {
        this.ctx.externalNotifier.notify({
          category: 'alert',
          title: 'Watchdog alert',
          message,
          meta: { timestamp },
        }).catch(err => log.error('Notifier', `Failed to send watchdog alert: ${err.message}`));
      }
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('watchdog-alert', { message, timestamp });
      }
    });

    this.attachDaemonClientListener('codex-activity', (paneId, state, detail) => {
      if (this.ctx.pluginManager?.hasHook('agent:activity')) {
        this.ctx.pluginManager.dispatch('agent:activity', { paneId: String(paneId), state, detail })
          .catch(err => log.error('Plugins', `Error in agent:activity hook: ${err.message}`));
      }
    });

    this.attachDaemonClientListener('agent-stuck-detected', (payload) => {
      const paneId = payload?.paneId;
      if (!paneId) return;
      const idleTime = payload?.idleMs || 0;
      this.ctx.recoveryManager?.handleStuck(paneId, idleTime, 'daemon-auto-nudge');

      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('agent-stuck-detected', {
          paneId,
          idleTime,
          message: payload?.message || `Agent in pane ${paneId} appears stuck.`,
        });
      }
    });

    this.attachDaemonClientListener('error', (paneId, message) => {
      log.error('Daemon', `Error in pane ${paneId}:`, message);
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send(`pty-error-${paneId}`, message);
      }
    });

    const connected = await this.ctx.daemonClient.connect();
    if (connected) {
      this.daemonConnectedForStartup = true;
      this.clearDaemonConnectTimeout();
    }
    return connected;
  }

  broadcastClaudeState() {
    if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
      this.ctx.mainWindow.webContents.send('claude-state-changed', Object.fromEntries(this.ctx.agentRunning));  
    }
  }

  ensureCliIdentityForwarder() {
    if (this.cliIdentityForwarderRegistered) return;
    this.cliIdentityForwarderRegistered = true;
    ipcMain.on('pane-cli-identity', (event, data) => this.cliIdentity.emitPaneCliIdentity(data));
  }

  ensureTriggerDeliveryAckForwarder() {
    if (this.triggerAckForwarderRegistered) return;
    this.triggerAckForwarderRegistered = true;
    ipcMain.on('trigger-delivery-ack', (event, data) => {
      this.handleTriggerDeliveryAck(data);
    });
    ipcMain.on('trigger-delivery-outcome', (event, data) => {
      this.handleTriggerDeliveryOutcome(data);
    });
  }

  ensureDeferredTeamMemoryStartup() {
    if (this.teamMemoryDeferredStartupStarted) return;
    this.teamMemoryDeferredStartupStarted = true;
    this._deferredTeamMemoryStartup().catch((err) => {
      log.warn('TeamMemory', `Deferred startup failed: ${err.message}`);
    });
  }

  async ensureTeamMemoryInitialized(reason = 'first-use') {
    if (this.teamMemoryInitialized) {
      this.ensureDeferredTeamMemoryStartup();
      return true;
    }
    if (this.teamMemoryInitFailed) {
      return false;
    }
    if (this.teamMemoryInitPromise) {
      return this.teamMemoryInitPromise;
    }

    this.teamMemoryInitPromise = (async () => {
      try {
        const result = await teamMemory.initializeTeamMemoryRuntime({
          runtimeOptions: {},
          recreateUnavailable: true,
        });
        this.teamMemoryInitialized = result?.ok === true;
        this.teamMemoryInitFailed = !this.teamMemoryInitialized;
        if (this.teamMemoryInitialized) {
          this.ensureDeferredTeamMemoryStartup();
          log.info('TeamMemory', `Lazy initialization ready (trigger=${reason})`);
          return true;
        }
        log.warn(
          'TeamMemory',
          `Lazy initialization degraded (trigger=${reason}): ${result?.status?.degradedReason || result?.initResult?.reason || 'unavailable'}`
        );
        return false;
      } catch (err) {
        this.teamMemoryInitialized = false;
        this.teamMemoryInitFailed = true;
        log.warn('TeamMemory', `Lazy initialization failed (trigger=${reason}): ${err.message}`);
        return false;
      } finally {
        this.teamMemoryInitPromise = null;
      }
    })();

    return this.teamMemoryInitPromise;
  }

  async ensureExperimentInitialized(reason = 'first-use') {
    if (this.experimentInitialized) {
      return true;
    }
    if (this.experimentInitFailed) {
      return false;
    }
    if (this.experimentInitPromise) {
      return this.experimentInitPromise;
    }

    this.experimentInitPromise = (async () => {
      try {
        const result = await experiment.initializeExperimentRuntime({
          runtimeOptions: {},
          recreateUnavailable: true,
        });
        this.experimentInitialized = result?.ok === true;
        this.experimentInitFailed = !this.experimentInitialized;
        if (this.experimentInitialized) {
          log.info('Experiment', `Lazy initialization ready (trigger=${reason})`);
          return true;
        }
        log.warn(
          'Experiment',
          `Lazy initialization degraded (trigger=${reason}): ${result?.status?.degradedReason || result?.initResult?.reason || 'unavailable'}`
        );
        return false;
      } catch (err) {
        this.experimentInitialized = false;
        this.experimentInitFailed = true;
        log.warn('Experiment', `Lazy initialization failed (trigger=${reason}): ${err.message}`);
        return false;
      } finally {
        this.experimentInitPromise = null;
      }
    })();

    return this.experimentInitPromise;
  }

  async appendTeamMemoryPatternEvent(event, label = 'pattern-event') {
    if (!event) {
      return { ok: false, reason: 'team_memory_unavailable' };
    }
    const ready = await this.ensureTeamMemoryInitialized(`append:${label}`);
    if (!ready) {
      return { ok: false, reason: 'team_memory_unavailable' };
    }
    try {
      const result = await teamMemory.appendPatternHookEvent(event);
      if (result?.ok === false) {
        log.warn('TeamMemory', `Failed to append ${label}: ${result.reason || 'unknown'}`);
      }
      return result;
    } catch (err) {
      log.warn('TeamMemory', `Failed to append ${label}: ${err.message}`);
      return { ok: false, reason: 'pattern_append_failed', error: err.message };
    }
  }

  async evaluateTeamMemoryGuardPreflight({ target, content, fromRole, traceContext } = {}) {
    const ready = await this.ensureTeamMemoryInitialized('guard-preflight');
    if (!ready) {
      return { blocked: false, actions: [] };
    }

    const nowMs = Date.now();
    const event = buildGuardPreflightEvent({
      target,
      content,
      fromRole,
      traceContext,
      nowMs,
    });

    let evaluation = null;
    try {
      evaluation = await teamMemory.executeTeamMemoryOperation('evaluate-guards', {
        events: [event],
        nowMs,
      });
    } catch (err) {
      log.warn('TeamMemoryGuard', `Preflight evaluation failed: ${err.message}`);
      return { blocked: false, actions: [] };
    }

    if (!evaluation?.ok) {
      return { blocked: false, actions: [] };
    }

    const actions = Array.isArray(evaluation.actions) ? evaluation.actions : [];
    for (const action of actions) {
      const actionEvent = {
        ...action,
        event: {
          ...(action?.event && typeof action.event === 'object' ? action.event : {}),
          target: target || null,
          status: 'preflight',
        },
      };
      await this.appendTeamMemoryPatternEvent(
        buildGuardFiringPatternEvent(actionEvent, nowMs),
        'guard-preflight'
      );
    }

    return {
      blocked: Boolean(evaluation.blocked),
      actions,
    };
  }

  async recordSessionLifecyclePattern({ paneId, status, exitCode = null, reason = '' } = {}) {
    const ready = await this.ensureTeamMemoryInitialized('session-lifecycle');
    if (!ready) return;
    const nowMs = Date.now();
    const event = buildSessionLifecyclePatternEvent({
      paneId,
      status,
      exitCode,
      reason,
      nowMs,
    });
    if (!event) return;
    await this.appendTeamMemoryPatternEvent(event, 'session-lifecycle');
  }

  async triggerProactiveMemoryInjection({ paneId, triggerType, payload = {}, explicit = false } = {}) {
    const ready = await this.ensureTeamMemoryInitialized(`memory-injection:${triggerType || 'unknown'}`);
    if (!ready) {
      return { ok: false, reason: 'team_memory_unavailable' };
    }

    const targetPane = String(paneId || payload?.pane_id || payload?.paneId || '1');
    const nowMs = Date.now();
    const sessionOrdinal = payload?.session_ordinal || payload?.sessionOrdinal || this.getCurrentAppStatusSessionNumber();
    let lifecycleAdvance = null;
    let staleReview = null;
    if (triggerType === 'session_rollover') {
      lifecycleAdvance = await teamMemory.executeTeamMemoryOperation('advance-memory-lifecycle', {
        session_ordinal: sessionOrdinal,
        nowMs,
      });
      staleReview = await teamMemory.executeTeamMemoryOperation('review-stale-memories', {
        limit: 10,
        nowMs,
      });
    }
    const result = await teamMemory.executeTeamMemoryOperation('trigger-memory-injection', {
      ...payload,
      pane_id: targetPane,
      session_id: payload?.session_id || payload?.sessionId || this.commsSessionScopeId || null,
      session_ordinal: sessionOrdinal,
      trigger_type: triggerType,
      explicit,
      nowMs,
    });
    if (!result?.ok || result.injected !== true || !result.injection?.message) {
      return {
        ...result,
        lifecycleAdvance,
        staleReview,
      };
    }

    const routed = this.routeInjectMessage({
      panes: [targetPane],
      message: `${result.injection.message}\r`,
      deliveryId: result.injection.injection_id || null,
      meta: {
        memoryInjection: true,
        triggerType,
        sourceTier: result.injection.source_tier || null,
        injectionReason: result.injection.injection_reason || null,
        authoritative: result.injection.authoritative === true,
      },
    });

    return {
      ...result,
      lifecycleAdvance,
      staleReview,
      delivered: routed === true,
    };
  }

  async recordMemoryInjectionFeedback(payload = {}) {
    const ready = await this.ensureTeamMemoryInitialized('memory-injection-feedback');
    if (!ready) {
      return { ok: false, reason: 'team_memory_unavailable' };
    }
    return teamMemory.executeTeamMemoryOperation('record-memory-injection-feedback', {
      ...payload,
      nowMs: payload?.nowMs || Date.now(),
    });
  }

  async sendCrossDeviceHandoffPacket({ targetDevice, paneId = '1', payload = {} } = {}) {
    const ready = await this.ensureTeamMemoryInitialized('cross-device-handoff-send');
    if (!ready) {
      return { ok: false, reason: 'team_memory_unavailable' };
    }

    const buildResult = await teamMemory.executeTeamMemoryOperation('build-cross-device-handoff', {
      ...payload,
      pane_id: String(paneId),
      target_device: targetDevice,
      source_device: this.bridgeDeviceId || getLocalDeviceId(process.env) || 'LOCAL',
      session_id: payload?.session_id || payload?.sessionId || this.commsSessionScopeId || null,
      session_ordinal: payload?.session_ordinal || payload?.sessionOrdinal || this.getCurrentAppStatusSessionNumber(),
      nowMs: payload?.nowMs || Date.now(),
    });
    if (!buildResult?.ok) {
      return buildResult;
    }

    const outboundText = [
      `Cross-device handoff from ${buildResult.packet?.source_device || this.bridgeDeviceId || 'LOCAL'}`,
      Array.isArray(buildResult.packet?.active_workstreams) && buildResult.packet.active_workstreams.length > 0
        ? `Workstreams: ${buildResult.packet.active_workstreams.join(' | ')}`
        : 'Workstreams: none listed',
    ].join('\n');
    const relayResult = await this.routeBridgeMessage({
      targetDevice,
      content: outboundText,
      fromRole: 'architect',
      messageId: `handoff-${buildResult.packet_id}`,
      structuredMessage: {
        type: 'handoffpacket',
        payload: {
          packet: buildResult.packet,
        },
      },
    });
    if (relayResult?.ok) {
      await teamMemory.executeTeamMemoryOperation('mark-cross-device-handoff-sent', {
        packet_id: buildResult.packet_id,
        sent_at: Date.now(),
        packet_json: buildResult.packet,
      });
    }
    return {
      ...relayResult,
      packet_id: buildResult.packet_id,
      packet: buildResult.packet,
      result_refs: buildResult.result_refs || [],
    };
  }

  async handleInboundHandoffPacket(packet = {}, options = {}) {
    const ready = await this.ensureTeamMemoryInitialized('cross-device-handoff-receive');
    if (!ready) {
      return { ok: false, reason: 'team_memory_unavailable' };
    }
    return teamMemory.executeTeamMemoryOperation('receive-cross-device-handoff', {
      packet,
      pane_id: options?.paneId || '1',
      nowMs: options?.nowMs || Date.now(),
    });
  }

  async prepareCompactionSurvivalForPane({ paneId = '1', payload = {} } = {}) {
    const ready = await this.ensureTeamMemoryInitialized('compaction-survival-prepare');
    if (!ready) {
      return { ok: false, reason: 'team_memory_unavailable' };
    }
    return teamMemory.executeTeamMemoryOperation('prepare-compaction-survival', {
      ...payload,
      pane_id: String(paneId),
      session_id: payload?.session_id || payload?.sessionId || this.commsSessionScopeId || null,
      project_root: typeof getProjectRoot === 'function' ? (getProjectRoot() || undefined) : undefined,
      nowMs: payload?.nowMs || Date.now(),
    });
  }

  async resumeCompactionSurvivalForPane({ paneId = '1', payload = {} } = {}) {
    const ready = await this.ensureTeamMemoryInitialized('compaction-survival-resume');
    if (!ready) {
      return { ok: false, reason: 'team_memory_unavailable' };
    }

    const result = await teamMemory.executeTeamMemoryOperation('resume-compaction-survival', {
      ...payload,
      pane_id: String(paneId),
      session_id: payload?.session_id || payload?.sessionId || this.commsSessionScopeId || null,
      project_root: typeof getProjectRoot === 'function' ? (getProjectRoot() || undefined) : undefined,
      nowMs: payload?.nowMs || Date.now(),
    });
    if (result?.ok && result?.resumed === true && result?.injection?.message) {
      this.routeInjectMessage({
        panes: [String(paneId)],
        message: `${result.injection.message}\r`,
        meta: {
          memoryInjection: true,
          triggerType: 'compaction_survival_resume',
          sourceTier: 'tier4',
          injectionReason: 'compaction_resume',
          authoritative: true,
        },
      });
    }
    return result;
  }

  async recordDeliveryOutcomePattern({ channel, target, fromRole, result, traceContext } = {}) {
    const ready = await this.ensureTeamMemoryInitialized('delivery-outcome');
    if (!ready) return;
    const nowMs = Date.now();

    await this.appendTeamMemoryPatternEvent(
      buildDeliveryOutcomePatternEvent({
        channel,
        target,
        fromRole,
        result,
        traceContext,
        nowMs,
      }),
      'delivery-outcome'
    );

    if (!isDeliveryFailureResult(result)) return;
    await this.appendTeamMemoryPatternEvent(
      buildDeliveryFailurePatternEvent({
        channel,
        target,
        fromRole,
        result,
        traceContext,
        nowMs,
      }),
      'delivery-failure'
    );
  }

  getCommsJournalFinalDeliveryState(result = {}) {
    const accepted = result?.accepted === true || result?.verified === true;
    const verified = result?.verified === true;
    const ackStatus = toNonEmptyString(result?.status)
      || (verified ? 'delivered.verified' : (accepted ? 'accepted.unverified' : 'delivery_failed'));
    const errorCode = accepted
      ? null
      : (
        toNonEmptyString(result?.error)
        || toNonEmptyString(result?.reason)
        || toNonEmptyString(result?.status)
        || toNonEmptyString(result?.details?.error)
        || toNonEmptyString(result?.details?.failureReason)
        || 'delivery_failed'
      );

    return {
      status: verified ? 'acked' : (accepted ? 'routed' : 'failed'),
      ackStatus,
      errorCode,
      accepted,
      verified,
    };
  }

  async finalizeLocalTriggerDeliveryJournal({
    messageId = null,
    result = null,
    paneId = null,
    target = null,
    senderRole = null,
    traceContext = null,
    routeKind = 'local',
  } = {}) {
    const normalizedMessageId = toNonEmptyString(messageId);
    if (!normalizedMessageId || !result) return null;

    const finalState = this.getCommsJournalFinalDeliveryState(result);
    const journalResult = await executeEvidenceLedgerOperation(
      'upsert-comms-journal',
      {
        messageId: normalizedMessageId,
        senderRole: senderRole || null,
        targetRole: target || null,
        channel: 'ws',
        direction: 'outbound',
        status: finalState.status,
        ackStatus: finalState.ackStatus,
        errorCode: finalState.errorCode,
        metadata: {
          source: 'websocket-local-trigger-delivery',
          routeKind,
          paneId: paneId ? String(paneId) : null,
          targetRaw: target || null,
          traceId: traceContext?.traceId || traceContext?.correlationId || null,
          deliveryId: result?.deliveryId || null,
          deliveryMode: result?.mode || null,
          deliveryAccepted: finalState.accepted,
          deliveryVerified: finalState.verified,
          finalOutcome: finalState.ackStatus,
          failureReason: toNonEmptyString(result?.reason) || toNonEmptyString(result?.details?.failureReason),
          notified: Array.isArray(result?.notified) ? result.notified : [],
        },
      },
      {
        source: {
          via: 'websocket',
          role: senderRole || 'system',
          paneId: paneId ? String(paneId) : null,
        },
      }
    );

    if (journalResult?.ok === false) {
      log.warn('EvidenceLedger', `Comms journal delivery finalization failed: ${journalResult.reason || 'unknown'}`);
    }

    return journalResult;
  }

  clearAgentResponseWatchdog(senderRole = null, targetRole = null) {
    if (targetRole === null) {
      const normalizedRole = normalizeWatchdogAgentRole(senderRole);
      if (!normalizedRole) return false;
      let cleared = false;
      for (const [key, entry] of this.pendingAgentResponseWatchdogs.entries()) {
        if (entry?.targetRole !== normalizedRole) continue;
        clearTimeout(entry.timerId);
        this.pendingAgentResponseWatchdogs.delete(key);
        cleared = true;
      }
      return cleared;
    }

    const key = createAgentResponseWatchdogKey(senderRole, targetRole);
    if (!key) return false;
    const entry = this.pendingAgentResponseWatchdogs.get(key);
    if (!entry) return false;
    clearTimeout(entry.timerId);
    this.pendingAgentResponseWatchdogs.delete(key);
    return true;
  }

  clearAllAgentResponseWatchdogs() {
    for (const entry of this.pendingAgentResponseWatchdogs.values()) {
      clearTimeout(entry?.timerId);
    }
    this.pendingAgentResponseWatchdogs.clear();
  }

  sendInternalHmMessage(targetRoles, message, options = {}) {
    const text = toNonEmptyString(message);
    if (!text) return false;
    if (!fs.existsSync(HM_SEND_SCRIPT_PATH)) {
      log.warn('ArchitectComms', `hm-send script unavailable for internal message: ${HM_SEND_SCRIPT_PATH}`);
      return false;
    }
    const role = toNonEmptyString(options.role) || 'system';
    const payload = text.startsWith(AGENT_MESSAGE_PREFIX)
      ? text
      : `${AGENT_MESSAGE_PREFIX}${text}`;
    const normalizedTargets = Array.from(new Set(
      (Array.isArray(targetRoles) ? targetRoles : [targetRoles])
        .map((target) => toNonEmptyString(target)?.toLowerCase())
        .filter(Boolean)
    ));
    if (normalizedTargets.length === 0) return false;

    let delivered = false;
    for (const target of normalizedTargets) {
      try {
        const child = spawn('node', [HM_SEND_SCRIPT_PATH, target, payload, '--role', role], {
          cwd: getProjectRoot() || WORKSPACE_PATH || process.cwd(),
          env: process.env,
          windowsHide: true,
        });
        if (typeof child?.unref === 'function') {
          child.unref();
        }
        delivered = true;
      } catch (error) {
        log.warn('ArchitectComms', `Failed sending internal ${target} message via hm-send: ${error.message}`);
      }
    }

    return delivered;
  }

  sendArchitectInternalHmMessage(message, options = {}) {
    return this.sendInternalHmMessage('architect', message, options);
  }

  scheduleAgentResponseWatchdog({ senderRole = null, targetRole = null, content = '', sentAtMs = Date.now() } = {}) {
    const normalizedSenderRole = normalizeWatchdogAgentRole(senderRole);
    const normalizedTargetRole = normalizeWatchdogAgentRole(targetRole);
    if (!normalizedSenderRole || !normalizedTargetRole) return false;
    if (normalizedSenderRole === normalizedTargetRole) return false;
    if (!shouldWatchdogAgentTask(content)) return false;

    const watchdogMs = resolveRuntimeInt(
      'agentResponseWatchdogMs',
      DEFAULT_AGENT_RESPONSE_WATCHDOG_MS
    );
    const key = createAgentResponseWatchdogKey(normalizedSenderRole, normalizedTargetRole);
    if (!key) return false;
    this.clearAgentResponseWatchdog(normalizedSenderRole, normalizedTargetRole);

    const sentAtLabel = formatLocalClockTime(sentAtMs);
    const timerId = setTimeout(() => {
      this.pendingAgentResponseWatchdogs.delete(key);
      const warning = normalizedSenderRole === 'architect'
        ? `[WATCHDOG] No response from ${normalizedTargetRole} for task sent at ${sentAtLabel}. Check if task was received.`
        : `[WATCHDOG] No response from ${normalizedTargetRole} to ${normalizedSenderRole} for task sent at ${sentAtLabel}. Check if task was received.`;
      const alertTargets = normalizedSenderRole === 'architect'
        ? ['architect']
        : [normalizedSenderRole, 'architect'];
      try {
        this.sendInternalHmMessage(alertTargets, `(SYSTEM WATCHDOG): ${warning}`, {
          role: 'system',
        });
      } catch (error) {
        log.warn('Watchdog', `Failed routing response watchdog alert for ${key}: ${error.message}`);
      }
    }, watchdogMs);

    if (typeof timerId?.unref === 'function') {
      timerId.unref();
    }

    this.pendingAgentResponseWatchdogs.set(key, {
      key,
      timerId,
      watchdogMs,
      sentAtMs,
      senderRole: normalizedSenderRole,
      targetRole: normalizedTargetRole,
    });
    return true;
  }

  maybeResolveAgentResponseWatchdog({ senderRole = null, targetRole = null, deliveryAccepted = false } = {}) {
    const normalizedSenderRole = normalizeWatchdogAgentRole(senderRole);
    const normalizedTargetRole = normalizeWatchdogAgentRole(targetRole);
    if (!deliveryAccepted) return false;
    if (!normalizedSenderRole || !normalizedTargetRole) return false;
    if (normalizedSenderRole === normalizedTargetRole) return false;
    return this.clearAgentResponseWatchdog(normalizedTargetRole, normalizedSenderRole);
  }

  async recordDeliveryFailurePattern(args = {}) {
    return this.recordDeliveryOutcomePattern(args);
  }

  async updateIntentStateAtomic(payload = {}) {
    const paneId = String(payload?.paneId ?? payload?.pane ?? '').trim();
    if (!paneId) {
      return { ok: false, reason: 'invalid_pane_id' };
    }

    const nowMs = Date.now();
    const nextIntent = typeof payload?.intent === 'string' ? payload.intent.trim() : '';
    const source = typeof payload?.source === 'string' ? payload.source : 'renderer';
    const current = this.intentStateByPane.get(paneId) || {};
    const role = payload?.role || current?.role || null;
    const session = payload?.session ?? current?.session ?? null;
    const previousIntent = typeof payload?.previousIntent === 'string'
      ? payload.previousIntent
      : (typeof current?.intent === 'string' ? current.intent : null);

    this.intentStateByPane.set(paneId, {
      pane: paneId,
      role,
      session,
      intent: nextIntent,
      last_update: new Date(nowMs).toISOString(),
    });

    const ready = await this.ensureTeamMemoryInitialized('intent-update');
    if (!ready) {
      return {
        ok: false,
        reason: 'team_memory_unavailable',
        paneId,
        intent: nextIntent,
        session,
      };
    }

    try {
      const patternEvent = buildIntentUpdatePatternEvent({
        paneId,
        role,
        session,
        intent: nextIntent,
        previousIntent,
        source,
        nowMs,
      });
      await this.appendTeamMemoryPatternEvent(patternEvent, 'intent-update');
      return {
        ok: true,
        paneId,
        intent: nextIntent,
        session,
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'team_memory_write_failed',
        error: err.message,
        paneId,
        intent: nextIntent,
        session,
      };
    }
  }

  /**
   * Resolve target (role name, canonical paneId, or background alias) to paneId.
   * @param {string} target - e.g. architect, 1, builder-bg-1, bg-2-1
   * @returns {string|null} paneId or null if not found
   */
  resolveTargetToPane(target) {
    if (!target) return null;

    const targetRaw = String(target).trim();
    if (!targetRaw) return null;
    const targetLower = targetRaw.toLowerCase();

    // Background builder aliases/synthetic pane IDs
    const backgroundPaneId = resolveBackgroundBuilderPaneId(targetLower);
    if (backgroundPaneId) {
      return backgroundPaneId;
    }

    // Direct paneId
    if (PANE_IDS.includes(targetRaw)) {
      return targetRaw;
    }

    // Role name lookup
    if (ROLE_ID_MAP[targetLower]) {
      return ROLE_ID_MAP[targetLower];
    }

    // Backward-compatible aliases
    const canonicalRole = BACKWARD_COMPAT_ROLE_ALIASES?.[targetLower];
    if (canonicalRole && ROLE_ID_MAP[canonicalRole]) {
      return ROLE_ID_MAP[canonicalRole];
    }

    return null;
  }

  normalizeOutboundTarget(target) {
    if (typeof target !== 'string') return '';
    return target.trim().toLowerCase();
  }

  isTelegramReplyTarget(target) {
    const normalized = this.normalizeOutboundTarget(target);
    return normalized === 'user' || normalized === 'telegram';
  }

  getTelegramReplyContextPath() {
    try {
      return resolveCoordPath(path.join('runtime', 'telegram-reply-context.json'), { forWrite: true });
    } catch (_) {
      return null;
    }
  }

  persistTelegramReplyContext(context = {}) {
    const contextPath = this.getTelegramReplyContextPath();
    const chatId = normalizeChatId(context?.chatId);
    if (!contextPath || !chatId) return false;

    const payload = {
      chatId,
      defaultChatId: normalizeChatId(process.env.TELEGRAM_CHAT_ID || '') || null,
      sender: typeof context?.sender === 'string' && context.sender.trim() ? context.sender.trim() : null,
      lastInboundAtMs: Number.isFinite(Number(context?.lastInboundAtMs))
        ? Math.floor(Number(context.lastInboundAtMs))
        : Date.now(),
      updatedAt: new Date().toISOString(),
    };

    try {
      fs.mkdirSync(path.dirname(contextPath), { recursive: true });
      fs.writeFileSync(contextPath, JSON.stringify(payload, null, 2));
      return true;
    } catch (_) {
      return false;
    }
  }

  markTelegramInboundContext(sender = 'unknown', metadata = {}) {
    const chatId = normalizeChatId(metadata?.chatId);
    const windowKey = toNonEmptyString(metadata?.windowKey) || this.resolveTelegramInboundWindowKey(chatId);
    this.telegramInboundContext = {
      lastInboundAtMs: Date.now(),
      sender: typeof sender === 'string' && sender.trim() ? sender.trim() : 'unknown',
      chatId,
      windowKey,
    };
    this.persistTelegramReplyContext(this.telegramInboundContext);
    return this.telegramInboundContext;
  }

  resolveTelegramInboundWindowKey(chatId = null) {
    if (!isMainProfile(this.activeProfileName)) {
      return 'main';
    }
    const normalizedChatId = normalizeChatId(chatId);
    return normalizedChatId === '8754356993' ? 'eunbyeol' : 'main';
  }

  hasRecentTelegramInbound(nowMs = Date.now()) {
    const lastInboundAtMs = Number(this.telegramInboundContext?.lastInboundAtMs || 0);
    if (!Number.isFinite(lastInboundAtMs) || lastInboundAtMs <= 0) return false;
    return (nowMs - lastInboundAtMs) <= TELEGRAM_REPLY_WINDOW_MS;
  }

  async routeTelegramReply({
    target,
    content,
    fromRole = 'system',
    messageId = null,
    chatId = null,
  } = {}) {
    const normalizedTarget = this.normalizeOutboundTarget(target);
    if (!this.isTelegramReplyTarget(normalizedTarget)) {
      return {
        handled: false,
      };
    }

    const requiresRecentInbound = normalizedTarget !== 'telegram';
    if (requiresRecentInbound && !this.hasRecentTelegramInbound()) {
      return {
        handled: true,
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'telegram_context_stale',
      };
    }

    const message = typeof content === 'string' ? content.trim() : '';
    if (!message) {
      return {
        handled: true,
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'telegram_empty_content',
      };
    }

    try {
      const replyChatId = normalizeChatId(chatId)
        || (requiresRecentInbound ? normalizeChatId(this.telegramInboundContext?.chatId) : null);
      const result = await sendRoutedTelegramMessage(message, process.env, {
        messageId,
        senderRole: fromRole,
        sessionId: this.commsSessionScopeId || null,
        chatId: replyChatId || null,
        metadata: {
          routeKind: 'telegram',
          targetRaw: normalizedTarget,
        },
      });
      if (!result?.ok) {
        return {
          handled: true,
          ok: false,
          accepted: false,
          queued: false,
          verified: false,
          status: 'telegram_send_failed',
          error: result?.error || 'unknown_error',
        };
      }

      return {
        handled: true,
        ok: true,
        accepted: true,
        queued: true,
        verified: true,
        status: 'telegram_delivered',
        messageId: result.messageId || null,
        chatId: result.chatId || null,
        routeMethod: result.method || null,
      };
    } catch (err) {
      return {
        handled: true,
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'telegram_send_failed',
        error: err.message,
      };
    }
  }

  resolveAutonomousSmokeProjectPath(projectMetadata = null) {
    const fallback = getProjectRoot()
      || path.resolve(path.join(WORKSPACE_PATH, '..'));
    if (!projectMetadata || typeof projectMetadata !== 'object') {
      return fallback;
    }

    const directPath = typeof projectMetadata.path === 'string'
      ? projectMetadata.path.trim()
      : '';
    if (directPath) return path.resolve(directPath);

    const envelopeProjectPath = typeof projectMetadata?.envelope?.project?.path === 'string'
      ? projectMetadata.envelope.project.path.trim()
      : '';
    if (envelopeProjectPath) return path.resolve(envelopeProjectPath);

    return fallback;
  }

  buildAutonomousSmokeRunId() {
    this.autonomousSmoke.sequence += 1;
    const sequenceId = String(this.autonomousSmoke.sequence).padStart(4, '0');
    return `auto-smoke-${Date.now()}-${sequenceId}`;
  }

  async runAutonomousSmokeSidecar(args = [], { projectPath = null, timeoutMs = AUTONOMOUS_SMOKE_TIMEOUT_MS } = {}) {
    if (!fs.existsSync(AUTONOMOUS_SMOKE_RUNNER_PATH)) {
      return {
        ok: false,
        status: 'runner_missing',
        code: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: `Runner not found: ${AUTONOMOUS_SMOKE_RUNNER_PATH}`,
      };
    }

    const cwd = projectPath && fs.existsSync(projectPath)
      ? projectPath
      : getProjectRoot();
    const env = {
      ...process.env,
      SQUIDRUN_PROJECT_ROOT: projectPath || getProjectRoot() || process.env.SQUIDRUN_PROJECT_ROOT || process.cwd(),
    };

    return await new Promise((resolve) => {
      const child = spawn('node', [AUTONOMOUS_SMOKE_RUNNER_PATH, 'run', ...args], {
        cwd: cwd || undefined,
        env,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch (_) {
          // Best effort.
        }
      }, Math.max(1000, timeoutMs));

      const finalize = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(result);
      };

      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk || '');
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk || '');
        });
      }

      child.on('error', (err) => {
        finalize({
          ok: false,
          status: 'spawn_failed',
          code: null,
          signal: null,
          timedOut,
          stdout,
          stderr: `${stderr}\n${err.message}`.trim(),
        });
      });

      child.on('close', (code, signal) => {
        finalize({
          ok: Number(code) === 0 && !timedOut,
          status: Number(code) === 0 ? 'ok' : 'runner_failed',
          code,
          signal: signal || null,
          timedOut,
          stdout,
          stderr,
        });
      });
    });
  }

  buildAutonomousSmokeSummary(summary = {}, context = {}) {
    const safeSummary = (summary && typeof summary === 'object' && !Array.isArray(summary))
      ? summary
      : {};
    const safeContext = (context && typeof context === 'object' && !Array.isArray(context))
      ? context
      : {};
    const status = formatSmokeResultMessage(safeSummary, {
      senderRole: safeContext.senderRole || 'builder',
      triggerReason: safeContext.triggerReason || null,
      runId: safeContext.runId || safeSummary.runId || null,
    });
    const lines = [
      status,
      `url=${safeSummary.url || 'unresolved'}`,
      `artifact_dir=${safeSummary.runDir || 'n/a'}`,
      `console_errors=${Number(safeSummary.consoleErrorCount || 0)}`,
      `page_errors=${Number(safeSummary.pageErrorCount || 0)}`,
      `request_failures=${Number(safeSummary.requestFailureCount || 0)}`,
      `http_errors=${Number(safeSummary.httpErrorCount || 0)}`,
      `axe_violations=${Number(safeSummary.axeViolationCount || 0)}`,
      `broken_links=${Number(safeSummary.brokenLinkCount || 0)}`,
      `diff_pixels=${Number(safeSummary.diffPixelCount || 0)}`,
      `diff_ratio=${typeof safeSummary.diffRatio === 'number' ? safeSummary.diffRatio : 'n/a'}`,
      `web_vitals=${safeSummary.webVitalsStatus || 'n/a'}`,
      `lighthouse=${safeSummary.lighthouseStatus || 'n/a'}`,
      `lighthouse_avg=${safeSummary.lighthouseAveragePerformanceScore ?? 'n/a'}`,
      `lighthouse_below_threshold=${Number(safeSummary.lighthouseBelowThresholdCount || 0)}`,
      `gate_profile=${safeSummary.gateProfile || 'per-cycle'}`,
      `firefox_gate=${safeSummary.firefoxGateStatus || 'n/a'}`,
      `missing_text=${Number(safeSummary.missingTextCount || 0)}`,
      `missing_selectors=${Number(safeSummary.missingSelectorCount || 0)}`,
      `hard_failures=${Number(safeSummary.hardFailureCount || 0)}`,
      `debug_package=${safeSummary.debugPackagePath || 'n/a'}`,
      `generated_spec=${safeSummary.generatedSpecPath || 'n/a'}`,
      `spec_generation=${safeSummary.specGenerationStatus || 'n/a'}`,
    ];
    const hardFailures = Array.isArray(safeSummary.hardFailures) ? safeSummary.hardFailures : [];
    for (const failure of hardFailures.slice(0, 3)) {
      const code = typeof failure?.code === 'string' ? failure.code : 'hard_failure';
      const message = typeof failure?.message === 'string' ? failure.message : 'Smoke failure';
      lines.push(`failure:${code}:${message}`);
    }
    return lines.join('\n');
  }

  async reportAutonomousSmokeSummary(summary = {}, context = {}) {
    const text = this.buildAutonomousSmokeSummary(summary, context);
    const architectPayload = `${AGENT_MESSAGE_PREFIX}(BUILDER AUTOSMOKE): ${text}`;
    let architectResult = null;

    try {
      architectResult = await triggers.sendDirectMessage(
        ['1'],
        architectPayload,
        'builder',
        { awaitDelivery: true }
      );
    } catch (err) {
      architectResult = {
        accepted: false,
        queued: false,
        verified: false,
        status: 'architect_report_failed',
        error: err.message,
      };
    }

    const architectDelivered = Boolean(architectResult?.verified || architectResult?.accepted);
    if (architectDelivered) {
      return {
        ok: true,
        architectDelivered: true,
        architectResult,
      };
    }

    const telegramMessage = [
      '[AUTONOMOUS_SMOKE_FALLBACK]',
      text,
      `architect_status=${architectResult?.status || 'delivery_failed'}`,
      architectResult?.error ? `architect_error=${architectResult.error}` : null,
    ].filter(Boolean).join('\n');

    const telegramResult = await sendTelegram(telegramMessage, process.env, {
      senderRole: 'builder',
      targetRole: 'user',
      sessionId: this.commsSessionScopeId || null,
    }).catch((err) => ({ ok: false, error: err.message }));

    return {
      ok: Boolean(telegramResult?.ok),
      architectDelivered: false,
      architectResult,
      telegramResult,
    };
  }

  runAutonomousSmokeInBackground(runContext = {}) {
    this.autonomousSmoke.inFlight = true;
    this.autonomousSmoke.lastStartedAtMs = Date.now();

    const context = {
      ...(runContext && typeof runContext === 'object' ? runContext : {}),
      runId: (runContext && runContext.runId) || this.buildAutonomousSmokeRunId(),
    };

    void (async () => {
      const projectPath = this.resolveAutonomousSmokeProjectPath(context.projectMetadata);
      const runnerArgs = buildSmokeRunnerArgs({
        senderRole: context.senderRole || 'builder',
        triggerReason: context.triggerReason || 'workflow_signal',
        messageContent: context.messageContent || '',
        runId: context.runId,
        sessionId: this.commsSessionScopeId || null,
        projectPath,
        headless: true,
      });

      const runnerResult = await this.runAutonomousSmokeSidecar(runnerArgs, { projectPath });
      const structuredOutput = [
        runnerResult.stdout,
        runnerResult.stderr,
        [runnerResult.stdout, runnerResult.stderr].filter(Boolean).join('\n'),
      ]
        .map((value) => parseStructuredJsonOutput(value))
        .find((value) => value && typeof value === 'object' && !Array.isArray(value));

      if (!structuredOutput) {
        log.warn(
          'AutonomousSmoke',
          `Skipping summary injection because smoke runner returned no structured JSON (status=${runnerResult.status || 'unknown'}, code=${runnerResult.code ?? 'null'})`,
        );
        return;
      }

      const summary = { ...structuredOutput };

      if (summary.runId == null) summary.runId = context.runId;
      if (summary.projectPath == null) summary.projectPath = projectPath;
      if (runnerResult.timedOut === true) {
        summary.ok = false;
        const hardFailures = Array.isArray(summary.hardFailures) ? summary.hardFailures : [];
        hardFailures.push({
          code: 'runner_timeout',
          message: `Smoke runner timed out after ${AUTONOMOUS_SMOKE_TIMEOUT_MS}ms`,
        });
        summary.hardFailures = hardFailures;
        summary.hardFailureCount = hardFailures.length;
      } else if (runnerResult.ok === false && summary.ok !== false) {
        summary.ok = false;
      }

      summary.runner = {
        status: runnerResult.status,
        exitCode: runnerResult.code,
        signal: runnerResult.signal,
        timedOut: runnerResult.timedOut,
        stderr: runnerResult.stderr || '',
      };

      await this.reportAutonomousSmokeSummary(summary, context);
    })()
      .catch((err) => {
        log.warn('AutonomousSmoke', `Smoke run failed: ${err.message}`);
      })
      .finally(() => {
        this.autonomousSmoke.inFlight = false;
        const queued = this.autonomousSmoke.queuedRun;
        this.autonomousSmoke.queuedRun = null;
        if (queued) {
          this.runAutonomousSmokeInBackground(queued);
        }
      });
  }

  maybeTriggerAutonomousSmokeFromSend({
    senderRole,
    messageContent,
    projectMetadata = null,
    deliveryResult = null,
  } = {}) {
    const triggerDecision = shouldTriggerAutonomousSmoke({
      senderRole,
      messageContent,
    });
    if (!triggerDecision.trigger) {
      return {
        ok: false,
        status: 'autonomous_smoke_not_triggered',
        reason: triggerDecision.reason,
      };
    }

    const delivered = Boolean(
      deliveryResult?.verified
      || deliveryResult?.accepted
      || deliveryResult?.queued
      || deliveryResult?.ok
    );
    if (!delivered) {
      return {
        ok: false,
        status: 'autonomous_smoke_skipped_undelivered',
        reason: triggerDecision.reason,
      };
    }

    if (this.autonomousSmoke.inFlight) {
      this.autonomousSmoke.queuedRun = {
        senderRole,
        messageContent,
        projectMetadata,
        triggerReason: triggerDecision.reason,
      };
      return {
        ok: true,
        status: 'autonomous_smoke_queued',
        reason: triggerDecision.reason,
      };
    }

    const nowMs = Date.now();
    if (
      AUTONOMOUS_SMOKE_COOLDOWN_MS > 0
      && this.autonomousSmoke.lastStartedAtMs > 0
      && (nowMs - this.autonomousSmoke.lastStartedAtMs) < AUTONOMOUS_SMOKE_COOLDOWN_MS
    ) {
      return {
        ok: false,
        status: 'autonomous_smoke_cooldown',
        reason: triggerDecision.reason,
      };
    }

    this.runAutonomousSmokeInBackground({
      senderRole,
      messageContent,
      projectMetadata,
      triggerReason: triggerDecision.reason,
    });
    return {
      ok: true,
      status: 'autonomous_smoke_started',
      reason: triggerDecision.reason,
    };
  }

  resolveEnvBridgeRuntimeConfig() {
    if (!isCrossDeviceEnabled(process.env)) return null;
    const profileName = getActiveProfileName();
    const relayUrl = String(process.env.SQUIDRUN_RELAY_URL || '').trim() || DEFAULT_BRIDGE_RELAY_URL;
    const sharedSecret = String(process.env.SQUIDRUN_RELAY_SECRET || '').trim();
    const baseDeviceId = getLocalDeviceId(process.env)
      || normalizeDeviceId(os.hostname())
      || normalizeDeviceId(`DEVICE-${process.pid}`);
    const deviceId = getProfileDeviceId(process.env, profileName, { baseDeviceId });
    if (!relayUrl || !deviceId) return null;
    return {
      source: 'env',
      relayUrl,
      sharedSecret,
      deviceId,
      pairedDeviceId: null,
      pairedAt: null,
    };
  }

  resolveBridgeRuntimeConfig() {
    const profileName = getActiveProfileName();
    const pairedResult = readPairedConfig();
    if (pairedResult?.ok && pairedResult.config) {
      const baseDeviceId = normalizeDeviceId(pairedResult.config.device_id);
      const deviceId = getProfileDeviceId(process.env, profileName, { baseDeviceId }) || baseDeviceId;
      return {
        source: 'devices.json',
        relayUrl: pairedResult.config.relay_url,
        sharedSecret: pairedResult.config.shared_secret,
        deviceId,
        pairedDeviceId: pairedResult.config.paired_device_id || null,
        pairedAt: pairedResult.config.paired_at || null,
      };
    }
    if (pairedResult?.ok === false) {
      log.warn('Bridge', `Failed to read devices.json: ${pairedResult.error || pairedResult.reason || 'unknown'}`);
    }
    return this.resolveEnvBridgeRuntimeConfig();
  }

  refreshBridgeRuntimeConfig() {
    this.bridgeRuntimeConfig = this.resolveBridgeRuntimeConfig();
    this.bridgeEnabled = Boolean(this.bridgeRuntimeConfig) || isCrossDeviceEnabled(process.env);
    this.bridgeDeviceId = this.bridgeRuntimeConfig?.deviceId || getProfileDeviceId(process.env, getActiveProfileName()) || null;
    this.bridgeRelayStatus.enabled = this.bridgeEnabled === true;
    this.bridgeRelayStatus.configured = Boolean(this.bridgeRuntimeConfig?.relayUrl && this.bridgeDeviceId);
    this.bridgeRelayStatus.relayUrl = this.bridgeRuntimeConfig?.relayUrl || null;
    this.bridgeRelayStatus.deviceId = this.bridgeDeviceId;
    this.bridgeRelayStatus.running = Boolean(this.bridgeClient);
    return this.bridgeRuntimeConfig;
  }

  getBridgeStatus() {
    const snapshot = {
      ...this.bridgeRelayStatus,
      running: Boolean(this.bridgeClient),
      enabled: this.bridgeEnabled === true,
      configured: Boolean((this.bridgeRuntimeConfig?.relayUrl || null) && this.bridgeDeviceId),
      relayUrl: this.bridgeRuntimeConfig?.relayUrl || null,
      deviceId: this.bridgeDeviceId,
    };
    snapshot.mode = snapshot.enabled !== true
      ? 'disabled'
      : ((snapshot.state === 'connected' || snapshot.status === 'relay_connected')
        ? 'connected'
        : 'connecting');
    if (Number.isFinite(snapshot.connectedSinceAt)) {
      snapshot.connectedForMs = Math.max(0, Date.now() - snapshot.connectedSinceAt);
    } else {
      snapshot.connectedForMs = null;
    }
    return snapshot;
  }

  emitBridgeStatusSnapshot() {
    const snapshot = this.getBridgeStatus();
    this.kernelBridge.emitBridgeEvent('bridge.relay.status', snapshot);
    return snapshot;
  }

  persistBridgePairingConfig(paired = {}) {
    const writeResult = writePairedConfig({
      device_id: paired.device_id,
      shared_secret: paired.shared_secret,
      relay_url: paired.relay_url,
      paired_device_id: paired.paired_device_id,
      paired_at: paired.paired_at || new Date().toISOString(),
    });
    if (!writeResult?.ok) {
      return {
        ok: false,
        reason: writeResult?.reason || 'devices_write_failed',
        error: writeResult?.error || 'Failed writing devices.json',
      };
    }
    this.refreshBridgeRuntimeConfig();
    return {
      ok: true,
      config: this.bridgeRuntimeConfig,
      path: writeResult.path,
    };
  }

  handleBridgePairingUpdate(update = {}) {
    if (!update || typeof update !== 'object') return;
    if (update.type === 'pairing-complete' && update.ok === true && update.paired) {
      const persistResult = this.persistBridgePairingConfig(update.paired);
      if (!persistResult.ok) {
        log.warn('Bridge', `Failed persisting pairing config: ${persistResult.error || persistResult.reason || 'unknown'}`);
      }
    }
    const shouldClearActiveCode = update.type === 'pairing-complete' || update.type === 'pairing-failed';
    const nextCode = shouldClearActiveCode
      ? null
      : ((Object.prototype.hasOwnProperty.call(update, 'code')
        ? String(update.code || '').trim()
        : this.bridgePairingState.code) || null);
    const nextExpiresAt = shouldClearActiveCode
      ? null
      : (Number.isFinite(update.expiresAt) ? update.expiresAt : this.bridgePairingState.expiresAt);
    this.emitBridgePairingStateUpdate({
      mode: update.type === 'pairing-init-ack' ? 'generate' : (update.type === 'pairing-complete' ? 'join' : this.bridgePairingState.mode),
      code: nextCode,
      expiresAt: nextExpiresAt,
      status: update.status || this.bridgePairingState.status,
      error: update.error || null,
      reason: update.reason || null,
      paired: update.paired || this.bridgePairingState.paired,
    });
  }

  getBridgePairingState() {
    return {
      ...this.bridgePairingState,
    };
  }

  emitBridgePairingStateUpdate(patch = {}) {
    const next = {
      ...this.bridgePairingState,
      ...(patch && typeof patch === 'object' ? patch : {}),
      updatedAt: Date.now(),
    };
    this.bridgePairingState = next;
    if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
      this.ctx.mainWindow.webContents.send('bridge:pairing-state', next);
    }
    return next;
  }

  isBridgeConfigured() {
    if (this.bridgeEnabled !== true) return false;
    const config = this.bridgeRuntimeConfig || this.refreshBridgeRuntimeConfig();
    return Boolean(config?.relayUrl && config?.deviceId);
  }

  async waitForBridgeReady(timeoutMs = BRIDGE_READY_WAIT_TIMEOUT_MS) {
    if (!this.bridgeClient) return false;
    const parsedTimeoutMs = Number.parseInt(String(timeoutMs), 10);
    const waitTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
      ? parsedTimeoutMs
      : BRIDGE_READY_WAIT_TIMEOUT_MS;
    const readyDeadline = Date.now() + Math.max(500, waitTimeoutMs);
    while (Date.now() < readyDeadline) {
      if (this.bridgeClient && this.bridgeClient.isReady()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return Boolean(this.bridgeClient && this.bridgeClient.isReady());
  }

  handleBridgeClientStatusUpdate(status = {}) {
    if (!status || typeof status !== 'object') return;

    const nextState = typeof status.state === 'string' ? status.state.trim().toLowerCase() : null;
    const nextStatus = typeof status.status === 'string' ? status.status.trim() : null;
    const nextError = typeof status.error === 'string' && status.error.trim()
      ? status.error.trim()
      : null;
    const nowMs = Date.now();
    const previousState = this.bridgeRelayStatus.state;
    const previousStatus = this.bridgeRelayStatus.status;
    const previousError = this.bridgeRelayStatus.error;

    this.bridgeRelayStatus.enabled = this.bridgeEnabled === true;
    this.bridgeRelayStatus.configured = Boolean((this.bridgeRuntimeConfig?.relayUrl || null) && this.bridgeDeviceId);
    this.bridgeRelayStatus.running = Boolean(this.bridgeClient);
    this.bridgeRelayStatus.relayUrl = this.bridgeRuntimeConfig?.relayUrl || null;
    this.bridgeRelayStatus.deviceId = this.bridgeDeviceId;
    if (nextState) this.bridgeRelayStatus.state = nextState;
    if (nextStatus) this.bridgeRelayStatus.status = nextStatus;
    this.bridgeRelayStatus.error = nextError;
    this.bridgeRelayStatus.lastUpdateAt = nowMs;
    if (
      this.bridgeRelayStatus.state !== previousState
      || this.bridgeRelayStatus.status !== previousStatus
      || this.bridgeRelayStatus.error !== previousError
    ) {
      this.bridgeRelayStatus.lastStatusChangeAt = nowMs;
    }

    if (status.type === 'relay.dispatch') {
      this.bridgeRelayStatus.lastDispatchAt = nowMs;
      this.bridgeRelayStatus.lastDispatchStatus = nextStatus || null;
      this.bridgeRelayStatus.lastDispatchTarget = typeof status.toDevice === 'string'
        ? status.toDevice
        : null;
      this.kernelBridge.emitBridgeEvent('bridge.relay.dispatch', {
        state: this.bridgeRelayStatus.state,
        status: nextStatus || null,
        ok: status.ok === true,
        accepted: status.accepted === true,
        queued: status.queued === true,
        verified: status.verified === true,
        messageId: status.messageId || null,
        fromDevice: status.fromDevice || null,
        toDevice: status.toDevice || null,
        error: nextError,
        lastDispatchAt: this.bridgeRelayStatus.lastDispatchAt,
      });
      this.emitBridgeStatusSnapshot();
      return;
    }

    if (status.type === 'relay.connected') {
      this.bridgeRelayStatus.lastConnectedAt = nowMs;
      this.bridgeRelayStatus.connectedSinceAt = nowMs;
      this.bridgeRelayStatus.lastReconnectScheduledAt = null;
      this.bridgeRelayStatus.nextReconnectDelayMs = null;
      this.bridgeRelayStatus.nextReconnectAt = null;
      this.bridgeRelayStatus.reconnectAttempt = 0;
      this.bridgeRelayStatus.replacedConflictCount = Number.isFinite(Number(status.replacedConflictCount))
        ? Math.max(0, Math.floor(Number(status.replacedConflictCount)))
        : 0;
      this.kernelBridge.emitBridgeEvent('bridge.relay.connected', {
        state: this.bridgeRelayStatus.state,
        status: nextStatus || 'relay_connected',
        deviceId: status.deviceId || this.bridgeDeviceId || null,
      });
      this.emitBridgeStatusSnapshot();
      return;
    }

    if (status.type === 'relay.disconnected') {
      const previousConnectedAt = Number.isFinite(this.bridgeRelayStatus.connectedSinceAt)
        ? this.bridgeRelayStatus.connectedSinceAt
        : this.bridgeRelayStatus.lastConnectedAt;
      this.bridgeRelayStatus.lastDisconnectedAt = nowMs;
      this.bridgeRelayStatus.lastDisconnectReason = status.reason || nextError || null;
      this.bridgeRelayStatus.lastDisconnectCode = Number.isFinite(Number(status.code))
        ? Math.floor(Number(status.code))
        : null;
      this.bridgeRelayStatus.disconnectCount += 1;
      if (
        Number.isFinite(previousConnectedAt)
        && (nowMs - previousConnectedAt) <= BRIDGE_FLAP_WINDOW_MS
      ) {
        this.bridgeRelayStatus.flapCount += 1;
      }
      this.bridgeRelayStatus.connectedSinceAt = null;
      this.kernelBridge.emitBridgeEvent('bridge.relay.disconnected', {
        state: this.bridgeRelayStatus.state,
        status: nextStatus || 'relay_disconnected',
        deviceId: status.deviceId || this.bridgeDeviceId || null,
        reason: status.reason || null,
        error: nextError,
      });
      this.emitBridgeStatusSnapshot();
      return;
    }

    if (status.type === 'relay.reconnecting') {
      this.bridgeRelayStatus.lastReconnectScheduledAt = nowMs;
      this.bridgeRelayStatus.nextReconnectDelayMs = Number.isFinite(Number(status.reconnectDelayMs))
        ? Math.max(0, Math.floor(Number(status.reconnectDelayMs)))
        : null;
      this.bridgeRelayStatus.nextReconnectAt = Number.isFinite(Number(status.reconnectAt))
        ? Math.floor(Number(status.reconnectAt))
        : null;
      this.bridgeRelayStatus.reconnectAttempt = Number.isFinite(Number(status.reconnectAttempt))
        ? Math.max(0, Math.floor(Number(status.reconnectAttempt)))
        : this.bridgeRelayStatus.reconnectAttempt;
      this.bridgeRelayStatus.replacedConflictCount = Number.isFinite(Number(status.replacedConflictCount))
        ? Math.max(0, Math.floor(Number(status.replacedConflictCount)))
        : this.bridgeRelayStatus.replacedConflictCount;
      this.kernelBridge.emitBridgeEvent('bridge.relay.reconnecting', {
        state: this.bridgeRelayStatus.state,
        status: nextStatus || 'relay_reconnecting',
        deviceId: status.deviceId || this.bridgeDeviceId || null,
        reconnectAttempt: this.bridgeRelayStatus.reconnectAttempt,
        replacedConflictCount: this.bridgeRelayStatus.replacedConflictCount,
        reconnectDelayMs: this.bridgeRelayStatus.nextReconnectDelayMs,
        reconnectAt: this.bridgeRelayStatus.nextReconnectAt,
        reason: status.reason || null,
      });
      this.emitBridgeStatusSnapshot();
      return;
    }

    if (status.type === 'relay.error') {
      this.bridgeRelayStatus.lastErrorAt = nowMs;
      this.kernelBridge.emitBridgeEvent('bridge.relay.error', {
        state: this.bridgeRelayStatus.state,
        status: nextStatus || 'relay_error',
        deviceId: status.deviceId || this.bridgeDeviceId || null,
        error: nextError,
      });
      this.emitBridgeStatusSnapshot();
      return;
    }

    if (status.type === 'relay.connecting') {
      this.kernelBridge.emitBridgeEvent('bridge.relay.connecting', {
        state: this.bridgeRelayStatus.state,
        status: nextStatus || 'relay_connecting',
        deviceId: status.deviceId || this.bridgeDeviceId || null,
      });
      this.emitBridgeStatusSnapshot();
    }
  }

  startBridgeClient() {
    this.refreshBridgeRuntimeConfig();
    if (!this.bridgeEnabled) return false;
    if (!this.isBridgeConfigured()) {
      log.warn('Bridge', 'Cross-device bridge enabled but missing usable runtime bridge config (requires relay URL + device ID).');
      return false;
    }
    if (this.bridgeClient) return true;

    const relayUrl = String(this.bridgeRuntimeConfig?.relayUrl || '').trim();
    const relaySecret = String(this.bridgeRuntimeConfig?.sharedSecret || '').trim();
    const deviceId = String(this.bridgeRuntimeConfig?.deviceId || '').trim();
    this.bridgeDeviceId = deviceId || null;
    this.bridgeClient = createBridgeClient({
      relayUrl,
      deviceId,
      sharedSecret: relaySecret,
      onMessage: (payload = {}) => this.handleBridgeInboundMessage(payload),
      onStatus: (status = {}) => this.handleBridgeClientStatusUpdate(status),
      onPairing: (update = {}) => this.handleBridgePairingUpdate(update),
    });
    const started = this.bridgeClient.start();
    this.bridgeRelayStatus.running = Boolean(started);
    this.emitBridgeStatusSnapshot();
    if (started) {
      log.info('Bridge', `Cross-device relay bridge enabled (device=${deviceId})`);
    }
    return started;
  }

  async discoverBridgeDevices({ timeoutMs = 5000 } = {}) {
    if (!this.bridgeEnabled) {
      return {
        ok: false,
        status: 'bridge_disabled',
        error: 'Cross-device bridge is disabled',
        devices: [],
        fetchedAt: Date.now(),
      };
    }

    if (!this.bridgeClient) {
      this.startBridgeClient();
    }

    const discoveryTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
    await this.waitForBridgeReady(discoveryTimeoutMs);

    if (!this.bridgeClient || !this.bridgeClient.isReady()) {
      this.handleBridgeClientStatusUpdate({
        type: 'relay.disconnected',
        state: 'disconnected',
        status: 'bridge_unavailable',
      });
      return {
        ok: false,
        status: 'bridge_unavailable',
        error: 'Relay unavailable',
        devices: [],
        fetchedAt: Date.now(),
      };
    }

    const result = await this.bridgeClient.discoverDevices({ timeoutMs: discoveryTimeoutMs });
    return {
      ok: result?.ok === true,
      status: result?.status || (result?.ok === true ? 'bridge_discovery_ok' : 'bridge_discovery_failed'),
      error: result?.error || null,
      devices: Array.isArray(result?.devices) ? result.devices : [],
      fetchedAt: Number.isFinite(result?.fetchedAt) ? result.fetchedAt : Date.now(),
    };
  }

  async initiateBridgePairing({ timeoutMs = 12000 } = {}) {
    this.emitBridgePairingStateUpdate({
      mode: 'generate',
      status: 'pairing_init_pending',
      error: null,
      reason: null,
    });
    if (!this.bridgeEnabled) {
      return {
        ok: false,
        status: 'bridge_disabled',
        error: 'Cross-device bridge is disabled',
      };
    }
    if (!this.bridgeClient) {
      this.startBridgeClient();
    }
    const pairingTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 12000;
    await this.waitForBridgeReady(pairingTimeoutMs);
    if (!this.bridgeClient || !this.bridgeClient.isReady()) {
      return {
        ok: false,
        status: 'bridge_unavailable',
        error: 'Relay unavailable',
      };
    }
    const result = await this.bridgeClient.initiatePairing({ timeoutMs: pairingTimeoutMs });
    if (result?.ok !== true) {
      this.emitBridgePairingStateUpdate({
        mode: 'generate',
        status: result?.status || 'pairing_init_failed',
        error: result?.error || 'pairing_init_failed',
        reason: result?.reason || null,
      });
    }
    return result;
  }

  async joinBridgePairing({ code, timeoutMs = 12000 } = {}) {
    this.emitBridgePairingStateUpdate({
      mode: 'join',
      status: 'pairing_join_pending',
      error: null,
      reason: null,
    });
    if (!this.bridgeEnabled) {
      return {
        ok: false,
        status: 'bridge_disabled',
        error: 'Cross-device bridge is disabled',
      };
    }
    if (!this.bridgeClient) {
      this.startBridgeClient();
    }
    const pairingTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 12000;
    await this.waitForBridgeReady(pairingTimeoutMs);
    if (!this.bridgeClient || !this.bridgeClient.isReady()) {
      return {
        ok: false,
        status: 'bridge_unavailable',
        error: 'Relay unavailable',
      };
    }
    const result = await this.bridgeClient.joinPairingCode(code, { timeoutMs: pairingTimeoutMs });
    if (!(result?.ok === true && result?.paired)) {
      this.emitBridgePairingStateUpdate({
        mode: 'join',
        status: result?.status || 'pairing_join_failed',
        error: result?.error || 'pairing_join_failed',
        reason: result?.reason || null,
      });
    }
    return result;
  }

  async getBridgeDevices({ refresh = true, timeoutMs = 5000 } = {}) {
    const devices = [];
    const byId = new Map();

    if (refresh) {
      const discovery = await this.discoverBridgeDevices({ timeoutMs });
      for (const entry of (Array.isArray(discovery?.devices) ? discovery.devices : [])) {
        const deviceId = String(entry?.device_id || '').trim().toUpperCase();
        if (!deviceId) continue;
        const normalized = {
          device_id: deviceId,
          name: deviceId,
          online: true,
          paired_at: null,
          connected_since: entry?.connected_since || null,
          roles: Array.isArray(entry?.roles) ? entry.roles : [],
        };
        byId.set(deviceId, normalized);
      }
    }

    const runtimeConfig = this.bridgeRuntimeConfig || this.refreshBridgeRuntimeConfig();
    if (runtimeConfig?.pairedDeviceId) {
      const pairedId = String(runtimeConfig.pairedDeviceId).trim().toUpperCase();
      const existing = byId.get(pairedId);
      if (existing) {
        existing.paired_at = runtimeConfig.pairedAt || null;
      } else {
        byId.set(pairedId, {
          device_id: pairedId,
          name: pairedId,
          online: false,
          paired_at: runtimeConfig.pairedAt || null,
          connected_since: null,
          roles: [],
        });
      }
    }

    for (const value of byId.values()) {
      devices.push(value);
    }
    devices.sort((a, b) => String(a.device_id || '').localeCompare(String(b.device_id || '')));
    return {
      ok: true,
      devices,
      fetchedAt: Date.now(),
    };
  }

  async routeBridgeMessage({
    targetDevice,
    content,
    fromRole = 'architect',
    messageId = null,
    traceContext = null,
    structuredMessage = null,
  } = {}) {
    const toDevice = String(targetDevice || '').trim().toUpperCase();
    const body = typeof content === 'string' ? content.trim() : '';
    if (!toDevice) {
      return {
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'bridge_invalid_target',
        error: 'targetDevice is required',
        routeKind: 'bridge',
      };
    }
    if (!body) {
      return {
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'bridge_empty_content',
        routeKind: 'bridge',
      };
    }
    if (!this.bridgeEnabled) {
      this.handleBridgeClientStatusUpdate({
        type: 'relay.disconnected',
        state: 'disconnected',
        status: 'bridge_disabled',
      });
      return {
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'bridge_disabled',
        routeKind: 'bridge',
      };
    }
    if (!this.bridgeClient) {
      this.startBridgeClient();
    }
    await this.waitForBridgeReady();
    if (!this.bridgeClient || !this.bridgeClient.isReady()) {
      const relayState = String(this.bridgeRelayStatus?.state || 'unknown').trim().toLowerCase() || 'unknown';
      const relayStatus = String(this.bridgeRelayStatus?.status || '').trim() || 'relay_unavailable';
      const relayError = String(this.bridgeRelayStatus?.error || '').trim() || null;
      log.warn(
        'Bridge',
        `routeBridgeMessage unavailable after waiting for relay readiness (state=${relayState}, status=${relayStatus}${relayError ? `, error=${relayError}` : ''})`
      );
      this.handleBridgeClientStatusUpdate({
        type: 'relay.disconnected',
        state: relayState,
        status: 'bridge_unavailable',
        error: relayError,
      });
      return {
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'bridge_unavailable',
        error: relayError || 'Relay unavailable',
        routeKind: 'bridge',
        relayState,
        relayStatus,
      };
    }

    const normalizedBridgeMetadata = normalizeBridgeMetadata(
      {
        traceId: traceContext?.traceId || traceContext?.correlationId || null,
        sessionId: this.commsSessionScopeId || null,
        structured: structuredMessage,
      },
      body
    );
    const bridgeResult = await this.bridgeClient.sendToDevice({
      messageId: messageId || `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      toDevice,
      targetRole: 'architect',
      content: body,
      fromRole,
      metadata: normalizedBridgeMetadata,
    });
    return {
      ...bridgeResult,
      routeKind: 'bridge',
    };
  }

  async handleBridgeInboundMessage(payload = {}) {
    const fromDevice = String(payload?.fromDevice || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
    const messageId = String(payload?.messageId || '').trim();
    const body = typeof payload?.content === 'string' ? payload.content.trim() : '';
    const bridgeMetadata = normalizeBridgeMetadata(payload?.metadata, body, {
      ensureStructured: true,
    });
    const structuredType = bridgeMetadata?.structured?.type || null;
    if (!body) {
      return {
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'bridge_empty_content',
        error: 'Inbound bridge message was empty',
      };
    }

    const inboundMessageId = messageId || `bridge-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sentAtMs = Date.now();
    void Promise.resolve(executeEvidenceLedgerOperation(
      'upsert-comms-journal',
      {
        messageId: inboundMessageId,
        sessionId: this.commsSessionScopeId || null,
        senderRole: 'architect',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'inbound',
        sentAtMs,
        brokeredAtMs: sentAtMs,
        rawBody: body,
        status: 'brokered',
        attempt: 1,
        metadata: {
          source: 'bridge-client',
          routeKind: 'bridge',
          fromDevice,
          bridgeMessageId: messageId || null,
          bridgeMetadata,
          structured: bridgeMetadata?.structured || null,
          structuredType,
        },
      },
      {
        source: {
          via: 'bridge-client',
          role: 'system',
          paneId: 'system',
        },
      }
    )).then((result) => {
      if (result?.ok === false) {
        log.warn('EvidenceLedger', `Bridge inbound journal upsert failed: ${result.reason || 'unknown'}`);
      }
    }).catch((err) => {
      log.warn('EvidenceLedger', `Bridge inbound journal upsert error: ${err.message}`);
    });

    let formatted = structuredType
      ? `[Bridge ${structuredType} from ${fromDevice}]: ${body}`
      : `[Bridge from ${fromDevice}]: ${body}`;
    if (structuredType === 'HandoffPacket') {
      const handoffPacket = bridgeMetadata?.structured?.payload?.packet || bridgeMetadata?.structured?.payload || null;
      const handoffResult = await this.handleInboundHandoffPacket(handoffPacket, {
        paneId: '1',
      });
      if (handoffResult?.ok === true && handoffResult?.injection?.message) {
        formatted = `[Bridge HandoffPacket from ${fromDevice}]\n${handoffResult.injection.message}`;
      }
    }
    const injection = triggers.sendDirectMessage(['1'], formatted, null);
    if (!injection?.success) {
      return {
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'bridge_inject_failed',
        error: injection?.error || 'Failed to inject bridge message into Architect pane',
      };
    }

    return {
      ok: true,
      accepted: true,
      queued: true,
      verified: true,
      status: 'bridge_delivered',
    };
  }

  async deliverHumanMessageWithRecall(message, recallContext = {}, logLabel = 'HumanMessage') {
    const meta = {
      ...((recallContext.meta && typeof recallContext.meta === 'object') ? recallContext.meta : {}),
      ...((recallContext.metadata && typeof recallContext.metadata === 'object') ? recallContext.metadata : {}),
    };
    if (toNonEmptyString(recallContext.windowKey) && !toNonEmptyString(meta.windowKey)) {
      meta.windowKey = toNonEmptyString(recallContext.windowKey);
    }
    const result = await this.deliverPaneMessageReliably({
      paneId: String(recallContext.paneId || '1'),
      message,
      fromRole: null,
      traceContext: recallContext.traceContext || null,
      meta: Object.keys(meta).length > 0 ? meta : null,
      queueOnAcceptedUnverified: true,
      queueOnHardFailure: true,
      messageId: recallContext.messageId || null,
      channel: recallContext.channel || 'user',
      sender: recallContext.sender || 'user',
      logLabel,
    });
    if (!(result?.accepted === true || result?.queued === true || result?.verified === true || result?.ok === true || result?.pendingQueued === true)) {
      log.warn(logLabel, `Failed to inject inbound message into pane ${recallContext.paneId || '1'} (${result?.error || 'unknown'})`);
    }
    return result;
  }

  startSmsPoller() {
    const started = smsPoller.start({
      onMessage: (text, from, metadata = {}) => {
        const sender = typeof from === 'string' && from.trim() ? from.trim() : 'unknown';
        const body = typeof text === 'string' ? text.trim() : '';
        if (!body) return;

        const inboundSid = typeof metadata?.sid === 'string' ? metadata.sid.trim() : '';
        const inboundMessageId = inboundSid
          ? `sms-in-${inboundSid}`
          : `sms-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const sentAtMs = Number.isFinite(Number(metadata?.timestampMs))
          ? Math.floor(Number(metadata.timestampMs))
          : Date.now();
        void Promise.resolve(executeEvidenceLedgerOperation(
          'upsert-comms-journal',
          {
            messageId: inboundMessageId,
            sessionId: this.commsSessionScopeId || null,
            senderRole: 'user',
            targetRole: 'architect',
            channel: 'sms',
            direction: 'inbound',
            sentAtMs,
            brokeredAtMs: Date.now(),
            rawBody: body,
            status: 'brokered',
            attempt: 1,
            metadata: {
              source: 'sms-poller',
              from: sender,
              sid: inboundSid || null,
            },
          },
          {
            source: {
              via: 'sms-poller',
              role: 'system',
              paneId: 'system',
            },
          }
        )).then((result) => {
          if (result?.ok === false) {
            log.warn('EvidenceLedger', `SMS inbound journal upsert failed: ${result.reason || 'unknown'}`);
          }
        }).catch((err) => {
          log.warn('EvidenceLedger', `SMS inbound journal upsert error: ${err.message}`);
        });

        void this.deliverHumanMessageWithRecall(
          `[SMS from ${sender}]: ${body}`,
          {
            paneId: '1',
            role: 'architect',
            channel: 'sms',
            sender,
            messageId: inboundMessageId,
            metadata,
            header: 'MESSAGE RECALL',
          },
          'SMS'
        );
      },
    });

    if (started) {
      log.info('SMS', 'Inbound SMS bridge enabled');
    }
  }

  startTelegramPoller() {
    const started = telegramPoller.start({
      env: buildProfileTelegramEnv(process.env, this.activeProfileName),
      onMessage: (text, from, metadata = {}) => {
        const sender = typeof from === 'string' && from.trim() ? from.trim() : 'unknown';
        const media = metadata?.media && typeof metadata.media === 'object' ? metadata.media : null;
        const photo = metadata?.photo && typeof metadata.photo === 'object' ? metadata.photo : null;
        const document = metadata?.document && typeof metadata.document === 'object' ? metadata.document : null;
        let body = typeof text === 'string' ? text.trim() : '';
        if (!body && media?.kind === 'photo') {
          body = '[Photo received]';
        } else if (!body && photo) {
          body = '[Photo received]';
        } else if (!body && media?.kind === 'document') {
          const fileName = typeof media?.fileName === 'string' && media.fileName.trim()
            ? media.fileName.trim()
            : 'unknown';
          body = `[File: ${fileName}]`;
        } else if (!body && document) {
          const fileName = typeof document?.file_name === 'string' && document.file_name.trim()
            ? document.file_name.trim()
            : 'unknown';
          body = `[File: ${fileName}]`;
        }
        if (!body) {
          log.warn(
            'Telegram',
            `Dropped inbound Telegram callback with empty body (update=${metadata?.updateId ?? 'unknown'} message=${metadata?.messageId ?? 'unknown'} mediaKind=${media?.kind || (photo ? 'photo' : (document ? 'document' : 'none'))})`
          );
          return;
        }
        const archivePath = typeof media?.localPath === 'string' && media.localPath.trim()
          ? media.localPath.trim()
          : null;
        const inboundWindowKey = this.resolveTelegramInboundWindowKey(metadata?.chatId);
        const inboundSessionScopeId = this.getWindowSessionScopeId(inboundWindowKey);

        log.info(
          'Telegram',
          `Handling inbound Telegram callback from ${sender} (update=${metadata?.updateId ?? 'unknown'} message=${metadata?.messageId ?? 'unknown'} mediaKind=${media?.kind || (photo ? 'photo' : (document ? 'document' : 'none'))})`
        );
        this.markTelegramInboundContext(sender, {
          chatId: metadata?.chatId,
          windowKey: inboundWindowKey,
        });
        const updateId = Number.isFinite(Number(metadata?.updateId))
          ? Math.floor(Number(metadata.updateId))
          : null;
        const messageId = Number.isFinite(Number(metadata?.messageId))
          ? Math.floor(Number(metadata.messageId))
          : null;
        const inboundMessageId = updateId !== null
          ? `telegram-in-${updateId}`
          : (messageId !== null
            ? `telegram-in-msg-${messageId}`
            : `telegram-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const sentAtMs = Number.isFinite(Number(metadata?.timestampMs))
          ? Math.floor(Number(metadata.timestampMs))
          : Date.now();
        void Promise.resolve(executeEvidenceLedgerOperation(
          'upsert-comms-journal',
          {
            messageId: inboundMessageId,
            sessionId: inboundSessionScopeId || null,
            senderRole: 'user',
            targetRole: 'architect',
            channel: 'telegram',
            direction: 'inbound',
            sentAtMs,
            brokeredAtMs: Date.now(),
            rawBody: body,
            status: 'brokered',
            attempt: 1,
            metadata: {
              source: 'telegram-poller',
              from: sender,
              updateId,
              telegramMessageId: messageId,
              chatId: Number.isFinite(Number(metadata?.chatId))
                ? Number(metadata.chatId)
                : null,
              windowKey: inboundWindowKey,
              sessionScopeId: inboundSessionScopeId,
              mediaKind: typeof media?.kind === 'string' ? media.kind : null,
              telegramFileId: typeof media?.fileId === 'string' ? media.fileId : null,
              telegramFilePath: typeof media?.telegramFilePath === 'string' ? media.telegramFilePath : null,
              mediaMimeType: typeof media?.mimeType === 'string' ? media.mimeType : null,
              mediaFileName: typeof media?.fileName === 'string' ? media.fileName : null,
              downloadedFilePath: archivePath,
              latestScreenshotPath: typeof media?.latestScreenshotPath === 'string'
                ? media.latestScreenshotPath
                : null,
            },
          },
          {
            source: {
              via: 'telegram-poller',
              role: 'system',
              paneId: 'system',
            },
          }
        )).then((result) => {
          if (result?.ok === false) {
            log.warn('EvidenceLedger', `Telegram inbound journal upsert failed: ${result.reason || 'unknown'}`);
          } else {
            log.info('Telegram', `Telegram inbound journaled as ${inboundMessageId}`);
          }
        }).catch((err) => {
          log.warn('EvidenceLedger', `Telegram inbound journal upsert error: ${err.message}`);
        });
        const formattedBody = archivePath ? `${body} | saved: ${archivePath}` : body;
        const fullTelegramMessage = `[Telegram from ${sender}]: ${formattedBody}`;
        const telegramMsgBytes = Buffer.byteLength(fullTelegramMessage, 'utf8');
        const TELEGRAM_MSG_SIZE_LIMIT = 256 * 1024; // 256 KB
        if (telegramMsgBytes > TELEGRAM_MSG_SIZE_LIMIT) {
          log.warn('Telegram', `Oversized message from ${sender} (${telegramMsgBytes} bytes > ${TELEGRAM_MSG_SIZE_LIMIT}). Truncating.`);
        }
        const safeMessage = telegramMsgBytes > TELEGRAM_MSG_SIZE_LIMIT
          ? fullTelegramMessage.slice(0, TELEGRAM_MSG_SIZE_LIMIT) + '\n[...truncated — full text in evidence ledger]'
          : fullTelegramMessage;
        void this.deliverHumanMessageWithRecall(
          safeMessage,
          {
            paneId: '1',
            role: 'architect',
            windowKey: inboundWindowKey,
            channel: 'telegram',
            sender,
            messageId: inboundMessageId,
            chatId: metadata?.chatId,
            telegramChatId: metadata?.chatId,
            metadata: {
              ...(metadata && typeof metadata === 'object' ? metadata : {}),
              windowKey: inboundWindowKey,
              sessionScopeId: inboundSessionScopeId,
            },
            header: 'MESSAGE RECALL',
          },
          'Telegram'
        );
      },
    });

    if (started) {
      log.info('Telegram', 'Inbound Telegram bridge enabled');
    }
  }

  async handleTeamMemoryGuardExperiment(entry = {}) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'invalid_guard_action' };
    if (String(entry.action || '').toLowerCase() !== 'block') return { ok: false, reason: 'not_block_action' };
    const experimentReady = await this.ensureExperimentInitialized('guard-block');
    if (!experimentReady) return { ok: false, reason: 'experiment_unavailable' };

    const event = (entry.event && typeof entry.event === 'object') ? entry.event : {};
    const claimId = String(event.claimId || event.claim_id || '').trim();
    const claimStatus = String(event.status || '').trim().toLowerCase();
    if (!claimId) return { ok: false, reason: 'claim_id_missing' };
    if (claimStatus !== 'contested' && claimStatus !== 'pending_proof') {
      return { ok: false, reason: 'claim_not_contested' };
    }

    const scope = String(event.scope || event.file || '').trim();
    const requestedBy = String(event.agent || event.owner || 'system').trim() || 'system';
    const session = String(event.session || '').trim() || null;
    const idempotencyKey = `guard-block:${entry.guardId || 'unknown'}:${claimId}:${session || 'none'}`;

    const runResult = await experiment.executeExperimentOperation('run-experiment', {
      profileId: TEAM_MEMORY_BLOCK_GUARD_PROFILE,
      claimId,
      requestedBy,
      session,
      idempotencyKey,
      guardContext: {
        guardId: entry.guardId || null,
        action: 'block',
        blocking: true,
      },
      scope: scope || null,
      input: {
        args: {},
      },
    });

    if (!runResult?.ok) {
      log.warn(
        'TeamMemoryGuard',
        `Block guard failed to queue experiment for claim ${claimId}: ${runResult?.reason || 'unknown'}`
      );
      return {
        ok: false,
        reason: runResult?.reason || 'experiment_queue_failed',
        runResult,
      };
    }

    const statusUpdate = await teamMemory.executeTeamMemoryOperation('update-claim-status', {
      claimId,
      status: 'pending_proof',
      changedBy: requestedBy,
      reason: 'guard_block_experiment_started',
      nowMs: Date.now(),
    });
    if (statusUpdate?.ok === false && statusUpdate.reason !== 'invalid_transition') {
      log.warn(
        'TeamMemoryGuard',
        `Experiment queued but claim ${claimId} pending_proof transition failed: ${statusUpdate.reason || 'unknown'}`
      );
    }

    log.info(
      'TeamMemoryGuard',
      `Queued guard-block experiment for claim ${claimId} (runId=${runResult.runId || 'unknown'}, queued=${runResult.queued === true})`
    );
    return {
      ok: true,
      runResult,
      statusUpdate,
    };
  }

  async shutdown() {
    log.info('App', 'Shutting down SquidRun Application');
    this.shuttingDown = true;
    this.clearPtyDataFlushTimer();
    this.flushBufferedPtyData();
    this.clearPtyVisibleReleaseTimer();
    this.flushVisibleFilteredPtyData(null, { force: true });
    this.clearDaemonConnectTimeout();
    this.clearWebSocketStartRetry();
    if (this.paneHostBootstrapTimer) {
      clearTimeout(this.paneHostBootstrapTimer);
      this.paneHostBootstrapTimer = null;
    }
    if (this.paneHostBootstrapVerifyTimer) {
      clearTimeout(this.paneHostBootstrapVerifyTimer);
      this.paneHostBootstrapVerifyTimer = null;
    }
    try {
      ipcMain.removeHandler('pane-host-inject');
    } catch (_) {
      // no-op
    }
    try {
      ipcMain.removeHandler('pipeline-get-items');
      ipcMain.removeHandler('pipeline-get-active');
      ipcMain.removeHandler('pipeline-mark-committed');
      ipcMain.removeHandler('shared-state-get');
      ipcMain.removeHandler('shared-state-changelog');
      ipcMain.removeHandler('shared-state-mark-seen');
      ipcMain.removeHandler('context-snapshot-refresh');
    } catch (_) {
      // no-op
    }
    if (this.paneHostReadyListener) {
      ipcMain.removeListener('pane-host-ready', this.paneHostReadyListener);
      this.paneHostReadyListener = null;
      this.paneHostReadyIpcRegistered = false;
    }
    if (this.mainWindowSendInterceptInstalled && this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
      try {
        this.ctx.mainWindow.webContents.send = this.mainWindowSendRaw;
      } catch (_) {
        // no-op
      }
    }
    this.mainWindowSendRaw = null;
    this.mainWindowSendInterceptInstalled = false;
    try {
      const sessionEndResult = await this.captureSessionEndState();
      if (sessionEndResult?.ok === false && sessionEndResult?.skipped !== true) {
        log.warn('EvidenceLedger', `Session-end capture failed: ${sessionEndResult.reason || sessionEndResult.error || 'unknown'}`);
      }
    } catch (err) {
      log.warn('EvidenceLedger', `Session-end capture error during shutdown: ${err.message}`);
    }
    this.paneHostWindowManager.closeAllPaneWindows();
    await this.stopAutoHandoffMaterializer({ flush: true });
    contextCompressor.shutdown();
    teamMemory.stopIntegritySweep();
    teamMemory.stopBeliefSnapshotSweep();
    teamMemory.stopPatternMiningSweep();
    if (typeof teamMemory.stopCommsTaggedClaimsSweep === 'function') {
      teamMemory.stopCommsTaggedClaimsSweep();
    }
    try {
      closeSharedRuntime();
    } catch (err) {
      log.warn('EvidenceLedger', `Failed to close shared runtime during shutdown: ${err.message}`);
    }
    try {
      closeSharedCognitiveMemoryRuntime();
    } catch (err) {
      log.warn('CognitiveMemory', `Failed to close shared runtime during shutdown: ${err.message}`);
    }
    experiment.closeExperimentRuntime({ killTimeoutMs: 2000 });
    teamMemory.closeTeamMemoryRuntime({ killTimeoutMs: 2000 }).catch((err) => {
      log.warn('TeamMemory', `Failed to close team memory runtime during shutdown: ${err.message}`);
    });
    websocketServer.stop();
    if (this.bridgeClient) {
      this.bridgeClient.stop();
      this.bridgeClient = null;
    }
    this.backgroundAgentManager.stop();
    this.backgroundAgentManager.killAll({ reason: 'app_shutdown' }).catch((err) => {
      log.warn('BackgroundAgent', `Failed to kill background agents during shutdown: ${err.message}`);
    });
    smsPoller.stop();
    telegramPoller.stop();
    closeCommsJournalStores();
    this.consoleLogWriter.flush().catch((err) => {
      log.warn('App', `Failed flushing console.log buffer during shutdown: ${err.message}`);
    });
    this.stopRuntimeServices('shutdown').catch((err) => {
      log.warn('RuntimeLifecycle', `Failed stopping runtime services during shutdown: ${err.message}`);
    });
    if (powerMonitor && typeof powerMonitor.removeListener === 'function') {
      for (const entry of this.powerMonitorListeners) {
        powerMonitor.removeListener(entry.eventName, entry.handler);
      }
    }
    this.powerMonitorListeners = [];

    if (this.ctx.daemonClient) {
      this.clearDaemonClientListeners(this.ctx.daemonClient);
      this.ctx.daemonClient.disconnect();
    }

    ipcHandlers.cleanup();
    ipcHandlers.cleanupProcesses();
  }
}

module.exports = SquidRunApp;



