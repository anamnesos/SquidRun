const log = require('../logger');
const {
  BACKGROUND_BUILDER_OWNER_PANE_ID,
  BACKGROUND_BUILDER_MAX_AGENTS,
  BACKGROUND_BUILDER_ALIAS_TO_PANE,
  BACKGROUND_BUILDER_PANE_TO_ALIAS,
  BACKGROUND_BUILDER_PANE_IDS,
  resolveBackgroundBuilderAlias,
  resolveBackgroundBuilderPaneId,
} = require('../../config');

const DEFAULT_BG_IDLE_TTL_MS = Number.parseInt(
  process.env.HIVEMIND_BG_IDLE_TTL_MS || String(20 * 60 * 1000),
  10
);
const DEFAULT_BG_WATCHDOG_INTERVAL_MS = Number.parseInt(
  process.env.HIVEMIND_BG_WATCHDOG_INTERVAL_MS || '15000',
  10
);
const DEFAULT_BG_SCROLLBACK_MAX_SIZE = Number.parseInt(
  process.env.HIVEMIND_BG_SCROLLBACK_MAX_SIZE || '12000',
  10
);
const DEFAULT_BG_STARTUP_DELAY_MS = Number.parseInt(
  process.env.HIVEMIND_BG_STARTUP_DELAY_MS || '3500',
  10
);
const DEFAULT_BG_STARTUP_RETRY_MS = Number.parseInt(
  process.env.HIVEMIND_BG_STARTUP_RETRY_MS || '6500',
  10
);
const PRIMARY_BG_COMPLETION_SENTINEL = '__HM_BG_DONE__';
const BG_COMPLETION_SENTINELS = [PRIMARY_BG_COMPLETION_SENTINEL, '[BG_TASK_COMPLETE]'];

function asPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function toTrimmedString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeRole(value) {
  const role = toTrimmedString(value).toLowerCase();
  if (!role) return '';
  if (role === 'builder' || role === '2') return 'builder';
  if (role === 'architect' || role === '1') return 'architect';
  if (role === 'oracle' || role === '3') return 'oracle';
  return role;
}

function detectRuntime(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) return 'claude';
  if (normalized.startsWith('codex') || normalized.includes(' codex')) return 'codex';
  if (normalized.startsWith('gemini') || normalized.includes(' gemini')) return 'gemini';
  return 'claude';
}

function withAutonomyFlags(command, settings = {}) {
  let cmd = String(command || '').trim() || 'codex';
  const autonomyEnabled = settings.autonomyConsentGiven === true && settings.allowAllPermissions === true;
  if (!autonomyEnabled) return cmd;

  const lower = cmd.toLowerCase();
  if (lower.startsWith('claude') && !cmd.includes('--dangerously-skip-permissions')) {
    cmd = `${cmd} --dangerously-skip-permissions`;
  } else if (lower.startsWith('codex') && !cmd.includes('--yolo') && !cmd.includes('--dangerously-bypass-approvals-and-sandbox')) {
    cmd = `${cmd} --yolo`;
  }
  return cmd;
}

