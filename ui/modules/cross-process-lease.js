'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_LEASE_STALE_MS = 2_000;
const DEFAULT_LEASE_RETRY_MS = 10;
const OWNER_FILE_NAME = 'owner.json';

function waitSync(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(Number(ms)));
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwner(lockPath) {
  try {
    const ownerPath = fs.statSync(lockPath).isDirectory()
      ? path.join(lockPath, OWNER_FILE_NAME)
      : lockPath;
    const raw = fs.readFileSync(ownerPath, 'utf8');
    const owner = JSON.parse(raw);
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
      return { owner: null, raw };
    }
    return { owner, raw };
  } catch {
    return { owner: null, raw: null };
  }
}

function getLeaseSnapshot(lockPath, options = {}) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return {
      exists: true,
      error: err.message,
      fingerprint: `error:${err.code || err.message}`,
      owner: null,
      ownerAlive: false,
      recoverable: false,
    };
  }

  const { owner, raw } = readOwner(lockPath);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const staleMs = Number.isFinite(Number(options.staleMs))
    ? Math.max(0, Number(options.staleMs))
    : DEFAULT_LEASE_STALE_MS;
  const ownerCreatedAtMs = Date.parse(String(owner?.createdAt || ''));
  const ageBaseMs = Number.isFinite(ownerCreatedAtMs) ? ownerCreatedAtMs : stat.mtimeMs;
  const ageMs = Math.max(0, nowMs - ageBaseMs);
  const ownerPid = Number(owner?.pid);
  const hasValidOwner = (
    Number.isInteger(ownerPid)
    && ownerPid > 0
    && typeof owner?.lockToken === 'string'
    && owner.lockToken.length > 0
  );
  const processAlive = typeof options.isProcessAlive === 'function'
    ? options.isProcessAlive
    : isPidAlive;
  const ownerAlive = hasValidOwner && processAlive(ownerPid) === true;
  const fingerprint = crypto
    .createHash('sha256')
    .update([
      raw || '',
      stat.dev,
      stat.ino,
      stat.birthtimeMs,
      stat.mtimeMs,
    ].join('|'))
    .digest('hex');

  return {
    exists: true,
    ageMs,
    fingerprint,
    hasValidOwner,
    owner,
    ownerAlive,
    recoverable: ownerAlive !== true && ageMs >= staleMs,
    staleMs,
  };
}

function restoreQuarantinedLease(quarantinePath, lockPath) {
  try {
    if (fs.existsSync(lockPath)) return false;
    fs.renameSync(quarantinePath, lockPath);
    return true;
  } catch {
    return false;
  }
}

function recoverStaleLease(lockPath, observed, options = {}) {
  if (!observed?.recoverable) return false;

  const confirmed = getLeaseSnapshot(lockPath, options);
  if (
    !confirmed?.recoverable
    || confirmed.fingerprint !== observed.fingerprint
    || confirmed.ownerAlive
  ) {
    return false;
  }

  const quarantinePath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch {
    return false;
  }

  const quarantined = getLeaseSnapshot(quarantinePath, options);
  if (
    !quarantined?.recoverable
    || quarantined.fingerprint !== confirmed.fingerprint
    || quarantined.ownerAlive
  ) {
    restoreQuarantinedLease(quarantinePath, lockPath);
    return false;
  }

  fs.rmSync(quarantinePath, { recursive: true, force: true });
  return true;
}

function prepareLeaseCandidate(lockPath, owner) {
  const candidatePath = `${lockPath}.candidate-${process.pid}-${owner.lockToken}`;
  fs.writeFileSync(
    candidatePath,
    `${JSON.stringify(owner, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' }
  );
  return candidatePath;
}

function tryInstallLeaseCandidate(candidatePath, lockPath) {
  try {
    // The candidate already contains complete owner metadata. linkSync gives
    // us create-if-absent publication without the mkdir -> owner write window,
    // and unlike directory rename it cannot replace an empty destination.
    fs.linkSync(candidatePath, lockPath);
    return { ok: true };
  } catch (err) {
    if (fs.existsSync(lockPath)) {
      return { ok: false, busy: true };
    }
    return {
      ok: false,
      busy: false,
      error: err.message,
    };
  }
}

function acquireProcessLease(lockPath, options = {}) {
  if (typeof lockPath !== 'string' || !lockPath.trim()) {
    return { ok: false, reason: 'invalid_lease_path' };
  }

  const resolvedLockPath = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(resolvedLockPath), { recursive: true });
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(0, Number(options.timeoutMs))
    : 0;
  const retryMs = Number.isFinite(Number(options.retryMs))
    ? Math.max(1, Number(options.retryMs))
    : DEFAULT_LEASE_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  const lockToken = options.lockToken || crypto.randomUUID();
  const owner = {
    version: 1,
    pid: Number(options.pid) || process.pid,
    lockToken,
    createdAt: new Date().toISOString(),
    resource: typeof options.resource === 'string' && options.resource
      ? options.resource
      : null,
  };
  let recoveredStaleLease = false;

  do {
    let candidatePath = null;
    try {
      candidatePath = prepareLeaseCandidate(resolvedLockPath, owner);
      const installed = tryInstallLeaseCandidate(candidatePath, resolvedLockPath);
      if (installed.ok) {
        const installedSnapshot = getLeaseSnapshot(resolvedLockPath, options);
        if (installedSnapshot?.owner?.lockToken !== lockToken) {
          return {
            ok: false,
            reason: 'lease_ownership_lost',
            lockPath: resolvedLockPath,
          };
        }
        return {
          ok: true,
          lockPath: resolvedLockPath,
          lockToken,
          owner,
          recoveredStaleLease,
        };
      }
      if (!installed.busy) {
        return {
          ok: false,
          reason: 'lease_acquire_failed',
          error: installed.error,
          lockPath: resolvedLockPath,
        };
      }
    } catch (err) {
      return {
        ok: false,
        reason: 'lease_acquire_failed',
        error: err.message,
        lockPath: resolvedLockPath,
      };
    } finally {
      if (candidatePath) {
        fs.rmSync(candidatePath, { recursive: true, force: true });
      }
    }

    const observed = getLeaseSnapshot(resolvedLockPath, options);
    if (observed?.recoverable && recoverStaleLease(resolvedLockPath, observed, options)) {
      recoveredStaleLease = true;
      continue;
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        reason: 'lease_busy',
        lockPath: resolvedLockPath,
        owner: observed?.owner || null,
      };
    }
    waitSync(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return {
    ok: false,
    reason: 'lease_busy',
    lockPath: resolvedLockPath,
  };
}

function isProcessLeaseOwner(lease) {
  if (!lease?.ok || !lease.lockPath || !lease.lockToken) return false;
  const snapshot = getLeaseSnapshot(lease.lockPath);
  return snapshot?.owner?.lockToken === lease.lockToken;
}

function releaseProcessLease(lease) {
  if (!isProcessLeaseOwner(lease)) return false;

  const releasePath = `${lease.lockPath}.release-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lease.lockPath, releasePath);
  } catch {
    return false;
  }

  const released = getLeaseSnapshot(releasePath);
  if (released?.owner?.lockToken !== lease.lockToken) {
    restoreQuarantinedLease(releasePath, lease.lockPath);
    return false;
  }
  fs.rmSync(releasePath, { recursive: true, force: true });
  return true;
}

module.exports = {
  DEFAULT_LEASE_STALE_MS,
  acquireProcessLease,
  getLeaseSnapshot,
  isPidAlive,
  isProcessLeaseOwner,
  releaseProcessLease,
};
