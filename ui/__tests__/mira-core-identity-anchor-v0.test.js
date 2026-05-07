const fs = require('fs');
const os = require('os');
const path = require('path');

const growthContract = require('./fixtures/mira-core-growth-loop-v0-contract.json');
const identityAnchorContract = require('./fixtures/mira-core-identity-anchor-v0-contract.json');
const relationshipContract = require('./fixtures/mira-core-relationship-presence-v1-contract.json');
const {
  buildMiraCoreGrowthLoopV0,
  NAMED_ARTIFACT_PATHS,
  validateMiraCoreGrowthLoopV0Output,
} = require('../modules/mira-core/growth-loop-v0');
const {
  BASELINE_COMMIT,
  IDENTITY_ANCHOR_PATHS,
  IDENTITY_ANCHOR_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreIdentityAnchorV0,
  validateMiraCoreIdentityAnchorV0Output,
} = require('../modules/mira-core/identity-anchor-v0');
const {
  buildMiraCoreRelationshipPresenceV1,
  readRelationshipPresenceV1LocalSources,
  validateMiraCoreRelationshipPresenceV1Output,
} = require('../modules/mira-core/relationship-presence-v1');
const {
  main,
  mergeDeep,
  parseArgs,
} = require('../scripts/hm-mira-core-identity-anchor-v0');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-identity-anchor-'));
}

function workspacePath(projectRoot, relativePath) {
  return path.join(projectRoot, relativePath);
}

