/**
 * Daemon Client - Client library for connecting to the terminal daemon
 *
 * Used by Electron main.js to communicate with the terminal daemon.
 * Handles connection, reconnection, and message routing.
 */

const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const log = require('./modules/logger');
const { PANE_ROLES, resolveCoordPath, PIPE_PATH } = require('./config');
const { getProfilePipePath, normalizeProfileName } = require('./profile');
const {
  stripClaudeResumeFlags,
  stripCodexResumeSubcommand,
} = require('./modules/cli-resume-invocation');

// In packaged builds, __dirname points inside app.asar which can't be spawned.
// Resolve to the unpacked copy so child_process.spawn works.
const ASAR_UNPACKED_DIR = __dirname.replace('app.asar', 'app.asar.unpacked');
const DAEMON_SCRIPT = path.join(ASAR_UNPACKED_DIR, 'terminal-daemon.js');
const DAEMON_PID_FILE = resolveCoordPath('runtime/daemon.pid', { forWrite: true });
const PANE_LAUNCH_ID_PATTERN = /^pl_[a-f0-9]{32}$/u;
const APP_GENERATION_PATTERN = /^app-(?:session-\d+|\d+-\d+)(?:[-:][A-Za-z0-9._-]+)?$/u;
const APP_OWNED_RETRY_REASONS = new Set([
  'claude_session_collision',
  'codex_missing_resume',
]);

function normalizePaneLaunchBinding(input = {}) {
  const paneLaunchId = String(input.paneLaunchId || '').trim();
  const appGeneration = String(input.appGeneration || '').trim();
  if (!PANE_LAUNCH_ID_PATTERN.test(paneLaunchId)
    || !APP_GENERATION_PATTERN.test(appGeneration)) {
    return null;
  }
  return { paneLaunchId, appGeneration };
}

function isCanonicalPaneId(paneId) {
  return Object.prototype.hasOwnProperty.call(PANE_ROLES || {}, String(paneId));
}

function paneLaunchBindingsEqual(left, right) {
  return Boolean(left && right
    && left.paneLaunchId === right.paneLaunchId
    && left.appGeneration === right.appGeneration);
}

function normalizePaneProcessId(input = {}) {
  const pid = Number(input.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function ownedPaneLaunchMatches(input, owned) {
  const pid = normalizePaneProcessId(input);
  return Boolean(pid && paneLaunchBindingsEqual(input, owned) && pid === owned?.pid);
}

/**
 * Write the daemon-owned pane-launch record and hand its id to the pane.
 *
 * FAIL OPEN, ALWAYS. A pane that will not start because the Telegram lane could
 * not reach its database is a catastrophically worse outcome than an admission
 * that later refuses for want of a launch record — and refusing is exactly what
 * the admission path does when this is absent, so the failure stays closed
 * where it matters and open where it would hurt.
 *
 * NO GENERATION IS INVENTED HERE. If the app has not put its real generation in
 * the environment, no launch row is written at all: a fabricated generation
 * would produce receipts that pass every check while naming a run that never
 * happened.
 *
 * THE RUNTIME COMES FROM THE COMMAND THAT IS ABOUT TO RUN.
 *
 * This is the repair for the defect that made the whole registry unreachable.
 * The previous version read `mode || spawnEnv.SQUIDRUN_RUNTIME`, and on the
 * standard pane path `mode` is literally `null` while NOTHING IN THE REPOSITORY
 * EVER SET `SQUIDRUN_RUNTIME` — so this function returned null for every real
 * pane, no launch row was ever written, no `SQUIDRUN_PANE_LAUNCH_ID` was ever
 * exported, and the admission producer failed `no_launch_binding` on every
 * prompt. The wiring existed and could not fire.
 *
 * `spawnOptions.paneCommand` is the literal command the daemon is being asked
 * to run, present on every branch of the standard path, and it is resolved
 * through the SAME `resolveConsumerRuntimeForLaunch` the rest of the app uses.
 * An unrecognised command still writes nothing: a guessed runtime is exactly
 * the fabricated identity this checkpoint exists to refuse.
 */
function recordPaneLaunchForSpawn({ spawnEnv, paneId, role, mode, spawnOptions }) {
  try {
    const {
      ENV_LAUNCH_ID,
      ENV_APP_GENERATION,
      generateLaunchId,
      recordPaneLaunch,
    } = require('./modules/main/telegram-launch-registry');
    // THE WHOLE TELEGRAM SCHEMA, not just the registry half. The receipts table
    // carries a foreign key into `telegram_transport_claims`, so a database
    // holding one half of this schema unit accepts the launch row and then
    // fails the receipt insert with a missing-table error the hook swallows.
    const { applyTelegramAdmissionSchema } = require('./modules/main/telegram-admission-store');
    const { TelegramAdmissionWriter } = require('./modules/main/telegram-admission-writer');

    // The app generation is startup-owned process state. A pane/renderer may
    // supply ordinary environment values, but it may not choose the generation
    // whose launch registry row and Room authority this spawn will inherit.
    const appGeneration = String(process.env[ENV_APP_GENERATION] || '').trim();
    if (!appGeneration) return null;

    const { resolveConsumerRuntimeForLaunch } = require('./modules/runtime-detect');
    const paneCommand = spawnOptions && typeof spawnOptions === 'object'
      ? spawnOptions.paneCommand
      : null;
    const consumerRuntime = String(
      mode
      || spawnEnv.SQUIDRUN_RUNTIME
      || resolveConsumerRuntimeForLaunch(paneCommand)
      || ''
    ).trim().toLowerCase();
    if (!consumerRuntime) return null;

    const launchId = generateLaunchId();
    const writer = new TelegramAdmissionWriter({});
    const opened = writer.open();
    if (!opened.ok) return null;
    try {
      const result = writer.transaction((db) => {
        const schema = applyTelegramAdmissionSchema(db);
        if (!schema.ok) return schema;
        return recordPaneLaunch(db, {
          launchId,
          appGeneration,
          paneId: String(paneId),
          // LOWERCASED INTO THE KERNEL'S ADDRESS VOCABULARY. `PANE_ROLES` says
          // `Architect`; `comms_journal.target_role` and the obligations CHECK
          // constraint both say `architect`. Storing the display form here
          // would make every admission fail its launch-identity join on a
          // capital letter — a mismatch that reads as tampering.
          role: String(role || '').trim().toLowerCase(),
          consumerRuntime,
          daemonProcessId: String(process.pid),
          launchedAtMs: Date.now(),
        });
      });
      if (!result || result.ok !== true) return null;
    } finally {
      writer.close();
    }

    // ONLY AFTER THE ROW IS COMMITTED. Exporting an id whose row does not exist
    // would give the hook a launch it cannot join to anything.
    spawnEnv[ENV_LAUNCH_ID] = launchId;
    spawnEnv[ENV_APP_GENERATION] = appGeneration;
    return launchId;
  } catch (err) {
    try { log.warn('DaemonClient', `pane launch record skipped: ${err.message}`); } catch { /* best effort */ }
    return null;
  }
}

function stripElectronRunAsNode(env) {
  if (!env || typeof env !== 'object') return env;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') {
      delete env[key];
    }
  }
  return env;
}

