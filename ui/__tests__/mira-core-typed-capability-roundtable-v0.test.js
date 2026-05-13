const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildTypedCapabilityRoundtableContextV0,
  isCapabilityRoundtablePrompt,
} = require('../modules/mira-core/typed-capability-roundtable-v0');
const {
  CURRENT_LANE_RELATIVE_PATH,
  PRESENCE_SUMMARY_RELATIVE_PATH,
} = require('../modules/mira-core/typed-restart-continuity-context-v0');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-capability-roundtable-'));
}

function writeJson(projectRoot, relativePath, payload) {
  const filePath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function mainMetadata(overrides = {}) {
  return {
    profileName: 'main',
    windowKey: 'main',
    sourceScope: 'main',
    deviceId: 'VIGIL',
    sessionId: 'app-session-372',
    activeState: 'open',
    visibleIndicatorPresent: true,
    ...overrides,
  };
}

function writeCurrentLane(projectRoot) {
  writeJson(projectRoot, CURRENT_LANE_RELATIVE_PATH, {
    version: 1,
    generatedAt: '2026-05-13T18:00:00.000Z',
    sessionId: 'app-session-372',
    source: 'comms_journal',
    status: 'active',
    activeLane: {
      laneId: 'capability-roundtable-main',
      objective: 'CAPABILITY_MAIN_LANE_SENTINEL: build typed internal action drill',
      kind: 'mira_capability_lane',
      status: 'active',
      sourceMessageId: 'architect#60',
      sourceRef: 'architect#60',
      sourceTimestampMs: Date.parse('2026-05-13T18:00:00.000Z'),
      senderRole: 'architect',
      targetRole: 'builder',
      rawBody: 'STARTUP PROSE SENTINEL should never appear',
    },
  });
  writeJson(projectRoot, PRESENCE_SUMMARY_RELATIVE_PATH, {
    schema: 'squidrun.startup_ai_briefing.mira_presence_runtime_state_summary.v0',
    surface: 'backstage_internal_only',
    visible_injection_allowed: false,
    generated_at: '2026-05-13T18:00:00.000Z',
    context: {
      present: true,
      decision: 'durable_state_loaded',
      surface: 'backstage_internal_only',
      visible_injection_allowed: false,
      summary: {
        active_mira_presence_lane: 'typed_capability_roundtable',
        accepted_critique: 'use internal actions, not permission theater',
        next_product_action: 'CAPABILITY_MAIN_ACTION_SENTINEL: prove a real chain',
        proof_test_state: 'roundtable drill tests running',
        stale_markers: [],
        startup_prose_sentinel: 'STARTUP PROSE SENTINEL should never appear',
      },
    },
  });
}

function fakeMemoryBrokerRecall() {
  return jest.fn(async () => ({
    ok: true,
    generatedAt: '2026-05-13T18:01:00.000Z',
    sources: [
      { source: 'cognitive_memory', ok: true, itemCount: 1 },
      { source: 'team_memory', ok: true, itemCount: 1 },
    ],
    results: [
      {
        sourceKind: 'vector_cognitive',
        title: 'Mira capability architecture',
        ref: 'memory:capability',
      },
    ],
  }));
}

function fakeReadMemory() {
  return jest.fn(async () => ({
    ok: true,
    decision: 'memory_retrieved_read_only',
    result_count: 1,
    results: [{ sourceType: 'cognitive', title: 'toolchain memory' }],
    no_mutation_performed: true,
  }));
}

describe('typed capability roundtable context v0', () => {
  test('recognizes capability roundtable prompts', () => {
    expect(isCapabilityRoundtablePrompt('Mira capability roundtable: what can you see, do, and remember?')).toBe(true);
    expect(isCapabilityRoundtablePrompt('plain casual check-in')).toBe(false);
  });

  test('main/VIGIL drill runs a real internal chain and sends through injected agent channel', async () => {
    const projectRoot = tempProject();
    try {
      writeCurrentLane(projectRoot);
      writeJson(projectRoot, path.join('.squidrun', 'handoffs-eunbyeol', 'current-lane.json'), {
        status: 'active',
        activeLane: { objective: 'EUNBYEOL_CAPABILITY_SENTINEL should stay out' },
      });
      const sendAgentMessage = jest.fn(async () => ({ ok: true, routed: true }));
      const runLocalCheck = jest.fn(async () => ({ ok: true, decision: 'harmless_check_completed' }));
      const stageProposalPreview = jest.fn(async () => ({ ok: true, decision: 'proposal_preview_staged_in_memory_only' }));
      const memoryBrokerRecall = fakeMemoryBrokerRecall();
      const readMemory = fakeReadMemory();

      const context = await buildTypedCapabilityRoundtableContextV0({
        projectRoot,
        promptText: 'Mira capability roundtable: what can you see, do, and remember?',
        metadata: mainMetadata(),
        nowMs: Date.parse('2026-05-13T18:02:00.000Z'),
        sendAgentMessage,
        runLocalCheck,
        stageProposalPreview,
        memoryBrokerRecall,
        readMemory,
      });

      expect(context.present).toBe(true);
      expect(context.decision).toBe('capability_roundtable_drill_executed');
      expect(context.manifest.authority_model.internal_default_executable).toBe(true);
      expect(context.manifest.authority_model.openai_tools_array_for_now).toEqual([]);
      expect(context.manifest.authority_model.execute_reads_false_visibility_not_used_for_drill).toBe(true);
      expect(context.manifest.authority_model.system_capabilities_json_used_as_truth).toBe(false);
      expect(context.manifest.tool_adaptor_classes.map((entry) => entry.id)).toEqual(expect.arrayContaining([
        'current_lane_and_runtime_state_read',
        'memory_layer_read',
        'code_and_runtime_inspection',
        'local_checks_and_tests',
        'patch_or_proposal_staging',
        'internal_agent_message',
      ]));
      expect(memoryBrokerRecall).toHaveBeenCalledTimes(1);
      expect(readMemory).toHaveBeenCalledTimes(1);
      expect(runLocalCheck).toHaveBeenCalledTimes(1);
      expect(stageProposalPreview).toHaveBeenCalledTimes(1);
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);
      expect(sendAgentMessage.mock.calls[0][0]).toBe('architect');
      expect(sendAgentMessage.mock.calls[0][1]).toContain('(MIRA/NEW-MIRA CAPABILITY NOTE)');
      expect(sendAgentMessage.mock.calls[0][1]).toContain('source_identity=new_mira; source_role=mira');
      expect(sendAgentMessage.mock.calls[0][1]).toContain('controller=typed_controller_outside_openai_tools_array');
      expect(sendAgentMessage.mock.calls[0][2]).toEqual(expect.objectContaining({
        source: 'new_mira_typed_capability_roundtable',
        senderRole: 'mira',
        senderIdentity: 'new_mira',
        targetRole: 'architect',
        targetPane: '1',
        routeKind: 'internal_pane_message',
        windowKey: 'main',
        profile: 'main',
      }));
      expect(context.drill.first_toolchain_executed).toBe('memory_current_lane_to_architect_message');
      expect(context.drill.outcome).toEqual(expect.objectContaining({
        internal_message_sent: true,
        durable_write_performed: false,
        selected_target_role: 'architect',
      }));
      expect(context.drill.actual_attempted_actions.map((entry) => entry.id)).toEqual(expect.arrayContaining([
        'read_current_working_state',
        'run_memory_broker_recall',
        'inspect_code_runtime_state',
        'choose_route_action_from_evidence',
        'message_internal_agent',
      ]));
      const rendered = JSON.stringify(context);
      expect(rendered).toContain('CAPABILITY_MAIN_LANE_SENTINEL');
      expect(rendered).toContain('CAPABILITY_MAIN_ACTION_SENTINEL');
      expect(rendered).not.toContain('STARTUP PROSE SENTINEL');
      expect(rendered).not.toContain('EUNBYEOL_CAPABILITY_SENTINEL');
      expect(rendered).not.toContain('system-capabilities.json');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('uses bounded recent comms metadata as working-state fallback without raw bodies', async () => {
    const projectRoot = tempProject();
    try {
      const sendAgentMessage = jest.fn(async () => ({ ok: true }));
      const commsMetadataReader = jest.fn(() => ({
        ok: true,
        rows: [
          {
            rowId: 10,
            messageId: 'architect#60',
            senderRole: 'architect',
            targetRole: 'builder',
            channel: 'ws',
            direction: 'inbound',
            status: 'recorded',
            rawBody: 'RAW COMMS BODY SENTINEL should not be projected',
            bodyBytes: 512,
            bodyHash: 'abc123',
            brokeredAtMs: Date.parse('2026-05-13T18:03:00.000Z'),
          },
        ],
      }));

      const context = await buildTypedCapabilityRoundtableContextV0({
        projectRoot,
        promptText: 'what can you see and do with internal actions?',
        metadata: mainMetadata(),
        nowMs: Date.parse('2026-05-13T18:04:00.000Z'),
        sendAgentMessage,
        commsMetadataReader,
        memoryBrokerRecall: fakeMemoryBrokerRecall(),
        readMemory: fakeReadMemory(),
      });

      const workingState = context.drill.attempts.find((attempt) => attempt.id === 'read_current_working_state');
      expect(workingState.fallback_used).toBe(true);
      expect(workingState.source).toBe('bounded_recent_comms_metadata_fallback');
      expect(workingState.comms_metadata.row_count).toBe(1);
      expect(workingState.comms_metadata.raw_body_included).toBe(false);
      expect(JSON.stringify(workingState)).not.toContain('RAW COMMS BODY SENTINEL');
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('presence-only restart context still uses bounded comms metadata fallback for working state', async () => {
    const projectRoot = tempProject();
    try {
      writeJson(projectRoot, PRESENCE_SUMMARY_RELATIVE_PATH, {
        schema: 'squidrun.startup_ai_briefing.mira_presence_runtime_state_summary.v0',
        surface: 'backstage_internal_only',
        visible_injection_allowed: false,
        generated_at: '2026-05-13T18:00:00.000Z',
        context: {
          present: true,
          decision: 'durable_state_loaded',
          surface: 'backstage_internal_only',
          visible_injection_allowed: false,
          summary: {
            active_mira_presence_lane: 'presence-only capability lane',
            accepted_critique: 'presence summary exists but current lane is absent',
            next_product_action: 'PRESENCE_ONLY_ACTION_SENTINEL: use comms fallback for working state',
            proof_test_state: 'fallback regression running',
            startup_prose_sentinel: 'STARTUP PROSE SENTINEL should never appear',
          },
        },
      });
      const commsMetadataReader = jest.fn(() => ({
        ok: true,
        rows: [{
          rowId: 11,
          messageId: 'architect#65',
          senderRole: 'architect',
          targetRole: 'builder',
          channel: 'ws',
          direction: 'inbound',
          status: 'recorded',
          rawBody: 'RAW PRESENCE-ONLY COMMS SENTINEL should not project',
          bodyBytes: 333,
          bodyHash: 'hash-presence-only',
        }],
      }));

      const context = await buildTypedCapabilityRoundtableContextV0({
        projectRoot,
        promptText: 'capability drill: what can you see?',
        metadata: mainMetadata(),
        nowMs: Date.parse('2026-05-13T18:04:00.000Z'),
        sendAgentMessage: jest.fn(async () => ({ ok: true })),
        commsMetadataReader,
        memoryBrokerRecall: fakeMemoryBrokerRecall(),
        readMemory: fakeReadMemory(),
      });

      const workingState = context.drill.attempts.find((attempt) => attempt.id === 'read_current_working_state');
      expect(workingState.restart_summary.current_lane_present).toBe(false);
      expect(workingState.restart_summary.presence_runtime_present).toBe(true);
      expect(workingState.fallback_used).toBe(true);
      expect(workingState.presence_summary_retained).toBe(true);
      expect(workingState.comms_metadata.row_count).toBe(1);
      expect(JSON.stringify(workingState)).not.toContain('RAW PRESENCE-ONLY COMMS SENTINEL');
      expect(JSON.stringify(context)).toContain('PRESENCE_ONLY_ACTION_SENTINEL');
      expect(JSON.stringify(context)).not.toContain('STARTUP PROSE SENTINEL');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('failed sendAgentMessage result does not count as sent or executed toolchain', async () => {
    const projectRoot = tempProject();
    try {
      writeCurrentLane(projectRoot);
      const sendAgentMessage = jest.fn(async () => ({ ok: false, status: 'failed', reason: 'window_unavailable' }));

      const context = await buildTypedCapabilityRoundtableContextV0({
        projectRoot,
        promptText: 'capability drill: what tools can you use?',
        metadata: mainMetadata(),
        nowMs: Date.parse('2026-05-13T18:02:00.000Z'),
        sendAgentMessage,
        runLocalCheck: jest.fn(async () => ({ ok: true })),
        stageProposalPreview: jest.fn(async () => ({ ok: true })),
        memoryBrokerRecall: fakeMemoryBrokerRecall(),
        readMemory: fakeReadMemory(),
      });

      const messageAttempt = context.drill.attempts.find((attempt) => attempt.id === 'message_internal_agent');
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);
      expect(messageAttempt.status).toBe('failed');
      expect(messageAttempt.reason).toBe('failed');
      expect(messageAttempt.result).toEqual(expect.objectContaining({
        ok: false,
        status: 'failed',
        reason: 'window_unavailable',
      }));
      expect(messageAttempt.completion_note_sent).toBe(false);
      expect(messageAttempt.completion_note_staged).toEqual(expect.objectContaining({
        staged: true,
        durable_write_performed: false,
        target_role: 'architect',
        relay_owner: 'architect',
      }));
      expect(context.drill.outcome.internal_message_sent).toBe(false);
      expect(context.drill.first_toolchain_executed).toBeNull();
      expect(context.decision).toBe('capability_roundtable_drill_attempted_with_gaps');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('side and Eunbyeol scopes fail closed and do not attempt internal actions', async () => {
    const cases = [
      { profileName: 'eunbyeol' },
      { windowKey: 'eunbyeol' },
      { sourceScope: 'eunbyeol' },
      { sessionId: 'app-session-372:eunbyeol' },
      { sessionScopeId: 'app-session-372:eunbyeol' },
      { windowKey: 'main', profileName: 'eunbyeol' },
      { deviceId: 'PHONE' },
      { visibleIndicatorPresent: false },
    ];
    for (const overrides of cases) {
      const projectRoot = tempProject();
      const sendAgentMessage = jest.fn();
      try {
        const context = await buildTypedCapabilityRoundtableContextV0({
          projectRoot,
          promptText: 'capability drill: what can you do?',
          metadata: mainMetadata(overrides),
          sendAgentMessage,
          memoryBrokerRecall: fakeMemoryBrokerRecall(),
          readMemory: fakeReadMemory(),
        });
        expect(context.present).toBe(false);
        expect(context.decision).toMatch(/^absent_/);
        expect(sendAgentMessage).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    }
  });

  test('built-in local check and proposal preview are bound; missing message adapter is reported as a gap', async () => {
    const projectRoot = tempProject();
    try {
      writeCurrentLane(projectRoot);
      const context = await buildTypedCapabilityRoundtableContextV0({
        projectRoot,
        promptText: 'capability drill: what tools can you use?',
        metadata: mainMetadata(),
        nowMs: Date.parse('2026-05-13T18:02:00.000Z'),
        memoryBrokerRecall: fakeMemoryBrokerRecall(),
        readMemory: fakeReadMemory(),
      });

      expect(context.decision).toBe('capability_roundtable_drill_attempted_with_gaps');
      expect(context.drill.first_toolchain_executed).toBeNull();
      expect(context.drill.missing_or_fake_adapters.map((entry) => entry.id)).toEqual([
        'message_internal_agent',
      ]);
      const localCheck = context.drill.attempts.find((entry) => entry.id === 'run_harmless_local_check');
      expect(localCheck.adapter_bound).toBe(true);
      expect(localCheck.status).toBe('succeeded_test_substrate_probe');
      expect(localCheck.adapter).toContain('ipc/test-execution');
      expect(localCheck.test_execution_probe.success).toBe(true);
      expect(localCheck.test_execution_probe.no_process_spawned).toBe(true);
      const proposal = context.drill.attempts.find((entry) => entry.id === 'stage_patch_or_proposal');
      expect(proposal.adapter_bound).toBe(true);
      expect(proposal.adapter).toBe('mira-core/mutation-patch preview');
      expect(proposal.no_mutation_performed).toBe(true);
      expect(proposal.status).toBe('succeeded_non_durable_mutation_patch_preview');
      const messageAttempt = context.drill.attempts.find((entry) => entry.id === 'message_internal_agent');
      expect(messageAttempt.completion_note_staged).toEqual(expect.objectContaining({
        staged: true,
        durable_write_performed: false,
        target_role: 'architect',
      }));
      expect(context.drill.actual_attempted_actions.find((entry) => entry.id === 'message_internal_agent').status)
        .toBe('adapter_present_not_bound_to_typed_path');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
