const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const {
  getArmRegistryManifest,
  queryArmCheckinProofs,
  queryArmMissingWatchdogs,
  closeArmRegistryStores,
} = require('../modules/main/arm-registry');
const {
  queryArmApplyRequests,
  closeArmApplyQueueStores,
} = require('../modules/main/arm-apply-queue');
const {
  buildTrustQuoteArmRegistryManifest,
  seedTrustQuoteArmRegistry,
} = require('../modules/main/trustquote-arm-registry-seed');

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

maybeDescribe('TrustQuote arm registry seed', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustquote-arm-seed-'));
    dbPath = path.join(tempDir, 'evidence-ledger.db');
  });

  afterEach(() => {
    closeArmRegistryStores();
    closeArmApplyQueueStores();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('builds the day-to-day TrustQuote manifest from app-status session context', () => {
    const projectRoot = path.join(tempDir, 'project');
    fs.mkdirSync(path.join(projectRoot, '.squidrun'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.squidrun', 'app-status.json'), JSON.stringify({ session: 777 }), 'utf8');

    const manifest = buildTrustQuoteArmRegistryManifest({ projectRoot, nowMs: 10_000 });

    expect(manifest).toEqual(expect.objectContaining({
      appRoomId: 'trustquote',
      sessionId: 'app-session-777:trustquote',
      mainSessionId: 'app-session-777',
      leadRole: 'trustquote-lead',
      leadPaneId: 'trustquote-lead',
    }));
    expect(manifest.arms.map((arm) => arm.armKey)).toEqual([
      'lead',
      'work-schedule',
      'money-documents',
    ]);
    expect(manifest.arms.map((arm) => arm.role)).toEqual([
      'trustquote-lead',
      'trustquote-work-schedule',
      'trustquote-money-documents',
    ]);
    expect(manifest.metadata).toEqual(expect.objectContaining({
      sourceRef: 'docs/trustquote-arm-set-proposal.md',
      readinessTruth: 'missing_until_role_checkins_exist',
      buildModeArms: [
        expect.objectContaining({
          armKey: 'dev-qa',
          desiredByDefault: false,
        }),
      ],
    }));
  });

  test('seeds desired arms without creating readiness proof apply requests or watchdogs', () => {
    const result = seedTrustQuoteArmRegistry({
      dbPath,
      mainSessionId: 'app-session-999',
      nowMs: 20_000,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('seeded_and_evaluated');
    expect(result.registry).toEqual(expect.objectContaining({
      appRoomId: 'trustquote',
      sessionId: 'app-session-999:trustquote',
      mainSessionId: 'app-session-999',
      desiredCount: 3,
      readyCount: 0,
      missingCount: 3,
    }));
    expect(Object.fromEntries(result.registry.arms.map((arm) => [arm.armKey, arm.status]))).toEqual({
      lead: 'missing',
      'money-documents': 'missing',
      'work-schedule': 'missing',
    });
    expect(queryArmCheckinProofs({}, { dbPath })).toHaveLength(0);
    expect(queryArmApplyRequests({}, { dbPath })).toHaveLength(0);
    expect(queryArmMissingWatchdogs({}, { dbPath })).toHaveLength(0);

    const store = new EvidenceLedgerStore({ dbPath });
    expect(store.init().ok).toBe(true);
    const registryCount = store.db.prepare('SELECT COUNT(*) AS count FROM arm_registries').get().count;
    const armCount = store.db.prepare('SELECT COUNT(*) AS count FROM arm_registry_arms').get().count;
    store.close();
    expect(registryCount).toBe(1);
    expect(armCount).toBe(3);
  });

  test('dry-run reports the manifest without writing registry rows', () => {
    const result = seedTrustQuoteArmRegistry({
      dbPath,
      mainSessionId: 'app-session-1000',
      dryRun: true,
      nowMs: 30_000,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'dry_run',
      readOnly: true,
      sideEffects: {
        registryWrites: 0,
        checkinsCreated: 0,
        applyRequestsCreated: 0,
        watchdogsCreated: 0,
      },
    }));
    expect(getArmRegistryManifest({
      appRoomId: 'trustquote',
      sessionId: 'app-session-1000:trustquote',
    }, { dbPath })).toBeNull();
  });

  test('CLI seeds parseable JSON for an explicit session', () => {
    const output = execFileSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'hm-seed-trustquote-arm-registry.js'),
      'seed',
      '--db',
      dbPath,
      '--session',
      'app-session-cli:trustquote',
      '--now-ms',
      '40000',
      '--json',
    ], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      windowsHide: true,
    });

    const result = JSON.parse(output);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'seeded_and_evaluated',
      schema: 'squidrun.trustquote_arm_registry_seed.v0',
    }));
    expect(result.registry).toEqual(expect.objectContaining({
      sessionId: 'app-session-cli:trustquote',
      desiredCount: 3,
      readyCount: 0,
      missingCount: 3,
    }));
  });
});
