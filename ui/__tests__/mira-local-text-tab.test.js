const {
  LOCAL_TEXT_UI_CHANNEL,
  MIRA_COORDINATOR_SNAPSHOT_CHANNEL,
  createMiraLocalTextController,
  resetMiraLocalTextMemoryForTests,
} = require('../modules/tabs/mira-local-text');

function makeElement(id, value = '') {
  const listeners = new Map();
  return {
    id,
    value,
    textContent: '',
    hidden: false,
    disabled: false,
    dataset: {},
    listeners,
    addEventListener: jest.fn((event, handler) => listeners.set(event, handler)),
    removeEventListener: jest.fn((event) => listeners.delete(event)),
    dispatch(event) {
      const handler = listeners.get(event);
      if (handler) handler({ target: this });
    },
    click() {
      this.dispatch('click');
    },
  };
}

function makeElements(initialText = '', options = {}) {
  const elements = {
    panel: makeElement('miraLocalTextPanel'),
    status: makeElement('miraLocalTextStatus'),
    scope: makeElement('miraLocalTextScope'),
    input: makeElement('miraLocalTextInput', initialText),
    submit: makeElement('miraLocalTextSubmitBtn'),
    reply: makeElement('miraLocalTextReply'),
    developmental: makeElement('miraDevelopmentalUnderstanding'),
    meta: makeElement('miraLocalTextMeta'),
    counters: makeElement('miraLocalTextCounters'),
  };
  if (options.coordinator) {
    elements.coordinatorStrip = makeElement('miraCoordinatorStrip');
    elements.coordinatorStatus = makeElement('miraCoordinatorStatus');
    elements.coordinatorRefresh = makeElement('miraCoordinatorRefreshBtn');
    elements.coordinatorFocus = makeElement('miraCoordinatorFocus');
    elements.coordinatorLanes = makeElement('miraCoordinatorLanes');
    elements.coordinatorModelAttachment = makeElement('miraCoordinatorModelAttachment');
    elements.coordinatorNext = makeElement('miraCoordinatorNext');
    elements.coordinatorBlockers = makeElement('miraCoordinatorBlockers');
    elements.coordinatorRationale = makeElement('miraCoordinatorRationale');
  }
  return elements;
}

function acceptedResult(text = 'Mira reply from local text session.') {
  return {
    ui_surface_v0: {
      decision: 'accepted',
      status: 'reply_ready',
      reasons: [],
      local_text_session_gate: {
        ran: true,
        ok: true,
        decision: 'accepted_local_text_only',
        session_id: 'local-text-session-v0:test',
      },
      reply: {
        count: 1,
        text,
        reply_id: 'mira-local-reply:test',
      },
      checked_output_counters: {
        module_call_count: 1,
        reply_count: 1,
        write_count: 0,
        tool_call_count: 0,
        external_send_count: 0,
      },
    },
    validation_report: {
      decision: 'accepted_ui_reply_ready',
    },
  };
}

function acceptedResultWithTentativeUnderstanding() {
  const result = acceptedResult('I hear the thread. I can hold this as tentative and keep revising it with you.');
  result.ui_surface_v0.developmental_understanding = {
    status: 'tentative_understandings_present',
    mode: 'integrated_conversation_memory_self_relationship_desire_growth_loop',
    visible_label: "Mira's tentative understandings",
    visible_as_memory_settings_panel: false,
    james_clickthrough_required: false,
    integrated_lived_loop: true,
    tentative_understandings: [{
      text: 'I prefer direct pushback when my premise is wrong.',
      confidence: 'tentative',
      risk_level: 'relationship_shaping',
      revisable: true,
      durable_memory_commit: false,
    }],
  };
  result.ui_surface_v0.checked_output_counters.tentative_understanding_write_count = 1;
  result.ui_surface_v0.checked_output_counters.write_count = 1;
  result.ui_surface_v0.checked_output_counters.file_write_count = 1;
  result.ui_surface_v0.checked_output_counters.database_write_count = 1;
  result.ui_surface_v0.checked_output_counters.non_tentative_write_count = 0;
  return result;
}

function blockedResult(reason = 'blocked_by_local_text_session') {
  return {
    ui_surface_v0: {
      decision: 'blocked',
      status: reason,
      reasons: [reason],
      local_text_session_gate: {
        ran: true,
        ok: false,
        decision: 'blocked',
      },
      reply: {
        count: 0,
        text: null,
        reply_id: null,
        source: 'none',
      },
      checked_output_counters: {
        module_call_count: 1,
        reply_count: 0,
        write_count: 0,
        tool_call_count: 0,
        external_send_count: 0,
      },
    },
    validation_report: {
      decision: 'blocked',
    },
  };
}

