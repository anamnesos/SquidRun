const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { TeamMemoryStore, loadSqliteDriver } = require('../modules/team-memory/store');
const { MemoryIngestService } = require('../modules/memory-ingest/service');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;
let activeStores = [];

function createStoreAndService(dbPath, markerPath) {
  const store = new TeamMemoryStore({ dbPath });
  const init = store.init();
  expect(init.ok).toBe(true);
  activeStores.push(store);
  const service = new MemoryIngestService({
    db: store.db,
    logger: { warn: jest.fn() },
    shutdownMarkerOptions: { filePath: markerPath },
    replayBatchSize: 10,
    replayTickMs: 5,
    replayMaxTickMs: 100,
    replayMaxPasses: 10,
  });
  return { store, service };
}

function parseLastJsonObject(raw = '') {
  const text = String(raw || '').trim();
  for (let idx = text.lastIndexOf('{'); idx >= 0; idx = text.lastIndexOf('{', idx - 1)) {
    const candidate = text.slice(idx).trim();
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // keep scanning
    }
  }
  return {};
}

function spawnConcurrentIngest({ uiRoot, dbPath, markerPath, payload, nowMs }) {
  return new Promise((resolve, reject) => {
    const script = `
      const path = require('path');
      const uiRoot = process.argv[1];
      const dbPath = process.argv[2];
      const markerPath = process.argv[3];
      const payload = JSON.parse(process.argv[4]);
      const nowMs = Number(process.argv[5]);
      const { TeamMemoryStore } = require(path.join(uiRoot, 'modules', 'team-memory', 'store'));
      const { MemoryIngestService } = require(path.join(uiRoot, 'modules', 'memory-ingest', 'service'));
      const store = new TeamMemoryStore({ dbPath });
      const init = store.init();
      if (!init.ok) {
        console.error(JSON.stringify(init));
        process.exit(2);
      }
      const service = new MemoryIngestService({
        db: store.db,
        logger: console,
        shutdownMarkerOptions: { filePath: markerPath },
      });
      const result = service.ingest(payload, { nowMs });
      store.close();
      if (result.ok !== true) {
        console.error(JSON.stringify(result));
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(result));
    `;

    const child = spawn(process.execPath, [
      '-e',
      script,
      uiRoot,
      dbPath,
      markerPath,
      JSON.stringify(payload),
      String(nowMs),
    ], {
      cwd: uiRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`concurrent ingest failed (${code}): ${stderr || stdout}`));
        return;
      }
      resolve({
        code,
        result: parseLastJsonObject(stdout || '{}'),
      });
    });
  });
}

