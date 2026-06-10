'use strict';

const crypto = require('crypto');

const DEFAULT_COOLDOWN_MS = 30000;
const RESTART_OPERATION_ORDER = Object.freeze(['pty-kill', 'pty-create', 'spawn-claude']);

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function createClaimId() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `restart-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function getWebContentsId(webContents) {
  if (!webContents || typeof webContents !== 'object') return null;
  const rawId = webContents.id ?? webContents._id ?? null;
  return rawId === null || rawId === undefined ? null : String(rawId);
}

function webContentsDestroyed(webContents) {
  if (!webContents || typeof webContents !== 'object') return false;
  if (typeof webContents.isDestroyed === 'function') {
    return webContents.isDestroyed() === true;
  }
  return false;
}

function sameWebContents(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const aId = getWebContentsId(a);
  const bId = getWebContentsId(b);
  return Boolean(aId && bId && aId === bId);
}

function publicClaim(claim) {
  if (!claim) return null;
  return {
    claimId: claim.claimId,
    paneId: claim.paneId,
    source: claim.source,
    ownerWindowKey: claim.ownerWindowKey,
    generation: claim.generation,
    createdAt: claim.createdAt,
  };
}

function normalizeOperation(value) {
  const operation = toNonEmptyString(value);
  return operation && RESTART_OPERATION_ORDER.includes(operation) ? operation : null;
}

function createPaneRestartArbiter(options = {}) {
  const activeByPane = new Map();
  const cooldownByPane = new Map();
  let generationCounter = 0;
  const cooldownMs = Number.isFinite(Number(options.cooldownMs))
    ? Math.max(0, Number(options.cooldownMs))
    : DEFAULT_COOLDOWN_MS;
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const resolveOwner = typeof options.resolveOwner === 'function'
    ? options.resolveOwner
    : () => ({ ownerWindowKey: 'main', webContents: null });

  function attachDestroyedHook(claim) {
    const webContents = claim.webContents;
    if (!webContents || typeof webContents.once !== 'function') return;
    try {
      webContents.once('destroyed', () => {
        const current = activeByPane.get(claim.paneId);
        if (!current || current.claimId !== claim.claimId) return;
        complete({
          paneId: claim.paneId,
          claimId: claim.claimId,
          status: 'owner_webcontents_destroyed',
          reason: 'owner_webcontents_destroyed',
        });
      });
    } catch (_) {
      // Best effort; completion reports still release the lease.
    }
  }

  function begin(request = {}) {
    const paneId = toNonEmptyString(String(request.paneId || ''));
    if (!paneId) {
      return { ok: false, granted: false, reason: 'missing_pane_id' };
    }
    const now = nowFn();
    const active = activeByPane.get(paneId);
    if (active) {
      return {
        ok: true,
        granted: false,
        coalesced: true,
        reason: 'restart_in_progress',
        paneId,
        activeClaimId: active.claimId,
        claim: publicClaim(active),
      };
    }

    const cooldown = cooldownByPane.get(paneId);
    if (cooldown && Number(cooldown.until) > now) {
      return {
        ok: true,
        granted: false,
        coalesced: true,
        reason: 'restart_cooldown_active',
        paneId,
        cooldownUntil: cooldown.until,
        activeClaimId: cooldown.claimId || null,
      };
    }
    if (cooldown) {
      cooldownByPane.delete(paneId);
    }

    const owner = resolveOwner(paneId, request) || {};
    const ownerWindowKey = toNonEmptyString(owner.ownerWindowKey || owner.windowKey) || 'main';
    const ownerWebContents = owner.webContents || null;
    const requestWebContents = request.webContents || null;
    const claimingWebContents = ownerWebContents || requestWebContents || null;

    if (owner.requiresWebContents === true && !ownerWebContents) {
      return {
        ok: false,
        granted: false,
        reason: 'restart_owner_unavailable',
        paneId,
        ownerWindowKey,
      };
    }

    if (requestWebContents && ownerWebContents && !sameWebContents(requestWebContents, ownerWebContents)) {
      return {
        ok: false,
        granted: false,
        reason: 'restart_owner_mismatch',
        paneId,
        ownerWindowKey,
      };
    }
    if (claimingWebContents && webContentsDestroyed(claimingWebContents)) {
      return {
        ok: false,
        granted: false,
        reason: 'owner_webcontents_destroyed',
        paneId,
        ownerWindowKey,
      };
    }

    const claim = {
      claimId: createClaimId(),
      paneId,
      source: toNonEmptyString(request.source || request.reason) || 'unknown',
      ownerWindowKey,
      generation: ++generationCounter,
      createdAt: now,
      webContents: claimingWebContents,
      webContentsId: getWebContentsId(claimingWebContents),
      nextOperationIndex: 0,
      completedOperations: new Set(),
    };
    activeByPane.set(paneId, claim);
    attachDestroyedHook(claim);
    return {
      ok: true,
      granted: true,
      coalesced: false,
      paneId,
      claim: publicClaim(claim),
    };
  }

  function validate(request = {}) {
    const paneId = toNonEmptyString(String(request.paneId || ''));
    const claimId = toNonEmptyString(String(request.claimId || ''));
    if (!paneId) return { ok: false, reason: 'missing_pane_id' };
    if (!claimId) return { ok: false, reason: 'missing_restart_claim' };
    const active = activeByPane.get(paneId);
    if (!active) return { ok: false, reason: 'restart_claim_not_active', paneId, claimId };
    if (active.claimId !== claimId) {
      return { ok: false, reason: 'restart_claim_mismatch', paneId, claimId, activeClaimId: active.claimId };
    }
    if (active.webContents && request.webContents && !sameWebContents(active.webContents, request.webContents)) {
      return {
        ok: false,
        reason: 'restart_claim_sender_mismatch',
        paneId,
        claimId,
        ownerWindowKey: active.ownerWindowKey,
      };
    }
    return { ok: true, paneId, claimId, claim: publicClaim(active) };
  }

  function authorizeOperation(request = {}) {
    const operation = normalizeOperation(request.operation || request.stage);
    if (!operation) {
      return { ok: false, reason: 'unsupported_restart_operation' };
    }
    const validation = validate(request);
    if (!validation?.ok) {
      return validation;
    }
    const active = activeByPane.get(validation.paneId);
    if (!active) {
      return { ok: false, reason: 'restart_claim_not_active', paneId: validation.paneId, claimId: validation.claimId };
    }
    const expectedOperation = RESTART_OPERATION_ORDER[active.nextOperationIndex] || null;
    if (active.completedOperations.has(operation)) {
      return {
        ok: false,
        reason: 'restart_operation_already_consumed',
        paneId: validation.paneId,
        claimId: validation.claimId,
        operation,
        expectedOperation,
      };
    }
    if (operation !== expectedOperation) {
      return {
        ok: false,
        reason: 'restart_operation_out_of_order',
        paneId: validation.paneId,
        claimId: validation.claimId,
        operation,
        expectedOperation,
      };
    }
    active.completedOperations.add(operation);
    active.nextOperationIndex += 1;
    return { ok: true, paneId: validation.paneId, claimId: validation.claimId, operation, claim: publicClaim(active) };
  }

  function complete(request = {}) {
    const paneId = toNonEmptyString(String(request.paneId || ''));
    const claimId = toNonEmptyString(String(request.claimId || ''));
    if (!paneId) return { ok: false, completed: false, reason: 'missing_pane_id' };
    if (!claimId) return { ok: false, completed: false, reason: 'missing_restart_claim', paneId };
    const active = activeByPane.get(paneId);
    if (!active) return { ok: false, completed: false, reason: 'restart_claim_not_active', paneId, claimId };
    if (active.claimId !== claimId) {
      return { ok: false, completed: false, reason: 'restart_claim_mismatch', paneId, claimId, activeClaimId: active.claimId };
    }
    if (active.webContents && request.webContents && !sameWebContents(active.webContents, request.webContents)) {
      return {
        ok: false,
        completed: false,
        reason: 'restart_claim_sender_mismatch',
        paneId,
        claimId,
        ownerWindowKey: active.ownerWindowKey,
      };
    }
    activeByPane.delete(paneId);
    const now = nowFn();
    cooldownByPane.set(paneId, {
      until: now + cooldownMs,
      claimId,
      status: request.status || null,
      reason: request.reason || null,
      completedAt: now,
    });
    return { ok: true, completed: true, paneId, claimId, cooldownUntil: now + cooldownMs };
  }

  function getActiveClaim(paneIdValue) {
    const paneId = toNonEmptyString(String(paneIdValue || ''));
    if (!paneId) return null;
    const active = activeByPane.get(paneId);
    return active ? publicClaim(active) : null;
  }

  function getSnapshot() {
    return {
      active: Array.from(activeByPane.values()).map(publicClaim),
      cooldowns: Array.from(cooldownByPane.entries()).map(([paneId, entry]) => ({ paneId, ...entry })),
    };
  }

  return {
    begin,
    validate,
    authorizeOperation,
    complete,
    getActiveClaim,
    getSnapshot,
    cooldownMs,
  };
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  RESTART_OPERATION_ORDER,
  createPaneRestartArbiter,
};
