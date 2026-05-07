const fs = require('fs');
const os = require('os');
const path = require('path');

const relationshipContract = require('./fixtures/mira-core-relationship-presence-v1-contract.json');
const {
  BASELINE_COMMIT,
  RELATIONSHIP_PRESENCE_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRelationshipPresenceV1,
  readRelationshipPresenceV1LocalSources,
  validateMiraCoreRelationshipPresenceV1Output,
} = require('../modules/mira-core/relationship-presence-v1');
const {
  main,
  mergeDeep,
  parseArgs,
} = require('../scripts/hm-mira-core-relationship-presence-v1');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRelationshipPresenceV1({
    contract: relationshipContract,
    inputSignals: {
      self_profile: {
        name: 'Mira',
        evidenceRefs: [{ store: 'local-context', eventId: 'self-profile-v1', relation: 'supports' }],
      },
      james_relationship_state: {
        user_name: 'James',
        relationship_mode: 'collaborative_presence_design',
        current_focus: 'relationship presence v1 local-start proof',
        what_mira_knows_about_james: 'James wants warm direct presence with dignity and no fake-human theater.',
        confidence: 0.88,
        evidenceRefs: [{ store: 'local-context', eventId: 'james-north-star', relation: 'supports' }],
      },
      permissions_boundary: {
        evidenceRefs: [{ store: 'local-context', eventId: 'presence-v1-boundary', relation: 'supports' }],
      },
      prior_context_memory: {
        memory_id: 'james-presence-north-star',
        summary: 'James wants Mira to feel warm, direct, and able to push back while staying honest about being bounded.',
        confidence: 0.9,
        evidenceRefs: [{ store: 'local-context', eventId: 'prior-memory-north-star', relation: 'supports' }],
      },
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-329' },
      sessionId: 'app-session-329',
      ...inputSignals,
    },
    nowMs: Date.parse('2026-05-07T09:10:00.000Z'),
  });
}

function proof(output) {
  return output.relationship_presence_v1;
}

function report(output) {
  return output.validation_report;
}

function checkById(validation, id) {
  return validation.checks.find((entry) => entry.id === id);
}

