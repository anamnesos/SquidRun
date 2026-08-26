#!/usr/bin/env node
'use strict';

// Thin cross-session spool only: list + acknowledge. Deliberately no routing,
// threading, priorities, replies, or delivery semantics; those belong to the
// future kernel inbox, not this bounded W5 bridge.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VALID_ROLES = new Set(['architect', 'builder', 'oracle']);

function parseArgs(argv = []) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      flags[key] = String(next);
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return VALID_ROLES.has(role) ? role : null;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonResult(filePath) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: 'json_root_not_object', payload: null };
    }
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, reason: 'json_read_or_parse_failed', error: error.message, payload: null };
  }
}

function ensureDirectoryFor(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function writeJsonAtomic(filePath, payload) {
  ensureDirectoryFor(filePath);
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify(payload, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
}

function isValidTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])])
  );
}

function noticeContentSha256(notice) {
  const authoritative = Object.fromEntries(
    Object.entries(notice || {}).filter(([key]) => ![
      'acknowledgements',
      'fullyAcknowledged',
      'fullyAcknowledgedAt',
    ].includes(key))
  );
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalizeJson(authoritative)), 'utf8')
    .digest('hex');
}

function validateNoticePayload(notice, noticePath = null) {
  if (!notice || typeof notice !== 'object' || Array.isArray(notice)) {
    return { ok: false, reason: 'notice_not_object' };
  }
  if (notice.schema !== 'squidrun.next_session_notice.v1') {
    return { ok: false, reason: 'notice_schema_invalid' };
  }
  if (typeof notice.topic !== 'string' || notice.topic.trim().length === 0) {
    return { ok: false, reason: 'notice_topic_invalid' };
  }
  if (typeof notice.status !== 'string' || notice.status.trim().length === 0) {
    return { ok: false, reason: 'notice_status_invalid' };
  }
  if (!isValidTimestamp(notice.createdAt)) {
    return { ok: false, reason: 'notice_created_at_invalid' };
  }
  if (typeof notice.message !== 'string' || notice.message.trim().length === 0) {
    return { ok: false, reason: 'notice_message_invalid' };
  }
  if (!Array.isArray(notice.audience) || notice.audience.length === 0) {
    return { ok: false, reason: 'notice_audience_invalid' };
  }
  const audience = notice.audience.map((value) => normalizeRole(value));
  if (audience.some((value) => !value) || new Set(audience).size !== audience.length) {
    return { ok: false, reason: 'notice_audience_invalid' };
  }
  if (notice.acknowledgements !== undefined
    && (!notice.acknowledgements || typeof notice.acknowledgements !== 'object' || Array.isArray(notice.acknowledgements))) {
    return { ok: false, reason: 'notice_acknowledgements_invalid' };
  }
  if (notice.topic === 'build1b-main-e28-restoration') {
    const expectedAudience = ['architect', 'builder', 'oracle'];
    if (!['complete', 'terminal_failure'].includes(notice.status)
      || audience.length !== expectedAudience.length
      || !expectedAudience.every((role) => audience.includes(role))
      || !/^[a-f0-9]{40}$/.test(String(notice.expectedHead || '').toLowerCase())
      || !Number.isInteger(notice.registrationEpochMs)
      || notice.registrationEpochMs <= 0
      || Date.parse(notice.createdAt) < notice.registrationEpochMs
      || Date.parse(notice.createdAt) > Date.now() + 60_000
      || (notice.restorationReceiptPath !== null
        && (typeof notice.restorationReceiptPath !== 'string' || !path.isAbsolute(notice.restorationReceiptPath)))
      || (notice.status === 'complete'
        && (typeof notice.donePath !== 'string'
          || !path.isAbsolute(notice.donePath)
          || typeof notice.restorationReceiptPath !== 'string'))
      || (notice.status === 'terminal_failure'
        && (typeof notice.terminalPath !== 'string' || !path.isAbsolute(notice.terminalPath)))) {
      return { ok: false, reason: 'build1b_e28_notice_contract_invalid' };
    }
  }
  return { ok: true, noticePath, audience };
}

