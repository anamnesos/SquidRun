const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { CognitiveMemoryApi } = require('../modules/cognitive-memory-api');
const { CognitiveMemoryStore } = require('../modules/cognitive-memory-store');
const { SleepConsolidator } = require('../modules/cognitive-memory-sleep');
const { MemoryIngestService } = require('../modules/memory-ingest/service');
const { MemoryPromotionService } = require('../modules/memory-ingest/promotion');
const {
  COGNITIVE_TRIGGER_NAMES,
  freezeMemoryMetabolism,
  inspectMemoryMetabolismFreeze,
  readMemoryMetabolismFreeze,
  unfreezeMemoryMetabolism,
} = require('../modules/memory-metabolism-freeze');

describe('memory metabolism freeze', () => {
  let tempDir;
  let dbPath;
  let artifactDir;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-memory-freeze-'));
    dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
    artifactDir = path.join(tempDir, '.squidrun', 'coord', 'memory-metabolism-freeze-test');
    store = new CognitiveMemoryStore({
      projectRoot: tempDir,
      profileName: 'main',
    });
    store.init().exec(`
      CREATE TABLE IF NOT EXISTS sleep_cycle_state (
        state_key TEXT PRIMARY KEY,
        state_value TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sleep_cycle_runs (
        run_id TEXT PRIMARY KEY,
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER,
        episode_count INTEGER NOT NULL DEFAULT 0,
        extracted_count INTEGER NOT NULL DEFAULT 0,
        generated_pr_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        summary_json TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO sleep_cycle_state (state_key, state_value, updated_at_ms)
      VALUES ('last_run_at_ms', '12345', 12345)
      ON CONFLICT(state_key) DO UPDATE SET state_value = excluded.state_value, updated_at_ms = excluded.updated_at_ms;
    `);
    const staged = store.stageMemoryPRs([
      {
        category: 'preference',
        statement: 'Keep this promoted memory intact through the retirement window.',
        confidence_score: 0.9,
        proposed_by: 'freeze-test',
        source_payload: { source: 'unit-test' },
      },
      {
        category: 'observation',
        statement: 'Leave this candidate pending while metabolism is frozen.',
        confidence_score: 0.5,
        proposed_by: 'freeze-test',
      },
    ]);
    store.reviewMemoryPRs({ ids: [staged.staged[0]], status: 'promoted' });
  });

  afterEach(() => {
    try { store?.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('exports promoted rows, snapshots the database, and installs a live reversible barrier', () => {
    const result = freezeMemoryMetabolism({
      dbPath,
      artifactDir,
      expectedPromotedCount: 1,
      evidenceWindowDays: 30,
      nowMs: 1_800_000_000_000,
      reason: 'unit-test freeze',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      active: true,
      promotedCount: 1,
      noDeletionPerformed: true,
    }));
    expect(result.installedTriggers).toHaveLength(COGNITIVE_TRIGGER_NAMES.length);
    expect(fs.existsSync(result.snapshotPath)).toBe(true);
    expect(fs.existsSync(result.exportPath)).toBe(true);
    expect(fs.existsSync(result.manifestPath)).toBe(true);

    const exported = JSON.parse(fs.readFileSync(result.exportPath, 'utf8'));
    expect(exported.promotedCount).toBe(1);
    expect(exported.records[0]).toEqual(expect.objectContaining({
      status: 'promoted',
      statement: 'Keep this promoted memory intact through the retirement window.',
      source_payload: { source: 'unit-test' },
    }));
    expect(exported.records[0].statement_sha256).toBe(
      crypto.createHash('sha256')
        .update('Keep this promoted memory intact through the retirement window.')
        .digest('hex')
    );

    const status = inspectMemoryMetabolismFreeze({ dbPath });
    expect(status).toEqual(expect.objectContaining({
      active: true,
      databaseBarrierActive: true,
      effectiveFrozen: true,
    }));
    expect(status.sleepLastRunAtMs).toBe(String(Number.MAX_SAFE_INTEGER));

    const stagedWhileFrozen = store.stageMemoryPRs([
      { category: 'fact', statement: 'This must not land.' },
    ]);
    expect(stagedWhileFrozen).toEqual(expect.objectContaining({
      ok: true,
      accepted: false,
      frozen: true,
      staged: [],
    }));

    const rawDb = new DatabaseSync(dbPath);
    try {
      expect(() => rawDb.prepare(`
        INSERT INTO memory_pr_queue (
          pr_id, category, statement, normalized_statement, source_payload_json,
          confidence_score, review_count, status, created_at_ms, updated_at_ms
        ) VALUES ('blocked-pr', 'fact', 'blocked', 'blocked', '{}', 0.5, 0, 'pending', 1, 1)
      `).run()).toThrow(/memory_metabolism_frozen/);
    } finally {
      rawDb.close();
    }

    const unfrozen = unfreezeMemoryMetabolism({
      dbPath,
      nowMs: 1_800_000_100_000,
      unfrozenBy: 'unit-test',
    });
    expect(unfrozen.active).toBe(false);
    expect(unfrozen.installedTriggers).toHaveLength(0);
    expect(unfrozen.sleepLastRunAtMs).toBe('12345');

    const stagedAfterUnfreeze = store.stageMemoryPRs([
      { category: 'fact', statement: 'Writes resume only after explicit unfreeze.' },
    ]);
    expect(stagedAfterUnfreeze.staged).toHaveLength(1);
  });

  test('sleep, cognitive ingest, team ingest, and promotion all stop at the shared marker', async () => {
    freezeMemoryMetabolism({
      dbPath,
      artifactDir,
      expectedPromotedCount: 1,
      nowMs: 1_800_000_000_000,
    });
    const statePath = path.join(path.dirname(dbPath), 'memory-metabolism-freeze.json');

    const consolidator = new SleepConsolidator({
      cognitiveStore: store,
      memorySearchIndex: { close() {} },
    });
    const sleep = await consolidator.runOnce();
    expect(sleep).toEqual(expect.objectContaining({
      accepted: false,
      frozen: true,
      status: 'frozen',
      episodeCount: 0,
    }));

    const api = new CognitiveMemoryApi({
      cognitiveStore: store,
      memorySearchIndex: { close() {} },
    });
    const cognitiveIngest = await api.ingest({ content: 'This must not become a node.' });
    expect(cognitiveIngest).toEqual(expect.objectContaining({
      accepted: false,
      frozen: true,
      operation: 'ingest_cognitive_memory',
    }));

    const journal = {
      countOutstandingEntries: () => 0,
      countReplayableEntries: () => 0,
      getNextReplayDueAt: () => null,
    };
    const ingest = new MemoryIngestService({
      db: {},
      journal,
      promotionService: {},
      shutdownMarker: {},
      freezeStatePath: statePath,
    });
    expect(ingest.ingest({ content: 'This must not enter team memory.' })).toEqual(expect.objectContaining({
      accepted: false,
      frozen: true,
      operation: 'memory_ingest',
    }));
    expect(ingest.runRecoveryPass()).toEqual(expect.objectContaining({
      accepted: false,
      frozen: true,
      operation: 'memory_ingest_recovery',
    }));

    const promotion = new MemoryPromotionService({
      db: {},
      projectRoot: tempDir,
      freezeStatePath: statePath,
    });
    expect(promotion.approveCandidate('candidate-1')).toEqual(expect.objectContaining({
      ok: false,
      frozen: true,
      status: 'frozen',
    }));
  });

  test('malformed marker fails closed', () => {
    const statePath = path.join(path.dirname(dbPath), 'memory-metabolism-freeze.json');
    fs.writeFileSync(statePath, '{not-json', 'utf8');
    expect(readMemoryMetabolismFreeze({ statePath })).toEqual(expect.objectContaining({
      active: true,
      malformed: true,
      reason: 'freeze_state_unreadable',
    }));
    expect(store.stageMemoryPRs([{ category: 'fact', statement: 'blocked by malformed marker' }])).toEqual(
      expect.objectContaining({ frozen: true, accepted: false })
    );
  });
});
