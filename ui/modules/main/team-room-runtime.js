'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { getProjectRoot } = require('../../config');
const {
  DEFAULT_PROFILE_NAME,
  DEFAULT_ROOM_ID,
  DEFAULT_ROOM_MEMBERS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MEMBER_KINDS,
} = require('./team-room-contracts');
const { TeamRoomAuth, hashToken, isPrivateLanHostname, safeNetworkPolicy } = require('./team-room-auth');
const { inspectAttachmentFile, resolveSafeExistingFile } = require('./team-room-attachments');
const { TeamRoomDeliveryAdapter } = require('./team-room-delivery-adapter');
const { buildPairingUrl, renderPairingQrDataUrl } = require('./team-room-qr');
const { TeamRoomService } = require('./team-room-service');
const { TeamRoomStore } = require('./team-room-store');
const { TeamRoomUploadManager } = require('./team-room-upload');

const DEFAULT_COOKIE_NAME = 'squidrun_team_room';
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_REQUEST_BYTES = 320 * 1024;
const PAIRING_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS_PER_WINDOW = 8;
const DEFAULT_STALE_CLAIM_MS = 30_000;
const DEFAULT_CLAIM_RECOVERY_INTERVAL_MS = 5_000;
const DEFAULT_REMOTE_HOST = '127.0.0.1';
const DEFAULT_REMOTE_PORT = 9911;
const APP_GENERATION_PATTERN = /^app-(?:session-\d+|\d+-\d+)(?:[-:][A-Za-z0-9._-]+)?$/u;
const CLI_BINDING_FIELDS = Object.freeze(['role', 'paneId', 'profileName', 'paneLaunchId', 'appGeneration']);

const STATIC_FILES = Object.freeze({
  '/': { file: 'team-room.html', type: 'text/html; charset=utf-8' },
  '/team-room.css': { file: 'team-room.css', type: 'text/css; charset=utf-8' },
  '/team-room.js': { file: 'team-room.js', type: 'text/javascript; charset=utf-8' },
  '/team-room.webmanifest': { file: 'team-room.webmanifest', type: 'application/manifest+json; charset=utf-8' },
  '/team-room-sw.js': { file: 'team-room-sw.js', type: 'text/javascript; charset=utf-8' },
  '/team-room-icon-192.png': { file: 'team-room-icon-192.png', type: 'image/png' },
  '/team-room-icon-512.png': { file: 'team-room-icon-512.png', type: 'image/png' },
  '/team-room-icon-180.png': { file: 'team-room-icon-180.png', type: 'image/png' },
});

const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self' ws: wss:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

function normalizeHostForUrl(host) {
  const value = String(host || '').trim();
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
}

function normalizeRemoteAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return address.startsWith('::ffff:') ? address.slice(7) : address.replace(/^\[|\]$/gu, '');
}

function normalizeRemoteTeamRoomOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.includes('*')) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || !parsed.hostname.toLowerCase().endsWith('.ts.net')) {
    return null;
  }
  return parsed.origin.toLowerCase();
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function timingSafeCodeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function writeJsonAtomic(filePath, value, mode = 0o600, ownedTemporaryPaths = null) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  ownedTemporaryPaths?.add(temporaryPath);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      removeFileIfPresent(temporaryPath);
      ownedTemporaryPaths?.delete(temporaryPath);
    } catch (cleanupError) {
      error.atomicCleanupError = cleanupError;
    }
    throw error;
  }
  ownedTemporaryPaths?.delete(temporaryPath);
  try { fs.chmodSync(filePath, mode); } catch {}
}

function removeFileIfPresent(filePath) {
  try { fs.unlinkSync(filePath); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function cliBindingsEqual(left, right) {
  return CLI_BINDING_FIELDS.every((field) => String(left?.[field] || '') === String(right?.[field] || ''));
}

function normalizeInterfaceAddress(value) {
  const raw = String(value || '').trim().toLowerCase();
  const unwrapped = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return unwrapped.split('%', 1)[0];
}

function resolveLocalInterfaceAddresses(networkInterfaces = os.networkInterfaces()) {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const address = normalizeInterfaceAddress(entry?.address);
      if (address && !addresses.includes(address)) addresses.push(address);
    }
  }
  return addresses.sort();
}

function resolveTeamRoomNetworkOptions(env = process.env, options = {}) {
  const lanEnabled = /^(?:1|true|yes|on)$/iu.test(String(env.SQUIDRUN_TEAM_ROOM_LAN || '').trim());
  const host = String(env.SQUIDRUN_TEAM_ROOM_HOST || (lanEnabled ? '' : '127.0.0.1')).trim();
  const rawPort = Number.parseInt(String(env.SQUIDRUN_TEAM_ROOM_PORT || '0'), 10);
  const port = Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65_535 ? rawPort : 0;
  const allowedOrigins = String(env.SQUIDRUN_TEAM_ROOM_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (lanEnabled && !host) return { ok: false, reason: 'room_lan_exact_host_required' };
  if (lanEnabled && port === 0) return { ok: false, reason: 'room_lan_fixed_port_required' };
  const origins = lanEnabled && allowedOrigins.length === 0
    ? [`http://${normalizeHostForUrl(host)}:${port}`]
    : allowedOrigins;
  const policy = safeNetworkPolicy({ bindHost: host, lanEnabled, allowedOrigins: origins });
  if (!policy.ok) return policy;
  if (lanEnabled) {
    const localAddresses = Array.isArray(options.localAddresses)
      ? [...new Set(options.localAddresses.map(normalizeInterfaceAddress).filter(Boolean))].sort()
      : resolveLocalInterfaceAddresses(options.networkInterfaces);
    if (!localAddresses.includes(normalizeInterfaceAddress(host))) {
      return {
        ok: false,
        reason: 'room_lan_bind_host_not_local',
        host,
        localAddresses,
      };
    }
  }
  return { ok: true, host, port, lanEnabled, allowedOrigins: origins };
}

function jsonResponse(response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...extraHeaders,
  });
  response.end(body);
}

function resultStatus(result) {
  if (result?.ok === true) return 200;
  const reason = String(result?.reason || '');
  if (reason.includes('bearer') || reason.includes('credential')) return 401;
  if (reason.includes('forbidden') || reason.includes('capability') || reason.includes('mismatch')
    || reason.includes('owner_required')) return 403;
  if (reason.includes('not_found')) return 404;
  if (reason.includes('fused') || reason.includes('conflict') || reason.includes('already') || reason.includes('duplicate')) return 409;
  return 400;
}