function acknowledgementFieldsMatch(left, right) {
  if (!left || typeof left !== 'object' || Array.isArray(left)
    || !right || typeof right !== 'object' || Array.isArray(right)) return false;
  return left.role === right.role
    && left.acknowledgedAt === right.acknowledgedAt
    && Number(left.pid) === Number(right.pid)
    && (left.paneId ?? null) === (right.paneId ?? null)
    && (left.sessionId ?? null) === (right.sessionId ?? null)
    && left.receiptPath === right.receiptPath;
}

function inspectAcknowledgement(acknowledgement, role, noticePath = null, notice = null, ackReceiptRoot = null) {
  if (acknowledgement === undefined || acknowledgement === null) {
    return { state: 'absent', valid: false };
  }
  if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)) {
    return { state: 'invalid', valid: false, reason: 'acknowledgement_not_object' };
  }
  if (acknowledgement.role !== role
    || !isValidTimestamp(acknowledgement.acknowledgedAt)
    || !Number.isInteger(Number(acknowledgement.pid))
    || Number(acknowledgement.pid) <= 0
    || !([null, 'string'].includes(acknowledgement.paneId === null || acknowledgement.paneId === undefined ? null : typeof acknowledgement.paneId))
    || !([null, 'string'].includes(acknowledgement.sessionId === null || acknowledgement.sessionId === undefined ? null : typeof acknowledgement.sessionId))
    || typeof acknowledgement.receiptPath !== 'string'
    || !path.isAbsolute(acknowledgement.receiptPath)) {
    return { state: 'invalid', valid: false, reason: 'acknowledgement_shape_invalid' };
  }
  const receiptResult = readJsonResult(acknowledgement.receiptPath);
  if (!receiptResult.ok) {
    return { state: 'repairable', valid: false, reason: 'ack_receipt_missing_or_invalid', receiptResult };
  }
  const receipt = receiptResult.payload;
  const noticeId = noticePath ? path.basename(noticePath).replace(/\.json$/i, '') : null;
  const resolvedReceiptPath = path.resolve(acknowledgement.receiptPath);
  const expectedReceiptDirectory = ackReceiptRoot && noticeId
    ? path.resolve(ackReceiptRoot, noticeId)
    : null;
  const receiptDirectoryMatches = expectedReceiptDirectory
    ? path.dirname(resolvedReceiptPath) === expectedReceiptDirectory
    : (!noticeId || path.basename(path.dirname(resolvedReceiptPath)) === noticeId);
  const receiptAudience = Array.isArray(receipt.audience) ? receipt.audience : [];
  const expectedAudience = Array.isArray(notice?.audience)
    ? notice.audience.map((candidate) => normalizeRole(candidate))
    : null;
  const audienceMatches = !expectedAudience
    || (receiptAudience.length === expectedAudience.length
      && receiptAudience.every((candidate, index) => candidate === expectedAudience[index]));
  const contentDigestMatches = typeof receipt.noticeContentSha256 === 'string'
    && /^[a-f0-9]{64}$/i.test(receipt.noticeContentSha256)
    && receipt.noticeContentSha256 === noticeContentSha256(notice);
  const valid = receipt.schema === 'squidrun.next_session_notice_ack.v1'
    && receipt.phase === 'committed'
    && isValidTimestamp(receipt.committedAt)
    && (!noticeId || receipt.noticeId === noticeId)
    && receipt.role === role
    && (!noticePath || receipt.noticePath === noticePath)
    && (!notice || receipt.topic === notice.topic)
    && audienceMatches
    && contentDigestMatches
    && receiptDirectoryMatches
    && acknowledgementFieldsMatch(receipt.acknowledgement, acknowledgement);
  return valid
    ? { state: 'committed', valid: true, receipt }
    : { state: 'repairable', valid: false, reason: 'ack_receipt_not_committed', receipt };
}

