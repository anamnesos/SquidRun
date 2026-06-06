const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const {
  upsertArmRegistryManifest,
  getArmRegistryManifest,
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
    sessionId: 'app-session-406:trustquote',
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
      sessionId: 'app-session-406:trustquote',
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

  test('keeps app-room session manifests isolated', () => {
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

    expect(current.mainSessionId).toBe('app-session-406');
    expect(next.mainSessionId).toBe('app-session-407');
    expect(next.metadata).toEqual(expect.objectContaining({ source: 'next-session' }));
  });
});