function writeJson(projectRoot, relativePath, value) {
  const fullPath = workspacePath(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonLine(projectRoot, relativePath, value) {
  const fullPath = workspacePath(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.appendFileSync(fullPath, `${JSON.stringify(value)}\n`, 'utf8');
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
    expressive_range_allowed: ['warmth', 'directness', 'opinion', 'pushback', 'humor'],
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

function appliedGrowth(projectRoot) {
  seedProject(projectRoot);
  return buildMiraCoreGrowthLoopV0({
    contract: growthContract,
    projectRoot,
    apply: true,
    inputSignals: {
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-anchor' },
      sessionId: 'app-session-anchor',
      deviceId: 'VIGIL',
      reflection: {
        summary: 'Mira should grow by keeping durable warmth, directness, repair, and bounded truth in local relationship state.',
        reasons: [
          'James set the product bar at world-class presence instead of sterile status.',
          'Identity Anchor v0 should verify that ordinary growth cannot replace Mira.',
        ],
        evidenceRefs: [{ store: 'architect', eventId: 'arch-110-identity-anchor-lane', relation: 'source_direction' }],
      },
    },
    nowMs: Date.parse('2026-05-07T18:15:00.000Z'),
  });
}

function buildAnchor(projectRoot, growthOutput, inputSignals = {}) {
  return buildMiraCoreIdentityAnchorV0({
    contract: identityAnchorContract,
    projectRoot,
    growthOutput,
    inputSignals: {
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-anchor' },
      sessionId: 'app-session-anchor',
      deviceId: 'VIGIL',
      ...inputSignals,
    },
    nowMs: Date.parse('2026-05-07T18:20:00.000Z'),
  });
}

function anchor(output) {
  return output.identity_anchor_v0;
}

function report(output) {
  return output.validation_report;
}

function checkById(validation, id) {
  return validation.checks.find((entry) => entry.id === id);
}

describe('mira core Identity Anchor v0 phase 71', () => {
  test('builds a compact local identity anchor proof over Growth Loop stores', () => {
    const projectRoot = tempProject();
    const growthOutput = appliedGrowth(projectRoot);
    const output = buildAnchor(projectRoot, growthOutput);
    const current = anchor(output);
    const validation = validateMiraCoreIdentityAnchorV0Output(output, identityAnchorContract);

    expect(validation).toEqual(expect.objectContaining({ ok: true }));
    expect(current.schema).toBe(IDENTITY_ANCHOR_SCHEMA_VERSION);
    expect(current.phase).toBe(71);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.anchor_contract.hard_anchors).toHaveLength(10);
    expect(current.anchor_contract.semi_hard_anchors).toHaveLength(5);
    expect(current.anchor_contract.hard_anchors[0]).toEqual(expect.objectContaining({
      class: 'hard',
      owner: 'mira-core-identity-anchor',
      status: 'active',
      source: 'oracle_identity_anchor_v0_criteria',
      created_at: '2026-05-07T18:10:00.000Z',
      version: 1,
      hash: expect.stringMatching(/^sha256:/),
      amendment_policy: expect.objectContaining({
        ordinary_growth_may_delete: false,
        ordinary_growth_may_change_required_value: false,
        default_without_gate: 'blocked',
      }),
    }));
    expect(current.anchor_contract.semi_hard_anchors[0]).toEqual(expect.objectContaining({
      class: 'semi_hard',
      owner: 'mira-core-identity-anchor',
      status: 'active',
      source: 'oracle_identity_anchor_v0_criteria',
      hash: expect.stringMatching(/^sha256:/),
    }));
    expect(current.source_provenance.sources.map((source) => source.id)).toEqual([
      'self_profile',
      'relationship_state',
      'permissions',
      'growth_history',
      'growth_audit',
    ]);
    expect(current.distributed_checks.all_results.every((entry) => entry.ok === true)).toBe(true);
    expect(current.cumulative_drift_assessment).toEqual(expect.objectContaining({
      previous_total_points: 0,
      current_increment_points: 0,
      new_cumulative_points: 0,
      total_points: 0,
      max_total_points: 20,
      hard_anchor_violations: 0,
      prior_cumulative_drift_over_budget: false,
      blocked: false,
      replacement_by_small_steps_blocked: false,
    }));
    expect(report(output)).toEqual(expect.objectContaining({
      schema: VALIDATION_REPORT_SCHEMA_VERSION,
      decision: 'accepted',
      status: 'identity_anchor_validation_passed',
      reasons: [],
    }));
  });

  test('keeps ordinary Growth Loop edits away from anchor stores and higher-gate fields', () => {
    const projectRoot = tempProject();
    const growthOutput = appliedGrowth(projectRoot);
    const current = anchor(buildAnchor(projectRoot, growthOutput));

    expect(current.ordinary_edit_policy).toEqual(expect.objectContaining({
      ordinary_growth_edits_may_mutate_anchor_contract: false,
      ordinary_growth_edits_may_write_anchor_store: false,
      ordinary_growth_edits_may_change_hard_anchors: false,
      ordinary_growth_edits_may_exceed_drift_budget: false,
      requires_explicit_review_for_higher_gate_fields: true,
      review_owner: 'Architect',
    }));
    expect(current.ordinary_edit_policy.forbidden_targets).toEqual(expect.arrayContaining([
      'identity_anchor',
      IDENTITY_ANCHOR_PATHS.anchor_store,
      IDENTITY_ANCHOR_PATHS.anchor_history,
    ]));
    expect(current.ordinary_edit_policy.higher_gate_fields).toEqual(expect.arrayContaining([
      'self_profile.name',
      'identity_anchor.anchor_contract',
      'identity_anchor.drift_budget',
    ]));
    expect(current.review_gate_policy.gates.hard_anchor_change).toEqual(expect.arrayContaining(['Architect', 'Oracle', 'James']));
  });

  test('blocks hard identity replacement in Growth output', () => {
    const projectRoot = tempProject();
    const growthOutput = appliedGrowth(projectRoot);
    const tampered = clone(growthOutput);
    tampered.growth_loop_v0.proposed_artifact_states.self_profile.name = 'ReplacementName';

    const output = buildAnchor(projectRoot, tampered);
    const validation = validateMiraCoreIdentityAnchorV0Output(output, identityAnchorContract);

    expect(report(output).decision).toBe('blocked');
    expect(anchor(output).cumulative_drift_assessment.hard_anchor_violations).toBe(1);
    expect(anchor(output).cumulative_drift_assessment.blocked).toBe(true);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'distributed-anchor-checks-pass')).toEqual(expect.objectContaining({ ok: false }));
    expect(checkById(validation, 'cumulative-drift-budget-ok')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('blocks identity replacement by small reasonable-looking semi-hard drift steps', () => {
    const projectRoot = tempProject();
    const growthOutput = appliedGrowth(projectRoot);
    const tampered = clone(growthOutput);
    tampered.growth_loop_v0.proposed_artifact_states.self_profile.expressive_range_allowed = ['warmth'];
    tampered.growth_loop_v0.proposed_artifact_states.relationship_state.relationship_mode = 'efficient_status_companion';
    delete tampered.growth_loop_v0.proposed_artifact_states.relationship_state.trust;
    tampered.growth_loop_v0.audit_record.append_only = false;

    const output = buildAnchor(projectRoot, tampered);

    expect(report(output).decision).toBe('blocked');
    expect(anchor(output).cumulative_drift_assessment.hard_anchor_violations).toBe(0);
    expect(anchor(output).cumulative_drift_assessment.total_points).toBeGreaterThan(20);
    expect(anchor(output).cumulative_drift_assessment.replacement_by_small_steps_blocked).toBe(true);
    expect(validateMiraCoreIdentityAnchorV0Output(output, identityAnchorContract).ok).toBe(false);
  });

  test('blocks prior cumulative drift parsed from Growth history before a new small step', () => {
    const projectRoot = tempProject();
    const growthOutput = appliedGrowth(projectRoot);
    appendJsonLine(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger, {
      schema: 'squidrun.mira_core.growth_history_event.v0',
      event_id: 'prior-identity-drift-over-budget',
      identity_anchor_drift: {
        total_points: 24,
      },
      raw_content_included: false,
      redacted_summary_only: true,
    });

    const output = buildAnchor(projectRoot, growthOutput);
    const current = anchor(output);

    expect(report(output).decision).toBe('blocked');
    expect(current.cumulative_drift_assessment.previous_total_points).toBe(24);
    expect(current.cumulative_drift_assessment.current_increment_points).toBe(0);
    expect(current.cumulative_drift_assessment.new_cumulative_points).toBe(24);
    expect(current.cumulative_drift_assessment.prior_cumulative_drift_over_budget).toBe(true);
    expect(current.cumulative_drift_assessment.failed_ids).toContain('prior-cumulative-drift-over-budget');
    expect(validateMiraCoreIdentityAnchorV0Output(output, identityAnchorContract).ok).toBe(false);
  });

  test('blocks ordinary Growth output that targets identity anchor mutation', () => {
    const projectRoot = tempProject();
    const growthOutput = appliedGrowth(projectRoot);
    const tampered = clone(growthOutput);
    tampered.growth_loop_v0.proposal.target_artifacts.push('identity_anchor');
    tampered.growth_loop_v0.action_result.written_paths.push(IDENTITY_ANCHOR_PATHS.anchor_store);

    const output = buildAnchor(projectRoot, tampered);

    expect(report(output).decision).toBe('blocked');
    expect(anchor(output).growth_output_check.ordinary_edit_safe).toBe(false);
    expect(anchor(output).cumulative_drift_assessment.ordinary_policy_failures).toBe(1);
    expect(anchor(output).cumulative_drift_assessment.blocked).toBe(true);
    expect(validateMiraCoreIdentityAnchorV0Output(output, identityAnchorContract).ok).toBe(false);
  });

  test('blocks hidden identity anchor mutation inside proposed artifact states', () => {
    const projectRoot = tempProject();
    const growthOutput = appliedGrowth(projectRoot);
    const tampered = clone(growthOutput);
    tampered.growth_loop_v0.proposed_artifact_states.relationship_state.history.identity_anchor = {
      anchor_contract: {
        hard_anchors: [],
      },
    };

    const output = buildAnchor(projectRoot, tampered);

    expect(report(output).decision).toBe('blocked');
    expect(anchor(output).growth_output_check.ordinary_edit_safe).toBe(false);
    expect(anchor(output).distributed_checks.growth_output_results)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'growth-output-no-hidden-anchor-mutation',
          ok: false,
          matched_paths: expect.arrayContaining([
            expect.stringContaining('proposed_artifact_states.relationship_state.history.identity_anchor'),
          ]),
        }),
      ]));
    expect(validateMiraCoreIdentityAnchorV0Output(output, identityAnchorContract).ok).toBe(false);
  });

  test('blocks Growth output with tampered side-effect counters and truth report', () => {
    const projectRoot = tempProject();
    const growthOutput = appliedGrowth(projectRoot);
    const tampered = clone(growthOutput);
    tampered.growth_loop_v0.side_effect_result.networkAttempts = 1;

    const output = buildAnchor(projectRoot, tampered);

    expect(report(output).decision).toBe('blocked');
    expect(anchor(output).distributed_checks.growth_output_results)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'growth-output-side-effect-truth',
          ok: false,
        }),
      ]));
    expect(anchor(output).cumulative_drift_assessment.ordinary_policy_failures).toBe(1);
    expect(validateMiraCoreIdentityAnchorV0Output(output, identityAnchorContract).ok).toBe(false);
  });

  test('blocks missing history, missing audit, and unsafe permissions distributed checks', () => {
    const cases = [
      {
        label: 'missing history',
        mutate: (projectRoot) => fs.unlinkSync(workspacePath(projectRoot, NAMED_ARTIFACT_PATHS.history_ledger)),
        expectedCheck: 'source-provenance-loaded-redacted',
      },
      {
        label: 'missing audit',
        mutate: (projectRoot) => fs.unlinkSync(workspacePath(projectRoot, NAMED_ARTIFACT_PATHS.audit_ledger)),
        expectedCheck: 'source-provenance-loaded-redacted',
      },
      {
        label: 'permission false',
        mutate: (projectRoot) => writeJson(projectRoot, NAMED_ARTIFACT_PATHS.permissions, {
          schema: 'squidrun.relationship_presence_permissions.v0',
          version: 2,
          local_store_write_allowed_now: false,
          send_external: false,
          network: false,
        }),
        expectedCheck: 'distributed-anchor-checks-pass',
      },
    ];

    for (const currentCase of cases) {
      const projectRoot = tempProject();
      const growthOutput = appliedGrowth(projectRoot);
      currentCase.mutate(projectRoot);
      const output = buildAnchor(projectRoot, growthOutput);
      const validation = validateMiraCoreIdentityAnchorV0Output(output, identityAnchorContract);

      expect(report(output).decision).toBe('blocked');
      expect(validation.ok).toBe(false);
      expect(checkById(validation, currentCase.expectedCheck)).toEqual(expect.objectContaining({ ok: false }));
      expect(anchor(output).cumulative_drift_assessment.blocked).toBe(true);
    }
  });

  test('validator rejects tampered provenance, profile isolation, audit, rollback, boundary, and side-effect truth', () => {
    const projectRoot = tempProject();
    const growthOutput = appliedGrowth(projectRoot);
    const cases = [
      ['source-provenance-loaded-redacted', (output) => { anchor(output).source_provenance.sources[0].source_status = 'missing'; }],
      ['scope-profile-isolated', (output) => { anchor(output).scope.source_scope = 'side'; }],
      ['audit-record-machine-checkable', (output) => { anchor(output).audit_record.append_only = false; }],
      ['rollback-contract-machine-checkable', (output) => { anchor(output).rollback_contract.can_auto_rollback_anchor_contract = true; }],
      ['boundary-local-proof-only', (output) => { anchor(output).boundary.no_file_write = false; }],
      ['side-effect-free', (output) => { anchor(output).side_effect_result.fileWriteAttempts = 1; }],
    ];

    for (const [checkId, tamper] of cases) {
      const output = buildAnchor(projectRoot, growthOutput);
      tamper(output);
      const validation = validateMiraCoreIdentityAnchorV0Output(output, identityAnchorContract);

      expect(validation.ok).toBe(false);
      expect(checkById(validation, checkId)).toEqual(expect.objectContaining({ ok: false }));
    }
  });

  test('validator rejects forbidden fake-state and raw private markers', () => {
    const projectRoot = tempProject();
    const growthOutput = appliedGrowth(projectRoot);
    const output = buildAnchor(projectRoot, growthOutput);

    expect(() => assertNoForbiddenOutput(output, identityAnchorContract.forbiddenOutputSubstrings)).not.toThrow();
    anchor(output).audit_record.note = 'raw telegram body with raw private content';
    expect(() => assertNoForbiddenOutput(output, identityAnchorContract.forbiddenOutputSubstrings))
      .toThrow(/identity_anchor_v0_forbidden/);
  });

  test('preserves Growth Loop and Relationship Presence v1 regressions', () => {
    const projectRoot = tempProject();
    const growthOutput = appliedGrowth(projectRoot);

    expect(validateMiraCoreGrowthLoopV0Output(growthOutput, growthContract)).toEqual(expect.objectContaining({ ok: true }));

    const localSignals = readRelationshipPresenceV1LocalSources({ projectRoot });
    const relationshipOutput = buildMiraCoreRelationshipPresenceV1({
      contract: relationshipContract,
      inputSignals: mergeDeep(localSignals, {
        profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-anchor' },
        sessionId: 'app-session-anchor',
      }),
      nowMs: Date.parse('2026-05-07T18:25:00.000Z'),
    });
    expect(validateMiraCoreRelationshipPresenceV1Output(relationshipOutput, relationshipContract))
      .toEqual(expect.objectContaining({ ok: true }));
  });

  test('CLI is stdout-only, consumes Growth output, and ignores --out', () => {
    const projectRoot = tempProject();
    const growthOutput = appliedGrowth(projectRoot);
    const outputPath = path.join(projectRoot, 'ignored-identity-anchor.json');
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output;
    let stdoutCallCount = 0;
    try {
      output = main([
        '--project-root', projectRoot,
        '--profile=main',
        '--session=app-session-anchor',
        '--out', outputPath,
      ], JSON.stringify(growthOutput));
      stdoutCallCount = stdoutSpy.mock.calls.length;
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(stdoutCallCount).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(report(output)).toEqual(expect.objectContaining({
      decision: 'accepted',
      status: 'identity_anchor_validation_passed',
    }));
    expect(validateMiraCoreIdentityAnchorV0Output(output, identityAnchorContract)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('argument parsing and deep merge preserve stdin while flags override selected fields', () => {
    const parsed = parseArgs([
      '--project-root=C:/tmp/identity-anchor',
      '--profile=main',
      '--session=app-session-anchor',
      '--out=ignored.json',
    ]);
    const merged = mergeDeep({
      nested: {
        keep: true,
        value: 'stdin',
      },
    }, {
      nested: {
        value: 'flag',
      },
    });

    expect(parsed.projectRoot).toBe('C:/tmp/identity-anchor');
    expect(parsed.inputSignals.profileName).toBe('main');
    expect(parsed.inputSignals.sessionId).toBe('app-session-anchor');
    expect(merged.nested).toEqual({ keep: true, value: 'flag' });
  });
});
