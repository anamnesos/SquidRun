'use strict';

const {
  getActiveArmSpawnSession,
  recordArmSpawnLivenessProof,
} = require('./arm-spawn-journal');
const { queryCommsJournalEntries } = require('./comms-journal');
const { normalizeDurableAddress } = require('../terminal-address-leases');

const ARM_LIVENESS_PING_SCHEMA = 'squidrun.arm_liveness_ping.v0';
const ARM_LIVENESS_PONG_SCHEMA = 'squidrun.arm_liveness_pong.v0';
const ARM_LIVENESS_PONG_MARKER = '[SQUIDRUN_ARM_LIVENESS_PONG]';

function toText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function terminalMatchesSpawnSession(terminal, session) {
  return Boolean(
    terminal
    && session
    && terminal.alive === true
    && normalizeDurableAddress(terminal.durableAddress) === normalizeDurableAddress(session.durableAddress)
    && toText(terminal.spawnLeaseId) === toText(session.spawnLeaseId)
    && toText(terminal.paneId) === toText(session.paneId)
  );
}

function buildArmLivenessPongReceipt(session = {}) {
  const receipt = {
    schema: ARM_LIVENESS_PONG_SCHEMA,
    sourceMessageId: toText(session.sourceMessageId),
    responseClass: toText(session.expectedResponseClass),
    durableAddress: normalizeDurableAddress(session.durableAddress),
    spawnLeaseId: toText(session.spawnLeaseId),
    paneId: toText(session.paneId),
  };
  if (Object.values(receipt).some((value) => !value)) return null;
  return receipt;
}

function buildArmLivenessPing(session = {}) {
  const pong = buildArmLivenessPongReceipt(session);
  if (!pong) return null;
  return {
    schema: ARM_LIVENESS_PING_SCHEMA,
    sourceMessageId: pong.sourceMessageId,
    expectedResponseClass: pong.responseClass,
    durableAddress: pong.durableAddress,
    spawnLeaseId: pong.spawnLeaseId,
    paneId: pong.paneId,
    replyMarker: ARM_LIVENESS_PONG_MARKER,
    replyReceipt: pong,
  };
}

