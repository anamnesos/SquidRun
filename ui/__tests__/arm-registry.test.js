const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const {
  upsertArmRegistryManifest,
  getArmRegistryManifest,
  migrateArmRegistryManifestScope,
  recordArmCheckinProof,
  queryArmCheckinProofs,
  evaluateArmRegistryReadiness,
  closeArmRegistryStores,
} = require('../modules/main/arm-registry');

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

function trustquoteManifest(overrides = {}) {
  return {
    appRoomId: 'trustquote',
    sessionId: 'app-room:trustquote',
    mainSessionId: 'app-session-406',
    leadRole: 'trustquote-lead',
    leadPaneId: 'trustquote-lead',
    routeTarget: 'trustquote',
    metadata: { source: 'test-manifest' },
    arms: [
      {
        armKey: 'lead',
        role: 'trustquote-lead',
        paneId: 'trustquote-lead',
        routeTarget: 'architect',
        armKind: 'lead',
        displayName: 'TrustQuote Lead',
        dataSources: ['readiness-proof', 'arm-summaries'],
        permissions: { read: ['summaries'], write: ['readiness'] },
        checkInObligation: { required: true, deadlineMs: 120000 },
      },
      {
        armKey: 'work-schedule',
        role: 'trustquote-operations',
        paneId: 'trustquote-operations',
        routeTarget: 'trustquote-operations',
        armKind: 'domain',
        displayName: 'Work + Schedule',
        dataSources: ['calendar-events', 'customers', 'job-packets'],
        permissions: { read: ['schedule', 'customers'], draft: ['schedule_change'] },
        checkInObligation: { required: true, deadlineMs: 120000 },
      },
      {
        armKey: 'money-documents',
        role: 'trustquote-billing',
        paneId: 'trustquote-billing',
        routeTarget: 'trustquote-billing',
        armKind: 'domain',
        displayName: 'Money + Documents',
        dataSources: ['jobs', 'quotes', 'payments', 'pricebook'],
        permissions: { read: ['money_records'], draft: ['invoice', 'payment_reminder'] },
        checkInObligation: { required: true, deadlineMs: 120000 },
      },
    ],
    ...overrides,
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
      sender: {
        role,
        pane_id: paneId,
      },
      envelope: {
        session_id: sessionId,
        sender: {
          role,
          pane_id: paneId,
        },
      },
      project: {
        session_id: sessionId,
      },
    },
  }, { nowMs }).ok).toBe(true);
  const row = store.queryCommsJournal({ messageId, limit: 1 })[0];
  store.close();
  return row;
}

const maybeDescribe = hasSqliteDriver() ? describe : describe.skip;

