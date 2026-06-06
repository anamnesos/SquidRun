const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ARM_STATE_PROJECTION_CHANNEL,
  buildArmStateProjectionResponse,
  registerArmStateProjectionHandlers,
} = require('../modules/ipc/arm-state-projection-handlers');
const {
  isAllowedInvokeChannel,
} = require('../modules/bridge/channel-policy');
const {
  seedTrustQuoteArmRegistry,
} = require('../modules/main/trustquote-arm-registry-seed');
const {
  queryArmMissingWatchdogs,
  closeArmRegistryStores,
} = require('../modules/main/arm-registry');
const {
  tickMissingArmWatchdog,
} = require('../modules/main/missing-arm-watchdog');
const {
  enqueueArmApplyRequest,
  queryArmApplyRequests,
  closeArmApplyQueueStores,
} = require('../modules/main/arm-apply-queue');
const {
  closeArmStateProjectionStores,
} = require('../modules/main/arm-state-projection');

function hasSqliteDriver() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') return true;
  } catch {
    // Continue to next fallback.
  }
  try {
    // eslint-disable-next-line global-require
    require('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

const maybeDescribe = hasSqliteDriver() ? describe : describe.skip;

maybeDescribe('arm state projection IPC handler', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-state-handler-'));
    dbPath = path.join(tempDir, 'evidence-ledger.db');
  });

  afterEach(() => {
    closeArmRegistryStores();
    closeArmApplyQueueStores();
    closeArmStateProjectionStores();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('registers a safe invoke channel and forwards filters to the projector', async () => {
    expect(isAllowedInvokeChannel(ARM_STATE_PROJECTION_CHANNEL)).toBe(true);
    const registered = {};
    const ipcMain = {
      removeHandler: jest.fn(),
      handle: jest.fn((channel, fn) => {
        registered[channel] = fn;
      }),
    };
    const buildArmStateProjection = jest.fn(() => ({
      ok: true,
      schema: 'squidrun.arm_state_projection.v0',
      projectionOnly: true,
      readOnly: true,
      registry: { appRoomId: 'trustquote' },
      sideEffects: {
        writesPerformed: 0,
        dispatchesPerformed: 0,
        watchdogAdvancesPerformed: 0,
      },
    }));

    registerArmStateProjectionHandlers({ ipcMain }, { buildArmStateProjection });
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(ARM_STATE_PROJECTION_CHANNEL);
    expect(ipcMain.handle).toHaveBeenCalledWith(ARM_STATE_PROJECTION_CHANNEL, expect.any(Function));

    const response = await registered[ARM_STATE_PROJECTION_CHANNEL](null, {
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      dbPath,
      nowMs: 12345,
      includeRows: false,
    });

    expect(buildArmStateProjection).toHaveBeenCalledWith({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, {
      nowMs: 12345,
      includeRows: false,
    });
    expect(response).toEqual(expect.objectContaining({
      ok: true,
      channel: ARM_STATE_PROJECTION_CHANNEL,
      projectionOnly: true,
      readOnly: true,
      dispatchEnabled: false,
      executorEnabled: false,
    }));
  });

  test('returns projection output without advancing watchdogs or dispatching apply requests', () => {
    const sessionId = 'app-session-handler:trustquote';
    const seeded = seedTrustQuoteArmRegistry({
      dbPath,
      sessionId,
      nowMs: 1_000,
    });
    expect(seeded.ok).toBe(true);
    expect(tickMissingArmWatchdog({
      appRoomId: 'trustquote',
      sessionId,
    }, { dbPath, nowMs: 2_000, dryRun: true }).ok).toBe(true);
    expect(enqueueArmApplyRequest({
      requestId: 'handler-money-write-1',
      appRoomId: 'trustquote',
      sessionId,
      armKey: 'money-documents',
      actionCategory: 'money_write',
      riskClass: 'safe',
      evidenceRefs: ['handler:projection'],
      draftPayload: { amount: 12000 },
    }, { dbPath, nowMs: 3_000 }).ok).toBe(true);

    const beforeWatchdogs = queryArmMissingWatchdogs({ registryId: seeded.registry.registryId }, { dbPath });
    const beforeRequests = queryArmApplyRequests({ registryId: seeded.registry.registryId }, { dbPath });

    const response = buildArmStateProjectionResponse({
      appRoomId: 'trustquote',
      sessionId,
      nowMs: 999_000,
    }, { dbPath });

    expect(response).toEqual(expect.objectContaining({
      ok: true,
      status: 'missing',
      channel: ARM_STATE_PROJECTION_CHANNEL,
      projectionOnly: true,
      readOnly: true,
      dispatchEnabled: false,
      executorEnabled: false,
      sideEffects: {
        writesPerformed: 0,
        dispatchesPerformed: 0,
        watchdogAdvancesPerformed: 0,
      },
    }));
    expect(response.registry).toEqual(expect.objectContaining({
      desiredCount: 3,
      readyCount: 0,
      missingCount: 3,
    }));
    expect(response.watchdogs.summary).toEqual(expect.objectContaining({
      open: 3,
      expected: 3,
    }));
    expect(response.applyQueue.summary).toEqual(expect.objectContaining({
      pendingApproval: 1,
      approvalRequired: 1,
    }));
    expect(queryArmMissingWatchdogs({ registryId: seeded.registry.registryId }, { dbPath })).toEqual(beforeWatchdogs);
    expect(queryArmApplyRequests({ registryId: seeded.registry.registryId }, { dbPath })).toEqual(beforeRequests);
  });

  test('ignores renderer-supplied db path and does not create alternate database files', () => {
    const sessionId = 'app-session-handler-override:trustquote';
    const seeded = seedTrustQuoteArmRegistry({
      dbPath,
      sessionId,
      nowMs: 1_000,
    });
    expect(seeded.ok).toBe(true);
    const alternateDbPath = path.join(tempDir, 'projection-attack.db');

    const response = buildArmStateProjectionResponse({
      appRoomId: 'trustquote',
      sessionId,
      db_path: alternateDbPath,
      nowMs: 9_000,
    }, { dbPath });

    expect(response).toEqual(expect.objectContaining({
      ok: true,
      dbPath: path.resolve(dbPath),
      channel: ARM_STATE_PROJECTION_CHANNEL,
      projectionOnly: true,
      readOnly: true,
      sideEffects: {
        writesPerformed: 0,
        dispatchesPerformed: 0,
        watchdogAdvancesPerformed: 0,
      },
    }));
    expect(fs.existsSync(alternateDbPath)).toBe(false);
    expect(fs.existsSync(`${alternateDbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${alternateDbPath}-shm`)).toBe(false);
  });

  test('reports missing registries without seeding them', () => {
    const seeded = seedTrustQuoteArmRegistry({
      dbPath,
      sessionId: 'app-session-handler-existing:trustquote',
      nowMs: 1_000,
    });
    expect(seeded.ok).toBe(true);
    const response = buildArmStateProjectionResponse({
      appRoomId: 'trustquote',
      sessionId: 'app-session-missing:trustquote',
      nowMs: 5_000,
    }, { dbPath });

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      status: 'not_found',
      reason: 'arm_registry_not_found',
      projectionOnly: true,
      readOnly: true,
      dispatchEnabled: false,
      executorEnabled: false,
    }));
    expect(response.sideEffects).toEqual({
      writesPerformed: 0,
      dispatchesPerformed: 0,
      watchdogAdvancesPerformed: 0,
    });
  });
});
