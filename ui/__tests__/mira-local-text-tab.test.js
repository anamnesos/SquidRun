const {
  LOCAL_TEXT_UI_CHANNEL,
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

function makeElements(initialText = '') {
  return {
    panel: makeElement('miraLocalTextPanel'),
    status: makeElement('miraLocalTextStatus'),
    scope: makeElement('miraLocalTextScope'),
    input: makeElement('miraLocalTextInput', initialText),
    submit: makeElement('miraLocalTextSubmitBtn'),
    reply: makeElement('miraLocalTextReply'),
    meta: makeElement('miraLocalTextMeta'),
    counters: makeElement('miraLocalTextCounters'),
  };
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
    });

    const first = controller.submit();
    const second = await controller.submit();
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
    }));
    expect(elements.panel.dataset.duplicateSubmitBlockCount).toBe('1');
  });

  test('accepted result renders exactly one reply and does not append a transcript', async () => {
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

    await controller.submit();
    expect(elements.reply.textContent).toBe('Second local reply.');
    expect(elements.reply.textContent).not.toContain('First local reply.');
    expect(elements.panel.dataset.replyCount).toBe('2');
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
});
