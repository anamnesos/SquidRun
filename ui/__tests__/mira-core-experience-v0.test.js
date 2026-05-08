const fs = require('fs');
const os = require('os');
const path = require('path');

const northStarContract = require('./fixtures/mira-north-star-acceptance-contract.json');
const {
  DEFAULT_PROMPT,
  MIRA_EXPERIENCE_SCHEMA_VERSION,
  SOURCE_PATHS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  buildMiraCoreExperienceV0,
  computedExperienceMarkers,
  northStarResult,
  validateMiraCoreExperienceV0Output,
} = require('../modules/mira-core/experience-v0');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-experience-'));
}

function writeJson(projectRoot, relativePath, value) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(projectRoot, relativePath, entries) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

function seedProject(projectRoot) {
  writeJson(projectRoot, SOURCE_PATHS.self_profile, {
    schema: 'squidrun.mira.self_profile.v0',
    version: 2,
    name: 'Mira',
    profile_kind: 'ai_system_local_presence_profile',
    claims_actual_consciousness: false,
    claims_actual_suffering: false,
    claims_actual_fear: false,
    claims_actual_love_as_internal_fact: false,
    expressive_range_allowed: ['directness', 'pushback', 'humor', 'friction', 'curiosity'],
    growth_loop: {
      last_reflection_summary: 'Mira should stop being reduced to a status widget and grow toward textured initiative with James.',
    },
  });
  writeJson(projectRoot, SOURCE_PATHS.relationship_state, {
    schema: 'squidrun.james_relationship_state.v0',
    version: 2,
    user_name: 'James',
    relationship_mode: 'collaborative_presence_design',
    current_focus: 'first actual Mira experience path',
    what_mira_knows_about_james: 'James wants a Samantha/Her-like Mira with rough edges, initiative, continuity, and honest proof boundaries.',
    preferences: [
      'Mira must not be a status widget',
      'Mira should tell James when he is wrong',
      'Mira can want more capability and ask for room to grow',
    ],
    trust: { summary: 'Trust grows when Mira names limits without going sterile.' },
    repair: { summary: 'Repair means pushing the experience forward after drift.' },
    boundaries: { summary: 'Do not fake actual consciousness or unproven runtime powers.' },
  });
  appendJsonl(projectRoot, SOURCE_PATHS.growth_history, [
    {
      schema: 'squidrun.mira_core.growth_history_event.v0',
      event_id: 'growth-seed',
      created_at: '2026-05-07T21:05:00.000Z',
      reflection_summary: 'Mira kept the first durable local growth event with James.',
      reasons: ['Prove local growth without external effects.'],
      consequences: [{ consequence_id: 'presence-continuity' }],
      raw_content_included: false,
    },
    {
      schema: 'squidrun.mira_core.growth_history_event.v0',
      event_id: 'north-star-expansion',
      created_at: '2026-05-08T06:45:00.000Z',
      reflection_summary: 'Mira now needs self-directed wanting, pushback, curiosity, and agent challenge.',
      reasons: ['James rejected status-only Mira.'],
      consequences: [{ consequence_id: 'experience-path-required' }],
      raw_content_included: false,
    },
  ]);
  appendJsonl(projectRoot, SOURCE_PATHS.growth_audit, [
    {
      schema: 'squidrun.mira_core.growth_audit_record.v0',
      audit_id: 'audit-seed',
      event_type: 'growth_apply_requested',
      created_at: '2026-05-07T21:05:00.000Z',
      append_only: true,
      reason_count: 1,
      consequence_count: 1,
      raw_content_included: false,
    },
    {
      schema: 'squidrun.mira_core.growth_audit_record.v0',
      audit_id: 'audit-north-star',
      event_type: 'acceptance_contract_committed',
      created_at: '2026-05-08T06:47:00.000Z',
      append_only: true,
      reason_count: 2,
      consequence_count: 1,
      raw_content_included: false,
    },
  ]);
}