function buildArmLivenessPrompt(session = {}) {
  const ping = buildArmLivenessPing(session);
  if (!ping) return null;
  const replyBody = `${ARM_LIVENESS_PONG_MARKER} ${JSON.stringify(ping.replyReceipt)}`;
  return {
    ping,
    replyBody,
    text: `[SQUIDRUN_ARM_LIVENESS_PING] From this exact pane, route one reply to architect through hm-send. `
      + `The reply body must include this exact one-line receipt: ${replyBody}`,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeArmLiveness(input = {}, dependencies = {}) {
  const daemonClient = dependencies.daemonClient || input.daemonClient;
  const dbPath = input.dbPath || input.db_path || dependencies.dbPath || null;
  const getSession = typeof dependencies.getSession === 'function'
    ? dependencies.getSession
    : (durableAddress) => getActiveArmSpawnSession(durableAddress, { dbPath });
  const queryJournal = typeof dependencies.queryJournal === 'function'
    ? dependencies.queryJournal
    : (filters) => queryCommsJournalEntries(filters, { dbPath });
  const recordProof = typeof dependencies.recordProof === 'function'
    ? dependencies.recordProof
    : (proof) => recordArmSpawnLivenessProof(proof, { dbPath });
  const now = typeof dependencies.now === 'function' ? dependencies.now : Date.now;
  const sleep = typeof dependencies.sleep === 'function' ? dependencies.sleep : delay;
  const requestedAddress = normalizeDurableAddress(
    input.durableAddress || input.durable_address || input.session?.durableAddress
  );
  const session = asObject(input.session);
  const activeSession = Object.keys(session).length > 0
    ? session
    : (requestedAddress ? getSession(requestedAddress) : null);
  if (!activeSession || activeSession.status !== 'active') {
    return { ok: false, status: 'invalid', reason: 'active_spawn_session_required' };
  }
  if (!daemonClient || typeof daemonClient.writeAndWaitAck !== 'function') {
    return { ok: false, status: 'invalid', reason: 'daemon_write_ack_unavailable', session: activeSession };
  }
  const terminal = typeof daemonClient.getTerminal === 'function'
    ? daemonClient.getTerminal(activeSession.paneId)
    : null;
  if (!terminalMatchesSpawnSession(terminal, activeSession)) {
    return { ok: false, status: 'rejected', reason: 'spawn_generation_not_live', session: activeSession };
  }

  const prompt = buildArmLivenessPrompt(activeSession);
  if (!prompt) return { ok: false, status: 'invalid', reason: 'liveness_ping_invalid', session: activeSession };
  const startedAtMs = Number(now());
  const eventId = `arm-liveness-ping:${activeSession.spawnLeaseId}:${startedAtMs}`;
  const ackTimeoutMs = Math.max(100, Math.min(10_000, Number(input.ackTimeoutMs || input.ack_timeout_ms) || 2_000));
  const proofTimeoutMs = Math.max(100, Math.min(60_000, Number(input.proofTimeoutMs || input.proof_timeout_ms) || 30_000));
  const pollIntervalMs = Math.max(10, Math.min(1_000, Number(input.pollIntervalMs || input.poll_interval_ms) || 100));
  const ack = await daemonClient.writeAndWaitAck(
    activeSession.paneId,
    `${prompt.text}\r`,
    {
      eventId,
      correlationId: activeSession.sourceMessageId,
      source: 'arm-liveness-probe',
      meta: {
        durableAddress: activeSession.durableAddress,
        spawnLeaseId: activeSession.spawnLeaseId,
        expectedResponseClass: activeSession.expectedResponseClass,
      },
    },
    { timeoutMs: ackTimeoutMs }
  );
  if (!ack?.success || ack.status !== 'accepted') {
    return {
      ok: false,
      status: 'write_rejected',
      reason: ack?.error || ack?.status || 'liveness_ping_write_failed',
      session: activeSession,
      ping: prompt.ping,
      ack,
    };
  }

  const deadlineAtMs = startedAtMs + proofTimeoutMs;
  const checkedRows = new Set();
  const rejections = [];
  while (Number(now()) <= deadlineAtMs) {
    const rows = await Promise.resolve(queryJournal({
      senderRole: activeSession.role,
      direction: 'outbound',
      sinceMs: startedAtMs,
      order: 'asc',
      limit: 250,
    }));
    for (const row of Array.isArray(rows) ? rows : []) {
      const rowKey = row.rowId || row.messageId;
      if (!rowKey || checkedRows.has(rowKey)) continue;
      checkedRows.add(rowKey);
      const proof = await Promise.resolve(recordProof({
        durableAddress: activeSession.durableAddress,
        spawnLeaseId: activeSession.spawnLeaseId,
        messageId: row.messageId,
        commsRowId: row.rowId,
      }));
      if (proof?.ok) {
        return {
          ok: true,
          status: 'proved',
          session: proof.session || activeSession,
          ping: prompt.ping,
          ack,
          proof,
        };
      }
      rejections.push({
        messageId: row.messageId || null,
        rowId: row.rowId || null,
        reason: proof?.reason || proof?.status || 'proof_rejected',
      });
    }
    if (Number(now()) >= deadlineAtMs) break;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadlineAtMs - Number(now()))));
  }

  return {
    ok: false,
    status: 'proof_timeout',
    reason: `no_correlated_comms_reply_within_${proofTimeoutMs}ms`,
    session: activeSession,
    ping: prompt.ping,
    ack,
    rejections: rejections.slice(-10),
  };
}

module.exports = {
  ARM_LIVENESS_PING_SCHEMA,
  ARM_LIVENESS_PONG_SCHEMA,
  ARM_LIVENESS_PONG_MARKER,
  buildArmLivenessPing,
  buildArmLivenessPongReceipt,
  buildArmLivenessPrompt,
  probeArmLiveness,
  terminalMatchesSpawnSession,
};
