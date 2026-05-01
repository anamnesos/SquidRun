const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { CognitiveMemoryApi } = require('../modules/cognitive-memory-api');
const { CognitiveMemoryStore } = require('../modules/cognitive-memory-store');
const { MemorySearchIndex } = require('../modules/memory-search');
const { TeamMemoryStore } = require('../modules/team-memory/store');
const { TeamMemoryClaims } = require('../modules/team-memory/claims');
const {
  SleepConsolidator,
  applyTeamMemoryAntibodyOutcomes,
  isSubstantiveTeamMemoryClaim,
  looksLikeOperationalNoiseStatement,
  runDbscan,
  syncTeamMemoryContradictionsToAntibody,
} = require('../modules/cognitive-memory-sleep');

function makeVectorForText(text) {
  const vector = new Array(384).fill(0);
  const normalized = String(text || '').toLowerCase();
  const tokens = normalized.match(/[a-z0-9_]+/g) || [];
  for (const token of tokens) {
    const slot = token.includes('plumb') ? 0
      : token.includes('supervisor') ? 1
      : token.includes('memory') ? 2
      : token.includes('workflow') ? 3
      : 4;
    vector[slot] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0)) || 1;
  return vector.map((value) => value / norm);
}

const mockEmbedder = {
  model: 'mock-mini',
  dim: 384,
  async embed(text) {
    return makeVectorForText(text);
  },
};

const maybeDescribe = (() => {
  try {
    require('sqlite-vec');
    return describe;
  } catch {
    return describe.skip;
  }
})();

