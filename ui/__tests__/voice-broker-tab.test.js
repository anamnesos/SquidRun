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
      'voiceSessionStatus',
      'voiceSessionStartBtn',
      'voicePushToTalkBtn',
      'voiceMuteBtn',
      'voiceInterruptBtn',
      'voiceSessionStopBtn',
      'voiceSessionLog',
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
    delete global.window;
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

  test('falls back to preload broker status when main IPC handler is unavailable', async () => {
    invokeBridge.mockRejectedValueOnce(new Error("No handler registered for 'voice-broker:status'"));
    global.window = {
      squidrun: {
        voice: {
          brokerStatusLocal: jest.fn(() => ({
            ok: true,
            state: 'running',
            ready: true,
            running: true,
            notReadyReasons: [],
            source: 'preload-status-file',
            lane: { broker: { address: { address: '127.0.0.1', port: 60817 } } },
            config: {
              model: 'gpt-realtime',
              voice: 'marin',
              transcriptJournalPath: 'voice-transcripts.jsonl',
              endpointShape: {
                clientSecret: { method: 'POST', path: '/v1/voice/realtime/client-secret' },
                transcript: { method: 'POST', path: '/v1/voice/transcripts' },
              },
            },
          })),
        },
      },
    };

    const status = await tab.refreshVoiceBrokerStatus();

    expect(status.source).toBe('preload-status-file');
    expect(elements.voiceBrokerState.textContent).toBe('Running');
    expect(elements.voiceSessionStartBtn.disabled).toBe(false);
  });

  test('creates Realtime WebRTC session through broker client-secret endpoint', async () => {
    const track = { enabled: true, stop: jest.fn() };
    const stream = {
      getAudioTracks: jest.fn(() => [track]),
      getTracks: jest.fn(() => [track]),
    };
    const dataChannel = {
      readyState: 'open',
      sent: [],
      handlers: {},
      addEventListener(event, handler) {
        this.handlers[event] = handler;
      },
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
      close: jest.fn(),
    };
    const peer = {
      addTrack: jest.fn(),
      createDataChannel: jest.fn(() => dataChannel),
      createOffer: jest.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' })),
      setLocalDescription: jest.fn(),
      setRemoteDescription: jest.fn(),
      close: jest.fn(),
    };
    const PeerConnection = jest.fn(() => peer);
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, body: { value: 'eph_test' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'answer-sdp',
      });

    const session = await tab.createVoiceRealtimeSession({
      status: {
        ok: true,
        ready: true,
        running: true,
        lane: { broker: { address: { address: '127.0.0.1', port: 43123 } } },
        config: {
          endpointShape: {
            clientSecret: { path: '/v1/voice/realtime/client-secret' },
            transcript: { path: '/v1/voice/transcripts' },
          },
        },
      },
      fetchImpl,
      mediaDevices: { getUserMedia: jest.fn(async () => stream) },
      RTCPeerConnection: PeerConnection,
    });

    expect(session.peerConnection).toBe(peer);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:43123/v1/voice/realtime/client-secret', expect.objectContaining({
      method: 'POST',
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://api.openai.com/v1/realtime/calls', expect.objectContaining({
      method: 'POST',
      body: 'offer-sdp',
      headers: expect.objectContaining({
        Authorization: 'Bearer eph_test',
        'Content-Type': 'application/sdp',
      }),
    }));
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer-sdp' });
    expect(track.enabled).toBe(false);
    dataChannel.handlers.open();
    expect(dataChannel.sent).toContainEqual(expect.objectContaining({
      type: 'session.update',
      session: expect.objectContaining({
        input_audio_transcription: expect.objectContaining({
          model: 'gpt-4o-mini-transcribe',
        }),
      }),
    }));
    expect(dataChannel.sent[0].session).not.toHaveProperty('turn_detection');
  });

  test('push-to-talk, mute, interrupt, and stop use WebRTC state only', async () => {
    const track = { enabled: false, stop: jest.fn() };
    const dataChannel = {
      readyState: 'open',
      sent: [],
      addEventListener: jest.fn(),
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
      close: jest.fn(),
    };
    const peer = { close: jest.fn() };
    tab.renderVoiceBrokerStatus({
      ok: true,
      ready: true,
      running: true,
      state: 'running',
      lane: { broker: { address: { address: '127.0.0.1', port: 43123 } } },
      config: {
        endpointShape: {
          clientSecret: { path: '/v1/voice/realtime/client-secret' },
        },
      },
    });
    await tab.startVoiceSession({
      status: {
        ok: true,
        ready: true,
        running: true,
        lane: { broker: { address: { address: '127.0.0.1', port: 43123 } } },
        config: { endpointShape: { clientSecret: { path: '/token' } } },
      },
      fetchImpl: jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ value: 'eph_test' }) })
        .mockResolvedValueOnce({ ok: true, text: async () => 'answer-sdp' }),
      mediaDevices: {
        getUserMedia: jest.fn(async () => ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        })),
      },
      RTCPeerConnection: jest.fn(() => ({
        addTrack: jest.fn(),
        createDataChannel: () => dataChannel,
        createOffer: async () => ({ sdp: 'offer-sdp' }),
        setLocalDescription: jest.fn(),
        setRemoteDescription: jest.fn(),
        close: peer.close,
      })),
    });

    expect(tab.setPushToTalk(true)).toBe(true);
    expect(track.enabled).toBe(true);
    expect(tab.muteVoiceSession()).toBe(true);
    expect(track.enabled).toBe(false);
    expect(tab.interruptVoiceSession()).toBe(true);
    expect(dataChannel.sent).toContainEqual({ type: 'response.cancel' });
    tab.stopVoiceSession();
    expect(track.stop).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
  });

  test('connect refreshes broker status so stale dynamic ports are not reused', async () => {
    invokeBridge.mockResolvedValueOnce({
      ok: true,
      state: 'running',
      ready: true,
      running: true,
      notReadyReasons: [],
      lane: { broker: { address: { address: '127.0.0.1', port: 56207 } } },
      config: {
        endpointShape: {
          clientSecret: { path: '/v1/voice/realtime/client-secret' },
          transcript: { path: '/v1/voice/transcripts' },
        },
      },
    });
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: 'eph_test' }) })
      .mockResolvedValueOnce({ ok: true, text: async () => 'answer-sdp' });
    const track = { enabled: false, stop: jest.fn() };

    await tab.startVoiceSession({
      fetchImpl,
      mediaDevices: {
        getUserMedia: jest.fn(async () => ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        })),
      },
      RTCPeerConnection: jest.fn(() => ({
        addTrack: jest.fn(),
        createDataChannel: () => ({
          addEventListener: jest.fn(),
          readyState: 'open',
          send: jest.fn(),
          close: jest.fn(),
        }),
        createOffer: async () => ({ sdp: 'offer-sdp' }),
        setLocalDescription: jest.fn(),
        setRemoteDescription: jest.fn(),
        close: jest.fn(),
      })),
    });

    expect(invokeBridge).toHaveBeenCalledWith('voice-broker:status');
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:56207/v1/voice/realtime/client-secret', expect.any(Object));
  });

  test('data channel transcript events post to broker transcript endpoint', async () => {
    const dataChannel = {
      readyState: 'open',
      handlers: {},
      addEventListener(event, handler) {
        this.handlers[event] = handler;
      },
      send: jest.fn(),
      close: jest.fn(),
    };
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: 'eph_test' }) })
      .mockResolvedValueOnce({ ok: true, text: async () => 'answer-sdp' })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ ok: true }) });

    await tab.createVoiceRealtimeSession({
      status: {
        ok: true,
        ready: true,
        running: true,
        lane: { broker: { address: { address: '127.0.0.1', port: 43123 } } },
        config: {
          endpointShape: {
            clientSecret: { path: '/v1/voice/realtime/client-secret' },
            transcript: { path: '/v1/voice/transcripts' },
          },
        },
      },
      fetchImpl,
      mediaDevices: {
        getUserMedia: jest.fn(async () => ({
          getAudioTracks: () => [{ enabled: false, stop: jest.fn() }],
          getTracks: () => [],
        })),
      },
      RTCPeerConnection: jest.fn(() => ({
        addTrack: jest.fn(),
        createDataChannel: () => dataChannel,
        createOffer: async () => ({ sdp: 'offer-sdp' }),
        setLocalDescription: jest.fn(),
        setRemoteDescription: jest.fn(),
        close: jest.fn(),
      })),
    });

    dataChannel.handlers.message({
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'evt_1',
        transcript: 'queue this as voice ingress',
      }),
    });
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenLastCalledWith('http://127.0.0.1:43123/v1/voice/transcripts', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('queue this as voice ingress'),
    }));
  });

  test('exports data-channel contract for future voice tools without pane writes', () => {
    expect(tab.VOICE_DATA_CHANNEL_CONTRACT).toEqual(expect.objectContaining({
      channelName: 'oai-events',
      clientEvents: expect.objectContaining({
        responseCancel: 'response.cancel',
      }),
      futureToolIngress: expect.arrayContaining([
        'response.function_call_arguments.done',
      ]),
    }));
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
