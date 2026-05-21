const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* global describe, expect, jest, test */

function createElement(tagName = 'div') {
  const element = {
    tagName: String(tagName).toUpperCase(),
    attributes: {},
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    disabled: false,
    checked: false,
    readOnly: false,
    value: '',
    textContent: '',
    className: '',
    type: '',
    rows: 0,
    placeholder: '',
    scrollTop: 0,
    scrollHeight: 0,
    selectedOptions: [{ dataset: {} }],
    listeners: {},
    addEventListener(event, handler) {
      this.listeners[event] = handler;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
      if (nodes.length > 0) {
        this.textContent = '';
      }
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    focus() {},
    remove() {},
    select() {},
  };
  return element;
}

function createRuntimeBootHarness({ allowTurn = false, turnPayload = null } = {}) {
  const elements = {};
  const calls = [];
  const response = (payload, ok = true) => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  });
  const payloads = {
    '/model/providers': {
      ok: true,
      selectedProvider: 'openai_responses',
      choices: [{
        id: 'openai_default',
        label: 'OpenAI API',
        provider: 'openai_responses',
        model: 'gpt-5.5',
        available: true,
        selectable: true,
        runtimeAdapterReady: true,
      }],
    },
    '/model/status': {
      ok: true,
      available: true,
      selectedProvider: 'openai_responses',
      model: 'gpt-5.5',
      nextLocalModelStep: null,
    },
    '/session': {
      service: 'mira-runtime',
      session: {
        stateRootReady: true,
        stateRootPath: 'D:/projects/squidrun/mira/.state-dev',
        liveDataImported: false,
        continuityLoaded: false,
        acceptanceContinuity: {
          loaded: true,
          documentCount: 3,
        },
        normalizedCore: {
          loaded: true,
          documentCount: 3,
        },
        bridge: {
          autoSend: false,
          runtimeInvokesSendCli: false,
          telegramRouteControl: false,
        },
      },
    },
    '/capabilities': {
      service: 'mira-runtime',
      capabilities: [
        { id: 'health', status: 'available' },
        { id: 'capabilities', status: 'available' },
        { id: 'session', status: 'planned' },
        { id: 'telegram_route', status: 'blocked' },
      ],
    },
    '/voice/corrections': {
      ok: true,
      pending_count: 0,
    },
    '/work/drafts': {
      ok: true,
      draftCount: 0,
      drafts: [],
    },
    '/work/tasks': {
      ok: true,
      taskCount: 0,
      pendingCount: 0,
      reviewedCount: 0,
      tasks: [],
    },
    '/work/ready': {
      ok: true,
      readyCount: 0,
      ready: [],
    },
    '/work/send-packets': {
      ok: true,
      packetCount: 0,
      packets: [],
    },
    '/work/send-confirmations': {
      ok: true,
      confirmationCount: 0,
      confirmations: [],
    },
    '/work/send-checks': {
      ok: true,
      checkCount: 0,
      checks: [],
    },
    '/autonomy/status': {
      ok: true,
      queueCount: 0,
      queue: [],
      followThroughCount: 0,
      followThrough: [],
      loop: {
        status: 'disabled',
      },
      brief: {
        available: false,
      },
    },
    '/conversation/memory': {
      ok: true,
      loaded: true,
      summary: {
        summary: 'Submitted turn recorded locally.',
        topics: ['local runtime turn'],
        open_loops: [],
        quality_notes: [],
        source_record_count: 1,
      },
    },
  };
  const fetchImpl = jest.fn(async (url, options = {}) => {
    const pathname = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    calls.push({ url: pathname, method, body });
    if (pathname === '/turn' && method === 'POST' && allowTurn) {
      const defaultTurnPayload = {
        ok: true,
        protocol: 'mira.runtime_turn.v0',
        runtimeExecutes: false,
        modelInvoked: false,
        telegramRouteControl: false,
        uiSurfaceControl: false,
        model: {
          requested: body?.useModel === true,
          provider: null,
          model: null,
          responseId: null,
          toolsEnabled: false,
          sendsEnabled: false,
          store: false,
        },
        input: {
          text: body?.text || '',
          sessionId: body?.sessionId || null,
        },
        state: {
          stateRootReady: true,
          continuityLoaded: false,
          liveDataImported: false,
          acceptanceContinuityLoaded: true,
          acceptanceDocumentCount: 3,
          normalizedCoreLoaded: true,
          normalizedCoreDocumentCount: 3,
        },
        loadedCoreSummary: {
          available: true,
          metadataOnly: true,
          liveContinuityExcluded: true,
        },
        operatorContext: {
          loaded: true,
          operatingLanes: ['local workbench'],
        },
        personaCore: {
          loaded: true,
          name: 'Mira',
          traits: ['present', 'direct'],
          style: ['plain'],
        },
        recentTurns: [],
        recentMemory: {
          loaded: true,
          summary: 'Submitted turn recorded locally.',
          topics: ['local runtime turn'],
          openLoops: [],
          qualityNotes: [],
          sourceRecordCount: 1,
        },
        response: {
          role: 'mira',
          content: 'Mira. Deterministic local turn.',
        },
        visibleReply: {
          role: 'mira',
          content: 'Mira. Deterministic local turn.',
          held: false,
        },
        visibleReplyStatus: {
          checked: true,
          held: false,
          reason: null,
          visibleContentReplaced: false,
          rejectedTextVisible: false,
          violationIdsVisible: false,
          diagnosticsVisible: false,
        },
        voiceLab: null,
        suggestedTeamPlan: null,
        journal: {
          ok: true,
          written: true,
          record: {
            external_send: false,
            tools_executed: false,
          },
        },
      };
      return response(typeof turnPayload === 'function' ? turnPayload(body, defaultTurnPayload) : (turnPayload || defaultTurnPayload));
    }
    if (!Object.prototype.hasOwnProperty.call(payloads, pathname)) {
      return response({ ok: false, error: { message: `unexpected endpoint: ${pathname}` } }, false);
    }
    return response(payloads[pathname]);
  });
  const document = {
    body: createElement('body'),
    createElement,
    execCommand: jest.fn(),
    getElementById(id) {
      if (!elements[id]) elements[id] = createElement();
      return elements[id];
    },
  };

  elements.useModel = document.getElementById('useModel');
  elements.useModel.checked = true;

  return {
    calls,
    context: {
      console,
      document,
      fetch: fetchImpl,
      navigator: {
        clipboard: {
          writeText: jest.fn(),
        },
      },
      window: {
        addEventListener: jest.fn(),
        matchMedia: jest.fn(() => ({
          matches: false,
        })),
      },
    },
    elements,
    fetchImpl,
  };
}