function contentDispositionFilename(value) {
  const fallback = String(value || 'attachment').replace(/[\r\n"\\]/gu, '_').slice(0, 180) || 'attachment';
  return `filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(String(value || fallback))}`;
}

function parseSingleByteRange(header, size) {
  const value = String(header || '').trim();
  if (!value) return { ok: true, start: 0, end: size - 1, partial: false };
  if (value.includes(',')) return { ok: false, reason: 'room_media_multi_range_forbidden' };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return { ok: false, reason: 'room_media_range_invalid' };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { ok: false, reason: 'room_media_range_invalid' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      return { ok: false, reason: 'room_media_range_invalid' };
    }
    end = Math.min(end, size - 1);
  }
  if (size <= 0 || start >= size) return { ok: false, reason: 'room_media_range_unsatisfiable' };
  return { ok: true, start, end, partial: true };
}

async function readJsonBody(request, limit = MAX_REQUEST_BYTES) {
  const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('room_json_content_type_required');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('room_request_too_large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('room_json_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('room_json_object_required');
  }
  return parsed;
}

class TeamRoomPairingRegistry {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.randomInt = typeof options.randomInt === 'function' ? options.randomInt : crypto.randomInt;
    this.ttlMs = Number(options.ttlMs) || DEFAULT_PAIRING_TTL_MS;
    this.records = new Map();
    this.attempts = new Map();
  }

  prune(nowMs = Number(this.now())) {
    for (const [id, record] of this.records) {
      if (record.expiresAtMs <= nowMs || record.consumedAtMs !== null) this.records.delete(id);
    }
    for (const [address, entry] of this.attempts) {
      if (entry.windowStartedAtMs + PAIRING_ATTEMPT_WINDOW_MS <= nowMs) this.attempts.delete(address);
    }
  }

  create(mode = 'lan') {
    const nowMs = Number(this.now());
    this.prune(nowMs);
    const code = String(this.randomInt(0, 1_000_000)).padStart(6, '0');
    const pairingId = `trp_${crypto.randomUUID()}`;
    this.records.set(pairingId, {
      pairingId,
      codeHash: hashToken(code),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
      consumedAtMs: null,
      failedAttempts: 0,
      mode: mode === 'remote' ? 'remote' : 'lan',
    });
    return { pairingId, code, expiresAtMs: nowMs + this.ttlMs };
  }

  claim(code, remoteAddress, mode = 'lan') {
    const nowMs = Number(this.now());
    this.prune(nowMs);
    const address = normalizeRemoteAddress(remoteAddress);
    const prior = this.attempts.get(address);
    const attemptState = prior && prior.windowStartedAtMs + PAIRING_ATTEMPT_WINDOW_MS > nowMs
      ? prior
      : { count: 0, windowStartedAtMs: nowMs };
    attemptState.count += 1;
    this.attempts.set(address, attemptState);
    if (attemptState.count > MAX_PAIRING_ATTEMPTS_PER_WINDOW) {
      return { ok: false, reason: 'room_pairing_rate_limited' };
    }
    const normalizedCode = String(code || '').trim();
    if (!/^\d{6}$/u.test(normalizedCode)) return { ok: false, reason: 'room_pairing_code_invalid' };
    for (const [pairingId, record] of this.records) {
      if (!timingSafeCodeEqual(record.codeHash, hashToken(normalizedCode))) continue;
      if (record.expiresAtMs <= nowMs) return { ok: false, reason: 'room_pairing_expired' };
      if (record.consumedAtMs !== null) return { ok: false, reason: 'room_pairing_consumed' };
      if (record.mode !== mode) return { ok: false, reason: 'room_pairing_ingress_mismatch' };
      record.consumedAtMs = nowMs;
      this.records.delete(pairingId);
      return { ok: true, pairingId };
    }
    return { ok: false, reason: 'room_pairing_code_invalid' };
  }
}

class TeamRoomRuntime {
  constructor(options = {}) {
    this.projectRoot = path.resolve(options.projectRoot || getProjectRoot());
    this.publicRoot = path.resolve(options.publicRoot || path.join(__dirname, '..', '..'));
    this.runtimeRoot = path.resolve(options.runtimeRoot || path.join(this.projectRoot, '.squidrun', 'runtime', 'team-room'));
    this.manifestPath = path.resolve(options.manifestPath || path.join(this.runtimeRoot, 'runtime.json'));
    this.credentialsRoot = path.resolve(options.credentialsRoot || path.join(this.runtimeRoot, 'credentials'));
    this.store = options.store || new TeamRoomStore(options.storeOptions || {});
    this.uploadManager = options.uploadManager || new TeamRoomUploadManager({
      store: this.store,
      attachmentRoot: this.store.attachmentRoot,
      trustedRoot: this.projectRoot,
      ...(options.uploadOptions || {}),
    });
    this.deliverToPane = typeof options.deliverToPane === 'function' ? options.deliverToPane : null;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
    this.host = String(options.host || '127.0.0.1').trim();
    this.port = Number.isSafeInteger(Number(options.port)) ? Number(options.port) : 0;
    this.lanEnabled = options.lanEnabled === true;
    this.configuredOrigins = Array.isArray(options.allowedOrigins) ? options.allowedOrigins : [];
    this.cookieName = String(options.cookieName || DEFAULT_COOKIE_NAME);
    this.configuredAppGeneration = String(options.appGeneration || '').trim();
    this.appGeneration = null;
    this.resolveCliBindings = typeof options.resolveCliBindings === 'function' ? options.resolveCliBindings : null;
    this.cliBindings = null;
    this.cliCredentialIds = new Map();
    this.startedAtMs = null;
    this.staleClaimMs = Math.max(1_000, Number(options.staleClaimMs) || DEFAULT_STALE_CLAIM_MS);
    this.claimRecoveryIntervalMs = Math.min(
      this.staleClaimMs,
      Math.max(250, Number(options.claimRecoveryIntervalMs) || DEFAULT_CLAIM_RECOVERY_INTERVAL_MS)
    );
    this.claimRecoveryTimer = null;
    this.registrations = new Map();
    this.auth = null;
    this.service = null;
    this.server = null;
    this.remoteServer = null;
    this.webSocketServer = null;
    this.origin = null;
    this.allowedOrigins = new Set();
    this.remoteHost = String(options.remoteHost || DEFAULT_REMOTE_HOST).trim();
    this.remotePort = Number.isInteger(Number(options.remotePort)) ? Number(options.remotePort) : DEFAULT_REMOTE_PORT;
    this.remoteOrigin = normalizeRemoteTeamRoomOrigin(options.remoteOrigin);
    this.requestIngress = new WeakMap();
    this.getRemoteAccessStatus = typeof options.getRemoteAccessStatus === 'function'
      ? options.getRemoteAccessStatus
      : async () => ({ ok: false, enabled: false, reason: 'team_room_remote_access_unavailable' });
    this.setRemoteAccessEnabled = typeof options.setRemoteAccessEnabled === 'function'
      ? options.setRemoteAccessEnabled
      : async () => ({ ok: false, enabled: false, reason: 'team_room_remote_access_unavailable' });
    this.remoteIngressResult = { ok: false, reason: 'team_room_remote_ingress_not_started' };
    this.clients = new Set();
    this.electronCredentialIds = new Set();
    this.startPromise = null;
    this.stopPromise = null;
    this.runtimePublished = false;
    this.ownedAtomicTemporaryPaths = new Set();
    this.pairing = options.pairing || new TeamRoomPairingRegistry({ now: this.now });
    this.dispatchPromises = new Set();
    this.retryTimers = new Set();
  }