function resolvePaths(projectRoot) {
  const root = path.resolve(projectRoot);
  return {
    projectRoot: root,
    spoolPath: path.join(root, '.squidrun', 'runtime', 'next-session-notices'),
    ackReceiptRoot: path.join(root, '.squidrun', 'coord', 'next-session-notice-acks'),
    listBatchRoot: path.join(root, '.squidrun', 'coord', 'next-session-notice-acks', 'list-batches'),
  };
}

function runObligationNaturalBeat(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const config = require('../config');
  config.setProjectRoot(projectRoot);
  const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
  const dbPath = path.resolve(
    options.dbPath
      || config.resolveCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true })
  );
  const store = new EvidenceLedgerStore({ dbPath, enabled: true });
  const init = store.init();
  if (!init.ok) {
    return {
      ok: false,
      reason: init.reason || 'obligation_store_unavailable',
      dbPath,
      lapseScan: null,
      obligations: [],
      count: 0,
    };
  }
  try {
    const appStatus = readJson(path.join(projectRoot, '.squidrun', 'app-status.json'), {});
    const rawSessionId = options.sessionId
      || appStatus?.session_id
      || appStatus?.sessionId
      || appStatus?.session
      || null;
    const sessionId = Number.isInteger(Number(rawSessionId)) && Number(rawSessionId) > 0
      ? `app-session-${Number(rawSessionId)}`
      : (typeof rawSessionId === 'string' && rawSessionId.trim() ? rawSessionId.trim() : null);
    const naturalBeat = options.beatRowId
      ? {
        ok: true,
        status: 'provided',
        naturalBeatRowId: Number(options.beatRowId),
        role: options.role,
        kind: 'provided',
      }
      : store.recordObligationNaturalBeat({
        role: options.role,
        sessionId,
        kind: 'startup-notices',
      }, { nowMs: options.nowMs });
    if (!naturalBeat.ok) {
      return {
        ok: false,
        reason: naturalBeat.reason || 'natural_beat_record_failed',
        dbPath,
        naturalBeat,
        lapseScan: null,
        obligations: [],
        count: 0,
      };
    }
    const lapseScan = store.lapseObligations({
      address: options.role,
      spoolPath: options.spoolPath,
      beatRowId: naturalBeat.naturalBeatRowId,
    }, {
      validateNotice: validateNoticePayload,
      nowMs: options.nowMs,
    });
    const listing = store.queryObligations({
      address: options.role,
      status: 'open,lapsed',
    });
    const terminalListing = store.queryObligations({
      status: 'fulfilled,released',
      limit: 10_000,
    });
    return {
      ok: lapseScan.ok === true && listing.ok === true && terminalListing.ok === true,
      reason: lapseScan.ok !== true
        ? lapseScan.reason
        : (listing.ok !== true
          ? listing.reason
          : (terminalListing.ok !== true ? terminalListing.reason : null)),
      dbPath,
      naturalBeat,
      lapseScan,
      obligations: listing.obligations || [],
      count: listing.count || 0,
      resolvedObligationIds: (terminalListing.obligations || [])
        .map((obligation) => obligation.obligationId)
        .filter(Boolean),
      readIntegrity: listing.readIntegrity || { flagged: false, redactedFields: [] },
    };
  } finally {
    store.close();
  }
}