maybeDescribe('arm registry', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-registry-'));
    dbPath = path.join(tempDir, 'evidence-ledger.db');
  });

  afterEach(() => {
    closeArmRegistryStores();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('persists a room-scoped manifest and desired arms in the evidence ledger', () => {
    const inserted = upsertArmRegistryManifest(trustquoteManifest(), { dbPath, nowMs: 1_000 });

    expect(inserted.ok).toBe(true);
    expect(inserted.status).toBe('inserted');
    expect(inserted.registry).toEqual(expect.objectContaining({
      appRoomId: 'trustquote',
      sessionId: 'app-room:trustquote',
      mainSessionId: 'app-session-406',
      leadRole: 'trustquote-lead',
      desiredCount: 3,
      readyCount: 0,
      missingCount: 3,
    }));
    expect(inserted.registry.arms.map((arm) => arm.armKey)).toEqual([
      'lead',
      'money-documents',
      'work-schedule',
    ]);
    expect(inserted.registry.arms.every((arm) => arm.status === 'desired')).toBe(true);

    closeArmRegistryStores();
    const reopened = new EvidenceLedgerStore({ dbPath });
    expect(reopened.init().ok).toBe(true);
    const persisted = reopened.getArmRegistryManifest({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    });
    reopened.close();

    expect(persisted).toEqual(expect.objectContaining({
      desiredCount: 3,
      readyCount: 0,
      missingCount: 3,
    }));
    expect(persisted.arms).toHaveLength(3);
  });

  test('upserts idempotently and keeps readiness unclaimable from manifest input', () => {
    const first = upsertArmRegistryManifest(trustquoteManifest(), { dbPath, nowMs: 1_000 });
    expect(first.ok).toBe(true);

    const second = upsertArmRegistryManifest(trustquoteManifest({
      readyCount: 3,
      metadata: { projectionSaysReady: true },
      arms: trustquoteManifest().arms.map((arm) => ({
        ...arm,
        status: 'ready',
        lastProofRefs: ['status-widget:false-proof'],
        metadata: { incomingClaim: 'ready' },
      })),
    }), { dbPath, nowMs: 2_000 });

    expect(second.ok).toBe(true);
    expect(second.status).toBe('updated');
    expect(second.registry).toEqual(expect.objectContaining({
      desiredCount: 3,
      readyCount: 0,
      missingCount: 3,
      metadata: expect.objectContaining({
        source: 'test-manifest',
        projectionSaysReady: true,
      }),
    }));
    expect(second.registry.arms.every((arm) => arm.status === 'desired')).toBe(true);
    expect(second.registry.arms.every((arm) => arm.lastProofRefs.length === 0)).toBe(true);

    const rows = new EvidenceLedgerStore({ dbPath });
    expect(rows.init().ok).toBe(true);
    const count = rows.db.prepare('SELECT COUNT(*) AS count FROM arm_registries').get().count;
    const armCount = rows.db.prepare('SELECT COUNT(*) AS count FROM arm_registry_arms').get().count;
    rows.close();
    expect(count).toBe(1);
    expect(armCount).toBe(3);
  });

  test('migrates a legacy session-pinned manifest in place and logs it', () => {
    const inserted = upsertArmRegistryManifest(trustquoteManifest(), { dbPath, nowMs: 1_000 });
    expect(inserted.ok).toBe(true);

    const legacyStore = new EvidenceLedgerStore({ dbPath });
    expect(legacyStore.init().ok).toBe(true);
    legacyStore.db.prepare(`
      UPDATE arm_registries SET session_id = ? WHERE registry_id = ?
    `).run('app-session-406:trustquote', inserted.registry.registryId);
    legacyStore.db.prepare(`
      UPDATE arm_registry_arms SET session_id = ? WHERE registry_id = ?
    `).run('app-session-406:trustquote', inserted.registry.registryId);
    legacyStore.close();

    const migrated = migrateArmRegistryManifestScope({
      appRoomId: 'trustquote',
      fromSessionId: 'app-session-406:trustquote',
    }, { dbPath, nowMs: 2_000 });

    expect(migrated).toEqual(expect.objectContaining({
      ok: true,
      status: 'migrated',
      migrated: true,
      fromSessionId: 'app-session-406:trustquote',
      toSessionId: 'app-room:trustquote',
    }));
    expect(migrated.before).toEqual(expect.objectContaining({
      armRows: 3,
      checkinRows: 0,
      watchdogRows: 0,
      applyRows: 0,
    }));
    expect(migrated.after).toEqual(expect.objectContaining({
      canonicalRows: 1,
      legacyRows: 0,
      armRows: 3,
      checkinRows: 0,
      watchdogRows: 0,
      applyRows: 0,
    }));

    const verify = new EvidenceLedgerStore({ dbPath });
    expect(verify.init().ok).toBe(true);
    expect(verify.db.prepare(`
      SELECT COUNT(*) AS count FROM arm_registries WHERE app_room_id = 'trustquote'
    `).get().count).toBe(1);
    expect(verify.db.prepare(`
      SELECT COUNT(*) AS count FROM arm_registry_arms WHERE session_id = 'app-room:trustquote'
    `).get().count).toBe(3);
    expect(verify.db.prepare(`
      SELECT COUNT(*) AS count FROM ledger_events WHERE type = 'arm_registry_manifest_scope_migration'
    `).get().count).toBe(1);
    verify.close();

    const second = migrateArmRegistryManifestScope({
      appRoomId: 'trustquote',
      fromSessionId: 'app-session-406:trustquote',
    }, { dbPath, nowMs: 3_000 });
    expect(second).toEqual(expect.objectContaining({
      ok: true,
      status: 'already_canonical',
      migrated: false,
    }));
  });

  test('rejects canonical success when a legacy duplicate registry remains', () => {
    const inserted = upsertArmRegistryManifest(trustquoteManifest(), { dbPath, nowMs: 1_000 });
    expect(inserted.ok).toBe(true);

    const duplicateStore = new EvidenceLedgerStore({ dbPath });
    expect(duplicateStore.init().ok).toBe(true);
    duplicateStore.db.prepare(`
      INSERT INTO arm_registries (
        registry_id, app_room_id, session_id, main_session_id, lead_role,
        lead_pane_id, route_target, status, desired_count, ready_count,
        missing_count, last_evaluated_at_ms, metadata_json, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 3, 0, 3, ?, '{}', ?, ?)
    `).run(
      'arm-registry-legacy-duplicate',
      'trustquote',
      'app-session-405:trustquote',
      'app-session-405',
      'trustquote-lead',
      'trustquote-lead',
      'trustquote',
      1_500,
      1_500,
      1_500
    );
    duplicateStore.close();

    const duplicate = migrateArmRegistryManifestScope({
      appRoomId: 'trustquote',
      fromSessionId: 'app-session-405:trustquote',
    }, { dbPath, nowMs: 2_000 });

    expect(duplicate).toEqual(expect.objectContaining({
      ok: false,
      status: 'duplicate_scope_conflict',
      reason: 'canonical_and_legacy_registries_present',
      canonicalRegistryId: inserted.registry.registryId,
      legacyRegistries: [
        expect.objectContaining({
          registryId: 'arm-registry-legacy-duplicate',
          sessionId: 'app-session-405:trustquote',
        }),
      ],
    }));
  });

  test('keeps one canonical app-room manifest across app sessions', () => {
    expect(upsertArmRegistryManifest(trustquoteManifest({
      sessionId: 'app-session-406:trustquote',
    }), { dbPath, nowMs: 1_000 }).ok).toBe(true);
    expect(upsertArmRegistryManifest(trustquoteManifest({
      sessionId: 'app-session-407:trustquote',
      mainSessionId: 'app-session-407',
      metadata: { source: 'next-session' },
    }), { dbPath, nowMs: 2_000 }).ok).toBe(true);

    const current = getArmRegistryManifest({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, { dbPath });
    const next = getArmRegistryManifest({
      appRoomId: 'trustquote',
      sessionId: 'app-session-407:trustquote',
    }, { dbPath });

    expect(current.registryId).toBe(next.registryId);
    expect(current.sessionId).toBe('app-room:trustquote');
    expect(next.sessionId).toBe('app-room:trustquote');
    expect(next.mainSessionId).toBe('app-session-407');
    expect(next.metadata).toEqual(expect.objectContaining({ source: 'next-session' }));

    const rows = new EvidenceLedgerStore({ dbPath });
    expect(rows.init().ok).toBe(true);
    const count = rows.db.prepare('SELECT COUNT(*) AS count FROM arm_registries').get().count;
    rows.close();
    expect(count).toBe(1);
  });

  test('computes desired ready and missing from durable role check-ins', () => {
    expect(upsertArmRegistryManifest(trustquoteManifest(), { dbPath, nowMs: 1_000 }).ok).toBe(true);
    const leadRow = seedCommsCheckin(dbPath, {
      messageId: 'hm-lead-1',
      role: 'trustquote-lead',
      paneId: 'trustquote-lead',
    }, 2_000);

    const leadCheckin = recordArmCheckinProof({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'lead',
      role: 'trustquote-lead',
      paneId: 'trustquote-lead',
      proofKind: 'startup_check_in',
      messageId: 'hm-lead-1',
      commsRowId: leadRow.rowId,
      rawRoleMarker: '(TRUSTQUOTE LEAD #1)',
      env: {
        SQUIDRUN_ROLE: 'trustquote-lead',
        SQUIDRUN_PANE_ID: 'trustquote-lead',
        SQUIDRUN_SESSION_SCOPE_ID: 'app-session-406:trustquote',
      },
      proofRefs: [`comms_journal:${leadRow.rowId}`],
    }, { dbPath, nowMs: 2_000 });

    expect(leadCheckin.ok).toBe(true);
    expect(leadCheckin.status).toBe('accepted');
    expect(leadCheckin.evaluation.registry).toEqual(expect.objectContaining({
      desiredCount: 3,
      readyCount: 1,
      missingCount: 2,
    }));

    seedCommsCheckin(dbPath, {
      messageId: 'hm-ops-1',
      role: 'trustquote-operations',
      paneId: 'trustquote-operations',
    }, 3_000);
    const operationsCheckin = recordArmCheckinProof({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'work-schedule',
      role: 'trustquote-operations',
      paneId: 'trustquote-operations',
      proofKind: 'role_check_in',
      messageId: 'hm-ops-1',
      env: {
        role: 'trustquote-operations',
        paneId: 'trustquote-operations',
        sessionId: 'app-session-406:trustquote',
      },
      proofRefs: ['hm:hm-ops-1'],
    }, { dbPath, nowMs: 3_000 });

    expect(operationsCheckin.ok).toBe(true);
    expect(operationsCheckin.evaluation.registry).toEqual(expect.objectContaining({
      desiredCount: 3,
      readyCount: 2,
      missingCount: 1,
    }));

    closeArmRegistryStores();
    const reopened = new EvidenceLedgerStore({ dbPath });
    expect(reopened.init().ok).toBe(true);
    const persisted = reopened.getArmRegistryManifest({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    });
    reopened.close();

    expect(persisted).toEqual(expect.objectContaining({
      desiredCount: 3,
      readyCount: 2,
      missingCount: 1,
    }));
    expect(Object.fromEntries(persisted.arms.map((arm) => [arm.armKey, arm.status]))).toEqual({
      lead: 'ready',
      'money-documents': 'missing',
      'work-schedule': 'ready',
    });
  });

  test('rejects forged check-in message ids that are not in comms journal', () => {
    expect(upsertArmRegistryManifest(trustquoteManifest(), { dbPath, nowMs: 1_000 }).ok).toBe(true);

    const forged = recordArmCheckinProof({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'lead',
      role: 'trustquote-lead',
      paneId: 'trustquote-lead',
      proofKind: 'startup_check_in',
      messageId: 'not-in-comms-journal',
      env: {
        SQUIDRUN_ROLE: 'trustquote-lead',
        SQUIDRUN_PANE_ID: 'trustquote-lead',
        SQUIDRUN_SESSION_SCOPE_ID: 'app-session-406:trustquote',
      },
    }, { dbPath, nowMs: 2_000 });

    expect(forged.ok).toBe(false);
    expect(forged.status).toBe('rejected');
    expect(forged.reason).toContain('comms_message_not_found');

    const evaluation = evaluateArmRegistryReadiness({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, { dbPath, nowMs: 3_000 });
    expect(evaluation.ok).toBe(true);
    expect(evaluation.registry).toEqual(expect.objectContaining({
      desiredCount: 3,
      readyCount: 0,
      missingCount: 3,
    }));
  });

  test('drops stale readiness proof when an arm key changes role or pane identity', () => {
    const oneArmManifest = trustquoteManifest({
      arms: [
        {
          armKey: 'money-documents',
          role: 'trustquote-billing',
          paneId: 'trustquote-billing',
          routeTarget: 'trustquote-billing',
          armKind: 'domain',
          displayName: 'Money + Documents',
          dataSources: ['jobs', 'quotes', 'payments'],
          permissions: { read: ['money_records'], draft: ['invoice'] },
          checkInObligation: { required: true },
        },
      ],
    });
    expect(upsertArmRegistryManifest(oneArmManifest, { dbPath, nowMs: 1_000 }).ok).toBe(true);
    seedCommsCheckin(dbPath, {
      messageId: 'hm-billing-ready',
      role: 'trustquote-billing',
      paneId: 'trustquote-billing',
    }, 2_000);

    const accepted = recordArmCheckinProof({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'money-documents',
      role: 'trustquote-billing',
      paneId: 'trustquote-billing',
      proofKind: 'startup_check_in',
      messageId: 'hm-billing-ready',
      env: {
        SQUIDRUN_ROLE: 'trustquote-billing',
        SQUIDRUN_PANE_ID: 'trustquote-billing',
        SQUIDRUN_SESSION_SCOPE_ID: 'app-session-406:trustquote',
      },
      proofRefs: ['hm:hm-billing-ready'],
    }, { dbPath, nowMs: 2_000 });
    expect(accepted.ok).toBe(true);
    expect(accepted.evaluation.registry).toEqual(expect.objectContaining({
      desiredCount: 1,
      readyCount: 1,
      missingCount: 0,
    }));

    const renamed = upsertArmRegistryManifest(trustquoteManifest({
      arms: [
        {
          armKey: 'money-documents',
          role: 'trustquote-finance',
          paneId: 'trustquote-finance',
          routeTarget: 'trustquote-finance',
          armKind: 'domain',
          displayName: 'Money + Documents',
          dataSources: ['jobs', 'quotes', 'payments'],
          permissions: { read: ['money_records'], draft: ['invoice'] },
          checkInObligation: { required: true },
        },
      ],
    }), { dbPath, nowMs: 3_000 });

    expect(renamed.ok).toBe(true);
    expect(renamed.registry).toEqual(expect.objectContaining({
      desiredCount: 1,
      readyCount: 0,
      missingCount: 1,
    }));
    expect(renamed.registry.arms[0]).toEqual(expect.objectContaining({
      role: 'trustquote-finance',
      paneId: 'trustquote-finance',
      status: 'desired',
      lastProofRefs: [],
    }));

    const evaluation = evaluateArmRegistryReadiness({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, { dbPath, nowMs: 4_000 });
    expect(evaluation.ok).toBe(true);
    expect(evaluation.registry).toEqual(expect.objectContaining({
      desiredCount: 1,
      readyCount: 0,
      missingCount: 1,
    }));
    expect(evaluation.registry.arms[0]).toEqual(expect.objectContaining({
      role: 'trustquote-finance',
      paneId: 'trustquote-finance',
      status: 'missing',
      lastProofRefs: [],
    }));
  });

  test('rejects route probes wrong identity and heartbeats as readiness proof', () => {
    expect(upsertArmRegistryManifest(trustquoteManifest(), { dbPath, nowMs: 1_000 }).ok).toBe(true);

    const routeProbe = recordArmCheckinProof({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'lead',
      role: 'trustquote-lead',
      paneId: 'trustquote-lead',
      proofKind: 'route_probe',
      messageId: 'route-proof-1',
      metadata: { canRouteTask: true },
    }, { dbPath, nowMs: 2_000 });
    expect(routeProbe.ok).toBe(false);
    expect(routeProbe.status).toBe('rejected');
    expect(routeProbe.reason).toContain('identity_check_in_required');

    seedCommsCheckin(dbPath, {
      messageId: 'hm-wrong-pane',
      role: 'trustquote-operations',
      paneId: 'trustquote-builder',
    }, 3_000);
    const wrongPane = recordArmCheckinProof({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      armKey: 'work-schedule',
      role: 'trustquote-operations',
      paneId: 'trustquote-builder',
      proofKind: 'startup_check_in',
      messageId: 'hm-wrong-pane',
      env: {
        SQUIDRUN_ROLE: 'trustquote-operations',
        SQUIDRUN_PANE_ID: 'trustquote-builder',
        SQUIDRUN_SESSION_SCOPE_ID: 'app-session-406:trustquote',
      },
    }, { dbPath, nowMs: 3_000 });
    expect(wrongPane.ok).toBe(false);
    expect(wrongPane.reason).toContain('pane_mismatch');
    expect(wrongPane.reason).toContain('comms_pane_mismatch');

    seedCommsCheckin(dbPath, {
      messageId: 'hm-stale-session',
      role: 'trustquote-billing',
      paneId: 'trustquote-billing',
      sessionId: 'app-session-405:trustquote',
    }, 4_000);
    const staleSession = recordArmCheckinProof({
      registryId: routeProbe.proof.registryId,
      sessionId: 'app-session-406:trustquote',
      armKey: 'money-documents',
      role: 'trustquote-billing',
      paneId: 'trustquote-billing',
      proofKind: 'startup_check_in',
      messageId: 'hm-stale-session',
      env: {
        SQUIDRUN_ROLE: 'trustquote-billing',
        SQUIDRUN_PANE_ID: 'trustquote-billing',
        SQUIDRUN_SESSION_SCOPE_ID: 'app-session-405:trustquote',
      },
    }, { dbPath, nowMs: 4_000 });
    expect(staleSession.ok).toBe(false);
    expect(staleSession.reason).toContain('session_mismatch');
    expect(staleSession.reason).toContain('env_session_mismatch');
    expect(staleSession.reason).toContain('comms_session_mismatch');

    const evaluation = evaluateArmRegistryReadiness({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
    }, { dbPath, nowMs: 5_000 });
    expect(evaluation.ok).toBe(true);
    expect(evaluation.registry).toEqual(expect.objectContaining({
      desiredCount: 3,
      readyCount: 0,
      missingCount: 3,
    }));
    expect(queryArmCheckinProofs({ status: 'rejected' }, { dbPath })).toHaveLength(3);
  });
});
