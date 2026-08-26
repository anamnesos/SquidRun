'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_HTTPS_PORT = 443;

function defaultRunCommand(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout = '', stderr = '') => {
      resolve({
        ok: !error,
        code: Number.isInteger(error?.code) ? error.code : (error ? null : 0),
        error: error?.message || null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

function defaultResolveCommand() {
  if (process.platform !== 'win32') return { ok: false, reason: 'tailscale_windows_required' };
  const allowedPath = path.resolve('C:\\Program Files\\Tailscale\\tailscale.exe');
  let resolved;
  try { resolved = fs.realpathSync.native(allowedPath); } catch {
    return { ok: false, reason: 'tailscale_executable_not_found' };
  }
  if (resolved.toLowerCase() !== allowedPath.toLowerCase()) {
    return { ok: false, reason: 'tailscale_executable_path_not_allowlisted' };
  }
  return { ok: true, command: resolved };
}

function parseJsonOutput(result, reason) {
  if (!result?.ok) {
    return {
      ok: false,
      reason: result?.reason || reason,
      detail: result?.stderr || result?.error || null,
    };
  }
  try {
    return { ok: true, value: JSON.parse(String(result.stdout || '').trim() || '{}') };
  } catch {
    return { ok: false, reason: `${reason}_invalid_json` };
  }
}

function normalizeDnsName(value) {
  const hostname = String(value || '').trim().replace(/\.+$/u, '').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.ts\.net$/u.test(hostname)) {
    return null;
  }
  return hostname;
}

function remoteOriginFromStatus(status = {}) {
  const dnsName = normalizeDnsName(status?.Self?.DNSName);
  return dnsName ? `https://${dnsName}` : null;
}

function serveStatusJsonIsEmpty(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 0);
}

function serveConfigIsRouteFree(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'version' && value.version === '0.0.1';
}

function plainStatusIsEmpty(value) {
  const normalized = String(value || '').trim();
  return normalized === '' || /^(?:no serve config|no serve configuration)$/iu.test(normalized);
}

function plainStatusHasExactRoute(value, expectedOrigin, expectedTarget) {
  const lines = String(value || '').split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
  const originLines = new Set([
    expectedOrigin,
    `${expectedOrigin}/`,
    `${expectedOrigin} (tailnet only)`,
    `${expectedOrigin}/ (tailnet only)`,
  ]);
  return lines.some((line) => originLines.has(line))
    && (lines.includes(`|-- proxy ${expectedTarget}`)
      || lines.includes(`|-- / proxy ${expectedTarget}`))
    && !lines.some((line) => /funnel/iu.test(line));
}

function serveStatusHasExactRoute(value, expectedOrigin, expectedTarget, httpsPort = DEFAULT_HTTPS_PORT) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let hostname;
  try { hostname = new URL(expectedOrigin).hostname; } catch { return false; }
  const portKey = String(httpsPort);
  const hostPort = `${hostname}:${portKey}`;
  const topKeys = Object.keys(value).sort();
  if (topKeys.length !== 2 || topKeys[0] !== 'TCP' || topKeys[1] !== 'Web') return false;
  const tcp = value.TCP;
  const web = value.Web;
  if (!tcp || typeof tcp !== 'object' || Array.isArray(tcp)
    || Object.keys(tcp).length !== 1
    || !tcp[portKey]
    || Object.keys(tcp[portKey]).length !== 1
    || tcp[portKey].HTTPS !== true) {
    return false;
  }
  if (!web || typeof web !== 'object' || Array.isArray(web)
    || Object.keys(web).length !== 1
    || !web[hostPort]
    || Object.keys(web[hostPort]).length !== 1) {
    return false;
  }
  const handlers = web[hostPort].Handlers;
  const rootHandler = handlers?.['/'];
  return Boolean(handlers
    && typeof handlers === 'object'
    && !Array.isArray(handlers)
    && Object.keys(handlers).length === 1
    && rootHandler
    && Object.keys(rootHandler).length === 1
    && rootHandler.Proxy === expectedTarget);
}

class TeamRoomTailscaleAccess {
  constructor(options = {}) {
    this.runCommand = typeof options.runCommand === 'function' ? options.runCommand : defaultRunCommand;
    this.resolveCommand = typeof options.resolveCommand === 'function'
      ? options.resolveCommand
      : defaultResolveCommand;
    this.getTargetOrigin = typeof options.getTargetOrigin === 'function'
      ? options.getTargetOrigin
      : () => 'http://127.0.0.1:9911';
    this.applyRemoteOrigin = typeof options.applyRemoteOrigin === 'function'
      ? options.applyRemoteOrigin
      : () => ({ ok: false, reason: 'team_room_remote_origin_applier_required' });
    this.httpsPort = Number.isInteger(Number(options.httpsPort))
      ? Number(options.httpsPort)
      : DEFAULT_HTTPS_PORT;
    this.transitionPromise = null;
    this.lastStatus = {
      available: false,
      enabled: false,
      origin: null,
      target: this.getTargetOrigin(),
      reason: 'tailscale_status_not_checked',
    };
  }

