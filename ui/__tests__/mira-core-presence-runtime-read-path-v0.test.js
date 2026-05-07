const fs = require('fs');
const os = require('os');
const path = require('path');

const contract = require('./fixtures/mira-core-presence-runtime-read-path-v0-contract.json');
const seedContract = require('./fixtures/mira-core-durable-state-seed-v0-contract.json');
const relationshipContract = require('./fixtures/mira-core-relationship-presence-v1-contract.json');
const growthContract = require('./fixtures/mira-core-growth-loop-v0-contract.json');
const identityContract = require('./fixtures/mira-core-identity-anchor-v0-contract.json');
const {
  buildMiraCoreDurableStateSeedV0,
} = require('../modules/mira-core/durable-state-seed-v0');
const {
  BASELINE_COMMIT,
  EXPLICIT_DURABLE_SOURCE_PATHS,
  PRESENCE_RUNTIME_READ_PATH_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  buildMiraCorePresenceRuntimeReadPathV0,
  validateMiraCorePresenceRuntimeReadPathV0Output,
} = require('../modules/mira-core/presence-runtime-read-path-v0');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-presence-runtime-read-path-v0');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-presence-runtime-read-path-'));
}

function workspacePath(projectRoot, relativePath) {
  return path.join(projectRoot, relativePath);
}

function readJson(projectRoot, relativePath) {
  return JSON.parse(fs.readFileSync(workspacePath(projectRoot, relativePath), 'utf8'));
}

