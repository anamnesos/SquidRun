const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../modules/team-memory/runtime');
const { TeamMemoryStore, loadSqliteDriver } = require('../modules/team-memory/store');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

function writeProjectFixture(projectRoot) {
  const knowledgeDir = path.join(projectRoot, 'workspace', 'knowledge');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(knowledgeDir, 'user-context.md'), '# User Context\n\n## Observed Preferences\n\n');
  fs.writeFileSync(path.join(knowledgeDir, 'workflows.md'), '# Workflows\n\n');
  fs.writeFileSync(path.join(knowledgeDir, 'runtime-environment.md'), '# Runtime Environment\n\n## Shared Notes\n\n');
  fs.writeFileSync(path.join(projectRoot, 'ARCHITECTURE.md'), '# Architecture\n\n## Decisions\n\n');
}

function initRuntime(tempDir) {
  const dbPath = path.join(tempDir, 'team-memory.sqlite');
  const init = runtime.initializeTeamMemoryRuntime({
    runtimeOptions: {
      storeOptions: {
        dbPath,
      },
    },
    forceRuntimeRecreate: true,
  });
  expect(init.ok).toBe(true);
  return dbPath;
}

function openStore(dbPath) {
  const store = new TeamMemoryStore({ dbPath });
  expect(store.init().ok).toBe(true);
  return store;
}