  get status() {
    return { ...this.lastStatus, transitionPending: Boolean(this.transitionPromise) };
  }

  async _run(args) {
    const resolved = this.resolveCommand();
    if (!resolved?.ok) {
      return {
        ok: false,
        reason: resolved?.reason || 'tailscale_executable_not_found',
        error: resolved?.reason || 'tailscale_executable_not_found',
        stdout: '',
        stderr: '',
      };
    }
    return this.runCommand(resolved.command, [...args], { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS });
  }

  async _readIdentity() {
    const parsed = parseJsonOutput(
      await this._run(['status', '--json']),
      'tailscale_status_unavailable'
    );
    if (!parsed.ok) return parsed;
    const backendState = String(parsed.value?.BackendState || '').trim();
    if (backendState !== 'Running') {
      return { ok: false, reason: 'tailscale_not_connected', backendState: backendState || null };
    }
    if (parsed.value?.Self?.Online !== true) {
      return { ok: false, reason: 'tailscale_node_offline' };
    }
    const origin = remoteOriginFromStatus(parsed.value);
    if (!origin) return { ok: false, reason: 'tailscale_dns_name_invalid' };
    return { ok: true, origin, value: parsed.value };
  }

  async _readServeEvidence() {
    const [plain, json, config] = await Promise.all([
      this._run(['serve', 'status']),
      this._run(['serve', 'status', '--json']),
      this._run(['serve', 'get-config', '--all']),
    ]);
    const jsonParsed = parseJsonOutput(json, 'tailscale_serve_status_json_failed');
    const configParsed = parseJsonOutput(config, 'tailscale_serve_get_config_failed');
    if (!plain.ok) {
      return { ok: false, reason: 'tailscale_serve_status_failed', detail: plain.stderr || plain.error || null };
    }
    if (!jsonParsed.ok) return jsonParsed;
    if (!configParsed.ok) return configParsed;
    return {
      ok: true,
      plain: String(plain.stdout || '').trim(),
      json: jsonParsed.value,
      config: configParsed.value,
    };
  }

  _applyOrigin(origin) {
    try {
      const result = this.applyRemoteOrigin(origin);
      if (result?.ok === false) {
        return { ok: false, reason: result.reason || 'team_room_remote_origin_apply_failed' };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error?.message || 'team_room_remote_origin_apply_failed' };
    }
  }

  _clearOrigin() {
    const cleared = this._applyOrigin(null);
    if (!cleared.ok) return { ok: false, reason: 'team_room_remote_origin_clear_failed', detail: cleared.reason };
    return { ok: true };
  }

  _setUnavailableStatus(reason, options = {}) {
    this.lastStatus = {
      available: options.available === true,
      enabled: false,
      origin: options.origin || null,
      target: this.getTargetOrigin(),
      reason,
    };
  }

  async inspect() {
    const identity = await this._readIdentity();
    if (!identity.ok) {
      const cleared = this._clearOrigin();
      const reason = cleared.ok ? identity.reason : cleared.reason;
      this._setUnavailableStatus(reason);
      if (!cleared.ok) this.lastStatus.detail = cleared.detail;
      return { ok: false, ...this.status };
    }
    const evidence = await this._readServeEvidence();
    if (!evidence.ok) {
      const cleared = this._clearOrigin();
      const reason = cleared.ok ? evidence.reason : cleared.reason;
      this._setUnavailableStatus(reason, { available: true, origin: identity.origin });
      if (!cleared.ok) this.lastStatus.detail = cleared.detail;
      return { ok: false, ...this.status };
    }
    const target = this.getTargetOrigin();
    const enabled = plainStatusHasExactRoute(evidence.plain, identity.origin, target)
      && serveStatusHasExactRoute(evidence.json, identity.origin, target, this.httpsPort)
      && serveConfigIsRouteFree(evidence.config);
    const empty = plainStatusIsEmpty(evidence.plain)
      && serveStatusJsonIsEmpty(evidence.json)
      && serveConfigIsRouteFree(evidence.config);
    const reason = enabled ? null : (empty ? 'tailscale_serve_disabled' : 'tailscale_serve_unrecognized_config');
    this.lastStatus = {
      available: true,
      enabled,
      origin: identity.origin,
      target,
      reason,
    };
    const applied = enabled ? this._applyOrigin(identity.origin) : this._clearOrigin();
    if (!applied.ok) {
      this.lastStatus.enabled = false;
      this.lastStatus.reason = enabled ? applied.reason : 'team_room_remote_origin_clear_failed';
      this.lastStatus.detail = applied.reason;
      return { ok: false, ...this.status, evidence };
    }
    return { ok: enabled || empty, ...this.status, evidence };
  }