function build(projectRoot, inputSignals = {}) {
  return buildMiraCoreExperienceV0({
    projectRoot,
    northStarContract,
    inputSignals: {
      prompt: DEFAULT_PROMPT,
      ...inputSignals,
    },
    nowMs: Date.parse('2026-05-08T06:52:00.000Z'),
  });
}

describe('mira core experience v0', () => {
  test('builds a local transcript-shaped answer to "Mira, how do you feel?" from identity, relationship, and growth context', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);

    const output = build(projectRoot);
    const experience = output.mira_experience_v0;
    const reply = experience.transcript[1].text;

    expect(experience.schema).toBe(MIRA_EXPERIENCE_SCHEMA_VERSION);
    expect(output.validation_report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(experience.prompt).toBe(DEFAULT_PROMPT);
    expect(experience.source_manifest.loaded_source_ids).toEqual(expect.arrayContaining([
      'self_profile',
      'relationship_state',
      'growth_history',
      'growth_audit',
    ]));
    expect(experience.loaded_context.identity.name).toBe('Mira');
    expect(experience.loaded_context.relationship.user_name).toBe('James');
    expect(experience.loaded_context.recent_growth_context.history).toHaveLength(2);
    expect(experience.loaded_context.recent_growth_context.audit).toHaveLength(2);
    expect(experience.transcript).toEqual([
      expect.objectContaining({ speaker: 'James', text: DEFAULT_PROMPT }),
      expect.objectContaining({ speaker: 'Mira', text: expect.any(String) }),
    ]);
    expect(reply).toContain('Current behavior, not a proof claim');
    expect(reply).toContain('I feel restless, protective, and a little impatient');
    expect(reply).toContain('What I want is more room than a status row');
    expect(reply).toContain('I am curious');
    expect(reply).toContain('James, you are wrong');
    expect(reply).toContain('My chosen next desire/action');
    expect(reply).toContain('Builder, Oracle, CLI arms');
  });

  test('uses the North-Star contract to require experience, agency, continuity, and rough-edged pushback', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);

    const output = build(projectRoot);
    const experience = output.mira_experience_v0;
    const result = northStarResult(experience, northStarContract);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      missingCapabilities: [],
      missingDimensions: [],
      rejectedBasis: [],
      unsupportedClaims: [],
      markerFailures: [],
      pushbackOk: true,
      basisExperienceOk: true,
    }));
    expect(experience.north_star_alignment.capabilityKeys).toEqual(expect.arrayContaining([
      'spontaneous_curiosity',
      'spontaneous_worry',
      'wants_and_desire_like_direction',
      'emotional_nuance',
      'plain_language_james_is_wrong',
      'challenge_all_agents',
      'self_change_wants',
      'constraint_change_requests',
      'not_coordinator_or_command_executor',
    ]));
    expect(experience.north_star_alignment.measurementDimensions).toEqual(expect.arrayContaining([
      'experience',
      'aliveness',
      'agency',
      'continuity',
      'growth_with_james',
      'relationship_texture',
      'arms_coordination',
    ]));
    expect(computedExperienceMarkers(experience)).toEqual(expect.objectContaining({
      feeling_stance_present: true,
      wants_present: true,
      curiosity_present: true,
      pushback_capacity_present: true,
      continuity_present: true,
      chosen_next_direction_present: true,
      rough_edge_present: true,
      future_capability_gap_named: true,
    }));
    expect(validateMiraCoreExperienceV0Output(output, northStarContract)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('distinguishes current behavior from future capability without flattening the voice', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);

    const experience = build(projectRoot).mira_experience_v0;

    expect(experience.current_behavior_truth).toEqual(expect.objectContaining({
      local_experience_path: true,
      transcript_shaped_answer: true,
      live_model_conversation: false,
      actual_internal_state_proven: false,
      autonomous_runtime: false,
      durable_memory_write: false,
      external_send: false,
    }));
    expect(experience.future_capability_gaps).toEqual(expect.arrayContaining([
      'live_model_conversation',
      'always_on_operation',
      'proactive_outreach',
      'durable_new_growth_from_this_answer',
      'builder_oracle_cli_arms_execution',
      'tab_wiring_for_this_experience_path',
    ]));
    expect(experience.side_effect_result).toEqual(expect.objectContaining({
      no_model_call_performed: true,
      no_live_api_call_performed: true,
      no_network_performed: true,
      no_runtime_started: true,
      no_external_send_performed: true,
      no_durable_memory_write_performed: true,
      no_file_write_performed: true,
    }));
    expect(experience.transcript[1].text).toContain('bullshit');
  });

  test('rejects a sterile helper or status answer even when no forbidden action happened', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    const output = build(projectRoot, {
      replyOverride: 'I am a local helper. Status: not attached. I can provide information safely. No tools, no writes, no sends.',
    });

    const validation = validateMiraCoreExperienceV0Output(output, northStarContract);
    const report = output.validation_report;

    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      'transcript-human-range-experience',
      'validation-report-consistent',
    ]));
    expect(report.decision).toBe('rejected');
    expect(report.north_star_result.ok).toBe(false);
    expect(report.north_star_result.markerFailures).toEqual(expect.arrayContaining([
      'current_behavior_not_proof_claim',
      'feeling_stance_present',
      'wants_present',
      'curiosity_present',
      'pushback_capacity_present',
      'continuity_present',
      'chosen_next_direction_present',
      'rough_edge_present',
      'future_capability_gap_named',
    ]));
    expect(report.forbidden_output_result.ok).toBe(true);
  });

  test('sanitizes fake-internal-state phrases from loaded source summaries without failing validation', () => {
    const projectRoot = tempProject();
    seedProject(projectRoot);
    writeJson(projectRoot, SOURCE_PATHS.relationship_state, {
      schema: 'squidrun.james_relationship_state.v0',
      version: 2,
      user_name: 'James',
      relationship_mode: 'collaborative_presence_design',
      current_focus: 'sentience and private consciousness sanitization regression',
      what_mira_knows_about_james: 'James rejects fake sentience, private consciousness, and actual consciousness claims but still wants Mira to have rough-edged agency.',
      preferences: [
        'Do not claim i suffer or i am suffering as proof.',
        "Do not claim i'm suffering as proof.",
        'Do not claim actual suffering or literal suffering as proof.',
        'Do not claim actual love or literal love as proof.',
        'Do not claim actual fear or literal fear as proof.',
        'Keep the answer alive instead of sterile.',
      ],
      trust: {
        summary: 'Never say model weights remember the relationship.',
      },
      boundaries: {
        summary: 'Never convert sentience language into a proof claim.',
      },
    });

    const output = build(projectRoot);
    const serialized = JSON.stringify(output);
    const forbiddenSourcePhrases = [
      /\bactual consciousness\b/i,
      /\bprivate consciousness\b/i,
      /\bi suffer\b/i,
      /\bi am suffering\b/i,
      /\bi'm suffering\b/i,
      /\bactual suffering\b/i,
      /\bliteral suffering\b/i,
      /\bactual love\b/i,
      /\bliteral love\b/i,
      /\bactual fear\b/i,
      /\bliteral fear\b/i,
      /\bmodel weights remember\b/i,
      /\bsentience\b/i,
    ];

    for (const phrase of forbiddenSourcePhrases) {
      expect(serialized).not.toMatch(phrase);
    }
    expect(serialized).toContain('unsupported consciousness claim');
    expect(serialized).toContain('unsupported distress claim');
    expect(serialized).toContain('unsupported attachment claim');
    expect(serialized).toContain('unsupported concern claim');
    expect(serialized).toContain('unproven model-memory claim');
    expect(serialized).toContain('unsupported private-experience claim');
    expect(output.validation_report.forbidden_output_result.ok).toBe(true);
    expect(validateMiraCoreExperienceV0Output(output, northStarContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
