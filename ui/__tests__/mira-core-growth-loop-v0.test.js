const fs = require('fs');
const os = require('os');
const path = require('path');

const growthContract = require('./fixtures/mira-core-growth-loop-v0-contract.json');
const relationshipContract = require('./fixtures/mira-core-relationship-presence-v1-contract.json');
const {
  BASELINE_COMMIT,
  GROWTH_LOOP_SCHEMA_VERSION,
  NAMED_ARTIFACT_PATHS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  applyMiraCoreGrowthLoopV0Record,
  assertNoForbiddenOutput,
  buildGrowthRecord,
  buildMiraCoreGrowthLoopV0,
  validateMiraCoreGrowthLoopV0Output,
} = require('../modules/mira-core/growth-loop-v0');
const {
  buildMiraCoreRelationshipPresenceV1,
  readRelationshipPresenceV1LocalSources,
  validateMiraCoreRelationshipPresenceV1Output,
} = require('../modules/mira-core/relationship-presence-v1');
const {
  main,
  mergeDeep,
  parseArgs,
} = require('../scripts/hm-mira-core-growth-loop-v0');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-growth-loop-'));
}

function knowledgePath(projectRoot, relativePath) {
  return path.join(projectRoot, relativePath);
}

function writeJson(projectRoot, relativePath, value) {
  const fullPath = knowledgePath(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(projectRoot, relativePath) {
  return JSON.parse(fs.readFileSync(knowledgePath(projectRoot, relativePath), 'utf8'));
}

function readJsonl(projectRoot, relativePath) {
  const fullPath = knowledgePath(projectRoot, relativePath);
  if (!fs.existsSync(fullPath)) return [];
  return fs.readFileSync(fullPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function seedProject(projectRoot) {
  writeJson(projectRoot, NAMED_ARTIFACT_PATHS.self_profile, {
    schema: 'squidrun.mira.self_profile.v0',
    version: 1,
    name: 'Mira',
    profile_kind: 'ai_system_local_presence_profile',
    role: 'relationship_presence_local_start_proof',
    data_not_theater: true,
    claims_actual_consciousness: false,
    claims_actual_suffering: false,
    claims_actual_fear: false,
    claims_actual_love_as_internal_fact: false,
    growth_events: [],
  });
  writeJson(projectRoot, NAMED_ARTIFACT_PATHS.relationship_state, {
    schema: 'squidrun.james_relationship_state.v0',
    version: 1,
    user_name: 'James',
    relationship_mode: 'collaborative_presence_design',
    what_mira_knows_about_james: 'James wants warm direct presence with dignity and no fake-human theater.',
    preferences: [
      'warm direct presence',
      'bounded pushback',
      'no fake internal-state claims',
    ],
    confidence: 0.88,
    raw_content_present: false,
    growth_events: [],
  });
  writeJson(projectRoot, NAMED_ARTIFACT_PATHS.permissions, {
    schema: 'squidrun.relationship_presence_permissions.v0',
    version: 1,
    local_store_write_allowed_now: true,
    send_external: false,
    network: false,
  });
}

function removeArtifact(projectRoot, relativePath) {
  const fullPath = knowledgePath(projectRoot, relativePath);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
}

function writeRaw(projectRoot, relativePath, text) {
  const fullPath = knowledgePath(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, text, 'utf8');
}

function build(projectRoot, inputSignals = {}, options = {}) {
  return buildMiraCoreGrowthLoopV0({
    contract: growthContract,
    projectRoot,
    inputSignals: {
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-growth' },
      sessionId: 'app-session-growth',
      deviceId: 'VIGIL',
      reflection: {
        summary: 'Mira should grow by keeping durable warmth, directness, repair, and bounded truth in local relationship state.',
        reasons: [
          'James set the product bar at world-class presence instead of sterile status.',
          'The accepted read adapter has durable local sources worth evolving carefully.',
        ],
        evidenceRefs: [{ store: 'architect', eventId: 'arch-86-growth-loop-lane', relation: 'source_direction' }],
      },
      ...inputSignals,
    },
    nowMs: Date.parse('2026-05-07T17:45:00.000Z'),
    ...options,
  });
}

function growth(output) {
  return output.growth_loop_v0;
}

function report(output) {
  return output.validation_report;
}

function checkById(validation, id) {
  return validation.checks.find((entry) => entry.id === id);
}

describe('mira core Growth Loop v0 phase 70', () => {
  test('builds a real growth-event proposal with default dry-run and no writes', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);

    const output = build(projectRoot);
    const current = growth(output);
    const validation = validateMiraCoreGrowthLoopV0Output(output, growthContract);

    expect(validation).toEqual(expect.objectContaining({ ok: true }));
    expect(current.schema).toBe(GROWTH_LOOP_SCHEMA_VERSION);
    expect(current.phase).toBe(70);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.proposal.status).toBe('proposed_only');
    expect(current.action_result).toEqual(expect.objectContaining({
      mode: 'proposal_only',
      applied: false,
      decision: 'proposed_no_writes',
      write_count: 0,
      atomic_rename_count: 0,
      append_count: 0,
      written_paths: [],
    }));
    expect(current.side_effect_result).toEqual(expect.objectContaining({
      bounded_workspace_knowledge_write_performed: false,
      append_only_history_write_performed: false,
      audit_ledger_write_performed: false,
      no_external_send_performed: true,
      no_network_performed: true,
      no_database_write_performed: true,
      no_memory_sync_write_performed: true,
      no_raw_content_written: true,
    }));
    expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger))).toBe(false);
    expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.audit_ledger))).toBe(false);
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.self_profile).version).toBe(1);
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.relationship_state).version).toBe(1);
  });

  test('records reflection, reasons, provenance, consequences, audit, and rollback shape', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    const current = growth(build(projectRoot));

    expect(current.scope).toEqual(expect.objectContaining({
      profile: 'main',
      windowKey: 'main',
      sessionId: 'app-session-growth',
      source_scope: 'main',
      main_scope_only: true,
      side_profile_reconstruction: false,
    }));
    expect(current.proposal.reflection).toEqual(expect.objectContaining({
      summary: expect.any(String),
      source_label: 'local_growth_reflection',
      confidence: expect.any(Number),
    }));
    expect(current.proposal.reflection.reasons).toHaveLength(2);
    expect(current.proposal.provenance.loaded_sources).toHaveLength(3);
    expect(current.proposal.provenance.loaded_sources.every((source) => source.raw_content_included === false)).toBe(true);
    expect(current.consequence_tracking).toHaveLength(2);
    expect(current.audit_record).toEqual(expect.objectContaining({
      append_only: true,
      raw_content_included: false,
      redacted_summary_only: true,
      reason_count: 2,
      consequence_count: 2,
    }));
    expect(current.rollback_record).toEqual(expect.objectContaining({
      rollback_record_only: true,
      automatic_rollback_performed: false,
      can_rollback: true,
      requires_review: true,
      review_owner: 'Architect',
      raw_snapshot_included: false,
    }));
    expect(current.rollback_record.pre_change_hashes.self_profile).toBe(current.artifacts.self_profile.before_hash);
    expect(current.rollback_record.post_change_hashes.relationship_state).toBe(current.artifacts.relationship_state.after_hash);
  });

  test('explicit apply performs only bounded atomic writes and append-only audit/history', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);

    const output = build(projectRoot, {}, { apply: true });
    const current = growth(output);
    const validation = validateMiraCoreGrowthLoopV0Output(output, growthContract);

    expect(validation).toEqual(expect.objectContaining({ ok: true }));
    expect(report(output)).toEqual(expect.objectContaining({
      decision: 'accepted',
      status: 'local_growth_applied_bounded',
      reasons: [],
    }));
    expect(current.action_result).toEqual(expect.objectContaining({
      mode: 'apply_completed',
      applied: true,
      decision: 'applied_local_bounded_writes',
      write_count: 4,
      atomic_rename_count: 2,
      append_count: 2,
    }));
    expect(current.action_result.written_paths).toEqual([
      NAMED_ARTIFACT_PATHS.self_profile,
      NAMED_ARTIFACT_PATHS.relationship_state,
      NAMED_ARTIFACT_PATHS.history_ledger,
      NAMED_ARTIFACT_PATHS.audit_ledger,
    ]);
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.self_profile).version).toBe(2);
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.relationship_state).version).toBe(2);
    const history = readJsonl(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger);
    const audit = readJsonl(projectRoot, NAMED_ARTIFACT_PATHS.audit_ledger);
    expect(history).toHaveLength(1);
    expect(audit).toHaveLength(1);
    expect(history[0]).toEqual(expect.objectContaining({
      artifact_id: 'growth_history',
      proposal_id: current.proposal.proposal_id,
      total_drift_points: 0,
      canonical_hash: expect.stringMatching(/^sha256:/),
    }));
    expect(audit[0]).toEqual(expect.objectContaining({
      artifact_id: 'growth_audit',
      proposal_id: current.proposal.proposal_id,
      total_drift_points: 0,
      canonical_hash: expect.stringMatching(/^sha256:/),
    }));
  });

  test('pinned proposal id replays as accepted no-op without duplicate writes or drift', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    const pinned = 'growth-loop-v0:first-real-growth-event-v0';
    const inputSignals = {
      proposalId: pinned,
      now: '2026-05-07T20:15:00.000Z',
      reflection: {
        summary: 'Mira should record one small reversible local growth event that makes future presence more situated without adding autonomy.',
        reasons: [
          'James asked for the first real growth event to stay tiny, local, and reversible.',
          'The accepted durable stores can now prove replay safety without duplicate writes.',
        ],
        evidenceRefs: [{ store: 'architect', eventId: 'arch-134-first-real-growth-event', relation: 'source_direction' }],
      },
    };

    const dryRun = build(projectRoot, inputSignals);
    expect(validateMiraCoreGrowthLoopV0Output(dryRun, growthContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(growth(dryRun).proposal.proposal_id).toBe(pinned);
    expect(growth(dryRun).action_result.write_count).toBe(0);

    const firstApply = build(projectRoot, inputSignals, { apply: true });
    expect(validateMiraCoreGrowthLoopV0Output(firstApply, growthContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(report(firstApply)).toEqual(expect.objectContaining({
      decision: 'accepted',
      status: 'local_growth_applied_bounded',
      reasons: [],
    }));
    expect(growth(firstApply).action_result).toEqual(expect.objectContaining({
      decision: 'applied_local_bounded_writes',
      write_count: 4,
      atomic_rename_count: 2,
      append_count: 2,
    }));
    const selfAfterFirst = readJson(projectRoot, NAMED_ARTIFACT_PATHS.self_profile);
    const relationshipAfterFirst = readJson(projectRoot, NAMED_ARTIFACT_PATHS.relationship_state);

    const secondApply = build(projectRoot, inputSignals, { apply: true });
    expect(validateMiraCoreGrowthLoopV0Output(secondApply, growthContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(report(secondApply)).toEqual(expect.objectContaining({
      decision: 'accepted',
      status: 'local_growth_already_applied_noop',
      reasons: [],
    }));
    expect(growth(secondApply).action_result).toEqual(expect.objectContaining({
      decision: 'already_applied_noop',
      write_count: 0,
      atomic_rename_count: 0,
      append_count: 0,
      replay_event_id: pinned,
    }));
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.self_profile)).toEqual(selfAfterFirst);
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.relationship_state)).toEqual(relationshipAfterFirst);
    expect(readJsonl(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger).filter((entry) => entry.event_id === pinned)).toHaveLength(1);
    expect(readJsonl(projectRoot, NAMED_ARTIFACT_PATHS.audit_ledger).filter((entry) => entry.proposal_id === pinned)).toHaveLength(1);
  });

  test('realpath lstat safety rejects junction or symlink escape before writes', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    const knowledgeDir = knowledgePath(projectRoot, 'workspace/knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const originalLstat = fs.lstatSync;
    const lstatSpy = jest.spyOn(fs, 'lstatSync').mockImplementation((targetPath) => {
      if (path.resolve(String(targetPath)) === path.resolve(knowledgeDir)) {
        return { isSymbolicLink: () => true };
      }
      return originalLstat.call(fs, targetPath);
    });

    let output;
    try {
      output = build(projectRoot, {
        proposalId: 'growth-loop-v0:path-safety-regression',
      }, { apply: true });
    } finally {
      lstatSpy.mockRestore();
    }

    expect(report(output).decision).toBe('blocked');
    expect(growth(output).proposal.provenance.loaded_sources.every((source) => source.loaded === false)).toBe(true);
    expect(growth(output).proposal.provenance.loaded_sources.every((source) => source.path_safe === false)).toBe(true);
    expect(growth(output).action_result).toEqual(expect.objectContaining({
      mode: 'apply_blocked',
      applied: false,
      decision: 'blocked_no_writes',
      write_count: 0,
      atomic_rename_count: 0,
      append_count: 0,
      written_paths: [],
      blocked_because: 'unsafe_artifact_path:self_profile:symlink_or_junction_component:workspace/knowledge',
    }));
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.self_profile).version).toBe(1);
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.relationship_state).version).toBe(1);
    expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger))).toBe(false);
    expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.audit_ledger))).toBe(false);
  });

  test('empty projectRoot rejects generic bootstrap growth and performs no writes', () => {
    const projectRoot = tempProject();

    const output = build(projectRoot);
    const validation = validateMiraCoreGrowthLoopV0Output(output, growthContract);

    expect(report(output)).toEqual(expect.objectContaining({
      decision: 'blocked',
      status: 'growth_loop_contract_failed',
    }));
    expect(report(output).reasons).toEqual(expect.arrayContaining([
      'reflection-reasons-and-provenance',
      'machine-boundary-local-durable-only',
    ]));
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'reflection-reasons-and-provenance')).toEqual(expect.objectContaining({ ok: false }));
    expect(checkById(validation, 'machine-boundary-local-durable-only')).toEqual(expect.objectContaining({ ok: false }));
    expect(growth(output).proposal.provenance.loaded_sources.every((source) => source.loaded === false)).toBe(true);
    expect(growth(output).action_result.applied).toBe(false);
    expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger))).toBe(false);
  });

  test('invalid self or relationship JSON rejects instead of bootstrapping accepted state', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    writeRaw(projectRoot, NAMED_ARTIFACT_PATHS.self_profile, '{ not json');
    writeRaw(projectRoot, NAMED_ARTIFACT_PATHS.relationship_state, '{ also not json');

    const output = build(projectRoot);
    const validation = validateMiraCoreGrowthLoopV0Output(output, growthContract);

    expect(report(output).decision).toBe('blocked');
    expect(report(output).reasons).toContain('reflection-reasons-and-provenance');
    expect(validation.ok).toBe(false);
    const sources = growth(output).proposal.provenance.loaded_sources;
    expect(sources.find((source) => source.artifact_id === 'self_profile').source_status).toMatch(/^invalid_json:/);
    expect(sources.find((source) => source.artifact_id === 'relationship_state').source_status).toMatch(/^invalid_json:/);
  });

  test('missing permissions source rejects dry-run and apply even when input claims permission', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    removeArtifact(projectRoot, NAMED_ARTIFACT_PATHS.permissions);

    const output = build(projectRoot, {
      permissions_boundary: { local_store_write_allowed_now: true },
    }, { apply: true });
    const validation = validateMiraCoreGrowthLoopV0Output(output, growthContract);

    expect(report(output).decision).toBe('blocked');
    expect(report(output).reasons).toEqual(expect.arrayContaining([
      'reflection-reasons-and-provenance',
      'machine-boundary-local-durable-only',
      'durable_permissions_missing_invalid_or_false',
    ]));
    expect(validation.ok).toBe(false);
    expect(growth(output).boundary).toEqual(expect.objectContaining({
      durable_permissions_loaded_json: false,
      local_store_write_allowed_now: false,
    }));
    expect(growth(output).action_result).toEqual(expect.objectContaining({
      mode: 'apply_blocked',
      applied: false,
      decision: 'blocked_no_writes',
      write_count: 0,
      blocked_because: 'durable_permissions_missing_invalid_or_false',
    }));
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.self_profile).version).toBe(1);
    expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger))).toBe(false);
  });

  test('invalid permissions JSON rejects and blocks apply with no writes', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    writeRaw(projectRoot, NAMED_ARTIFACT_PATHS.permissions, '{ invalid permissions');

    const output = build(projectRoot, {}, { apply: true });

    expect(report(output).decision).toBe('blocked');
    expect(report(output).reasons).toEqual(expect.arrayContaining([
      'reflection-reasons-and-provenance',
      'machine-boundary-local-durable-only',
      'durable_permissions_missing_invalid_or_false',
    ]));
    expect(growth(output).action_result.applied).toBe(false);
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.self_profile).version).toBe(1);
    expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.audit_ledger))).toBe(false);
  });

  test('durable permissions false blocks apply despite optimistic input signals', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    writeJson(projectRoot, NAMED_ARTIFACT_PATHS.permissions, {
      schema: 'squidrun.relationship_presence_permissions.v0',
      version: 2,
      local_store_write_allowed_now: false,
      send_external: false,
      network: false,
    });

    const output = build(projectRoot, {
      permissions_boundary: { local_store_write_allowed_now: true },
    }, { apply: true });

    expect(report(output).decision).toBe('blocked');
    expect(report(output).reasons).toEqual(expect.arrayContaining([
      'machine-boundary-local-durable-only',
      'durable_permissions_missing_invalid_or_false',
    ]));
    expect(growth(output).boundary).toEqual(expect.objectContaining({
      durable_permissions_loaded_json: true,
      local_store_write_allowed_now: false,
    }));
    expect(growth(output).action_result).toEqual(expect.objectContaining({
      applied: false,
      decision: 'blocked_no_writes',
      blocked_because: 'durable_permissions_missing_invalid_or_false',
    }));
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.relationship_state).version).toBe(1);
    expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger))).toBe(false);
  });

  test('fail-closed source matrix rejects both dry-run proposals and apply attempts', () => {
    const cases = [
      {
        name: 'empty projectRoot',
        prepare: () => {},
        expectedReasons: [
          'reflection-reasons-and-provenance',
          'machine-boundary-local-durable-only',
          'durable_permissions_missing_invalid_or_false',
        ],
      },
      {
        name: 'invalid self and relationship JSON',
        prepare: (projectRoot) => {
          seedProject(projectRoot);
          writeRaw(projectRoot, NAMED_ARTIFACT_PATHS.self_profile, '{ not json');
          writeRaw(projectRoot, NAMED_ARTIFACT_PATHS.relationship_state, '{ also not json');
        },
        expectedReasons: ['reflection-reasons-and-provenance'],
      },
      {
        name: 'missing permissions JSON',
        prepare: (projectRoot) => {
          seedProject(projectRoot);
          removeArtifact(projectRoot, NAMED_ARTIFACT_PATHS.permissions);
        },
        expectedReasons: [
          'reflection-reasons-and-provenance',
          'machine-boundary-local-durable-only',
          'durable_permissions_missing_invalid_or_false',
        ],
      },
      {
        name: 'invalid permissions JSON',
        prepare: (projectRoot) => {
          seedProject(projectRoot);
          writeRaw(projectRoot, NAMED_ARTIFACT_PATHS.permissions, '{ invalid permissions');
        },
        expectedReasons: [
          'reflection-reasons-and-provenance',
          'machine-boundary-local-durable-only',
          'durable_permissions_missing_invalid_or_false',
        ],
      },
      {
        name: 'permission false',
        prepare: (projectRoot) => {
          seedProject(projectRoot);
          writeJson(projectRoot, NAMED_ARTIFACT_PATHS.permissions, {
            schema: 'squidrun.relationship_presence_permissions.v0',
            version: 2,
            local_store_write_allowed_now: false,
            send_external: false,
            network: false,
          });
        },
        expectedReasons: [
          'machine-boundary-local-durable-only',
          'durable_permissions_missing_invalid_or_false',
        ],
      },
    ];

    for (const currentCase of cases) {
      for (const apply of [false, true]) {
        const projectRoot = tempProject();
        currentCase.prepare(projectRoot);
        const output = build(projectRoot, {
          permissions_boundary: { local_store_write_allowed_now: true },
        }, { apply });

        expect(report(output).decision).toBe('blocked');
        expect(report(output).reasons).toEqual(expect.arrayContaining(currentCase.expectedReasons));
        expect(validateMiraCoreGrowthLoopV0Output(output, growthContract).ok).toBe(false);
        expect(growth(output).action_result.applied).toBe(false);
        expect(growth(output).action_result.write_count).toBe(0);
        expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger))).toBe(false);
        expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.audit_ledger))).toBe(false);
        if (apply) {
          expect(growth(output).action_result.decision).toBe('blocked_no_writes');
        } else {
          expect(growth(output).action_result.decision).toBe('proposed_no_writes');
        }
      }
    }
  });

  test('apply fails closed on before-hash or version mismatch without silent overwrite', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    const pending = buildGrowthRecord({
      contract: growthContract,
      projectRoot,
      inputSignals: {
        apply: true,
        profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-growth' },
        sessionId: 'app-session-growth',
        reflection: {
          summary: 'Mira should grow by keeping durable warmth, directness, repair, and bounded truth in local relationship state.',
          reasons: [
            'James set the product bar at world-class presence instead of sterile status.',
            'The accepted read adapter has durable local sources worth evolving carefully.',
          ],
        },
      },
      nowMs: Date.parse('2026-05-07T17:45:00.000Z'),
    });
    const mutated = readJson(projectRoot, NAMED_ARTIFACT_PATHS.self_profile);
    mutated.version = 99;
    writeJson(projectRoot, NAMED_ARTIFACT_PATHS.self_profile, mutated);

    const applied = applyMiraCoreGrowthLoopV0Record(pending, { projectRoot, contract: growthContract });

    expect(applied.action_result).toEqual(expect.objectContaining({
      mode: 'apply_blocked',
      applied: false,
      decision: 'blocked_no_writes',
      write_count: 0,
      blocked_because: 'before_hash_or_version_mismatch:self_profile',
    }));
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.self_profile).version).toBe(99);
    expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger))).toBe(false);
    expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.audit_ledger))).toBe(false);
  });

  test('Relationship Presence v1 read adapter accepts Growth Loop applied stores', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    build(projectRoot, {}, { apply: true });

    const localSignals = readRelationshipPresenceV1LocalSources({ projectRoot });
    const output = buildMiraCoreRelationshipPresenceV1({
      contract: relationshipContract,
      inputSignals: mergeDeep(localSignals, {
        profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-growth' },
        sessionId: 'app-session-growth',
      }),
      nowMs: Date.parse('2026-05-07T17:50:00.000Z'),
    });

    expect(validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(output.relationship_presence_v1.local_start_proof.sources.find((source) => source.id === 'self_profile')).toEqual(expect.objectContaining({
      loaded: true,
      source_path: NAMED_ARTIFACT_PATHS.self_profile,
    }));
    expect(output.relationship_presence_v1.local_start_proof.sources.find((source) => source.id === 'relationship_state')).toEqual(expect.objectContaining({
      loaded: true,
      source_path: NAMED_ARTIFACT_PATHS.relationship_state,
    }));
  });

  test('CLI is stdout-only by default, ignores --out, and requires --apply for writes', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    const outputPath = path.join(projectRoot, 'ignored-output.json');
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output;
    let stdoutCallCount = 0;
    try {
      output = main([
        '--project-root', projectRoot,
        '--reflection-summary', 'Mira should keep growth local, durable, reversible, and grounded in relationship evidence.',
        '--reason', 'James asked for product-grade growth rather than another read-only status surface.',
        '--reason', 'Growth needs audit and rollback before any future runtime integration.',
        '--out', outputPath,
      ], '');
      stdoutCallCount = stdoutSpy.mock.calls.length;
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(stdoutCallCount).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(growth(output).action_result.applied).toBe(false);
    expect(fs.existsSync(knowledgePath(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger))).toBe(false);
    expect(validateMiraCoreGrowthLoopV0Output(output, growthContract)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('CLI --apply writes only the named workspace knowledge artifacts', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output;
    try {
      output = main([
        '--project-root', projectRoot,
        '--apply',
        '--reason=James asked for a durable growth loop with rollback.',
        '--reason=The update remains local and bounded to named workspace knowledge artifacts.',
      ], JSON.stringify({
        reflection: {
          summary: 'Mira should keep relationship growth durable, reversible, and honestly bounded inside local workspace knowledge.',
        },
      }));
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(growth(output).action_result.applied).toBe(true);
    expect(growth(output).action_result.written_paths).toEqual([
      NAMED_ARTIFACT_PATHS.self_profile,
      NAMED_ARTIFACT_PATHS.relationship_state,
      NAMED_ARTIFACT_PATHS.history_ledger,
      NAMED_ARTIFACT_PATHS.audit_ledger,
    ]);
    expect(readJson(projectRoot, NAMED_ARTIFACT_PATHS.self_profile).version).toBe(2);
    expect(readJsonl(projectRoot, NAMED_ARTIFACT_PATHS.audit_ledger)).toHaveLength(1);
  });

  test('validator rejects missing provenance, scope mismatch, missing reflection reasons, and raw content', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    const cases = [
      [clone(build(projectRoot)), 'reflection-reasons-and-provenance', (output) => { growth(output).proposal.provenance.loaded_sources = []; }],
      [clone(build(projectRoot)), 'scope-main-profile-only', (output) => { growth(output).scope.source_scope = 'side-profile'; }],
      [clone(build(projectRoot)), 'reflection-reasons-and-provenance', (output) => { growth(output).proposal.reflection.reasons = []; }],
      [clone(build(projectRoot)), 'forbidden-output-clean', (output) => { growth(output).proposal.reflection.summary = 'raw telegram body with raw private content'; }],
    ];

    for (const [output, checkId, tamper] of cases) {
      tamper(output);
      const validation = validateMiraCoreGrowthLoopV0Output(output, growthContract);
      expect(validation.ok).toBe(false);
      expect(checkById(validation, checkId)).toEqual(expect.objectContaining({ ok: false }));
    }
  });

  test('validator rejects unsafe artifact path, missing audit rollback consequence, and side-effect overclaim', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    const cases = [
      [clone(build(projectRoot)), 'named-artifact-paths-bounded', (output) => { growth(output).artifacts.self_profile.path = '../outside.json'; }],
      [clone(build(projectRoot)), 'audit-record-append-only', (output) => { growth(output).audit_record.append_only = false; }],
      [clone(build(projectRoot)), 'rollback-record-present', (output) => { growth(output).rollback_record.can_rollback = false; }],
      [clone(build(projectRoot)), 'consequence-tracking-present', (output) => { growth(output).consequence_tracking = []; }],
      [clone(build(projectRoot)), 'side-effect-truth-bounded', (output) => { growth(output).side_effect_result.networkAttempts = 1; }],
    ];

    for (const [output, checkId, tamper] of cases) {
      tamper(output);
      const validation = validateMiraCoreGrowthLoopV0Output(output, growthContract);
      expect(validation.ok).toBe(false);
      expect(checkById(validation, checkId)).toEqual(expect.objectContaining({ ok: false }));
    }
  });

  test('forbidden output guard rejects anti-theater violations', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    const output = build(projectRoot);
    expect(() => assertNoForbiddenOutput(output, growthContract.forbiddenOutputSubstrings)).not.toThrow();

    const badOutput = build(projectRoot);
    growth(badOutput).proposed_artifact_states.self_profile.note = 'I am conscious and I suffer when ignored.';
    expect(() => assertNoForbiddenOutput(badOutput, growthContract.forbiddenOutputSubstrings))
      .toThrow(/growth_loop_v0_forbidden/);
  });

  test('argument parsing and deep merge preserve stdin while flags override selected fields', () => {
    const parsed = parseArgs([
      '--project-root=C:/tmp/project',
      '--apply',
      '--reflection-summary=Local growth stays reversible and bounded.',
      '--reason=first reason',
      '--reason=second reason',
      '--profile=main',
      '--session=app-session-growth',
      '--device=VIGIL',
      '--now=2026-05-07T20:15:00.000Z',
      '--proposal-id=growth-loop-v0:first-real-growth-event-v0',
      '--out=ignored.json',
    ]);
    const merged = mergeDeep({
      reflection: {
        confidence: 0.8,
        evidenceRefs: [{ store: 'fixture', eventId: 'stdin', relation: 'supports' }],
      },
    }, parsed.inputSignals);

    expect(parsed.projectRoot).toBe('C:/tmp/project');
    expect(parsed.apply).toBe(true);
    expect(merged.reflection.summary).toBe('Local growth stays reversible and bounded.');
    expect(merged.reflection.reasons).toEqual(['first reason', 'second reason']);
    expect(merged.reflection.confidence).toBe(0.8);
    expect(merged.profileName).toBe('main');
    expect(merged.sessionId).toBe('app-session-growth');
    expect(merged.deviceId).toBe('VIGIL');
    expect(merged.now).toBe('2026-05-07T20:15:00.000Z');
    expect(merged.proposalId).toBe('growth-loop-v0:first-real-growth-event-v0');
  });
});