function stripCallerPaneLaunchBinding(env) {
  if (!env || typeof env !== 'object') return env;
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();
    if (upperKey === 'SQUIDRUN_PANE_LAUNCH_ID' || upperKey === 'SQUIDRUN_APP_GENERATION') {
      delete env[key];
    }
  }
  return env;
}

function stripCallerPaneAddress(env) {
  if (!env || typeof env !== 'object') return env;
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();
    if (upperKey === 'SQUIDRUN_ROLE' || upperKey === 'SQUIDRUN_PANE_ID') {
      delete env[key];
    }
  }
  return env;
}

function readCaseInsensitiveEnv(env, name) {
  const wanted = String(name || '').toUpperCase();
  for (const [key, value] of Object.entries(env || {})) {
    if (String(key).toUpperCase() === wanted) return value;
  }
  return undefined;
}

function sanitizeSpawnOptions(options) {
  if (!options || typeof options !== 'object') return null;
  const sanitized = {};
  const reserved = new Set(['env', 'requestid', 'mode', 'paneid', 'cwd', 'dryrun']);
  for (const [key, value] of Object.entries(options)) {
    if (!reserved.has(String(key).toLowerCase())) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

class DaemonClient extends EventEmitter {
  constructor(options = {}) {
    super();
    const profileName = options.profileName ? normalizeProfileName(options.profileName) : null;
    this.pipePath = options.pipePath || (profileName ? getProfilePipePath(profileName, os.platform()) : PIPE_PATH);
    this.daemonEnv = {
      ...(options.daemonEnv && typeof options.daemonEnv === 'object' ? options.daemonEnv : {}),
    };
    if (profileName && !this.daemonEnv.SQUIDRUN_PROFILE) {
      this.daemonEnv.SQUIDRUN_PROFILE = profileName;
    }
    this.client = null;
    this.connected = false;
    this.connectPromise = null;
    this.spawnedDuringLastConnect = false;
    this.buffer = '';
    this.reconnecting = false;
    this.terminals = new Map(); // Cache of known terminals
    this.lastActivity = new Map(); // Track last activity time per pane
    this.pendingWriteAcks = new Map(); // requestEventId -> { resolve, timer }
    this.writeAckSeq = 0;
    this.spawnSeq = 0;
    // The app creates the launch id before sending the spawn request. Keep the
    // exact handoff until the daemon confirms which terminal it created, so an
    // older daemon that does not echo the new fields cannot make the app guess
    // from registry row age or completion state.
    this.pendingPaneLaunchBindings = new Map();
    // Confirmed canonical launch authority is app-owned state. It is promoted
    // only from an exact pending request/binding match and intentionally
    // survives a daemon socket reconnect. Daemon snapshots can restore
    // liveness against this map, but can never mint or replace its values.
    this.ownedPaneLaunchBindings = new Map();
    this.pendingAddressSpawns = new Map(); // requestId -> { resolve, timer }
    this.addressSpawnSeq = 0;
    this.pendingAddressKills = new Map(); // requestId -> { resolve, timer }
    this.addressKillSeq = 0;
  }

  /**
   * Connect to the daemon, spawning it if necessary
   * @returns {Promise<boolean>} true if connected
   */
  async connect() {
    if (this.connected && this.client && !this.client.destroyed) {
      this.spawnedDuringLastConnect = false;
      return true;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this._connectInternal();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /**
   * Connect only when the daemon pipe already exists.
   *
   * Unlike connect(), this never starts a daemon. Standalone controllers use
   * this fail-closed path when replacing the daemon would violate the active
   * process-generation boundary.
   * @returns {Promise<boolean>} true only when an existing pipe accepted us
   */
  async connectExisting() {
    if (this.connected && this.client && !this.client.destroyed) {
      this.spawnedDuringLastConnect = false;
      return true;
    }
    if (this.connectPromise) {
      return false;
    }

    this.spawnedDuringLastConnect = false;
    this.connectPromise = this._tryConnect();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async _connectInternal() {
    this.spawnedDuringLastConnect = false;

    // Try to connect first
    const connected = await this._tryConnect();
    if (connected) {
      log.info('DaemonClient', 'Connected to existing daemon');
      return true;
    }

    // Daemon not running, spawn it
    log.info('DaemonClient', 'Daemon not running, spawning...');
    await this._spawnDaemon();

    // Wait a bit for daemon to start
    await this._sleep(500);

    // Try to connect again
    const retryConnected = await this._tryConnect();
    if (retryConnected) {
      this.spawnedDuringLastConnect = true;
      log.info('DaemonClient', 'Connected to newly spawned daemon');
      return true;
    }

    log.error('DaemonClient', 'Failed to connect to daemon after spawn');
    this.spawnedDuringLastConnect = false;
    return false;
  }

  /**
   * Try to connect to the daemon
   * @returns {Promise<boolean>}
   */
  _tryConnect() {
    return new Promise((resolve) => {
      const client = net.createConnection(this.pipePath);
      let settled = false;
      let timeout = null;

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        client.removeListener('connect', onConnect);
        client.removeListener('error', onError);
      };

      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.client && this.client !== client) {
          this._teardownSocket(this.client);
        }
        this.client = client;
        this.connected = true;
        this._setupClient(client);
        resolve(true);
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this._teardownSocket(client);
        resolve(false);
      };

      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        this._teardownSocket(client);
        resolve(false);
      }, 2000);

      client.on('connect', onConnect);
      client.on('error', onError);
    });
  }

  _teardownSocket(socket) {
    if (!socket) return;
    try {
      if (typeof socket.removeAllListeners === 'function') {
        socket.removeAllListeners();
      }
    } catch {
      // Ignore listener cleanup failures during reconnect churn.
    }
    try {
      if (!socket.destroyed && typeof socket.destroy === 'function') {
        socket.destroy();
      }
    } catch {
      // Ignore teardown failures; reconnect path will recover.
    }
  }

  /**
   * Setup client event handlers
   */
  _setupClient(socket = this.client) {
    this.buffer = '';

    socket.on('data', (data) => {
      if (socket !== this.client) return;
      this.buffer += data.toString();

      // Process complete messages (newline-delimited)
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          this._handleMessage(line.trim());
        }
      }
    });

    socket.on('close', () => {
      if (socket !== this.client) return;
      log.warn('DaemonClient', 'Connection closed');
      this.connected = false;
      this.client = null;
      this._rejectPendingWriteAcks('daemon_disconnected');
      this._rejectPendingAddressSpawns('daemon_disconnected');
      this._rejectPendingAddressKills('daemon_disconnected');
      this.emit('disconnected');

      // Attempt reconnect
      if (!this.reconnecting) {
        this._attemptReconnect();
      }
    });

    socket.on('error', (err) => {
      if (socket !== this.client) return;
      log.error('DaemonClient', 'Connection error', err.message);
      this.connected = false;
      this._rejectPendingWriteAcks('daemon_connection_error');
      this._rejectPendingAddressSpawns('daemon_connection_error');
      this._rejectPendingAddressKills('daemon_connection_error');
    });
  }

  /**
   * Handle incoming message from daemon
   */
  _replaceTerminalSnapshot(terminals = []) {
    const previous = new Map(this.terminals);
    const next = new Map();
    const observedPaneIds = new Set();
    const recovered = [];
    for (const terminal of terminals) {
      const paneId = String(terminal?.paneId || '').trim();
      if (!paneId) continue;
      observedPaneIds.add(paneId);
      const pending = this.pendingPaneLaunchBindings.get(paneId) || null;
      if (pending) {
        const snapshotRequestId = String(terminal?.spawnRequestId || '').trim();
        const daemonBinding = normalizePaneLaunchBinding(terminal);
        const snapshotPid = normalizePaneProcessId(terminal);
        const exactRecovery = Boolean(
          snapshotRequestId
          && snapshotRequestId === String(pending.requestId || '')
          && snapshotPid
          && paneLaunchBindingsEqual(daemonBinding, pending)
        );
        if (exactRecovery) {
          const restored = {
            ...terminal,
            paneId,
            paneLaunchId: pending.paneLaunchId,
            appGeneration: pending.appGeneration,
            pid: snapshotPid,
          };
          this.ownedPaneLaunchBindings.set(paneId, {
            paneLaunchId: pending.paneLaunchId,
            appGeneration: pending.appGeneration,
            pid: snapshotPid,
            requestId: snapshotRequestId,
            launchSpec: pending.launchSpec,
          });
          this.pendingPaneLaunchBindings.delete(paneId);
          next.set(paneId, restored);
          recovered.push({
            ...restored,
            requestId: snapshotRequestId,
            paneLaunchRecovered: true,
          });
          continue;
        }
        const prior = previous.get(paneId);
        if (prior) next.set(paneId, prior);
        continue;
      }
      if (isCanonicalPaneId(paneId)) {
        const daemonBinding = normalizePaneLaunchBinding(terminal);
        const ownedBinding = this.ownedPaneLaunchBindings.get(paneId) || null;
        const acceptedBinding = ownedPaneLaunchMatches(terminal, ownedBinding)
          ? ownedBinding
          : null;
        if (ownedBinding && !acceptedBinding) {
          // A different process cannot inherit a prior canonical launch label.
          // Omit the pane from this snapshot so all Room consumers fail closed
          // until an app-owned replacement request is confirmed.
          continue;
        }
        next.set(paneId, {
          ...terminal,
          paneId,
          paneLaunchId: acceptedBinding?.paneLaunchId || null,
          appGeneration: acceptedBinding?.appGeneration || null,
        });
        continue;
      }
      next.set(paneId, { ...terminal, paneId });
    }
    for (const paneId of this.pendingPaneLaunchBindings.keys()) {
      if (observedPaneIds.has(paneId)) continue;
      const prior = previous.get(paneId);
      if (prior) next.set(paneId, prior);
    }
    this.terminals.clear();
    for (const [paneId, terminal] of next) this.terminals.set(paneId, terminal);
    for (const terminal of recovered) {
      this.emit(
        'spawned',
        terminal.paneId,
        terminal.pid,
        terminal.dryRun === true,
        terminal
      );
    }
    return Array.from(this.terminals.values());
  }

  _handleMessage(message) {
    try {
      const msg = JSON.parse(message);

      switch (msg.event) {
        case 'connected':
          // Initial connection, cache terminal list
          this.emit('connected', this._replaceTerminalSnapshot(msg.terminals || []));
          break;

        case 'data':
          this.lastActivity.set(msg.paneId, Date.now()); // Track activity
          try {
            this.emit('data', msg.paneId, msg.data);
          } catch (err) {
            log.warn('DaemonClient', `Data listener error for pane ${msg.paneId}: ${err.message}`);
          }
          break;

        case 'exit':
          this.emit('exit', msg.paneId, msg.code, msg);
          if (this.terminals.has(msg.paneId)) {
            const cached = this.terminals.get(msg.paneId);
            const eventPid = Number(msg.pid);
            const cachedPid = Number(cached?.pid);
            if (!Number.isFinite(eventPid) || !Number.isFinite(cachedPid) || eventPid === cachedPid) {
              cached.alive = false;
            }
          }
          {
            const paneId = String(msg.paneId || '');
            const ownedBinding = this.ownedPaneLaunchBindings.get(paneId) || null;
            if (ownedPaneLaunchMatches(msg, ownedBinding)) {
              this.ownedPaneLaunchBindings.delete(paneId);
            }
          }
          break;

        case 'spawned': {
          const paneId = String(msg.paneId);
          const pending = this.pendingPaneLaunchBindings.get(paneId) || null;
          const requestMatches = !pending
            || String(pending.requestId || '') === String(msg.requestId || '');
          if (pending && !requestMatches) {
            // A prior same-pane lifecycle can report after a replacement spawn
            // was already requested. It may not consume or bypass the current
            // app-owned launch handoff, update the terminal cache, or trigger a
            // Room credential refresh.
            log.warn('DaemonClient', `Ignored stale pane spawn confirmation for pane ${paneId}`);
            break;
          }
          const daemonBinding = normalizePaneLaunchBinding(msg);
          let launchBinding = daemonBinding;
          let ownedBinding = null;
          if (pending && requestMatches) {
            const confirmedPid = normalizePaneProcessId(msg);
            if (!confirmedPid
              || (daemonBinding && !paneLaunchBindingsEqual(daemonBinding, pending))) {
              log.warn('DaemonClient', `Refused mismatched pane launch confirmation for pane ${paneId}`);
              break;
            } else {
              launchBinding = {
                paneLaunchId: pending.paneLaunchId,
                appGeneration: pending.appGeneration,
              };
            }
            this.ownedPaneLaunchBindings.set(paneId, {
              ...launchBinding,
              pid: confirmedPid,
              requestId: String(pending.requestId || ''),
              launchSpec: pending.launchSpec,
            });
            this.pendingPaneLaunchBindings.delete(paneId);
          } else if (isCanonicalPaneId(paneId)) {
            ownedBinding = this.ownedPaneLaunchBindings.get(paneId) || null;
            if (ownedBinding && !ownedPaneLaunchMatches(msg, ownedBinding)) {
              log.warn('DaemonClient', `Ignored unowned pane process replacement for pane ${paneId}`);
              break;
            }
            if (!ownedBinding) {
              // Canonical terminal liveness may still update, but an unowned
              // daemon event never becomes Room/launch authority.
              launchBinding = null;
              log.warn('DaemonClient', `Stripped unowned pane launch identity for pane ${paneId}`);
            } else {
              launchBinding = ownedBinding;
            }
          }
          const spawnedMessage = {
            ...msg,
            paneId,
            paneLaunchId: launchBinding?.paneLaunchId || null,
            appGeneration: launchBinding?.appGeneration || null,
            spawnRequestId: launchBinding
              ? String(
                pending?.requestId
                || ownedBinding?.requestId
                || msg.spawnRequestId
                || msg.requestId
                || ''
              ).trim() || null
              : null,
          };
          this.terminals.set(paneId, {
            paneId,
            pid: msg.pid,
            alive: true,
            dryRun: msg.dryRun || false,
            mode: msg.mode || 'pty',
            createdAt: msg.createdAt || null,
            workRoomRouteOwner: msg.workRoomRouteOwner === true,
            backgroundAgent: msg.backgroundAgent === true,
            routeOwner: msg.routeOwner || null,
            roomId: msg.roomId || null,
            role: msg.role || null,
            ownerPaneId: msg.ownerPaneId || null,
            paneLaunchId: spawnedMessage.paneLaunchId,
            appGeneration: spawnedMessage.appGeneration,
            spawnRequestId: spawnedMessage.spawnRequestId,
          });
          this.emit('spawned', paneId, msg.pid, msg.dryRun || false, spawnedMessage);
          break;
        }

        case 'spawn-retry-requested': {
          const paneId = String(msg.paneId || '').trim();
          const reason = String(msg.reason || '').trim();
          const owned = this.ownedPaneLaunchBindings.get(paneId) || null;
          const current = this.terminals.get(paneId) || null;
          const exactRequest = Boolean(
            owned?.requestId
            && String(msg.spawnRequestId || '') === String(owned.requestId)
          );
          const launchSpec = owned?.launchSpec || null;
          const retryCount = Number(launchSpec?.retryCount) || 0;
          const authorized = Boolean(
            APP_OWNED_RETRY_REASONS.has(reason)
            && owned
            && owned.retryRequested !== true
            && retryCount < 1
            && exactRequest
            && ownedPaneLaunchMatches(msg, owned)
            && ownedPaneLaunchMatches(current, owned)
            && launchSpec
            && !this.pendingPaneLaunchBindings.has(paneId)
          );
          if (!authorized) {
            log.warn('DaemonClient', `Ignored unowned pane retry request for pane ${paneId || 'unknown'}`);
            this.emit('spawn-retry-result', paneId, {
              ok: false,
              reason: 'pane_retry_not_app_owned',
              retryReason: reason || null,
            });
            break;
          }

          owned.retryRequested = true;
          const replacementOptions = { ...(launchSpec.spawnOptions || {}) };
          if (reason === 'claude_session_collision') {
            replacementOptions.paneCommand = stripClaudeResumeFlags(
              replacementOptions.paneCommand
            ) || 'claude';
            replacementOptions.spawnCommandOnCreate = true;
            replacementOptions.claudeCollisionRecoveryAttempted = true;
          } else if (reason === 'codex_missing_resume') {
            replacementOptions.paneCommand = stripCodexResumeSubcommand(
              replacementOptions.paneCommand
            ) || 'codex';
            replacementOptions.spawnCommandOnCreate = true;
            replacementOptions.codexResumeRecoveryAttempted = true;
          }
          const accepted = this.spawn(
            paneId,
            launchSpec.cwd,
            launchSpec.dryRun === true,
            launchSpec.mode,
            { ...(launchSpec.env || {}) },
            replacementOptions,
            {
              retryCount: retryCount + 1,
              requireLaunchBinding: true,
            }
          );
          const replacement = this.pendingPaneLaunchBindings.get(paneId) || null;
          const replacementOwned = Boolean(
            accepted === true
            && replacement
            && replacement.paneLaunchId !== owned.paneLaunchId
            && replacement.requestId
          );
          this.emit('spawn-retry-result', paneId, {
            ok: replacementOwned,
            reason: replacementOwned
              ? 'app_owned_pane_retry_requested'
              : 'app_owned_pane_retry_launch_unavailable',
            retryReason: reason,
            previousPaneLaunchId: owned.paneLaunchId,
            replacementPaneLaunchId: replacementOwned ? replacement.paneLaunchId : null,
            replacementRequestId: replacementOwned ? replacement.requestId : null,
          });
          break;
        }

        case 'address-spawn-result': {
          const requestId = msg.requestId || null;
          if (msg.ok && msg.terminal
            && !this.pendingPaneLaunchBindings.has(String(msg.paneId))) {
            const paneId = String(msg.paneId);
            const daemonBinding = normalizePaneLaunchBinding(msg.terminal);
            const ownedBinding = this.ownedPaneLaunchBindings.get(paneId) || null;
            const acceptedBinding = !isCanonicalPaneId(paneId)
              ? daemonBinding
              : (ownedPaneLaunchMatches(msg.terminal, ownedBinding) ? ownedBinding : null);
            if (!(isCanonicalPaneId(paneId) && ownedBinding && !acceptedBinding)) {
              this.terminals.set(paneId, {
                ...msg.terminal,
                paneId,
                alive: true,
                paneLaunchId: acceptedBinding?.paneLaunchId || null,
                appGeneration: acceptedBinding?.appGeneration || null,
              });
            }
          }
          const pending = requestId ? this.pendingAddressSpawns.get(requestId) : null;
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingAddressSpawns.delete(requestId);
            pending.resolve(msg);
          }
          this.emit('address-spawn-result', msg);
          break;
        }

        case 'address-kill-result': {
          const requestId = msg.requestId || null;
          if (msg.ok && this.terminals.has(msg.paneId)) {
            const cached = this.terminals.get(msg.paneId);
            if (!msg.spawnLeaseId || cached?.spawnLeaseId === msg.spawnLeaseId) {
              this.terminals.delete(msg.paneId);
            }
          }
          const pending = requestId ? this.pendingAddressKills.get(requestId) : null;
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingAddressKills.delete(requestId);
            pending.resolve(msg);
          }
          this.emit('address-kill-result', msg);
          break;
        }

        case 'list':
          this.emit('list', this._replaceTerminalSnapshot(msg.terminals || []));
          break;

        case 'attached':
          // U1: Include scrollback in attached event
          this.emit('attached', msg.paneId, msg.pid, msg.alive, msg.scrollback);
          break;

        case 'killed':
          if (this.terminals.has(msg.paneId)) {
            const cached = this.terminals.get(msg.paneId);
            const eventPid = Number(msg.pid);
            const cachedPid = Number(cached?.pid);
            if (!Number.isFinite(eventPid) || !Number.isFinite(cachedPid) || eventPid === cachedPid) {
              this.terminals.delete(msg.paneId);
            }
          }
          {
            const paneId = String(msg.paneId || '');
            const ownedBinding = this.ownedPaneLaunchBindings.get(paneId) || null;
            if (ownedPaneLaunchMatches(msg, ownedBinding)) {
              this.ownedPaneLaunchBindings.delete(paneId);
            }
          }
          this.emit('killed', msg.paneId, msg);
          break;

        case 'error':
          {
            const paneId = String(msg.paneId || '');
            const requestId = String(msg.requestId || '').trim();
            const pending = this.pendingPaneLaunchBindings.get(paneId) || null;
            if (pending && requestId && requestId === String(pending.requestId || '')) {
              this.pendingPaneLaunchBindings.delete(paneId);
            }
            this.emit('error', msg.paneId, msg.message, msg);
          }
          break;

        case 'pong':
          this.emit('pong');
          break;

        // D3: Handle graceful shutdown notification from daemon
        case 'shutdown':
          log.warn('DaemonClient', 'Daemon is shutting down', msg.message);
          this.emit('shutdown', msg.message, msg.timestamp);
          // Don't attempt reconnect - daemon is intentionally shutting down
          this.reconnecting = true; // Prevent auto-reconnect
          break;

        // D2: Handle health check response
        case 'health':
          this.emit('health', msg);
          break;

        // Handle heartbeat state changes
        case 'heartbeat-state-changed':
          this.emit('heartbeat-state-changed', msg.state, msg.interval, msg.timestamp);
          break;

        // Handle heartbeat status response
        case 'heartbeat-status':
          this.emit('heartbeat-status', msg);
          break;

        // ID-1: Handle identity injection response
        case 'identity-injected':
          this.emit('identity-injected', msg.paneId, msg.role, msg.message);
          break;

        // Handle watchdog alert
        case 'watchdog-alert':
          this.emit('watchdog-alert', msg.message, msg.timestamp);
          break;

        case 'agent-stuck-detected':
          this.emit('agent-stuck-detected', msg);
          break;

        case 'agent-stuck-alert':
          this.emit('agent-stuck-alert', msg);
          break;

        // Handle Codex exec activity state changes
        case 'codex-activity':
          this.emit('codex-activity', msg.paneId, msg.state, msg.detail);
          break;

        // Event Kernel: daemon-side event envelope
        case 'kernel-event':
          this.emit('kernel-event', msg.eventData || null);
          if (msg.eventData?.type === 'daemon.write.ack') {
            const requestEventId = msg.eventData?.payload?.requestedByEventId;
            if (requestEventId) {
              const pending = this.pendingWriteAcks.get(requestEventId);
              if (pending) {
                clearTimeout(pending.timer);
                this.pendingWriteAcks.delete(requestEventId);
                pending.resolve({
                  success: true,
                  requestEventId,
                  eventData: msg.eventData,
                  status: msg.eventData?.payload?.status,
                });
              }
            }
            this.emit('write-ack', msg.eventData);
          }
          break;

        // Event Kernel: daemon-side diagnostics
        case 'kernel-stats':
          this.emit('kernel-stats', msg.stats || {});
          break;

        default:
          log.warn('DaemonClient', 'Unknown event', msg.event);
      }
    } catch (err) {
      log.error('DaemonClient', 'Error parsing message', err.message);
    }
  }

  /**
   * Attempt to reconnect to daemon
   */
  async _attemptReconnect() {
    if (this.reconnecting) return;
    if (this.connected && this.client && !this.client.destroyed) return;
    this.reconnecting = true;

    log.info('DaemonClient', 'Attempting to reconnect...');

    for (let i = 0; i < 5; i++) {
      await this._sleep(1000);
      const connected = await this._tryConnect();
      if (connected) {
        log.info('DaemonClient', 'Reconnected successfully');
        this.reconnecting = false;
        this.emit('reconnected');
        return;
      }
    }

    log.error('DaemonClient', 'Failed to reconnect after 5 attempts');
    this.reconnecting = false;
    this.emit('reconnect-failed');
  }

  /**
   * Spawn the daemon process (detached)
   */
  async _spawnDaemon() {
    return new Promise((resolve) => {
      const daemonEnv = stripElectronRunAsNode({
        ...process.env,
        ...this.daemonEnv,
      });
      daemonEnv.ELECTRON_RUN_AS_NODE = '1';

      log.info('DaemonClient', `Spawning daemon with Electron-as-Node ${process.execPath}`, DAEMON_SCRIPT);

      // Spawn as detached process so it survives parent exit
      const daemon = spawn(process.execPath, [DAEMON_SCRIPT], {
        detached: true,
        stdio: 'ignore', // Don't inherit stdio - daemon runs independently
        cwd: ASAR_UNPACKED_DIR,
        env: daemonEnv,
      });

      // Unref so parent can exit without waiting
      daemon.unref();

      log.info('DaemonClient', 'Daemon spawned with PID', daemon.pid);
      resolve();
    });
  }

  /**
   * Send a message to the daemon
   */
  _send(message) {
    if (!this.connected || !this.client) {
      log.error('DaemonClient', 'Not connected');
      return false;
    }

    try {
      this.client.write(JSON.stringify(message) + '\n');
      return true;
    } catch (err) {
      log.error('DaemonClient', 'Send error', err.message);
      return false;
    }
  }

  /**
   * Spawn a terminal in a pane
   * @param {string} paneId - The pane identifier
   * @param {string} [cwd] - Working directory
   * @param {boolean} [dryRun=false] - If true, spawn mock terminal instead of real PTY
   */
  spawn(
    paneId,
    cwd,
    dryRun = false,
    mode = null,
    env = null,
    spawnOptions = null,
    requestMeta = null
  ) {
    const id = String(paneId);
    const incomingEnv = (env && typeof env === 'object') ? { ...env } : {};
    const incomingRole = readCaseInsensitiveEnv(incomingEnv, 'SQUIDRUN_ROLE');
    const explicitRole = typeof incomingRole === 'string'
      ? incomingRole.trim()
      : '';
    const canonicalRole = String(PANE_ROLES?.[id] || '').trim();
    const role = canonicalRole || explicitRole;
    stripCallerPaneAddress(incomingEnv);
    stripCallerPaneLaunchBinding(incomingEnv);
    const spawnEnv = {
      ...incomingEnv,
      SQUIDRUN_ROLE: role,
      SQUIDRUN_PANE_ID: id,
    };
    // THE DAEMON'S LAUNCH RECORD, written here because this is the one place
    // that knows a pane launch is happening and still controls the environment
    // the runtime will inherit. The id is handed to the pane through
    // SQUIDRUN_PANE_LAUNCH_ID; that hand-off is the only way a later hook can
    // name its own launch, and without it `pane_launch_id` stays what it was
    // for two checkpoints — a column the store read and nothing ever wrote.
    const paneLaunchId = recordPaneLaunchForSpawn({ spawnEnv, paneId: id, role, mode, spawnOptions });
    stripElectronRunAsNode(spawnEnv);
    const payload = {
      action: 'spawn',
      paneId: id,
      cwd,
      dryRun,
      mode,
      env: spawnEnv,
    };
    const requestId = String(requestMeta?.requestId || '').trim() || this._nextSpawnRequestId();
    payload.requestId = requestId;
    const sanitizedSpawnOptions = sanitizeSpawnOptions(spawnOptions);
    if (sanitizedSpawnOptions) {
      payload.options = sanitizedSpawnOptions;
    }
    const launchBinding = normalizePaneLaunchBinding({
      paneLaunchId,
      appGeneration: spawnEnv.SQUIDRUN_APP_GENERATION,
    });
    if (requestMeta?.requireLaunchBinding === true && !launchBinding) {
      log.warn('DaemonClient', `Refused app-owned pane retry without launch authority for pane ${id}`);
      return false;
    }
    if (launchBinding) {
      const replayEnv = { ...spawnEnv };
      stripCallerPaneAddress(replayEnv);
      stripCallerPaneLaunchBinding(replayEnv);
      this.pendingPaneLaunchBindings.set(id, {
        ...launchBinding,
        requestId,
        launchSpec: {
          cwd,
          dryRun: dryRun === true,
          mode,
          env: replayEnv,
          spawnOptions: { ...(sanitizedSpawnOptions || {}) },
          retryCount: Math.max(0, Number(requestMeta?.retryCount) || 0),
        },
      });
    }
    const accepted = this._send(payload);
    if (!accepted && launchBinding) {
      const pending = this.pendingPaneLaunchBindings.get(id);
      if (pending?.paneLaunchId === launchBinding.paneLaunchId) {
        this.pendingPaneLaunchBindings.delete(id);
      }
    }
    return accepted;
  }

  _nextSpawnRequestId() {
    this.spawnSeq += 1;
    return `pane-spawn-${Date.now()}-${this.spawnSeq}`;
  }

  /**
   * Spawn a pane and wait until this daemon connection observes the matching
   * spawned event. A request id prevents an older same-pane event from
   * satisfying a newer lifecycle.
   */
  async spawnAndWait(
    paneId,
    cwd,
    dryRun = false,
    mode = null,
    env = null,
    spawnOptions = null,
    waitOptions = {}
  ) {
    const id = String(paneId);
    const timeoutMs = Math.max(100, Number(waitOptions.timeoutMs) || 5000);
    const requestId = this._nextSpawnRequestId();
    if (!this.connected || !this.client) {
      return {
        ok: false,
        status: 'not_connected',
        reason: 'daemon_not_connected',
        paneId: id,
      };
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('spawned', onSpawned);
        this.off('disconnected', onDisconnected);
        this.off('error', onError);
        resolve(result);
      };
      const onSpawned = (spawnedPaneId, pid, spawnedDryRun, message = {}) => {
        if (String(spawnedPaneId) !== id || message?.requestId !== requestId) return;
        finish({
          ok: Number.isFinite(Number(pid)),
          status: Number.isFinite(Number(pid)) ? 'spawned' : 'spawn_identity_invalid',
          reason: Number.isFinite(Number(pid))
            ? 'daemon_pane_spawn_observed'
            : 'daemon_pane_spawn_pid_missing',
          paneId: id,
          pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
          dryRun: spawnedDryRun === true,
          message,
          requestId,
        });
      };
      const onDisconnected = () => {
        finish({
          ok: false,
          status: 'disconnected',
          reason: 'daemon_disconnected_before_spawn_observed',
          paneId: id,
          requestId,
        });
      };
      const onError = (errorPaneId, message, errorEvent = {}) => {
        if (String(errorPaneId || '') !== id
          || String(errorEvent?.requestId || '') !== requestId) return;
        finish({
          ok: false,
          status: 'spawn_failed',
          reason: 'daemon_pane_spawn_failed',
          paneId: id,
          error: message || null,
          requestId,
        });
      };
      const timer = setTimeout(() => {
        finish({
          ok: false,
          status: 'ack_timeout',
          reason: `daemon pane spawn observation timeout after ${timeoutMs}ms`,
          paneId: id,
          requestId,
        });
      }, timeoutMs);

      this.on('spawned', onSpawned);
      this.on('disconnected', onDisconnected);
      this.on('error', onError);
      try {
        const accepted = this.spawn(
          id,
          cwd,
          dryRun,
          mode,
          env,
          spawnOptions,
          { requestId }
        );
        if (accepted !== true) {
          finish({
            ok: false,
            status: 'send_failed',
            reason: 'daemon_spawn_send_failed',
            paneId: id,
            requestId,
          });
        }
      } catch (error) {
        finish({
          ok: false,
          status: 'spawn_failed',
          reason: 'daemon_spawn_send_threw',
          paneId: id,
          error: error?.message || String(error),
          requestId,
        });
      }
    });
  }

  _nextAddressSpawnRequestId() {
    this.addressSpawnSeq += 1;
    return `address-spawn-${Date.now()}-${this.addressSpawnSeq}`;
  }

  _rejectPendingAddressSpawns(reason = 'daemon_disconnected') {
    for (const [requestId, pending] of this.pendingAddressSpawns.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        status: 'ack_timeout',
        reason,
        requestId,
      });
    }
    this.pendingAddressSpawns.clear();
  }

  /**
   * Spawn a daemon-owned terminal keyed by a durable address and wait for its
   * generation-specific result. Legacy pane spawn remains unchanged.
   * @param {Object} input
   * @param {Object} [waitOptions]
   * @returns {Promise<Object>}
   */
  async spawnAddressed(input = {}, waitOptions = {}) {
    const paneId = String(input.paneId || '').trim();
    const incomingEnv = (input.env && typeof input.env === 'object') ? input.env : {};
    const explicitRole = typeof incomingEnv.SQUIDRUN_ROLE === 'string'
      ? incomingEnv.SQUIDRUN_ROLE.trim()
      : '';
    const role = explicitRole || String(PANE_ROLES?.[paneId] || '').trim();
    const spawnEnv = {
      SQUIDRUN_ROLE: role,
      SQUIDRUN_PANE_ID: paneId,
      ...incomingEnv,
    };
    stripElectronRunAsNode(spawnEnv);
    const requestId = String(input.requestId || '').trim() || this._nextAddressSpawnRequestId();
    const timeoutMs = Math.max(100, Number(waitOptions.timeoutMs) || 5000);

    if (!this.connected || !this.client) {
      return {
        ok: false,
        status: 'not_connected',
        reason: 'daemon_not_connected',
        requestId,
      };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAddressSpawns.delete(requestId);
        resolve({
          ok: false,
          status: 'ack_timeout',
          reason: `address spawn ack timeout after ${timeoutMs}ms`,
          requestId,
        });
      }, timeoutMs);
      this.pendingAddressSpawns.set(requestId, { resolve, timer });

      const sent = this._send({
        action: 'spawn-addressed',
        requestId,
        durableAddress: input.durableAddress || input.address || null,
        paneId,
        cwd: input.cwd,
        dryRun: input.dryRun === true,
        mode: input.mode || null,
        env: spawnEnv,
        owner: input.owner || null,
        recoveryEvent: input.recoveryEvent || null,
        sourceMessageId: input.sourceMessageId || null,
        expectedResponseClass: input.expectedResponseClass || null,
        options: input.options && typeof input.options === 'object'
          ? { ...input.options }
          : undefined,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingAddressSpawns.delete(requestId);
        resolve({
          ok: false,
          status: 'send_failed',
          reason: 'address_spawn_send_failed',
          requestId,
        });
      }
    });
  }

  _nextAddressKillRequestId() {
    this.addressKillSeq += 1;
    return `address-kill-${Date.now()}-${this.addressKillSeq}`;
  }

  _rejectPendingAddressKills(reason = 'daemon_disconnected') {
    for (const [requestId, pending] of this.pendingAddressKills.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, status: 'ack_timeout', reason, requestId });
    }
    this.pendingAddressKills.clear();
  }

  async killAddressed(input = {}, waitOptions = {}) {
    const requestId = String(input.requestId || '').trim() || this._nextAddressKillRequestId();
    const timeoutMs = Math.max(100, Number(waitOptions.timeoutMs) || 5000);
    if (!this.connected || !this.client) {
      return { ok: false, status: 'not_connected', reason: 'daemon_not_connected', requestId };
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAddressKills.delete(requestId);
        resolve({
          ok: false,
          status: 'ack_timeout',
          reason: `address kill ack timeout after ${timeoutMs}ms`,
          requestId,
        });
      }, timeoutMs);
      this.pendingAddressKills.set(requestId, { resolve, timer });
      const sent = this._send({
        action: 'kill-addressed',
        requestId,
        durableAddress: input.durableAddress || input.address || null,
        spawnLeaseId: input.spawnLeaseId || input.leaseId || null,
        paneId: input.paneId || null,
        reason: input.reason || null,
        recoveryEvent: input.recoveryEvent || null,
        sourceMessageId: input.sourceMessageId || null,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingAddressKills.delete(requestId);
        resolve({ ok: false, status: 'send_failed', reason: 'address_kill_send_failed', requestId });
      }
    });
  }

  /**
   * Write data to a terminal
   * @param {string} paneId - The pane identifier
   * @param {string} data - Data to write
   * @param {Object|null} kernelMeta - Optional event-kernel metadata
   */
  write(paneId, data, kernelMeta = null) {
    return this._send({
      action: 'write',
      paneId,
      data,
      kernelMeta: kernelMeta || undefined,
    });
  }

  _nextWriteAckEventId() {
    this.writeAckSeq += 1;
    return `write-${Date.now()}-${this.writeAckSeq}`;
  }

  _rejectPendingWriteAcks(reason = 'daemon_disconnected') {
    for (const [eventId, pending] of this.pendingWriteAcks.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        success: false,
        requestEventId: eventId,
        status: 'ack_timeout',
        error: reason,
      });
    }
    this.pendingWriteAcks.clear();
  }

  /**
   * Write data and wait for daemon.write.ack for this specific write.
   * requestEventId is carried in kernelMeta.eventId and echoed by daemon ack.
   * @param {string} paneId
   * @param {string} data
   * @param {Object|null} kernelMeta
   * @param {Object} [options]
   * @param {number} [options.timeoutMs=2000]
   * @returns {Promise<{success:boolean,status?:string,error?:string,requestEventId?:string,eventData?:Object}>}
   */
  async writeAndWaitAck(paneId, data, kernelMeta = null, options = {}) {
    const timeoutMs = Math.max(100, Number(options?.timeoutMs) || 2000);
    const normalizedMeta = (kernelMeta && typeof kernelMeta === 'object')
      ? { ...kernelMeta }
      : {};
    if (!normalizedMeta.eventId) {
      normalizedMeta.eventId = this._nextWriteAckEventId();
    }
    const requestEventId = normalizedMeta.eventId;

    if (!this.connected || !this.client) {
      return {
        success: false,
        requestEventId,
        status: 'not_connected',
        error: 'Daemon not connected',
      };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWriteAcks.delete(requestEventId);
        resolve({
          success: false,
          requestEventId,
          status: 'ack_timeout',
          error: `write ack timeout after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      this.pendingWriteAcks.set(requestEventId, { resolve, timer });

      const sent = this.write(paneId, data, normalizedMeta);
      if (!sent) {
        clearTimeout(timer);
        this.pendingWriteAcks.delete(requestEventId);
        resolve({
          success: false,
          requestEventId,
          status: 'send_failed',
          error: 'Failed to send write to daemon',
        });
      }
    });
  }

  /**
   * Pause terminal output
   * @param {string} paneId - The pane identifier
   */
  pause(paneId) {
    return this._send({
      action: 'pause',
      paneId,
    });
  }

  /**
   * Resume terminal output
   * @param {string} paneId - The pane identifier
   */
  resume(paneId) {
    return this._send({
      action: 'resume',
      paneId,
    });
  }

  /**
   * Resize a terminal
   * @param {string} paneId - The pane identifier
   * @param {number} cols - Number of columns
   * @param {number} rows - Number of rows
   * @param {Object|null} kernelMeta - Optional event-kernel metadata
   */
  resize(paneId, cols, rows, kernelMeta = null) {
    return this._send({
      action: 'resize',
      paneId,
      cols,
      rows,
      kernelMeta: kernelMeta || undefined,
    });
  }

  /**
   * Kill a terminal
   * @param {string} paneId - The pane identifier
   */
  kill(paneId) {
    return this._send({
      action: 'kill',
      paneId,
    });
  }

  /**
   * Request list of all terminals
   */
  list() {
    return this._send({
      action: 'list',
    });
  }

  /**
   * Attach to a terminal (request its current state)
   * @param {string} paneId - The pane identifier
   */
  attach(paneId) {
    return this._send({
      action: 'attach',
      paneId,
    });
  }

  /**
   * Send ping to daemon
   */
  ping() {
    return this._send({
      action: 'ping',
    });
  }

  /**
   * Request health check from daemon
   * Returns: uptime, terminal count, memory usage
   */
  health() {
    return this._send({
      action: 'health',
    });
  }

  // ============================================================
  // ID-1: Session Identity Injection
  // Inject role identity message for /resume identification
  // ============================================================

  /**
   * Inject identity message into terminal for Claude session identification
   * Makes sessions identifiable when using /resume
   * @param {string} paneId - The pane identifier
   */
  injectIdentity(paneId) {
    return this._send({
      action: 'inject-identity',
      paneId,
    });
  }

  // ============================================================
  // FX2: Session Persistence Methods
  // ============================================================

  /**
   * Get saved session state from daemon
   * @returns {Promise<Object|null>} Session state or null
   */
  getSession() {
    return this._send({
      action: 'get-session',
    });
  }

  /**
   * Manually save current session state
   */
  saveSession() {
    return this._send({
      action: 'save-session',
    });
  }

  /**
   * Clear saved session state
   */
  clearSession() {
    return this._send({
      action: 'clear-session',
    });
  }

  /**
   * Request daemon shutdown (kills all terminals)
   */
  shutdown() {
    return this._send({
      action: 'shutdown',
    });
  }

  /**
   * Disconnect from daemon (doesn't kill terminals)
   */
  disconnect() {
    this._rejectPendingWriteAcks('daemon_disconnected');
    this._rejectPendingAddressSpawns('daemon_disconnected');
    this._rejectPendingAddressKills('daemon_disconnected');
    if (this.client) {
      this._teardownSocket(this.client);
      this.client = null;
    }
    this.connected = false;
  }

  /**
   * True if the daemon was spawned during the most recent connect() call.
   * This distinguishes full daemon restarts from lightweight app reconnects.
   * @returns {boolean}
   */
  didSpawnDuringLastConnect() {
    return this.spawnedDuringLastConnect === true;
  }

  /**
   * Check if daemon is running
   * @returns {Promise<boolean>}
   */
  async isDaemonRunning() {
    // Check if PID file exists and process is running
    if (fs.existsSync(DAEMON_PID_FILE)) {
      try {
        const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, 'utf-8').trim());
        if (pid) {
          // Try to check if process exists
          try {
            process.kill(pid, 0); // Signal 0 doesn't kill, just checks
            return true;
          } catch (_e) {
            // Process doesn't exist
            return false;
          }
        }
      } catch (_e) {
        return false;
      }
    }
    return false;
  }

  /**
   * Get cached terminal info
   * @param {string} paneId
   */
  getTerminal(paneId) {
    return this.terminals.get(paneId);
  }

  /**
   * Get all cached terminals
   */
  getTerminals() {
    return Array.from(this.terminals.values());
  }

  /**
   * Get last activity timestamp for a pane
   * @param {string} paneId
   * @returns {number|null} timestamp or null if no activity recorded
   */
  getLastActivity(paneId) {
    return this.lastActivity.get(paneId) || null;
  }

  /**
   * Get all activity timestamps
   * @returns {Object} paneId -> timestamp
   */
  getAllActivity() {
    return Object.fromEntries(this.lastActivity);
  }

  /**
   * Sleep utility
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
let instance = null;

/**
 * Get the daemon client instance
 * @returns {DaemonClient}
 */
function getDaemonClient() {
  if (!instance) {
    instance = new DaemonClient();
  }
  return instance;
}

module.exports = {
  DaemonClient,
  getDaemonClient,
  PIPE_PATH,
};
