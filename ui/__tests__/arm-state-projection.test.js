const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const {
  upsertArmRegistryManifest,
  recordArmCheckinProof,
  evaluateArmRegistryReadiness,
  queryArmMissingWatchdogs,
  closeArmRegistryStores,
} = require('../modules/main/arm-registry');
const {
  enqueueArmApplyRequest,
  queryArmApplyRequests,
  closeArmApplyQueueStores,
} = require('../modules/main/arm-apply-queue');
const {
  tickMissingArmWatchdog,
} = require('../modules/main/missing-arm-watchdog');
const {
  buildArmStateProjection,
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

function manifest() {
  return {
    appRoomId: 'trustquote',
    sessionId: 'app-room:trustquote',
    mainSessionId: 'app-session-406',
    leadRole: 'trustquote-lead',
    leadPaneId: 'trustquote-lead',
    routeTarget: 'trustquote',
    arms: [
      {
        armKey: 'lead',
        role: 'trustquote-lead',
        paneId: 'trustquote-lead',
        routeTarget: 'architect',
        armKind: 'lead',
        displayName: 'TrustQuote Lead',
        dataSources: ['summaries'],
        permissions: { read: ['summaries'] },
        checkInObligation: { required: true },
      },
      {
        armKey: 'invoice',
        role: 'trustquote-invoice',
        paneId: 'trustquote-invoice',
        routeTarget: 'trustquote-invoice',
        armKind: 'domain',
        displayName: 'Invoice',
        dataSources: ['jobs', 'quotes', 'payments'],
        permissions: { read: ['money_records'], draft: ['invoice'] },
        checkInObligation: { required: true },
      },
    ],
  };
}

function seedCommsCheckin(dbPath, input = {}, nowMs = 1_000) {
  const sessionId = input.sessionId || 'app-session-406:trustquote';
  const role = input.role || 'trustquote-lead';
  const paneId = input.paneId || 'trustquote-lead';
  const messageId = input.messageId || `hm-${role}-${nowMs}`;
  const store = new EvidenceLedgerStore({ dbPath });
  expect(store.init().ok).toBe(true);
  expect(store.upsertCommsJournal({
    messageId,
    sessionId,
    senderRole: role,
    targetRole: 'architect',
    channel: 'ws',
    direction: 'outbound',
    status: 'routed',
    sentAtMs: nowMs,
    brokeredAtMs: nowMs,
    rawBody: `(${role}): online in ${paneId}; env role=${role}; pane=${paneId}; session=${sessionId}`,
    metadata: {
      session_id: sessionId,
      sender: { role, pane_id: paneId },
      envelope: {
        session_id: sessionId,
        sender: { role, pane_id: paneId },
      },
      project: { session_id: sessionId },
    },
  }, { nowMs }).ok).toBe(true);
  const row = store.queryCommsJournal({ messageId, limit: 1 })[0];
  store.close();
  return row;
}

const maybeDescribe = hasSqliteDriver() ? describe : describe.skip;

maybeDescribe('arm state projection', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-state-projection-'));
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

  test('projects desired ready missing watchdog and apply queue state without advancing due work', () => {
    expect(upsertArmRegistryManifest(manifest(), { dbPath, nowMs: 1_000 }).ok).toBe(true);
    const checkinRow = seedCommsCheckin(dbPath, {
      messageId: 'hm-lead-ready',
      role: 'trustquote-lead',
      paneId: 'trustquote-lead',
    }, 2_000);
    expect(recordArmCheckinProof({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'lead',
      role: 'trustquote-lead',
      paneId: 'trustquote-lead',
      proofKind: 'startup_check_in',
      messageId: 'hm-lead-ready',
      commsRowId: checkinRow.rowId,
      env: {
        SQUIDRUN_ROLE: 'trustquote-lead',
        SQUIDRUN_PANE_ID: 'trustquote-lead',
        SQUIDRUN_SESSION_SCOPE_ID: 'app-session-406:trustquote',
      },
    }, { dbPath, nowMs: 2_000 }).ok).toBe(true);

    expect(tickMissingArmWatchdog({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, { dbPath, nowMs: 3_000, dryRun: true }).ok).toBe(true);
    expect(enqueueArmApplyRequest({
      requestId: 'apply-money-write-projection-1',
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'invoice',
      actionCategory: 'money_write',
      riskClass: 'safe',
      evidenceRefs: ['invoice:projection'],
      draftPayload: { amount: 5000 },
    }, { dbPath, nowMs: 4_000 }).ok).toBe(true);

    const beforeWatchdogs = queryArmMissingWatchdogs({ status: 'expected' }, { dbPath });
    const beforeQueue = queryArmApplyRequests({ status: 'approval_required' }, { dbPath });
    const projection = buildArmStateProjection({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, { dbPath, nowMs: 123_000 });

    expect(projection).toEqual(expect.objectContaining({
      ok: true,
      status: 'missing',
      projectionOnly: true,
      readOnly: true,
      explicitInvocationRequired: true,
      trustQuoteRoomBehaviorUnchanged: true,
      dispatchEnabled: false,
      executorEnabled: false,
      sideEffects: {
        writesPerformed: 0,
        dispatchesPerformed: 0,
        watchdogAdvancesPerformed: 0,
      },
    }));
    expect(projection.registry).toEqual(expect.objectContaining({
      desiredCount: 2,
      readyCount: 1,
      missingCount: 1,
    }));
    expect(projection.watchdogs.summary).toEqual(expect.objectContaining({
      total: 1,
      open: 1,
      expected: 1,
      overdue: 1,
      nextDueAtMs: 123000,
    }));
    expect(projection.applyQueue.summary).toEqual(expect.objectContaining({
      total: 1,
      approvalRequired: 1,
      pendingApproval: 1,
    }));
    expect(projection.arms.find((arm) => arm.armKey === 'lead')).toEqual(expect.objectContaining({
      status: 'ready',
      latestAcceptedCheckin: expect.objectContaining({ messageId: 'hm-lead-ready' }),
    }));
    expect(projection.arms.find((arm) => arm.armKey === 'invoice')).toEqual(expect.objectContaining({
      status: 'missing',
      applyQueueSummary: expect.objectContaining({ pendingApproval: 1 }),
    }));

    expect(queryArmMissingWatchdogs({ status: 'expected' }, { dbPath })).toEqual(beforeWatchdogs);
    expect(queryArmApplyRequests({ status: 'approval_required' }, { dbPath })).toEqual(beforeQueue);
  });

  test('uses registry metadata readiness session when projection has no explicit session', () => {
    const seededManifest = {
      ...manifest(),
      metadata: {
        readinessSessionId: 'app-session-406:trustquote',
      },
    };
    expect(upsertArmRegistryManifest(seededManifest, { dbPath, nowMs: 1_000 }).ok).toBe(true);
    const leadRow = seedCommsCheckin(dbPath, {
      messageId: 'hm-lead-ready-from-metadata-session',
      role: 'trustquote-lead',
      paneId: 'trustquote-lead',
      sessionId: 'app-session-406:trustquote',
    }, 2_000);
    expect(recordArmCheckinProof({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'lead',
      role: 'trustquote-lead',
      paneId: 'trustquote-lead',
      proofKind: 'startup_check_in',
      messageId: 'hm-lead-ready-from-metadata-session',
      commsRowId: leadRow.rowId,
      env: {
        SQUIDRUN_ROLE: 'trustquote-lead',
        SQUIDRUN_PANE_ID: 'trustquote-lead',
        SQUIDRUN_SESSION_SCOPE_ID: 'app-session-406:trustquote',
      },
    }, { dbPath, nowMs: 2_000 }).ok).toBe(true);

    const projection = buildArmStateProjection({
      appRoomId: 'trustquote',
    }, { dbPath, nowMs: 3_000 });

    expect(projection.registry).toEqual(expect.objectContaining({
      readinessSessionId: 'app-session-406:trustquote',
      readyCount: 1,
      missingCount: 1,
    }));
    expect(projection.arms.find((arm) => arm.armKey === 'lead')).toEqual(expect.objectContaining({
      status: 'ready',
      latestAcceptedCheckin: expect.objectContaining({ messageId: 'hm-lead-ready-from-metadata-session' }),
    }));
  });

  test('does not attach a stale accepted check-in after arm identity changes', () => {
    expect(upsertArmRegistryManifest(manifest(), { dbPath, nowMs: 1_000 }).ok).toBe(true);
    const billingRow = seedCommsCheckin(dbPath, {
      messageId: 'hm-billing-ready-original',
      role: 'trustquote-invoice',
      paneId: 'trustquote-invoice',
    }, 2_000);
    const accepted = recordArmCheckinProof({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'invoice',
      role: 'trustquote-invoice',
      paneId: 'trustquote-invoice',
      proofKind: 'startup_check_in',
      messageId: 'hm-billing-ready-original',
      commsRowId: billingRow.rowId,
      env: {
        SQUIDRUN_ROLE: 'trustquote-invoice',
        SQUIDRUN_PANE_ID: 'trustquote-invoice',
        SQUIDRUN_SESSION_SCOPE_ID: 'app-session-406:trustquote',
      },
    }, { dbPath, nowMs: 2_000 });
    expect(accepted.ok).toBe(true);

    const renamedManifest = manifest();
    renamedManifest.arms = renamedManifest.arms.map((arm) => (
      arm.armKey === 'invoice'
        ? {
          ...arm,
          role: 'trustquote-finance',
          paneId: 'trustquote-finance',
          routeTarget: 'trustquote-finance',
        }
        : arm
    ));
    expect(upsertArmRegistryManifest(renamedManifest, { dbPath, nowMs: 3_000 }).ok).toBe(true);
    const evaluated = evaluateArmRegistryReadiness({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, { dbPath, nowMs: 4_000 });
    expect(evaluated.ok).toBe(true);
    expect(evaluated.registry.arms.find((arm) => arm.armKey === 'invoice')).toEqual(expect.objectContaining({
      role: 'trustquote-finance',
      paneId: 'trustquote-finance',
      status: 'missing',
      lastProofRefs: [],
    }));

    const projection = buildArmStateProjection({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, { dbPath, nowMs: 5_000 });
    const moneyArm = projection.arms.find((arm) => arm.armKey === 'invoice');
    expect(moneyArm).toEqual(expect.objectContaining({
      role: 'trustquote-finance',
      paneId: 'trustquote-finance',
      status: 'missing',
      latestAcceptedCheckin: null,
    }));
    expect(moneyArm.latestAcceptedCheckin).not.toEqual(expect.objectContaining({
      messageId: 'hm-billing-ready-original',
    }));
  });

  test('uses canonical manifest across restart but only current-session check-ins count', () => {
    expect(upsertArmRegistryManifest(manifest(), { dbPath, nowMs: 1_000 }).ok).toBe(true);
    const lead406 = seedCommsCheckin(dbPath, {
      messageId: 'hm-lead-session-406',
      role: 'trustquote-lead',
      paneId: 'trustquote-lead',
      sessionId: 'app-session-406:trustquote',
    }, 2_000);
    expect(recordArmCheckinProof({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'lead',
      role: 'trustquote-lead',
      paneId: 'trustquote-lead',
      proofKind: 'startup_check_in',
      messageId: 'hm-lead-session-406',
      commsRowId: lead406.rowId,
      env: {
        SQUIDRUN_ROLE: 'trustquote-lead',
        SQUIDRUN_PANE_ID: 'trustquote-lead',
        SQUIDRUN_SESSION_SCOPE_ID: 'app-session-406:trustquote',
      },
    }, { dbPath, nowMs: 2_000 }).ok).toBe(true);

    const restarted = buildArmStateProjection({
      appRoomId: 'trustquote',
      sessionId: 'app-session-407:trustquote',
    }, { dbPath, nowMs: 3_000 });
    expect(restarted.registry).toEqual(expect.objectContaining({
      sessionId: 'app-room:trustquote',
      readinessSessionId: 'app-session-407:trustquote',
      desiredCount: 2,
      readyCount: 0,
      missingCount: 2,
    }));
    expect(restarted.arms.find((arm) => arm.armKey === 'lead')).toEqual(expect.objectContaining({
      status: 'missing',
      latestAcceptedCheckin: null,
    }));

    const lead407 = seedCommsCheckin(dbPath, {
      messageId: 'hm-lead-session-407',
      role: 'trustquote-lead',
      paneId: 'trustquote-lead',
      sessionId: 'app-session-407:trustquote',
    }, 4_000);
    expect(recordArmCheckinProof({
      appRoomId: 'trustquote',
      sessionId: 'app-session-407:trustquote',
      armKey: 'lead',
      role: 'trustquote-lead',
      paneId: 'trustquote-lead',
      proofKind: 'startup_check_in',
      messageId: 'hm-lead-session-407',
      commsRowId: lead407.rowId,
      env: {
        SQUIDRUN_ROLE: 'trustquote-lead',
        SQUIDRUN_PANE_ID: 'trustquote-lead',
        SQUIDRUN_SESSION_SCOPE_ID: 'app-session-407:trustquote',
      },
    }, { dbPath, nowMs: 4_000 }).ok).toBe(true);

    const current = buildArmStateProjection({
      appRoomId: 'trustquote',
      sessionId: 'app-session-407:trustquote',
    }, { dbPath, nowMs: 5_000 });
    expect(current.registry).toEqual(expect.objectContaining({
      desiredCount: 2,
      readyCount: 1,
      missingCount: 1,
    }));
    expect(current.arms.find((arm) => arm.armKey === 'lead')).toEqual(expect.objectContaining({
      status: 'ready',
      latestAcceptedCheckin: expect.objectContaining({ messageId: 'hm-lead-session-407' }),
    }));
  });

  test('CLI surfaces the same projection only when explicitly invoked', () => {
    expect(upsertArmRegistryManifest(manifest(), { dbPath, nowMs: 1_000 }).ok).toBe(true);

    const output = execFileSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'hm-arm-state.js'),
      'status',
      '--db',
      dbPath,
      '--app-room',
      'trustquote',
      '--session',
      'app-session-406:trustquote',
      '--json',
      '--now-ms',
      '2000',
    ], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      windowsHide: true,
    });
    const projection = JSON.parse(output);
    expect(projection).toEqual(expect.objectContaining({
      ok: true,
      schema: 'squidrun.arm_state_projection.v0',
      projectionOnly: true,
      readOnly: true,
      explicitInvocationRequired: true,
      trustQuoteRoomBehaviorUnchanged: true,
    }));
    expect(projection.registry).toEqual(expect.objectContaining({
      appRoomId: 'trustquote',
      desiredCount: 2,
      readyCount: 0,
      missingCount: 2,
    }));
  });

  test('CLI refuses a missing explicit db path without creating projection files', () => {
    const missingDbPath = path.join(tempDir, 'missing-projection.db');

    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'hm-arm-state.js'),
      'status',
      '--db',
      missingDbPath,
      '--app-room',
      'trustquote',
      '--session',
      'app-session-406:trustquote',
      '--json',
    ], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      windowsHide: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout);
    expect(payload).toEqual(expect.objectContaining({
      ok: false,
      schema: 'squidrun.arm_state_projection.v0',
    }));
    expect(payload.reason).toContain('db_not_found:');
    expect(payload.reason).toContain('--allow-create');
    expect(fs.existsSync(missingDbPath)).toBe(false);
    expect(fs.existsSync(`${missingDbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${missingDbPath}-shm`)).toBe(false);
  });
});