function listNotices(options = {}) {
  const role = normalizeRole(options.role);
  if (!role) {
    return { ok: false, reason: 'invalid_role', role: options.role || null, notices: [], count: 0 };
  }
  const spoolPath = path.resolve(options.spoolPath);
  let names;
  try {
    names = fs.readdirSync(spoolPath).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        ok: true,
        role,
        directoryPresent: false,
        spoolPath,
        notices: [],
        count: 0,
      };
    }
    return { ok: false, reason: 'spool_read_failed', error: error.message, role, spoolPath, notices: [], count: 0 };
  }

  const notices = [];
  const errors = [];
  const resolvedObligationIds = new Set(
    Array.isArray(options.resolvedObligationIds) ? options.resolvedObligationIds : []
  );
  for (const name of names) {
    const noticePath = path.join(spoolPath, name);
    const noticeResult = readJsonResult(noticePath);
    if (!noticeResult.ok) {
      errors.push({ noticePath, reason: noticeResult.reason, error: noticeResult.error || null });
      continue;
    }
    const notice = noticeResult.payload;
    const noticeValidation = validateNoticePayload(notice, noticePath);
    if (!noticeValidation.ok) {
      errors.push({ noticePath, reason: noticeValidation.reason });
      continue;
    }
    if (typeof notice.obligationId === 'string'
      && resolvedObligationIds.has(notice.obligationId)) continue;
    const audience = noticeValidation.audience;
    if (!audience.includes(role)) continue;
    const acknowledgements = notice.acknowledgements && typeof notice.acknowledgements === 'object' && !Array.isArray(notice.acknowledgements)
      ? notice.acknowledgements
      : {};
    if (notice.acknowledgements !== undefined && acknowledgements !== notice.acknowledgements) {
      errors.push({ noticePath, reason: 'notice_acknowledgements_invalid' });
      continue;
    }
    const acknowledgementStates = {};
    let acknowledgementShapeInvalid = false;
    for (const candidate of Object.keys(acknowledgements)) {
      if (!VALID_ROLES.has(candidate)) {
        errors.push({ noticePath, reason: 'acknowledgement_role_invalid', role: candidate });
        acknowledgementShapeInvalid = true;
        continue;
      }
      const inspected = inspectAcknowledgement(acknowledgements[candidate], candidate, noticePath, notice, options.ackReceiptRoot);
      acknowledgementStates[candidate] = inspected.state;
      if (inspected.state === 'invalid') {
        errors.push({ noticePath, reason: inspected.reason, role: candidate });
        acknowledgementShapeInvalid = true;
      }
    }
    if (acknowledgementShapeInvalid) continue;
    const roleAcknowledgement = inspectAcknowledgement(acknowledgements[role], role, noticePath, notice, options.ackReceiptRoot);
    if (roleAcknowledgement.valid) continue;
    notices.push({
      noticeId: name.replace(/\.json$/i, ''),
      noticePath,
      topic: notice.topic || null,
      status: notice.status || null,
      createdAt: notice.createdAt || null,
      message: notice.message || '',
      audience,
      acknowledgedRoles: Object.keys(acknowledgements).filter((candidate) => (
        VALID_ROLES.has(candidate) && inspectAcknowledgement(acknowledgements[candidate], candidate, noticePath, notice, options.ackReceiptRoot).valid
      )),
      acknowledgementStates,
      acknowledgementRepairRequired: roleAcknowledgement.state === 'repairable',
      payload: notice,
    });
  }
  return {
    ok: errors.length === 0,
    reason: errors.length === 0 ? null : 'invalid_notice_or_acknowledgement_data',
    role,
    directoryPresent: true,
    spoolPath,
    notices,
    count: notices.length,
    errors,
  };
}

