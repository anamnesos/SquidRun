'use strict';

const crypto = require('crypto');
const path = require('path');
const { normalizeDurableAddress } = require('../terminal-address-leases');
const {
  recordArmSpawnStarted,
} = require('./arm-spawn-journal');

const ARM_SPAWN_TRANSACTION_SCHEMA = 'squidrun.arm_spawn_transaction.v0';

function toText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function slug(value, fallback = null) {
  const text = toText(value);
  if (!text) return fallback;
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function normalizeWorkspaceIdentity(workspacePath) {
  const text = toText(workspacePath);
  if (!text) return null;
  return path.resolve(text).replace(/\\/g, '/').toLowerCase();
}

function buildArmDurableAddress(input = {}) {
  const workspaceIdentity = normalizeWorkspaceIdentity(input.workspacePath || input.workspace_path);
  const profileName = slug(input.profileName || input.profile_name || input.profile, 'main');
  const appRoomId = slug(input.appRoomId || input.app_room_id, null);
  const armKey = slug(input.armKey || input.arm_key || input.paneId || input.pane_id, null);
  if (!workspaceIdentity || !appRoomId || !armKey) return null;
  const workspaceHash = crypto
    .createHash('sha256')
    .update(workspaceIdentity, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return normalizeDurableAddress(`arm://${profileName}/${workspaceHash}/${appRoomId}/${armKey}`);
}

function validateSpawnResult(result, expected) {
  if (!result?.ok) {
    return {
      ok: false,
      status: result?.status || 'spawn_failed',
      reason: result?.reason || 'daemon_spawn_refused',
      spawnResult: result || null,
    };
  }
  const terminal = asObject(result.terminal);
  const receipt = asObject(result.receipt);
  const pid = Number(terminal.pid ?? receipt.pid);
  const checks = [
    [result.status === 'spawned', 'spawned_status_required'],
    [normalizeDurableAddress(result.durableAddress) === expected.durableAddress, 'result_address_mismatch'],
    [toText(result.spawnLeaseId), 'result_spawn_lease_required'],
    [terminal.alive === true, 'result_live_terminal_required'],
    [Number.isInteger(pid) && pid > 0, 'result_positive_pid_required'],
    [toText(terminal.paneId) === expected.paneId, 'terminal_pane_mismatch'],
    [normalizeDurableAddress(terminal.durableAddress) === expected.durableAddress, 'terminal_address_mismatch'],
    [toText(terminal.spawnLeaseId) === toText(result.spawnLeaseId), 'terminal_lease_mismatch'],
    [receipt.schema === 'squidrun.arm_spawn_receipt.v0', 'spawn_receipt_schema_required'],
    [receipt.eventClass === 'arm.spawn.started', 'started_receipt_required'],
    [receipt.status === 'spawned', 'spawned_receipt_status_required'],
    [toText(receipt.paneId) === expected.paneId, 'receipt_pane_mismatch'],
    [Number(receipt.pid) === pid, 'receipt_pid_mismatch'],
    [normalizeDurableAddress(receipt.durableAddress) === expected.durableAddress, 'receipt_address_mismatch'],
    [toText(receipt.spawnLeaseId) === toText(result.spawnLeaseId), 'receipt_lease_mismatch'],
    [toText(receipt.sourceMessageId) === expected.sourceMessageId, 'receipt_source_message_mismatch'],
    [toText(receipt.expectedResponseClass) === expected.expectedResponseClass, 'receipt_response_class_mismatch'],
    [toText(receipt.owner) === expected.owner, 'receipt_owner_mismatch'],
    [toText(receipt.recoveryEvent) === expected.recoveryEvent, 'receipt_recovery_event_mismatch'],
    [!Object.prototype.hasOwnProperty.call(receipt, 'whoFailed')
      && !Object.prototype.hasOwnProperty.call(receipt, 'who_failed'), 'blame_field_forbidden'],
  ];
  const failed = checks.find(([valid]) => !valid);
  if (failed) {
    return {
      ok: false,
      status: 'invalid_spawn_ack',
      reason: failed[1],
      spawnResult: result,
      durableAddress: expected.durableAddress,
      spawnLeaseId: toText(result.spawnLeaseId),
    };
  }
  return {
    ok: true,
    status: 'validated',
    terminal,
    receipt,
    pid,
    spawnLeaseId: toText(result.spawnLeaseId),
  };
}

async function rollbackSpawn(daemonClient, spawnResult, details = {}) {
  const durableAddress = normalizeDurableAddress(
    spawnResult?.durableAddress || spawnResult?.receipt?.durableAddress || details.durableAddress
  );
  const spawnLeaseId = toText(
    spawnResult?.spawnLeaseId || spawnResult?.receipt?.spawnLeaseId || details.spawnLeaseId
  );
  if (!durableAddress || !spawnLeaseId) {
    return { ok: false, status: 'rollback_unaddressable', reason: 'spawn_generation_unknown' };
  }
  if (!daemonClient || typeof daemonClient.killAddressed !== 'function') {
    return {
      ok: false,
      status: 'rollback_unavailable',
      reason: 'addressed_kill_unavailable',
      durableAddress,
      spawnLeaseId,
    };
  }
  try {
    return await daemonClient.killAddressed({
      durableAddress,
      spawnLeaseId,
      paneId: details.paneId || spawnResult?.terminal?.paneId || spawnResult?.receipt?.paneId || null,
      sourceMessageId: details.sourceMessageId || spawnResult?.receipt?.sourceMessageId || null,
      reason: details.reason || 'spawn_session_rollback',
      recoveryEvent: details.recoveryEvent || 'spawn_session_persist_failure',
    });
  } catch (error) {
    return {
      ok: false,
      status: 'rollback_error',
      reason: error.message,
      durableAddress,
      spawnLeaseId,
    };
  }
}

async function spawnArmWithAtomicSession(input = {}, dependencies = {}) {
  const daemonClient = dependencies.daemonClient || input.daemonClient;
  const recordSession = typeof dependencies.recordSession === 'function'
    ? dependencies.recordSession
    : recordArmSpawnStarted;
  const workspacePath = toText(input.workspacePath || input.workspace_path);
  const profileName = slug(input.profileName || input.profile_name || input.profile, 'main');
  const appRoomId = slug(input.appRoomId || input.app_room_id, null);
  const armKey = slug(input.armKey || input.arm_key, null);
  const paneId = toText(input.paneId || input.pane_id);
  const role = toText(input.role);
  const owner = toText(input.owner);
  const recoveryEvent = toText(input.recoveryEvent || input.recovery_event);
  const sourceMessageId = toText(input.sourceMessageId || input.source_message_id);
  const expectedResponseClass = toText(input.expectedResponseClass || input.expected_response_class);
  const durableAddress = normalizeDurableAddress(input.durableAddress || input.durable_address)
    || buildArmDurableAddress({ workspacePath, profileName, appRoomId, armKey, paneId });
  const required = [
    [daemonClient && typeof daemonClient.spawnAddressed === 'function', 'addressed_spawn_unavailable'],
    [workspacePath, 'workspace_path_required'],
    [profileName, 'profile_name_required'],
    [appRoomId, 'app_room_id_required'],
    [armKey, 'arm_key_required'],
    [paneId, 'pane_id_required'],
    [role, 'role_required'],
    [owner, 'owner_required'],
    [recoveryEvent, 'recovery_event_required'],
    [sourceMessageId, 'source_message_id_required'],
    [expectedResponseClass, 'expected_response_class_required'],
    [durableAddress, 'durable_address_required'],
  ];
  const missing = required.find(([valid]) => !valid);
  if (missing) return { ok: false, status: 'invalid', reason: missing[1], durableAddress };

  const expected = {
    durableAddress,
    paneId,
    sourceMessageId,
    expectedResponseClass,
    owner,
    recoveryEvent,
  };
  let spawnResult;
  try {
    spawnResult = await daemonClient.spawnAddressed({
      requestId: input.requestId || input.request_id,
      durableAddress,
      paneId,
      cwd: input.cwd || workspacePath,
      dryRun: input.dryRun === true,
      mode: input.mode || null,
      env: {
        ...asObject(input.env),
        SQUIDRUN_ROLE: role,
        SQUIDRUN_PANE_ID: paneId,
        SQUIDRUN_PROFILE: profileName,
      },
      owner,
      recoveryEvent,
      sourceMessageId,
      expectedResponseClass,
      options: asObject(input.options),
    }, asObject(input.waitOptions || input.wait_options));
  } catch (error) {
    return { ok: false, status: 'spawn_error', reason: error.message, durableAddress };
  }

  const validated = validateSpawnResult(spawnResult, expected);
  if (!validated.ok) {
    const rollback = spawnResult?.ok
      ? await rollbackSpawn(daemonClient, spawnResult, {
          durableAddress,
          spawnLeaseId: validated.spawnLeaseId,
          paneId,
          sourceMessageId,
          reason: 'invalid_spawn_ack',
          recoveryEvent: 'spawn_ack_validation_failure',
        })
      : null;
    return { ...validated, rollback, durableAddress };
  }

  let persisted;
  try {
    persisted = await Promise.resolve(recordSession({
      schema: ARM_SPAWN_TRANSACTION_SCHEMA,
      durableAddress,
      spawnLeaseId: validated.spawnLeaseId,
      previousSpawnLeaseId: validated.receipt.previousSpawnLeaseId || null,
      registryId: input.registryId || input.registry_id || null,
      armId: input.armId || input.arm_id || null,
      appRoomId,
      armKey,
      paneId,
      role,
      profileName,
      workspacePath: path.resolve(workspacePath),
      owner,
      recoveryEvent,
      sourceMessageId,
      expectedResponseClass,
      mainSessionId: input.mainSessionId || input.main_session_id || null,
      terminal: validated.terminal,
      receipt: validated.receipt,
      metadata: {
        ...asObject(input.metadata),
        transactionSchema: ARM_SPAWN_TRANSACTION_SCHEMA,
      },
    }, {
      dbPath: input.dbPath || input.db_path || dependencies.dbPath || null,
      nowMs: input.nowMs ?? input.now_ms ?? dependencies.nowMs,
    }));
  } catch (error) {
    persisted = { ok: false, status: 'persist_error', reason: error.message };
  }

  if (!persisted?.ok) {
    const rollback = await rollbackSpawn(daemonClient, spawnResult, {
      durableAddress,
      spawnLeaseId: validated.spawnLeaseId,
      paneId,
      sourceMessageId,
      reason: 'spawn_session_persist_failure',
      recoveryEvent: 'spawn_session_persist_failure',
    });
    return {
      ok: false,
      status: rollback?.ok ? 'registry_write_rolled_back' : 'registry_write_rollback_failed',
      reason: persisted?.reason || persisted?.status || 'spawn_session_persist_failed',
      durableAddress,
      spawnLeaseId: validated.spawnLeaseId,
      spawnResult,
      persistence: persisted || null,
      rollback,
    };
  }

  return {
    ok: true,
    status: 'spawned_and_registered',
    schema: ARM_SPAWN_TRANSACTION_SCHEMA,
    durableAddress,
    spawnLeaseId: validated.spawnLeaseId,
    spawnResult,
    persistence: persisted,
    session: persisted.session || null,
  };
}

module.exports = {
  ARM_SPAWN_TRANSACTION_SCHEMA,
  buildArmDurableAddress,
  normalizeWorkspaceIdentity,
  rollbackSpawn,
  spawnArmWithAtomicSession,
  validateSpawnResult,
};
