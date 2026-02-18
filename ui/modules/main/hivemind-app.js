/**
 * Hivemind Application
 * Main process application controller
 */

const { BrowserWindow, ipcMain, session, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('../logger');
const { getDaemonClient } = require('../../daemon-client');
const { WORKSPACE_PATH, PANE_IDS, ROLE_ID_MAP } = require('../../config');
const { createPluginManager } = require('../plugins');
const { createBackupManager } = require('../backup-manager');
const { createRecoveryManager } = require('../recovery-manager');
const { createExternalNotifier } = require('../external-notifications');
const { createKernelBridge } = require('./kernel-bridge');
const { createPaneHostWindowManager } = require('./pane-host-window-manager');
const AGENT_MESSAGE_PREFIX = '[AGENT MSG - reply via hm-send.js] ';

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
const { sendTelegram } = require('../../scripts/hm-telegram');
const teamMemory = require('../team-memory');
const experiment = require('../experiment');
const {
  materializeSessionHandoff,
  removeLegacyPaneHandoffFiles,
} = require('./auto-handoff-materializer');
const { closeCommsJournalStores } = require('./comms-journal');
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
const { executeTransitionLedgerOperation } = require('../ipc/transition-ledger-handlers');
const { executeGitHubOperation } = require('../ipc/github-handlers');
const { executePaneControlAction } = require('./pane-control-service');
const { captureScreenshot } = require('../ipc/screenshot-handlers');
const { executeContractPromotionAction } = require('../contract-promotion-service');
const { createBufferedFileWriter } = require('../buffered-file-writer');
const IS_DARWIN = process.platform === 'darwin';
const PANE_HOST_BOOTSTRAP_VERIFY_DELAY_MS = IS_DARWIN ? 900 : 1500;
const APP_IDLE_THRESHOLD_MS = 30000;
const CONSOLE_LOG_FLUSH_INTERVAL_MS = 500;
const TELEGRAM_REPLY_WINDOW_MS = Number.parseInt(
  process.env.HIVEMIND_TELEGRAM_REPLY_WINDOW_MS || String(5 * 60 * 1000),
  10
);
const TEAM_MEMORY_BACKFILL_LIMIT = Number.parseInt(process.env.HIVEMIND_TEAM_MEMORY_BACKFILL_LIMIT || '5000', 10);
const TEAM_MEMORY_INTEGRITY_SWEEP_INTERVAL_MS = Number.parseInt(
  process.env.HIVEMIND_TEAM_MEMORY_INTEGRITY_SWEEP_MS || String(24 * 60 * 60 * 1000),
  10
);
const TEAM_MEMORY_BELIEF_SNAPSHOT_INTERVAL_MS = Number.parseInt(
  process.env.HIVEMIND_TEAM_MEMORY_BELIEF_SWEEP_MS || String(5 * 60 * 1000),
  10
);
const TEAM_MEMORY_PATTERN_MINING_INTERVAL_MS = Number.parseInt(
  process.env.HIVEMIND_TEAM_MEMORY_PATTERN_SWEEP_MS || String(60 * 1000),
  10
);
const TEAM_MEMORY_BLOCK_GUARD_PROFILE = String(process.env.HIVEMIND_TEAM_MEMORY_BLOCK_GUARD_PROFILE || 'jest-suite').trim() || 'jest-suite';
const APP_STARTUP_SESSION_RETRY_LIMIT = 3;
const AUTO_HANDOFF_INTERVAL_MS = Number.parseInt(process.env.HIVEMIND_AUTO_HANDOFF_INTERVAL_MS || '30000', 10);
const AUTO_HANDOFF_ENABLED = process.env.HIVEMIND_AUTO_HANDOFF_ENABLED !== '0';
const TEAM_MEMORY_TAGGED_CLAIM_SWEEP_INTERVAL_MS = Number.parseInt(
  process.env.HIVEMIND_TEAM_MEMORY_TAGGED_CLAIM_SWEEP_MS || '30000',
  10
);
const WEBSOCKET_START_RETRY_BASE_MS = Number.parseInt(
  process.env.HIVEMIND_WEBSOCKET_START_RETRY_BASE_MS || '500',
  10
);
const WEBSOCKET_START_RETRY_MAX_MS = Number.parseInt(
  process.env.HIVEMIND_WEBSOCKET_START_RETRY_MAX_MS || '10000',
  10
);

function asPositiveInt(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return fallback;
  return numeric;
}

class HivemindApp {
  constructor(appContext, managers) {
    this.ctx = appContext;
    this.settings = managers.settings;
    this.activity = managers.activity;
    this.usage = managers.usage;
    this.cliIdentity = managers.cliIdentity;
    this.firmwareManager = managers.firmwareManager;
    this.kernelBridge = createKernelBridge(() => this.ctx.mainWindow);
    this.paneHostWindowManager = createPaneHostWindowManager({
      getCurrentSettings: () => this.ctx.currentSettings || {},
    });
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
    };
    this.powerMonitorListeners = [];
    this.lastSystemSuspendAtMs = null;
    this.lastSystemResumeAtMs = null;
    this.wakeRecoveryInFlight = false;
    this.autoHandoffTimer = null;
    this.autoHandoffWriteInFlight = false;
    this.autoHandoffEnabled = AUTO_HANDOFF_ENABLED && process.env.NODE_ENV !== 'test';
    this.paneHostReady = new Set();
    this.paneHostMissingPanes = new Set();
    this.paneHostLastErrorReason = null;
    this.paneHostLastErrorAt = null;
    this.paneHostBootstrapTimer = null;
    this.paneHostBootstrapVerifyTimer = null;
    this.paneHostReadyIpcRegistered = false;
    this.paneHostReadyListener = null;
    this.mainWindowSendRaw = null;
    this.mainWindowSendInterceptInstalled = false;
    this.websocketStartRetryTimer = null;
    this.websocketStartRetryAttempt = 0;
    this.shuttingDown = false;
  }

  async initializeStartupSessionScope(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const startupSource = {
      via: 'app-startup',
      role: 'system',
      paneId: null,
    };
    const fallbackScope = `app-${process.pid}-${Date.now()}`;
    this.commsSessionScopeId = fallbackScope;

    const preferredSessionNumber = asPositiveInt(opts.sessionNumber ?? opts.session, null);

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
      const sessionNumber = nextSessionNumber + attempt;
      const startResult = await executeEvidenceLedgerOperation(
        'record-session-start',
        {
          sessionNumber,
          mode: 'APP',
          meta: {
            source: 'hivemind-app',
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
        this.commsSessionScopeId = sessionId
          ? `app-session-${sessionNumber}-${sessionId}`
          : `app-session-${sessionNumber}`;

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
        return this.ledgerAppSession;
      }

      if (startResult?.reason !== 'conflict') {
        log.warn('EvidenceLedger', `Startup session start failed: ${startResult?.reason || 'unknown'}`);
        break;
      }
    }

    log.warn('EvidenceLedger', `Falling back to ephemeral comms session scope (${fallbackScope})`);
    return null;
  }

  getCurrentAppStatusSessionNumber() {
    try {
      if (!this.settings || typeof this.settings.readAppStatus !== 'function') return null;
      const status = this.settings.readAppStatus();
      return asPositiveInt(status?.session ?? status?.sessionNumber, null);
    } catch {
      return null;
    }
  }

  isHiddenPaneHostModeEnabled() {
    if (process.env.HIVEMIND_HIDDEN_PANE_HOSTS === '1') return true;
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

    const missingWindows = paneIds.filter((paneId) => !this.paneHostWindowManager.getPaneWindow(paneId));
    const missingReady = paneIds.filter((paneId) => !this.paneHostReady.has(String(paneId)));

    if (missingWindows.length === 0 && missingReady.length === 0) {
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

    this.paneHostBootstrapTimer = setTimeout(() => {
      this.paneHostBootstrapTimer = null;
      void this.ensurePaneHostWindows().finally(() => {
        this.paneHostBootstrapVerifyTimer = setTimeout(() => {
          this.paneHostBootstrapVerifyTimer = null;
          this.verifyPaneHostWindowsAfterBootstrap('createWindow');
        }, PANE_HOST_BOOTSTRAP_VERIFY_DELAY_MS);
      });
    }, 0);
  }

  sendPaneHostMessage(paneId, channel, payload = {}) {
    if (!this.isHiddenPaneHostModeEnabled()) return false;
    return this.paneHostWindowManager.sendToPaneWindow(String(paneId), channel, {
      ...payload,
      paneId: String(paneId),
    });
  }

  sendToVisibleWindow(channel, payload) {
    const window = this.ctx.mainWindow;
    if (!window || window.isDestroyed()) return false;
    const sender = typeof this.mainWindowSendRaw === 'function'
      ? this.mainWindowSendRaw
      : window.webContents.send.bind(window.webContents);
    sender(channel, payload);
    return true;
  }

  installMainWindowSendInterceptor() {
    const window = this.ctx.mainWindow;
    if (!window || window.isDestroyed() || !window.webContents) return;
    if (this.mainWindowSendInterceptInstalled) return;

    const originalSend = window.webContents.send.bind(window.webContents);
    this.mainWindowSendRaw = originalSend;
    window.webContents.send = (channel, payload, ...rest) => {
      if (channel === 'inject-message' && this.isHiddenPaneHostModeEnabled()) {
        // If triggers.js already tried routeInjectMessage and it failed,
        // don't re-attempt — just deliver to visible renderer directly.
        if (payload?._routerAttempted) {
          const clean = { ...payload };
          delete clean._routerAttempted;
          return originalSend(channel, clean, ...rest);
        }
        const handled = this.routeInjectMessage(payload || {});
        if (handled) return;
      }
      return originalSend(channel, payload, ...rest);
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
      this.sendPaneHostMessage(paneId, 'pane-host:prime-scrollback', { paneId, scrollback });
    }
  }

  routeInjectMessage(payload = {}) {
    if (!payload || typeof payload !== 'object') return false;
    const panes = Array.isArray(payload.panes)
      ? payload.panes.map((paneId) => String(paneId))
      : [];
    if (panes.length === 0) return false;

    if (!this.isHiddenPaneHostModeEnabled()) {
      return this.sendToVisibleWindow('inject-message', payload);
    }

    let routed = false;
    for (const paneId of panes) {
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
        const routedToHost = this.sendPaneHostMessage(paneId, 'pane-host:inject-message', {
          message: payload.message,
          deliveryId: payload.deliveryId || null,
          traceContext: payload.traceContext || null,
          meta: payload.meta || null,
        });
        if (routedToHost) {
          routed = true;
          this.clearPaneHostDegraded(paneId);
          log.info('PaneHost', `Routed inject to hidden window for pane ${paneId}`);
          continue;
        }
      }

      const fallbackMeta = (payload.meta && typeof payload.meta === 'object')
        ? { ...payload.meta }
        : {};
      fallbackMeta.deliveryPath = 'visible_fallback';
      fallbackMeta.hiddenHostReady = hostReady;
      fallbackMeta.hiddenHostWindowPresent = hostWindowPresent;
      fallbackMeta.hiddenHostLoading = hostLoading;

      const routedToVisible = this.sendToVisibleWindow('inject-message', {
        ...payload,
        panes: [paneId],
        meta: fallbackMeta,
      });

      if (routedToVisible) {
        routed = true;
        this.reportPaneHostDegraded({
          paneId,
          reason: canRouteToHiddenHost ? 'inject_hidden_send_failed' : 'inject_hidden_not_ready',
          message: `Hidden pane host unavailable/not ready for pane ${paneId}. Routed inject via visible renderer fallback.`,
          details: {
            deliveryId: payload.deliveryId || null,
            hiddenHostReady: hostReady,
            hiddenHostWindowPresent: hostWindowPresent,
            hiddenHostLoading: hostLoading,
            fallback: 'visible_renderer',
          },
        });
        log.warn('PaneHost', `Hidden-host inject fallback via visible renderer for pane ${paneId}`);
      } else {
        this.reportPaneHostDegraded({
          paneId,
          reason: 'inject_fallback_visible_unavailable',
          message: `Hidden pane host unavailable for pane ${paneId}; visible renderer fallback also unavailable. Delivery FAILED.`,
          details: {
            deliveryId: payload.deliveryId || null,
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
      const paneId = String(payload?.paneId || '').trim();
      if (!paneId) return;
      this.paneHostReady.add(paneId);
      this.clearPaneHostDegraded(paneId);
      this.updatePaneHostStatus();
      const terminal = this.ctx.daemonClient?.getTerminal?.(paneId);
      if (terminal?.scrollback) {
        this.sendPaneHostMessage(paneId, 'pane-host:prime-scrollback', {
          paneId,
          scrollback: terminal.scrollback,
        });
      }
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
    log.info('App', 'Initializing Hivemind Application');

    // 1. Load settings
    this.settings.loadSettings();

    // 2. Create main window as early as possible so users see immediate startup feedback.
    await this.createWindow();

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

    // 5. Pre-configure Codex
    this.settings.ensureCodexConfig();

    // 6. Defer non-critical worker runtimes until first use.
    // Keep startup focused on rendering + core watchers.
    log.info(
      'App',
      'Deferring startup worker prewarm (evidence-ledger/team-memory/experiment/comms) until first use'
    );

    // 7. Setup external notifications
    this.ctx.setExternalNotifier(createExternalNotifier({
      getSettings: () => this.ctx.currentSettings,
      log,
      appName: 'Hivemind',
    }));

    ipcHandlers.setExternalNotifier(this.ctx.externalNotifier);
    if (watcher && typeof watcher.setExternalNotifier === 'function') {
      watcher.setExternalNotifier((payload) => this.ctx.externalNotifier?.notify(payload));
    }

    // 8. Load activity log
    this.activity.loadActivityLog();

    // 9. Load usage stats
    this.usage.loadUsageStats();

    // 10. Initialize PTY daemon connection (heavy startup work begins after window is shown).
    await this.initDaemonClient();
    const didSpawnDuringLastConnect = this.ctx.daemonClient?.didSpawnDuringLastConnect?.() === true;
    this.settings.writeAppStatus({
      incrementSession: didSpawnDuringLastConnect,
    });
    if (didSpawnDuringLastConnect) {
      await this.initializeStartupSessionScope({
        sessionNumber: this.getCurrentAppStatusSessionNumber(),
      });
    }

    // 11. Register sleep/wake listeners for laptop resilience.
    this.setupPowerMonitorListeners();

    // 12. Setup global IPC forwarders
    this.ensureCliIdentityForwarder();
    this.ensureTriggerDeliveryAckForwarder();

    // 13. Start WebSocket server for instant agent messaging
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

            const marker = '[PROJECT CONTEXT]';
            if (text.includes(marker)) return text;

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

          // Route WebSocket messages via triggers module (handles delivery)
          if (data.message.type === 'send') {
            const { target, content } = data.message;
            const contentWithProjectContext = withProjectContext(content, data.message.metadata);
            const attempt = Number(data.message.attempt || 1);
            const maxAttempts = Number(data.message.maxAttempts || 1);
            const messageId = data.message.messageId || null;
            const traceContext = data.traceContext || data.message.traceContext || null;
            const nowMs = Date.now();
            const targetPaneIdForJournal = this.resolveTargetToPane(target);
            const targetRoleForJournal = (() => {
              if (targetPaneIdForJournal === '1') return 'architect';
              if (targetPaneIdForJournal === '2') return 'builder';
              if (targetPaneIdForJournal === '5') return 'oracle';
              if (this.isTelegramReplyTarget(target)) return this.normalizeOutboundTarget(target);
              return null;
            })();

            if (messageId) {
              const journalResult = await executeEvidenceLedgerOperation(
                'upsert-comms-journal',
                {
                  messageId,
                  sessionId: this.commsSessionScopeId || null,
                  senderRole: data.role || 'unknown',
                  targetRole: targetRoleForJournal,
                  channel: 'ws',
                  direction: 'outbound',
                  sentAtMs: Number(data.message.sentAtMs || data.message.timestamp || nowMs),
                  brokeredAtMs: nowMs,
                  rawBody: typeof content === 'string' ? content : String(content ?? ''),
                  status: 'brokered',
                  attempt,
                  metadata: {
                    source: 'websocket-broker',
                    targetRaw: target || null,
                    traceId: traceContext?.traceId || traceContext?.correlationId || null,
                    project: data.message?.metadata?.project || null,
                    maxAttempts,
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
                messageId,
                target: target || null,
                attempt,
                maxAttempts,
              }, 'system', traceContext);
            } else if (attempt > 1) {
              emitKernelCommsEvent('comms.retry.attempted', {
                messageId,
                target: target || null,
                attempt,
                maxAttempts,
              }, 'system', traceContext);
            }

            const telegramReplyTarget = this.isTelegramReplyTarget(target);
            if (telegramReplyTarget) {
              const normalizedTarget = this.normalizeOutboundTarget(target);
              const preflight = await this.evaluateTeamMemoryGuardPreflight({
                target: normalizedTarget,
                content,
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
                content,
                fromRole: data.role || 'unknown',
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
              return {
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

              log.info('WebSocket', `Routing 'send' to pane ${paneId} (via triggers)`);
              const result = await triggers.sendDirectMessage(
                [String(paneId)],
                withAgentPrefix(contentWithProjectContext),
                data.role || 'unknown',
                { traceContext, awaitDelivery: true }
              );
              await this.recordDeliveryOutcomePattern({
                channel: 'send',
                target: String(paneId),
                fromRole: data.role || 'unknown',
                result,
                traceContext,
              });
              return {
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
    this.startTelegramPoller();
    this.startAutoHandoffMaterializer();

    log.info('App', 'Initialization complete');
  }

  runAutoHandoffMaterializer(reason = 'timer') {
    if (!this.autoHandoffEnabled) {
      return { ok: false, reason: 'disabled' };
    }
    if (this.autoHandoffWriteInFlight) {
      return { ok: false, reason: 'in_flight' };
    }

    this.autoHandoffWriteInFlight = true;
    try {
      const result = materializeSessionHandoff({
        sessionId: this.commsSessionScopeId || null,
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
    }
  }

  startAutoHandoffMaterializer() {
    if (!this.autoHandoffEnabled) {
      return;
    }
    this.stopAutoHandoffMaterializer({ flush: false });

    const cleanup = removeLegacyPaneHandoffFiles({ ignoreErrors: true });
    if (cleanup?.removed?.length > 0) {
      log.info('AutoHandoff', `Removed legacy pane handoff files (${cleanup.removed.length})`);
    }
    if (cleanup?.failed?.length > 0) {
      for (const failure of cleanup.failed) {
        log.warn('AutoHandoff', `Failed removing legacy handoff file ${failure.path}: ${failure.error}`);
      }
    }

    this.runAutoHandoffMaterializer('startup');
    const intervalMs = Math.max(5000, Number.isFinite(AUTO_HANDOFF_INTERVAL_MS) ? AUTO_HANDOFF_INTERVAL_MS : 30000);
    this.autoHandoffTimer = setInterval(() => {
      this.runAutoHandoffMaterializer('timer');
    }, intervalMs);
  }

  stopAutoHandoffMaterializer(options = {}) {
    if (this.autoHandoffTimer) {
      clearInterval(this.autoHandoffTimer);
      this.autoHandoffTimer = null;
    }

    if (options.flush === true && this.autoHandoffEnabled) {
      this.runAutoHandoffMaterializer('shutdown');
    }
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
    teamMemory.startBeliefSnapshotSweep({
      intervalMs: TEAM_MEMORY_BELIEF_SNAPSHOT_INTERVAL_MS,
      immediate: true,
    });
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
    this.ctx.mainWindow = new BrowserWindow({
      width: 1400,
      height: 800,
      icon: path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'hivemind-icon.ico' : 'hivemind-icon.png'),
      backgroundColor: '#0a0a0f',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        preload: path.join(__dirname, '..', '..', 'preload.js'),
      },
      title: 'Hivemind',
    });

    this.installMainWindowSendInterceptor();
    this.ensurePaneHostReadyForwarder();
    this.setupPermissions();

    // Register IPC handlers and load listeners before renderer startup to avoid startup races.
    this.initModules();
    this.setupWindowListeners();

    this.ctx.mainWindow.loadFile('index.html');

    // Hidden pane host windows are non-critical; defer to a separate task so
    // main-window listeners/post-load init always install first.
    this.schedulePaneHostBootstrap();

    if (this.ctx.currentSettings.devTools) {
      this.ctx.mainWindow.webContents.openDevTools();
    }
  }

  setupPermissions() {
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {   
      const allowedPermissions = ['media', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write'];       
      const mediaTypes = details?.mediaTypes || [];
      if (allowedPermissions.includes(permission) || mediaTypes.includes('audio')) {
        return true;
      }
      return false;
    });

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowedPermissions = ['media', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write'];       
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
    ipcMain.handle('pane-host-inject', async (_event, paneId, payload = {}) => {
      const id = String(paneId || '').trim();
      if (!id) {
        return { success: false, reason: 'missing_pane_id' };
      }
      if (!this.isHiddenPaneHostModeEnabled()) {
        return { success: false, reason: 'hidden_hosts_disabled' };
      }
      const sent = this.sendPaneHostMessage(id, 'pane-host:inject-message', {
        message: payload?.message || '',
        deliveryId: payload?.deliveryId || null,
        traceContext: payload?.traceContext || null,
        meta: payload?.meta || null,
      });
      return sent
        ? { success: true, paneId: id, mode: 'pane-host' }
        : { success: false, reason: 'pane_host_unavailable', paneId: id };
    });

    // Direct Enter dispatch for hidden pane hosts — bypasses pty-write IPC handler
    // to use the same direct daemonClient.write path as the working Enter button.
    ipcMain.removeHandler('pane-host-dispatch-enter');
    ipcMain.handle('pane-host-dispatch-enter', (_event, paneId) => {
      const id = String(paneId || '').trim();
      if (!id) {
        return { success: false, reason: 'missing_pane_id' };
      }
      const dc = this.ctx.daemonClient;
      if (!dc || !dc.connected) {
        return { success: false, reason: 'daemon_not_connected', paneId: id };
      }
      dc.write(id, '\r');
      return { success: true, paneId: id };
    });

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
    });

    // Pipeline
    pipeline.init({
      mainWindow: window,
      sendDirectMessage: (targets, message, fromRole) => triggers.sendDirectMessage(targets, message, fromRole),
    });
    // Pipeline IPC handlers
    ipcMain.handle('pipeline-get-items', (event, stageFilter) => {
      return pipeline.getItems(stageFilter || null);
    });
    ipcMain.handle('pipeline-get-active', () => {
      return pipeline.getActiveItems();
    });
    ipcMain.handle('pipeline-mark-committed', (event, itemId) => {
      return pipeline.markCommitted(itemId);
    });

    // Shared State (P3)
    sharedState.init({
      watcher,
      mainWindow: window,
    });

    // Shared State IPC handlers
    ipcMain.handle('shared-state-get', () => {
      return sharedState.getState();
    });
    ipcMain.handle('shared-state-changelog', (event, { paneId, since } = {}) => {
      if (paneId) return sharedState.getChangelogForPane(paneId);
      return sharedState.getChangesSince(since || 0);
    });
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

      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('daemon-connected', { terminals });
      }
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

  setupWindowListeners() {
    const window = this.ctx.mainWindow;

    window.webContents.on('did-finish-load', async () => {
      await this.initPostLoad();
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

  async initPostLoad() {
    const window = this.ctx.mainWindow;

    const initAfterLoad = async (attempt = 1) => {
      try {
        watcher.startWatcher();
        watcher.startTriggerWatcher();
        watcher.startMessageWatcher();

        const state = watcher.readState();
        if (window && !window.isDestroyed()) {
          window.webContents.send('state-changed', state);
        }

        // Connect if not already connected, or resend state if already connected
        if (this.ctx.daemonClient) {
          if (!this.ctx.daemonClient.connected) {
            await this.ctx.daemonClient.connect();
          } else {
            // Daemon already connected before renderer loaded - resend the event
            log.info('App', 'Resending daemon-connected to renderer (was connected before load)');
            const terminals = this.ctx.daemonClient.getTerminals?.() || [];
            window.webContents.send('daemon-connected', {
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
    // Re-inits happen on reload; clear previously attached singleton listeners first.
    this.clearDaemonClientListeners(this.ctx.daemonClient);
    this.ctx.daemonClient = getDaemonClient();

    // Update IPC handlers with daemon client
    ipcHandlers.setDaemonClient(this.ctx.daemonClient);

    const handlePaneExit = (paneId, code) => {
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
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send(`pty-exit-${paneId}`, code);
      }
      this.sendPaneHostMessage(paneId, 'pane-host:pty-exit', { paneId, code });
    };

    this.attachDaemonClientListener('data', (paneId, data) => {
      this.lastDaemonOutputAtMs = Date.now();
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

      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send(`pty-data-${paneId}`, data);
      }
      this.sendPaneHostMessage(paneId, 'pane-host:pty-data', { paneId, data });

      if (data.includes('Error') || data.includes('error:') || data.includes('FAILED')) {
        this.activity.logActivity('error', paneId, 'Terminal error detected', { snippet: data.substring(0, 200) }
);
      } else if (data.includes('✅') || data.includes('DONE') || data.includes('Complete')) {
        this.activity.logActivity('terminal', paneId, 'Completion indicator detected', { snippet: data.substring(
0, 100) });
      }

      const currentState = this.ctx.agentRunning.get(paneId);
      if (currentState === 'starting' || currentState === 'idle') {
        const lower = data.toLowerCase();
        if (lower.includes('>') || lower.includes('claude') || lower.includes('codex') || lower.includes('gemini') || lower.includes('cursor')) {
          this.ctx.agentRunning.set(paneId, 'running');
          organicUI.agentOnline(paneId);
          this.ctx.pluginManager?.dispatch('agent:stateChanged', { paneId: String(paneId), state: 'running' })
            .catch(err => log.error('Plugins', `Error in agent:stateChanged hook: ${err.message}`));
          this.broadcastClaudeState();
          this.activity.logActivity('state', paneId, 'Agent started', { status: 'running' });
          log.info('Agent', `Pane ${paneId} now running`);
        }
      }
    });

    this.attachDaemonClientListener('exit', (paneId, code) => {
      handlePaneExit(paneId, code);
    });

    this.attachDaemonClientListener('spawned', (paneId, pid) => {
      log.info('Daemon', `Terminal spawned for pane ${paneId}, PID: ${pid}`);
      const command = this.cliIdentity.getPaneCommandForIdentity(String(paneId));
      this.cliIdentity.inferAndEmitCliIdentity(paneId, command);
      this.ctx.recoveryManager?.recordActivity(paneId);
    });

    this.attachDaemonClientListener('connected', (terminals) => {
      log.info('Daemon', `Connected. Existing terminals: ${terminals.length}`);

      if (terminals && terminals.length > 0) {
        for (const term of terminals) {
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
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('daemon-connected', {
          terminals
        });
      }
      this.primePaneHostFromTerminalSnapshot(terminals);

      this.kernelBridge.emitBridgeEvent('bridge.connected', {
        transport: 'daemon-client',
        terminalCount: terminals?.length || 0,
      });
    });

    this.attachDaemonClientListener('disconnected', () => {
      log.warn('Daemon', 'Disconnected');
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('daemon-disconnected');
      }
      this.kernelBridge.emitBridgeEvent('bridge.disconnected', {
        transport: 'daemon-client',
      });
    });

    this.attachDaemonClientListener('reconnected', () => {
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('daemon-reconnected');
      }
      this.kernelBridge.emitBridgeEvent('bridge.connected', {
        transport: 'daemon-client',
        resumed: true,
      });
    });

    this.attachDaemonClientListener('kernel-event', (eventData) => {
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

    return this.ctx.daemonClient.connect();
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
      if (data?.deliveryId) triggers.handleDeliveryAck(data.deliveryId, data.paneId);
    });
    ipcMain.on('trigger-delivery-outcome', (event, data) => {
      if (data?.deliveryId) triggers.handleDeliveryOutcome(data.deliveryId, data.paneId, data);
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
    const event = buildSessionLifecyclePatternEvent({
      paneId,
      status,
      exitCode,
      reason,
      nowMs: Date.now(),
    });
    if (!event) return;
    await this.appendTeamMemoryPatternEvent(event, 'session-lifecycle');
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
   * Resolve target (role name or paneId) to numeric paneId
   * @param {string} target - Role name (e.g., 'architect') or paneId (e.g., '1')
   * @returns {string|null} paneId or null if not found
   */
  resolveTargetToPane(target) {
    if (!target) return null;

    const targetLower = target.toLowerCase();

    // Direct paneId
    if (PANE_IDS.includes(target)) {
      return target;
    }

    // Role name lookup
    if (ROLE_ID_MAP[targetLower]) {
      return ROLE_ID_MAP[targetLower];
    }

    // Legacy aliases
    const legacyMap = {
      lead: '1',
      orchestrator: '2',
      'worker-b': '2',
      devops: '2',
      backend: '2',
      investigator: '5',
    };
    if (legacyMap[targetLower]) {
      return legacyMap[targetLower];
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

  markTelegramInboundContext(sender = 'unknown') {
    this.telegramInboundContext = {
      lastInboundAtMs: Date.now(),
      sender: typeof sender === 'string' && sender.trim() ? sender.trim() : 'unknown',
    };
    return this.telegramInboundContext;
  }

  hasRecentTelegramInbound(nowMs = Date.now()) {
    const lastInboundAtMs = Number(this.telegramInboundContext?.lastInboundAtMs || 0);
    if (!Number.isFinite(lastInboundAtMs) || lastInboundAtMs <= 0) return false;
    return (nowMs - lastInboundAtMs) <= TELEGRAM_REPLY_WINDOW_MS;
  }

  async routeTelegramReply({ target, content, fromRole = 'system' } = {}) {
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
      const result = await sendTelegram(message, process.env, {
        senderRole: fromRole,
        sessionId: this.commsSessionScopeId || null,
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

        const formatted = `[SMS from ${sender}]: ${body}`;
        const result = triggers.sendDirectMessage(['1'], formatted, null);
        if (!result?.success) {
          log.warn('SMS', `Failed to inject inbound SMS into pane 1 (${result?.error || 'unknown'})`);
        }
      },
    });

    if (started) {
      log.info('SMS', 'Inbound SMS bridge enabled');
    }
  }

  startTelegramPoller() {
    const started = telegramPoller.start({
      onMessage: (text, from, metadata = {}) => {
        const sender = typeof from === 'string' && from.trim() ? from.trim() : 'unknown';
        const body = typeof text === 'string' ? text.trim() : '';
        if (!body) return;

        this.markTelegramInboundContext(sender);
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
            sessionId: this.commsSessionScopeId || null,
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
          }
        }).catch((err) => {
          log.warn('EvidenceLedger', `Telegram inbound journal upsert error: ${err.message}`);
        });
        const formatted = `[Telegram from ${sender}]: ${body}`;
        const result = triggers.sendDirectMessage(['1'], formatted, null);
        if (!result?.success) {
          log.warn('Telegram', `Failed to inject inbound Telegram into pane 1 (${result?.error || 'unknown'})`);
        }
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

  shutdown() {
    log.info('App', 'Shutting down Hivemind Application');
    this.shuttingDown = true;
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
    this.paneHostWindowManager.closeAllPaneWindows();
    this.stopAutoHandoffMaterializer({ flush: true });
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
    experiment.closeExperimentRuntime({ killTimeoutMs: 2000 });
    teamMemory.closeTeamMemoryRuntime({ killTimeoutMs: 2000 }).catch((err) => {
      log.warn('TeamMemory', `Failed to close team memory runtime during shutdown: ${err.message}`);
    });
    websocketServer.stop();
    smsPoller.stop();
    telegramPoller.stop();
    closeCommsJournalStores();
    this.consoleLogWriter.flush().catch((err) => {
      log.warn('App', `Failed flushing console.log buffer during shutdown: ${err.message}`);
    });
    watcher.stopWatcher();
    watcher.stopTriggerWatcher();
    watcher.stopMessageWatcher();
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

module.exports = HivemindApp;
