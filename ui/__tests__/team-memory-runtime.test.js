const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const runtime = require('../modules/team-memory/runtime');
const { loadSqliteDriver } = require('../modules/team-memory/store');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

maybeDescribe('team-memory runtime phase0', () => {
  let tempDir;
  let evidenceStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-team-runtime-'));
    evidenceStore = new EvidenceLedgerStore({
      dbPath: path.join(tempDir, 'evidence-ledger.db'),
      enabled: true,
    });
    expect(evidenceStore.init().ok).toBe(true);
    evidenceStore.appendBatch([
      {
        eventId: 'evt-backfill-1',
        traceId: 'trc-backfill-1',
        type: 'decision.recorded',
        stage: 'decision',
        source: 'test-suite',
        role: 'architect',
        payload: { summary: 'Use worker process for file watcher' },
      },
      {
        eventId: 'evt-backfill-2',
        traceId: 'trc-backfill-2',
        type: 'incident.created',
        stage: 'incident',
        source: 'test-suite',
        role: 'oracle',
        payload: { summary: 'Message delivery failed during reconnect' },
      },
    ]);
  });

  afterEach(() => {
    runtime.closeSharedRuntime();
    if (evidenceStore) evidenceStore.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('initializes runtime and performs idempotent backfill', () => {
    const init = runtime.initializeTeamMemoryRuntime({
      runtimeOptions: {
        storeOptions: {
          dbPath: path.join(tempDir, 'team-memory.sqlite'),
        },
      },
      forceRuntimeRecreate: true,
    });
    expect(init.ok).toBe(true);

    const first = runtime.executeTeamMemoryOperation('run-backfill', {
      evidenceLedgerDbPath: path.join(tempDir, 'evidence-ledger.db'),
      limit: 100,
    });
    expect(first.ok).toBe(true);
    expect(first.insertedClaims).toBeGreaterThan(0);
    expect(first.scannedEvents).toBeGreaterThanOrEqual(2);

    const second = runtime.executeTeamMemoryOperation('run-backfill', {
      evidenceLedgerDbPath: path.join(tempDir, 'evidence-ledger.db'),
      limit: 100,
    });
    expect(second.ok).toBe(true);
    expect(second.insertedClaims).toBe(0);
    expect(second.duplicateClaims).toBeGreaterThan(0);
  });

  test('routes search-claims action with combined filters', () => {
    const init = runtime.initializeTeamMemoryRuntime({
      runtimeOptions: {
        storeOptions: {
          dbPath: path.join(tempDir, 'team-memory.sqlite'),
        },
      },
      forceRuntimeRecreate: true,
    });
    expect(init.ok).toBe(true);

    const created = runtime.executeTeamMemoryOperation('create-claim', {
      statement: 'Trigger queue duplicate injection risk during reconnect',
      owner: 'builder',
      claimType: 'negative',
      confidence: 0.95,
      scopes: ['ui/modules/triggers.js'],
      session: 's_222',
      nowMs: 2000,
    });
    expect(created.ok).toBe(true);

    const search = runtime.executeTeamMemoryOperation('search-claims', {
      text: 'trigger queue duplicate',
      scope: 'ui/modules/triggers.js',
      claimType: 'negative',
      status: 'proposed',
      sessionsBack: 3,
      limit: 10,
    });

    expect(search.ok).toBe(true);
    expect(search.total).toBe(1);
    expect(search.claims[0].id).toBe(created.claim.id);
  });

  test('routes consensus and belief actions', () => {
    const init = runtime.initializeTeamMemoryRuntime({
      runtimeOptions: {
        storeOptions: {
          dbPath: path.join(tempDir, 'team-memory.sqlite'),
        },
      },
      forceRuntimeRecreate: true,
    });
    expect(init.ok).toBe(true);

    const created = runtime.executeTeamMemoryOperation('create-claim', {
      statement: 'Consensus runtime route test',
      owner: 'builder',
      claimType: 'fact',
      session: 's_333',
      scopes: ['ui/modules/triggers.js'],
    });
    expect(created.ok).toBe(true);

    const consensus = runtime.executeTeamMemoryOperation('record-consensus', {
      claimId: created.claim.id,
      agent: 'architect',
      position: 'agree',
      activeAgents: ['architect'],
    });
    expect(consensus.ok).toBe(true);

    const readConsensus = runtime.executeTeamMemoryOperation('get-consensus', {
      claimId: created.claim.id,
    });
    expect(readConsensus.ok).toBe(true);
    expect(readConsensus.summary.agree).toBe(1);

    const snapshot = runtime.executeTeamMemoryOperation('create-belief-snapshot', {
      agent: 'builder',
      session: 's_333',
    });
    expect(snapshot.ok).toBe(true);

    const beliefs = runtime.executeTeamMemoryOperation('get-agent-beliefs', {
      agent: 'builder',
      session: 's_333',
    });
    expect(beliefs.ok).toBe(true);
    expect(beliefs.latest).toBeTruthy();

    const contradictions = runtime.executeTeamMemoryOperation('get-contradictions', {
      agent: 'builder',
      session: 's_333',
    });
    expect(contradictions.ok).toBe(true);

    const pattern = runtime.executeTeamMemoryOperation('create-pattern', {
      patternType: 'failure',
      scope: 'ui/modules/triggers.js',
      agents: ['architect', 'builder'],
      frequency: 2,
      confidence: 0.8,
    });
    expect(pattern.ok).toBe(true);

    const readPatterns = runtime.executeTeamMemoryOperation('query-patterns', {
      patternType: 'failure',
      scope: 'ui/modules/triggers.js',
    });
    expect(readPatterns.ok).toBe(true);
    expect(readPatterns.total).toBeGreaterThanOrEqual(1);

    const deactivated = runtime.executeTeamMemoryOperation('deactivate-pattern', {
      patternId: pattern.pattern.id,
    });
    expect(deactivated.ok).toBe(true);
    expect(deactivated.pattern.active).toBe(false);

    const guard = runtime.executeTeamMemoryOperation('create-guard', {
      action: 'warn',
      triggerCondition: {
        scope: 'ui/modules/triggers.js',
        patternType: 'failure',
      },
      sourcePattern: pattern.pattern.id,
    });
    expect(guard.ok).toBe(true);

    const readGuards = runtime.executeTeamMemoryOperation('query-guards', {
      scope: 'ui/modules/triggers.js',
      active: true,
    });
    expect(readGuards.ok).toBe(true);
    expect(readGuards.total).toBeGreaterThanOrEqual(1);

    const evaluated = runtime.executeTeamMemoryOperation('evaluate-guards', {
      events: [
        {
          scope: 'ui/modules/triggers.js',
          patternType: 'failure',
          eventType: 'tool',
        },
      ],
    });
    expect(evaluated.ok).toBe(true);
    expect(evaluated.actions.length).toBeGreaterThanOrEqual(1);

    const guardDeactivated = runtime.executeTeamMemoryOperation('deactivate-guard', {
      guardId: guard.guard.id,
    });
    expect(guardDeactivated.ok).toBe(true);
    expect(guardDeactivated.guard.active).toBe(false);
  });
});
