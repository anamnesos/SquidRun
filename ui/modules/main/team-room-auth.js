'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { EXPLICIT_ROOM_SOURCES, validateTrustedIdentity } = require('./team-room-contracts');

const TRUSTED_REGISTRATION_AUTHORITIES = new Set(['runtime_registry', 'paired_device']);
const TRUSTED_SESSION_KINDS = new Set(['runtime_registry', 'paired_device', 'electron_window']);
const ALLOWED_CAPABILITIES = new Set(['post', 'read', 'media']);
const DEFAULT_CREDENTIAL_TTL_MS = 12 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const capabilities = [...new Set(value.map((item) => String(item || '').trim().toLowerCase()))];
  return capabilities.length > 0 && capabilities.every((item) => ALLOWED_CAPABILITIES.has(item))
    ? capabilities.sort()
    : null;
}

function safeNetworkPolicy(input = {}) {
  const policy = {
    bindHost: String(input.bindHost || '127.0.0.1').trim(),
    lanEnabled: input.lanEnabled === true,
    allowedOrigins: Array.isArray(input.allowedOrigins) ? input.allowedOrigins.map((item) => String(item).trim()) : [],
    publicDirectory: input.publicDirectory === true,
    publicTunnel: input.publicTunnel === true,
    upnp: input.upnp === true,
  };
  if (policy.publicDirectory || policy.publicTunnel || policy.upnp) {
    return { ok: false, reason: 'room_public_exposure_forbidden' };
  }
  if (policy.allowedOrigins.some((origin) => !origin || origin === '*' || origin.includes('*'))) {
    return { ok: false, reason: 'room_wildcard_origin_forbidden' };
  }
  if (!policy.lanEnabled) {
    if (!['127.0.0.1', '::1', 'localhost'].includes(policy.bindHost) || policy.allowedOrigins.length > 0) {
      return { ok: false, reason: 'room_loopback_policy_required' };
    }
  } else {
    if (!isPrivateLanHostname(policy.bindHost)) return { ok: false, reason: 'room_lan_private_bind_required' };
    if (policy.allowedOrigins.length === 0) return { ok: false, reason: 'room_lan_exact_origin_required' };
    for (const origin of policy.allowedOrigins) {
      const parsed = parsePrivateNetworkOrigin(origin);
      if (!parsed.ok) return { ok: false, reason: parsed.reason === 'room_origin_not_lan_private' ? parsed.reason : 'room_origin_invalid' };
    }
  }
  return { ok: true, policy };
}

function inspectPrivateNetworkHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  const bracketed = raw.startsWith('[') || raw.endsWith(']');
  if (bracketed && !(raw.startsWith('[') && raw.endsWith(']'))) {
    return { ok: false, reason: 'room_host_literal_invalid' };
  }
  const host = bracketed ? raw.slice(1, -1) : raw;
  if (!host || ['0.0.0.0', '::'].includes(host)) return { ok: false, reason: 'room_host_not_private' };
  if (host === 'localhost') return { ok: true, host, family: 'localhost', scope: 'loopback' };
  const family = net.isIP(host);
  if (family === 4) {
    const octets = host.split('.').map(Number);
    const privateV4 = octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
    return privateV4
      ? { ok: true, host, family: 4, scope: octets[0] === 127 ? 'loopback' : 'private' }
      : { ok: false, reason: 'room_host_not_private' };
  }
  if (family === 6) {
    if (host === '::1') return { ok: true, host, family: 6, scope: 'loopback' };
    const firstHextet = Number.parseInt(host.split(':')[0], 16);
    if ((firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80) {
      return { ok: true, host, family: 6, scope: 'private' };
    }
  }
  return { ok: false, reason: 'room_host_not_private' };
}

function isPrivateLanHostname(value) {
  return inspectPrivateNetworkHost(value).ok;
}

