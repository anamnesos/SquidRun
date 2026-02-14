const fs = require('fs');
const os = require('os');
const path = require('path');

const { TeamMemoryStore, loadSqliteDriver } = require('../modules/team-memory/store');
const { TeamMemoryClaims } = require('../modules/team-memory/claims');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

maybeDescribe('team-memory claims module', () => {
  let tempDir;
  let store;
  let claims;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-team-claims-'));
    store = new TeamMemoryStore({
      dbPath: path.join(tempDir, 'team-memory.sqlite'),
    });
    expect(store.init().ok).toBe(true);
    claims = new TeamMemoryClaims(store.db);
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('creates and queries claims by scope/type/status/owner/session', () => {
    const created = claims.createClaim({
      statement: 'Avoid retry storms during reconnect windows',
      claimType: 'negative',
      owner: 'devops',
      session: 's_121',
      scopes: ['ui/modules/websocket-runtime.js', 'comms'],
    });

    expect(created.ok).toBe(true);
    expect(created.status).toBe('created');
    expect(created.claim.claimType).toBe('negative');
    expect(created.claim.scopes).toEqual(expect.arrayContaining(['ui/modules/websocket-runtime.js']));

    const result = claims.queryClaims({
      scope: 'ui/modules/websocket-runtime.js',
      claimType: 'negative',
      status: 'proposed',
      owner: 'devops',
      session: 's_121',
    });

    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.claims[0].id).toBe(created.claim.id);
  });

  test('enforces idempotency key dedup on createClaim', () => {
    const first = claims.createClaim({
      statement: 'First write wins',
      claimType: 'fact',
      owner: 'architect',
      idempotencyKey: 'claim:create:dedup-1',
    });
    const second = claims.createClaim({
      statement: 'Second write should dedup',
      claimType: 'fact',
      owner: 'architect',
      idempotencyKey: 'claim:create:dedup-1',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.status).toBe('duplicate');
    expect(second.claim.id).toBe(first.claim.id);
    expect(claims.queryClaims({ limit: 10 }).total).toBe(1);
  });

  test('enforces claim status state-machine transitions', () => {
    const created = claims.createClaim({
      statement: 'State machine test claim',
      owner: 'devops',
    });
    const claimId = created.claim.id;

    const valid = claims.updateClaimStatus(claimId, 'confirmed', 'architect', 'supported by trace');
    expect(valid.ok).toBe(true);
    expect(valid.claim.status).toBe('confirmed');

    const contested = claims.updateClaimStatus(claimId, 'contested', 'analyst', 'regression detected');
    expect(contested.ok).toBe(true);
    expect(contested.claim.status).toBe('contested');

    const pendingProof = claims.updateClaimStatus(
      claimId,
      'pending_proof',
      'devops',
      'guard queued experiment'
    );
    expect(pendingProof.ok).toBe(true);
    expect(pendingProof.claim.status).toBe('pending_proof');

    const resolved = claims.updateClaimStatus(
      claimId,
      'confirmed',
      'devops',
      'experiment succeeded'
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.claim.status).toBe('confirmed');

    const invalid = claims.updateClaimStatus(claimId, 'proposed', 'architect', 'cannot revert');
    expect(invalid.ok).toBe(false);
    expect(invalid.reason).toBe('invalid_transition');

    const deprecated = claims.deprecateClaim(claimId, 'architect', 'superseded');
    expect(deprecated.ok).toBe(true);
    expect(deprecated.claim.status).toBe('deprecated');

    const impossible = claims.updateClaimStatus(claimId, 'confirmed', 'architect', 'terminal state');
    expect(impossible.ok).toBe(false);
    expect(impossible.reason).toBe('invalid_transition');
  });

  test('binds evidence with added_by attribution', () => {
    const created = claims.createClaim({
      statement: 'Evidence binding claim',
      owner: 'analyst',
    });

    const bind = claims.addEvidence(
      created.claim.id,
      'evt-proof-123',
      'supports',
      { addedBy: 'devops', weight: 0.8 }
    );

    expect(bind.ok).toBe(true);
    expect(bind.status).toBe('added');
    expect(bind.claim.evidence).toEqual([
      expect.objectContaining({
        evidenceRef: 'evt-proof-123',
        addedBy: 'devops',
        relation: 'supports',
      }),
    ]);
  });

  test('creates decision lineage and records outcomes', () => {
    const chosen = claims.createClaim({
      statement: 'Use worker process for watcher isolation',
      claimType: 'decision',
      owner: 'devops',
    }).claim;
    const alternative = claims.createClaim({
      statement: 'Keep watcher in main thread',
      claimType: 'hypothesis',
      owner: 'devops',
    }).claim;

    const decision = claims.createDecision({
      claimId: chosen.id,
      decidedBy: 'architect',
      context: 'Process isolation phase planning',
      rationale: 'Reduce main-thread IO pressure',
      alternatives: [
        { claimId: alternative.id, rejectionReason: 'higher latency risk' },
      ],
      session: 's_122',
    });

    expect(decision.ok).toBe(true);
    expect(decision.decision.decidedBy).toBe('architect');
    expect(decision.decision.alternatives).toEqual([
      { claimId: alternative.id, rejectionReason: 'higher latency risk' },
    ]);

    const outcome = claims.recordOutcome(decision.decision.id, 'success', 'No regressions in smoke tests');
    expect(outcome.ok).toBe(true);
    expect(outcome.decision.outcome).toBe('success');
    expect(outcome.decision.outcomeNotes).toBe('No regressions in smoke tests');
  });

  test('supports combined retrieval filters with confidence-weighted search ranking', () => {
    const scope = 'ui/modules/triggers.js';
    claims.createClaim({
      statement: 'Trigger queue must avoid duplicate injection during reconnect',
      claimType: 'negative',
      owner: 'devops',
      confidence: 0.35,
      session: 's_220',
      scopes: [scope],
      nowMs: 1000,
    });
    claims.createClaim({
      statement: 'Trigger queue duplicate injection was fixed with delivery check',
      claimType: 'negative',
      owner: 'devops',
      confidence: 0.92,
      session: 's_220',
      scopes: [scope],
      nowMs: 1001,
    });
    claims.createClaim({
      statement: 'Watcher worker restart policy',
      claimType: 'fact',
      owner: 'devops',
      confidence: 0.99,
      session: 's_220',
      scopes: ['ui/modules/watcher.js'],
      nowMs: 1002,
    });

    const result = claims.searchClaims({
      text: 'trigger queue duplicate',
      scope,
      claimType: 'negative',
      status: 'proposed',
      session: 's_220',
    });

    expect(result.ok).toBe(true);
    expect(result.total).toBe(2);
    expect(result.claims[0].confidence).toBeGreaterThanOrEqual(result.claims[1].confidence);
    expect(result.claims.every((claim) => claim.scopes.includes(scope))).toBe(true);
    expect(result.claims.every((claim) => claim.claimType === 'negative')).toBe(true);
  });

  test('supports temporal retrieval using last N sessions', () => {
    claims.createClaim({
      statement: 'old session claim',
      owner: 'devops',
      session: 's_100',
      nowMs: 1000,
    });
    claims.createClaim({
      statement: 'session 101 claim',
      owner: 'devops',
      session: 's_101',
      nowMs: 2000,
    });
    claims.createClaim({
      statement: 'session 102 claim',
      owner: 'devops',
      session: 's_102',
      nowMs: 3000,
    });
    claims.createClaim({
      statement: 'session 103 claim',
      owner: 'devops',
      session: 's_103',
      nowMs: 4000,
    });

    const result = claims.queryClaims({
      sessionsBack: 3,
      order: 'desc',
    });

    expect(result.ok).toBe(true);
    expect(result.total).toBe(3);
    const sessions = new Set(result.claims.map((claim) => claim.session));
    expect(sessions.has('s_101')).toBe(true);
    expect(sessions.has('s_102')).toBe(true);
    expect(sessions.has('s_103')).toBe(true);
    expect(sessions.has('s_100')).toBe(false);
  });

  test('records consensus and auto-promotes when all active agents agree', () => {
    const created = claims.createClaim({
      statement: 'Enable comms worker recovery backoff',
      owner: 'devops',
      status: 'proposed',
      session: 's_300',
      scopes: ['ui/modules/comms-worker-client.js'],
    });
    const claimId = created.claim.id;

    const first = claims.recordConsensus({
      claimId,
      agent: 'architect',
      position: 'agree',
      reason: 'reviewed',
      activeAgents: ['architect', 'devops', 'analyst'],
    });
    expect(first.ok).toBe(true);
    expect(first.claim.status).toBe('proposed');

    claims.recordConsensus({
      claimId,
      agent: 'devops',
      position: 'agree',
      activeAgents: ['architect', 'devops', 'analyst'],
    });
    const third = claims.recordConsensus({
      claimId,
      agent: 'analyst',
      position: 'agree',
      activeAgents: ['architect', 'devops', 'analyst'],
    });

    expect(third.ok).toBe(true);
    expect(third.claim.status).toBe('confirmed');
    expect(third.statusUpdate?.ok).toBe(true);
  });

  test('auto-contests claim when any agent disagrees', () => {
    const created = claims.createClaim({
      statement: 'Use strict submit verification',
      owner: 'devops',
      status: 'proposed',
      scopes: ['ui/modules/injection.js'],
    });
    const claimId = created.claim.id;

    claims.recordConsensus({
      claimId,
      agent: 'architect',
      position: 'agree',
      activeAgents: ['architect', 'devops', 'analyst'],
    });
    claims.recordConsensus({
      claimId,
      agent: 'devops',
      position: 'agree',
      activeAgents: ['architect', 'devops', 'analyst'],
    });
    claims.recordConsensus({
      claimId,
      agent: 'analyst',
      position: 'agree',
      activeAgents: ['architect', 'devops', 'analyst'],
    });
    expect(claims.getClaim(claimId).status).toBe('confirmed');

    const disagree = claims.recordConsensus({
      claimId,
      agent: 'analyst',
      position: 'disagree',
      reason: 'new regression trace',
      activeAgents: ['architect', 'devops', 'analyst'],
    });
    expect(disagree.ok).toBe(true);
    expect(disagree.claim.status).toBe('contested');

    const consensus = claims.getConsensus(claimId);
    expect(consensus.ok).toBe(true);
    expect(consensus.summary.disagree).toBe(1);
  });

  test('creates belief snapshots and detects normalized contradictions', () => {
    const positive = claims.createClaim({
      statement: 'Inject startup prompt into pane 1',
      owner: 'analyst',
      claimType: 'fact',
      confidence: 0.9,
      session: 's_301',
      scopes: ['ui/modules/injection.js'],
    }).claim;
    const negative = claims.createClaim({
      statement: 'Do not inject startup prompt into pane 1 on light restart',
      owner: 'analyst',
      claimType: 'negative',
      confidence: 0.8,
      session: 's_301',
      scopes: ['ui/modules/injection.js'],
    }).claim;

    expect(positive).toBeDefined();
    expect(negative).toBeDefined();

    const snapshot = claims.createBeliefSnapshot({
      agent: 'analyst',
      session: 's_301',
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.snapshot.agent).toBe('analyst');
    expect(snapshot.snapshot.beliefs.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.contradictions.count).toBeGreaterThanOrEqual(1);

    const beliefs = claims.getAgentBeliefs({ agent: 'analyst', session: 's_301' });
    expect(beliefs.ok).toBe(true);
    expect(beliefs.latest).toBeTruthy();
    expect(Array.isArray(beliefs.latest.beliefs)).toBe(true);

    const contradictions = claims.getContradictions({ agent: 'analyst', session: 's_301' });
    expect(contradictions.ok).toBe(true);
    expect(contradictions.total).toBeGreaterThanOrEqual(1);
    expect(contradictions.contradictions[0]).toEqual(
      expect.objectContaining({
        agent: 'analyst',
        session: 's_301',
      })
    );
  });
});