  get status() {
    return {
      running: Boolean(this.server?.listening),
      origin: this.origin,
      host: this.host,
      port: this.server?.address()?.port || null,
      lanEnabled: this.lanEnabled,
      manifestPath: this.manifestPath,
      remote: {
        listening: Boolean(this.remoteServer?.listening),
        host: this.remoteHost,
        port: this.remoteServer?.address()?.port || null,
        origin: this.remoteOrigin,
        reason: this.remoteIngressResult?.ok ? null : this.remoteIngressResult?.reason,
      },
    };
  }

  setRemoteOrigin(value) {
    if (value === null || value === undefined || value === '') {
      this.remoteOrigin = null;
      this._disconnectRemoteClients();
      return { ok: true, origin: null };
    }
    const origin = normalizeRemoteTeamRoomOrigin(value);
    if (!origin) return { ok: false, reason: 'team_room_remote_origin_invalid' };
    this.remoteOrigin = origin;
    return { ok: true, origin };
  }

  get remoteTargetOrigin() {
    if (!this.remoteServer?.listening) return null;
    const port = this.remoteServer?.address()?.port || this.remotePort;
    return `http://${DEFAULT_REMOTE_HOST}:${port}`;
  }

  _resolveTrustedRegistration = (registration = {}) => {
    const token = String(registration.registrationToken || '').trim();
    const record = this.registrations.get(token);
    if (!record) return { ok: false, reason: 'trusted_registration_invalid' };
    this.registrations.delete(token);
    const source = String(record.identity?.source || '');
    if ((record.registrationAuthority === 'runtime_registry' && source !== 'room_cli')
      || (record.registrationAuthority === 'paired_device' && source !== 'room_web')) {
      return { ok: false, reason: 'trusted_registration_source_mismatch' };
    }
    return {
      ok: true,
      registrationAuthority: record.registrationAuthority,
      credentialSessionKind: record.credentialSessionKind,
      identity: record.identity,
    };
  };

  _issueCredential(memberId, source, registrationAuthority = 'runtime_registry', options = {}) {
    const member = this.store.getMember(memberId, DEFAULT_ROOM_ID, DEFAULT_PROFILE_NAME);
    if (!member) return { ok: false, reason: 'runtime_identity_not_registered' };
    const registrationToken = this.randomBytes(32).toString('base64url');
    this.registrations.set(registrationToken, {
      registrationAuthority,
      credentialSessionKind: options.credentialSessionKind || registrationAuthority,
      identity: {
        memberId: member.memberId,
        roomId: member.roomId,
        profileName: member.profileName,
        memberKind: member.memberKind,
        role: member.role,
        paneId: member.paneId,
        source,
      },
    });
    return this.auth.issueCredential({ registrationToken }, options);
  }

  issueElectronCredential() {
    if (!this.auth) return { ok: false, reason: 'team_room_runtime_not_started' };
    const issued = this._issueCredential('james', 'room_web', 'paired_device', {
      credentialSessionKind: 'electron_window',
    });
    if (issued.ok) this.electronCredentialIds.add(issued.credential.credentialId);
    return issued;
  }

  _nextCliBindingRevision() {
    return `trb_${this.randomBytes(16).toString('hex')}`;
  }

  _sealCliBindings(bindings, priorBindings = null) {
    const sealed = {};
    for (const member of DEFAULT_ROOM_MEMBERS.filter((candidate) => candidate.memberKind === MEMBER_KINDS.AGENT)) {
      const offered = bindings?.[member.role];
      if (!offered
        || offered.role !== member.role
        || String(offered.paneId) !== String(member.paneId)
        || offered.appGeneration !== this.appGeneration) {
        throw new Error(`team_room_cli_binding_missing:${member.role}`);
      }
      const prior = priorBindings?.[member.role];
      sealed[member.role] = Object.freeze({
        ...offered,
        bindingRevision: prior && cliBindingsEqual(prior, offered)
          ? prior.bindingRevision
          : this._nextCliBindingRevision(),
      });
    }
    return Object.freeze(sealed);
  }

  _credentialPayload(member, binding, issued) {
    return {
      schema: 'squidrun.team_room_cli_credential.v2',
      role: member.role,
      memberId: member.memberId,
      paneId: binding.paneId,
      profileName: binding.profileName,
      paneLaunchId: binding.paneLaunchId,
      appGeneration: this.appGeneration,
      bindingRevision: binding.bindingRevision,
      source: 'room_cli',
      token: issued.token,
      credentialId: issued.credential.credentialId,
      expiresAtMs: issued.credential.expiresAtMs,
    };
  }

  _writeCliCredentials(roles = null, bindings = this.cliBindings) {
    removeFileIfPresent(path.join(this.credentialsRoot, 'james.json'));
    const selectedRoles = roles ? new Set(roles) : null;
    const issuedByRole = new Map();
    try {
      for (const member of DEFAULT_ROOM_MEMBERS.filter((candidate) => (
        candidate.memberKind === MEMBER_KINDS.AGENT && (!selectedRoles || selectedRoles.has(candidate.role))
      ))) {
        const binding = bindings?.[member.role];
        if (!binding
          || binding.role !== member.role
          || String(binding.paneId) !== String(member.paneId)
          || binding.appGeneration !== this.appGeneration) {
          throw new Error(`team_room_cli_binding_missing:${member.role}`);
        }
        const issued = this._issueCredential(member.memberId, 'room_cli', 'runtime_registry', {
          ttlMs: 24 * 60 * 60 * 1000,
        });
        if (!issued.ok) throw new Error(issued.reason);
        issuedByRole.set(member.role, issued);
        writeJsonAtomic(
          path.join(this.credentialsRoot, `${member.role}.json`),
          this._credentialPayload(member, binding, issued),
          0o600,
          this.ownedAtomicTemporaryPaths
        );
      }
    } catch (error) {
      for (const issued of issuedByRole.values()) {
        this.store.revokeAuthCredential(issued.credential.credentialId);
      }
      throw error;
    }
    return issuedByRole;
  }

  _runtimeManifest(bindings = this.cliBindings) {
    return {
      schema: 'squidrun.team_room_runtime.v2',
      pid: process.pid,
      startedAtMs: this.startedAtMs,
      origin: this.origin,
      wsUrl: `${this.origin.replace(/^http/u, 'ws')}/ws`,
      host: this.host,
      port: Number(this.server.address().port),
      lanEnabled: this.lanEnabled,
      appGeneration: this.appGeneration,
      cliBindings: bindings,
    };
  }