function parsePrivateNetworkOrigin(value) {
  const raw = String(value || '').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'room_origin_invalid' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { ok: false, reason: 'room_origin_invalid' };
  }
  const host = inspectPrivateNetworkHost(parsed.hostname);
  if (!host.ok) return { ok: false, reason: 'room_origin_not_lan_private' };
  if (host.family === 4) {
    const authority = raw.slice(raw.indexOf('://') + 3).split(/[/?#]/u, 1)[0];
    const rawHost = authority.replace(/:\d+$/u, '');
    const exactDottedDecimal = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u;
    if (!exactDottedDecimal.test(rawHost) || rawHost !== host.host) {
      return { ok: false, reason: 'room_origin_invalid' };
    }
  }
  return { ok: true, origin: parsed.origin, protocol: parsed.protocol, port: parsed.port, ...host };
}

class TeamRoomAuth {
  constructor(options = {}) {
    if (!options.store) throw new Error('team_room_auth_store_required');
    this.store = options.store;
    this.resolveTrustedRegistration = typeof options.resolveTrustedRegistration === 'function'
      ? options.resolveTrustedRegistration
      : null;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
    this.randomUUID = typeof options.randomUUID === 'function' ? options.randomUUID : crypto.randomUUID;
  }

  issueCredential(registration = {}, options = {}) {
    if (!this.resolveTrustedRegistration) {
      return { ok: false, reason: 'trusted_registration_verifier_required' };
    }
    let resolved;
    try {
      resolved = this.resolveTrustedRegistration(registration);
    } catch {
      return { ok: false, reason: 'trusted_registration_invalid' };
    }
    if (!resolved || resolved.ok !== true) {
      return { ok: false, reason: resolved?.reason || 'trusted_registration_invalid' };
    }
    const authority = String(resolved.registrationAuthority || '').trim().toLowerCase();
    if (!TRUSTED_REGISTRATION_AUTHORITIES.has(authority)) {
      return { ok: false, reason: 'trusted_registration_authority_required' };
    }
    const sessionKind = String(resolved.credentialSessionKind || authority).trim().toLowerCase();
    if (!TRUSTED_SESSION_KINDS.has(sessionKind)) {
      return { ok: false, reason: 'trusted_registration_session_kind_invalid' };
    }
    const trusted = validateTrustedIdentity(resolved.identity);
    if (!trusted.ok) return trusted;
    const capabilities = normalizeCapabilities(options.capabilities || ['post', 'read', 'media']);
    if (!capabilities) return { ok: false, reason: 'room_capabilities_invalid' };
    const member = this.store.getMember(
      trusted.identity.memberId,
      trusted.identity.roomId,
      trusted.identity.profileName
    );
    if (!member
      || member.roomId !== trusted.identity.roomId
      || member.profileName !== trusted.identity.profileName
      || member.memberKind !== trusted.identity.memberKind
      || member.role !== trusted.identity.role
      || (member.memberKind === 'agent' && member.paneId !== trusted.identity.paneId)) {
      return { ok: false, reason: 'runtime_identity_not_registered' };
    }

    const nowMs = Number(this.now());
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return { ok: false, reason: 'room_clock_invalid' };
    const requestedTtlMs = options.ttlMs === undefined ? DEFAULT_CREDENTIAL_TTL_MS : Number(options.ttlMs);
    if (!Number.isSafeInteger(requestedTtlMs) || requestedTtlMs < 60_000 || requestedTtlMs > 30 * 24 * 60 * 60 * 1000) {
      return { ok: false, reason: 'room_credential_ttl_invalid' };
    }
    const tokenBytes = this.randomBytes(32);
    if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length !== 32) {
      return { ok: false, reason: 'room_credential_entropy_invalid' };
    }
    const token = tokenBytes.toString('base64url');
    const credentialId = `trc_${this.randomUUID()}`;
    const inserted = this.store.insertAuthCredential({
      credentialId,
      tokenHash: hashToken(token),
      memberId: member.memberId,
      roomId: member.roomId,
      profileName: member.profileName,
      sessionKind,
      source: trusted.identity.source,
      capabilities,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + requestedTtlMs,
    });
    if (!inserted.ok) return inserted;
    return {
      ok: true,
      token,
      credential: {
        credentialId,
        memberId: member.memberId,
        roomId: member.roomId,
        profileName: member.profileName,
        source: trusted.identity.source,
        capabilities,
        expiresAtMs: nowMs + requestedTtlMs,
      },
    };
  }

  authenticateBearer(authorization, options = {}) {
    const match = /^Bearer ([A-Za-z0-9_-]{40,256})$/u.exec(String(authorization || '').trim());
    if (!match) return { ok: false, reason: 'room_bearer_required' };
    const credential = this.store.getAuthCredentialByHash(hashToken(match[1]));
    if (!credential) return { ok: false, reason: 'room_credential_invalid' };
    const nowMs = Number(this.now());
    if (credential.revokedAtMs !== null) return { ok: false, reason: 'room_credential_revoked' };
    if (credential.expiresAtMs <= nowMs) return { ok: false, reason: 'room_credential_expired' };
    const endpointSource = String(options.source || '').trim().toLowerCase();
    if (!EXPLICIT_ROOM_SOURCES.has(endpointSource)) return { ok: false, reason: 'room_source_invalid' };
    if (credential.source !== endpointSource) return { ok: false, reason: 'room_source_mismatch' };
    const requiredCapability = String(options.requiredCapability || '').trim().toLowerCase();
    if (requiredCapability && !credential.capabilities.includes(requiredCapability)) {
      return { ok: false, reason: 'room_capability_denied' };
    }
    if (options.roomId && credential.roomId !== String(options.roomId).trim().toLowerCase()) {
      return { ok: false, reason: 'room_scope_mismatch' };
    }
    if (options.profileName && credential.profileName !== String(options.profileName).trim().toLowerCase()) {
      return { ok: false, reason: 'room_profile_mismatch' };
    }
    const member = this.store.getMember(credential.memberId, credential.roomId, credential.profileName);
    if (!member || member.active !== true || member.roomId !== credential.roomId || member.profileName !== credential.profileName) {
      return { ok: false, reason: 'room_member_inactive_or_mismatched' };
    }
    return {
      ok: true,
      credentialId: credential.credentialId,
      identity: {
        memberId: member.memberId,
        roomId: member.roomId,
        profileName: member.profileName,
        memberKind: member.memberKind,
        role: member.role,
        paneId: member.paneId,
        source: credential.source,
      },
      capabilities: credential.capabilities,
    };
  }
}

module.exports = {
  ALLOWED_CAPABILITIES,
  DEFAULT_CREDENTIAL_TTL_MS,
  TRUSTED_REGISTRATION_AUTHORITIES,
  TRUSTED_SESSION_KINDS,
  TeamRoomAuth,
  hashToken,
  inspectPrivateNetworkHost,
  isPrivateLanHostname,
  normalizeCapabilities,
  parsePrivateNetworkOrigin,
  safeNetworkPolicy,
};
