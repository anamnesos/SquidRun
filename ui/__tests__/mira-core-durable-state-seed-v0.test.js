const fs = require('fs');
const os = require('os');
const path = require('path');

const seedContract = require('./fixtures/mira-core-durable-state-seed-v0-contract.json');
const relationshipContract = require('./fixtures/mira-core-relationship-presence-v1-contract.json');
const growthContract = require('./fixtures/mira-core-growth-loop-v0-contract.json');
const identityContract = require('./fixtures/mira-core-identity-anchor-v0-contract.json');
const {
  DURABLE_STATE_SEED_SCHEMA_VERSION,
  SEED_ARTIFACT_PATHS,
  SEED_ID,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreDurableStateSeedV0,
  readDurableStateSeedArtifacts,
  validateMiraCoreDurableStateSeedV0Output,
} = require('../modules/mira-core/durable-state-seed-v0');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-durable-state-seed-v0');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-durable-state-seed-'));
}

function workspacePath(projectRoot, relativePath) {
  return path.join(projectRoot, relativePath);
}

function build(projectRoot, options = {}) {
  return buildMiraCoreDurableStateSeedV0({
    contract: seedContract,
    relationshipContract,
    growthContract,
    identityContract,
    projectRoot,
    apply: options.apply === true,
    inputSignals: {
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-seed' },
      sessionId: 'app-session-seed',
      deviceId: 'VIGIL',
      ...(options.inputSignals || {}),
    },
    nowMs: Date.parse('2026-05-07T19:05:00.000Z'),
  });
}

function seed(output) {
  return output.durable_state_seed_v0;
}

function report(output) {
  return output.validation_report;
}

function checkById(validation, id) {
  return validation.checks.find((entry) => entry.id === id);
}

function readJson(projectRoot, id) {
  return JSON.parse(fs.readFileSync(workspacePath(projectRoot, SEED_ARTIFACT_PATHS[id]), 'utf8'));
}