function createListingBatch(listing, options = {}) {
  if (!listing?.ok || listing.count === 0) {
    return { ...listing, batchToken: null, batchPath: null, ackCommand: null };
  }
  const role = normalizeRole(listing.role);
  const ackReceiptRoot = path.resolve(options.ackReceiptRoot || '');
  if (!role || !path.isAbsolute(ackReceiptRoot)) {
    return { ...listing, ok: false, reason: 'list_batch_context_invalid' };
  }
  const entries = listing.notices.map((notice) => ({
    noticeId: notice.noticeId,
    noticePath: notice.noticePath,
    noticeContentSha256: noticeContentSha256(notice.payload),
  }));
  const token = crypto.createHash('sha256')
    .update(JSON.stringify(canonicalizeJson({ role, entries })), 'utf8')
    .digest('hex');
  const batchPath = path.join(ackReceiptRoot, 'list-batches', role, `${token}.json`);
  const batch = {
    schema: 'squidrun.next_session_notice_list_batch.v1',
    phase: 'committed',
    role,
    token,
    createdAt: new Date(Number(options.nowMs || Date.now())).toISOString(),
    spoolPath: listing.spoolPath,
    entries,
  };
  try {
    writeJsonAtomic(batchPath, batch);
  } catch (error) {
    return {
      ...listing,
      ok: false,
      reason: 'list_batch_write_failed',
      error: error.message,
      batchToken: null,
      batchPath,
      ackCommand: null,
    };
  }
  return {
    ...listing,
    batchToken: token,
    batchPath,
    ackCommand: `node ui/scripts/hm-next-session-notices.js ack-all --batch ${token}`,
  };
}

function readListingBatch(options = {}) {
  const role = normalizeRole(options.role);
  const token = String(options.batchToken || '').toLowerCase();
  if (!role || !/^[a-f0-9]{64}$/.test(token)) {
    return { ok: false, reason: 'list_batch_token_missing_or_invalid', role, token: token || null };
  }
  const ackReceiptRoot = path.resolve(options.ackReceiptRoot);
  const batchPath = path.join(ackReceiptRoot, 'list-batches', role, `${token}.json`);
  const batch = readJson(batchPath, null);
  const entries = Array.isArray(batch?.entries) ? batch.entries : [];
  const recomputedToken = crypto.createHash('sha256')
    .update(JSON.stringify(canonicalizeJson({ role, entries })), 'utf8')
    .digest('hex');
  if (batch?.schema !== 'squidrun.next_session_notice_list_batch.v1'
    || batch?.phase !== 'committed'
    || batch?.role !== role
    || batch?.token !== token
    || recomputedToken !== token
    || !isValidTimestamp(batch?.createdAt)
    || path.resolve(String(batch?.spoolPath || '')) !== path.resolve(options.spoolPath)
    || entries.length === 0) {
    return { ok: false, reason: 'list_batch_missing_or_invalid', role, token, batchPath };
  }
  const validated = [];
  for (const entry of entries) {
    const expectedNoticePath = path.join(path.resolve(options.spoolPath), `${entry?.noticeId}.json`);
    const notice = readJson(expectedNoticePath, null);
    const validation = validateNoticePayload(notice, expectedNoticePath);
    if (!validation.ok
      || path.resolve(String(entry?.noticePath || '')) !== expectedNoticePath
      || !validation.audience.includes(role)
      || !/^[a-f0-9]{64}$/.test(String(entry?.noticeContentSha256 || ''))
      || noticeContentSha256(notice) !== entry.noticeContentSha256) {
      return {
        ok: false,
        reason: 'listed_notice_changed_or_invalid',
        role,
        token,
        batchPath,
        noticeId: entry?.noticeId || null,
      };
    }
    validated.push({ ...entry, noticePath: expectedNoticePath });
  }
  return { ok: true, role, token, batchPath, entries: validated };
}