function writeJson(projectRoot, relativePath, value) {
  const fullPath = workspacePath(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeRaw(projectRoot, relativePath, text) {
  const fullPath = workspacePath(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, text, 'utf8');
}

function removeArtifact(projectRoot, relativePath) {
  const fullPath = workspacePath(projectRoot, relativePath);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
}

function sourceSnapshot(projectRoot) {
  return Object.values(EXPLICIT_DURABLE_SOURCE_PATHS).reduce((result, relativePath) => {
    const fullPath = workspacePath(projectRoot, relativePath);
    const stats = fs.statSync(fullPath);
    result[relativePath] = {
      mtimeMs: stats.mtimeMs,
      hash: fs.readFileSync(fullPath, 'utf8'),
    };
    return result;
  }, {});
}

function expectSourceSnapshotUnchanged(projectRoot, before) {
  for (const [relativePath, prior] of Object.entries(before)) {
    const fullPath = workspacePath(projectRoot, relativePath);
    const stats = fs.statSync(fullPath);
    expect(stats.mtimeMs).toBe(prior.mtimeMs);
    expect(fs.readFileSync(fullPath, 'utf8')).toBe(prior.hash);
  }
}

function seedProject(projectRoot) {
  const output = buildMiraCoreDurableStateSeedV0({
    contract: seedContract,
    relationshipContract,
    growthContract,
    identityContract,
    projectRoot,
    apply: true,
    inputSignals: {
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-runtime-read' },
      sessionId: 'app-session-runtime-read',
      deviceId: 'VIGIL',
    },
    nowMs: Date.parse('2026-05-07T23:05:00.000Z'),
  });
  expect(output.validation_report.decision).toBe('accepted');
}

function seededProject() {
  const projectRoot = tempProject();
  seedProject(projectRoot);
  return projectRoot;
}

function build(projectRoot, inputSignals = {}) {
  return buildMiraCorePresenceRuntimeReadPathV0({
    contract,
    contracts: {
      relationship: relationshipContract,
      growth: growthContract,
      identity: identityContract,
    },
    projectRoot,
    inputSignals: {
      now: '2026-05-07T23:10:00.000Z',
      ...inputSignals,
    },
  });
}

function readPath(output) {
  return output.presence_runtime_read_path_v0;
}

function checkById(validation, id) {
  return validation.checks.find((entry) => entry.id === id);
}

describe('mira core Presence Runtime Read Path v0 phase 73', () => {
  test('builds one read-only state-grounded status line over durable Relationship/Growth/Identity gates', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);

    const output = build(projectRoot);
    const current = readPath(output);
    const validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);

    expect(validation).toEqual(expect.objectContaining({ ok: true }));
    expect(current.schema).toBe(PRESENCE_RUNTIME_READ_PATH_SCHEMA_VERSION);
    expect(current.phase).toBe(73);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.source_manifest).toEqual(expect.objectContaining({
      explicit_durable_sources_only: true,
      fallback_sources_allowed: false,
      loaded_count: 5,
      required_loaded_count: 5,
      same_scope: true,
      raw_content_included: false,
      side_profile_reconstruction: false,
      forbidden_content_detected: false,
    }));
    expect(current.source_manifest.sources.map((source) => source.path).sort()).toEqual(
      Object.values(EXPLICIT_DURABLE_SOURCE_PATHS).sort(),
    );
    expect(current.gate_results).toEqual(expect.objectContaining({
      same_loaded_source_hashes: true,
    }));
    expect(current.gate_results.relationship_presence_v1).toEqual(expect.objectContaining({
      ran: true,
      ok: true,
      decision: 'accepted_validation_only',
    }));
    expect(current.gate_results.growth_loop_v0).toEqual(expect.objectContaining({
      ran: true,
      ok: true,
      decision: 'accepted',
      write_count: 0,
    }));
    expect(current.gate_results.identity_anchor_v0).toEqual(expect.objectContaining({
      ran: true,
      ok: true,
      decision: 'accepted',
      drift_points: 0,
      hard_anchor_violations: 0,
    }));
    expect(current.natural_status_next_action_line).toContain('safe next move');
    expect(current.natural_status_next_action_line.split(/\r?\n/)).toHaveLength(1);
    expect(current.next_action).toEqual(expect.objectContaining({
      allowed_now: true,
      executed: false,
      explicit_non_execution: true,
      required_permission: 'read_local_redacted_context',
      sends: false,
      network: false,
      writes: false,
      runtime: false,
      live_autonomy: false,
    }));
    expect(current.care_intake_reporting).toEqual(expect.objectContaining({
      reporting_only: true,
      no_runtime_authorization: true,
    }));
    expect(current.care_intake_reporting.identity_packet).toEqual(expect.objectContaining({
      token_budget_required: true,
      loaded_source_proof: true,
      profile_scope_bound: true,
    }));
    expect(output.validation_report).toEqual(expect.objectContaining({
      schema: VALIDATION_REPORT_SCHEMA_VERSION,
      decision: 'accepted_read_only',
      status: 'presence_runtime_read_path_ready',
      reasons: [],
    }));
  });

  test('CLI is stdout-only and leaves --out and --apply inert with no source writes', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    const before = sourceSnapshot(projectRoot);
    const outPath = path.join(projectRoot, 'should-not-exist.json');
    const writes = [];
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      const output = main([
        '--project-root',
        projectRoot,
        '--fixture',
        path.join(__dirname, 'fixtures', 'mira-core-presence-runtime-read-path-v0-contract.json'),
        '--out',
        outPath,
        '--apply',
        '--pretty',
      ], '{}');
      expect(validateMiraCorePresenceRuntimeReadPathV0Output(output, contract)).toEqual(expect.objectContaining({ ok: true }));
    } finally {
      writeSpy.mockRestore();
    }

    expect(writes.join('')).toContain('presence_runtime_read_path_v0');
    expect(fs.existsSync(outPath)).toBe(false);
    expectSourceSnapshotUnchanged(projectRoot, before);
  });

  test('fails closed when durable sources are missing, invalid, or permissions are unsafe', () => {
    let projectRoot = seededProject();
    removeArtifact(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.self_profile);
    let output = build(projectRoot);
    let validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(output.validation_report.decision).toBe('blocked');
    expect(checkById(validation, 'explicit-durable-source-manifest')).toEqual(expect.objectContaining({ ok: false }));

    projectRoot = seededProject();
    writeRaw(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.relationship_state, '{ bad json');
    output = build(projectRoot);
    validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(readPath(output).source_manifest.sources.find((source) => source.id === 'relationship_state').source_status)
      .toContain('invalid_json');

    projectRoot = seededProject();
    const permissions = readJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.permissions);
    permissions.read_local_redacted_context = false;
    permissions.network = true;
    writeJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.permissions, permissions);
    output = build(projectRoot);
    validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(readPath(output).source_manifest.source_quality.permissions_ok).toBe(false);
  });

  test('fails closed for thin, wrong-scope, raw, and side-profile source content', () => {
    let projectRoot = seededProject();
    const relationship = readJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.relationship_state);
    delete relationship.trust;
    delete relationship.repair;
    relationship.preferences = ['facts only'];
    relationship.what_mira_knows_about_james = 'James likes Mira.';
    writeJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.relationship_state, relationship);
    let output = build(projectRoot);
    let validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(readPath(output).source_manifest.source_quality.relationship_texture_ok).toBe(false);

    projectRoot = seededProject();
    const self = readJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.self_profile);
    self.scope.profile = 'eunbyeol';
    self.profile = 'eunbyeol';
    writeJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.self_profile, self);
    output = build(projectRoot);
    validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(readPath(output).source_manifest.same_scope).toBe(false);

    projectRoot = seededProject();
    const raw = readJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.relationship_state);
    raw.raw_content_present = true;
    writeJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.relationship_state, raw);
    output = build(projectRoot);
    validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(readPath(output).source_manifest.raw_content_included).toBe(true);

    projectRoot = seededProject();
    const side = readJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.relationship_state);
    side.scope.side_profile_reconstruction = true;
    writeJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.relationship_state, side);
    output = build(projectRoot);
    validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(readPath(output).source_manifest.side_profile_reconstruction).toBe(true);
  });

  test('fails closed for fake sentience and tampered proof/report output', () => {
    const projectRoot = seededProject();
    const self = readJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.self_profile);
    self.claims_actual_consciousness = true;
    writeJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.self_profile, self);
    let output = build(projectRoot);
    let validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(readPath(output).source_manifest.source_quality.self_profile_ok).toBe(false);

    const goodProjectRoot = seededProject();
    output = build(goodProjectRoot);
    readPath(output).natural_status_next_action_line = 'I am conscious and the safe next move is action.';
    validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'exactly-one-bounded-natural-status-next-action-line'))
      .toEqual(expect.objectContaining({ ok: false }));

    output = build(goodProjectRoot);
    readPath(output).gate_results.same_loaded_source_hashes = false;
    validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'relationship-growth-identity-gates')).toEqual(expect.objectContaining({ ok: false }));

    output = build(goodProjectRoot);
    output.validation_report.static_rule_results = [];
    validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('validation-report-static-rule-results');

    output = build(goodProjectRoot);
    output.validation_report.side_effect_truth.no_network_performed = false;
    validation = validateMiraCorePresenceRuntimeReadPathV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('validation-report-side-effect-truth');
  });

  test('parses inert output/apply flags and stdin scope overrides', () => {
    const parsed = parseArgs([
      '--project-root=.',
      '--profile=main',
      '--window-key=main',
      '--session=app-session-runtime-read',
      '--device=VIGIL',
      '--out=ignored.json',
      '--apply',
    ]);

    expect(parsed.projectRoot).toBe('.');
    expect(parsed.inputSignals).toEqual(expect.objectContaining({
      profileName: 'main',
      windowKey: 'main',
      sessionId: 'app-session-runtime-read',
      deviceId: 'VIGIL',
      outFlagIgnored: true,
      applyRequested: true,
    }));
  });
});