function readJsonl(projectRoot, id) {
  return fs.readFileSync(workspacePath(projectRoot, SEED_ARTIFACT_PATHS[id]), 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function expectCanonicalSeedMetadata(value, artifactId) {
  expect(value).toEqual(expect.objectContaining({
    artifact_id: artifactId,
    generated_at: '2026-05-07T19:00:00.000Z',
    seed_id: SEED_ID,
    profile: 'main',
    window: 'main',
    session: 'app-session-seed',
    device: 'VIGIL',
    source_scope: 'main',
    canonical_hash: expect.stringMatching(/^sha256:/),
  }));
  expect(value.scope).toEqual(expect.objectContaining({
    profile: 'main',
    windowKey: 'main',
    sessionId: 'app-session-seed',
    deviceId: 'VIGIL',
    source_scope: 'main',
    main_scope_only: true,
    side_profile_reconstruction: false,
  }));
  expect(value.provenance).toEqual(expect.objectContaining({
    source_label: 'durable_state_seed_v0_redacted_local_fact',
    raw_content_included: false,
    redacted_summary_only: true,
  }));
}

describe('mira core Durable State Seed v0 phase 72', () => {
  test('defaults to dry-run stdout-only preview with no durable writes', () => {
    const projectRoot = tempProject();
    const output = build(projectRoot);
    const current = seed(output);
    const validation = validateMiraCoreDurableStateSeedV0Output(output, seedContract);

    expect(validation).toEqual(expect.objectContaining({ ok: true }));
    expect(current.schema).toBe(DURABLE_STATE_SEED_SCHEMA_VERSION);
    expect(current.phase).toBe(72);
    expect(current.seed_contract.required_artifacts.map((entry) => entry.path)).toEqual(Object.values(SEED_ARTIFACT_PATHS));
    expect(current.action_result).toEqual(expect.objectContaining({
      mode: 'dry_run',
      applied: false,
      decision: 'preview_no_writes',
      write_count: 0,
      planned_write_count: 5,
    }));
    expect(current.pre_apply_safety_gate).toEqual(expect.objectContaining({
      required: true,
      ok: true,
      reasons: [],
      checked_before_any_write: true,
    }));
    for (const entry of current.artifact_plan) {
      expect(entry).toEqual(expect.objectContaining({
        path_safe: true,
        path_safety_reason: null,
        full_path_within_project: true,
        canonical_metadata_required: true,
        expected_canonical_hash: expect.stringMatching(/^sha256:/),
      }));
    }
    expect(current.boundary).toEqual(expect.objectContaining({
      default_dry_run_stdout_only: true,
      explicit_apply_required: true,
      stdout_only: true,
      output_file_written: false,
      pre_apply_scope_gate_required: true,
      exact_existing_seed_hash_required: true,
      canonical_metadata_required: true,
      realpath_lstat_escape_check_required: true,
      redacted_local_facts_only: true,
      identity_anchor_store_write: false,
    }));
    expect(current.side_effect_result.boundedWorkspaceKnowledgeWriteAttempts).toBe(0);
    for (const relativePath of Object.values(SEED_ARTIFACT_PATHS)) {
      expect(fs.existsSync(workspacePath(projectRoot, relativePath))).toBe(false);
    }
    expect(report(output)).toEqual(expect.objectContaining({
      schema: VALIDATION_REPORT_SCHEMA_VERSION,
      decision: 'accepted',
      status: 'durable_state_seed_preview_valid',
      reasons: [],
    }));
  });

  test('explicit apply writes only allowlisted workspace knowledge artifacts and proves read/growth/anchor acceptance', () => {
    const projectRoot = tempProject();
    const output = build(projectRoot, { apply: true });
    const current = seed(output);
    const validation = validateMiraCoreDurableStateSeedV0Output(output, seedContract);

    expect(validation).toEqual(expect.objectContaining({ ok: true }));
    expect(current.action_result).toEqual(expect.objectContaining({
      mode: 'apply_completed',
      applied: true,
      decision: 'applied_local_seed_writes',
      write_count: 5,
      atomic_write_count: 5,
      append_count: 2,
    }));
    expect(current.action_result.written_paths).toEqual(Object.values(SEED_ARTIFACT_PATHS));
    expect(current.post_apply_validation).toEqual(expect.objectContaining({
      mode: 'post_apply_loaded_durable_sources',
      all_accept: true,
      growth_history_entries: 1,
      growth_audit_entries: 1,
      max_prior_drift_points: 0,
    }));
    expect(current.post_apply_validation.relationship_presence).toEqual(expect.objectContaining({
      ok: true,
      decision: 'accepted_validation_only',
      status: 'local_start_relationship_presence_proof',
    }));
    expect(current.post_apply_validation.relationship_presence.loaded_sources).toEqual(expect.objectContaining({
      loaded_count: 3,
      self_profile: true,
      relationship_state: true,
      permissions_boundary: true,
    }));
    expect(current.post_apply_validation.growth_loop).toEqual(expect.objectContaining({
      ok: true,
      decision: 'accepted',
    }));
    expect(current.post_apply_validation.identity_anchor).toEqual(expect.objectContaining({
      ok: true,
      decision: 'accepted',
      metadata_bound: true,
      previous_drift_points: 0,
      new_cumulative_drift_points: 0,
      identity_anchor_store_seeded: false,
    }));

    const selfProfile = readJson(projectRoot, 'self_profile');
    const relationshipState = readJson(projectRoot, 'relationship_state');
    const permissions = readJson(projectRoot, 'permissions');
    expectCanonicalSeedMetadata(selfProfile, 'self_profile');
    expectCanonicalSeedMetadata(relationshipState, 'relationship_state');
    expectCanonicalSeedMetadata(permissions, 'permissions');
    expect(selfProfile).toEqual(expect.objectContaining({
      seed_id: SEED_ID,
      name: 'Mira',
      data_not_theater: true,
      claims_actual_consciousness: false,
    }));
    expect(relationshipState).toEqual(expect.objectContaining({
      seed_id: SEED_ID,
      user_name: 'James',
      relationship_mode: 'collaborative_presence_design',
      raw_content_present: false,
    }));
    for (const key of ['trust', 'repair', 'boundaries', 'promises', 'history']) {
      expect(relationshipState[key]).toEqual(expect.objectContaining({
        label: key,
      }));
      expect(Object.prototype.hasOwnProperty.call(relationshipState[key], 'raw_content_included')).toBe(false);
    }
    expect(permissions).toEqual(expect.objectContaining({
      machine_checkable: true,
      local_store_write_allowed_now: true,
      send_external: false,
      network: false,
      customer_action: false,
      runtime_start: false,
      kill_switch_wiring: false,
    }));
    const history = readJsonl(projectRoot, 'growth_history')[0];
    const audit = readJsonl(projectRoot, 'growth_audit')[0];
    expectCanonicalSeedMetadata(history, 'growth_history');
    expectCanonicalSeedMetadata(audit, 'growth_audit');
    expect(history).toEqual(expect.objectContaining({
      version: 1,
      identity_anchor_drift_points: 0,
      raw_content_included: false,
      redacted_summary_only: true,
    }));
    expect(audit).toEqual(expect.objectContaining({
      version: 1,
      identity_anchor_drift_points: 0,
      total_drift_points: 0,
      raw_content_included: false,
      redacted_summary_only: true,
    }));
  });

  test('apply is idempotent and does not duplicate Growth history or audit seed rows', () => {
    const projectRoot = tempProject();
    const first = build(projectRoot, { apply: true });
    const second = build(projectRoot, { apply: true });
    const firstValidation = validateMiraCoreDurableStateSeedV0Output(first, seedContract);
    const secondValidation = validateMiraCoreDurableStateSeedV0Output(second, seedContract);

    expect(firstValidation).toEqual(expect.objectContaining({ ok: true }));
    expect(secondValidation).toEqual(expect.objectContaining({ ok: true }));
    expect(seed(second).action_result).toEqual(expect.objectContaining({
      decision: 'already_seeded_noop',
      write_count: 0,
      noop_count: 5,
    }));
    expect(readJsonl(projectRoot, 'growth_history')).toHaveLength(1);
    expect(readJsonl(projectRoot, 'growth_audit')).toHaveLength(1);
  });

  test('pre-apply scope safety gate blocks profile window source mismatch before writes', () => {
    const projectRoot = tempProject();
    const output = build(projectRoot, {
      apply: true,
      inputSignals: {
        profile: { name: 'aux', windowKey: 'aux-window', sessionScopeId: 'aux-session' },
        sessionId: 'aux-session',
        sourceScope: 'aux-window',
      },
    });
    const current = seed(output);
    const validation = validateMiraCoreDurableStateSeedV0Output(output, seedContract);

    expect(report(output).decision).toBe('blocked');
    expect(current.pre_apply_safety_gate).toEqual(expect.objectContaining({
      required: true,
      ok: false,
      checked_before_any_write: true,
    }));
    expect(current.pre_apply_safety_gate.reasons).toEqual(expect.arrayContaining([
      'profile_mismatch:aux',
      'window_mismatch:aux-window',
      'session_scope_mismatch:aux-session',
      'source_scope_mismatch:aux-window',
    ]));
    expect(current.action_result).toEqual(expect.objectContaining({
      mode: 'apply_blocked',
      decision: 'blocked_no_writes',
      write_count: 0,
      atomic_write_count: 0,
      append_count: 0,
      written_paths: [],
    }));
    expect(current.action_result.blocked_because).toContain('pre_apply_scope_safety_gate');
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'action-result-bounded')).toEqual(expect.objectContaining({ ok: true }));
    for (const relativePath of Object.values(SEED_ARTIFACT_PATHS)) {
      expect(fs.existsSync(workspacePath(projectRoot, relativePath))).toBe(false);
    }
  });

  test('existing same-seed tamper blocks instead of self-healing permissions', () => {
    const projectRoot = tempProject();
    const first = build(projectRoot, { apply: true });
    expect(validateMiraCoreDurableStateSeedV0Output(first, seedContract)).toEqual(expect.objectContaining({ ok: true }));

    const permissionsPath = workspacePath(projectRoot, SEED_ARTIFACT_PATHS.permissions);
    const permissions = readJson(projectRoot, 'permissions');
    permissions.local_store_write_allowed_now = false;
    permissions.canonical_hash = 'sha256:tampered';
    fs.writeFileSync(permissionsPath, `${JSON.stringify(permissions, null, 2)}\n`, 'utf8');

    const second = build(projectRoot, { apply: true });
    const current = seed(second);
    const validation = validateMiraCoreDurableStateSeedV0Output(second, seedContract);

    expect(report(second).decision).toBe('blocked');
    expect(current.action_result).toEqual(expect.objectContaining({
      mode: 'apply_blocked',
      decision: 'blocked_no_writes',
      write_count: 0,
    }));
    expect(current.action_result.blocked_because).toContain('permissions:existing_seed_artifact_hash_or_metadata_mismatch');
    expect(current.artifact_plan.find((entry) => entry.artifact_id === 'permissions')).toEqual(expect.objectContaining({
      operation: 'blocked_existing_seed_json_mismatch',
      canonical_metadata_present: false,
      ok_to_apply: false,
    }));
    expect(readJson(projectRoot, 'permissions').local_store_write_allowed_now).toBe(false);
    expect(readJson(projectRoot, 'permissions').canonical_hash).toBe('sha256:tampered');
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'action-result-bounded')).toEqual(expect.objectContaining({ ok: true }));
  });

  test('existing same-seed JSONL tamper blocks instead of appending over raw marker drift', () => {
    const projectRoot = tempProject();
    const first = build(projectRoot, { apply: true });
    expect(validateMiraCoreDurableStateSeedV0Output(first, seedContract)).toEqual(expect.objectContaining({ ok: true }));

    const historyPath = workspacePath(projectRoot, SEED_ARTIFACT_PATHS.growth_history);
    const history = readJsonl(projectRoot, 'growth_history');
    delete history[0].seed_id;
    delete history[0].version;
    history[0].redacted_summary_only = false;
    history[0].canonical_hash = 'sha256:tampered';
    fs.writeFileSync(historyPath, `${history.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

    const second = build(projectRoot, { apply: true });
    const current = seed(second);
    const validation = validateMiraCoreDurableStateSeedV0Output(second, seedContract);

    expect(report(second).decision).toBe('blocked');
    expect(current.action_result).toEqual(expect.objectContaining({
      mode: 'apply_blocked',
      decision: 'blocked_no_writes',
      write_count: 0,
    }));
    expect(current.action_result.blocked_because).toContain('growth_history:existing_seed_entry_hash_or_metadata_mismatch');
    expect(current.artifact_plan.find((entry) => entry.artifact_id === 'growth_history')).toEqual(expect.objectContaining({
      operation: 'blocked_seed_entry_hash_or_metadata_mismatch',
      canonical_metadata_present: false,
      ok_to_apply: false,
    }));
    expect(readJsonl(projectRoot, 'growth_history')).toHaveLength(1);
    expect(readJsonl(projectRoot, 'growth_history')[0].redacted_summary_only).toBe(false);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'action-result-bounded')).toEqual(expect.objectContaining({ ok: true }));
  });

  test('realpath lstat safety rejects symlink or junction workspace escape before writes', () => {
    const projectRoot = tempProject();
    const knowledgeDir = workspacePath(projectRoot, 'workspace/knowledge');
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
      output = build(projectRoot, { apply: true });
    } finally {
      lstatSpy.mockRestore();
    }
    const current = seed(output);
    const validation = validateMiraCoreDurableStateSeedV0Output(output, seedContract);

    expect(report(output).decision).toBe('blocked');
    expect(current.action_result).toEqual(expect.objectContaining({
      mode: 'apply_blocked',
      decision: 'blocked_no_writes',
      write_count: 0,
    }));
    expect(current.action_result.blocked_because).toContain('unsafe_path:symlink_or_junction_component:workspace/knowledge');
    expect(current.artifact_plan.every((entry) => entry.path_safe === false)).toBe(true);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'action-result-bounded')).toEqual(expect.objectContaining({ ok: true }));
    for (const relativePath of Object.values(SEED_ARTIFACT_PATHS)) {
      expect(fs.existsSync(workspacePath(projectRoot, relativePath))).toBe(false);
    }
  });

  test('invalid existing durable JSON fails closed without writes', () => {
    const projectRoot = tempProject();
    const selfPath = workspacePath(projectRoot, SEED_ARTIFACT_PATHS.self_profile);
    fs.mkdirSync(path.dirname(selfPath), { recursive: true });
    fs.writeFileSync(selfPath, '{not json', 'utf8');

    const output = build(projectRoot, { apply: true });
    const current = seed(output);
    const validation = validateMiraCoreDurableStateSeedV0Output(output, seedContract);

    expect(report(output).decision).toBe('blocked');
    expect(current.action_result).toEqual(expect.objectContaining({
      mode: 'apply_blocked',
      applied: false,
      decision: 'blocked_no_writes',
      write_count: 0,
    }));
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'action-result-bounded')).toEqual(expect.objectContaining({ ok: true }));
    expect(fs.existsSync(workspacePath(projectRoot, SEED_ARTIFACT_PATHS.relationship_state))).toBe(false);
  });

  test('validator rejects unsafe tampering, raw markers, side-profile case content, and false proof claims', () => {
    const projectRoot = tempProject();
    const output = build(projectRoot, { apply: true });
    const unsafe = clone(output);
    seed(unsafe).boundary.network = true;
    seed(unsafe).post_apply_validation.identity_anchor.metadata_bound = false;
    seed(unsafe).side_effect_result.networkAttempts = 1;

    const validation = validateMiraCoreDurableStateSeedV0Output(unsafe, seedContract);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'boundary-local-stdout-apply-only')).toEqual(expect.objectContaining({ ok: false }));
    expect(checkById(validation, 'side-effect-truth-bounded')).toEqual(expect.objectContaining({ ok: false }));
    expect(checkById(validation, 'post-apply-accepted-proofs')).toEqual(expect.objectContaining({ ok: false }));

    const forbidden = clone(output);
    seed(forbidden).artifact_plan[0].note = 'Eunbyeol raw private content';
    expect(() => assertNoForbiddenOutput(forbidden, seedContract.forbiddenOutputSubstrings))
      .toThrow(/durable_state_seed_v0_forbidden/);
  });

  test('CLI is stdout-only, ignores --out, and supports explicit apply in a temp workspace', () => {
    const projectRoot = tempProject();
    const outputPath = path.join(projectRoot, 'ignored-seed-output.json');
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output;
    let stdoutCallCount = 0;
    try {
      output = main([
        '--project-root', projectRoot,
        '--profile=main',
        '--session=app-session-seed',
        '--apply',
        '--out', outputPath,
      ], '{}');
      stdoutCallCount = stdoutSpy.mock.calls.length;
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(stdoutCallCount).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(report(output)).toEqual(expect.objectContaining({
      decision: 'accepted',
      status: 'durable_state_seed_applied_and_validated',
    }));
    expect(validateMiraCoreDurableStateSeedV0Output(output, seedContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(readDurableStateSeedArtifacts({ projectRoot }).growth_history.entry_count).toBe(1);
  });

  test('argument parsing keeps apply explicit and maps profile/session flags', () => {
    const parsed = parseArgs([
      '--project-root=C:/tmp/seed',
      '--profile=main',
      '--session=app-session-seed',
      '--device=VIGIL',
      '--out=ignored.json',
    ]);

    expect(parsed.projectRoot).toBe('C:/tmp/seed');
    expect(parsed.apply).toBe(false);
    expect(parsed.inputSignals).toEqual(expect.objectContaining({
      profileName: 'main',
      sessionId: 'app-session-seed',
      deviceId: 'VIGIL',
    }));
  });
});
