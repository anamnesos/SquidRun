const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
}));

jest.mock('../modules/memory-consistency-check', () => ({
  runMemoryConsistencyCheck: jest.fn(() => ({
    ok: true,
    checkedAt: '2026-03-15T00:00:00.000Z',
    status: 'in_sync',
    synced: true,
    summary: {
      knowledgeEntryCount: 15,
      knowledgeNodeCount: 15,
      missingInCognitiveCount: 0,
      orphanedNodeCount: 0,
      duplicateKnowledgeHashCount: 0,
      issueCount: 0,
    },
  })),
}));

const { execFileSync } = require('child_process');
const { runMemoryConsistencyCheck } = require('../modules/memory-consistency-check');

function createDatabase(filePath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(filePath);
  } catch (_) {
    const BetterSqlite3 = require('better-sqlite3');
    return new BetterSqlite3(filePath);
  }
}

describe('hm-health-snapshot', () => {
  let tempDir;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-health-snapshot-'));

    fs.mkdirSync(path.join(tempDir, 'ui', '__tests__'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'ui', 'modules', 'main'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'ui', 'modules', 'supervisor'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.squidrun', 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'workspace', 'memory'), { recursive: true });

    fs.writeFileSync(path.join(tempDir, 'ui', 'package.json'), '{"name":"squidrun-test"}');
    fs.writeFileSync(path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'), 'test("a", () => {});');
    fs.writeFileSync(path.join(tempDir, 'ui', '__tests__', 'beta.test.js'), 'test("b", () => {});');
    fs.writeFileSync(path.join(tempDir, 'ui', 'modules', 'recovery-manager.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, 'ui', 'modules', 'scheduler.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, 'ui', 'modules', 'main', 'background-agent-manager.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, 'ui', 'modules', 'main', 'evidence-ledger-memory.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, 'ui', 'modules', 'supervisor', 'store.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, 'ui', 'supervisor-daemon.js'), 'module.exports = {};');

    const evidenceDb = createDatabase(path.join(tempDir, '.squidrun', 'runtime', 'evidence-ledger.db'));
    evidenceDb.exec(`
      CREATE TABLE comms_journal (
        id INTEGER PRIMARY KEY,
        message TEXT
      );
      INSERT INTO comms_journal (message) VALUES ('hi'), ('there');
    `);
    evidenceDb.close();

    const cognitiveDb = createDatabase(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
    cognitiveDb.exec(`
      CREATE TABLE nodes (
        node_id TEXT PRIMARY KEY,
        content TEXT
      );
      INSERT INTO nodes (node_id, content) VALUES ('n1', 'memory');
    `);
    cognitiveDb.close();
  });

  afterEach(() => {
    jest.resetModules();
    jest.unmock('node:sqlite');
    jest.unmock('better-sqlite3');
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('builds a structured startup health snapshot', () => {
    const { createHealthSnapshot } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      nowMs: Date.parse('2026-03-17T07:45:00.000Z'),
      jestTimeoutMs: 1000,
      bridgeStatus: {
        enabled: true,
        configured: true,
        running: true,
        relayUrl: 'wss://relay.example.test',
        deviceId: 'LOCAL',
        state: 'connected',
      },
    });

    expect(snapshot.status.level).toBe('ok');
    expect(snapshot.status.label).toBe('OK');
    expect(snapshot.status.score).toBe(100);
    expect(snapshot.status.penalties).toEqual([]);
    expect(snapshot.generatedAt).toBe('2026-03-17T07:45:00.000Z');
    expect(snapshot.tests.testFileCount).toBe(2);
    expect(snapshot.tests.jestList).toEqual(expect.objectContaining({
      ok: true,
      count: 2,
    }));
    expect(snapshot.modules).toEqual(expect.objectContaining({
      moduleFileCount: expect.any(Number),
      keyModules: expect.objectContaining({
        recovery_manager: expect.objectContaining({ exists: true }),
        background_agent_manager: expect.objectContaining({ exists: true }),
        scheduler: expect.objectContaining({ exists: true }),
      }),
    }));
    expect(snapshot.databases.evidenceLedger).toEqual(expect.objectContaining({
      exists: true,
      primaryTable: 'comms_journal',
      rowCount: 2,
    }));
    expect(snapshot.databases.cognitiveMemory).toEqual(expect.objectContaining({
      exists: true,
      primaryTable: 'nodes',
      rowCount: 1,
    }));
    expect(snapshot.bridge).toEqual(expect.objectContaining({
      enabled: true,
      configured: true,
      mode: 'connected',
      running: true,
      relayUrl: 'wss://relay.example.test',
      deviceId: 'LOCAL',
      state: 'connected',
    }));
    expect(snapshot.memoryConsistency).toEqual(expect.objectContaining({
      status: 'in_sync',
      synced: true,
      summary: expect.objectContaining({
        knowledgeEntryCount: 15,
        knowledgeNodeCount: 15,
      }),
    }));
    expect(snapshot.systemCapabilities).toEqual(expect.objectContaining({
      localModels: expect.objectContaining({
        enabled: false,
      }),
    }));
    expect(runMemoryConsistencyCheck).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: tempDir,
      sampleLimit: 5,
    }));
  });

  test('normalizes ui and .squidrun roots back to the project root', () => {
    const { createHealthSnapshot, normalizeProjectRoot } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    expect(normalizeProjectRoot(path.join(tempDir, 'ui'))).toBe(tempDir);
    expect(normalizeProjectRoot(path.join(tempDir, '.squidrun'))).toBe(tempDir);

    const uiSnapshot = createHealthSnapshot({
      projectRoot: path.join(tempDir, 'ui'),
      jestTimeoutMs: 1000,
    });
    const coordSnapshot = createHealthSnapshot({
      projectRoot: path.join(tempDir, '.squidrun'),
      jestTimeoutMs: 1000,
    });

    expect(uiSnapshot.projectRoot).toBe(tempDir);
    expect(uiSnapshot.tests.testFileCount).toBe(2);
    expect(uiSnapshot.modules.moduleFileCount).toBeGreaterThan(0);
    expect(uiSnapshot.databases.evidenceLedger.exists).toBe(true);
    expect(coordSnapshot.projectRoot).toBe(tempDir);
    expect(coordSnapshot.tests.testFileCount).toBe(2);
    expect(coordSnapshot.databases.cognitiveMemory.exists).toBe(true);
  });

  test('renders a compact startup health markdown summary', () => {
    const { renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    const markdown = renderStartupHealthMarkdown({
      generatedAt: '2026-03-17T07:45:00.000Z',
      status: { level: 'ok', warnings: [] },
      tests: {
        testFileCount: 2,
        jestList: { count: 2, ok: true },
      },
      modules: {
        moduleFileCount: 6,
        keyModules: {
          recovery_manager: { exists: true },
          scheduler: { exists: true },
        },
      },
      databases: {
        evidenceLedger: { exists: true, rowCount: 2 },
        cognitiveMemory: { exists: true, rowCount: 1 },
      },
      memoryConsistency: {
        status: 'in_sync',
        synced: true,
        summary: {
          knowledgeEntryCount: 15,
          knowledgeNodeCount: 15,
          missingInCognitiveCount: 0,
          orphanedNodeCount: 0,
          duplicateKnowledgeHashCount: 0,
        },
      },
      bridge: {
        enabled: true,
        configured: true,
        mode: 'connecting',
        relayUrl: 'wss://relay.example.test',
        deviceId: 'LOCAL',
        state: 'disconnected',
      },
      systemCapabilities: {
        localModels: {
          enabled: true,
          ollama: {
            running: true,
            selectedModel: 'llama3:8b',
          },
          sleepExtraction: {
            enabled: true,
            available: true,
            model: 'claude-opus-4-6',
            path: 'anthropic-api',
          },
        },
      },
    });

    expect(markdown).toContain('STARTUP HEALTH');
    expect(markdown).toContain('Overall: OK');
    expect(markdown).toContain('Generated: 2026-03-17T07:45:00.000Z');
    expect(markdown).toContain('App Session: unknown');
    expect(markdown).toContain('Tests: 2 files, 2 Jest-discoverable suites');
    expect(markdown).toContain('Modules: 6 JS modules under ui/modules');
    expect(markdown).toContain('Evidence ledger DB: present, rows=2');
    expect(markdown).toContain('MEMORY CONSISTENCY');
    expect(markdown).toContain('Sync Status: in_sync (in sync)');
    expect(markdown).toContain('Counts: entries=15, nodes=15, missing=0, orphans=0, duplicates=0');
    expect(markdown).toContain('BRIDGE HEALTH');
    expect(markdown).toContain('Connection: disconnected');
    expect(markdown).toContain('Device ID: LOCAL');
    expect(markdown).toContain('Runtime: mode=connecting, enabled=yes, configured=yes');
    expect(markdown).toContain('LOCAL MODELS');
    expect(markdown).toContain('Feature Enabled: yes');
    expect(markdown).toContain('Selected Model: llama3:8b');
    expect(markdown).toContain('Sleep Extraction: path=anthropic-api, enabled=yes, available=yes, model=claude-opus-4-6');
  });

  test('degrades startup health when bridge is enabled but not connected', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      jestTimeoutMs: 1000,
      bridgeStatus: {
        enabled: true,
        configured: true,
        running: false,
        relayUrl: 'wss://relay.example.test',
        deviceId: 'LOCAL',
        state: 'disconnected',
        status: 'relay_disconnected',
      },
    });

    expect(snapshot.bridge.mode).toBe('connecting');
    expect(snapshot.status.level).toBe('warn');
    expect(snapshot.status.label).toBe('WARN');
    expect(snapshot.status.score).toBe(85);
    expect(snapshot.status.warnings).toContain('bridge_enabled_not_connected:disconnected');
    expect(snapshot.status.penalties).toContainEqual({ code: 'bridge_enabled_not_connected', points: 15 });
    expect(renderStartupHealthMarkdown(snapshot)).toContain('Probe: degraded (enabled but disconnected); penalty=15');
  });

  test('degrades startup health when memory consistency detects drift', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      jestTimeoutMs: 1000,
      memoryConsistency: {
        ok: true,
        checkedAt: '2026-03-15T00:00:00.000Z',
        status: 'drift_detected',
        synced: false,
        summary: {
          knowledgeEntryCount: 15,
          knowledgeNodeCount: 19,
          missingInCognitiveCount: 2,
          orphanedNodeCount: 6,
          duplicateKnowledgeHashCount: 0,
          issueCount: 0,
        },
      },
    });
    const markdown = renderStartupHealthMarkdown(snapshot);

    expect(snapshot.status.level).toBe('warn');
    expect(snapshot.status.label).toBe('WARN');
    expect(snapshot.status.warnings).toContain('memory_consistency_drift:missing=2,orphans=6,duplicates=0');
    expect(markdown).toContain('Sync Status: drift_detected (attention needed)');
    expect(markdown).toContain('Counts: entries=15, nodes=19, missing=2, orphans=6, duplicates=0');
  });

  test('exports an explicit startup health scoring contract', () => {
    const {
      HEALTH_SCORE_PENALTIES,
      HEALTH_SCORE_THRESHOLDS,
      getPenaltyPoints,
      resolveHealthThreshold,
    } = require('../scripts/hm-health-snapshot');

    expect(HEALTH_SCORE_THRESHOLDS).toEqual([
      expect.objectContaining({ minScore: 95, level: 'ok', label: 'OK' }),
      expect.objectContaining({ minScore: 80, level: 'warn', label: 'WARN' }),
      expect.objectContaining({ minScore: 60, level: 'degraded', label: 'DEGRADED' }),
      expect.objectContaining({ minScore: 0, level: 'critical', label: 'CRITICAL' }),
    ]);
    expect(HEALTH_SCORE_PENALTIES.bridge_enabled_not_connected).toEqual(expect.objectContaining({
      points: 15,
      category: 'bridge',
    }));
    expect(HEALTH_SCORE_PENALTIES.memory_consistency_drift).toEqual(expect.objectContaining({
      points: 12,
      category: 'memory_consistency',
    }));
    expect(getPenaltyPoints('missing_key_modules', { count: 2 })).toBe(8);
    expect(resolveHealthThreshold(100)).toEqual(expect.objectContaining({ label: 'OK' }));
    expect(resolveHealthThreshold(85)).toEqual(expect.objectContaining({ label: 'WARN' }));
    expect(resolveHealthThreshold(70)).toEqual(expect.objectContaining({ label: 'DEGRADED' }));
    expect(resolveHealthThreshold(20)).toEqual(expect.objectContaining({ label: 'CRITICAL' }));
  });

  test('falls back to better-sqlite3 when node:sqlite is unavailable', () => {
    jest.resetModules();

    const fakeDb = {
      close: jest.fn(),
    };
    const BetterSqlite3 = jest.fn(() => fakeDb);

    jest.doMock('node:sqlite', () => ({}), { virtual: true });
    jest.doMock('better-sqlite3', () => BetterSqlite3);

    let loadSqliteDriver;
    jest.isolateModules(() => {
      ({ loadSqliteDriver } = require('../scripts/hm-health-snapshot'));
    });

    const driver = loadSqliteDriver();
    expect(driver).toEqual(expect.objectContaining({ name: 'better-sqlite3' }));

    const db = driver.create('fallback-test.sqlite', { readonly: true });
    expect(BetterSqlite3).toHaveBeenCalledWith('fallback-test.sqlite', { readonly: true });
    db.close();
    expect(fakeDb.close).toHaveBeenCalled();
  });

  test('resolves an absolute Windows cmd path when ComSpec is unavailable', () => {
    const { resolveWindowsCmdPath } = require('../scripts/hm-health-snapshot');
    const systemRoot = path.join(tempDir, 'Windows');
    const system32 = path.join(systemRoot, 'System32');
    const cmdPath = path.join(system32, 'cmd.exe');
    fs.mkdirSync(system32, { recursive: true });
    fs.writeFileSync(cmdPath, '');

    expect(resolveWindowsCmdPath({
      SystemRoot: systemRoot,
    })).toBe(cmdPath);
  });
});