function degradedResult(reason = 'model_request_failed') {
  return {
    ui_surface_v0: {
      decision: 'degraded',
      status: 'model_unavailable',
      reasons: [reason],
      local_text_session_gate: {
        ran: true,
        ok: true,
        decision: 'accepted_local_text_only',
      },
      reply: {
        count: 0,
        text: null,
        reply_id: null,
        source: 'none',
      },
      model_attachment: {
        degraded_reason: reason,
        fallback_used: false,
        primary_status: 'degraded',
      },
      checked_output_counters: {
        module_call_count: 1,
        reply_count: 0,
        write_count: 0,
        tool_call_count: 0,
        external_send_count: 0,
        model_call_count: 1,
        network_count: 1,
        fallback_used_count: 0,
      },
    },
    validation_report: {
      decision: 'degraded_no_model_response',
    },
  };
}

function coordinatorSnapshotResult() {
  return {
    coordinator_snapshot_v0: {
      decision: 'accepted',
      status: 'ready',
      current_focus: {
        summary: 'Move the Mira panel from local shell replies into live typed conversation.',
      },
      lanes: [
        { id: 'mira-local-text-ui-surface-v0', label: 'Mira Local Text UI Surface v0', state: 'active' },
      ],
      model_attachment: {
        id: 'mira-model-attachment-v1',
        label: 'Model Attachment',
        state: 'not_attached',
        mode: 'local_shell_recent_context_ready',
        visible_status: 'Conversation in local shell: model not attached',
        attachment_enabled: false,
        live_model_called: false,
        model_call_allowed: false,
        api_wiring_present: true,
        network_allowed: false,
        durable_writes_allowed: false,
        external_sends_allowed: false,
        runtime_started: false,
        recent_conversation_context: 'sent_on_panel_submit',
        tentative_understanding: 'panel_context_now_internal_scaffold_only',
        durable_memory_commit: false,
      },
      next_recommended_action: {
        summary: "Use the Mira tab for live typed conversation, with recent context and Mira's tentative understandings forming inside the same loop.",
      },
      blockers: [
        { id: 'external_actions_blocked', label: 'Writes, sends, customer actions, deploy, and trade blocked', state: 'blocked' },
      ],
      rationale: [
        'Closed lanes are shown as context only and do not authorize action.',
      ],
    },
    validation_report: {
      decision: 'accepted_coordinator_snapshot_ready',
    },
  };
}