  _refreshCliBindings() {
    if (!this.server?.listening || !this.runtimePublished || !this.resolveCliBindings) {
      return { ok: false, reason: 'team_room_cli_binding_refresh_unavailable' };
    }
    const resolved = this.resolveCliBindings({ appGeneration: this.appGeneration });
    if (!resolved?.ok || !resolved.bindings) {
      return { ok: false, reason: resolved?.reason || 'team_room_cli_binding_resolution_failed' };
    }
    let nextBindings;
    try {
      nextBindings = this._sealCliBindings(resolved.bindings, this.cliBindings);
    } catch (error) {
      return { ok: false, reason: error.message };
    }
    const changedRoles = Object.keys(nextBindings).filter((role) => (
      !cliBindingsEqual(this.cliBindings?.[role], nextBindings[role])
    ));
    if (changedRoles.length === 0) return { ok: true, changedRoles: [] };

    const newlyIssuedIds = [];
    try {
      const issuedByRole = this._writeCliCredentials(changedRoles, nextBindings);
      for (const role of changedRoles) {
        const priorId = this.cliCredentialIds.get(role);
        if (priorId) this.store.revokeAuthCredential(priorId);
        const issued = issuedByRole.get(role);
        newlyIssuedIds.push(issued.credential.credentialId);
      }
      // The manifest rename is the publication point. Per-role bindingRevision
      // makes every credential/manifest mix fail closed before that rename.
      writeJsonAtomic(this.manifestPath, this._runtimeManifest(nextBindings), 0o600, this.ownedAtomicTemporaryPaths);
      this.cliBindings = nextBindings;
      for (const role of changedRoles) {
        this.cliCredentialIds.set(role, issuedByRole.get(role).credential.credentialId);
      }
      return { ok: true, changedRoles };
    } catch (error) {
      for (const credentialId of newlyIssuedIds) this.store.revokeAuthCredential(credentialId);
      let cleanupDetail = null;
      if (error.atomicCleanupError) {
        try {
          this._cleanupOwnedAtomicTemporaryPaths();
          cleanupDetail = `team_room_atomic_temp_cleanup_retried:${error.atomicCleanupError.message}`;
        } catch (cleanupError) {
          cleanupDetail = `team_room_atomic_temp_cleanup_pending:${cleanupError.message}`;
        }
      }
      return {
        ok: false,
        reason: `team_room_cli_binding_rotation_failed:${error.message}`,
        ...(cleanupDetail ? { cleanupDetail } : {}),
      };
    }
  }

