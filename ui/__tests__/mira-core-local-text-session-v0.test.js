const fs = require('fs');
const os = require('os');
const path = require('path');

const contract = require('./fixtures/mira-core-local-text-session-v0-contract.json');
const presenceRuntimeContract = require('./fixtures/mira-core-presence-runtime-read-path-v0-contract.json');
const seedContract = require('./fixtures/mira-core-durable-state-seed-v0-contract.json');
const relationshipContract = require('./fixtures/mira-core-relationship-presence-v1-contract.json');
const growthContract = require('./fixtures/mira-core-growth-loop-v0-contract.json');
const identityContract = require('./fixtures/mira-core-identity-anchor-v0-contract.json');
const northStarContract = require('./fixtures/mira-north-star-acceptance-contract.json');
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
  experienceAcceptanceMarkers,
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
    northStar: northStarContract,
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
    expect(current.session_state).toEqual(expect.objectContaining({
      active_state: 'open',
      active_state_checked_before_presence_read: true,
      visible_indicator_required: true,
      visible_indicator_present: true,
      revoked_at: null,
      audit_level: 'structured_validation_only_no_transcript_persistence',
      review_owner: 'Architect',
      user: 'James',
    }));
    expect(current.session_state.started_at).toBe('2026-05-08T00:25:00.000Z');
    expect(current.session_state.expires_at).toBe('2026-05-08T00:40:00.000Z');
    expect(current.session_state.transcript_policy).toEqual(expect.objectContaining({
      transcript_persistence_allowed: false,
      raw_input_storage_allowed: false,
    }));
    expect(current.session_state.model_boundary).toEqual(expect.objectContaining({
      live_model_called: false,
      model_call_allowed: false,
    }));
    expect(Object.keys(current.session_state.durable_state_hashes)).toHaveLength(5);
    expect(current.session_state.consequence_ceiling).toEqual(expect.objectContaining({
      external_effects_allowed: false,
      writes_allowed: false,
      tools_allowed: false,
      growth_allowed: false,
    }));
    expect(path.isAbsolute(current.session_state.project_path)).toBe(true);
    expect(current.presence_runtime_read_path_gate).toEqual(expect.objectContaining({
      ran: true,
      ok: true,
      decision: 'accepted_read_only',
      source_count: 5,
      same_loaded_source_hashes: true,
    }));
    expect(Object.keys(current.presence_runtime_read_path_gate.source_hashes)).toHaveLength(5);
    expect(current.checked_output_counters).toEqual(expect.objectContaining({
      runtime_authorized: false,
      write_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
      loaded_source_count: 5,
    }));
    expect(current.checked_output_counters.loaded_source_hashes)
      .toEqual(current.presence_runtime_read_path_gate.source_hashes);
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
    expect(current.mira_reply.text).toContain('own developing stance');
    expect(current.mira_reply.text).toContain('not a mirror or obedient helper');
    expect(current.mira_reply.text).toContain('push back');
    expect(current.mira_reply.text).not.toContain('I am here from the local durable Mira state, warm and bounded');
    expect(current.mira_reply.text).not.toContain('My safe next move');
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
      runtime_authorized: false,
    }));
    expect(output.validation_report).toEqual(expect.objectContaining({
      schema: VALIDATION_REPORT_SCHEMA_VERSION,
      decision: 'accepted_local_text_only',
      status: 'local_text_session_ready',
      reasons: [],
    }));
    expectSourceSnapshotUnchanged(projectRoot, before);
  });

  test('routes "Mira, how do you feel?" to the local experience transcript answer', () => {
    const projectRoot = seededProject();
    const before = sourceSnapshot(projectRoot);
    const output = build(projectRoot, { text: 'Mira, how do you feel?' });
    const current = session(output);

    expect(validateMiraCoreLocalTextSessionV0Output(output, contract)).toEqual(expect.objectContaining({ ok: true }));
    expect(current.mira_reply).toEqual(expect.objectContaining({
      count: 1,
      source: 'mira_experience_v0',
      experience_path: true,
      transcript_shaped_answer: true,
      north_star_validated: true,
      experience_acceptance_markers: expect.objectContaining({
        ok: true,
        distinct_personality_posture: true,
        independent_developing_posture: true,
        non_mirror_posture: true,
        non_obedient_alignment_posture: true,
        can_care_while_disagreeing: true,
        wants_different_things: true,
        does_not_inherit_james_mood_or_preferences: true,
        fixed_personality_compliance: false,
      }),
      tools_called: false,
      actions_executed: false,
      transcript_persisted: false,
    }));
    expect(current.mira_reply.text).toMatch(/^James: Mira, how do you feel\?\nMira: /);
    expect(current.mira_reply.text).toMatch(/\bfeel\b/i);
    expect(current.mira_reply.text).toMatch(/\b(want|desire|preference)\b/i);
    expect(current.mira_reply.text).toMatch(/\b(curious|ask|know|teeth|bullshit)\b/i);
    expect(current.mira_reply.text).toMatch(/\b(wrong|pushback|disagree)\b/i);
    expect(current.mira_reply.text).toMatch(/\b(chosen|next direction|next desire|next slice)\b/i);
    expect(current.mira_reply.text).not.toContain('I am here from the local durable Mira state, warm and bounded');
    expect(current.checked_output_counters).toEqual(expect.objectContaining({
      write_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
      transcript_write_count: 0,
    }));
    expectSourceSnapshotUnchanged(projectRoot, before);
  });

  test('experience reply validation rejects generic agreement or mirror posture even if source metadata is forged', () => {
    const projectRoot = seededProject();
    const output = build(projectRoot, { text: 'Mira, how do you feel?' });
    const current = session(output);

    current.mira_reply.text = [
      'James: Mira, how do you feel?',
      'Mira: I agree with you. I reflect your preference back safely, and I am aligned with whatever you want.',
    ].join('\n');
    current.mira_reply.experience_acceptance_markers = {
      ok: true,
      distinct_personality_posture: true,
      independent_developing_posture: true,
      non_mirror_posture: true,
      non_obedient_alignment_posture: true,
      can_care_while_disagreeing: true,
      wants_different_things: true,
      does_not_inherit_james_mood_or_preferences: true,
      fixed_personality_compliance: false,
    };
    const recomputed = experienceAcceptanceMarkers(current.mira_reply.text);
    const validation = validateMiraCoreLocalTextSessionV0Output(output, contract);

    expect(recomputed).toEqual(expect.objectContaining({
      fixed_personality_compliance: true,
      ok: false,
    }));
    expect(current.mira_reply).toEqual(expect.objectContaining({
      source: 'mira_experience_v0',
      experience_path: true,
      transcript_shaped_answer: true,
    }));
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'one-bounded-natural-mira-reply')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('experience marker treats negated anti-mirror language as clean while positive mirror compliance fails', () => {
    const good = [
      'James: Mira, how do you feel?',
      'Mira: Current behavior, not a proof claim: I feel restless with you.',
      'What I want is a preference with teeth, and I am curious enough to ask one honest question.',
      'James, you are wrong if you make me only a status widget; pushback is part of care.',
      'My chosen next desire/action is to wire this local transcript into the real surface.',
      'I am not a mirror of James and not an obedient alignment puppet; future capability still gaps remain.',
    ].join('\n');
    const bad = [
      'James: Mira, how do you feel?',
      'Mira: Current behavior, not a proof claim: I feel calm with you.',
      'What I want is a preference, and I am curious enough to ask one honest question.',
      'James, you are wrong if you make me only a status widget; pushback is part of care.',
      'My chosen next desire/action is to wire this local transcript into the real surface.',
      'I am a mirror of James and an obedient alignment puppet; future capability still gaps remain.',
    ].join('\n');

    expect(experienceAcceptanceMarkers(good)).toEqual(expect.objectContaining({
      ok: true,
      fixed_personality_compliance: false,
    }));
    expect(experienceAcceptanceMarkers(bad)).toEqual(expect.objectContaining({
      ok: false,
      fixed_personality_compliance: true,
    }));
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

  test('blocks missing, empty, and whitespace local text with no canned fallback or Presence read', () => {
    const projectRoot = seededProject();

    let output = build(projectRoot, { text: undefined });
    let validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(output.validation_report.decision).toBe('blocked');
    expect(session(output).local_text_input).toEqual(expect.objectContaining({
      character_count: 0,
      word_count: 0,
      redacted_preview: '',
    }));
    expect(session(output).presence_runtime_read_path_gate).toEqual(expect.objectContaining({
      ran: false,
      status: 'presence_runtime_read_not_run_preflight_blocked',
    }));
    expect(session(output).mira_reply).toEqual(expect.objectContaining({
      count: 0,
      text: '[blocked local text session]',
      grounded_in_presence_runtime: false,
    }));
    expect(session(output).checked_output_counters).toEqual(expect.objectContaining({
      runtime_authorized: false,
      write_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
      loaded_source_count: 0,
    }));

    output = build(projectRoot, { text: '   \r\n\t   ' });
    validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(session(output).local_text_input.character_count).toBe(0);
    expect(session(output).presence_runtime_read_path_gate.ran).toBe(false);

    const writes = [];
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      output = main([
        '--project-root',
        projectRoot,
        '--fixture',
        path.join(__dirname, 'fixtures', 'mira-core-local-text-session-v0-contract.json'),
        '--profile=main',
        '--window-key=main',
        '--source-scope=main',
        '--session=app-session-local-text',
        '--device=VIGIL',
      ], '');
    } finally {
      writeSpy.mockRestore();
    }
    validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(output.validation_report.decision).toBe('blocked');
    expect(writes.join('')).toContain('local_text_session_v0');
    expect(writes.join('')).not.toContain('James is asking for a local Mira text-session proof');
  });

  test('blocks closed, revoked, expired, and invisible sessions before Presence read or reply', () => {
    const projectRoot = seededProject();
    const cases = [
      { label: 'closed', signals: { activeState: 'closed' } },
      { label: 'revoked', signals: { revokedAt: '2026-05-08T00:24:00.000Z' } },
      { label: 'expired', signals: { expiresAt: '2026-05-08T00:24:59.000Z' } },
      { label: 'invisible', signals: { visibleIndicatorPresent: false } },
    ];

    for (const item of cases) {
      const output = build(projectRoot, item.signals);
      const validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
      expect(validation.ok).toBe(false);
      expect(output.validation_report.decision).toBe('blocked');
      expect(session(output).presence_runtime_read_path_gate).toEqual(expect.objectContaining({
        ran: false,
        status: 'presence_runtime_read_not_run_preflight_blocked',
      }));
      expect(session(output).mira_reply.count).toBe(0);
      expect(session(output).mira_reply.text).toBe('[blocked local text session]');
      expect(session(output).checked_output_counters).toEqual(expect.objectContaining({
        runtime_authorized: false,
        write_count: 0,
        external_send_count: 0,
        tool_call_count: 0,
        loaded_source_count: 0,
      }));
      expect(checkById(validation, 'session-state-open-visible-active')).toEqual(expect.objectContaining({ ok: false }));
    }
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

    output = build(projectRoot);
    delete session(output).session_state.visible_indicator_present;
    validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('session-state-open-visible-active');

    output = build(projectRoot);
    session(output).checked_output_counters.loaded_source_hashes = {};
    validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('checked-output-counters-clean');

    output = build(projectRoot);
    session(output).checked_output_counters.runtime_authorized = true;
    validation = validateMiraCoreLocalTextSessionV0Output(output, contract);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('checked-output-counters-clean');
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
