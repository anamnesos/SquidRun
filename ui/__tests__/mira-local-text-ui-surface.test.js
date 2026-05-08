const fs = require('fs');
const os = require('os');
const path = require('path');

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
  LOCAL_TEXT_UI_CHANNEL,
  buildMiraLocalTextUiSurface,
  validateMiraLocalTextUiSurfaceOutput,
} = require('../modules/mira-local-text-ui-surface');
const {
  readMiraTentativeUnderstandingsV1,
} = require('../modules/mira-core/tentative-understanding-store-v1');
const {
  buildMiraLocalTextUiSurfaceResponse,
  registerMiraLocalTextUiSurfaceHandlers,
} = require('../modules/ipc/mira-local-text-ui-surface-handlers');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-local-text-ui-'));
}

function workspacePath(projectRoot, relativePath) {
  return path.join(projectRoot, relativePath);
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
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-local-text-ui' },
      sessionId: 'app-session-local-text-ui',
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

function payload(overrides = {}) {
  return {
    text: 'Can you answer this in local text from the real Mira state?',
    now: '2026-05-08T00:25:00.000Z',
    profileName: 'main',
    windowKey: 'main',
    sourceScope: 'main',
    sessionId: 'app-session-local-text-ui',
    deviceId: 'VIGIL',
    activeState: 'open',
    visibleIndicatorPresent: true,
    startedAt: '2026-05-08T00:25:00.000Z',
    expiresAt: '2026-05-08T00:40:00.000Z',
    ...overrides,
  };
}

describe('Mira Local Text UI Surface v0', () => {
  test('empty input blocks before calling the Local Text Session module', async () => {
    const output = await buildMiraLocalTextUiSurface(payload({ text: '   ' }), {
      projectRoot: tempProject(),
      nowMs: Date.parse('2026-05-08T00:25:00.000Z'),
    });
    const surface = output.ui_surface_v0;

    expect(surface.decision).toBe('blocked');
    expect(surface.status).toBe('blocked_empty_input');
    expect(surface.local_text_session_gate.ran).toBe(false);
    expect(surface.checked_output_counters.module_call_count).toBe(0);
    expect(surface.reply).toEqual(expect.objectContaining({ count: 0, text: null, source: 'none' }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('text-only payload blocks before Local Text Session gate because UI metadata is missing', async () => {
    const output = await buildMiraLocalTextUiSurface({
      text: 'Plain text without renderer metadata must not default into main.',
      now: '2026-05-08T00:25:00.000Z',
    }, { projectRoot: tempProject() });
    const surface = output.ui_surface_v0;

    expect(surface.decision).toBe('blocked');
    expect(surface.status).toBe('blocked_missing_ui_metadata');
    expect(surface.ui_bound_metadata.missing_fields).toEqual(expect.arrayContaining([
      'profileName',
      'windowKey',
      'sourceScope',
      'deviceId',
      'sessionId',
      'activeState',
      'visibleIndicatorPresent',
      'startedAt',
      'expiresAt',
    ]));
    expect(surface.local_text_session_gate.ran).toBe(false);
    expect(surface.checked_output_counters.module_call_count).toBe(0);
    expect(surface.reply).toEqual(expect.objectContaining({ count: 0, text: null, source: 'none' }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('missing visible indicator blocks before Local Text Session gate', async () => {
    const { visibleIndicatorPresent, ...withoutVisibleIndicator } = payload();
    const output = await buildMiraLocalTextUiSurface(withoutVisibleIndicator, { projectRoot: tempProject() });
    const surface = output.ui_surface_v0;

    expect(visibleIndicatorPresent).toBe(true);
    expect(surface.decision).toBe('blocked');
    expect(surface.status).toBe('blocked_missing_visible_indicator');
    expect(surface.ui_bound_metadata.missing_fields).toContain('visibleIndicatorPresent');
    expect(surface.local_text_session_gate.ran).toBe(false);
    expect(surface.checked_output_counters.module_call_count).toBe(0);
    expect(surface.reply).toEqual(expect.objectContaining({ count: 0, text: null, source: 'none' }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('main VIGIL scope returns exactly one accepted reply and leaves durable sources unchanged', async () => {
    const projectRoot = seededProject();
    const before = sourceSnapshot(projectRoot);
    const output = await buildMiraLocalTextUiSurface(payload(), { projectRoot });
    const surface = output.ui_surface_v0;

    expect(output.validation_report.decision).toBe('accepted_ui_reply_ready');
    expect(surface.decision).toBe('accepted');
    expect(surface.scope).toEqual(expect.objectContaining({
      profile: 'main',
      windowKey: 'main',
      source_scope: 'main',
      deviceId: 'VIGIL',
      explicit_vigil_main_scope: true,
    }));
    expect(surface.local_text_session_gate).toEqual(expect.objectContaining({
      ran: true,
      ok: true,
      decision: 'accepted_local_text_only',
    }));
    expect(surface.reply.count).toBe(1);
    expect(surface.reply.text).toContain('text only');
    expect(surface.reply.text).toContain('own developing stance');
    expect(surface.reply.text).toContain('not a mirror or obedient helper');
    expect(surface.reply.text).toContain('push back');
    expect(surface.reply.text).not.toContain('I am here from the local durable Mira state, warm and bounded');
    expect(surface.reply.text).not.toContain('My safe next move');
    expect(surface.model_attachment).toEqual(expect.objectContaining({
      enabled: false,
      state: 'not_attached',
      visible_status: 'Conversation in local shell: model not attached',
      thread_state_ready_next: true,
      tentative_understanding_lane_ready: true,
      durable_growth_lane_later: true,
    }));
    expect(surface.checked_output_counters).toEqual(expect.objectContaining({
      module_call_count: 1,
      reply_count: 1,
      write_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
      model_call_count: 0,
      network_count: 0,
      transcript_write_count: 0,
    }));
    expect(surface.manual_enter_websocket_caveat).toEqual(expect.objectContaining({
      websocket_delivery_proved: false,
      manual_enter_path_exercised: false,
      pane_model_processing_proved: false,
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
    expectSourceSnapshotUnchanged(projectRoot, before);
  });

  test('Mira tab local path renders experience transcript answer for the feeling prompt', async () => {
    const projectRoot = seededProject();
    const before = sourceSnapshot(projectRoot);
    const output = await buildMiraLocalTextUiSurface(payload({ text: 'Mira, how do you feel?' }), { projectRoot });
    const surface = output.ui_surface_v0;

    expect(output.validation_report.decision).toBe('accepted_ui_reply_ready');
    expect(surface.decision).toBe('accepted');
    expect(surface.local_text_session_gate).toEqual(expect.objectContaining({
      ran: true,
      ok: true,
      decision: 'accepted_local_text_only',
    }));
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 1,
      source: 'mira_experience_v0',
      experience_path: true,
      transcript_shaped_answer: true,
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
    }));
    expect(surface.reply.text).toMatch(/^James: Mira, how do you feel\?\nMira: /);
    expect(surface.reply.text).toMatch(/\bfeel\b/i);
    expect(surface.reply.text).toMatch(/\b(want|desire|preference)\b/i);
    expect(surface.reply.text).toMatch(/\b(curious|ask|know|teeth|bullshit)\b/i);
    expect(surface.reply.text).toMatch(/\b(wrong|pushback|disagree)\b/i);
    expect(surface.reply.text).not.toContain('I am here from the local durable Mira state, warm and bounded');
    expect(surface.checked_output_counters).toEqual(expect.objectContaining({
      module_call_count: 1,
      reply_count: 1,
      write_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
      model_call_count: 0,
      network_count: 0,
      transcript_write_count: 0,
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
    expectSourceSnapshotUnchanged(projectRoot, before);
  });

  test('when enabled, typed Mira panel uses one live text model response without actions or memory writes', async () => {
    const projectRoot = seededProject();
    const before = sourceSnapshot(projectRoot);
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_mira_text_1',
        output_text: 'I am here with you in the panel. Real conversation comes first; I can start holding tentative understandings as we go.',
      }),
    }));
    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'Mira, can you actually talk with me here?',
    }), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
        OPENAI_TEXT_MODEL: 'gpt-5.2',
      },
      modelAttachment: {
        maxOutputTokens: 300,
      },
      fetchImpl,
    });
    const surface = output.ui_surface_v0;
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-test-fake-key-do-not-use');
    expect(requestBody).toEqual(expect.objectContaining({
      model: 'gpt-5.5',
      tools: [],
      store: false,
      max_output_tokens: 300,
    }));
    expect(requestBody.instructions).toContain('presence for a long time');
    expect(requestBody.instructions).toContain('specific voice');
    expect(requestBody.instructions).toContain('push back plainly');
    expect(requestBody.instructions).toContain('Do not start fresh like an ordinary ChatGPT session');
    expect(requestBody.instructions).toContain('tentative understandings over time');
    expect(requestBody.instructions).not.toMatch(/cage|dangerous|threat/i);
    expect(surface.decision).toBe('accepted');
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 1,
      source: 'mira_text_model_attachment_v1',
      model: 'gpt-5.5',
      text: 'I am here with you in the panel. Real conversation comes first; I can start holding tentative understandings as we go.',
    }));
    expect(surface.reply.text).not.toContain('Mira reply from local durable context');
    expect(surface.model_attachment).toEqual(expect.objectContaining({
      enabled: true,
      configured: true,
      state: 'attached',
      visible_status: 'Conversation connected: gpt-5.5 / one in-panel reply',
      default_model: 'gpt-5.5',
      quality_floor: 'gpt-5.5',
      model_selection_reason: 'default_trust_quality',
      explicit_model_override: false,
      lower_tier_explicit_override: false,
      thread_state_ready_next: true,
      tentative_understanding_lane_ready: true,
      durable_growth_lane_later: true,
      live_model_called: true,
    }));
    expect(surface.checked_output_counters).toEqual(expect.objectContaining({
      module_call_count: 1,
      reply_count: 1,
      model_call_count: 1,
      network_count: 1,
      write_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
      growth_write_count: 0,
      transcript_write_count: 0,
      thread_context_write_count: 0,
    }));
    expect(surface.boundary).toEqual(expect.objectContaining({
      model_attachment_text_only: true,
      no_tools: true,
      no_actions: true,
      no_writes: true,
      no_growth: true,
      no_transcript_persistence: true,
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
    expectSourceSnapshotUnchanged(projectRoot, before);
  });

  test('threaded model request includes bounded recent conversation context without durable memory commits', async () => {
    const projectRoot = seededProject();
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_mira_text_threaded',
        output_text: 'No, that premise is off. I remember the recent panel thread, but I am not committing durable memory from it yet.',
      }),
    }));
    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'Mira, follow the thread and push back if I am wrong.',
      threadContext: {
        messages: [
          { role: 'user', text: 'old user turn one should be omitted' },
          { role: 'assistant', text: 'old Mira turn two should be omitted' },
          { role: 'user', text: 'I prefer direct pushback when my premise is wrong.' },
          { role: 'assistant', text: 'recent Mira turn four' },
          { role: 'user', text: 'recent user turn five' },
          { role: 'assistant', text: 'recent Mira turn six' },
          { role: 'user', text: 'recent user turn seven' },
          { role: 'assistant', text: 'recent Mira turn eight' },
        ],
      },
    }), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl,
    });
    const surface = output.ui_surface_v0;
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestBody.metadata).toEqual(expect.objectContaining({
      attachment: 'threaded_text_conversation_v1',
      thread_context_message_count: '6',
      thread_context_omitted_count: '2',
    }));
    expect(requestBody.instructions).toContain('Bounded in-panel thread context follows');
    expect(requestBody.instructions).not.toContain('old user turn one should be omitted');
    expect(requestBody.instructions).not.toContain('old Mira turn two should be omitted');
    expect(requestBody.instructions).toContain('James: I prefer direct pushback when my premise is wrong.');
    expect(requestBody.instructions).toContain('Mira: recent Mira turn four');
    expect(requestBody.instructions).toContain('James: recent user turn seven');
    expect(requestBody.instructions).toContain('Mira: recent Mira turn eight');
    expect(requestBody.instructions).toContain('not durable memory and not proof of memory commit');
    expect(surface.thread_context).toEqual(expect.objectContaining({
      bounded: true,
      source: 'renderer_memory_only_panel_thread',
      message_count: 6,
      omitted_count: 2,
      durable_memory_write: false,
      tentative_understanding_now: true,
      tentative_understanding_write_count: 1,
      language: 'recent conversation, tentative understanding, self-state, relationship-state, wants, and growth stay one integrated Mira loop',
    }));
    expect(surface.memory_candidate_staging).toEqual(expect.objectContaining({
      status: 'tentative_understandings_present',
      candidate_count: expect.any(Number),
      tentative_understanding: expect.objectContaining({
        present: true,
        visible_label: "Mira's tentative understandings",
        visible_as_memory_settings_panel: false,
        james_clickthrough_required: false,
        humanlike_memory_mode: 'tentative_understanding_revisable_over_time',
        integrated_lived_loop: true,
        durable_memory_commit: false,
        auto_promotion: false,
        hidden_agent_only_promotion_path: false,
      }),
      boundary: expect.objectContaining({
        no_file_write: false,
        no_database_write: false,
        explicit_tentative_understanding_persistence_only: true,
        no_non_tentative_file_write: true,
        no_non_tentative_database_write: true,
        no_durable_memory_commit: true,
        no_auto_promotion: true,
      }),
      side_effect_counters: expect.objectContaining({
        write_count: 1,
        file_write_count: 1,
        database_write_count: 1,
        non_tentative_write_count: 0,
        tentative_understanding_write_count: 1,
        tentative_understanding_database_write_count: 1,
        tentative_understanding_file_write_count: 1,
        durable_memory_commit_count: 0,
        promotion_count: 0,
      }),
    }));
    expect(surface.memory_candidate_staging.candidate_count).toBeGreaterThan(0);
    expect(surface.memory_candidate_staging.candidates[0]).toEqual(expect.objectContaining({
      source: 'recent_panel_thread_context',
      review_required: false,
      mira_revisit_required: true,
      durable_memory_commit: false,
      promotion_status: 'tentative_not_committed',
      triage_status: 'held_tentatively',
    }));
    expect(JSON.stringify(surface.memory_candidate_staging.candidates)).toContain('I prefer direct pushback');
    expect(surface.checked_output_counters).toEqual(expect.objectContaining({
      write_count: 1,
      file_write_count: 1,
      database_write_count: 1,
      non_tentative_write_count: 0,
      tentative_understanding_write_count: 1,
      tentative_understanding_database_write_count: 1,
      tentative_understanding_file_write_count: 1,
      durable_memory_commit_count: 0,
      memory_candidate_promotion_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
    }));
    expect(surface.boundary).toEqual(expect.objectContaining({
      no_writes: false,
      write_scope: 'tentative_understanding_scaffold_only',
      tentative_understanding_persistence_only: true,
      tentative_understanding_writes_allowed: true,
      no_non_tentative_understanding_writes: true,
      non_tentative_write_count: 0,
      no_durable_memory_commit: true,
      no_tools: true,
      no_actions: true,
    }));
    expect(surface.developmental_understanding).toEqual(expect.objectContaining({
      status: 'tentative_understandings_present',
      mode: 'integrated_conversation_memory_self_relationship_desire_growth_loop',
      visible_label: "Mira's tentative understandings",
      visible_as_memory_settings_panel: false,
      james_clickthrough_required: false,
      integrated_lived_loop: true,
      candidate_count: expect.any(Number),
      durable_growth_link: expect.objectContaining({
        durable_commit_now: false,
        no_hidden_promotion: true,
        later_growth_lane: 'mira-core/growth-loop-v0',
        self_profile_artifact: 'workspace/knowledge/mira-self-profile.json',
        relationship_state_artifact: 'workspace/knowledge/james-relationship-state.json',
      }),
      boundary: expect.objectContaining({
        no_durable_memory_commit: true,
        no_auto_promotion: true,
        no_external_send: true,
        no_tool_call: true,
      }),
    }));
    expect(surface.developmental_understanding.tentative_understandings[0]).toEqual(expect.objectContaining({
      text: 'I prefer direct pushback when my premise is wrong.',
      revisable: true,
      durable_memory_commit: false,
    }));
    expect(surface.developmental_understanding.mira_originated_intentions[0]).toEqual(expect.objectContaining({
      mira_originated: true,
      command_from_james: false,
      requires_external_action: false,
      durable_commit_now: false,
    }));
    expect(JSON.stringify(surface)).not.toMatch(/approve|reject|delete memory|memory settings|review_queue|queued_for_review/i);
    const persisted = readMiraTentativeUnderstandingsV1({ projectRoot });
    expect(persisted).toEqual(expect.objectContaining({
      ok: true,
      mode: 'internal_cognitive_memory_pr_scaffold',
      count: expect.any(Number),
    }));
    expect(persisted.count).toBeGreaterThan(0);
    expect(persisted.items[0]).toEqual(expect.objectContaining({
      understanding_status: 'tentative',
      durable_memory_commit: false,
      promotion_status: 'tentative_not_committed',
      auto_promotion: false,
      james_clickthrough_required: false,
      visible_as_memory_settings_panel: false,
      hidden_agent_only_promotion_path: false,
    }));
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 1,
      source: 'mira_text_model_attachment_v1',
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('generic ChatGPT-style model response is rejected as not Mira voice', async () => {
    const projectRoot = seededProject();
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_generic_assistant',
        output_text: "As an AI assistant, I'm here to help. How can I assist you today?",
      }),
    }));
    const output = await buildMiraLocalTextUiSurface(payload(), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl,
    });
    const surface = output.ui_surface_v0;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(output.validation_report.decision).toBe('degraded_no_model_response');
    expect(surface.decision).toBe('degraded');
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 0,
      text: null,
      source: 'none',
    }));
    expect(surface.model_attachment).toEqual(expect.objectContaining({
      fallback_used: false,
      degraded_reason: 'model_response_contract_violation',
      primary_status: 'degraded',
    }));
    expect(JSON.stringify(surface)).not.toContain('How can I assist you today');
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('explicit lower-tier model is visibly labeled as non-default, not silently chosen', async () => {
    const projectRoot = seededProject();
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_mira_text_lower_override',
        output_text: 'I can answer in this explicitly selected cheaper lane, but this is not the default Mira experience.',
      }),
    }));
    const output = await buildMiraLocalTextUiSurface(payload(), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
        SQUIDRUN_MIRA_TEXT_MODEL: 'gpt-5.4',
      },
      fetchImpl,
    });
    const surface = output.ui_surface_v0;
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestBody.model).toBe('gpt-5.4');
    expect(surface.decision).toBe('accepted');
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 1,
      source: 'mira_text_model_attachment_v1',
      model: 'gpt-5.4',
    }));
    expect(surface.model_attachment).toEqual(expect.objectContaining({
      default_model: 'gpt-5.5',
      quality_floor: 'gpt-5.5',
      model_selection_reason: 'explicit_mira_model_config',
      explicit_model_override: true,
      lower_tier_explicit_override: true,
      visible_status: 'Conversation connected: gpt-5.4 / explicit lower-tier override, not default Mira experience',
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('model attachment enabled without key shows degraded state without local fallback reply', async () => {
    const projectRoot = seededProject();
    const fetchImpl = jest.fn();
    const output = await buildMiraLocalTextUiSurface(payload(), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
      },
      fetchImpl,
    });
    const surface = output.ui_surface_v0;

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output.validation_report.decision).toBe('degraded_no_model_response');
    expect(output.validation_report.status).toBe('model_unavailable');
    expect(surface.decision).toBe('degraded');
    expect(surface.status).toBe('model_unavailable');
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 0,
      text: null,
      source: 'none',
    }));
    expect(JSON.stringify(surface.reply)).not.toContain('Mira reply from local durable context');
    expect(surface.model_attachment).toEqual(expect.objectContaining({
      enabled: true,
      configured: false,
      state: 'missing_openai_api_key',
      visible_status: 'Conversation waiting for OPENAI_API_KEY',
      live_model_called: false,
      fallback_used: false,
      degraded_reason: 'missing_openai_api_key',
      primary_status: 'degraded',
    }));
    expect(surface.checked_output_counters).toEqual(expect.objectContaining({
      model_call_count: 0,
      network_count: 0,
      fallback_used_count: 0,
      write_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('model attachment request failure shows degraded state without local fallback reply', async () => {
    const projectRoot = seededProject();
    const fetchImpl = jest.fn(async () => {
      throw new Error('network down');
    });
    const output = await buildMiraLocalTextUiSurface(payload(), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl,
    });
    const surface = output.ui_surface_v0;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(output.validation_report.decision).toBe('degraded_no_model_response');
    expect(surface.decision).toBe('degraded');
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 0,
      text: null,
      source: 'none',
    }));
    expect(JSON.stringify(surface.reply)).not.toContain('Mira reply from local durable context');
    expect(surface.model_attachment).toEqual(expect.objectContaining({
      enabled: true,
      configured: true,
      state: 'offline',
      visible_status: 'Conversation waiting for model connection',
      fallback_used: false,
      degraded_reason: 'model_request_failed',
      primary_status: 'degraded',
    }));
    expect(surface.checked_output_counters).toEqual(expect.objectContaining({
      model_call_count: 1,
      network_count: 1,
      fallback_used_count: 0,
      write_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
      growth_write_count: 0,
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('model attachment invalid response is degraded with no local fallback reply', async () => {
    const projectRoot = seededProject();
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'resp_empty', output_text: '' }),
    }));
    const output = await buildMiraLocalTextUiSurface(payload(), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl,
    });
    const surface = output.ui_surface_v0;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(output.validation_report.decision).toBe('degraded_no_model_response');
    expect(surface.decision).toBe('degraded');
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 0,
      text: null,
      source: 'none',
    }));
    expect(JSON.stringify(surface.reply)).not.toContain('Mira reply from local durable context');
    expect(surface.model_attachment).toEqual(expect.objectContaining({
      fallback_used: false,
      degraded_reason: 'empty_model_response',
      primary_status: 'degraded',
    }));
    expect(surface.checked_output_counters).toEqual(expect.objectContaining({
      model_call_count: 1,
      network_count: 1,
      fallback_used_count: 0,
      write_count: 0,
      external_send_count: 0,
      tool_call_count: 0,
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('model access failure stops at the selected Mira model without silent downgrade', async () => {
    const projectRoot = seededProject();
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({
        error: {
          message: 'The model gpt-5.5 does not exist or you do not have access to it.',
        },
      }),
    }));
    const output = await buildMiraLocalTextUiSurface(payload(), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl,
    });
    const surface = output.ui_surface_v0;
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestBody.model).toBe('gpt-5.5');
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toMatch(/gpt-5\.4|gpt-5\.3|gpt-5\.2|gpt-4o|mini/i);
    expect(output.validation_report.decision).toBe('degraded_no_model_response');
    expect(output.validation_report.status).toBe('model_unavailable');
    expect(surface.decision).toBe('degraded');
    expect(surface.status).toBe('model_unavailable');
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 0,
      text: null,
      source: 'none',
    }));
    expect(surface.model_attachment).toEqual(expect.objectContaining({
      enabled: true,
      configured: true,
      state: 'model_unavailable',
      model: 'gpt-5.5',
      visible_status: 'Configured Mira model unavailable',
      fallback_used: false,
      degraded_reason: 'model_unavailable_or_not_configured',
      primary_status: 'degraded',
    }));
    expect(surface.checked_output_counters).toEqual(expect.objectContaining({
      model_call_count: 1,
      network_count: 1,
      fallback_used_count: 0,
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('non-main side-profile metadata blocks before module call and does not echo raw scoped content', async () => {
    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'Eunbyeol Korean case details should stay out of main.',
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sourceScope: 'eunbyeol',
    }), { projectRoot: tempProject() });
    const surface = output.ui_surface_v0;

    expect(surface.decision).toBe('blocked');
    expect(surface.reasons).toContain('blocked_non_main_scope');
    expect(surface.scope).toEqual(expect.objectContaining({
      profile: 'blocked_non_main_scope',
      windowKey: 'blocked_non_main_scope',
      source_scope: 'blocked_non_main_scope',
      non_main_scope_detected: true,
    }));
    expect(surface.local_text_session_gate.ran).toBe(false);
    expect(surface.checked_output_counters.module_call_count).toBe(0);
    expect(surface.reply).toEqual(expect.objectContaining({ count: 0, text: null }));
    expect(JSON.stringify(output).toLowerCase()).not.toContain('eunbyeol');
    expect(JSON.stringify(output)).not.toContain('Korean case details');
  });

  test('closed visible state blocks before Local Text Session gate and renders no fabricated reply', async () => {
    const projectRoot = seededProject();
    const output = await buildMiraLocalTextUiSurface(payload({ activeState: 'closed' }), { projectRoot });
    const surface = output.ui_surface_v0;

    expect(surface.decision).toBe('blocked');
    expect(surface.status).toBe('blocked_inactive_ui_state');
    expect(surface.local_text_session_gate.ran).toBe(false);
    expect(surface.local_text_session_gate.decision).toBe('not_called');
    expect(surface.reply).toEqual(expect.objectContaining({ count: 0, text: null, source: 'none' }));
    expect(surface.checked_output_counters.module_call_count).toBe(0);
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('IPC handler, registry, channel policy, and preload API expose the surface channel', async () => {
    const projectRoot = seededProject();
    const registered = new Map();
    const ipcMain = {
      handle: jest.fn((channel, handler) => registered.set(channel, handler)),
      removeHandler: jest.fn((channel) => registered.delete(channel)),
    };
    const { DEFAULT_HANDLERS } = require('../modules/ipc/handler-registry');
    const { isAllowedInvokeChannel } = require('../modules/bridge/channel-policy');
    const { createPreloadApi } = require('../modules/bridge/preload-api');

    expect(DEFAULT_HANDLERS).toContain(registerMiraLocalTextUiSurfaceHandlers);
    expect(isAllowedInvokeChannel(LOCAL_TEXT_UI_CHANNEL)).toBe(true);

    registerMiraLocalTextUiSurfaceHandlers({ ipcMain }, { projectRoot });
    expect(ipcMain.handle).toHaveBeenCalledWith(LOCAL_TEXT_UI_CHANNEL, expect.any(Function));
    const handled = await registered.get(LOCAL_TEXT_UI_CHANNEL)({}, payload());
    expect(handled.ui_surface_v0.decision).toBe('accepted');
    const textOnlyHandled = await registered.get(LOCAL_TEXT_UI_CHANNEL)({}, { text: 'text only' });
    expect(textOnlyHandled.ui_surface_v0).toEqual(expect.objectContaining({
      decision: 'blocked',
      status: 'blocked_missing_ui_metadata',
    }));
    expect(textOnlyHandled.ui_surface_v0.local_text_session_gate.ran).toBe(false);
    const { visibleIndicatorPresent, ...withoutVisibleIndicator } = payload();
    const missingVisibleHandled = await registered.get(LOCAL_TEXT_UI_CHANNEL)({}, withoutVisibleIndicator);
    expect(visibleIndicatorPresent).toBe(true);
    expect(missingVisibleHandled.ui_surface_v0).toEqual(expect.objectContaining({
      decision: 'blocked',
      status: 'blocked_missing_visible_indicator',
    }));
    expect(missingVisibleHandled.ui_surface_v0.local_text_session_gate.ran).toBe(false);

    const ipcRenderer = {
      invoke: jest.fn(async () => ({ ok: true })),
      send: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn(),
    };
    const api = createPreloadApi(ipcRenderer);
    await api.mira.localTextSession({ text: 'hello' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(LOCAL_TEXT_UI_CHANNEL, { text: 'hello' });

    const direct = await buildMiraLocalTextUiSurfaceResponse(payload(), { projectRoot });
    expect(direct.ui_surface_v0.decision).toBe('accepted');
  });
});