  async reconcile() {
    try {
      return await this.inspect();
    } catch (error) {
      const cleared = this._clearOrigin();
      this._setUnavailableStatus(
        cleared.ok ? error?.message || 'tailscale_reconcile_failed' : cleared.reason
      );
      return { ok: false, ...this.status };
    }
  }

  async getStatus() {
    if (this.transitionPromise) {
      try { await this.transitionPromise; } catch {}
    }
    return this.inspect();
  }

  async setEnabled(enabled) {
    if (this.transitionPromise) return this.transitionPromise;
    this.transitionPromise = (enabled ? this._enable() : this._disable())
      .finally(() => { this.transitionPromise = null; });
    return this.transitionPromise;
  }

  async _enable() {
    const prior = await this.inspect();
    if (prior.ok && prior.enabled) {
      return { ...this.status, ok: true, transitionPending: false, alreadyEnabled: true };
    }
    if (!prior.ok || prior.reason !== 'tailscale_serve_disabled') {
      return {
        ...this.status,
        ok: false,
        transitionPending: false,
        reason: prior.reason || 'tailscale_serve_preflight_unverified',
      };
    }
    const identity = await this._readIdentity();
    if (!identity.ok) return { ...this.status, ok: false, transitionPending: false, reason: identity.reason };
    const target = this.getTargetOrigin();
    if (target !== 'http://127.0.0.1:9911') {
      return { ...this.status, ok: false, transitionPending: false, reason: 'team_room_remote_target_not_loopback' };
    }
    const result = await this._run([
      'serve', '--yes', '--bg', `--https=${this.httpsPort}`, target,
    ]);
    if (!result.ok) {
      return this._rollbackEnable('tailscale_serve_enable_failed', result.stderr || result.error || null);
    }
    const inspected = await this.inspect();
    if (!inspected.ok || !inspected.enabled || inspected.origin !== identity.origin) {
      return this._rollbackEnable(inspected.reason || 'tailscale_serve_enable_unverified');
    }
    return { ...this.status, ok: true, transitionPending: false };
  }

  async _resetAndVerify() {
    const reset = await this._run(['serve', 'reset']);
    if (!reset.ok) {
      const cleared = this._clearOrigin();
      this._setUnavailableStatus('tailscale_serve_reset_failed', { available: true });
      return {
        ...this.status,
        ok: false,
        transitionPending: false,
        reason: 'tailscale_serve_reset_failed',
        detail: reset.stderr || reset.error || null,
        originCleared: cleared.ok,
      };
    }
    const evidence = await this._readServeEvidence();
    if (!evidence.ok) {
      const cleared = this._clearOrigin();
      this._setUnavailableStatus(evidence.reason, { available: true });
      return {
        ...this.status,
        ok: false,
        transitionPending: false,
        reason: evidence.reason,
        originCleared: cleared.ok,
      };
    }
    const empty = plainStatusIsEmpty(evidence.plain)
      && serveStatusJsonIsEmpty(evidence.json)
      && serveConfigIsRouteFree(evidence.config);
    if (!empty) {
      const cleared = this._clearOrigin();
      this._setUnavailableStatus('tailscale_serve_reset_unverified', { available: true });
      return {
        ...this.status,
        ok: false,
        transitionPending: false,
        reason: 'tailscale_serve_reset_unverified',
        evidence,
        originCleared: cleared.ok,
      };
    }
    const cleared = this._clearOrigin();
    if (!cleared.ok) {
      this._setUnavailableStatus(cleared.reason, { available: true });
      return {
        ...this.status,
        ok: false,
        transitionPending: false,
        reason: cleared.reason,
        detail: cleared.detail,
        evidence,
      };
    }
    this.lastStatus = {
      available: true,
      enabled: false,
      origin: null,
      target: this.getTargetOrigin(),
      reason: 'tailscale_serve_disabled',
    };
    return { ...this.status, ok: true, transitionPending: false, evidence };
  }

  async _rollbackEnable(enableReason, detail = null) {
    const rollback = await this._resetAndVerify();
    if (rollback.ok) {
      return {
        ...this.status,
        ok: false,
        transitionPending: false,
        reason: enableReason,
        detail,
        rolledBack: true,
        rollbackEvidence: rollback.evidence,
      };
    }
    return {
      ...this.status,
      ok: false,
      transitionPending: false,
      reason: 'tailscale_serve_enable_rollback_failed',
      enableReason,
      detail,
      rolledBack: false,
      rollbackReason: rollback.reason,
      rollbackEvidence: rollback.evidence || null,
    };
  }

  async _disable() {
    return this._resetAndVerify();
  }
}

module.exports = {
  TeamRoomTailscaleAccess,
  defaultResolveCommand,
  defaultRunCommand,
  normalizeDnsName,
  plainStatusHasExactRoute,
  plainStatusIsEmpty,
  remoteOriginFromStatus,
  serveConfigIsRouteFree,
  serveStatusHasExactRoute,
  serveStatusJsonIsEmpty,
};
