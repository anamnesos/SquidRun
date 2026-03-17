const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../modules/team-memory/runtime');
const { TeamMemoryStore, loadSqliteDriver } = require('../modules/team-memory/store');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

function writeProjectFixture(projectRoot) {
  const knowledgeDir = path.join(projectRoot, 'workspace', 'knowledge');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(knowledgeDir, 'user-context.md'), '# User Context\n\n');
  fs.writeFileSync(path.join(knowledgeDir, 'workflows.md'), '# Workflows\n\n');
  fs.writeFileSync(path.join(knowledgeDir, 'runtime-environment.md'), '# Runtime Environment\n\n## Shared Notes\n\n');
  fs.writeFileSync(path.join(knowledgeDir, 'infrastructure.md'), '# Infrastructure\n\n');
  fs.writeFileSync(path.join(knowledgeDir, 'projects.md'), '# Projects\n\n');
  fs.writeFileSync(path.join(projectRoot, 'ARCHITECTURE.md'), '# Architecture\n\n');
}

function initRuntime(tempDir) {
  const dbPath = path.join(tempDir, 'team-memory.sqlite');
  const init = runtime.initializeTeamMemoryRuntime({
    runtimeOptions: {
      projectRoot: tempDir,
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

maybeDescribe('memory delivery phase 4', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-memory-phase4-'));
    writeProjectFixture(tempDir);
    dbPath = initRuntime(tempDir);
  });

  afterEach(() => {
    runtime.closeSharedRuntime();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('error signature trigger injects tier3 memory with delivery metadata', () => {
    runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Minified React error #418 was fixed by forcing a fresh suspense boundary on squidrun.com.',
      memory_class: 'solution_trace',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.91,
      source_trace: 'phase4-error-match-1',
      session_id: 'sess-error',
      nowMs: 1000,
    });

    const result = runtime.executeTeamMemoryOperation('trigger-memory-injection', {
      trigger_type: 'error_signature_match',
      error_signature: 'React error #418',
      trigger_event_id: 'err-1',
      pane_id: '2',
      session_id: 'sess-error',
      session_ordinal: 5,
      nowMs: 2000,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      injected: true,
      status: 'delivered',
      injection: expect.objectContaining({
        source_tier: 'tier3',
        authoritative: false,
        reason: 'error_signature_match',
      }),
    }));
    expect(result.injection.message).toContain('[MEMORY][assistive]');
    expect(result.injection.message).toContain('error_signature_match');
    expect(result.injection.message).toContain('React error #418');

    const store = openStore(dbPath);
    const row = store.db.prepare(`
      SELECT trigger_type, memory_class, source_tier, authoritative
      FROM memory_injection_events
      WHERE trigger_event_id = 'err-1'
      LIMIT 1
    `).get();
    expect(row).toEqual(expect.objectContaining({
      trigger_type: 'error_signature_match',
      memory_class: 'solution_trace',
      source_tier: 'tier3',
      authoritative: 0,
    }));
    expect(store.db.prepare(`
      SELECT access_kind, session_ordinal
      FROM memory_access_log
      WHERE memory_id = ? 
      ORDER BY created_at DESC
      LIMIT 1
    `).get(result.injection.memory_id)).toEqual(expect.objectContaining({
      access_kind: 'retrieval',
      session_ordinal: 5,
    }));
    store.close();
  });

  test('rate limits the fourth proactive injection within ten minutes', () => {
    runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Relay reconnects cleanly after socket reset.',
      memory_class: 'solution_trace',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.88,
      source_trace: 'phase4-rate-limit-1',
      session_id: 'sess-rate-limit',
      scope: { domain: 'relay' },
      nowMs: 1000,
    });

    for (let idx = 0; idx < 3; idx += 1) {
      const result = runtime.executeTeamMemoryOperation('trigger-memory-injection', {
        trigger_type: 'task_domain_match',
        domain: 'relay',
        trigger_event_id: `rate-${idx}`,
        pane_id: '2',
        session_id: 'sess-rate-limit',
        nowMs: 2000 + idx,
      });
      expect(result.status).toBe('delivered');
    }

    const fourth = runtime.executeTeamMemoryOperation('trigger-memory-injection', {
      trigger_type: 'task_domain_match',
      domain: 'relay',
      trigger_event_id: 'rate-4',
      pane_id: '2',
      session_id: 'sess-rate-limit',
      nowMs: 2500,
    });
    expect(fourth).toEqual(expect.objectContaining({
      ok: true,
      injected: false,
      status: 'rate_limited',
    }));
  });

  test('ranks down a memory after two unreferenced injections in the same session', () => {
    const primary = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Relay reconnect fix: wait for the daemon socket backoff window.',
      memory_class: 'solution_trace',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.9,
      source_trace: 'phase4-rankdown-primary',
      session_id: 'sess-rankdown',
      scope: { domain: 'relay' },
      nowMs: 1000,
    });
    const fallback = runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Relay fallback path: use the websocket bridge when the primary socket is busy.',
      memory_class: 'solution_trace',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.78,
      source_trace: 'phase4-rankdown-fallback',
      session_id: 'sess-rankdown',
      scope: { domain: 'relay' },
      nowMs: 1100,
    });
    const primaryId = primary.result_refs.find((entry) => entry.kind === 'memory_object').id;
    const fallbackId = fallback.result_refs.find((entry) => entry.kind === 'memory_object').id;

    const first = runtime.executeTeamMemoryOperation('trigger-memory-injection', {
      trigger_type: 'task_domain_match',
      domain: 'relay',
      trigger_event_id: 'rankdown-1',
      pane_id: '2',
      session_id: 'sess-rankdown',
      nowMs: 2000,
    });
    const second = runtime.executeTeamMemoryOperation('trigger-memory-injection', {
      trigger_type: 'task_domain_match',
      domain: 'relay',
      trigger_event_id: 'rankdown-2',
      pane_id: '2',
      session_id: 'sess-rankdown',
      nowMs: 2100,
    });
    const third = runtime.executeTeamMemoryOperation('trigger-memory-injection', {
      trigger_type: 'task_domain_match',
      domain: 'relay',
      trigger_event_id: 'rankdown-3',
      pane_id: '2',
      session_id: 'sess-rankdown',
      nowMs: 2200,
    });

    expect(first.injection.memory_id).toBe(primaryId);
    expect(second.injection.memory_id).toBe(primaryId);
    expect(third.injection.memory_id).toBe(fallbackId);
    expect(third.injection.memory_id).not.toBe(primaryId);
  });

  test('builds and journals a cross-device handoff packet with expiry metadata', () => {
    const result = runtime.executeTeamMemoryOperation('build-cross-device-handoff', {
      pane_id: '1',
      session_id: 'sess-handoff',
      session_ordinal: 12,
      source_device: 'VIGIL',
      target_device: 'MACBOOK',
      active_workstreams: ['Implement Phase 4 delivery'],
      unresolved_blockers: ['Await relay ack'],
      nowMs: 5000,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      packet_id: expect.any(String),
      packet: expect.objectContaining({
        session_id: 'sess-handoff',
        source_device: 'VIGIL',
        target_device: 'MACBOOK',
        active_workstreams: ['Implement Phase 4 delivery'],
        unresolved_blockers: ['Await relay ack'],
        expires_at_session: 15,
      }),
    }));

    const store = openStore(dbPath);
    const row = store.db.prepare(`
      SELECT session_id, source_device, target_device, status, expires_at_session
      FROM memory_handoff_packets
      WHERE packet_id = ?
    `).get(result.packet_id);
    expect(row).toEqual(expect.objectContaining({
      session_id: 'sess-handoff',
      source_device: 'VIGIL',
      target_device: 'MACBOOK',
      status: 'built',
      expires_at_session: 15,
    }));
    store.close();
  });

  test('session rollover can inject startup health state memories', () => {
    runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Startup health: 194 test files, 195 Jest suites, recovery-manager and scheduler present.',
      memory_class: 'system_health_state',
      provenance: { source: 'startup-health', kind: 'observed', actor: 'system' },
      confidence: 0.58,
      source_trace: 'startup-health:rollover',
      session_id: 'sess-startup-health',
      nowMs: 8000,
    });

    const result = runtime.executeTeamMemoryOperation('trigger-memory-injection', {
      trigger_type: 'session_rollover',
      trigger_event_id: 'startup-health-rollover',
      pane_id: '2',
      session_id: 'sess-startup-health',
      nowMs: 9000,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      injected: true,
      status: 'delivered',
      injection: expect.objectContaining({
        memory_class: 'system_health_state',
      }),
    }));
    expect(result.injection.message).toContain('Startup health');
  });

  test('expired memories are excluded from delivery selection', () => {
    runtime.executeTeamMemoryOperation('ingest-memory', {
      content: 'Relay reconnect fix expired before it could help.',
      memory_class: 'solution_trace',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.95,
      source_trace: 'phase4-expired-delivery',
      session_id: 'sess-expired-delivery',
      scope: { domain: 'relay' },
      expires_at: 1500,
      nowMs: 1000,
    });

    const result = runtime.executeTeamMemoryOperation('trigger-memory-injection', {
      trigger_type: 'task_domain_match',
      domain: 'relay',
      trigger_event_id: 'expired-delivery-1',
      pane_id: '2',
      session_id: 'sess-expired-delivery',
      nowMs: 2000,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      injected: false,
      status: 'no_match',
    }));
  });

  test('prepares compaction survival and re-reads tier1 files on resume', () => {
    const prepared = runtime.executeTeamMemoryOperation('prepare-compaction-survival', {
      pane_id: '2',
      session_id: 'sess-compact',
      active_workstreams: ['Finish Phase 4'],
      unfinished_work: ['Wire relay handoff receive path'],
      unresolved_blockers: ['Need final regression run'],
      uncommitted_insights: ['Error injections should stay under 3 per 10 minutes.'],
      project_root: tempDir,
      nowMs: 6000,
    });
    expect(prepared).toEqual(expect.objectContaining({
      ok: true,
      survival_id: expect.any(String),
      tier1_snapshot: expect.arrayContaining([
        expect.objectContaining({ path: 'ARCHITECTURE.md', exists: true }),
      ]),
    }));

    fs.appendFileSync(path.join(tempDir, 'workspace', 'knowledge', 'workflows.md'), 'Phase 4 updated.\n');

    const resumed = runtime.executeTeamMemoryOperation('resume-compaction-survival', {
      pane_id: '2',
      session_id: 'sess-compact',
      project_root: tempDir,
      nowMs: 7000,
    });
    expect(resumed).toEqual(expect.objectContaining({
      ok: true,
      resumed: true,
      injection: expect.objectContaining({
        message: expect.stringContaining('[COMPACTION RESUME] Pane 2 context restored'),
      }),
    }));
    expect(resumed.injection.message).toContain('Tier 1 re-read:');

    const store = openStore(dbPath);
    const row = store.db.prepare(`
      SELECT status, tier1_snapshot_json
      FROM memory_compaction_survival
      WHERE survival_id = ?
    `).get(prepared.survival_id);
    expect(row.status).toBe('resumed');
    const snapshot = JSON.parse(row.tier1_snapshot_json);
    expect(snapshot.find((entry) => entry.path === 'workspace/knowledge/workflows.md').sha1).toBeTruthy();
    store.close();
  });
});