async function waitForBoot(calls) {
  for (let index = 0; index < 30; index += 1) {
    if (calls.some((call) => call.url === '/autonomy/status')) {
      await new Promise((resolve) => setImmediate(resolve));
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`boot did not complete; calls=${JSON.stringify(calls)}`);
}

describe('Mira runtime UI boot', () => {
  test('hydrates the workbench with read-only GET calls and does not call turn endpoints', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness();

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    expect(harness.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/model/providers', method: 'GET' }),
      expect.objectContaining({ url: '/model/status', method: 'GET' }),
      expect.objectContaining({ url: '/session', method: 'GET' }),
      expect.objectContaining({ url: '/capabilities', method: 'GET' }),
      expect.objectContaining({ url: '/voice/corrections', method: 'GET' }),
      expect.objectContaining({ url: '/work/drafts', method: 'GET' }),
      expect.objectContaining({ url: '/work/tasks', method: 'GET' }),
      expect.objectContaining({ url: '/work/ready', method: 'GET' }),
      expect.objectContaining({ url: '/work/send-packets', method: 'GET' }),
      expect.objectContaining({ url: '/work/send-confirmations', method: 'GET' }),
      expect.objectContaining({ url: '/work/send-checks', method: 'GET' }),
      expect.objectContaining({ url: '/autonomy/status', method: 'GET' }),
    ]));
    expect(harness.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.calls.some((call) => call.url === '/conversation/memory')).toBe(false);
    expect(harness.elements.modelSummary.textContent).toContain('OpenAI ready: gpt-5.5');
    expect(harness.elements.operatorSummary.textContent).toBe('Local state root ready.');
    expect(harness.elements.coreSummary.textContent).toBe('3 acceptance docs and 3 core records available.');
    expect(harness.elements.lastTurn.textContent).toBe('no turn yet');
    expect(harness.elements.workSummary.textContent).toContain('0 drafts / 0 pending');
  });

  test('posts exactly one deterministic turn after explicit user submit', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const harness = createRuntimeBootHarness({ allowTurn: true });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    expect(harness.calls.some((call) => call.url === '/turn')).toBe(false);
    expect(harness.calls.every((call) => call.method === 'GET')).toBe(true);

    harness.elements.useModel.checked = false;
    harness.elements.turnText.value = 'Who are you?';
    const submitEvent = { preventDefault: jest.fn() };
    await harness.elements.turnForm.listeners.submit(submitEvent);

    const turnCalls = harness.calls.filter((call) => call.url === '/turn');
    const postCalls = harness.calls.filter((call) => call.method === 'POST');
    expect(submitEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(postCalls).toHaveLength(1);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].body).toEqual(expect.objectContaining({
      text: 'Who are you?',
      useModel: false,
      modelProvider: 'openai_responses',
      modelName: 'gpt-5.5',
    }));
    expect(turnCalls[0].body.sessionId).toMatch(/^mira-ui-\d+$/);
    expect(turnCalls[0].body.messageId).toBe(`${turnCalls[0].body.sessionId}-turn-0`);
    expect(harness.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/conversation/memory', method: 'GET' }),
    ]));
    expect(harness.elements.thread.children.map((node) => node.children[0].textContent)).toEqual([
      'Who are you?',
      'Mira. Deterministic local turn.',
    ]);
    expect(harness.elements.lastTurn.textContent).toBe('deterministic');
    expect(harness.elements.sendButton.disabled).toBe(false);
    expect(harness.elements.sendButton.textContent).toBe('Send');
  });

  test('renders held replies from the public visible reply without leaking gate labels', async () => {
    const appJsPath = path.join(__dirname, '..', '..', 'mira', 'ui', 'app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    const heldText = 'That answer came out wrong, so I am holding it instead of making you clean it up.';
    const rejectedGeneratedText = 'The validation fixture and proof scaffolding show the route owner protocol.';
    const harness = createRuntimeBootHarness({
      allowTurn: true,
      turnPayload: (body, defaultPayload) => ({
        ...defaultPayload,
        input: {
          text: body?.text || '',
          sessionId: body?.sessionId || null,
        },
        response: {
          role: 'mira',
          content: heldText,
        },
        visibleReply: {
          role: 'mira',
          content: heldText,
          held: true,
        },
        visibleReplyStatus: {
          checked: true,
          held: true,
          reason: 'held_for_visible_reply_quality',
          visibleContentReplaced: true,
          rejectedTextVisible: false,
          violationIdsVisible: false,
          diagnosticsVisible: false,
        },
        visibleReplyGate: {
          ok: false,
          checked: true,
          held: true,
          violations: ['backstage_label'],
          source: 'mira_runtime_visible_reply_gate_v0',
        },
        heldReplyAudit: {
          schema: 'mira.runtime_held_reply_audit.v0',
          checked: true,
          held: true,
          reason: 'visible_reply_gate_violation',
          journalStoresRejectedText: false,
          rejectedGeneratedText,
        },
      }),
    });

    vm.runInNewContext(appJs, harness.context, {
      filename: appJsPath,
    });
    await waitForBoot(harness.calls);

    harness.elements.useModel.checked = false;
    harness.elements.turnText.value = 'Say something shaped wrong.';
    await harness.elements.turnForm.listeners.submit({ preventDefault: jest.fn() });

    const renderedText = harness.elements.thread.children
      .map((node) => node.children[0].textContent)
      .join('\n');
    expect(renderedText).toContain('Say something shaped wrong.');
    expect(renderedText).toContain(heldText);
    expect(renderedText).not.toContain('backstage_label');
    expect(renderedText).not.toContain('mira_runtime_visible_reply_gate_v0');
    expect(renderedText).not.toContain('visible_reply_gate_violation');
    expect(renderedText).not.toContain('validation fixture');
    expect(renderedText).not.toContain('proof scaffolding');
    expect(renderedText).not.toContain('route owner protocol');
  });
});