maybeDescribe('memory-ingest failure hardening', () => {
  let tempDir;
  let dbPath;
  let markerPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-memory-ingest-recovery-'));
    dbPath = path.join(tempDir, 'team-memory.sqlite');
    markerPath = path.join(tempDir, 'memory-ingest-shutdown.json');
    activeStores = [];
  });

  afterEach(() => {
    for (const store of activeStores) {
      try {
        store.close();
      } catch {
        // best effort
      }
    }
    activeStores = [];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('replays unrouted journal entries after an unclean shutdown', () => {
    const cleanStart = createStoreAndService(dbPath, markerPath);
    cleanStart.service.initializeRuntime({ nowMs: 100 });
    cleanStart.service.shutdown({ nowMs: 150 });
    cleanStart.store.close();

    const crashed = createStoreAndService(dbPath, markerPath);
    const startup = crashed.service.initializeRuntime({ nowMs: 200 });
    expect(startup.startup.hadAbruptShutdown).toBe(false);
    crashed.service.setCompactionLock({
      locked: true,
      locked_tiers: ['tier3'],
      reason: 'test_compaction',
    }, { nowMs: 210 });

    const queued = crashed.service.ingest({
      content: 'Retry the replay queue after restart.',
      memory_class: 'solution_trace',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.92,
      source_trace: 'crash-trace-1',
      session_id: 'app-session-217',
    }, { nowMs: 220 });
    expect(queued.ok).toBe(true);
    expect(queued.queued).toBe(true);
    crashed.store.close();

    const recovered = createStoreAndService(dbPath, markerPath);
    const recoveredStartup = recovered.service.initializeRuntime({ nowMs: 400 });
    expect(recoveredStartup.startup.hadAbruptShutdown).toBe(true);
    expect(recovered.service.getStatus({ nowMs: 401 }).compactionLock.locked).toBe(false);

    const replay = recovered.service.flushRecoveryWork({ nowMs: 410, maxPasses: 10 });
    expect(replay.outstandingEntries).toBe(0);

    const journalRow = recovered.store.db.prepare('SELECT status, queue_reason FROM memory_ingest_journal LIMIT 1').get();
    const memoryCount = recovered.store.db.prepare('SELECT COUNT(*) AS count FROM memory_objects').get().count;
    expect(journalRow.status).toBe('routed');
    expect(journalRow.queue_reason).toBeNull();
    expect(memoryCount).toBeGreaterThanOrEqual(1);

    recovered.service.shutdown({ nowMs: 450 });
    recovered.store.close();
  });

  test('queues ingest while target tier is compacting and replays on unlock', () => {
    const { store, service } = createStoreAndService(dbPath, markerPath);
    service.initializeRuntime({ nowMs: 1000 });

    service.setCompactionLock({
      locked: true,
      locked_tiers: ['tier3'],
      reason: 'compaction_active',
    }, { nowMs: 1010 });

    const queued = service.ingest({
      content: 'Queue me until compaction ends.',
      memory_class: 'solution_trace',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.87,
      source_trace: 'lock-trace-1',
      session_id: 'app-session-217',
    }, { nowMs: 1020 });

    expect(queued.ok).toBe(true);
    expect(queued.queued).toBe(true);
    expect(queued.queue_reason).toBe('compaction_lock');

    const beforeReplay = store.db.prepare('SELECT status, queue_reason FROM memory_ingest_journal LIMIT 1').get();
    expect(beforeReplay.status).toBe('failed');
    expect(beforeReplay.queue_reason).toBe('compaction_lock');
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM memory_objects').get().count).toBe(0);

    service.setCompactionLock({ locked: false, reason: 'compaction_done' }, { nowMs: 1100 });
    const replay = service.flushRecoveryWork({ nowMs: 1105, maxPasses: 10 });
    expect(replay.outstandingEntries).toBe(0);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM memory_objects').get().count).toBe(1);

    const afterReplay = store.db.prepare('SELECT status, queue_reason, next_attempt_at FROM memory_ingest_journal LIMIT 1').get();
    expect(afterReplay.status).toBe('routed');
    expect(afterReplay.queue_reason).toBeNull();
    expect(afterReplay.next_attempt_at).toBeNull();

    service.shutdown({ nowMs: 1200 });
    store.close();
  });

  test('simultaneous ingest calls dedupe cleanly without journal corruption', async () => {
    const uiRoot = path.join(__dirname, '..');
    const preInitStore = new TeamMemoryStore({ dbPath });
    expect(preInitStore.init().ok).toBe(true);
    preInitStore.close();

    const payload = {
      content: 'Concurrent writers should dedupe safely.',
      memory_class: 'solution_trace',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.94,
      source_trace: 'concurrency-trace-1',
      session_id: 'app-session-217',
    };

    await Promise.all(
      Array.from({ length: 6 }, (_, index) => spawnConcurrentIngest({
        uiRoot,
        dbPath,
        markerPath,
        payload,
        nowMs: 2000 + index,
      }))
    );

    const store = new TeamMemoryStore({ dbPath });
    expect(store.init().ok).toBe(true);

    const journalCount = store.db.prepare('SELECT COUNT(*) AS count FROM memory_ingest_journal').get().count;
    const memoryCount = store.db.prepare('SELECT COUNT(*) AS count FROM memory_objects').get().count;
    const dedupeCount = store.db.prepare('SELECT COUNT(*) AS count FROM memory_dedupe_keys').get().count;

    expect(journalCount).toBe(6);
    expect(memoryCount).toBe(1);
    expect(dedupeCount).toBe(1);

    const badRows = store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_ingest_journal
      WHERE status NOT IN ('routed', 'deduped')
    `).get().count;
    expect(badRows).toBe(0);

    store.close();
  });

  test('precompact hook persists active task state through the ingest journal', () => {
    const { store, service } = createStoreAndService(dbPath, markerPath);
    service.initializeRuntime({ nowMs: 3000 });
    service.setCompactionLock({
      locked: true,
      locked_tiers: ['tier1', 'tier3'],
      reason: 'precompact_capture',
    }, { nowMs: 3010 });

    const result = service.capturePrecompactState({
      summary: 'Builder was midway through wiring replay recovery.',
      pane_id: '2',
      role: 'builder',
      session_id: 'app-session-217',
    }, { nowMs: 3020 });

    expect(result.ok).toBe(true);
    expect(result.routed_to_tier).toBe('tier4');
    expect(result.queued).toBe(false);

    const memoryRow = store.db.prepare(`
      SELECT memory_class, tier, provenance_json, content
      FROM memory_objects
      LIMIT 1
    `).get();
    const journalRow = store.db.prepare(`
      SELECT status, payload_json
      FROM memory_ingest_journal
      LIMIT 1
    `).get();

    expect(memoryRow.memory_class).toBe('active_task_state');
    expect(memoryRow.tier).toBe('tier4');
    expect(JSON.parse(memoryRow.provenance_json).kind).toBe('precompact_hook');
    expect(memoryRow.content).toContain('midway through wiring replay recovery');
    expect(journalRow.status).toBe('routed');
    expect(JSON.parse(journalRow.payload_json).scope.hook).toBe('precompact');

    service.shutdown({ nowMs: 3050 });
    store.close();
  });
});