maybeDescribe('memory promotion and lifecycle phase 3', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-memory-phase3-'));
    writeProjectFixture(tempDir);
    dbPath = initRuntime(tempDir);
  });

  afterEach(() => {
    runtime.closeSharedRuntime();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('ingest creates tier1 promotion candidate artifacts and approve writes knowledge file', () => {
    const ingest = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Use hm-send for agent messaging.',
      memory_class: 'procedural_rule',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.92,
      source_trace: 'phase3-promote-1',
      session_ordinal: 1,
      project_root: tempDir,
      nowMs: 1000,
    });
    expect(ingest.ok).toBe(true);
    expect(ingest.promotion_required).toBe(true);

    const store = openStore(dbPath);
    const candidate = store.db.prepare('SELECT * FROM memory_promotion_queue LIMIT 1').get();
    expect(candidate.base_sha).toBeTruthy();
    expect(candidate.patch_text).toContain('Use hm-send for agent messaging.');
    expect(candidate.target_file).toBe('workspace/knowledge/workflows.md');
    store.close();

    const approve = runtime.executeTeamMemoryOperation('approve-memory-promotion', {
      candidate_id: candidate.candidate_id,
      reviewer: 'architect',
      project_root: tempDir,
      nowMs: 1500,
    });
    expect(approve.ok).toBe(true);
    expect(approve.status).toBe('promoted');
    expect(fs.readFileSync(path.join(tempDir, 'workspace', 'knowledge', 'workflows.md'), 'utf8')).toContain('Use hm-send for agent messaging.');
  });

  test('approved correction promotions supersede the original memory', () => {
    const original = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Use hm-send for agent messaging.',
      memory_class: 'procedural_rule',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.92,
      source_trace: 'phase3-correction-original',
      session_ordinal: 1,
      project_root: tempDir,
      nowMs: 1000,
    });
    const originalMemoryId = original.result_refs.find((entry) => entry.kind === 'memory_object').id;

    let store = openStore(dbPath);
    const originalCandidate = store.db.prepare(`
      SELECT candidate_id
      FROM memory_promotion_queue
      WHERE memory_id = ?
      LIMIT 1
    `).get(originalMemoryId);
    store.close();

    const originalApprove = runtime.executeTeamMemoryOperation('approve-memory-promotion', {
      candidate_id: originalCandidate.candidate_id,
      reviewer: 'architect',
      project_root: tempDir,
      nowMs: 1500,
    });
    expect(originalApprove).toEqual(expect.objectContaining({
      ok: true,
      status: 'promoted',
      correctionApplied: false,
    }));

    const correction = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Use hm-send for all agent messaging because terminal output is not inter-agent communication.',
      memory_class: 'procedural_rule',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.96,
      source_trace: 'phase3-correction-updated',
      correction_of: originalMemoryId,
      session_ordinal: 2,
      project_root: tempDir,
      nowMs: 2000,
    });
    const correctionMemoryId = correction.result_refs.find((entry) => entry.kind === 'memory_object').id;

    store = openStore(dbPath);
    const correctionCandidate = store.db.prepare(`
      SELECT candidate_id, correction_of, supersedes
      FROM memory_promotion_queue
      WHERE memory_id = ?
      LIMIT 1
    `).get(correctionMemoryId);
    expect(correctionCandidate).toEqual(expect.objectContaining({
      correction_of: originalMemoryId,
      supersedes: null,
    }));
    store.close();

    const correctionApprove = runtime.executeTeamMemoryOperation('approve-memory-promotion', {
      candidate_id: correctionCandidate.candidate_id,
      reviewer: 'architect',
      project_root: tempDir,
      nowMs: 2500,
    });
    expect(correctionApprove).toEqual(expect.objectContaining({
      ok: true,
      status: 'promoted',
      correctionApplied: true,
      supersededMemoryId: originalMemoryId,
    }));

    const verify = openStore(dbPath);
    expect(verify.db.prepare(`
      SELECT status, lifecycle_state
      FROM memory_objects
      WHERE memory_id = ?
    `).get(originalMemoryId)).toEqual(expect.objectContaining({
      status: 'superseded',
      lifecycle_state: 'superseded',
    }));
    expect(verify.db.prepare(`
      SELECT status, lifecycle_state, correction_of, supersedes
      FROM memory_objects
      WHERE memory_id = ?
    `).get(correctionMemoryId)).toEqual(expect.objectContaining({
      status: 'active',
      lifecycle_state: 'active',
      correction_of: originalMemoryId,
      supersedes: originalMemoryId,
    }));
    verify.close();
  });

  test('reject marks promotion candidate and memory as rejected', () => {
    runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Always review ws reconnect alerts in devtools.',
      memory_class: 'procedural_rule',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.7,
      source_trace: 'phase3-reject-1',
      session_ordinal: 1,
      nowMs: 1000,
    });

    const store = openStore(dbPath);
    const candidate = store.db.prepare('SELECT candidate_id, memory_id FROM memory_promotion_queue LIMIT 1').get();
    store.close();

    const reject = runtime.executeTeamMemoryOperation('reject-memory-promotion', {
      candidate_id: candidate.candidate_id,
      reviewer: 'architect',
      nowMs: 1200,
    });
    expect(reject.ok).toBe(true);
    expect(reject.status).toBe('rejected');

    const verify = openStore(dbPath);
    expect(verify.db.prepare('SELECT status FROM memory_promotion_queue WHERE candidate_id = ?').get(candidate.candidate_id).status).toBe('rejected');
    expect(verify.db.prepare('SELECT status, lifecycle_state FROM memory_objects WHERE memory_id = ?').get(candidate.memory_id)).toEqual(
      expect.objectContaining({ status: 'rejected', lifecycle_state: 'rejected' })
    );
    verify.close();
  });

  test('lifecycle advances to stale and archived based on session ordinal', () => {
    const ingest = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Port 3001 worked for the retry path.',
      memory_class: 'solution_trace',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.85,
      source_trace: 'phase3-lifecycle-1',
      session_ordinal: 1,
      nowMs: 1000,
    });
    const memoryId = ingest.result_refs.find((entry) => entry.kind === 'memory_object').id;

    const stale = runtime.executeTeamMemoryOperation('advance-memory-lifecycle', {
      session_ordinal: 11,
      nowMs: 2000,
    });
    expect(stale.ok).toBe(true);
    expect(stale.staleCount).toBeGreaterThanOrEqual(1);

    let verify = openStore(dbPath);
    expect(verify.db.prepare('SELECT lifecycle_state FROM memory_objects WHERE memory_id = ?').get(memoryId).lifecycle_state).toBe('stale');
    verify.close();

    const archived = runtime.executeTeamMemoryOperation('advance-memory-lifecycle', {
      session_ordinal: 41,
      nowMs: 3000,
    });
    expect(archived.ok).toBe(true);
    expect(archived.archivedCount).toBeGreaterThanOrEqual(1);

    verify = openStore(dbPath);
    expect(verify.db.prepare('SELECT lifecycle_state FROM memory_objects WHERE memory_id = ?').get(memoryId).lifecycle_state).toBe('archived');
    verify.close();
  });

  test('two retrievals within five sessions reactivate stale memory', () => {
    const ingest = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Retry the daemon after clearing the stale pid file.',
      memory_class: 'solution_trace',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.9,
      source_trace: 'phase3-reactivate-1',
      session_ordinal: 1,
      nowMs: 1000,
    });
    const memoryId = ingest.result_refs.find((entry) => entry.kind === 'memory_object').id;

    runtime.executeTeamMemoryOperation('advance-memory-lifecycle', {
      session_ordinal: 11,
      nowMs: 2000,
    });
    runtime.executeTeamMemoryOperation('record-memory-access', {
      memory_id: memoryId,
      access_kind: 'retrieval',
      session_ordinal: 12,
      nowMs: 2100,
    });
    const second = runtime.executeTeamMemoryOperation('record-memory-access', {
      memory_id: memoryId,
      access_kind: 'retrieval',
      session_ordinal: 16,
      nowMs: 2200,
    });
    expect(second.ok).toBe(true);

    const verify = openStore(dbPath);
    expect(verify.db.prepare('SELECT lifecycle_state FROM memory_objects WHERE memory_id = ?').get(memoryId).lifecycle_state).toBe('active');
    verify.close();
  });

  test('single retrieval extends stale window but does not reactivate', () => {
    const ingest = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Use the backup socket during reconnect recovery.',
      memory_class: 'solution_trace',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.8,
      source_trace: 'phase3-stale-window-1',
      session_ordinal: 1,
      nowMs: 1000,
    });
    const memoryId = ingest.result_refs.find((entry) => entry.kind === 'memory_object').id;

    runtime.executeTeamMemoryOperation('advance-memory-lifecycle', {
      session_ordinal: 11,
      nowMs: 2000,
    });
    runtime.executeTeamMemoryOperation('record-memory-access', {
      memory_id: memoryId,
      access_kind: 'retrieval',
      session_ordinal: 12,
      nowMs: 2100,
    });

    const verify = openStore(dbPath);
    const row = verify.db.prepare(`
      SELECT lifecycle_state, stale_window_until_session
      FROM memory_objects
      WHERE memory_id = ?
    `).get(memoryId);
    expect(row.lifecycle_state).toBe('stale');
    expect(row.stale_window_until_session).toBe(17);
    verify.close();
  });

  test('advance-memory-lifecycle marks expired memories as expired', () => {
    const ingest = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Session-only override that should expire quickly.',
      memory_class: 'active_task_state',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.8,
      source_trace: 'phase3-expiry-1',
      session_ordinal: 1,
      expires_at: 1500,
      nowMs: 1000,
    });
    const memoryId = ingest.result_refs.find((entry) => entry.kind === 'memory_object').id;

    const advanced = runtime.executeTeamMemoryOperation('advance-memory-lifecycle', {
      session_ordinal: 2,
      nowMs: 2000,
    });

    expect(advanced).toEqual(expect.objectContaining({
      ok: true,
      expiredCount: 1,
    }));

    const verify = openStore(dbPath);
    expect(verify.db.prepare(`
      SELECT status, lifecycle_state, archived_at
      FROM memory_objects
      WHERE memory_id = ?
    `).get(memoryId)).toEqual(expect.objectContaining({
      status: 'expired',
      lifecycle_state: 'archived',
      archived_at: 2000,
    }));
    verify.close();
  });

  test('promotion conflict writes conflict artifact instead of mutating canonical file', () => {
    runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Use hm-send for critical agent routing.',
      memory_class: 'procedural_rule',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.9,
      source_trace: 'phase3-conflict-1',
      session_ordinal: 1,
      project_root: tempDir,
      nowMs: 1000,
    });

    const store = openStore(dbPath);
    const candidate = store.db.prepare('SELECT candidate_id FROM memory_promotion_queue LIMIT 1').get();
    store.close();

    fs.appendFileSync(path.join(tempDir, 'workspace', 'knowledge', 'workflows.md'), '- unrelated edit\n');

    const approve = runtime.executeTeamMemoryOperation('approve-memory-promotion', {
      candidate_id: candidate.candidate_id,
      reviewer: 'architect',
      project_root: tempDir,
      nowMs: 1500,
    });
    expect(approve.ok).toBe(true);
    expect(approve.status).toBe('conflict');
    expect(fs.existsSync(approve.conflict_artifact_path)).toBe(true);
  });

  test('direct user preference override auto-promotes and writes immediate session overlay', () => {
    const ingest = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'The user prefers concise milestone updates.',
      memory_class: 'user_preference',
      provenance: { source: 'user', kind: 'direct_user_correction', claim_type: 'direct_preference' },
      confidence: 1,
      source_trace: 'phase3-pref-override-1',
      session_ordinal: 5,
      project_root: tempDir,
      nowMs: 1000,
    });
    expect(ingest.ok).toBe(true);
    expect(ingest.auto_promoted).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, 'workspace', 'knowledge', 'user-context.md'), 'utf8')).toContain('The user prefers concise milestone updates.');

    const store = openStore(dbPath);
    expect(store.db.prepare('SELECT claim_type, status, review_required FROM memory_promotion_queue LIMIT 1').get()).toEqual(
      expect.objectContaining({ claim_type: 'preference', status: 'promoted', review_required: 0 })
    );
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM memory_objects WHERE memory_class = ?').get('active_task_state').count).toBeGreaterThanOrEqual(1);
    store.close();
  });

  test('objective fact override records a tier4 session note only', () => {
    const ingest = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'The websocket server listens on port 9999.',
      memory_class: 'architecture_decision',
      provenance: { source: 'user', kind: 'direct_user_correction', claim_type: 'objective_fact_contradiction' },
      confidence: 1,
      source_trace: 'phase3-fact-override-1',
      session_ordinal: 7,
      project_root: tempDir,
      nowMs: 1000,
    });
    expect(ingest.ok).toBe(true);
    expect(ingest.routed_to_tier).toBe('tier4');

    const store = openStore(dbPath);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM memory_promotion_queue').get().count).toBe(0);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM memory_objects WHERE tier = ?').get('tier4').count).toBeGreaterThanOrEqual(1);
    store.close();
  });

  test('operational correction from provenance claim_type stays review-required and persists canonical claim type', () => {
    const ingest = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'The reconnect script now requires a clean daemon restart.',
      memory_class: 'procedural_rule',
      provenance: { source: 'user', kind: 'direct_user_correction', claim_type: 'operational_correction' },
      confidence: 1,
      source_trace: 'phase3-operational-override-1',
      session_ordinal: 9,
      project_root: tempDir,
      nowMs: 1000,
    });
    expect(ingest.ok).toBe(true);
    expect(ingest.promotion_required).toBe(true);

    const store = openStore(dbPath);
    expect(store.db.prepare('SELECT claim_type, review_required, status FROM memory_promotion_queue LIMIT 1').get()).toEqual(
      expect.objectContaining({ claim_type: 'operational_correction', review_required: 1, status: 'pending' })
    );
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM memory_objects WHERE memory_class = ?').get('active_task_state').count).toBeGreaterThanOrEqual(1);
    store.close();
  });

  test('oracle-style provenance claim_type aliases drive override routing without kind markers', () => {
    const directPreference = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Keep updates short.',
      memory_class: 'user_preference',
      provenance: { source: 'user', claim_type: 'direct_preference' },
      confidence: 1,
      source_trace: 'oracle-alias-pref',
      project_root: tempDir,
      nowMs: 1000,
    });
    expect(directPreference.ok).toBe(true);
    expect(directPreference.auto_promoted).toBe(true);

    const objectiveFact = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Server port is 9999.',
      memory_class: 'architecture_decision',
      provenance: { source: 'user', claim_type: 'objective_fact_contradiction' },
      confidence: 1,
      source_trace: 'oracle-alias-fact',
      project_root: tempDir,
      nowMs: 1100,
    });
    expect(objectiveFact.ok).toBe(true);
    expect(objectiveFact.routed_to_tier).toBe('tier4');

    const store = openStore(dbPath);
    const candidates = store.db.prepare(`
      SELECT memory_class, claim_type, review_required, status
      FROM memory_promotion_queue
      ORDER BY created_at ASC
    `).all();
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memory_class: 'user_preference',
        claim_type: 'preference',
        review_required: 0,
        status: 'promoted',
      }),
    ]));
    expect(candidates.some((entry) => entry.claim_type === 'objective_fact')).toBe(false);
    store.close();
  });

  test('top-level claim_type directly drives review gating and objective-fact suppression', () => {
    const directPreference = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Prefer milestone-only updates.',
      memory_class: 'user_preference',
      claim_type: 'preference',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 1,
      source_trace: 'top-level-pref',
      project_root: tempDir,
      nowMs: 1200,
    });
    expect(directPreference.ok).toBe(true);
    expect(directPreference.promotion_required).toBe(false);

    const objectiveFact = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Prod websocket port is 9999.',
      memory_class: 'architecture_decision',
      claim_type: 'objective_fact',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 1,
      source_trace: 'top-level-fact',
      project_root: tempDir,
      nowMs: 1300,
    });
    expect(objectiveFact.ok).toBe(true);
    expect(objectiveFact.routed_to_tier).toBe('tier4');

    const store = openStore(dbPath);
    const objectiveFactCandidates = store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_promotion_queue
      WHERE claim_type = 'objective_fact'
    `).get();
    expect(objectiveFactCandidates.count).toBe(0);
    store.close();
  });
});