maybeDescribe('cognitive-memory sleep consolidation', () => {
  let tempDir;
  let workspaceDir;
  let coordDir;
  let evidenceDbPath;
  let sessionStatePath;
  let teamMemoryDbPath;
  let memorySearchIndex;
  let cognitiveStore;
  let teamMemoryStore;
  let teamMemoryClaims;
  let api;
  let consolidator;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-sleep-cycle-'));
    workspaceDir = path.join(tempDir, 'workspace');
    coordDir = path.join(tempDir, '.squidrun', 'runtime');
    evidenceDbPath = path.join(coordDir, 'evidence-ledger.db');
    sessionStatePath = path.join(coordDir, 'session-state.json');
    teamMemoryDbPath = path.join(coordDir, 'team-memory.sqlite');
    fs.mkdirSync(path.join(workspaceDir, 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'handoffs'), { recursive: true });
    fs.mkdirSync(coordDir, { recursive: true });

    fs.writeFileSync(path.join(workspaceDir, 'knowledge', 'user-context.md'), [
      '# User Context',
      '',
      '## Active Focus Areas',
      '',
      '- the user runs a plumbing business and wants automation that actually sticks.',
      '',
      '## Observed Preferences',
      '',
      '- Prefers direct execution over lengthy planning.',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(workspaceDir, 'handoffs', 'session.md'), '# Session Handoff Index\n');

    fs.writeFileSync(sessionStatePath, JSON.stringify({
      savedAt: new Date(Date.now() - 3600000).toISOString(),
      terminals: [{ paneId: '2', lastActivity: Date.now() - 60000, lastInputTime: Date.now() - 3600000 }],
    }, null, 2));

    const evidenceDb = new DatabaseSync(evidenceDbPath);
    evidenceDb.exec(`
      CREATE TABLE comms_journal (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        session_id TEXT,
        sender_role TEXT,
        target_role TEXT,
        channel TEXT,
        direction TEXT,
        raw_body TEXT,
        sent_at_ms INTEGER,
        brokered_at_ms INTEGER,
        updated_at_ms INTEGER,
        metadata_json TEXT DEFAULT '{}'
      );
    `);
    const nowMs = Date.now();
    const insert = evidenceDb.prepare(`
      INSERT INTO comms_journal (
        message_id, session_id, sender_role, target_role, channel, direction, raw_body, sent_at_ms, brokered_at_ms, updated_at_ms, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('msg-1', 'app-session-1', 'builder', 'architect', 'ws', 'outbound', 'The supervisor memory search keeps plumbing workflow context available.', nowMs - 10000, nowMs - 9000, nowMs - 9000, '{}');
    insert.run('msg-2', 'app-session-1', 'builder', 'architect', 'ws', 'outbound', 'Plumbing business automation should stay durable through supervisor memory extraction.', nowMs - 8000, nowMs - 7000, nowMs - 7000, '{}');
    evidenceDb.close();

    memorySearchIndex = new MemorySearchIndex({
      workspaceDir,
      embedder: mockEmbedder,
    });
    await memorySearchIndex.indexAll({ force: true });

    cognitiveStore = new CognitiveMemoryStore({
      workspaceDir,
      dbPath: path.join(workspaceDir, 'memory', 'cognitive-memory.db'),
      pendingPrPath: path.join(tempDir, '.squidrun', 'memory', 'pending-pr.json'),
      allowUnscopedDbPath: true,
    });
    teamMemoryStore = new TeamMemoryStore({ dbPath: teamMemoryDbPath });
    const teamInit = teamMemoryStore.init();
    expect(teamInit.ok).toBe(true);
    teamMemoryClaims = new TeamMemoryClaims(teamMemoryStore.db);
    api = new CognitiveMemoryApi({
      cognitiveStore,
      memorySearchIndex,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    });

    consolidator = new SleepConsolidator({
      cognitiveStore,
      memorySearchIndex,
      evidenceDbPath,
      teamMemoryDbPath,
      sessionStatePath,
      extractor: async () => ([
        {
          category: 'system_state',
          domain: 'system_architecture',
          statement: 'The supervisor memory search keeps plumbing workflow context available.',
          confidence_score: 0.72,
          source_trace: 'msg-1',
          source_payload: { rowId: 1 },
        },
        {
          category: 'workflow',
          domain: 'workflows',
          statement: 'Plumbing business automation should stay durable through supervisor memory extraction.',
          confidence_score: 0.68,
          source_trace: 'msg-2',
          source_payload: { rowId: 2 },
        },
      ]),
      clusterMinPoints: 2,
      clusterEpsilon: 0.3,
      relatedDistance: 0.35,
    });
  });

  afterEach(() => {
    try { api?.close(); } catch {}
    try { consolidator?.close(); } catch {}
    try { teamMemoryStore?.close(); } catch {}
    try { cognitiveStore?.close(); } catch {}
    try { memorySearchIndex?.close(); } catch {}
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('dbscan groups nearby vectors into a cluster', () => {
    const points = [
      { index: 0, vector: makeVectorForText('supervisor memory plumbing workflow') },
      { index: 1, vector: makeVectorForText('plumbing workflow supervisor memory') },
      { index: 2, vector: makeVectorForText('calendar invite meeting notes') },
    ];

    const result = runDbscan(points, { epsilon: 0.25, minPoints: 2 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]).toHaveLength(2);
  });

  test('consolidates new episodes into staged memory PRs and advances the cursor', async () => {
    const shouldRun = consolidator.shouldRun(Date.now());
    expect(shouldRun.ok).toBe(true);

    const summary = await consolidator.runOnce();

    expect(summary.ok).toBe(true);
    expect(summary.episodeCount).toBe(2);
    expect(summary.generatedPrCount).toBeGreaterThanOrEqual(1);
    expect(consolidator.getLastProcessedRowId()).toBe(2);

    const pending = cognitiveStore.listPendingPRs({ limit: 10 });
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0]).toEqual(expect.objectContaining({ proposed_by: 'sleep-cycle' }));
  });

  test('bases idle detection on lastInputTime instead of savedAt or lastActivity', () => {
    const nowMs = Date.now();
    fs.writeFileSync(sessionStatePath, JSON.stringify({
      savedAt: new Date(nowMs).toISOString(),
      terminals: [{
        paneId: '2',
        lastActivity: nowMs,
        lastInputTime: nowMs - 3600000,
      }],
    }, null, 2));

    const snapshot = consolidator.readActivitySnapshot(nowMs);

    expect(snapshot.lastInputMs).toBe(nowMs - 3600000);
    expect(snapshot.lastActivityMs).toBe(nowMs - 3600000);
    expect(snapshot.idleMs).toBe(3600000);
    expect(snapshot.isIdle).toBe(true);
  });

  test('filters operational contradiction noise down to substantive user or agent claims', () => {
    expect(looksLikeOperationalNoiseStatement('delivered.verified')).toBe(true);
    expect(looksLikeOperationalNoiseStatement('Session started for pane 3')).toBe(true);
    expect(looksLikeOperationalNoiseStatement('The seller sent the package to Example Buyer as the user\'s test-buy alias.')).toBe(false);

    expect(isSubstantiveTeamMemoryClaim({
      owner: 'builder',
      claimType: 'fact',
      status: 'confirmed',
      statement: 'The seller sent the package to Example Buyer as the user\'s test-buy alias.',
    })).toBe(true);
    expect(isSubstantiveTeamMemoryClaim({
      owner: 'system',
      claimType: 'fact',
      status: 'confirmed',
      statement: 'delivered.verified',
    })).toBe(false);
  });

  test('queues only substantive team-memory contradictions into the antibody pipeline', async () => {
    teamMemoryClaims.createClaim({
      statement: 'delivered.verified',
      owner: 'builder',
      claimType: 'fact',
      session: 'tm-noise',
      scopes: ['delivery-status'],
    });
    teamMemoryClaims.createClaim({
      statement: 'routed_unverified_timeout',
      owner: 'builder',
      claimType: 'negative',
      session: 'tm-noise',
      scopes: ['delivery-status'],
    });
    const noisySnapshot = teamMemoryClaims.createBeliefSnapshot({
      agent: 'builder',
      session: 'tm-noise',
    });
    expect(noisySnapshot.ok).toBe(true);

    teamMemoryClaims.createClaim({
      statement: 'the user said the shipping label, invoice, and Messenger thread are all the same Example Buyer test-buy trail.',
      owner: 'builder',
      claimType: 'fact',
      session: 'tm-real',
      scopes: ['korean-fraud.purchase-trail'],
    });
    teamMemoryClaims.createClaim({
      statement: 'The shipping label belongs to a different buyer and not to the Example Buyer test buy.',
      owner: 'builder',
      claimType: 'negative',
      session: 'tm-real',
      scopes: ['korean-fraud.purchase-trail'],
    });
    const realSnapshot = teamMemoryClaims.createBeliefSnapshot({
      agent: 'builder',
      session: 'tm-real',
    });
    expect(realSnapshot.ok).toBe(true);

    const summary = await syncTeamMemoryContradictionsToAntibody({
      api,
      teamMemoryStore,
      teamMemoryClaims,
      limit: 20,
    });

    expect(summary).toEqual(expect.objectContaining({
      ok: true,
      scanned: expect.any(Number),
      filteredNoise: expect.any(Number),
      queued: expect.any(Number),
    }));
    expect(summary.filteredNoise).toBeGreaterThanOrEqual(1);
    expect(summary.queueIds).toHaveLength(1);

    const queueItem = cognitiveStore.getAntibodyQueueItem(summary.queueIds[0]);
    const payload = JSON.parse(queueItem.payload_json || '{}');
    expect(queueItem.request_type).toBe('team_memory_contradiction');
    expect(payload).toEqual(expect.objectContaining({
      source: 'team-memory-contradiction',
      contradictionId: expect.any(String),
    }));
  });

  test('applies completed antibody coexistence outcomes back into team memory contradictions', async () => {
    const baseline = teamMemoryClaims.createClaim({
      statement: 'The scoped routing thesis is still active and should remain open.',
      owner: 'builder',
      claimType: 'fact',
      session: 'tm-resolution',
      scopes: ['runtime.scoped-routing'],
    }).claim;
    const correction = teamMemoryClaims.createClaim({
      statement: 'The scoped routing thesis is no longer active and should be closed.',
      owner: 'builder',
      claimType: 'negative',
      session: 'tm-resolution',
      scopes: ['runtime.scoped-routing'],
    }).claim;
    const snapshot = teamMemoryClaims.createBeliefSnapshot({
      agent: 'builder',
      session: 'tm-resolution',
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.contradictions.inserted).toBeGreaterThanOrEqual(1);

    const queued = await syncTeamMemoryContradictionsToAntibody({
      api,
      teamMemoryStore,
      teamMemoryClaims,
      limit: 20,
    });
    expect(queued.queueIds).toHaveLength(1);

    const queueId = queued.queueIds[0];
    const queueItem = cognitiveStore.getAntibodyQueueItem(queueId);
    const payload = JSON.parse(queueItem.payload_json || '{}');
    expect(payload.autoDecision).toBe(null);

    const updated = cognitiveStore.updateAntibodyJob(queueId, {
      status: 'completed',
      result: {
        consensus: {
          status: 'coexistence',
        },
      },
    });
    expect(updated.ok).toBe(true);

    const resolution = applyTeamMemoryAntibodyOutcomes({
      api,
      cognitiveStore,
      teamMemoryStore,
      teamMemoryClaims,
      queueIds: [queueId],
    });
    expect(resolution).toEqual(expect.objectContaining({
      ok: true,
      resolved: 1,
    }));

    const baselineAfter = teamMemoryClaims.getClaim(baseline.id);
    expect(baselineAfter.status).toBe('proposed');

    const activeAfter = teamMemoryClaims.getContradictions({
      session: 'tm-resolution',
      activeOnly: true,
    });
    expect(activeAfter.total).toBe(0);

    const completed = cognitiveStore.getAntibodyQueueItem(queueId);
    const completedResult = JSON.parse(completed.result_json || '{}');
    expect(completedResult.teamMemoryResolution).toEqual(expect.objectContaining({
      action: 'coexistence',
    }));
    expect(correction).toBeDefined();
  });
});