function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function acquireNoticeLock(noticePath, options = {}) {
  const lockPath = `${noticePath}.ack.lock`;
  const attempts = Math.max(1, Number(options.attempts || 40));
  const staleAfterMs = Math.max(30000, Number(options.staleAfterMs || 120000));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      const token = crypto.randomUUID();
      try {
        fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.unlinkSync(lockPath);
        } catch {}
        return { ok: false, reason: 'notice_lock_write_failed', error: error.message, lockPath };
      } finally {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      return { ok: true, lockPath, token };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        return { ok: false, reason: 'notice_lock_create_failed', error: error.message, lockPath };
      }
      try {
        const stat = fs.statSync(lockPath);
        if ((Date.now() - stat.mtimeMs) > staleAfterMs) {
          const owner = readJson(lockPath, null);
          let ownerAlive = false;
          if (Number.isInteger(Number(owner?.pid)) && Number(owner.pid) > 0) {
            try {
              process.kill(Number(owner.pid), 0);
              ownerAlive = true;
            } catch (pidError) {
              ownerAlive = pidError.code === 'EPERM';
            }
          }
          if (!ownerAlive) {
            fs.renameSync(lockPath, `${lockPath}.stale-${Date.now()}-${crypto.randomUUID()}`);
            continue;
          }
        }
      } catch {}
      sleepSync(25);
    }
  }
  return { ok: false, reason: 'notice_lock_busy', lockPath };
}

function releaseNoticeLock(lock) {
  if (!lock?.ok) return;
  const current = readJson(lock.lockPath, null);
  if (current?.token !== lock.token) return;
  try {
    fs.unlinkSync(lock.lockPath);
  } catch {}
}

function acknowledgeNotice(options = {}) {
  const role = normalizeRole(options.role);
  if (!role) return { ok: false, reason: 'invalid_role', role: options.role || null };
  const noticePath = path.resolve(options.noticePath);
  const lock = acquireNoticeLock(noticePath, options.lockOptions);
  if (!lock.ok) return { ok: false, reason: lock.reason, lock };
  try {
    const notice = readJson(noticePath, null);
    if (!notice) return { ok: false, reason: 'notice_missing_or_invalid', noticePath };
    const noticeValidation = validateNoticePayload(notice, noticePath);
    if (!noticeValidation.ok) {
      return { ok: false, reason: noticeValidation.reason, noticePath };
    }
    if (options.expectedNoticeContentSha256
      && noticeContentSha256(notice) !== options.expectedNoticeContentSha256) {
      return { ok: false, reason: 'listed_notice_changed_or_invalid', noticePath };
    }
    const audience = noticeValidation.audience;
    if (!audience.includes(role)) {
      return { ok: false, reason: 'role_not_in_notice_audience', role, noticePath };
    }
    const acknowledgements = notice.acknowledgements && typeof notice.acknowledgements === 'object' && !Array.isArray(notice.acknowledgements)
      ? { ...notice.acknowledgements }
      : {};
    const existingInspection = inspectAcknowledgement(acknowledgements[role], role, noticePath, notice, options.ackReceiptRoot);
    if (existingInspection.valid) {
      return {
        ok: true,
        alreadyAcknowledged: true,
        role,
        noticePath,
        acknowledgement: acknowledgements[role],
      };
    }
    const nowMs = Number(options.nowMs || Date.now());
    const noticeId = path.basename(noticePath).replace(/\.json$/i, '');
    const receiptPath = path.join(
      path.resolve(options.ackReceiptRoot),
      noticeId,
      `${role}-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`
    );
    const acknowledgement = {
      role,
      acknowledgedAt: new Date(nowMs).toISOString(),
      pid: process.pid,
      paneId: options.paneId || process.env.SQUIDRUN_PANE_ID || null,
      sessionId: options.sessionId || process.env.SQUIDRUN_SESSION_ID || null,
      receiptPath,
    };
    acknowledgements[role] = acknowledgement;
    const fullyAcknowledged = audience.every((candidate) => (
      candidate === role || inspectAcknowledgement(acknowledgements[candidate], candidate, noticePath, notice, options.ackReceiptRoot).valid
    ));
    const updated = {
      ...notice,
      acknowledgements,
      // fullyAcknowledged is published only after the new receipt is committed.
      fullyAcknowledged: false,
      fullyAcknowledgedAt: null,
    };
    const receipt = {
      schema: 'squidrun.next_session_notice_ack.v1',
      phase: 'prepared_before_notice_update',
      noticeId,
      noticePath,
      topic: notice.topic || null,
      audience,
      noticeContentSha256: noticeContentSha256(notice),
      role,
      acknowledgement,
      fullyAcknowledged,
    };
    try {
      // Receipt-first ordering means a receipt failure cannot hide an
      // authoritative notice. A crash after this write leaves the notice
      // visible; a crash after the notice update leaves a repairable prepared
      // receipt that list + ack-all will surface and replace.
      writeJsonAtomic(receiptPath, receipt);
      writeJsonAtomic(noticePath, updated);
      writeJsonAtomic(receiptPath, { ...receipt, phase: 'committed', committedAt: new Date().toISOString() });
      if (fullyAcknowledged) {
        writeJsonAtomic(noticePath, {
          ...updated,
          fullyAcknowledged: true,
          fullyAcknowledgedAt: new Date(nowMs).toISOString(),
        });
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'acknowledgement_transaction_failed',
        error: error.message,
        role,
        noticePath,
        receiptPath,
      };
    }
    return {
      ok: true,
      alreadyAcknowledged: false,
      role,
      noticePath,
      acknowledgement,
      fullyAcknowledged,
      receiptPath,
    };
  } finally {
    releaseNoticeLock(lock);
  }
}

