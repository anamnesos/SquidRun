describe('voice-broker tab', () => {
  let tab;
  let invokeBridge;
  let elements;

  function makeElement(id) {
    const listeners = new Map();
    return {
      id,
      textContent: '',
      hidden: false,
      disabled: false,
      dataset: {},
      listeners,
      addEventListener: jest.fn((event, handler) => listeners.set(event, handler)),
      removeEventListener: jest.fn((event) => listeners.delete(event)),
      click() {
        const handler = listeners.get('click');
        if (handler) handler();
      },
    };
  }

  function installDom() {
    elements = {};
    [
      'voiceBrokerPanel',
      'voiceBrokerState',
      'voiceBrokerReadiness',
      'voiceBrokerEndpoint',
      'voiceBrokerModel',
      'voiceBrokerJournal',
      'voiceBrokerError',
      'voiceBrokerRefreshBtn',
      'voiceBrokerStartBtn',
      'voiceBrokerStopBtn',
      'voiceBrokerRestartBtn',
    ].forEach((id) => {
      elements[id] = makeElement(id);
    });
    global.document = {
      getElementById: jest.fn((id) => elements[id] || null),
      createElement: jest.fn(() => ({
        textContent: '',
        get innerHTML() {
          return String(this.textContent || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        },
      })),
    };
  }

  beforeEach(() => {
    jest.resetModules();
    installDom();
    invokeBridge = jest.fn();
    jest.doMock('../modules/renderer-bridge', () => ({ invokeBridge }));
    tab = require('../modules/tabs/voice-broker');
  });

  afterEach(() => {
    tab.destroyVoiceBrokerTab();
    jest.dontMock('../modules/renderer-bridge');
    delete global.document;
  });

  test('renders missing OPENAI_API_KEY as visible not-ready state', () => {
    tab.renderVoiceBrokerStatus({
      ok: true,
      state: 'not_ready',
      ready: false,
      running: false,
      notReadyReasons: ['openai_api_key_missing'],
      config: {
        host: '127.0.0.1',
        port: 0,
        model: 'gpt-realtime',
        voice: 'marin',
        transcriptJournalPath: 'D:/projects/squidrun/.squidrun/runtime/voice-transcripts.jsonl',
        endpointShape: {
          clientSecret: { method: 'POST', path: '/v1/voice/realtime/client-secret' },
        },
      },
    });

    expect(elements.voiceBrokerPanel.dataset.state).toBe('not_ready');
    expect(elements.voiceBrokerState.textContent).toBe('Not ready');
    expect(elements.voiceBrokerReadiness.textContent).toBe('OPENAI_API_KEY missing');
    expect(elements.voiceBrokerStartBtn.disabled).toBe(true);
    expect(elements.voiceBrokerRestartBtn.disabled).toBe(true);
    expect(elements.voiceBrokerStopBtn.disabled).toBe(true);
  });

  test('renders running broker controls without stopping agent panes', () => {
    tab.renderVoiceBrokerStatus({
      ok: true,
      state: 'running',
      ready: true,
      running: true,
      notReadyReasons: [],
      lane: {
        broker: {
          address: { address: '127.0.0.1', port: 43123 },
        },
      },
      config: {
        model: 'gpt-realtime',
        voice: 'marin',
        transcriptJournalPath: 'voice-transcripts.jsonl',
        endpointShape: {
          clientSecret: { method: 'POST', path: '/v1/voice/realtime/client-secret' },
        },
      },
    });

    expect(elements.voiceBrokerState.textContent).toBe('Running');
    expect(elements.voiceBrokerEndpoint.textContent).toBe('POST http://127.0.0.1:43123/v1/voice/realtime/client-secret');
    expect(elements.voiceBrokerStartBtn.disabled).toBe(true);
    expect(elements.voiceBrokerStopBtn.disabled).toBe(false);
    expect(elements.voiceBrokerRestartBtn.disabled).toBe(false);
  });

  test('setup refreshes status and wires restart through IPC control channel', async () => {
    invokeBridge
      .mockResolvedValueOnce({
        ok: true,
        state: 'stopped',
        ready: true,
        running: false,
        notReadyReasons: [],
        config: {
          endpointShape: {
            clientSecret: { method: 'POST', path: '/v1/voice/realtime/client-secret' },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        action: 'restart',
        status: {
          ok: true,
          state: 'running',
          ready: true,
          running: true,
          notReadyReasons: [],
          config: {},
        },
      });

    tab.setupVoiceBrokerTab();
    await Promise.resolve();
    elements.voiceBrokerRestartBtn.click();
    await Promise.resolve();

    expect(invokeBridge).toHaveBeenCalledWith('voice-broker:status');
    expect(invokeBridge).toHaveBeenCalledWith('voice-broker:control', { action: 'restart' });
    expect(elements.voiceBrokerState.textContent).toBe('Running');
  });

  test('html helper escapes rendered status text', () => {
    const html = tab.renderVoiceBrokerPanelHtml({
      state: '<bad>',
      ok: true,
      ready: true,
      running: false,
      config: {
        endpointShape: {
          clientSecret: { method: 'POST', path: '/x?<bad>' },
        },
      },
    });

    expect(html).toContain('&lt;bad&gt;');
  });
});