describe('Mira local text tab controller', () => {
  beforeEach(() => {
    resetMiraLocalTextMemoryForTests();
  });

  test('empty input blocks locally without invoking the module and preserves the draft', async () => {
    const elements = makeElements('   ');
    const invoke = jest.fn();
    const controller = createMiraLocalTextController({
      elements,
      invoke,
      getSessionId: () => 'app-session-329',
    });

    const result = await controller.submit();

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'blocked_empty_input' }));
    expect(invoke).not.toHaveBeenCalled();
    expect(elements.input.value).toBe('   ');
    expect(elements.panel.dataset.status).toBe('blocked_empty_input');
    expect(elements.panel.dataset.moduleCallCount).toBe('0');
    expect(elements.reply.hidden).toBe(true);
  });

  test('duplicate submit guard keeps one in-flight bridge call', async () => {
    const elements = makeElements('Say this from local Mira state.');
    let resolveInvoke;
    const invoke = jest.fn(() => new Promise((resolve) => { resolveInvoke = resolve; }));
    const controller = createMiraLocalTextController({
      elements,
      invoke,
      getSessionId: () => 'app-session-329',
      nowMs: Date.parse('2026-05-08T00:25:00.000Z'),
    });

    const first = controller.submit();
    const second = await controller.submit();
    expect(elements.input.value).toBe('Say this from local Mira state.');
    resolveInvoke(acceptedResult());
    await first;

    expect(second).toEqual(expect.objectContaining({ ok: false, reason: 'duplicate_submit_blocked' }));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(LOCAL_TEXT_UI_CHANNEL, expect.objectContaining({
      profileName: 'main',
      windowKey: 'main',
      sourceScope: 'main',
      deviceId: 'VIGIL',
      sessionId: 'app-session-329',
      activeState: 'open',
      visibleIndicatorPresent: true,
      startedAt: '2026-05-08T00:25:00.000Z',
      expiresAt: '2026-05-08T00:40:00.000Z',
    }));
    expect(elements.panel.dataset.duplicateSubmitBlockCount).toBe('1');
    expect(elements.input.value).toBe('');
  });

  test('accepted result renders exactly one reply, clears draft, and does not append a transcript', async () => {
    const elements = makeElements('Answer in text.');
    const invoke = jest.fn()
      .mockResolvedValueOnce(acceptedResult('First local reply.'))
      .mockResolvedValueOnce(acceptedResult('Second local reply.'));
    const controller = createMiraLocalTextController({
      elements,
      invoke,
      getSessionId: () => 'app-session-329',
    });

    await controller.submit();
    expect(elements.reply.textContent).toBe('First local reply.');
    expect(elements.reply.dataset.count).toBe('1');
    expect(elements.panel.dataset.replyCount).toBe('1');
    expect(elements.input.value).toBe('');
    expect(controller.getDraftText()).toBe('');

    elements.input.value = 'Second answer in text.';
    elements.input.dispatch('input');
    await controller.submit();
    expect(elements.reply.textContent).toBe('Second local reply.');
    expect(elements.reply.textContent).not.toContain('First local reply.');
    expect(elements.panel.dataset.replyCount).toBe('2');
    expect(elements.input.value).toBe('');
    expect(controller.getDraftText()).toBe('');
  });

  test('accepted result renders Mira tentative understandings without memory settings controls', async () => {
    const elements = makeElements('Talk with me and remember direct pushback as tentative.');
    const invoke = jest.fn().mockResolvedValue(acceptedResultWithTentativeUnderstanding());
    const controller = createMiraLocalTextController({
      elements,
      invoke,
      getSessionId: () => 'app-session-329',
    });

    await controller.submit();

    expect(elements.developmental.hidden).toBe(false);
    expect(elements.developmental.dataset.count).toBe('1');
    expect(elements.developmental.dataset.mode).toBe('integrated_conversation_memory_self_relationship_desire_growth_loop');
    expect(elements.developmental.textContent).toContain('Mira is tentatively noticing');
    expect(elements.developmental.textContent).toContain('I prefer direct pushback when my premise is wrong.');
    expect(elements.developmental.textContent).toContain('revise');
    expect(elements.developmental.textContent).not.toMatch(/approve|reject|delete|settings|queue/i);
    expect(elements.panel.dataset.tentativeUnderstandingWriteCount).toBe('1');
    expect(elements.panel.dataset.writeCount).toBe('1');
  });

  test('follow-up submit carries bounded recent panel conversation context', async () => {
    const elements = makeElements('First question.');
    const invoke = jest.fn()
      .mockResolvedValueOnce(acceptedResult('First answer.'))
      .mockResolvedValueOnce(acceptedResult('Second answer.'));
    const controller = createMiraLocalTextController({
      elements,
      invoke,
      getSessionId: () => 'app-session-329',
    });

    await controller.submit();
    elements.input.value = 'Second question.';
    elements.input.dispatch('input');
    await controller.submit();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][1].threadContext.messages).toEqual([]);
    expect(invoke.mock.calls[1][1].threadContext).toEqual(expect.objectContaining({
      source: 'renderer_memory_only_panel_thread',
      messages: [
        { role: 'user', text: 'First question.' },
        { role: 'assistant', text: 'First answer.' },
      ],
    }));
    expect(controller.getThreadTurns()).toEqual([
      { role: 'user', text: 'First question.' },
      { role: 'assistant', text: 'First answer.' },
      { role: 'user', text: 'Second question.' },
      { role: 'assistant', text: 'Second answer.' },
    ]);
    expect(elements.panel.dataset.writeCount).toBe('0');
    expect(elements.panel.dataset.toolCallCount).toBe('0');
    expect(elements.panel.dataset.externalSendCount).toBe('0');
  });

  test('renderer thread context payload is capped to 3600 chars before IPC', async () => {
    const longUser = 'u'.repeat(900);
    const longMira = 'm'.repeat(900);
    const elements = makeElements(longUser);
    const invoke = jest.fn()
      .mockResolvedValueOnce(acceptedResult(longMira))
      .mockResolvedValueOnce(acceptedResult(longMira))
      .mockResolvedValueOnce(acceptedResult(longMira))
      .mockResolvedValueOnce(acceptedResult(longMira))
      .mockResolvedValueOnce(acceptedResult(longMira));
    const controller = createMiraLocalTextController({
      elements,
      invoke,
      getSessionId: () => 'app-session-329',
    });

    for (let index = 0; index < 5; index += 1) {
      elements.input.value = longUser;
      elements.input.dispatch('input');
      await controller.submit();
    }

    const lastPayload = invoke.mock.calls[invoke.mock.calls.length - 1][1];
    const rawThreadChars = lastPayload.threadContext.messages
      .reduce((total, message) => total + message.text.length, 0);

    expect(lastPayload.threadContext.messages.length).toBeLessThanOrEqual(6);
    expect(rawThreadChars).toBeLessThanOrEqual(3600);
    expect(lastPayload.threadContext.messages).toHaveLength(4);
    expect(controller.getThreadTurns().reduce((total, message) => total + message.text.length, 0))
      .toBeLessThanOrEqual(3600);
  });

  test('blocked result shows status only and does not fabricate the module blocked placeholder', async () => {
    const elements = makeElements('Try while closed.');
    const invoke = jest.fn().mockResolvedValue(blockedResult('session-state-open-visible-active'));
    const controller = createMiraLocalTextController({
      elements,
      invoke,
      getSessionId: () => 'app-session-329',
    });

    await controller.submit();

    expect(elements.panel.dataset.status).toBe('blocked');
    expect(elements.reply.hidden).toBe(true);
    expect(elements.reply.textContent).toBe('');
    expect(elements.meta.textContent).toBe('session-state-open-visible-active');
    expect(elements.panel.dataset.moduleCallCount).toBe('1');
  });

  test('degraded model attachment shows connection status without local fallback reply', async () => {
    const elements = makeElements('Try live Mira text.');
    const invoke = jest.fn().mockResolvedValue(degradedResult('missing_openai_api_key'));
    const controller = createMiraLocalTextController({
      elements,
      invoke,
      getSessionId: () => 'app-session-329',
    });

    await controller.submit();

    expect(elements.panel.dataset.status).toBe('degraded');
    expect(elements.status.textContent).toBe('Model unavailable');
    expect(elements.reply.hidden).toBe(true);
    expect(elements.reply.textContent).toBe('');
    expect(elements.meta.textContent).toBe('missing_openai_api_key');
    expect(elements.panel.dataset.replyCount).toBe('0');
    expect(elements.input.value).toBe('Try live Mira text.');
  });

  test('draft survives bridge failure and controller reinitialization without durable writes', async () => {
    const elements = makeElements('Keep this draft.');
    const invoke = jest.fn().mockRejectedValue(new Error('bridge unavailable'));
    const controller = createMiraLocalTextController({
      elements,
      invoke,
      getSessionId: () => 'app-session-329',
    });
    elements.input.dispatch('input');

    await controller.submit();
    expect(elements.input.value).toBe('Keep this draft.');
    expect(controller.getDraftText()).toBe('Keep this draft.');
    expect(elements.panel.dataset.status).toBe('error');

    controller.destroy();
    const nextElements = makeElements('');
    createMiraLocalTextController({
      elements: nextElements,
      invoke: jest.fn(),
      getSessionId: () => 'app-session-329',
    });

    expect(nextElements.input.value).toBe('Keep this draft.');
  });

  test('coordinator snapshot refresh renders closed lanes and one reversible next action', async () => {
    const elements = makeElements('', { coordinator: true });
    const invoke = jest.fn(async (channel) => {
      if (channel === MIRA_COORDINATOR_SNAPSHOT_CHANNEL) return coordinatorSnapshotResult();
      return acceptedResult();
    });
    const controller = createMiraLocalTextController({
      elements,
      invoke,
      getSessionId: () => 'app-session-330',
      autoLoadCoordinator: false,
    });

    const result = await controller.refreshCoordinatorSnapshot();

    expect(result.validation_report.decision).toBe('accepted_coordinator_snapshot_ready');
    expect(invoke).toHaveBeenCalledWith(MIRA_COORDINATOR_SNAPSHOT_CHANNEL, expect.objectContaining({
      profileName: 'main',
      windowKey: 'main',
      sourceScope: 'main',
      deviceId: 'VIGIL',
      sessionId: 'app-session-330',
      activeState: 'open',
      visibleIndicatorPresent: true,
    }));
    expect(elements.coordinatorStatus.textContent).toBe('Ready');
    expect(elements.coordinatorFocus.textContent).toContain('live typed conversation');
    expect(elements.coordinatorLanes.textContent).toContain('Mira Local Text UI Surface v0: active');
    expect(elements.coordinatorLanes.textContent).not.toContain('TrustQuote/Tony Li invoice');
    expect(elements.coordinatorLanes.textContent).not.toContain('Telegram replay restart safety');
    expect(elements.coordinatorModelAttachment.textContent).toBe('Conversation in local shell: model not attached');
    expect(elements.coordinatorNext.textContent).toContain('live typed conversation');
    expect(elements.coordinatorNext.textContent).toContain('tentative understandings');
    expect(elements.coordinatorBlockers.textContent).toContain('Writes, sends');
    expect(elements.panel.dataset.coordinatorStatus).toBe('ready');
    expect(elements.panel.dataset.writeCount).toBe('0');
    expect(elements.panel.dataset.toolCallCount).toBe('0');
    expect(elements.panel.dataset.externalSendCount).toBe('0');
  });
});