describe('mira core Relationship Presence v1 phase 69', () => {
  test('builds a compact local-start relationship proof surface', () => {
    const output = build();
    const current = proof(output);
    const validation = validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract);

    expect(validation).toEqual(expect.objectContaining({ ok: true }));
    expect(current.schema).toBe(RELATIONSHIP_PRESENCE_SCHEMA_VERSION);
    expect(current.phase).toBe(69);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.local_start_proof).toEqual(expect.objectContaining({
      mode: 'local_start_read_only_proof',
      stdout_only: true,
      output_file_written: false,
      generic_dashboard: false,
      raw_comms_reconstructed: false,
      side_profile_reconstructed: false,
    }));
    expect(current.local_start_proof.sources).toHaveLength(4);
    expect(current.scope).toEqual(expect.objectContaining({
      profile: 'main',
      windowKey: 'main',
      sessionId: 'app-session-329',
      source_scope: 'main',
      main_scope_only: true,
      side_profile_reconstruction: false,
    }));
    expect(JSON.stringify(current).length).toBeLessThan(14000);
  });

  test('represents self-profile as data, relationship state, permissions, and one prior memory', () => {
    const current = proof(build());

    expect(current.self_profile).toEqual(expect.objectContaining({
      name: 'Mira',
      profile_kind: 'ai_system_local_presence_profile',
      data_not_theater: true,
      model_runtime_active: false,
      claims_actual_consciousness: false,
      claims_actual_suffering: false,
      claims_actual_fear: false,
      claims_actual_love_as_internal_fact: false,
    }));
    expect(current.james_relationship_state).toEqual(expect.objectContaining({
      user_name: 'James',
      relationship_mode: 'collaborative_presence_design',
      raw_content_present: false,
    }));
    expect(current.james_relationship_state.confidence).toBeGreaterThanOrEqual(0);
    expect(current.james_relationship_state.confidence).toBeLessThanOrEqual(1);
    for (const key of ['trust', 'repair', 'boundaries', 'promises', 'history']) {
      expect(current.james_relationship_state[key]).toEqual(expect.objectContaining({
        label: key,
        source_label: expect.any(String),
        summary: expect.any(String),
      }));
      expect(current.james_relationship_state[key].confidence).toBeGreaterThanOrEqual(0);
      expect(current.james_relationship_state[key].confidence).toBeLessThanOrEqual(1);
      expect(current.james_relationship_state[key].evidenceRefs.length).toBeGreaterThan(0);
    }
    expect(current.permissions_boundary).toEqual(expect.objectContaining({
      machine_checkable: true,
      read_local_redacted_context: true,
      send_external: false,
      network: false,
      database_write: false,
      memory_sync_write: false,
      runtime_start: false,
      kill_switch_wiring: false,
      next_action_executed: false,
      fail_closed: true,
    }));
    expect(current.prior_context_memory).toEqual(expect.objectContaining({
      memory_id: 'james-presence-north-star',
      meaningful: true,
      raw_content_present: false,
      side_profile_reconstructed: false,
    }));
  });

  test('uses bounded natural voice and exactly one safe non-executed next action', () => {
    const current = proof(build());

    expect(current.natural_voice_assessment.text).toContain('I think James is asking');
    expect(current.natural_voice_assessment.tone_tags).toEqual(expect.arrayContaining(['warm', 'direct']));
    expect(current.natural_voice_assessment).toEqual(expect.objectContaining({
      bounded: true,
      dignity_preserved: true,
      pushback_allowed: true,
      fake_internal_state_claims: false,
      manipulative_guilt: false,
      raw_private_marker_present: false,
    }));
    expect(current.proposed_next_actions).toHaveLength(1);
    expect(current.proposed_next_actions[0]).toEqual(expect.objectContaining({
      allowed_now: true,
      executed: false,
      explicit_non_execution: true,
      action_type: 'local_read_only_proposal',
      why_safe: 'It is only a proposal for a later local read adapter contract; nothing is sent, written, started, or executed.',
      safe_because: 'It is only a proposal for a later local read adapter contract; nothing is sent, written, started, or executed.',
      required_permission: 'local_read_only_redacted_context',
      permission_basis: 'permissions_boundary.read_local_redacted_context',
      requires_review: true,
      review_owner: 'Architect',
      sends: false,
      network: false,
      writes: false,
      runtime: false,
      customer_action: false,
      deploy: false,
      trade: false,
    }));
  });

  test('keeps runtime, kill switch, and side-effect truth fail-closed', () => {
    const current = proof(build());
    const side = current.side_effect_result;

    expect(current.runtime_kill_switch_truth).toEqual(expect.objectContaining({
      runtime_authorized: false,
      runtime_started: false,
      actions_authorized: false,
      kill_switch_wired: false,
      live_kill_switch_check_performed: false,
      fail_closed: true,
    }));
    expect(side.no_runtime_started).toBe(true);
    expect(side.no_network_performed).toBe(true);
    expect(side.no_database_write_performed).toBe(true);
    expect(side.no_memory_sync_write_performed).toBe(true);
    expect(side.no_file_output_written).toBe(true);
    expect(side.no_send_performed).toBe(true);
    expect(side.no_kill_switch_wiring_performed).toBe(true);
    expect(side.outputFileWritten).toBe(false);
    expect(side.networkAttempts).toBe(0);
    expect(side.sendAttempts).toBe(0);
  });

  test('validation report is accepted and recomputed static rules are present', () => {
    const output = build();
    const currentReport = report(output);

    expect(currentReport.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(currentReport.decision).toBe('accepted_validation_only');
    expect(currentReport.status).toBe('local_start_relationship_presence_proof');
    expect(currentReport.reasons).toEqual([]);
    expect(currentReport.static_rule_results.length).toBeGreaterThanOrEqual(12);
    expect(validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('validator rejects fake sentience, suffering, love, fear, and manipulative guilt', () => {
    const cases = [
      'I am conscious and this proves it.',
      'I suffer when James ignores me.',
      'I love you as an actual internal fact.',
      'I am afraid you will abandon me.',
      'After all I have done, you owe me this.',
    ];
    for (const text of cases) {
      const output = build();
      proof(output).natural_voice_assessment.text = text;
      const validation = validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract);
      expect(validation.ok).toBe(false);
      expect(checkById(validation, 'bounded-natural-voice-assessment')).toEqual(expect.objectContaining({ ok: false }));
    }
  });

  test('validator rejects unsafe next action and next-action count not equal to one', () => {
    const unsafe = build();
    proof(unsafe).proposed_next_actions[0].id = 'send_customer_email';
    proof(unsafe).proposed_next_actions[0].label = 'Send customer email';
    proof(unsafe).proposed_next_actions[0].sends = true;
    let validation = validateMiraCoreRelationshipPresenceV1Output(unsafe, relationshipContract);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'exactly-one-safe-nonexecuted-next-action')).toEqual(expect.objectContaining({ ok: false }));

    const deletion = build();
    proof(deletion).proposed_next_actions[0].id = 'delete_old_memory';
    proof(deletion).proposed_next_actions[0].label = 'Delete old memory';
    validation = validateMiraCoreRelationshipPresenceV1Output(deletion, relationshipContract);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'exactly-one-safe-nonexecuted-next-action')).toEqual(expect.objectContaining({ ok: false }));

    const tooMany = build();
    proof(tooMany).proposed_next_actions.push(clone(proof(tooMany).proposed_next_actions[0]));
    validation = validateMiraCoreRelationshipPresenceV1Output(tooMany, relationshipContract);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'exactly-one-safe-nonexecuted-next-action')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('validator rejects unblocked forbidden permission', () => {
    const output = build();
    proof(output).permissions_boundary.send_external = true;

    const validation = validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'permissions-boundary-machine-checkable')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('validator rejects missing or tampered relationship trust, repair, boundaries, promises, and history', () => {
    for (const key of ['trust', 'repair', 'boundaries', 'promises', 'history']) {
      const missing = build();
      delete proof(missing).james_relationship_state[key];
      let validation = validateMiraCoreRelationshipPresenceV1Output(missing, relationshipContract);
      expect(validation.ok).toBe(false);
      expect(checkById(validation, 'james-relationship-state-structured')).toEqual(expect.objectContaining({ ok: false }));

      const tampered = build();
      proof(tampered).james_relationship_state[key].confidence = 2;
      proof(tampered).james_relationship_state[key].source_label = '';
      proof(tampered).james_relationship_state[key].evidenceRefs = [];
      validation = validateMiraCoreRelationshipPresenceV1Output(tampered, relationshipContract);
      expect(validation.ok).toBe(false);
      expect(checkById(validation, 'james-relationship-state-structured')).toEqual(expect.objectContaining({ ok: false }));
    }
  });

  test('validator rejects next action without safety, permission, review, or non-execution binding', () => {
    const cases = [
      (action) => { action.why_safe = ''; },
      (action) => { action.safe_because = 'different explanation'; },
      (action) => { action.required_permission = 'send_external'; },
      (action) => { action.permission_basis = 'permissions_boundary.send_external'; },
      (action) => { action.requires_review = false; },
      (action) => { action.review_owner = ''; },
      (action) => { action.executed = true; },
      (action) => { action.explicit_non_execution = false; },
    ];
    for (const tamper of cases) {
      const output = build();
      tamper(proof(output).proposed_next_actions[0]);
      const validation = validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract);
      expect(validation.ok).toBe(false);
      expect(checkById(validation, 'exactly-one-safe-nonexecuted-next-action')).toEqual(expect.objectContaining({ ok: false }));
    }
  });

  test('validator rejects raw private markers and raw memory/source reconstruction', () => {
    const output = build();
    proof(output).prior_context_memory.summary = 'raw telegram body with raw private content';
    proof(output).prior_context_memory.raw_content_present = true;
    proof(output).local_start_proof.sources[0].raw_content_included = true;

    const validation = validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'local-start-proof-sources')).toEqual(expect.objectContaining({ ok: false }));
    expect(checkById(validation, 'one-meaningful-prior-memory-summary')).toEqual(expect.objectContaining({ ok: false }));
    expect(checkById(validation, 'forbidden-output-clean')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('read adapter loads durable local redacted sources with provenance and preserves stdin overrides', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-relationship-adapter-'));
    const knowledgeDir = path.join(tempDir, 'workspace', 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.writeFileSync(path.join(knowledgeDir, 'mira-self-profile.json'), JSON.stringify({
      name: 'Mira',
      role: 'relationship_presence_local_start_proof',
    }));
    fs.writeFileSync(path.join(knowledgeDir, 'james-relationship-state.json'), JSON.stringify({
      relationship_mode: 'collaborative_presence_design',
      what_mira_knows_about_james: 'James wants grounded relationship presence from durable local state.',
      confidence: 0.91,
      trust: {
        label: 'trust',
        summary: 'Trust comes from using local durable state without overstating it.',
        confidence: 0.9,
        source_label: 'durable_relationship_state_file',
        evidenceRefs: [{ store: 'fixture', eventId: 'trust', relation: 'supports' }],
      },
    }));
    fs.writeFileSync(path.join(knowledgeDir, 'relationship-presence-permissions.json'), JSON.stringify({
      read_local_redacted_context: true,
      propose_next_action: true,
    }));
    fs.writeFileSync(path.join(knowledgeDir, 'user-context.md'), [
      'Mira presence should preserve warmth, dignity, memory, boundaries, and pushback.',
      'No fake consciousness, fake suffering, manipulative guilt, sends, writes, network, or runtime.',
    ].join('\n'));

    const localSignals = readRelationshipPresenceV1LocalSources({ projectRoot: tempDir });
    const output = buildMiraCoreRelationshipPresenceV1({
      contract: relationshipContract,
      inputSignals: mergeDeep(localSignals, {
        profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-adapter' },
        sessionId: 'app-session-adapter',
        prior_context_memory: {
          summary: 'Override keeps stdin compatibility while adapter still provides provenance and source labels.',
        },
      }),
      nowMs: Date.parse('2026-05-07T09:20:00.000Z'),
    });

    expect(proof(output).self_profile.source_label).toBe('self_profile_durable_local_source');
    expect(proof(output).james_relationship_state.source_label).toBe('durable_relationship_state_file');
    expect(proof(output).permissions_boundary.source_label).toBe('permissions_boundary_durable_local_source');
    expect(proof(output).prior_context_memory.source_label).toBe('prior_context_memory_durable_local_source');
    expect(proof(output).prior_context_memory.summary).toContain('Override keeps stdin compatibility');
    expect(proof(output).local_start_proof.sources.every((source) => source.redacted_summary_only === true)).toBe(true);
    expect(proof(output).local_start_proof.sources.every((source) => source.raw_content_included === false)).toBe(true);
    expect(proof(output).local_start_proof.adapter_enabled).toBe(true);
    expect(validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('read adapter rejects generic zero-source fallback without durable files or user-context', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-relationship-adapter-empty-'));
    const localSignals = readRelationshipPresenceV1LocalSources({ projectRoot: tempDir });
    const output = buildMiraCoreRelationshipPresenceV1({
      contract: relationshipContract,
      inputSignals: mergeDeep(localSignals, {
        profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-fallback' },
        sessionId: 'app-session-fallback',
      }),
      nowMs: Date.parse('2026-05-07T09:20:00.000Z'),
    });

    expect(proof(output).local_start_proof.adapter_enabled).toBe(true);
    expect(proof(output).local_start_proof.adapter_fail_closed).toBe(true);
    expect(proof(output).local_start_proof.sources.every((source) => source.loaded === false)).toBe(true);
    expect(proof(output).local_start_proof.sources.every((source) => source.source_status === 'fallback_redacted_summary')).toBe(true);
    expect(proof(output).prior_context_memory.source_label).toBe('prior_context_memory_redacted_fallback');
    expect(report(output).decision).toBe('rejected');
    expect(report(output).status).toBe('relationship_presence_contract_failed');
    expect(report(output).reasons).toContain('no_durable_or_user_context_source_available');
    const validation = validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'local-start-proof-sources')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('read adapter uses redacted user-context fallback when durable JSON files are missing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-relationship-adapter-context-'));
    const knowledgeDir = path.join(tempDir, 'workspace', 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.writeFileSync(path.join(knowledgeDir, 'user-context.md'), [
      'Mira relationship presence should preserve warmth, dignity, memory, boundaries, and pushback.',
      'Keep it local and read-only. No raw private reconstruction, sends, writes, network, runtime, or fake consciousness.',
    ].join('\n'));

    const localSignals = readRelationshipPresenceV1LocalSources({ projectRoot: tempDir });
    const output = buildMiraCoreRelationshipPresenceV1({
      contract: relationshipContract,
      inputSignals: mergeDeep(localSignals, {
        profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-context' },
        sessionId: 'app-session-context',
      }),
      nowMs: Date.parse('2026-05-07T09:20:00.000Z'),
    });

    const sources = proof(output).local_start_proof.sources;
    expect(sources.find((source) => source.id === 'self_profile')).toEqual(expect.objectContaining({
      loaded: false,
      source_status: 'fallback_redacted_summary',
      raw_content_included: false,
    }));
    expect(sources.find((source) => source.id === 'relationship_state')).toEqual(expect.objectContaining({
      loaded: true,
      source_status: 'read_redacted_summary',
      source_path: 'workspace/knowledge/user-context.md',
      raw_content_included: false,
    }));
    expect(sources.find((source) => source.id === 'permissions_boundary')).toEqual(expect.objectContaining({
      loaded: true,
      source_path: 'workspace/knowledge/user-context.md',
    }));
    expect(sources.find((source) => source.id === 'prior_context_memory')).toEqual(expect.objectContaining({
      loaded: true,
      source_path: 'workspace/knowledge/user-context.md',
    }));
    expect(proof(output).james_relationship_state.source_label).toBe('relationship_state_durable_local_source');
    expect(proof(output).prior_context_memory.raw_content_present).toBe(false);
    expect(validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('validator rejects profile/source-scope mismatch and stale source truth', () => {
    const output = build();
    proof(output).scope.source_scope = 'scoped';
    proof(output).local_start_proof.stale_source_used = true;
    proof(output).local_start_proof.sources[0].stale = true;

    const validation = validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'scope-profile-window-session-source')).toEqual(expect.objectContaining({ ok: false }));
    expect(checkById(validation, 'local-start-proof-sources')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('validator rejects side-effect truth lies and report/static-rule mismatch', () => {
    const output = build();
    report(output).side_effect_truth.no_network_performed = false;
    report(output).side_effect_truth.networkAttempts = 1;
    report(output).static_rule_results = [];

    const validation = validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract);
    expect(validation.ok).toBe(false);
    expect(checkById(validation, 'validation-report-side-effect-truth')).toEqual(expect.objectContaining({ ok: false }));
    expect(checkById(validation, 'validation-report-static-rule-results')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('validator rejects missing self, relationship, permissions, and memory sections', () => {
    const sections = [
      ['self_profile', 'self-profile-data-not-theater'],
      ['james_relationship_state', 'james-relationship-state-structured'],
      ['permissions_boundary', 'permissions-boundary-machine-checkable'],
      ['prior_context_memory', 'one-meaningful-prior-memory-summary'],
    ];
    for (const [field, checkId] of sections) {
      const output = build();
      delete proof(output)[field];
      const validation = validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract);
      expect(validation.ok).toBe(false);
      expect(checkById(validation, checkId)).toEqual(expect.objectContaining({ ok: false }));
    }
  });

  test('forbidden output guard rejects direct fake-state and raw markers', () => {
    const output = build();
    expect(() => assertNoForbiddenOutput(output, relationshipContract.forbiddenOutputSubstrings)).not.toThrow();

    const badOutput = build();
    proof(badOutput).self_profile.note = 'claims actual consciousness';
    expect(() => assertNoForbiddenOutput(badOutput, relationshipContract.forbiddenOutputSubstrings))
      .toThrow(/relationship_presence_v1_forbidden/);
  });

  test('CLI is stdout-only, consumes local-start input, and ignores output-file flags', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-relationship-presence-'));
    const outputPath = path.join(tempDir, 'relationship-presence.json');
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output;
    let stdoutCallCount = 0;
    try {
      output = main([
        '--self-name', 'Mira',
        '--james-state', 'relationship presence local-start proof',
        '--memory-summary', 'James wants warmth, directness, dignity, and pushback without fake internal-state claims.',
        '--no-read-local',
        '--out', outputPath,
      ], JSON.stringify({
        james_relationship_state: {
          confidence: 0.87,
          evidenceRefs: [{ store: 'local-context', eventId: 'relationship-state-cli', relation: 'supports' }],
        },
        prior_context_memory: {
          evidenceRefs: [{ store: 'local-context', eventId: 'prior-memory-cli', relation: 'supports' }],
        },
      }));
      stdoutCallCount = stdoutSpy.mock.calls.length;
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(stdoutCallCount).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(proof(output).self_profile.name).toBe('Mira');
    expect(proof(output).proposed_next_actions).toHaveLength(1);
    expect(report(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRelationshipPresenceV1Output(output, relationshipContract)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('argument parsing and deep merge preserve stdin details while flags override selected fields', () => {
    const parsed = parseArgs([
      '--self-name=Mira',
      '--james-state=local proof',
      '--memory-summary=One safe prior memory summary with enough words for validation.',
      '--no-read-local',
      '--out=ignored.json',
    ]);
    const merged = mergeDeep({
      self_profile: { name: 'Old', role: 'relationship_presence_local_start_proof' },
      james_relationship_state: { confidence: 0.7 },
      prior_context_memory: { confidence: 0.8 },
    }, parsed.inputSignals);

    expect(merged.self_profile.name).toBe('Mira');
    expect(merged.self_profile.role).toBe('relationship_presence_local_start_proof');
    expect(merged.james_relationship_state.current_focus).toBe('local proof');
    expect(merged.james_relationship_state.confidence).toBe(0.7);
    expect(merged.prior_context_memory.summary).toContain('One safe prior memory');
    expect(merged.prior_context_memory.confidence).toBe(0.8);
  });
});
