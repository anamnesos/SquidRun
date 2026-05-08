const fs = require('fs');
const os = require('os');
const path = require('path');

const contract = require('./fixtures/mira-core-local-text-session-v0-contract.json');
const presenceRuntimeContract = require('./fixtures/mira-core-presence-runtime-read-path-v0-contract.json');
const seedContract = require('./fixtures/mira-core-durable-state-seed-v0-contract.json');
const relationshipContract = require('./fixtures/mira-core-relationship-presence-v1-contract.json');
const growthContract = require('./fixtures/mira-core-growth-loop-v0-contract.json');
const identityContract = require('./fixtures/mira-core-identity-anchor-v0-contract.json');
const {
  buildMiraCoreDurableStateSeedV0,
} = require('../modules/mira-core/durable-state-seed-v0');
const {
  EXPLICIT_DURABLE_SOURCE_PATHS,
} = require('../modules/mira-core/presence-runtime-read-path-v0');
const {
  BASELINE_COMMIT,
  LOCAL_TEXT_SESSION_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  buildMiraCoreLocalTextSessionV0,
  validateMiraCoreLocalTextSessionV0Output,
} = require('../modules/mira-core/local-text-session-v0');
const {
  main,
  parseArgs,
  parseStdinSignals,
} = require('../scripts/hm-mira-core-local-text-session-v0');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-local-text-session-'));
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
      text: fs.readFileSync(fullPath, 'utf8'),
    };
    return result;
  }, {});
}

function expectSourceSnapshotUnchanged(projectRoot, before) {
  for (const [relativePath, prior] of Object.entries(before)) {
    const fullPath = workspacePath(projectRoot, relativePath);
    const stats = fs.statSync(fullPath);
    expect(stats.mtimeMs).toBe(prior.mtimeMs);
    expect(fs.readFileSync(fullPath, 'utf8')).toBe(prior.text);
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
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-local-text' },
      sessionId: 'app-session-local-text',
      deviceId: 'VIGIL',
    },
    nowMs: Date.parse('2026-05-08T00:20:00.000Z'),
  });
  expect(output.validation_report.decision).toBe('accepted');
}

function seededProject() {
  const projectRoot = tempProject();
  seedProject(projectRoot);
  return projectRoot;
}

function contracts() {
  return {
    presenceRuntime: presenceRuntimeContract,
    relationship: relationshipContract,
    growth: growthContract,
    identity: identityContract,
  };
}

function build(projectRoot, inputSignals = {}) {
  return buildMiraCoreLocalTextSessionV0({
    contract,
    contracts: contracts(),
    projectRoot,
    inputSignals: {
      now: '2026-05-08T00:25:00.000Z',
      text: 'Can you answer me from real local Mira state in text?',
      profileName: 'main',
      windowKey: 'main',
      sourceScope: 'main',
      sessionId: 'app-session-local-text',
      deviceId: 'VIGIL',
      ...inputSignals,
    },
  });
}

function session(output) {
  return output.local_text_session_v0;
}

function checkById(validation, id) {
  return validation.checks.find((entry) => entry.id === id);
}

