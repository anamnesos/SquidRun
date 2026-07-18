'use strict';

const log = require('../logger');
const { WORKSPACE_PATH, getProjectRoot } = require('../../config');
const { getActiveProfileName } = require('../../profile');
const { SQUID_ROOM_TEAM_PANE_IDS } = require('../workspace-pane-shell');
const { getTrustQuoteArmPaneIds } = require('../trustquote-arm-specs');
const { toNonEmptyString } = require('./squidrun-root-paths');
const { rollbackSpawn, spawnArmWithAtomicSession } = require('./arm-spawn-transaction');
const { probeArmLiveness } = require('./arm-liveness-probe');
const { recordArmSpawnLifecycle } = require('./arm-spawn-journal');

const SQUID_ROOM_ARM_PANE_ID_SET = new Set(
  getTrustQuoteArmPaneIds().map((paneId) => String(paneId)),
);
const SQUID_ROOM_TEAM_PANE_ID_SET = new Set(
  (SQUID_ROOM_TEAM_PANE_IDS || []).map((paneId) => String(paneId)),
);

function isSquidRoomArmPaneId(value) {
  return SQUID_ROOM_ARM_PANE_ID_SET.has(String(value || ''));
}

function resolveVisibleWindowKeysForPane(appController, paneId) {
  const normalizedPaneId = String(paneId || '');
  if (isSquidRoomArmPaneId(normalizedPaneId)) return ['squid-room'];
  const windowKeys = ['main'];
  if (
    SQUID_ROOM_TEAM_PANE_ID_SET.has(normalizedPaneId)
    && appController.canSendToWindow(appController.getAppWindow('squid-room'))
  ) {
    windowKeys.push('squid-room');
  }
  return windowKeys;
}

async function spawnAddressedArm(appController, input = {}, options = {}) {
  const workspacePath = input.workspacePath || input.workspace_path || getProjectRoot() || WORKSPACE_PATH;
  return spawnArmWithAtomicSession({
    ...input,
    workspacePath,
    profileName: input.profileName || input.profile_name
      || appController.activeProfileName || getActiveProfileName(),
    mainSessionId: input.mainSessionId || input.main_session_id || appController.commsSessionScopeId,
    owner: input.owner || 'terminal-daemon',
    recoveryEvent: input.recoveryEvent || input.recovery_event || 'lease_check_on_spawn',
    dbPath: input.dbPath || input.db_path || options.dbPath || null,
    nowMs: input.nowMs ?? input.now_ms ?? options.nowMs,
  }, {
    daemonClient: appController.ctx.daemonClient,
    dbPath: input.dbPath || input.db_path || options.dbPath || null,
    nowMs: input.nowMs ?? input.now_ms ?? options.nowMs,
  });
}

async function spawnAddressedArmAndProveLiveness(appController, input = {}, options = {}) {
  const spawnArm = typeof options.spawnArm === 'function'
    ? options.spawnArm
    : (spawnInput) => appController.spawnAddressedArm(spawnInput, options);
  const spawned = await spawnArm(input);
  if (!spawned?.ok) return spawned;

  const proveLiveness = typeof options.probeLiveness === 'function'
    ? options.probeLiveness
    : probeArmLiveness;
  const dbPath = input.dbPath || input.db_path || options.dbPath || null;
  const liveness = await proveLiveness({
    ...input,
    dbPath,
    session: spawned.session,
    durableAddress: spawned.durableAddress,
  }, {
    daemonClient: appController.ctx.daemonClient,
    dbPath,
  });
  if (liveness?.ok) {
    return {
      ...spawned,
      status: 'spawned_and_liveness_proved',
      liveness,
      session: liveness.session || spawned.session,
    };
  }

  const rollbackDetails = {
    durableAddress: spawned.durableAddress,
    spawnLeaseId: spawned.spawnLeaseId,
    paneId: spawned.session?.paneId || input.paneId || input.pane_id,
    sourceMessageId: spawned.session?.sourceMessageId
      || input.sourceMessageId || input.source_message_id,
    reason: 'liveness_proof_failed',
    recoveryEvent: 'liveness_proof_failure',
  };
  const rollback = typeof options.rollbackSpawn === 'function'
    ? await options.rollbackSpawn(appController.ctx.daemonClient, spawned.spawnResult, rollbackDetails)
    : await rollbackSpawn(appController.ctx.daemonClient, spawned.spawnResult, rollbackDetails);
  const persistLifecycle = typeof options.recordLifecycle === 'function'
    ? options.recordLifecycle
    : recordArmSpawnLifecycle;
  const lifecycle = rollback?.receipt
    ? persistLifecycle({
        eventClass: rollback.receipt.eventClass,
        receipt: rollback.receipt,
        mainSessionId: appController.commsSessionScopeId,
        paneId: rollback.receipt.paneId || spawned.session?.paneId || null,
      }, {
        dbPath,
        nowMs: options.nowMs,
      })
    : null;
  return {
    ok: false,
    status: rollback?.ok ? 'liveness_failed_rolled_back' : 'liveness_failed_rollback_failed',
    reason: liveness?.reason || liveness?.status || 'liveness_proof_failed',
    durableAddress: spawned.durableAddress,
    spawnLeaseId: spawned.spawnLeaseId,
    spawn: spawned,
    liveness,
    rollback,
    lifecycle,
  };
}

function handleArmSpawnLifecycleEvent(appController, eventData = {}, options = {}) {
  const eventClass = toNonEmptyString(eventData.type);
  if (!eventClass?.startsWith('arm.spawn.') || eventClass === 'arm.spawn.started') {
    return { ok: true, status: 'ignored', reason: 'not_persisted_arm_lifecycle' };
  }
  const receipt = eventData.payload && typeof eventData.payload === 'object'
    ? eventData.payload
    : {};
  const persist = typeof options.recordLifecycle === 'function'
    ? options.recordLifecycle
    : recordArmSpawnLifecycle;
  const result = persist({
    eventClass,
    receipt,
    mainSessionId: appController.commsSessionScopeId,
    paneId: eventData.paneId || receipt.paneId || null,
  }, {
    dbPath: options.dbPath || null,
    nowMs: options.nowMs,
  });
  if (result?.ok === false) {
    log.warn('ArmSpawn', `Failed persisting ${eventClass}: ${result.reason || result.status || 'unknown'}`);
  }
  return result;
}

module.exports = {
  handleArmSpawnLifecycleEvent,
  isSquidRoomArmPaneId,
  resolveVisibleWindowKeysForPane,
  spawnAddressedArm,
  spawnAddressedArmAndProveLiveness,
};