function acknowledgeAll(options = {}) {
  const batch = readListingBatch(options);
  if (!batch.ok) return batch;
  const results = batch.entries.map((notice) => acknowledgeNotice({
    ...options,
    noticePath: notice.noticePath,
    expectedNoticeContentSha256: notice.noticeContentSha256,
  }));
  return {
    ok: results.every((result) => result.ok),
    role: batch.role,
    batchToken: batch.token,
    batchPath: batch.batchPath,
    listedCount: batch.entries.length,
    acknowledgedCount: results.filter((result) => result.ok).length,
    results,
  };
}

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node ui/scripts/hm-next-session-notices.js list --role <architect|builder|oracle> [--project-root <path>]',
    '  node ui/scripts/hm-next-session-notices.js ack-all --batch <token> --role <architect|builder|oracle> [--project-root <path>]',
    '',
  ].join('\n'));
}

function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const role = normalizeRole(flags.role || process.env.SQUIDRUN_ROLE);
  const projectRoot = path.resolve(flags['project-root'] || process.cwd());
  if (!command || !role) {
    printUsage();
    return 2;
  }
  const paths = resolvePaths(projectRoot);
  const options = {
    role,
    spoolPath: paths.spoolPath,
    ackReceiptRoot: paths.ackReceiptRoot,
    paneId: process.env.SQUIDRUN_PANE_ID || null,
    sessionId: process.env.SQUIDRUN_SESSION_ID || null,
  };
  let result = null;
  if (command === 'list') {
    const obligationBeat = runObligationNaturalBeat({
      projectRoot,
      role,
      spoolPath: paths.spoolPath,
    });
    result = createListingBatch(listNotices({
      ...options,
      resolvedObligationIds: obligationBeat.resolvedObligationIds,
    }), options);
    result.obligationBeat = obligationBeat;
    result.ok = result.ok === true && obligationBeat.ok === true;
    if (!result.ok && !result.reason) {
      result.reason = obligationBeat.reason || 'obligation_beat_failed';
    }
  } else if (command === 'ack-all') {
    result = acknowledgeAll({ ...options, batchToken: flags.batch });
  }
  if (!result) {
    printUsage();
    return 2;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  VALID_ROLES,
  parseArgs,
  normalizeRole,
  readJson,
  readJsonResult,
  writeJsonAtomic,
  isValidTimestamp,
  validateNoticePayload,
  inspectAcknowledgement,
  resolvePaths,
  runObligationNaturalBeat,
  listNotices,
  createListingBatch,
  acquireNoticeLock,
  releaseNoticeLock,
  acknowledgeNotice,
  acknowledgeAll,
  main,
};
