/**
 * Hivemind Application
 * Main process application controller
 */

const { BrowserWindow, ipcMain, session } = require('electron');
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
const teamMemory = require('../team-memory');
const experiment = require('../experiment');
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
  initializeEvidenceLedgerRuntime,
  closeSharedRuntime,
} = require('../ipc/evidence-ledger-handlers');
const { executeContractPromotionAction } = require('../contract-promotion-service');
const { createBufferedFileWriter } = require('../buffered-file-writer');
const APP_IDLE_THRESHOLD_MS = 30000;
const CONSOLE_LOG_FLUSH_INTERVAL_MS = 500;
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
    this.contextInjection = managers.contextInjection;
    this.kernelBridge = createKernelBridge(() => this.ctx.mainWindow);
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
    this.experimentInitialized = false;
    this.intentStateByPane = new Map();
    this.ledgerAppSession = null;
    this.commsSessionScopeId = `app-${process.pid}-${Date.now()}`;
  }

  async initializeStartupSessionScope() {
    const startupSource = {
      via: 'app-startup',
      role: 'system',
      paneId: null,
    };
    const fallbackScope = `app-${process.pid}-${Date.now()}`;
    this.commsSessionScopeId = fallbackScope;

    let nextSessionNumber = 1;
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

  async init() {
    log.info('App', 'Initializing Hivemind Application');

    // 1. Load settings
    this.settings.loadSettings();

    // 2. Auto-detect installed CLIs and patch invalid paneCommands (startup only)
    if (typeof this.settings.autoDetectPaneCommandsOnStartup === 'function') {
      this.settings.autoDetectPaneCommandsOnStartup();
    }

    // 3. Pre-configure Codex
    this.settings.ensureCodexConfig();

    // 4. Initialize Evidence Ledger runtime early (DB + optional seed)
    const ledgerInit = await initializeEvidenceLedgerRuntime({
      runtimeOptions: {
        seedOptions: {
          enabled: true,
        },
      },
      recreateUnavailable: true,
    });
    if (ledgerInit.ok) {
      log.info('EvidenceLedger', `Startup initialization ready (driver=${ledgerInit.status?.driver || 'unknown'})`);
    } else {
      log.warn('EvidenceLedger', `Startup initialization degraded: ${ledgerInit.status?.degradedReason || ledgerInit.initResult?.reason || 'unavailable'}`);
    }

    // 4b. Initialize Team Memory runtime foundation (Phase 0).
    const teamMemoryInit = await teamMemory.initializeTeamMemoryRuntime({
      runtimeOptions: {},
      recreateUnavailable: true,
    });
    this.teamMemoryInitialized = teamMemoryInit?.ok === true;
    if (this.teamMemoryInitialized) {
      log.info('TeamMemory', `Startup initialization ready (driver=${teamMemoryInit.status?.driver || 'unknown'})`);
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
    } else {
      log.warn('TeamMemory', `Startup initialization degraded: ${teamMemoryInit?.status?.degradedReason || teamMemoryInit?.initResult?.reason || 'unavailable'}`);
    }

    // 4c. Initialize Experiment runtime foundation (Phase 6a).
    const experimentInit = await experiment.initializeExperimentRuntime({
      runtimeOptions: {},
      recreateUnavailable: true,
    });
    this.experimentInitialized = experimentInit?.ok === true;
    if (this.experimentInitialized) {
      log.info('Experiment', `Startup initialization ready (driver=${experimentInit.status?.driver || 'worker'})`);
    } else {
      log.warn(
        'Experiment',
        `Startup initialization degraded: ${experimentInit?.status?.degradedReason || experimentInit?.initResult?.reason || 'unavailable'}`
      );
    }

    // 5. Setup external notifications
    this.ctx.setExternalNotifier(createExternalNotifier({
      getSettings: () => this.ctx.currentSettings,
      log,
      appName: 'Hivemind',
    }));

    ipcHandlers.setExternalNotifier(this.ctx.externalNotifier);
    if (watcher && typeof watcher.setExternalNotifier === 'function') {
      watcher.setExternalNotifier((payload) => this.ctx.externalNotifier?.notify(payload));
    }

    // 6. Initial app status
    this.settings.writeAppStatus();

    // 7. Load activity log
    this.activity.loadActivityLog();

    // 8. Load usage stats
    this.usage.loadUsageStats();

    // 8b. Increment Evidence Ledger startup session and bind comms scope.
    await this.initializeStartupSessionScope();

    // 9. Initialize PTY daemon connection
    await this.initDaemonClient();

    // 10. Create main window
    await this.createWindow();

    // 11. Setup global IPC forwarders
    this.ensureCliIdentityForwarder();
    this.ensureTriggerDeliveryAckForwarder();

    // 12. Start WebSocket server for instant agent messaging
    try {
      await websocketServer.start({
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

          if (data.message.type === 'comms-event' || data.message.type === 'comms-metric') {
            return emitKernelCommsEvent(
              data.message.eventType,
              data.message.payload || {},
              data.message?.payload?.paneId || 'system'
            );
          }

          // Handle screenshot requests from agents
          if (data.message.type === 'screenshot') {
            log.info('WebSocket', 'Screenshot request received');
            try {
              if (!this.ctx.mainWindow || this.ctx.mainWindow.isDestroyed()) {
                websocketServer.sendToTarget(data.role || data.clientId, JSON.stringify({
                  type: 'screenshot-result',
                  success: false,
                  error: 'Window not available'
                }));
                return;
              }
              const image = await this.ctx.mainWindow.webContents.capturePage();
              const buffer = image.toPNG();
              const screenshotsDir = path.join(WORKSPACE_PATH, 'screenshots');
              if (!fs.existsSync(screenshotsDir)) {
                fs.mkdirSync(screenshotsDir, { recursive: true });
              }
              const timestamp = Date.now();
              const filename = `capture-${timestamp}.png`;
              const filePath = path.join(screenshotsDir, filename);
              fs.writeFileSync(filePath, buffer);
              const latestPath = path.join(screenshotsDir, 'latest.png');
              fs.writeFileSync(latestPath, buffer);
              log.info('WebSocket', `Screenshot saved to ${filePath}`);
              // Send result back - note: WebSocket clients need to listen for this
              websocketServer.broadcast(JSON.stringify({
                type: 'screenshot-result',
                success: true,
                path: latestPath,
                filename
              }));
            } catch (err) {
              log.error('WebSocket', `Screenshot failed: ${err.message}`);
              websocketServer.broadcast(JSON.stringify({
                type: 'screenshot-result',
                success: false,
                error: err.message
              }));
            }
            return;
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
            const attempt = Number(data.message.attempt || 1);
            const maxAttempts = Number(data.message.maxAttempts || 1);
            const messageId = data.message.messageId || null;
            const traceContext = data.traceContext || data.message.traceContext || null;

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

            const paneId = this.resolveTargetToPane(target);
            if (paneId) {
              const preflight = await this.evaluateTeamMemoryGuardPreflight({
                target: target || String(paneId),
                content,
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
                withAgentPrefix(content),
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
      });
    } catch (err) {
      log.error('WebSocket', `Failed to start server: ${err.message}`);
    }

    this.startSmsPoller();

    log.info('App', 'Initialization complete');
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

    this.setupPermissions();
    this.ctx.mainWindow.loadFile('index.html');

    if (this.ctx.currentSettings.devTools) {
      this.ctx.mainWindow.webContents.openDevTools();
    }

    this.initModules();
    this.setupWindowListeners();
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
      contextInjection: this.ctx.contextInjection,
    });

    ipcHandlers.setupIPCHandlers({
      loadSettings: () => this.settings.loadSettings(),
      saveSettings: (s) => this.settings.saveSettings(s),
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
        if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
          this.ctx.mainWindow.webContents.send('inject-message', {
            panes: [String(paneId)],
            message: `[RECOVERY] Resuming previous task\n${message}\r`,
            meta,
          });
          return true;
        }
        return false;
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
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('codex-activity', { paneId, state, detail });
      }
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
    });
  }

  async appendTeamMemoryPatternEvent(event, label = 'pattern-event') {
    if (!this.teamMemoryInitialized || !event) {
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
    if (!this.teamMemoryInitialized) {
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
    if (!this.teamMemoryInitialized) return;
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
    if (!this.teamMemoryInitialized) return;
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

    if (!this.teamMemoryInitialized) {
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

  startSmsPoller() {
    const started = smsPoller.start({
      onMessage: (text, from) => {
        const sender = typeof from === 'string' && from.trim() ? from.trim() : 'unknown';
        const body = typeof text === 'string' ? text.trim() : '';
        if (!body) return;

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

  async handleTeamMemoryGuardExperiment(entry = {}) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'invalid_guard_action' };
    if (String(entry.action || '').toLowerCase() !== 'block') return { ok: false, reason: 'not_block_action' };
    if (!this.experimentInitialized) return { ok: false, reason: 'experiment_unavailable' };

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
    contextCompressor.shutdown();
    teamMemory.stopIntegritySweep();
    teamMemory.stopBeliefSnapshotSweep();
    teamMemory.stopPatternMiningSweep();
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
    this.consoleLogWriter.flush().catch((err) => {
      log.warn('App', `Failed flushing console.log buffer during shutdown: ${err.message}`);
    });
    watcher.stopWatcher();
    watcher.stopTriggerWatcher();
    watcher.stopMessageWatcher();

    if (this.ctx.daemonClient) {
      this.clearDaemonClientListeners(this.ctx.daemonClient);
      this.ctx.daemonClient.disconnect();
    }

    ipcHandlers.cleanup();
    ipcHandlers.cleanupProcesses();
  }
}

module.exports = HivemindApp;
