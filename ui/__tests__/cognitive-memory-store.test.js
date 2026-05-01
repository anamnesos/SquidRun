const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CognitiveMemoryStore,
  resolveDefaultCognitiveMemoryDbPath,
  resolveDefaultPendingPrPath,
} = require('../modules/cognitive-memory-store');
const { collectTextFragments, extractCandidates } = require('../scripts/hm-memory-extract');

describe('cognitive-memory store and extraction', () => {
  let tempDir;
  let workspaceDir;
  let pendingPrPath;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-cogmem-'));
    workspaceDir = path.join(tempDir, 'workspace');
    pendingPrPath = path.join(tempDir, '.squidrun', 'memory', 'pending-pr.json');
    fs.mkdirSync(workspaceDir, { recursive: true });
    store = new CognitiveMemoryStore({
      workspaceDir,
      pendingPrPath,
      dbPath: path.join(workspaceDir, 'memory', 'cognitive-memory.db'),
      allowUnscopedDbPath: true,
    });
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('extractCandidates classifies useful facts from hook payloads', () => {
    const candidates = extractCandidates({
      session_id: 'session-1',
      transcript: [
        'The user prefers direct execution over lengthy planning.',
        'The supervisor watcher should keep the memory index fresh.',
      ],
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'preference', domain: 'user_preferences' }),
      expect.objectContaining({ category: 'system_state', domain: 'system_architecture' }),
    ]));
  });

  test('stages pending PRs and mirrors them to pending-pr.json', () => {
    const result = store.stageMemoryPRs([
      {
        category: 'preference',
        statement: 'The user prefers direct execution over lengthy planning.',
        confidence_score: 0.72,
        source_trace: 'session-1:0',
        proposed_by: 'precompact-hook',
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.staged).toHaveLength(1);
    expect(fs.existsSync(pendingPrPath)).toBe(true);

    const payload = JSON.parse(fs.readFileSync(pendingPrPath, 'utf8'));
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toEqual(expect.objectContaining({
      category: 'preference',
      confidence_score: 0.72,
      review_count: 0,
    }));
  });

  test('defaults cognitive memory DB to the profile-scoped runtime path', () => {
    const mainPath = resolveDefaultCognitiveMemoryDbPath({
      projectRoot: tempDir,
      profileName: 'main',
    });
    const scopedPath = resolveDefaultCognitiveMemoryDbPath({
      projectRoot: tempDir,
      profileName: 'scoped',
    });

    expect(mainPath).toBe(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
    expect(scopedPath).toBe(path.join(tempDir, '.squidrun', 'runtime-scoped', 'cognitive-memory.db'));
    expect(resolveDefaultPendingPrPath({
      projectRoot: tempDir,
      profileName: 'scoped',
    })).toBe(path.join(tempDir, '.squidrun', 'memory-scoped', 'pending-pr.json'));
  });

  test('blocks mutating writes to unscoped legacy DB paths unless explicitly allowed', () => {
    const unsafeStore = new CognitiveMemoryStore({
      projectRoot: tempDir,
      profileName: 'scoped',
      dbPath: path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db'),
      pendingPrPath,
    });

    expect(() => unsafeStore.stageMemoryPRs([
      { category: 'fact', statement: 'unsafe write should not land' },
    ])).toThrow(/not profile-scoped/);
    unsafeStore.close();
  });

  test('seeds the main runtime DB from a non-empty legacy cognitive DB once', () => {
    const legacyDbPath = path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db');
    const legacyStore = new CognitiveMemoryStore({
      projectRoot: tempDir,
      profileName: 'main',
      dbPath: legacyDbPath,
      pendingPrPath,
      allowUnscopedDbPath: true,
    });
    legacyStore.stageMemoryPRs([
      {
        category: 'fact',
        statement: 'legacy cognitive memory should seed runtime once.',
      },
    ]);
    legacyStore.close();

    const runtimeStore = new CognitiveMemoryStore({
      projectRoot: tempDir,
      profileName: 'main',
    });
    const pending = runtimeStore.listPendingPRs({ limit: 10 });
    expect(runtimeStore.dbPath).toBe(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ statement: 'legacy cognitive memory should seed runtime once.' }),
    ]));
    runtimeStore.close();
  });

  test('keeps main and Scoped cognitive writes in separate runtime DBs', () => {
    const mainStore = new CognitiveMemoryStore({
      projectRoot: tempDir,
      profileName: 'main',
    });
    const scopedStore = new CognitiveMemoryStore({
      projectRoot: tempDir,
      profileName: 'scoped',
    });

    mainStore.stageMemoryPRs([
      { category: 'fact', statement: 'main memory stays in main runtime.' },
    ]);
    scopedStore.stageMemoryPRs([
      { category: 'fact', statement: 'scoped memory stays in scoped runtime.' },
    ]);

    expect(mainStore.dbPath).toBe(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
    expect(scopedStore.dbPath).toBe(path.join(tempDir, '.squidrun', 'runtime-scoped', 'cognitive-memory.db'));
    expect(mainStore.pendingPrPath).toBe(path.join(tempDir, '.squidrun', 'memory', 'pending-pr.json'));
    expect(scopedStore.pendingPrPath).toBe(path.join(tempDir, '.squidrun', 'memory-scoped', 'pending-pr.json'));
    expect(mainStore.listPendingPRs({ limit: 10 }).map((row) => row.statement)).toEqual([
      'main memory stays in main runtime.',
    ]);
    expect(scopedStore.listPendingPRs({ limit: 10 }).map((row) => row.statement)).toEqual([
      'scoped memory stays in scoped runtime.',
    ]);

    mainStore.close();
    scopedStore.close();
  });

  test('rebuilds a zero-byte main runtime DB from the legacy seed', () => {
    const legacyDbPath = path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db');
    const runtimeDbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
    const legacyStore = new CognitiveMemoryStore({
      projectRoot: tempDir,
      profileName: 'main',
      dbPath: legacyDbPath,
      pendingPrPath,
      allowUnscopedDbPath: true,
    });
    legacyStore.stageMemoryPRs([
      {
        category: 'fact',
        statement: 'zero byte runtime DB should rebuild from this seed.',
      },
    ]);
    legacyStore.close();

    fs.mkdirSync(path.dirname(runtimeDbPath), { recursive: true });
    fs.writeFileSync(runtimeDbPath, '');
    expect(fs.statSync(runtimeDbPath).size).toBe(0);

    const runtimeStore = new CognitiveMemoryStore({
      projectRoot: tempDir,
      profileName: 'main',
    });
    const rows = runtimeStore.listPendingPRs({ limit: 10 });

    expect(fs.statSync(runtimeDbPath).size).toBeGreaterThan(0);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ statement: 'zero byte runtime DB should rebuild from this seed.' }),
    ]));
    runtimeStore.close();
  });

  test('records and updates transactive expertise', () => {
    const first = store.recordTransactiveUse({
      domain: 'service titan api',
      agent_id: 'builder',
      pane_id: '2',
      expertise_delta: 0.2,
    });
    const second = store.recordTransactiveUse({
      domain: 'service titan api',
      agent_id: 'builder',
      pane_id: '2',
      expertise_delta: 0.15,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const rows = store.listTransactiveMeta({ limit: 10 });
    expect(rows[0]).toEqual(expect.objectContaining({
      domain: 'service titan api',
      primary_agent_id: 'builder',
      proof_count: 2,
    }));
    expect(Number(rows[0].expertise_score)).toBeCloseTo(0.35, 5);
  });

  test('collectTextFragments chunks long strings with overlap so phrases survive boundaries', () => {
    const keyPhrase = 'prefers direct execution over lengthy planning';
    const fragments = collectTextFragments({
      transcript: `${'filler '.repeat(170)} ${keyPhrase} ${'tail '.repeat(170)}`,
    });

    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.some((fragment) => fragment.includes(keyPhrase))).toBe(true);
  });
});