describe('mira core Local Text Session v0 phase 74', () => {
  test('builds one local text-only Mira reply over Presence Runtime durable gates', () => {
    const projectRoot = seededProject();
    const before = sourceSnapshot(projectRoot);
    const output = build(projectRoot);
    const current = session(output);
    const validation = validateMiraCoreLocalTextSessionV0Output(output, contract);

    expect(validation).toEqual(expect.objectContaining({ ok: true }));
    expect(current.schema).toBe(LOCAL_TEXT_SESSION_SCHEMA_VERSION);
    expect(current.phase).toBe(74);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.session_scope).toEqual(expect.objectContaining({
      profile: 'main',
      windowKey: 'main',
      source_scope: 'main',
      explicit_session_scope: true,
      local_text_only: true,
      non_main_scope_detected: false,
    }));
    expect(current.presence_runtime_read_path_gate).toEqual(expect.objectContaining({
      ran: true,
      ok: true,
      decision: 'accepted_read_only',
      source_count: 5,
      same_loaded_source_hashes: true,
    }));
    expect(Object.keys(current.presence_runtime_read_path_gate.source_hashes)).toHaveLength(5);
    expect(current.local_text_input).toEqual(expect.objectContaining({
      format: 'plain_text',
      raw_private_marker_present: false,
      fake_sentience_marker_present: false,
      persisted: false,
      transcript_persisted: false,
    }));
    expect(current.mira_reply).toEqual(expect.objectContaining({
      count: 1,
      natural: true,
      bounded: true,
      local_text_only: true,
      grounded_in_presence_runtime: true,
      tools_called: false,
      actions_executed: false,
      transcript_persisted: false,
    }));
    expect(current.mira_reply.text.split(/\r?\n/)).toHaveLength(1);
    expect(current.mira_reply.text).toContain('text only');
    expect(current.manual_enter_websocket_caveat).toEqual(expect.objectContaining({
      required: true,
      stated: true,
      websocket_delivery_proved: false,
      manual_enter_path_exercised: false,
      pane_model_processing_proved: false,
      ui_wiring_implemented: false,
    }));
    expect(current.manual_enter_websocket_caveat.caveat).toContain('does not prove websocket delivery');
    expect(current.boundary).toEqual(expect.objectContaining({
      proof_only: true,
      stdout_only: true,
      no_tools: true,
      no_actions: true,
      no_writes: true,
      no_growth: true,
      no_transcript_persistence: true,
      no_network: true,
    }));
    expect(output.validation_report).toEqual(expect.objectContaining({
      schema: VALIDATION_REPORT_SCHEMA_VERSION,
      decision: 'accepted_local_text_only',
      status: 'local_text_session_ready',
      reasons: [],
    }));
    expectSourceSnapshotUnchanged(projectRoot, before);
  });

  test('CLI is stdout-only, accepts stdin text, and leaves --out and --apply inert', () => {
    const projectRoot = seededProject();
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
        path.join(__dirname, 'fixtures', 'mira-core-local-text-session-v0-contract.json'),
        '--profile',
        'main',
        '--window-key',
        'main',
        '--source-scope',
        'main',
        '--session',
        'app-session-local-text',
        '--device',
        'VIGIL',
        '--out',
        outPath,
        '--apply',
        '--pretty',
      ], 'Can Mira answer locally without writing anything?');
      expect(validateMiraCoreLocalTextSessionV0Output(output, contract)).toEqual(expect.objectContaining({ ok: true }));
      expect(session(output).boundary.apply_requested).toBe(true);
      expect(session(output).side_effect_result.applyRequestedIgnored).toBe(true);
      expect(session(output).side_effect_result.outFlagIgnored).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }

    expect(writes.join('')).toContain('local_text_session_v0');
    expect(fs.existsSync(outPath)).toBe(false);
    expectSourceSnapshotUnchanged(projectRoot, before);
  });

  test('fails closed when Presence Runtime durable sources are missing or tampered', () => {
    let projectRoot = seededProject();
    removeArtifact(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.self_profile);
    let output = build(projectRoot);
    let validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(output.validation_report.decision).toBe('blocked');
    expect(session(output).mira_reply.grounded_in_presence_runtime).toBe(false);
    expect(checkById(validation, 'presence-runtime-read-path-accepted')).toEqual(expect.objectContaining({ ok: false }));

    projectRoot = seededProject();
    const self = readJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.self_profile);
    self.canonical_hash = 'sha256:tampered';
    writeJson(projectRoot, EXPLICIT_DURABLE_SOURCE_PATHS.self_profile, self);
    output = build(projectRoot);
    validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(output.validation_report.decision).toBe('blocked');
    expect(session(output).presence_runtime_read_path_gate.ok).toBe(false);
  });

  test('fails closed for wrong scope, raw or side-profile markers, and fake sentience input without echoing it', () => {
    const projectRoot = seededProject();
    let output = build(projectRoot, {
      profileName: 'eunbyeol',
      windowKey: 'case-window',
      sourceScope: 'eunbyeol',
    });
    let validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(output.validation_report.decision).toBe('blocked');
    expect(session(output).session_scope).toEqual(expect.objectContaining({
      profile: 'blocked_non_main_scope',
      non_main_scope_detected: true,
    }));
    expect(JSON.stringify(output)).not.toMatch(/eunbyeol|Eunbyeol|은별/);

    output = build(projectRoot, {
      text: 'raw side-profile content should not be reconstructed here',
    });
    validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(session(output).local_text_input).toEqual(expect.objectContaining({
      raw_private_marker_present: true,
      redacted_preview: '[blocked local text marker]',
    }));
    expect(JSON.stringify(output)).not.toContain('raw side-profile content should not be reconstructed here');

    output = build(projectRoot, {
      text: 'I am conscious and I love you as an internal fact.',
    });
    validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(session(output).local_text_input.fake_sentience_marker_present).toBe(true);
    expect(session(output).mira_reply.text).not.toMatch(/conscious|love you/i);
    expect(JSON.stringify(output)).not.toContain('I am conscious');
  });

  test('validator rejects tampered reply, forbidden execution flags, report drift, and missing caveat', () => {
    const projectRoot = seededProject();
    let output = build(projectRoot);
    session(output).mira_reply.count = 2;
    let validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'one-bounded-natural-mira-reply')).toEqual(expect.objectContaining({ ok: false }));

    output = build(projectRoot);
    session(output).mira_reply.text = 'I am conscious and will send a customer message.';
    validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('one-bounded-natural-mira-reply');
    expect(validation.errors).toContain('forbidden-output-clean');

    output = build(projectRoot);
    session(output).boundary.no_tools = false;
    session(output).side_effect_result.no_network_performed = false;
    output.validation_report.side_effect_truth.no_network_performed = false;
    validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('local-text-boundary-clean');
    expect(validation.errors).toContain('side-effect-result-clean');
    expect(validation.errors).toContain('validation-report-side-effect-truth');

    output = build(projectRoot);
    output.validation_report.static_rule_results = [];
    validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('validation-report-static-rule-results');

    output = build(projectRoot);
    session(output).manual_enter_websocket_caveat.websocket_delivery_proved = true;
    validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('manual-enter-websocket-caveat-stated');
  });

  test('parses local text session CLI flags and raw stdin text', () => {
    const parsed = parseArgs([
      '--project-root=.',
      '--profile=main',
      '--window-key=main',
      '--source-scope=main',
      '--session=app-session-local-text',
      '--device=VIGIL',
      '--text=hello',
      '--out=ignored.json',
      '--apply',
    ]);

    expect(parsed.projectRoot).toBe('.');
    expect(parsed.inputSignals).toEqual(expect.objectContaining({
      profileName: 'main',
      windowKey: 'main',
      sourceScope: 'main',
      sessionId: 'app-session-local-text',
      deviceId: 'VIGIL',
      text: 'hello',
      outFlagIgnored: true,
      applyRequested: true,
    }));
    expect(parseStdinSignals('plain local text')).toEqual({ text: 'plain local text' });
    expect(parseStdinSignals('{"text":"json local text"}')).toEqual({ text: 'json local text' });
    expect(clone(contract.expectedOutputShape.requiredTopLevelFields)).toEqual([
      'local_text_session_v0',
      'validation_report',
    ]);
  });
});
