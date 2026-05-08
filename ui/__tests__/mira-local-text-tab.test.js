const {
  LOCAL_TEXT_UI_CHANNEL,
  MIRA_COORDINATOR_SNAPSHOT_CHANNEL,
  createMiraLocalTextController,
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
    meta: makeElement('miraLocalTextMeta'),
    counters: makeElement('miraLocalTextCounters'),
  };
  if (options.coordinator) {
    elements.coordinatorStrip = makeElement('miraCoordinatorStrip');
    elements.coordinatorStatus = makeElement('miraCoordinatorStatus');
    elements.coordinatorRefresh = makeElement('miraCoordinatorRefreshBtn');
    elements.coordinatorFocus = makeElement('miraCoordinatorFocus');
    elements.coordinatorLanes = makeElement('miraCoordinatorLanes');
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

function coordinatorSnapshotResult() {
  return {
    coordinator_snapshot_v0: {
      decision: 'accepted',
      status: 'ready',
      current_focus: {
        summary: 'Move the local text panel from available UI into restart-proof user-visible proof.',
      },
      lanes: [
        { id: 'mira-local-text-ui-surface-v0', label: 'Mira Local Text UI Surface v0', state: 'active' },
        { id: 'trustquote-tony-li-invoice', label: 'TrustQuote/Tony Li invoice', state: 'closed' },
        { id: 'telegram-replay-restart-safety', label: 'Telegram replay restart safety', state: 'closed' },
      ],
      next_recommended_action: {
        summary: 'Use the Mira tab to submit one local text prompt and verify Ready, exactly one bounded reply, and zero writes/tools/sends.',
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
    expect(elements.coordinatorFocus.textContent).toContain('local text panel');
    expect(elements.coordinatorLanes.textContent).toContain('TrustQuote/Tony Li invoice: closed');
    expect(elements.coordinatorLanes.textContent).toContain('Telegram replay restart safety: closed');
    expect(elements.coordinatorNext.textContent).toContain('zero writes/tools/sends');
    expect(elements.coordinatorBlockers.textContent).toContain('Writes, sends');
    expect(elements.panel.dataset.coordinatorStatus).toBe('ready');
    expect(elements.panel.dataset.writeCount).toBe('0');
    expect(elements.panel.dataset.toolCallCount).toBe('0');
    expect(elements.panel.dataset.externalSendCount).toBe('0');
  });
});
