const fs = require('fs');
const os = require('os');
const path = require('path');

const { TeamMemoryStore, loadSqliteDriver } = require('../modules/team-memory/store');
const { TeamMemoryClaims } = require('../modules/team-memory/claims');
const { TeamMemoryPatterns } = require('../modules/team-memory/patterns');
const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const teamMemory = require('../modules/team-memory');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

maybeDescribe('team-memory patterns module', () => {
  let tempDir;
  let dbPath;
  let ledgerDbPath;
  let spoolPath;
  let store;
  let claims;
  let patterns;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-team-patterns-'));
    dbPath = path.join(tempDir, 'team-memory.sqlite');
    ledgerDbPath = path.join(tempDir, 'evidence-ledger.db');
    spoolPath = path.join(tempDir, 'pattern-spool.jsonl');
    store = new TeamMemoryStore({ dbPath });
    expect(store.init().ok).toBe(true);
    claims = new TeamMemoryClaims(store.db);
    patterns = new TeamMemoryPatterns(store.db, { spoolPath });
  });

  afterEach(async () => {
    await teamMemory.resetForTests();
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('detects recurring failure/success patterns and tracks frequency/confidence', () => {
    claims.createClaim({
      statement: 'Triggers regression in session 401',
      claimType: 'negative',
      owner: 'analyst',
      session: 's_401',
      status: 'contested',
      scopes: ['ui/modules/triggers.js'],
      confidence: 0.9,
      nowMs: 1000,
    });
    claims.createClaim({
      statement: 'Triggers regression in session 402',
      claimType: 'negative',
      owner: 'devops',
      session: 's_402',
      status: 'contested',
      scopes: ['ui/modules/triggers.js'],
      confidence: 0.85,
      nowMs: 2000,
    });
    claims.createClaim({
      statement: 'Injection flow stable after fix',
      claimType: 'fact',
      owner: 'architect',
      session: 's_402',
      status: 'confirmed',
      scopes: ['ui/modules/injection.js'],
      confidence: 0.88,
      nowMs: 3000,
    });

    fs.writeFileSync(spoolPath, [
      JSON.stringify({ scope: 'ui/modules/triggers.js', agent: 'devops', outcome: 'failure', session: 's_402' }),
      JSON.stringify({ scope: 'ui/modules/triggers.js', agent: 'analyst', outcome: 'failure', session: 's_402' }),
      JSON.stringify({ scope: 'ui/modules/triggers.js', agent: 'architect', outcome: 'failure', session: 's_403' }),
      JSON.stringify({ scope: 'ui/modules/injection.js', agent: 'devops', outcome: 'success', session: 's_403' }),
      '',
    ].join('\n'), 'utf-8');

    const mined = patterns.processPatternSpool({ spoolPath, nowMs: 4000 });
    expect(mined.ok).toBe(true);
    expect(mined.processedEvents).toBeGreaterThanOrEqual(4);
    expect(mined.detectedPatterns).toBeGreaterThan(0);

    const failure = patterns.queryPatterns({ patternType: 'failure', scope: 'ui/modules/triggers.js' });
    expect(failure.ok).toBe(true);
    expect(failure.total).toBeGreaterThanOrEqual(1);
    expect(failure.patterns[0].frequency).toBeGreaterThan(0);
    expect(failure.patterns[0].confidence).toBeGreaterThan(0);
  });

  test('classifies actor/status task events without outcome fields', () => {
    fs.writeFileSync(spoolPath, [
      JSON.stringify({ scope: 'ui/modules/ipc/task-pool-handlers.js', actor: 'devops', status: 'failed', session: 's_601' }),
      JSON.stringify({ scope: 'ui/modules/ipc/task-pool-handlers.js', actor: 'analyst', status: 'failed', session: 's_602' }),
      JSON.stringify({ scope: 'ui/modules/ipc/task-pool-handlers.js', actor: 'architect', status: 'in_progress', session: 's_602' }),
      JSON.stringify({ scope: 'ui/modules/ipc/task-pool-handlers.js', actor: 'devops', status: 'completed', session: 's_603' }),
      JSON.stringify({ scope: 'ui/modules/ipc/task-pool-handlers.js', actor: 'analyst', status: 'completed', session: 's_603' }),
      '',
    ].join('\n'), 'utf-8');

    const mined = patterns.processPatternSpool({ spoolPath, nowMs: 5000 });
    expect(mined.ok).toBe(true);

    const failure = patterns.queryPatterns({ patternType: 'failure', scope: 'ui/modules/ipc/task-pool-handlers.js' });
    expect(failure.ok).toBe(true);
    expect(failure.total).toBeGreaterThanOrEqual(1);

    const success = patterns.queryPatterns({ patternType: 'success', scope: 'ui/modules/ipc/task-pool-handlers.js' });
    expect(success.ok).toBe(true);
    expect(success.total).toBeGreaterThanOrEqual(1);
  });

  test('keeps hook path append-only and mines only in worker/runtime operation', async () => {
    process.env.HIVEMIND_TEAM_MEMORY_FORCE_IN_PROCESS = '1';
    await teamMemory.resetForTests();

    const init = await teamMemory.initializeTeamMemoryRuntime({
      runtimeOptions: {
        storeOptions: { dbPath },
      },
      forceRuntimeRecreate: true,
    });
    expect(init.ok).toBe(true);

    const append = await teamMemory.appendPatternHookEvent({
      scope: 'ui/modules/triggers.js',
      agent: 'devops',
      outcome: 'failure',
      session: 's_501',
    }, { spoolPath, evidenceLedgerDbPath: ledgerDbPath });
    expect(append.ok).toBe(true);
    expect(append.ledger).toEqual(expect.objectContaining({ ok: true }));
    const appendSecond = await teamMemory.appendPatternHookEvent({
      scope: 'ui/modules/triggers.js',
      agent: 'analyst',
      outcome: 'failure',
      session: 's_502',
    }, { spoolPath, evidenceLedgerDbPath: ledgerDbPath });
    expect(appendSecond.ok).toBe(true);
    expect(appendSecond.ledger).toEqual(expect.objectContaining({ ok: true }));
    expect(fs.existsSync(spoolPath)).toBe(true);

    const evidenceStore = new EvidenceLedgerStore({ dbPath: ledgerDbPath });
    expect(evidenceStore.init().ok).toBe(true);
    const hookEvents = evidenceStore.queryEvents({ source: 'team-memory.pattern-hook', limit: 10 });
    expect(hookEvents.length).toBeGreaterThanOrEqual(2);
    evidenceStore.close();

    const before = await teamMemory.executeTeamMemoryOperation('query-patterns', {
      patternType: 'failure',
      scope: 'ui/modules/triggers.js',
    }, { useWorker: false });
    expect(before.ok).toBe(true);
    expect(before.total).toBe(0);

    const mined = await teamMemory.executeTeamMemoryOperation('process-pattern-spool', {
      spoolPath,
    }, { useWorker: false });
    expect(mined.ok).toBe(true);

    const after = await teamMemory.executeTeamMemoryOperation('query-patterns', {
      patternType: 'failure',
      scope: 'ui/modules/triggers.js',
    }, { useWorker: false });
    expect(after.ok).toBe(true);
    expect(after.total).toBeGreaterThanOrEqual(1);

    delete process.env.HIVEMIND_TEAM_MEMORY_FORCE_IN_PROCESS;
  });
});
