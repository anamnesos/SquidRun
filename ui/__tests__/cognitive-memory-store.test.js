const fs = require('fs');
const os = require('os');
const path = require('path');

const { CognitiveMemoryStore } = require('../modules/cognitive-memory-store');
const { extractCandidates } = require('../scripts/hm-memory-extract');

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
        'James prefers direct execution over lengthy planning.',
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
        statement: 'James prefers direct execution over lengthy planning.',
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
});