function sanitizeMultilineForPty(value) {
  return String(value || '').replace(/\r?\n/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsCompletionSignal(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;

  return lines.some((line) => BG_COMPLETION_SENTINELS.some((marker) => (
    new RegExp(`^${escapeRegExp(marker)}(?:[.!])*\\s*$`).test(line)
  )));
}

function appendCompletionDirective(content) {
  const text = String(content ?? '');
  if (BG_COMPLETION_SENTINELS.some((marker) => text.includes(marker))) {
    return text;
  }
  const normalized = text.trimEnd();
  const separator = normalized.length > 0 ? '\n' : '';
  return `${normalized}${separator}When delegated work is complete, send Builder a completion update and print ${PRIMARY_BG_COMPLETION_SENTINEL} on its own line.`;
}

class BackgroundAgentManager {
  constructor(options = {}) {
    this.getDaemonClient = typeof options.getDaemonClient === 'function'
      ? options.getDaemonClient
      : (() => null);
    this.getSettings = typeof options.getSettings === 'function'
      ? options.getSettings
      : (() => ({}));
    this.getSessionScopeId = typeof options.getSessionScopeId === 'function'
      ? options.getSessionScopeId
      : (() => null);
    this.resolveBuilderCwd = typeof options.resolveBuilderCwd === 'function'
      ? options.resolveBuilderCwd
      : (() => process.cwd());
    this.logActivity = typeof options.logActivity === 'function'
      ? options.logActivity
      : null;
    this.onStateChanged = typeof options.onStateChanged === 'function'
      ? options.onStateChanged
      : null;

    this.maxAgents = BACKGROUND_BUILDER_MAX_AGENTS;
    this.idleTtlMs = asPositiveInt(DEFAULT_BG_IDLE_TTL_MS, 20 * 60 * 1000);
    this.watchdogIntervalMs = asPositiveInt(DEFAULT_BG_WATCHDOG_INTERVAL_MS, 15000);
    this.scrollbackMaxSize = asPositiveInt(DEFAULT_BG_SCROLLBACK_MAX_SIZE, 12000);
    this.startupDelayMs = asPositiveInt(DEFAULT_BG_STARTUP_DELAY_MS, 3500);
    this.startupRetryMs = asPositiveInt(DEFAULT_BG_STARTUP_RETRY_MS, 6500);

    this.agents = new Map(); // paneId -> state
    this.watchdogTimer = null;
    this.lastSessionScopeId = null;
  }

  start() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      this.runWatchdogTick();
    }, this.watchdogIntervalMs);
    if (typeof this.watchdogTimer.unref === 'function') {
      this.watchdogTimer.unref();
    }
  }

  stop() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  isBackgroundPaneId(value) {
    return Boolean(resolveBackgroundBuilderPaneId(value));
  }

  resolveAlias(value) {
    return resolveBackgroundBuilderAlias(value);
  }

  resolvePaneId(value) {
    return resolveBackgroundBuilderPaneId(value);
  }

  listAgents() {
    return Array.from(this.agents.values())
      .map((entry) => ({ ...entry }))
      .sort((a, b) => String(a.paneId).localeCompare(String(b.paneId)));
  }

  notifyStateChange() {
    if (typeof this.onStateChanged !== 'function') return;
    try {
      this.onStateChanged(this.listAgents());
    } catch (err) {
      log.warn('BackgroundAgent', `State change callback failed: ${err.message}`);
    }
  }

  getAgentState(target) {
    const paneId = this.resolvePaneId(target);
    if (!paneId) return null;
    return this.agents.get(paneId) || null;
  }

  allocateAlias(requestedAlias = null) {
    if (requestedAlias) {
      const alias = this.resolveAlias(requestedAlias);
      if (!alias) return null;
      const paneId = BACKGROUND_BUILDER_ALIAS_TO_PANE[alias];
      if (!this.agents.has(paneId)) return alias;
      return null;
    }

    for (const alias of Object.keys(BACKGROUND_BUILDER_ALIAS_TO_PANE)) {
      const paneId = BACKGROUND_BUILDER_ALIAS_TO_PANE[alias];
      if (!this.agents.has(paneId)) return alias;
    }
    return null;
  }

  buildStartupContract({ alias, paneId, runtime }) {
    const modelShim = runtime === 'gemini'
      ? 'GEMINI.md'
      : (runtime === 'codex' ? 'CODEX.md' : 'CLAUDE.md');

    return sanitizeMultilineForPty(
      `You are ${alias} (${paneId}), a headless Background Builder Agent. `
      + `Read ROLES.md, ${modelShim}, workspace/handoffs/session.md, and .hivemind/app-status.json before work. `
      + `Owner binding is strict: report only to Builder (pane 2) via `
      + `node ui/scripts/hm-send.js builder \"(${alias.toUpperCase()} #1): online and ready\" --role ${alias}. `
      + `Never message Architect directly. `
      + `When a delegated task is complete, send Builder a completion update.`
    );
  }

  buildAgentState({ alias, paneId, ownerPaneId, runtime, command, sessionScopeId }) {
    return {
      alias,
      paneId,
      ownerPaneId,
      runtime,
      command,
      status: 'starting',
      createdAtMs: Date.now(),
      lastActivityAtMs: Date.now(),
      sessionScopeId: sessionScopeId || null,
      completionReason: null,
    };
  }

  async ensureDaemonConnected() {
    const daemonClient = this.getDaemonClient();
    if (!daemonClient) {
      return { ok: false, reason: 'daemon_missing' };
    }
    if (daemonClient.connected) {
      return { ok: true, daemonClient };
    }
    try {
      const connected = await daemonClient.connect();
      if (!connected) {
        return { ok: false, reason: 'daemon_connect_failed' };
      }
      return { ok: true, daemonClient };
    } catch (err) {
      return { ok: false, reason: 'daemon_connect_failed', error: err.message };
    }
  }

  logEvent(type, paneId, message, details = {}) {
    if (!this.logActivity) return;
    try {
      this.logActivity(type, paneId, message, {
        subsystem: 'background-agent',
        ...details,
      });
    } catch (err) {
      log.warn('BackgroundAgent', `Activity log failed: ${err.message}`);
    }
  }

  async spawnAgent(options = {}) {
    const ownerPaneId = String(options.ownerPaneId || BACKGROUND_BUILDER_OWNER_PANE_ID);
    if (ownerPaneId !== BACKGROUND_BUILDER_OWNER_PANE_ID) {
      return { ok: false, reason: 'owner_binding_violation', ownerPaneId };
    }

    if (this.agents.size >= this.maxAgents) {
      return { ok: false, reason: 'capacity_reached', maxAgents: this.maxAgents };
    }

    const alias = this.allocateAlias(options.alias || null);
    if (!alias) {
      return { ok: false, reason: 'slot_unavailable' };
    }

    const paneId = BACKGROUND_BUILDER_ALIAS_TO_PANE[alias];
    const connection = await this.ensureDaemonConnected();
    if (!connection.ok) {
      return { ok: false, reason: connection.reason || 'daemon_unavailable', error: connection.error || null };
    }
    const daemonClient = connection.daemonClient;

    const settings = this.getSettings() || {};
    const paneCommands = settings.paneCommands && typeof settings.paneCommands === 'object'
      ? settings.paneCommands
      : {};
    const baseCommand = String(paneCommands[BACKGROUND_BUILDER_OWNER_PANE_ID] || 'codex').trim() || 'codex';
    const command = withAutonomyFlags(baseCommand, settings);
    const runtime = detectRuntime(command);
    const cwd = this.resolveBuilderCwd() || process.cwd();

    const sessionScopeId = this.getSessionScopeId();
    const state = this.buildAgentState({ alias, paneId, ownerPaneId, runtime, command, sessionScopeId });
    this.agents.set(paneId, state);
    this.notifyStateChange();

    daemonClient.spawn(
      paneId,
      cwd,
      false,
      null,
      {
        HIVEMIND_ROLE: alias,
        HIVEMIND_PANE_ID: paneId,
        HIVEMIND_PARENT_PANE_ID: ownerPaneId,
        HIVEMIND_BG_ALIAS: alias,
      },
      {
        backgroundAgent: true,
        ownerPaneId,
        scrollbackMaxSize: this.scrollbackMaxSize,
      }
    );

    this.logEvent('spawn', paneId, `Spawned background builder ${alias}`, {
      alias,
      paneId,
      runtime,
      ownerPaneId,
      cwd,
      sessionScopeId: sessionScopeId || null,
    });

    // Launch CLI and inject startup contract after the shell is ready.
    setTimeout(() => {
      const tracked = this.agents.get(paneId);
      if (!tracked) return;
      daemonClient.write(paneId, `${command}\r`);
    }, 150);

    const startupContract = this.buildStartupContract({ alias, paneId, runtime });
    setTimeout(() => {
      if (!this.agents.has(paneId)) return;
      daemonClient.write(paneId, `${startupContract}\r`);
    }, this.startupDelayMs);

    // A second send improves reliability if the CLI was still booting.
    setTimeout(() => {
      if (!this.agents.has(paneId)) return;
      daemonClient.write(paneId, `${startupContract}\r`);
    }, this.startupRetryMs);

    return {
      ok: true,
      accepted: true,
      alias,
      paneId,
      ownerPaneId,
      runtime,
      command,
      status: 'starting',
    };
  }

  async killAgent(target, options = {}) {
    const paneId = this.resolvePaneId(target);
    if (!paneId) {
      return { ok: false, reason: 'invalid_target', target };
    }
    const state = this.agents.get(paneId);
    if (!state) {
      return { ok: false, reason: 'not_running', paneId };
    }

    const reason = toTrimmedString(options.reason) || 'manual_kill';
    const daemonClient = this.getDaemonClient();
    if (daemonClient?.connected) {
      daemonClient.kill(paneId);
    }
    this.agents.delete(paneId);
    this.notifyStateChange();
    this.logEvent('stop', paneId, `Stopped background builder ${state.alias}`, {
      alias: state.alias,
      paneId,
      reason,
    });
    return {
      ok: true,
      accepted: true,
      paneId,
      alias: state.alias,
      reason,
    };
  }

  async killAll(options = {}) {
    const reason = toTrimmedString(options.reason) || 'kill_all';
    const results = [];
    for (const paneId of Array.from(this.agents.keys())) {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.killAgent(paneId, { reason });
      results.push(result);
    }
    return {
      ok: true,
      accepted: true,
      reason,
      killed: results.filter((entry) => entry?.ok).length,
      results,
    };
  }

  async sendMessageToAgent(target, content, options = {}) {
    const paneId = this.resolvePaneId(target);
    if (!paneId) {
      return {
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'invalid_target',
        target,
      };
    }
    const state = this.agents.get(paneId);
    if (!state) {
      return {
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'agent_not_running',
        paneId,
      };
    }

    const senderRole = normalizeRole(options.fromRole);
    if (senderRole !== 'builder') {
      return {
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'owner_binding_violation',
        paneId,
        senderRole: options.fromRole || null,
      };
    }

    const daemonClient = this.getDaemonClient();
    if (!daemonClient?.connected) {
      return {
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'daemon_not_connected',
        paneId,
      };
    }

    const payloadContent = appendCompletionDirective(content);
    const payload = `${payloadContent}\r`;
    daemonClient.write(paneId, payload, options.traceContext || null);
    state.status = 'running';
    state.lastActivityAtMs = Date.now();
    this.notifyStateChange();

    return {
      ok: true,
      accepted: true,
      queued: true,
      verified: true,
      status: 'delivered.daemon_write',
      paneId,
      alias: state.alias,
      mode: 'daemon-pty',
      notified: [paneId],
      deliveryId: null,
      details: {
        ownerPaneId: state.ownerPaneId,
      },
    };
  }

  handleDaemonData(paneId, data) {
    const paneKey = resolveBackgroundBuilderPaneId(paneId);
    if (!paneKey) return;
    const state = this.agents.get(paneKey);
    if (!state) return;
    state.lastActivityAtMs = Date.now();
    if (state.status === 'starting') {
      state.status = 'running';
    }

    const text = String(data || '');
    if (containsCompletionSignal(text)) {
      // Fire and forget to avoid blocking daemon event loop path.
      void this.killAgent(paneKey, { reason: 'task_completed' });
      return;
    }
    this.notifyStateChange();
  }

  handleDaemonExit(paneId, exitCode = null) {
    const paneKey = resolveBackgroundBuilderPaneId(paneId);
    if (!paneKey) {
      if (String(paneId) === BACKGROUND_BUILDER_OWNER_PANE_ID) {
        void this.killAll({ reason: 'parent_builder_exit' });
      }
      return;
    }

    const state = this.agents.get(paneKey);
    if (!state) return;
    this.agents.delete(paneKey);
    this.notifyStateChange();
    this.logEvent('exit', paneKey, `Background builder exited (${state.alias})`, {
      alias: state.alias,
      paneId: paneKey,
      exitCode,
    });
  }

  handleDaemonKilled(paneId) {
    const paneKey = resolveBackgroundBuilderPaneId(paneId);
    if (paneKey) {
      const state = this.agents.get(paneKey);
      if (!state) return;
      this.agents.delete(paneKey);
      this.notifyStateChange();
      this.logEvent('stop', paneKey, `Background builder killed (${state.alias})`, {
        alias: state.alias,
        paneId: paneKey,
      });
      return;
    }
    if (String(paneId) === BACKGROUND_BUILDER_OWNER_PANE_ID) {
      void this.killAll({ reason: 'parent_builder_killed' });
    }
  }

  syncWithDaemonTerminals(terminals = []) {
    const live = new Set(
      (Array.isArray(terminals) ? terminals : [])
        .filter((term) => term && term.alive)
        .map((term) => String(term.paneId))
    );
    const daemonClient = this.getDaemonClient();

    // Hard-kill orphan background panes restored from a prior parent/session lifecycle.
    for (const paneId of BACKGROUND_BUILDER_PANE_IDS) {
      if (!live.has(paneId)) continue;
      if (this.agents.has(paneId)) continue;
      if (daemonClient?.connected) {
        daemonClient.kill(paneId);
      }
      this.logEvent('stop', paneId, `Killed orphan background builder terminal (${paneId})`, {
        paneId,
        reason: 'orphan_on_sync',
      });
    }

    for (const paneId of Array.from(this.agents.keys())) {
      if (live.has(paneId)) continue;
      const state = this.agents.get(paneId);
      this.agents.delete(paneId);
      this.logEvent('warning', paneId, `Removed stale background builder state (${state?.alias || paneId})`, {
        alias: state?.alias || null,
        paneId,
        reason: 'daemon_sync_missing',
      });
    }
    this.notifyStateChange();
  }

  runWatchdogTick(nowMs = Date.now()) {
    if (this.agents.size === 0) return;
    const daemonClient = this.getDaemonClient();
    const daemonTerminals = daemonClient?.getTerminals?.() || [];
    const aliveSet = new Set(
      daemonTerminals
        .filter((term) => term && term.alive)
        .map((term) => String(term.paneId))
    );

    for (const paneId of Array.from(this.agents.keys())) {
      const state = this.agents.get(paneId);
      if (!state) continue;

      if (!aliveSet.has(paneId)) {
        this.agents.delete(paneId);
        this.logEvent('warning', paneId, `Detected orphan background builder (${state.alias})`, {
          alias: state.alias,
          paneId,
          reason: 'orphan_terminal_missing',
        });
        continue;
      }

      const daemonLastActivity = Number(daemonClient?.getLastActivity?.(paneId) || 0);
      if (Number.isFinite(daemonLastActivity) && daemonLastActivity > 0) {
        state.lastActivityAtMs = daemonLastActivity;
      }

      const idleMs = nowMs - Number(state.lastActivityAtMs || state.createdAtMs || nowMs);
      if (idleMs > this.idleTtlMs) {
        void this.killAgent(paneId, { reason: 'idle_ttl_expired' });
      }
    }
    this.notifyStateChange();
  }

  async handleSessionScopeChange(newScopeId) {
    const nextScope = toTrimmedString(newScopeId);
    const previous = this.lastSessionScopeId;
    this.lastSessionScopeId = nextScope || null;
    if (!previous || !nextScope || previous === nextScope) {
      return { ok: true, changed: false };
    }

    const result = await this.killAll({ reason: 'session_rollover' });
    return { ok: true, changed: true, result };
  }

  getTargetMap() {
    return {
      ownerPaneId: BACKGROUND_BUILDER_OWNER_PANE_ID,
      maxAgents: BACKGROUND_BUILDER_MAX_AGENTS,
      aliases: { ...BACKGROUND_BUILDER_ALIAS_TO_PANE },
      paneIds: [...BACKGROUND_BUILDER_PANE_IDS],
      paneToAlias: { ...BACKGROUND_BUILDER_PANE_TO_ALIAS },
    };
  }
}

function createBackgroundAgentManager(options = {}) {
  return new BackgroundAgentManager(options);
}

module.exports = {
  BackgroundAgentManager,
  createBackgroundAgentManager,
  containsCompletionSignal,
  appendCompletionDirective,
};
