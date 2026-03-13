const fs = require('fs');
const os = require('os');
const path = require('path');

const { TeamMemoryStore, loadSqliteDriver } = require('../modules/team-memory/store');
const { MemoryIngestService } = require('../modules/memory-ingest/service');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

maybeDescribe('memory-ingest integration', () => {
  let tempDir;
  let store;
  let service;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-memory-ingest-'));
    store = new TeamMemoryStore({
      dbPath: path.join(tempDir, 'team-memory.sqlite'),
    });
    const init = store.init();
    expect(init.ok).toBe(true);
    service = new MemoryIngestService({
      db: store.db,
      logger: { warn: jest.fn() },
    });
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('auto-routes solution trace to tier3 and dedupes repeated writes', () => {
    const payload = {
      content: 'EADDRINUSE on daemon restart was fixed by clearing orphaned process state.',
      memory_class: 'solution_trace',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.92,
      source_trace: 'trace-solution-1',
      session_id: 'app-session-217',
    };

    const first = service.ingest(payload, { nowMs: 1000 });
    expect(first.ok).toBe(true);
    expect(first.routed_to_tier).toBe('tier3');
    expect(first.deduped).toBe(false);
    expect(first.result_refs).toEqual([
      expect.objectContaining({ kind: 'memory_object', tier: 'tier3' }),
    ]);

    const second = service.ingest(payload, { nowMs: 2000 });
    expect(second.ok).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.result_refs).toEqual(first.result_refs);

    const memoryCount = store.db.prepare('SELECT COUNT(*) AS count FROM memory_objects').get().count;
    const journalCount = store.db.prepare('SELECT COUNT(*) AS count FROM memory_ingest_journal').get().count;
    expect(memoryCount).toBe(1);
    expect(journalCount).toBe(2);
  });

  test('routes procedural rule to tier1 candidate queue', () => {
    const result = service.ingest({
      content: 'Use hm-send for agent-to-agent messaging.',
      memory_class: 'procedural_rule',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.88,
      source_trace: 'trace-rule-1',
      session_id: 'app-session-217',
    }, { nowMs: 5000 });

    expect(result.ok).toBe(true);
    expect(result.routed_to_tier).toBe('tier1');
    expect(result.promotion_required).toBe(true);
    expect(result.result_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'memory_object', tier: 'tier1' }),
      expect.objectContaining({ kind: 'promotion_candidate', target_file: 'workspace/knowledge/workflows.md' }),
    ]));

    const queued = store.db.prepare('SELECT * FROM memory_promotion_queue').all();
    expect(queued).toHaveLength(1);
    expect(queued[0].target_file).toBe('workspace/knowledge/workflows.md');
    expect(queued[0].review_required).toBe(1);

    const persisted = store.db.prepare('SELECT result_refs_json FROM memory_objects WHERE ingest_id = ?').get(result.ingest_id);
    expect(JSON.parse(persisted.result_refs_json)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'memory_object', tier: 'tier1' }),
      expect.objectContaining({ kind: 'promotion_candidate', target_file: 'workspace/knowledge/workflows.md' }),
    ]));
  });
});