  _cleanupOwnedAtomicTemporaryPaths() {
    const failures = [];
    for (const temporaryPath of [...this.ownedAtomicTemporaryPaths]) {
      try {
        removeFileIfPresent(temporaryPath);
        this.ownedAtomicTemporaryPaths.delete(temporaryPath);
      } catch (error) {
        failures.push(`${temporaryPath}:${error.message}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join('|'));
  }

  _presentedCredential(request) {
    const authorization = String(request.headers.authorization || '').trim();
    let token = null;
    let transport = 'bearer';
    const bearer = /^Bearer ([A-Za-z0-9_-]{40,256})$/u.exec(authorization);
    if (bearer) token = bearer[1];
    if (!token) {
      token = parseCookies(request.headers.cookie)[this.cookieName] || null;
      transport = 'cookie';
    }
    if (!token) return { ok: false, reason: 'room_bearer_required' };
    const credential = this.store.getAuthCredentialByHash(hashToken(token));
    if (!credential) return { ok: false, reason: 'room_credential_invalid' };
    return {
      ok: true,
      authorization: `Bearer ${token}`,
      credential,
      transport,
    };
  }

  _originAllowed(request) {
    const origin = String(request.headers.origin || '').trim();
    const ingress = this.requestIngress.get(request) || 'lan';
    if (ingress === 'remote') return Boolean(origin && this.remoteOrigin && origin === this.remoteOrigin);
    return Boolean(origin && this.allowedOrigins.has(origin));
  }

  _markIngress(request, ingress) {
    this.requestIngress.set(request, ingress === 'remote' ? 'remote' : 'lan');
    return request;
  }

  _requestIngress(request) {
    return this.requestIngress.get(request) || 'lan';
  }

  _disconnectRemoteClients() {
    for (const client of [...this.clients]) {
      if (client.roomIngress !== 'remote') continue;
      this.clients.delete(client);
      try { client.terminate(); } catch {}
    }
  }

  _authenticate(request, capability, endpointSource) {
    const presented = this._presentedCredential(request);
    if (!presented.ok) return presented;
    const result = this.auth.authenticateBearer(presented.authorization, {
      requiredCapability: capability,
      roomId: DEFAULT_ROOM_ID,
      profileName: DEFAULT_PROFILE_NAME,
      source: endpointSource,
    });
    return result.ok ? { ...result, ...presented, endpointSource } : result;
  }

  _enrichMessage(message) {
    return {
      ...message,
      author: this.store.getMember(message.authorId, message.roomId, message.profileName),
      attachments: this.store.getMessageAttachments(message.messageId).map((attachment) => ({
        attachmentId: attachment.attachmentId,
        mimeType: attachment.mimeType,
        originalName: attachment.originalName,
        bytes: attachment.bytes,
        width: attachment.width,
        height: attachment.height,
        sha256: attachment.sha256,
        previewStatus: attachment.metadata?.preview?.status || (attachment.previewRelativePath ? 'ready' : 'not_available'),
        previewReason: attachment.metadata?.preview?.reason || null,
        originalUrl: `/api/media/${encodeURIComponent(attachment.attachmentId)}/original`,
        previewUrl: attachment.previewRelativePath
          ? `/api/media/${encodeURIComponent(attachment.attachmentId)}/preview`
          : null,
        downloadUrl: `/api/media/${encodeURIComponent(attachment.attachmentId)}/download`,
      })),
    };
  }

  snapshot() {
    return {
      schema: 'squidrun.team_room_snapshot.v1',
      roomId: DEFAULT_ROOM_ID,
      profileName: DEFAULT_PROFILE_NAME,
      members: this.store.listMembers(DEFAULT_ROOM_ID, DEFAULT_PROFILE_NAME),
      messages: this.store.listMessages(DEFAULT_ROOM_ID, DEFAULT_PROFILE_NAME).map((message) => this._enrichMessage(message)),
      roomState: this.store.getRoomState(DEFAULT_ROOM_ID, DEFAULT_PROFILE_NAME),
      generatedAtMs: Number(this.now()),
    };
  }

  _broadcast(payload) {
    const encoded = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState !== 1) continue;
      try { client.send(encoded); } catch {}
    }
  }

  _scheduleDispatch(activations = []) {
    const targetIds = [...new Set((activations || [])
      .filter((activation) => activation.status === 'queued')
      .map((activation) => activation.targetMemberId))];
    for (const targetMemberId of targetIds) {
      const task = Promise.resolve().then(async () => {
        const adapter = new TeamRoomDeliveryAdapter({
          store: this.store,
          deliverToPane: async (delivery) => {
            if (!this.deliverToPane) return { ok: false, reason: 'team_room_pane_delivery_unavailable' };
            const replyCommand = `node ui/scripts/hm-room.js reply --activation ${delivery.activation.activationId} --reason direct_answer --stdin`;
            return this.deliverToPane({
              ...delivery,
              prompt: `${delivery.prompt}\nActivation: ${delivery.activation.activationId}\nReply command: ${replyCommand}`,
            });
          },
        });
        const result = await adapter.dispatchSafeBoundary(targetMemberId, {
          roomId: DEFAULT_ROOM_ID,
          profileName: DEFAULT_PROFILE_NAME,
          limit: 20,
        });
        if (!result.ok && result.failed.length > 0 && this.server?.listening) {
          const activationId = result.failed[0].activationId;
          const activation = this.store.getActivation(activationId);
          if (activation && activation.attempts < 4) {
            const delayMs = Math.min(10_000, 750 * (2 ** Math.max(0, activation.attempts - 1)));
            const timer = setTimeout(() => {
              this.retryTimers.delete(timer);
              if (!this.server?.listening) return;
              const requeued = this.store.requeueFailedActivation(activationId);
              if (requeued.ok) this._scheduleDispatch([{ status: 'queued', targetMemberId }]);
            }, delayMs);
            this.retryTimers.add(timer);
          }
        }
        return result;
      }).catch(() => null).finally(() => this.dispatchPromises.delete(task));
      this.dispatchPromises.add(task);
    }
  }

  _scheduleAllPending() {
    for (const member of this.store.listMembers(DEFAULT_ROOM_ID, DEFAULT_PROFILE_NAME)) {
      if (member.memberKind === MEMBER_KINDS.AGENT && member.active) this._scheduleDispatch([{ status: 'queued', targetMemberId: member.memberId }]);
    }
  }

  _recoverStaleClaimsAndDispatch() {
    const recovered = this.store.recoverStaleClaims({ olderThanMs: this.staleClaimMs });
    if (recovered.ok && recovered.requeued > 0 && this.server?.listening) this._scheduleAllPending();
    return recovered;
  }

  _armClaimRecovery() {
    if (this.claimRecoveryTimer) clearInterval(this.claimRecoveryTimer);
    this.claimRecoveryTimer = setInterval(() => {
      if (!this.server?.listening) return;
      this._refreshCliBindings();
      this._recoverStaleClaimsAndDispatch();
    }, this.claimRecoveryIntervalMs);
    this.claimRecoveryTimer.unref?.();
  }

  async _handleSnapshot(request, response, endpointSource) {
    const authenticated = this._authenticate(request, 'read', endpointSource);
    if (!authenticated.ok) return jsonResponse(response, resultStatus(authenticated), authenticated);
    return jsonResponse(response, 200, { ok: true, snapshot: this.snapshot() });
  }

  async _handlePost(request, response, endpointSource) {
    const authenticated = this._authenticate(request, 'post', endpointSource);
    if (!authenticated.ok) return jsonResponse(response, resultStatus(authenticated), authenticated);
    if (authenticated.transport === 'cookie' && !this._originAllowed(request)) {
      return jsonResponse(response, 403, { ok: false, reason: 'room_origin_forbidden' });
    }
    let input;
    try { input = await readJsonBody(request); } catch (error) {
      return jsonResponse(response, 400, { ok: false, reason: error.message });
    }
    const payload = { ...input };
    delete payload.activationId;
    delete payload.agentInitiatedRoot;
    if (authenticated.identity.memberKind === MEMBER_KINDS.AGENT) {
      if (input.agentInitiatedRoot === true) {
        if (Object.prototype.hasOwnProperty.call(input, 'activationId')) {
          return jsonResponse(response, 400, { ok: false, reason: 'room_agent_root_activation_forbidden' });
        }
        payload.agentInitiatedRoot = true;
      } else {
        const activationId = String(input.activationId || '').trim();
        const activation = this.store.getActivation(activationId);
        if (!activation) return jsonResponse(response, 404, { ok: false, reason: 'room_activation_not_found' });
        payload.replyToMessageId = activation.messageId;
        payload.causalActivationId = activation.activationId;
      }
    } else if (Object.prototype.hasOwnProperty.call(input, 'activationId')
      || Object.prototype.hasOwnProperty.call(input, 'agentInitiatedRoot')) {
      return jsonResponse(response, 403, { ok: false, reason: 'human_causal_activation_forbidden' });
    }
    const result = this.service.post({
      authorization: authenticated.authorization,
      source: endpointSource,
      roomId: DEFAULT_ROOM_ID,
      profileName: DEFAULT_PROFILE_NAME,
      payload,
    });
    if (!result.ok) return jsonResponse(response, resultStatus(result), result);
    const enriched = this._enrichMessage(result.message);
    this._broadcast({ type: 'message', message: enriched, roomState: result.state });
    this._scheduleDispatch(result.activations);
    return jsonResponse(response, result.status === 'inserted' ? 201 : 200, { ...result, message: enriched });
  }

  async _handleUpload(request, response) {
    const authenticated = this._authenticate(request, 'media', 'room_web');
    if (!authenticated.ok) return jsonResponse(response, resultStatus(authenticated), authenticated);
    if (authenticated.transport !== 'cookie' || !this._originAllowed(request)) {
      return jsonResponse(response, 403, { ok: false, reason: 'room_origin_forbidden' });
    }
    const result = await this.uploadManager.ingestMultipartRequest(request, {
      roomId: authenticated.identity.roomId,
      profileName: authenticated.identity.profileName,
      memberId: authenticated.identity.memberId,
    });
    if (!result.ok) return jsonResponse(response, resultStatus(result), result);
    const attachment = result.attachment;
    return jsonResponse(response, result.status === 'inserted' ? 201 : 200, {
      ok: true,
      status: result.status,
      attachment: {
        attachmentId: attachment.attachmentId,
        sha256: attachment.sha256,
        mimeType: attachment.mimeType,
        originalName: attachment.originalName,
        bytes: attachment.bytes,
        width: attachment.width,
        height: attachment.height,
        previewStatus: attachment.metadata?.preview?.status || result.previewStatus,
        previewReason: attachment.metadata?.preview?.reason || result.previewReason || null,
        originalUrl: `/api/media/${encodeURIComponent(attachment.attachmentId)}/original`,
        previewUrl: attachment.previewRelativePath
          ? `/api/media/${encodeURIComponent(attachment.attachmentId)}/preview`
          : null,
        downloadUrl: `/api/media/${encodeURIComponent(attachment.attachmentId)}/download`,
      },
    });
  }

  async _handleMedia(request, response, attachmentId, variant) {
    const authenticated = this._authenticate(request, 'media', 'room_web');
    if (!authenticated.ok) return jsonResponse(response, resultStatus(authenticated), authenticated);
    const authorized = this.store.verifyReadyAttachment(attachmentId, authenticated.identity);
    if (!authorized.ok) return jsonResponse(response, resultStatus(authorized), authorized);
    const attachment = authorized.attachment;
    const preview = variant === 'preview';
    const filePath = preview ? attachment.previewLocalPath : attachment.localPath;
    if (!filePath) return jsonResponse(response, 404, { ok: false, reason: 'room_attachment_preview_not_found' });
    if (preview) {
      const previewMetadata = attachment.metadata?.preview || {};
      const verifiedPreview = inspectAttachmentFile({
        rootPath: this.store.attachmentRoot,
        filePath,
        claimedMime: 'image/webp',
        expectedBytes: previewMetadata.bytes,
        expectedSha256: previewMetadata.sha256,
        originalName: `${attachment.sha256}.webp`,
      });
      if (!verifiedPreview.ok || previewMetadata.status !== 'ready') {
        return jsonResponse(response, 404, {
          ok: false,
          reason: 'room_attachment_preview_integrity_failed',
        });
      }
    }
    const safe = resolveSafeExistingFile(this.store.attachmentRoot, filePath);
    if (!safe.ok) return jsonResponse(response, 404, { ok: false, reason: 'room_attachment_media_unavailable' });
    const range = parseSingleByteRange(request.headers.range, safe.stat.size);
    if (!range.ok) {
      return jsonResponse(response, 416, { ok: false, reason: range.reason }, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${safe.stat.size}`,
      });
    }
    const mimeType = preview ? 'image/webp' : attachment.mimeType;
    const disposition = variant === 'download' ? 'attachment' : 'inline';
    const length = range.end - range.start + 1;
    response.writeHead(range.partial ? 206 : 200, {
      ...SECURITY_HEADERS,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${disposition}; ${contentDispositionFilename(attachment.originalName)}`,
      'Content-Length': length,
      'Content-Type': mimeType,
      ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${safe.stat.size}` } : {}),
    });
    const stream = fs.createReadStream(safe.filePath, { start: range.start, end: range.end });
    stream.once('error', (error) => response.destroy(error));
    stream.pipe(response);
  }

  async _handlePairingStart(request, response) {
    const authenticated = this._authenticate(request, 'read', 'room_web');
    if (!authenticated.ok) return jsonResponse(response, resultStatus(authenticated), authenticated);
    if (authenticated.transport !== 'cookie'
      || !this.electronCredentialIds.has(authenticated.credentialId)
      || authenticated.identity.memberId !== 'james') {
      return jsonResponse(response, 403, { ok: false, reason: 'room_pairing_electron_owner_required' });
    }
    if (!this._originAllowed(request)) {
      return jsonResponse(response, 403, { ok: false, reason: 'room_origin_forbidden' });
    }
    let input;
    try { input = await readJsonBody(request, 4 * 1024); } catch (error) {
      return jsonResponse(response, 400, { ok: false, reason: error.message });
    }
    const mode = input.mode === 'remote' ? 'remote' : 'lan';
    if (mode === 'lan' && !this.lanEnabled) {
      return jsonResponse(response, 409, { ok: false, reason: 'room_lan_disabled' });
    }
    if (mode === 'remote') {
      const remoteStatus = await this.getRemoteAccessStatus();
      if (!this.remoteOrigin || remoteStatus?.enabled !== true) {
        return jsonResponse(response, 409, {
          ok: false,
          reason: remoteStatus?.reason || 'team_room_remote_access_disabled',
        });
      }
    }
    const claimOrigin = mode === 'remote' ? this.remoteOrigin : this.origin;
    const pairing = this.pairing.create(mode);
    const pairingUrl = buildPairingUrl(claimOrigin, pairing.code);
    const qrDataUrl = await renderPairingQrDataUrl(pairingUrl);
    return jsonResponse(response, 201, {
      ok: true,
      pairing: {
        code: pairing.code,
        expiresAtMs: pairing.expiresAtMs,
        claimUrl: `${claimOrigin}/`,
        mode,
        pairingUrl,
        qrDataUrl,
      },
    });
  }

  async _handlePairingClaim(request, response) {
    const ingress = this._requestIngress(request);
    if (ingress === 'lan' && !this.lanEnabled) {
      return jsonResponse(response, 409, { ok: false, reason: 'room_lan_disabled' });
    }
    if (ingress === 'remote' && !this.remoteOrigin) {
      return jsonResponse(response, 409, { ok: false, reason: 'team_room_remote_access_disabled' });
    }
    if (!this._originAllowed(request)) {
      return jsonResponse(response, 403, { ok: false, reason: 'room_origin_forbidden' });
    }
    const remoteAddress = normalizeRemoteAddress(request.socket?.remoteAddress);
    if (!isPrivateLanHostname(remoteAddress)) {
      return jsonResponse(response, 403, { ok: false, reason: 'room_pairing_private_lan_required' });
    }
    let input;
    try { input = await readJsonBody(request, 4 * 1024); } catch (error) {
      return jsonResponse(response, 400, { ok: false, reason: error.message });
    }
    const claimed = this.pairing.claim(input.code, remoteAddress, ingress);
    if (!claimed.ok) return jsonResponse(response, resultStatus(claimed), claimed);
    const issued = this._issueCredential('james', 'room_web', 'paired_device', { ttlMs: 30 * 24 * 60 * 60 * 1000 });
    if (!issued.ok) return jsonResponse(response, 500, issued);
    return jsonResponse(response, 200, { ok: true }, {
      'Set-Cookie': `${this.cookieName}=${encodeURIComponent(issued.token)};${ingress === 'remote' ? ' Secure;' : ''} HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}`,
    });
  }

  _authenticateElectronOwner(request, options = {}) {
    const authenticated = this._authenticate(request, 'read', 'room_web');
    if (!authenticated.ok) return authenticated;
    if (authenticated.transport !== 'cookie'
      || !this.electronCredentialIds.has(authenticated.credentialId)
      || authenticated.identity.memberId !== 'james') {
      return { ok: false, reason: 'room_remote_access_electron_owner_required' };
    }
    if (options.requireOrigin !== false && !this._originAllowed(request)) {
      return { ok: false, reason: 'room_origin_forbidden' };
    }
    return authenticated;
  }

  async _handleRemoteAccess(request, response) {
    const authenticated = this._authenticateElectronOwner(request, { requireOrigin: request.method !== 'GET' });
    if (!authenticated.ok) return jsonResponse(response, resultStatus(authenticated), authenticated);
    if (request.method === 'GET') {
      const result = await this.getRemoteAccessStatus();
      return jsonResponse(response, result?.ok === false ? 503 : 200, result);
    }
    let input;
    try { input = await readJsonBody(request, 4 * 1024); } catch (error) {
      return jsonResponse(response, 400, { ok: false, reason: error.message });
    }
    if (typeof input.enabled !== 'boolean') {
      return jsonResponse(response, 400, { ok: false, reason: 'team_room_remote_enabled_boolean_required' });
    }
    const result = await this.setRemoteAccessEnabled(input.enabled);
    return jsonResponse(response, result?.ok ? 200 : 503, result);
  }

  async _handleHttp(request, response) {
    if (this._requestIngress(request) === 'remote' && !this.remoteOrigin) {
      return jsonResponse(response, 503, { ok: false, reason: 'team_room_remote_access_disabled' });
    }
    const hostHeader = String(request.headers.host || '');
    let url;
    try { url = new URL(request.url || '/', `http://${hostHeader}`); } catch {
      return jsonResponse(response, 400, { ok: false, reason: 'room_url_invalid' });
    }
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse(response, 200, { ok: true, service: 'team-room', lanEnabled: this.lanEnabled });
    }
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return jsonResponse(response, 200, {
        ok: true,
        config: {
          roomName: 'Team Room',
          lanEnabled: this.lanEnabled,
          attachmentPhase: 'live',
          maxAttachmentBytes: this.uploadManager.maxBytes,
          maxAttachmentsPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
          heicPreview: 'capability-tested-per-upload',
        },
      });
    }
    if (url.pathname === '/api/snapshot' && request.method === 'GET') return this._handleSnapshot(request, response, 'room_web');
    if (url.pathname === '/api/messages' && request.method === 'POST') return this._handlePost(request, response, 'room_web');
    if (url.pathname === '/api/attachments' && request.method === 'POST') return this._handleUpload(request, response);
    if (url.pathname === '/api/cli/snapshot' && request.method === 'GET') return this._handleSnapshot(request, response, 'room_cli');
    if (url.pathname === '/api/cli/messages' && request.method === 'POST') return this._handlePost(request, response, 'room_cli');
    if (url.pathname === '/api/pairing/start' && request.method === 'POST') return this._handlePairingStart(request, response);
    if (url.pathname === '/api/pairing/claim' && request.method === 'POST') return this._handlePairingClaim(request, response);
    if (url.pathname === '/api/remote-access' && ['GET', 'POST'].includes(request.method)) {
      return this._handleRemoteAccess(request, response);
    }
    const mediaMatch = /^\/api\/media\/([A-Za-z0-9_-]{1,128})\/(original|preview|download)$/u.exec(url.pathname);
    if (mediaMatch && request.method === 'GET') return this._handleMedia(request, response, mediaMatch[1], mediaMatch[2]);
    const asset = STATIC_FILES[url.pathname];
    if (request.method !== 'GET' || !asset) return jsonResponse(response, 404, { ok: false, reason: 'room_route_not_found' });
    const filePath = path.resolve(this.publicRoot, asset.file);
    if (path.dirname(filePath) !== this.publicRoot) return jsonResponse(response, 403, { ok: false, reason: 'room_static_path_forbidden' });
    let body;
    try { body = fs.readFileSync(filePath); } catch {
      return jsonResponse(response, 404, { ok: false, reason: 'room_asset_not_found' });
    }
    response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': asset.type, 'Content-Length': body.length });
    response.end(body);
  }

  _handleUpgrade(request, socket, head) {
    let url;
    try { url = new URL(request.url || '/', `http://${request.headers.host || ''}`); } catch { socket.destroy(); return; }
    if (url.pathname !== '/ws' || !this._originAllowed(request)) { socket.destroy(); return; }
    const authenticated = this._authenticate(request, 'read', 'room_web');
    if (!authenticated.ok || authenticated.transport !== 'cookie') { socket.destroy(); return; }
    this.webSocketServer.handleUpgrade(request, socket, head, (client) => {
      client.roomIdentity = authenticated.identity;
      client.roomIngress = this._requestIngress(request);
      this.webSocketServer.emit('connection', client, request);
    });
  }

  _createIngressServer(ingress) {
    const server = http.createServer((request, response) => {
      this._markIngress(request, ingress);
      Promise.resolve(this._handleHttp(request, response)).catch((error) => {
        if (!response.headersSent) jsonResponse(response, 500, { ok: false, reason: 'team_room_internal_error' });
        else response.destroy(error);
      });
    });
    server.on('upgrade', (request, socket, head) => {
      this._markIngress(request, ingress);
      this._handleUpgrade(request, socket, head);
    });
    return server;
  }

  async _startRemoteIngress() {
    if (this.remoteServer?.listening) {
      this.remoteIngressResult = { ok: true, alreadyRunning: true };
      return { ok: true, ...this.status.remote, alreadyRunning: true };
    }
    if (this.remoteHost !== DEFAULT_REMOTE_HOST) {
      this.remoteIngressResult = { ok: false, reason: 'team_room_remote_host_not_exact_loopback' };
      return this.remoteIngressResult;
    }
    this.remoteServer = this._createIngressServer('remote');
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { this.remoteServer.off('listening', onListening); reject(error); };
        const onListening = () => { this.remoteServer.off('error', onError); resolve(); };
        this.remoteServer.once('error', onError);
        this.remoteServer.once('listening', onListening);
        this.remoteServer.listen(this.remotePort, DEFAULT_REMOTE_HOST);
      });
      this.remoteIngressResult = { ok: true };
      return { ok: true, ...this.status.remote };
    } catch (error) {
      const failedServer = this.remoteServer;
      this.remoteServer = null;
      try { failedServer.close(); } catch {}
      this.remoteIngressResult = {
        ok: false,
        reason: `team_room_remote_ingress_start_failed:${error.code || error.message}`,
      };
      return this.remoteIngressResult;
    }
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.ownedAtomicTemporaryPaths.size > 0) {
      try {
        this._cleanupOwnedAtomicTemporaryPaths();
      } catch (error) {
        return { ok: false, reason: `team_room_atomic_temp_cleanup_pending:${error.message}` };
      }
    }
    if (this.server?.listening) {
      const refreshed = this._refreshCliBindings();
      if (!refreshed.ok) return { ok: false, ...this.status, alreadyRunning: true, reason: refreshed.reason };
      return { ok: true, ...this.status, alreadyRunning: true, cliBindingsRotated: refreshed.changedRoles };
    }
    const uploadCleanup = await this.uploadManager.recoverStaleTemporaryPaths();
    if (!uploadCleanup.ok) return uploadCleanup;
    this.startPromise = (async () => {
      const appGeneration = this.configuredAppGeneration || String(process.env.SQUIDRUN_APP_GENERATION || '').trim();
      if (!APP_GENERATION_PATTERN.test(appGeneration)) return { ok: false, reason: 'team_room_app_generation_required' };
      this.appGeneration = appGeneration;
      if (!this.resolveCliBindings) return { ok: false, reason: 'team_room_cli_binding_resolver_required' };
      const cliBindingResult = this.resolveCliBindings({ appGeneration });
      if (!cliBindingResult?.ok || !cliBindingResult.bindings) {
        return { ok: false, reason: cliBindingResult?.reason || 'team_room_cli_binding_resolution_failed' };
      }
      this.cliBindings = this._sealCliBindings(cliBindingResult.bindings);
      const policyResult = safeNetworkPolicy({
        bindHost: this.host,
        lanEnabled: this.lanEnabled,
        allowedOrigins: this.configuredOrigins,
      });
      if (!policyResult.ok) return policyResult;
      const initialized = this.store.init();
      if (!initialized.ok) return initialized;
      this.auth = new TeamRoomAuth({
        store: this.store,
        resolveTrustedRegistration: this._resolveTrustedRegistration,
        now: this.now,
        randomBytes: this.randomBytes,
      });
      this.service = new TeamRoomService({ store: this.store, auth: this.auth });
      this.store.revokeAuthCredentials({ source: 'room_cli', sessionKind: 'runtime_registry' });
      this.store.revokeAuthCredentials({ source: 'room_web', sessionKind: 'electron_window' });
      const issuedCliCredentials = this._writeCliCredentials();
      this.cliCredentialIds = new Map([...issuedCliCredentials.entries()].map(([role, issued]) => (
        [role, issued.credential.credentialId]
      )));
      this.webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
      this.webSocketServer.on('connection', (client) => {
        this.clients.add(client);
        client.send(JSON.stringify({ type: 'snapshot', snapshot: this.snapshot() }));
        client.on('close', () => this.clients.delete(client));
        client.on('error', () => this.clients.delete(client));
      });
      this.server = this._createIngressServer('lan');
      await new Promise((resolve, reject) => {
        const onError = (error) => { this.server.off('listening', onListening); reject(error); };
        const onListening = () => { this.server.off('error', onError); resolve(); };
        this.server.once('error', onError);
        this.server.once('listening', onListening);
        this.server.listen(this.port, this.host);
      });
      const address = this.server.address();
      const port = Number(address.port);
      this.origin = `http://${normalizeHostForUrl(this.host)}:${port}`;
      this.allowedOrigins = new Set([this.origin, ...this.configuredOrigins]);
      await this._startRemoteIngress();
      this.startedAtMs = Number(this.now());
      writeJsonAtomic(this.manifestPath, this._runtimeManifest(), 0o600, this.ownedAtomicTemporaryPaths);
      this.runtimePublished = true;
      this.store.recoverStaleClaims({ olderThanMs: this.staleClaimMs });
      this._scheduleAllPending();
      this._armClaimRecovery();
      return { ok: true, ...this.status, driver: initialized.driver };
    })().catch(async (error) => {
      const reason = `team_room_start_failed:${error.message}`;
      const cleanupDetail = error.atomicCleanupError
        ? `team_room_atomic_temp_cleanup_retried:${error.atomicCleanupError.message}`
        : null;
      try {
        await this.stop();
        return { ok: false, reason, ...(cleanupDetail ? { cleanupDetail } : {}) };
      } catch (cleanupError) {
        return {
          ok: false,
          reason,
          ...(cleanupDetail ? { cleanupDetail } : {}),
          cleanupReason: `team_room_start_cleanup_failed:${cleanupError.message}`,
        };
      }
    })
      .finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      for (const client of this.clients) {
        try { client.close(1001, 'server shutdown'); } catch {}
      }
      this.clients.clear();
      for (const timer of this.retryTimers) clearTimeout(timer);
      this.retryTimers.clear();
      if (this.claimRecoveryTimer) clearInterval(this.claimRecoveryTimer);
      this.claimRecoveryTimer = null;
      for (const credentialId of this.electronCredentialIds) {
        this.store.revokeAuthCredential(credentialId);
      }
      for (const credentialId of this.cliCredentialIds.values()) {
        this.store.revokeAuthCredential(credentialId);
      }
      this.electronCredentialIds.clear();
      if (this.webSocketServer) {
        await new Promise((resolve) => this.webSocketServer.close(() => resolve()));
        this.webSocketServer = null;
      }
      if (this.remoteServer) {
        await new Promise((resolve) => this.remoteServer.close(() => resolve()));
        this.remoteServer = null;
      }
      if (this.server) {
        await new Promise((resolve) => this.server.close(() => resolve()));
        this.server = null;
      }
      await Promise.allSettled([...this.dispatchPromises]);
      const uploadCleanup = await this.uploadManager.cleanupOwnedTemporaryPaths();
      this.store.close();
      this.auth = null;
      this.service = null;
      this.appGeneration = null;
      this.cliBindings = null;
      this.cliCredentialIds.clear();
      this.startedAtMs = null;
      this.runtimePublished = false;
      this.origin = null;
      this.remoteOrigin = null;
      this.remoteIngressResult = { ok: false, reason: 'team_room_remote_ingress_not_started' };
      this.allowedOrigins.clear();
      removeFileIfPresent(this.manifestPath);
      removeFileIfPresent(path.join(this.credentialsRoot, 'james.json'));
      for (const member of DEFAULT_ROOM_MEMBERS.filter((candidate) => candidate.memberKind === MEMBER_KINDS.AGENT)) {
        removeFileIfPresent(path.join(this.credentialsRoot, `${member.role}.json`));
      }
      this._cleanupOwnedAtomicTemporaryPaths();
      if (!uploadCleanup.ok) throw new Error(uploadCleanup.reason);
      return { ok: true };
    })().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }
}

module.exports = {
  DEFAULT_COOKIE_NAME,
  normalizeRemoteTeamRoomOrigin,
  DEFAULT_CLAIM_RECOVERY_INTERVAL_MS,
  DEFAULT_PAIRING_TTL_MS,
  DEFAULT_STALE_CLAIM_MS,
  MAX_PAIRING_ATTEMPTS_PER_WINDOW,
  MAX_REQUEST_BYTES,
  SECURITY_HEADERS,
  STATIC_FILES,
  TeamRoomPairingRegistry,
  TeamRoomRuntime,
  normalizeRemoteAddress,
  parseCookies,
  parseSingleByteRange,
  readJsonBody,
  resolveTeamRoomNetworkOptions,
  writeJsonAtomic,
};
