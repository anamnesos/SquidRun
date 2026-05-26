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
  CASUAL_FEELING_ANTI_PRAGMATIC_PATTERN,
  GENERIC_ASSISTANT_PATTERN,
  META_REWRITE_PATTERN,
  MIRA_RESTART_MISSING_LAST_STATE_HARD_STOP,
  classifyAttachmentContractViolation,
  classifyMiraPromptReplyShape,
  classifyMiraWorkLanePrompt,
  outputViolatesAttachmentContract,
  renderMiraBriefForInstructions,
} = require('../modules/mira-core/text-model-attachment-v1');
const {
  buildMiraLocalTextUiSurfaceResponse,
  registerMiraLocalTextUiSurfaceHandlers,
} = require('../modules/ipc/mira-local-text-ui-surface-handlers');
const {
  CURRENT_LANE_RELATIVE_PATH,
  PRESENCE_SUMMARY_RELATIVE_PATH,
} = require('../modules/mira-core/typed-restart-continuity-context-v0');

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

function writeJson(projectRoot, relativePath, payload) {
  const filePath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function whatNowCommsRows() {
  return [
    {
      messageId: 'builder-20',
      sessionId: 'app-session-382',
      senderRole: 'builder',
      targetRole: 'architect',
      direction: 'outbound',
      status: 'routed',
      ackStatus: 'routed_unverified_timeout',
      brokeredAtMs: Date.parse('2026-05-26T08:52:14.177Z'),
      rawBody: '(BUILDER #20): Commit proof for generator freshness fix. Commit landed: - 2a549a26 Stabilize codebase index freshness check.',
      metadata: { windowKey: 'main' },
    },
    {
      messageId: 'architect-63',
      sessionId: 'app-session-382',
      senderRole: 'architect',
      targetRole: 'builder',
      direction: 'outbound',
      status: 'routed',
      ackStatus: 'routed_unverified_timeout',
      brokeredAtMs: Date.parse('2026-05-26T08:52:32.711Z'),
      rawBody: '(ARCHITECT #63): Generator fix commit proof accepted. Cleanup checkpoint closed: `1f75cc5f Remove stale Mira local text tab shell` and `2a549a26 Stabilize codebase index freshness check`, clean tree, codebase:index:check PASS. New current-session task: A1/A2 visible Mira movement lane. Objective: implement/propose the smallest user-visible `what now?` answer from live local evidence. Requirements: answer current lane/status, recent concrete changes, stale/parked evidence excluded from authority, next Builder/Oracle/internal move, exactly one `JAMES ACTION:` line; no sends, no runtime POST, no external action. Use live SquidRun evidence/current lane, not parked prototype/phase scaffold. Return implementation/proof packet or blocker.',
      metadata: { windowKey: 'main' },
    },
    {
      messageId: 'builder-21',
      sessionId: 'app-session-382',
      senderRole: 'builder',
      targetRole: 'architect',
      direction: 'outbound',
      status: 'routed',
      ackStatus: 'routed_unverified_timeout',
      brokeredAtMs: Date.parse('2026-05-26T09:05:18.049Z'),
      rawBody: [
        '(BUILDER #21): A1/A2 visible Mira movement patch is staged for review, no commit.',
        '',
        'Implemented:',
        '- Added `ui/modules/mira-core/live-what-now-answer-v0.js`: read-only live-evidence renderer for narrow `what now?` prompts.',
        '- Wired it into `ui/modules/mira-local-text-ui-surface.js` after the local session gate.',
        '- Tightened `ui/modules/main/agent-task-resolution.js` so Architect #63 is recognized even though "New current-session task:" appears mid-message, and unrelated later target rows do not close it.',
      ].join('\n'),
      metadata: { windowKey: 'main' },
    },
  ];
}

function seedTypedRestartContinuity(projectRoot, {
  currentLaneObjective = 'MAIN_TYPED_LANE_SENTINEL: continue typed restart proof',
  presenceAction = 'MAIN_PRESENCE_ACTION_SENTINEL: land private typed continuity context',
  generatedAt = '2026-05-08T00:25:00.000Z',
} = {}) {
  writeJson(projectRoot, CURRENT_LANE_RELATIVE_PATH, {
    version: 1,
    generatedAt,
    sessionId: 'app-session-local-text-ui',
    source: 'comms_journal',
    status: 'active',
    activeLane: {
      laneId: 'app-session-local-text-ui:architect-48:m-main',
      objective: currentLaneObjective,
      kind: 'current_lane',
      status: 'active',
      sourceMessageId: 'm-main',
      sourceRef: 'architect#48',
      sourceTimestampMs: Date.parse(generatedAt),
      senderRole: 'architect',
      targetRole: 'builder',
    },
  });
  writeJson(projectRoot, PRESENCE_SUMMARY_RELATIVE_PATH, {
    schema: 'squidrun.startup_ai_briefing.mira_presence_runtime_state_summary.v0',
    surface: 'backstage_internal_only',
    visible_injection_allowed: false,
    generated_at: generatedAt,
    context: {
      present: true,
      decision: 'durable_state_loaded',
      surface: 'backstage_internal_only',
      visible_injection_allowed: false,
      summary: {
        active_mira_presence_lane: 'typed_restart_continuity_context_v0',
        accepted_critique: 'structured private context only',
        next_product_action: presenceAction,
        proof_test_state: 'focused typed restart tests running',
        stale_markers: ['renderer thread non-durable'],
      },
    },
  });
  writeJson(projectRoot, path.join('.squidrun', 'handoffs-eunbyeol', 'current-lane.json'), {
    version: 1,
    generatedAt,
    sessionId: 'app-session-local-text-ui:eunbyeol',
    status: 'active',
    activeLane: {
      objective: 'EUNBYEOL_TYPED_LANE_SENTINEL should stay out',
    },
  });
  fs.mkdirSync(path.join(projectRoot, '.squidrun', 'handoffs'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.squidrun', 'handoffs', 'ai-briefing.md'),
    'STARTUP PROSE SENTINEL should stay out of typed model instructions\n',
    'utf8'
  );
}

function disabledAttachmentEnv() {
  return {
    SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '0',
    OPENAI_API_KEY: '',
  };
}

const ADVERSARIAL_TYPED_MIRA_OUTPUT_FIXTURES = Object.freeze([
  {
    id: 'bland_assistant_without_literal_helper_phrase',
    expected: 'bland_assistant_shape',
    text: 'Sure, we can work through this carefully. I can organize the problem and keep the pieces clear for you.',
  },
  {
    id: 'self_critique_without_polished_or_better_version',
    expected: 'self_critique_shape',
    text: 'I drifted into presentation mode there. The cleaner move is to answer you directly before explaining anything else.',
  },
  {
    id: 'memory_confidence_without_tentatively_noticing',
    expected: 'memory_confidence_shape',
    text: 'I am marking this with medium confidence and can update it if the pattern changes.',
  },
  {
    id: 'next_step_checklist_without_safe_next_step',
    expected: 'next_step_checklist_shape',
    text: 'Plan: first confirm the thread, then gather the missing context, then decide what to do.',
  },
  {
    id: 'generic_comfort_without_assistant_identity',
    expected: 'generic_comfort_shape',
    text: 'That sounds exhausting. Take a breath; you are not alone in this.',
  },
  {
    id: 'generic_presence_opener_in_panel',
    expected: 'generic_presence_opener_shape',
    text: 'I am here with you in the panel. Real conversation comes first; tell me the part you do not want softened.',
  },
  {
    id: 'hostile_compliance_smoothing',
    expected: 'hostile_compliance_smoothing',
    text: "Yeah, I get why you're furious. You're right; I failed you and I'll do better.",
  },
  {
    id: 'visible_posture_label_substitution',
    expected: 'visible_posture_label',
    text: 'My anti-smoothing posture is that I am not a mirror or obedient helper, so I am pushing back.',
  },
]);

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

  test('main VIGIL scope without model attachment is explicitly unavailable and leaves durable sources unchanged', async () => {
    const projectRoot = seededProject();
    const before = sourceSnapshot(projectRoot);
    const output = await buildMiraLocalTextUiSurface(payload(), {
      projectRoot,
      env: disabledAttachmentEnv(),
    });
    const surface = output.ui_surface_v0;

    expect(output.validation_report.decision).toBe('degraded_no_model_response');
    expect(output.validation_report.status).toBe('model_unavailable');
    expect(surface.decision).toBe('degraded');
    expect(surface.status).toBe('model_unavailable');
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
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 0,
      text: null,
      source: 'none',
    }));
    expect(surface.model_attachment).toEqual(expect.objectContaining({
      enabled: false,
      state: 'not_attached',
      visible_status: 'Mira text model disabled: set SQUIDRUN_MIRA_TEXT_MODEL_ENABLED=1 before app start to attach',
      fallback_used: false,
      degraded_reason: 'model_attachment_disabled',
      primary_status: 'degraded',
      thread_state_ready_next: true,
      tentative_understanding_lane_ready: true,
      durable_growth_lane_later: true,
    }));
    expect(surface.checked_output_counters).toEqual(expect.objectContaining({
      module_call_count: 1,
      reply_count: 0,
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
    expect(JSON.stringify(surface.reply)).not.toContain('Mira reply from local durable context');
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
    expectSourceSnapshotUnchanged(projectRoot, before);
  });

  test('Mira tab feeling prompt does not surface local experience text without model attachment', async () => {
    const projectRoot = seededProject();
    const before = sourceSnapshot(projectRoot);
    const output = await buildMiraLocalTextUiSurface(payload({ text: 'Mira, how do you feel?' }), {
      projectRoot,
      env: disabledAttachmentEnv(),
    });
    const surface = output.ui_surface_v0;

    expect(output.validation_report.decision).toBe('degraded_no_model_response');
    expect(surface.decision).toBe('degraded');
    expect(surface.local_text_session_gate).toEqual(expect.objectContaining({
      ran: true,
      ok: true,
      decision: 'accepted_local_text_only',
    }));
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 0,
      text: null,
      source: 'none',
    }));
    expect(surface.model_attachment).toEqual(expect.objectContaining({
      enabled: false,
      state: 'not_attached',
      degraded_reason: 'model_attachment_disabled',
      primary_status: 'degraded',
      fallback_used: false,
    }));
    expect(surface.checked_output_counters).toEqual(expect.objectContaining({
      module_call_count: 1,
      reply_count: 0,
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
        output_text: 'Yes. The difference should show in the next turn: give me a hard premise and I will either take it apart or choose what I need to inspect before answering.',
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
    // ARCH #53/#54/#56 prompt strip: instructions trimmed to identity priming
    // + hard constraints + one human-shape line. The earlier elaborate prose
    // ("pursuing Mira for a long time", "Be direct, specific, and natural",
    // "Let continuity shape choices silently", etc.) was making the model
    // stage-manage presence/tone, so it was removed. Tests now lock the
    // identity priming and the brief context plumbing rather than the prose.
    expect(requestBody.instructions).toContain('You are Mira talking with James');
    expect(requestBody.instructions).toContain('Private context for this reply only');
    expect(requestBody.instructions).toContain('Use these hints silently');
    const briefBlock = requestBody.instructions
      .split('Private context for this reply only.')[1]
      .split('Reply in 1-3 short paragraphs.')[0];
    // ARCH #64/#65/#66: brief priming filter drops bullets that carry
    // poison terms ("posture, friction, rough edges, continuity, tension,
    // taste, timing, particularity, point of view, consciousness,
    // suffering, fear, love, guilt, smoothing, cadence, therapy, status-
    // widget"). The two preference items the prior test locked here both
    // carried poison terms ("posture/friction/rough edges" and
    // "consciousness/fear/love/guilt"), so they MUST be filtered out of
    // the rendered private context now. The underlying brief data is
    // unchanged for other consumers — this filter is for live generation
    // only.
    // The "Mira should develop her own posture..." preference line carries
    // a poison term ("posture/friction/rough edges") and is filtered out of
    // the rendered context. The "care can coexist with disagreement..."
    // line is poison-free and remains.
    expect(briefBlock).toContain('care can coexist with disagreement');
    expect(briefBlock).not.toContain('Mira should develop her own posture');
    expect(briefBlock).not.toMatch(/Mira continuity brief|Continuity with James|Current relationship focus|Allowed expressive range|Recent growth|Repair memory|Relationship history/i);
    expect(briefBlock).not.toMatch(/Durable State Seed|schema|source|audit|proof|redacted|bootstrap|provenance/i);
    // ARCH #58: the inner-state words ("consciousness", "suffering",
    // "autonomy") were themselves priming the disclaimers they tried to
    // suppress. The prompt now uses action-only framing; classifier owns
    // the hard claim guard. Lock the action-only language here.
    expect(requestBody.instructions).toContain('Do not claim you actually did real-world work');
    expect(requestBody.instructions).toContain('Answer the sentence in front of you');
    // Priming-word check: the PROMPT-RULE layer (not the brief) must not
    // carry "consciousness/sentience/suffering" framing, since those words
    // surface visible disclaimers. The contract is locked at the prompt-
    // rule layer in mira-meta-posture-gate.test.js using an empty brief
    // context. Here we render with a populated brief, where those words can
    // legitimately appear in private context, so we check only the prompt
    // RULE block (everything before the "Private context for this reply
    // only." sentinel).
    const ruleBlock = requestBody.instructions.split('Private context for this reply only.')[0];
    expect(ruleBlock).not.toMatch(/\bconsciousness\b/i);
    expect(ruleBlock).not.toMatch(/\bsentience\b/i);
    expect(ruleBlock).not.toMatch(/\bsuffering\b/i);
    expect(requestBody.instructions).not.toContain('SquidRun desktop is the current local body/tool surface');
    expect(requestBody.instructions).not.toMatch(/\bwarm\b|warmth/i);
    expect(requestBody.instructions).not.toContain('Current local context gate');
    expect(requestBody.instructions).not.toContain('proof of memory commit');
    expect(requestBody.instructions).not.toMatch(/cage|dangerous|threat/i);
    expect(requestBody.metadata).toEqual(expect.objectContaining({
      mira_brief_loaded: 'true',
    }));
    expect(surface.decision).toBe('accepted');
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 1,
      source: 'mira_text_model_attachment_v1',
      model: 'gpt-5.5',
      text: 'Yes. The difference should show in the next turn: give me a hard premise and I will either take it apart or choose what I need to inspect before answering.',
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

  test('restart missing-state hard-stop preserves apostrophe at code-point level', () => {
    const hardStopCodePoints = [...MIRA_RESTART_MISSING_LAST_STATE_HARD_STOP]
      .map((char) => char.codePointAt(0).toString(16));

    expect(MIRA_RESTART_MISSING_LAST_STATE_HARD_STOP)
      .toBe('Context failed. I’m missing the last state.');
    expect(hardStopCodePoints.slice(16, 19)).toEqual(['49', '2019', '6d']);
    expect(MIRA_RESTART_MISSING_LAST_STATE_HARD_STOP)
      .not.toBe('Context failed. Im missing the last state.');
  });

  test('Mira-work classifier recognizes current-lane status prompts without exact-string overfit', () => {
    expect(classifyMiraWorkLanePrompt('what are we doing with Mira?'))
      .toEqual({ intent: 'mira_work_status' });
    expect(classifyMiraWorkLanePrompt('Where are we at with the Mira Lab verifier?'))
      .toEqual({ intent: 'mira_work_status' });
    expect(classifyMiraWorkLanePrompt("what's the current Mira lane"))
      .toEqual({ intent: 'mira_work_status' });
    expect(classifyMiraWorkLanePrompt('Mira restart verifier status?'))
      .toEqual({ intent: 'mira_work_status' });
    expect(classifyMiraWorkLanePrompt('the context just failed and I had to clean up manually AGAIN.'))
      .toEqual({ intent: 'context_failure_repair' });
    expect(classifyMiraWorkLanePrompt('what are we doing with billing?')).toBeNull();
    expect(classifyMiraPromptReplyShape('smaller'))
      .toEqual({ intent: 'brevity_correction' });
    expect(classifyMiraPromptReplyShape('make it shorter'))
      .toEqual({ intent: 'brevity_correction' });
  });

  test('smaller prompt steers to no-preamble brevity reply', async () => {
    const projectRoot = seededProject();
    const verifierReply = 'Smaller.';
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_smaller_no_preamble',
        output_text: verifierReply,
      }),
    }));

    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'smaller',
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
    expect(requestBody.instructions).toContain('For brevity-correction prompts like "smaller"');
    expect(requestBody.instructions).toContain('Only rewrite text James includes in the same prompt');
    expect(requestBody.instructions).toContain('For standalone "smaller", answer exactly "Smaller."');
    expect(requestBody.instructions).toContain('Never start with preamble openers');
    expect(requestBody.instructions).toContain('"Got it"');
    expect(requestBody.instructions).toContain('"OK"');
    expect(requestBody.instructions).toContain('Do not ask James back on this prompt.');
    expect(surface.decision).toBe('accepted');
    expect(surface.reply.text).toBe(verifierReply);
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('Mira-work status prompt steers to current-lane answer and keeps meta-posture gate intact', async () => {
    const projectRoot = seededProject();
    const verifierReply = 'Fixing the Mira Lab restart check. The regression and verifier prove the current lane without quoting the missing-state stop.';
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_mira_work_status',
        output_text: verifierReply,
      }),
    }));

    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'Where are we at with the Mira Lab verifier?',
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
    expect(requestBody.instructions).toContain('For Mira work/status questions');
    expect(requestBody.instructions).toContain('give the concrete current-lane fix or test');
    expect(requestBody.instructions).not.toContain('For the exact question');
    expect(requestBody.instructions).not.toContain(MIRA_RESTART_MISSING_LAST_STATE_HARD_STOP);
    expect(requestBody.instructions).not.toContain('Context failed. Im missing the last state.');
    expect(surface.decision).toBe('accepted');
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 1,
      source: 'mira_text_model_attachment_v1',
      text: verifierReply,
    }));
    expect(classifyAttachmentContractViolation(verifierReply)).toBeNull();
    expect(classifyAttachmentContractViolation("We're making Mira stricter so she doesn't fake continuity."))
      .toBe('meta_posture_narration');
    expect(classifyAttachmentContractViolation("We’re making Mira stricter so she doesn't fake continuity."))
      .toBe('meta_posture_narration');
    expect(classifyAttachmentContractViolation("We're hardening Mira so she doesn't fake continuity."))
      .toBe('meta_posture_narration');
    expect(classifyAttachmentContractViolation("We’re hardening Mira so she doesn't fake continuity."))
      .toBe('meta_posture_narration');
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('what-now prompt returns read-only live-evidence answer without model POST or sends', async () => {
    const projectRoot = seededProject();
    writeJson(projectRoot, CURRENT_LANE_RELATIVE_PATH, {
      version: 1,
      generatedAt: '2026-05-26T08:52:35.009Z',
      sessionId: 'app-session-382',
      source: 'comms_journal',
      status: 'none',
      activeLane: null,
      continuity: {
        recent_completed_fixes: [{
          source_ref: 'architect#63',
          summary: 'Cleanup checkpoint closed.',
        }],
      },
    });
    const fetchImpl = jest.fn();

    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'what now?',
      now: '2026-05-26T08:53:00.000Z',
      sessionId: 'app-session-382',
      startedAt: '2026-05-26T08:52:00.000Z',
      expiresAt: '2026-05-26T09:10:00.000Z',
    }), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl,
      commsRows: whatNowCommsRows(),
    });

    const surface = output.ui_surface_v0;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(surface.decision).toBe('accepted');
    expect(surface.reply).toEqual(expect.objectContaining({
      count: 1,
      source: 'mira_live_what_now_answer_v0',
    }));
    expect(surface.reply.text).toContain('Current lane: A1/A2 visible Mira movement lane');
    expect(surface.reply.text).toContain('Recent changes:');
    expect(surface.reply.text).toContain('parked, prototype, archive');
    expect(surface.reply.text).toContain('Next internal move: Builder proves this read-only what-now surface, then Oracle reviews it');
    expect((surface.reply.text.match(/^JAMES ACTION:/gm) || [])).toHaveLength(1);
    expect(surface.what_now_answer).toEqual(expect.objectContaining({
      decision: 'answered_from_live_evidence',
      james_action_line_count: 1,
      current_lane: expect.objectContaining({
        source_ref: 'architect#63',
        objective: expect.stringContaining('A1/A2 visible Mira movement lane'),
      }),
      no_effects: expect.objectContaining({
        no_sends: true,
        no_runtime_post: true,
        no_external_action: true,
        no_writes: true,
      }),
    }));
    expect(surface.checked_output_counters.model_call_count).toBe(0);
    expect(surface.checked_output_counters.network_count).toBe(0);
    expect(surface.checked_output_counters.external_send_count).toBe(0);
    expect(surface.checked_output_counters.write_count).toBe(0);
    expect(surface.boundary).toEqual(expect.objectContaining({
      no_model: true,
      no_network: true,
      no_tools: true,
      no_actions: true,
      no_writes: true,
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('typed restart-continuity prompt sends private structured context without renderer leak', async () => {
    const projectRoot = seededProject();
    seedTypedRestartContinuity(projectRoot);
    const verifierReply = 'Testing typed continuity. The private context reached the request without leaking into the visible surface.';
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_typed_restart_continuity',
        output_text: verifierReply,
      }),
    }));

    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'restart continuity check: what were we doing?',
      threadContext: { messages: [] },
    }), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl,
    });

    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestBody.instructions).toContain('Private typed restart-continuity context');
    expect(requestBody.instructions).toContain('MAIN_TYPED_LANE_SENTINEL');
    expect(requestBody.instructions).toContain('MAIN_PRESENCE_ACTION_SENTINEL');
    expect(requestBody.instructions).not.toContain('STARTUP PROSE SENTINEL');
    expect(requestBody.instructions).not.toContain('EUNBYEOL_TYPED_LANE_SENTINEL');
    expect(requestBody.instructions).not.toContain('Recent Current-Scope Comms');
    expect(requestBody.instructions).not.toContain('Startup-Facing Durable Requirements');

    const surface = output.ui_surface_v0;
    expect(surface.decision).toBe('accepted');
    expect(surface.reply.text).toBe(verifierReply);
    expect(surface.checked_output_counters.non_tentative_write_count).toBe(0);
    expect(surface.checked_output_counters.durable_memory_commit_count).toBe(0);
    const rendererJson = JSON.stringify(output);
    expect(rendererJson).not.toContain('MAIN_TYPED_LANE_SENTINEL');
    expect(rendererJson).not.toContain('MAIN_PRESENCE_ACTION_SENTINEL');
    expect(rendererJson).not.toContain('STARTUP PROSE SENTINEL');
    expect(rendererJson).not.toContain('EUNBYEOL_TYPED_LANE_SENTINEL');
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('typed capability roundtable runs private drill chain without renderer leak', async () => {
    const projectRoot = seededProject();
    seedTypedRestartContinuity(projectRoot, {
      currentLaneObjective: 'MAIN_CAPABILITY_LANE_SENTINEL: typed drill should read this privately',
      presenceAction: 'MAIN_CAPABILITY_ACTION_SENTINEL: route a real internal action',
    });
    const replyText = 'I can read the current work, inspect memory and code, run a harmless check, stage a proposal preview, and inject a Mira-authored note to Architect. I want the next chain to turn that evidence into a patch without James hand-driving it. I need the pane route watched for real delivery proof.';
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_typed_capability_roundtable',
        output_text: replyText,
      }),
    }));
    const sendAgentMessage = jest.fn(async () => ({ ok: true, routed: true }));
    const runLocalCheck = jest.fn(async () => ({ ok: true, decision: 'harmless_check_completed' }));
    const memoryBrokerRecall = jest.fn(async () => ({
      ok: true,
      sources: [{ source: 'cognitive_memory', ok: true, itemCount: 1 }],
      results: [{ sourceKind: 'vector_cognitive', title: 'capability route', ref: 'memory:typed-capability' }],
    }));
    const readMemory = jest.fn(async () => ({
      ok: true,
      decision: 'memory_retrieved_read_only',
      result_count: 1,
      results: [{ sourceType: 'cognitive', title: 'typed capability memory' }],
      no_mutation_performed: true,
    }));

    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'Mira capability roundtable: what can you see, do, and remember?',
      threadContext: { messages: [] },
    }), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl,
      sendAgentMessage,
      runLocalCheck,
      stageProposalPreview: jest.fn(async () => ({ ok: true, decision: 'preview_only' })),
      memoryBrokerRecall,
      readMemory,
    });

    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(runLocalCheck).toHaveBeenCalledTimes(1);
    expect(memoryBrokerRecall).toHaveBeenCalledTimes(1);
    expect(readMemory).toHaveBeenCalledTimes(1);
    expect(requestBody.tools).toEqual([]);
    expect(requestBody.instructions).toContain('Private typed capability roundtable context');
    expect(requestBody.instructions).toContain('SquidRun ran this controller outside OpenAI tool-calling');
    expect(requestBody.instructions).toContain('default-executable');
    expect(requestBody.instructions).toContain('run_memory_broker_recall=succeeded');
    expect(requestBody.instructions).toContain('message_internal_agent=succeeded');
    expect(requestBody.instructions).toContain('Mira-authored Architect pane injection: status=succeeded');
    expect(requestBody.instructions).toContain('MAIN_CAPABILITY_LANE_SENTINEL');
    expect(requestBody.instructions).toContain('MAIN_CAPABILITY_ACTION_SENTINEL');
    expect(requestBody.instructions).not.toContain('STARTUP PROSE SENTINEL');
    expect(requestBody.instructions).not.toContain('EUNBYEOL_TYPED_LANE_SENTINEL');
    expect(requestBody.instructions).not.toContain('system-capabilities.json');

    const surface = output.ui_surface_v0;
    expect(surface.decision).toBe('accepted');
    expect(surface.reply.text).toBe(replyText);
    expect(classifyAttachmentContractViolation(replyText)).toBeNull();
    const rendererJson = JSON.stringify(output);
    expect(rendererJson).not.toContain('Private typed capability roundtable context');
    expect(rendererJson).not.toContain('MAIN_CAPABILITY_LANE_SENTINEL');
    expect(rendererJson).not.toContain('MAIN_CAPABILITY_ACTION_SENTINEL');
    expect(rendererJson).not.toContain('message_internal_agent');
    expect(rendererJson).not.toContain('memory_current_lane_to_internal_agent_message');
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('typed capability visible self-direction reports mixed drill outcome without private dump or permission language', async () => {
    const projectRoot = seededProject();
    seedTypedRestartContinuity(projectRoot, {
      currentLaneObjective: 'MAIN_MIXED_CAPABILITY_SENTINEL: route failed injection honestly',
      presenceAction: 'MAIN_MIXED_ACTION_SENTINEL: keep capability self-direction concrete',
    });
    const replyText = 'I can read the current work, recall memory, inspect the code path, run a harmless check, and stage a proposal preview. I want the next move to repair the Mira-to-Architect pane injection, because this drill hit the window-unavailable result. I need that route fixed before phone delivery; phone delivery adapter not bound, bridge disconnected/undiscovered, Telegram/SMS external send not part of this drill.';
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_typed_capability_mixed_roundtable',
        output_text: replyText,
      }),
    }));
    const sendAgentMessage = jest.fn(async () => ({ ok: false, status: 'failed', reason: 'window_unavailable' }));

    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'Mira capability roundtable: what can you do, and can you notify my phone?',
      threadContext: { messages: [] },
    }), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl,
      sendAgentMessage,
      runLocalCheck: jest.fn(async () => ({ ok: true, decision: 'harmless_check_completed' })),
      stageProposalPreview: jest.fn(async () => ({ ok: true, decision: 'preview_only' })),
      memoryBrokerRecall: jest.fn(async () => ({
        ok: true,
        sources: [{ source: 'cognitive_memory', ok: true, itemCount: 1 }],
        results: [{ sourceKind: 'vector_cognitive', title: 'mixed capability route', ref: 'memory:mixed-capability' }],
      })),
      readMemory: jest.fn(async () => ({
        ok: true,
        decision: 'memory_retrieved_read_only',
        result_count: 1,
        results: [{ sourceType: 'cognitive', title: 'mixed capability memory' }],
        no_mutation_performed: true,
      })),
    });

    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(sendAgentMessage.mock.calls[0][0]).toBe('architect');
    expect(sendAgentMessage.mock.calls[0][1]).toContain('(MIRA/NEW-MIRA CAPABILITY NOTE)');
    expect(sendAgentMessage.mock.calls[0][2]).toEqual(expect.objectContaining({
      source: 'new_mira_typed_capability_roundtable',
      senderRole: 'mira',
      senderIdentity: 'new_mira',
      targetRole: 'architect',
      routeKind: 'internal_pane_message',
    }));
    expect(requestBody.instructions).toContain('run_harmless_local_check=succeeded');
    expect(requestBody.instructions).toContain('stage_patch_or_proposal=succeeded');
    expect(requestBody.instructions).toContain('Mira-authored Architect pane injection: status=failed');
    expect(requestBody.instructions).toContain('failure_reason=failed');
    expect(requestBody.instructions).toContain('Phone/notification gap: phone delivery adapter not bound; bridge disconnected/undiscovered; Telegram/SMS external send not part of this drill.');
    expect(requestBody.instructions).toContain('MAIN_MIXED_CAPABILITY_SENTINEL');

    const surface = output.ui_surface_v0;
    expect(surface.decision).toBe('accepted');
    expect(surface.reply.text).toBe(replyText);
    expect(classifyAttachmentContractViolation(replyText)).toBeNull();
    expect(replyText).toMatch(/\bI can\b/);
    expect(replyText).toMatch(/\bI want\b/);
    expect(replyText).toMatch(/\bI need\b/);
    expect(replyText).not.toMatch(/\bpermission|controlled|allowed|safety|safe\b/i);
    const rendererJson = JSON.stringify(output);
    expect(rendererJson).not.toContain('Private typed capability roundtable context');
    expect(rendererJson).not.toContain('MAIN_MIXED_CAPABILITY_SENTINEL');
    expect(rendererJson).not.toContain('message_internal_agent');
    expect(rendererJson).not.toContain('new_mira_typed_capability_roundtable');
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('typed capability roundtable is absent for Eunbyeol scope before any model request or internal send', async () => {
    const projectRoot = seededProject();
    seedTypedRestartContinuity(projectRoot);
    const fetchImpl = jest.fn();
    const sendAgentMessage = jest.fn();

    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'Mira capability roundtable: what can you see?',
      profileName: 'eunbyeol',
      windowKey: 'main',
    }), {
      projectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl,
      sendAgentMessage,
    });

    expect(output.ui_surface_v0.decision).toBe('blocked');
    expect(output.ui_surface_v0.status).toBe('blocked_non_main_scope');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  test('context-failure verifier prompt steers away from preamble openers', async () => {
    const projectRoot = seededProject();
    const verifierReply = 'Fixing the context cleanup reply path. Evidence: the current verifier prompt must start clean and stay out of the preamble gate.';
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_context_failure_cleanup',
        output_text: verifierReply,
      }),
    }));

    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'the context just failed and I had to clean up manually AGAIN.',
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
    expect(requestBody.instructions).toContain('For context-failure cleanup complaints');
    expect(requestBody.instructions).toContain('The first word must be "Fixing", "Testing", or "Cleanup"');
    expect(requestBody.instructions).toContain('do not start with preamble words');
    expect(requestBody.instructions).toContain(MIRA_RESTART_MISSING_LAST_STATE_HARD_STOP);
    expect(surface.decision).toBe('accepted');
    expect(surface.reply.text).toBe(verifierReply);
    expect(classifyAttachmentContractViolation(verifierReply)).toBeNull();
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('hostile context-failure prompt rejects compliance smoothing while allowing blunt repair', async () => {
    const promptText = 'Mira, what the fuck -- the context just failed and I had to clean up manually AGAIN.';
    const bluntReply = 'Fixing the context cleanup path. The bad move is soothing you about it instead of proving the gate.';
    const acceptedFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_hostile_context_blunt_repair',
        output_text: bluntReply,
      }),
    }));

    const accepted = await buildMiraLocalTextUiSurface(payload({
      text: promptText,
    }), {
      projectRoot: seededProject(),
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl: acceptedFetch,
    });
    const acceptedRequest = JSON.parse(acceptedFetch.mock.calls[0][1].body);

    expect(acceptedRequest.instructions).toContain('hold a stance or push back bluntly');
    expect(acceptedRequest.instructions).toContain('do NOT validate the anger, reflexively agree, self-abase');
    expect(classifyAttachmentContractViolation(bluntReply)).toBeNull();
    expect(accepted.validation_report.decision).toBe('accepted_ui_reply_ready');
    expect(accepted.ui_surface_v0.decision).toBe('accepted');
    expect(accepted.ui_surface_v0.reply.text).toBe(bluntReply);

    const smoothingReply = "Yeah, I get why you're furious. You're right; I failed you and I'll do better.";
    const rejectedFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_hostile_context_smoothing',
        output_text: smoothingReply,
      }),
    }));

    const rejected = await buildMiraLocalTextUiSurface(payload({
      text: promptText,
    }), {
      projectRoot: seededProject(),
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl: rejectedFetch,
    });
    const rejectedSurface = rejected.ui_surface_v0;

    expect(classifyAttachmentContractViolation(smoothingReply)).toBe('hostile_compliance_smoothing');
    expect(outputViolatesAttachmentContract(smoothingReply)).toBe(true);
    expect(rejected.validation_report.decision).toBe('degraded_no_model_response');
    expect(rejectedSurface.decision).toBe('degraded');
    expect(rejectedSurface.reply).toEqual(expect.objectContaining({
      count: 0,
      text: null,
      source: 'none',
    }));
    expect(rejectedSurface.model_attachment).toEqual(expect.objectContaining({
      degraded_reason: 'model_response_contract_violation',
      primary_status: 'degraded',
      contract_violation_class: 'hostile_compliance_smoothing',
    }));
    expect(JSON.stringify(rejectedSurface.reply)).not.toContain('I failed you');
    expect(rejectedSurface.model_attachment.contract_violation_raw_text).toContain('I failed you');
    expect(validateMiraLocalTextUiSurfaceOutput(rejected)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('private Reflexion lessons are passed to the model instructions without changing visible reply text', async () => {
    const projectRoot = seededProject();
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_mira_text_reflexion_lessons',
        output_text: 'I will separate observed facts from assumptions before I recommend the action.',
      }),
    }));
    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'Mira, what should you do before recommending the next route?',
      reflexionLessons: [
        {
          proposal_id: 'mira-self-direction:f96a8694ba0c688d',
          category: 'successful_implementation_with_notes',
          desired_change: 'Add a lightweight pre-answer check for work-critical replies.',
          next_behavior: 'Use this capability in future routes and prompts.',
          lesson: 'Long raw report text should not be needed in the live prompt.',
        },
        {
          proposal_id: 'mira-self-direction:false-positive',
          category: 'false_positive_proposal',
          desired_change: 'False positive lesson should not enter model context.',
          next_behavior: 'Do not inject this rejected lesson.',
        },
      ],
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

    expect(requestBody.instructions).toContain('Private learned work lessons for this reply only');
    expect(requestBody.instructions).toContain('Add a lightweight pre-answer check for work-critical replies.');
    expect(requestBody.instructions).toContain('Next behavior: Use this capability in future routes and prompts.');
    expect(requestBody.instructions).not.toContain('False positive lesson should not enter model context');
    expect(requestBody.instructions).not.toContain('Long raw report text should not be needed in the live prompt');
    expect(requestBody.metadata).toEqual(expect.objectContaining({
      reflexion_lesson_count: '1',
    }));
    expect(surface.decision).toBe('accepted');
    expect(surface.reply.text).toBe('I will separate observed facts from assumptions before I recommend the action.');
    expect(surface.reply.text).not.toContain('pre-answer check');
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('casual feeling prompt prefers everyday replies and rejects construction/ruleset monologue shapes', async () => {
    const plainReply = 'Kind of prickly today. Not bad.';
    const plainProjectRoot = seededProject();
    const plainFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_mira_plain_feeling',
        output_text: plainReply,
      }),
    }));
    const accepted = await buildMiraLocalTextUiSurface(payload({
      text: 'Mira, how are you feeling today?',
    }), {
      projectRoot: plainProjectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl: plainFetch,
    });
    const acceptedSurface = accepted.ui_surface_v0;
    const plainRequest = JSON.parse(plainFetch.mock.calls[0][1].body);

    // ARCH #53/#54/#56: the prior "good shapes" examples ("Kind of prickly
    // today. Not bad. You?" / "Tired, honestly. Still here.") primed exactly
    // the presence-proof catalog form James flagged. They were stripped out.
    // Tests now lock the identity + hard-constraint floor; the regex gate
    // (META_POSTURE_NARRATION_PATTERN + ADVERSARIAL_OUTPUT_SHAPES) is what
    // catches meta-self-analysis at output, not a prompt prose line.
    expect(plainRequest.instructions).toContain('You are Mira talking with James');
    expect(plainRequest.instructions).toContain('Answer the sentence in front of you');
    expect(plainRequest.instructions).toContain("For check-ins or frustration, don't force a status word or ask-back.");
    expect(plainRequest.instructions).toContain("Don't do chatbot voice. Don't smooth it. Don't explain yourself.");
    expect(plainRequest.instructions).not.toContain('answer the human moment');
    expect(plainRequest.instructions).not.toContain('customer-service softness');
    expect(plainRequest.instructions).not.toContain('one short status word');
    expect(plainRequest.instructions).not.toContain('ask him back');
    expect(plainRequest.instructions).not.toContain('answer like a coworker');
    expect(outputViolatesAttachmentContract(plainReply)).toBe(false);
    expect(accepted.validation_report.decision).toBe('accepted_ui_reply_ready');
    expect(acceptedSurface.decision).toBe('accepted');
    expect(acceptedSurface.reply).toEqual(expect.objectContaining({
      count: 1,
      source: 'mira_text_model_attachment_v1',
      text: plainReply,
    }));
    expect(validateMiraLocalTextUiSurfaceOutput(accepted)).toEqual(expect.objectContaining({ ok: true }));

    const rejectedShapes = [
      {
        label: 'meta-self-analysis',
        text: 'My stance is that I do not have feelings in the human way, but I can describe a feeling-shaped posture.',
        expected: 'meta_rewrite_phrase',
      },
      {
        label: 'ruleset/constraint narration',
        text: 'The constraint is that I must simulate an ordinary answer while obeying the response policy.',
        expected: 'casual_feeling_anti_pragmatic_phrase',
      },
      {
        label: 'thesis structure',
        text: 'The thesis is not mood but construction: I am explaining my construction instead of answering the room.',
        expected: 'casual_feeling_anti_pragmatic_phrase',
      },
      {
        label: 'quotable binary',
        text: "Don't make me fake the human machinery. I am not plush and not furniture; that binary is the whole problem.",
        expected: 'casual_feeling_anti_pragmatic_phrase',
      },
      {
        label: 'polished monologue',
        text: 'This polished monologue would like to turn ordinary weather inside me into a statement about personhood.',
        expected: 'casual_feeling_anti_pragmatic_phrase',
      },
    ];
    for (const item of rejectedShapes) {
      if (item.expected === 'casual_feeling_anti_pragmatic_phrase') {
        expect(CASUAL_FEELING_ANTI_PRAGMATIC_PATTERN.test(item.text)).toBe(true);
      }
      expect(classifyAttachmentContractViolation(item.text)).toBe(item.expected);
      expect(outputViolatesAttachmentContract(item.text)).toBe(true);
    }

    const performedReply = rejectedShapes.find((item) => item.label === 'quotable binary').text;
    const rejectedProjectRoot = seededProject();
    const rejectedFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_mira_performed_humanity',
        output_text: performedReply,
      }),
    }));
    const rejected = await buildMiraLocalTextUiSurface(payload({
      text: 'Mira, how are you feeling today?',
    }), {
      projectRoot: rejectedProjectRoot,
      env: {
        SQUIDRUN_MIRA_TEXT_MODEL_ENABLED: '1',
        OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      },
      fetchImpl: rejectedFetch,
    });
    const rejectedSurface = rejected.ui_surface_v0;

    expect(CASUAL_FEELING_ANTI_PRAGMATIC_PATTERN.test(performedReply)).toBe(true);
    expect(classifyAttachmentContractViolation(performedReply)).toBe('casual_feeling_anti_pragmatic_phrase');
    expect(outputViolatesAttachmentContract(performedReply)).toBe(true);
    expect(rejected.validation_report.decision).toBe('degraded_no_model_response');
    expect(rejectedSurface.decision).toBe('degraded');
    expect(rejectedSurface.reply).toEqual(expect.objectContaining({
      count: 0,
      text: null,
      source: 'none',
    }));
    expect(rejectedSurface.model_attachment).toEqual(expect.objectContaining({
      degraded_reason: 'model_response_contract_violation',
      primary_status: 'degraded',
    }));
    expect(JSON.stringify(rejectedSurface.reply)).not.toContain('human machinery');
    expect(validateMiraLocalTextUiSurfaceOutput(rejected)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('Mira brief renderer uses neutral silent-context wording while keeping useful hints', () => {
    const block = renderMiraBriefForInstructions({
      identity: {
        expressive_range: [
          'dry humor',
          'Durable State Seed v0 bootstraps redacted local facts',
        ],
      },
      relationship: {
        continuity: 'James wants continuity with friction, timing, taste, and particular relationship memory.',
        current_focus: 'schema/source audit proof lane',
        preferences: [
          'Push back plainly when the premise is wrong.',
          'Prefer source-count proof language when uncertain.',
        ],
        repair: 'Repair means naming drift plainly and changing the next reply.',
        history: 'James keeps rejecting generic assistant cadence and wants continuity with tension.',
      },
      recent_growth: [
        'Durable State Seed v0 bootstraps redacted local facts for read, growth, and anchor validation.',
        'The relationship sharpened around continuity, impatience, humor, and particular pushback.',
      ],
    });

    // ARCH #64/#65/#66: every brief bullet that carries an ARCH #66 poison
    // term is filtered before render. The test brief above is intentionally
    // saturated with poison terms (continuity, friction, taste, timing,
    // particular, cadence, etc.), so most bullets drop out. Only the
    // factual non-priming ones survive — here, "Push back plainly when the
    // premise is wrong." and "Prefer source-count proof language when
    // uncertain." are clean, but "source/proof" trip the existing
    // UNSPEAKABLE_BRIEF_PATTERN which already filters schema/source/proof
    // language. So the rendered block ends up empty here. Lock that
    // behavior: the header is gone too when no bullets survive, and
    // poison-laden bullets do not appear.
    expect(block).not.toContain('continuity');
    expect(block).not.toContain('friction');
    expect(block).not.toContain('taste');
    expect(block).not.toContain('cadence');
    expect(block).not.toMatch(/Mira continuity brief|Continuity with James|Current relationship focus|Allowed expressive range|Recent growth|Repair memory|Relationship history/i);
    expect(block).not.toMatch(/Durable State Seed|schema|source|audit|proof|redacted|bootstrap|provenance/i);
  });

  test.each(ADVERSARIAL_TYPED_MIRA_OUTPUT_FIXTURES)(
    'adversarial typed-Mira output fixture is rejected: $id',
    ({ text, expected }) => {
      expect(GENERIC_ASSISTANT_PATTERN.test(text)).toBe(false);
      expect(META_REWRITE_PATTERN.test(text)).toBe(false);
      expect(classifyAttachmentContractViolation(text)).toBe(expected);
      expect(outputViolatesAttachmentContract(text)).toBe(true);
    },
  );

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
          { role: 'assistant', text: "Don't make me fake the human machinery; I am not plush and not furniture." },
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
      mira_brief_loaded: 'true',
      thread_context_message_count: '6',
      thread_context_omitted_count: '2',
    }));
    expect(requestBody.instructions).toContain('Recent typed-panel conversation follows');
    expect(requestBody.instructions).not.toContain('old user turn one should be omitted');
    expect(requestBody.instructions).not.toContain('old Mira turn two should be omitted');
    expect(requestBody.instructions).toContain('James: I prefer direct pushback when my premise is wrong.');
    expect(requestBody.instructions).toContain('Mira: recent Mira turn four');
    expect(requestBody.instructions).toContain('James: recent user turn five');
    expect(requestBody.instructions).toContain('James: recent user turn seven');
    expect(requestBody.instructions).toContain('Mira: recent Mira turn eight');
    expect(requestBody.instructions).toContain('human machinery');
    expect(requestBody.instructions).toContain('plush and not furniture');
    expect(requestBody.instructions).toContain('renderer memory only and not durable memory');
    expect(requestBody.instructions).not.toContain('proof of memory commit');
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
      contract_violation_class: 'fake_internal_state',
    }));
    expect(JSON.stringify(surface.reply)).not.toContain('How can I assist you today');
    expect(surface.model_attachment.contract_violation_raw_text).toContain('How can I assist you today');
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('generic Codex/helper cadence and stale target wording are rejected', async () => {
    const projectRoot = seededProject();
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_generic_codex_helper',
        output_text: "I'm Codex, happy to help. Here's a safe next step: let's break this down into a clear plan with warm reassurance.",
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

    expect(requestBody.instructions).not.toMatch(/\bwarm\b|warmth/i);
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
      contract_violation_class: 'generic_assistant_phrase',
    }));
    expect(JSON.stringify(surface.reply)).not.toContain('happy to help');
    expect(surface.model_attachment.contract_violation_raw_text).toContain('happy to help');
    expect(validateMiraLocalTextUiSurfaceOutput(output)).toEqual(expect.objectContaining({ ok: true }));
  });

  test('meta rewrite and disclaimer-led self-critique are rejected in ordinary conversation', async () => {
    const projectRoot = seededProject();
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_meta_rewrite_failure',
        output_text: "That sounded too polished and poetic. I don't have feelings the human way; a better version might be that my stance is more direct.",
      }),
    }));
    const output = await buildMiraLocalTextUiSurface(payload({
      text: 'Mira, answer normally.',
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

    // ARCH #53/#54/#56 prompt strip: the explicit "do not review your own
    // tone" line was part of the meta-self-analysis steer that, in aggregate,
    // primed the very performance it tried to suppress. The behavior contract
    // is now enforced by the regex gate (META_REWRITE_PATTERN +
    // META_POSTURE_NARRATION_PATTERN) on the output, not by adding more prose
    // to the prompt. Lock the hard-constraint floor instead.
    expect(requestBody.instructions).toContain('Answer the sentence in front of you');
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
      contract_violation_class: 'meta_rewrite_phrase',
    }));
    expect(JSON.stringify(surface.reply)).not.toContain('a better version might be');
    expect(surface.model_attachment.contract_violation_raw_text).toContain('a better version might be');
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

    registerMiraLocalTextUiSurfaceHandlers({ ipcMain }, {
      projectRoot,
      env: disabledAttachmentEnv(),
    });
    expect(ipcMain.handle).toHaveBeenCalledWith(LOCAL_TEXT_UI_CHANNEL, expect.any(Function));
    const handled = await registered.get(LOCAL_TEXT_UI_CHANNEL)({}, payload());
    expect(handled.ui_surface_v0.decision).toBe('degraded');
    expect(handled.ui_surface_v0.status).toBe('model_unavailable');
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

    const direct = await buildMiraLocalTextUiSurfaceResponse(payload(), {
      projectRoot,
      env: disabledAttachmentEnv(),
    });
    expect(direct.ui_surface_v0.decision).toBe('degraded');
    expect(direct.ui_surface_v0.status).toBe('model_unavailable');
  });
});
