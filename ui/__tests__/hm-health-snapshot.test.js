const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
}));

const { execFileSync } = require('child_process');

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

    const cognitiveDb = createDatabase(path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db'));
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
      jestTimeoutMs: 1000,
    });

    expect(snapshot.status.level).toBe('ok');
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
    });

    expect(markdown).toContain('STARTUP HEALTH');
    expect(markdown).toContain('Tests: 2 files, 2 Jest-discoverable suites');
    expect(markdown).toContain('Modules: 6 JS modules under ui/modules');
    expect(markdown).toContain('Evidence ledger DB: present, rows=2');
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
