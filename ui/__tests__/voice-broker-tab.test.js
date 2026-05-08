const fs = require('fs');
const path = require('path');

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
    expect(elements.voiceBrokerModel.textContent).toContain('voice wrapper');
    expect(elements.voiceBrokerModel.textContent).not.toContain('live Mira brain');
    expect(elements.voiceBrokerModel.textContent).not.toContain('native audio brain');
    expect(elements.voiceBrokerStartBtn.disabled).toBe(true);
    expect(elements.voiceBrokerStopBtn.disabled).toBe(false);
    expect(elements.voiceBrokerRestartBtn.disabled).toBe(false);
  });

  test('desktop voice surface includes hold control and AI voice disclosure', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

    expect(html).toContain('id="voicePushToTalkBtn"');
    expect(html).toContain('Hold to Talk');
    expect(html).toContain('id="voiceDisclosure"');
    expect(html).toContain('AI-generated voice audio');
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
          liveTranscriptionModel: 'gpt-realtime-whisper',
          transcriptionModel: 'gpt-4o-transcribe',
          vadMode: 'semantic_vad',
          vadEagerness: 'low',
          vadPrefixPaddingMs: 900,
          vadSilenceDurationMs: 2600,
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
    expect(peer.addTrack).toHaveBeenCalledWith(track, stream);
    expect(track.enabled).toBe(false);
    dataChannel.handlers.open();
    expect(dataChannel.sent).toContainEqual(expect.objectContaining({
      type: 'session.update',
      session: expect.objectContaining({
        type: 'realtime',
        audio: expect.objectContaining({
          input: expect.objectContaining({
            transcription: expect.objectContaining({
              model: 'gpt-realtime-whisper',
            }),
          }),
        }),
      }),
    }));
    expect(dataChannel.sent[0].session.audio.input.turn_detection).toEqual(expect.objectContaining({
      type: 'semantic_vad',
      eagerness: 'low',
      create_response: false,
      interrupt_response: true,
    }));
  });

  test('records mic chunks as fallback transcription route', async () => {
    const blob = {
      size: 10,
      type: 'audio/webm',
      arrayBuffer: async () => Buffer.from('fake-audio'),
    };
    const recorder = {
      handlers: {},
      addEventListener(event, handler) {
        this.handlers[event] = handler;
      },
      start: jest.fn(),
      stop: jest.fn(),
    };
    const MediaRecorder = jest.fn(() => recorder);
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: 'eph_test' }) })
      .mockResolvedValueOnce({ ok: true, text: async () => 'answer-sdp' })
      .mockResolvedValue({ ok: true, status: 202, json: async () => ({ ok: true, text: 'fallback heard me' }) });
    const dataChannel = {
      handlers: {},
      addEventListener(event, handler) {
        this.handlers[event] = handler;
      },
      readyState: 'open',
      send: jest.fn(),
      close: jest.fn(),
    };

    await tab.createVoiceRealtimeSession({
      status: {
        ok: true,
        ready: true,
        running: true,
        lane: { broker: { address: { address: '127.0.0.1', port: 43123 } } },
        config: {
          endpointShape: {
            clientSecret: { path: '/v1/voice/realtime/client-secret' },
            audioTranscription: { path: '/v1/voice/audio-transcriptions' },
          },
        },
      },
      fetchImpl,
      MediaRecorder,
      mediaDevices: {
        getUserMedia: jest.fn(async () => ({
          getAudioTracks: () => [{ enabled: true, stop: jest.fn() }],
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

    expect(recorder.start).toHaveBeenCalledWith(4000);
    dataChannel.handlers.message({
      data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
    });
    recorder.handlers.dataavailable({ data: blob });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenLastCalledWith('http://127.0.0.1:43123/v1/voice/audio-transcriptions', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('audioBase64'),
    }));
  });

  test('skips fallback mic chunks once native realtime transcription is active', async () => {
    const blob = {
      size: 10,
      type: 'audio/webm',
      arrayBuffer: async () => Buffer.from('fake-audio'),
    };
    const recorder = {
      handlers: {},
      addEventListener(event, handler) {
        this.handlers[event] = handler;
      },
      start: jest.fn(),
      stop: jest.fn(),
    };
    const MediaRecorder = jest.fn(() => recorder);
    const fetchImpl = jest.fn(async (url) => {
      const target = String(url || '');
      if (target.includes('/v1/voice/realtime/client-secret')) {
        return { ok: true, json: async () => ({ value: 'eph_test' }) };
      }
      if (target.includes('/v1/realtime/calls')) {
        return { ok: true, text: async () => 'answer-sdp' };
      }
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    });
    const dataChannel = {
      handlers: {},
      addEventListener(event, handler) {
        this.handlers[event] = handler;
      },
      readyState: 'open',
      send: jest.fn(),
      close: jest.fn(),
    };

    await tab.createVoiceRealtimeSession({
      status: {
        ok: true,
        ready: true,
        running: true,
        lane: { broker: { address: { address: '127.0.0.1', port: 43123 } } },
        config: {
          endpointShape: {
            clientSecret: { path: '/v1/voice/realtime/client-secret' },
            audioTranscription: { path: '/v1/voice/audio-transcriptions' },
            diagnostics: { path: '/v1/voice/diagnostics' },
          },
        },
      },
      fetchImpl,
      MediaRecorder,
      mediaDevices: {
        getUserMedia: jest.fn(async () => ({
          getAudioTracks: () => [{ enabled: true, stop: jest.fn() }],
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
      data: JSON.stringify({ type: 'session.updated' }),
    });
    dataChannel.handlers.message({
      data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
    });
    recorder.handlers.dataavailable({ data: blob });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchImpl).not.toHaveBeenCalledWith(
      'http://127.0.0.1:43123/v1/voice/audio-transcriptions',
      expect.any(Object)
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/v1/voice/diagnostics',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('native_transcription_active_skipped'),
      })
    );
  });

  test('posts voice diagnostics to broker endpoint', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ ok: true }),
    }));
    const result = await tab.postVoiceDiagnostic('voice.mic.granted', {
      audioTrackCount: 1,
    }, {
      fetchImpl,
      status: {
        lane: { broker: { address: { address: '127.0.0.1', port: 43123 } } },
        config: {
          endpointShape: {
            diagnostics: { path: '/v1/voice/diagnostics' },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:43123/v1/voice/diagnostics', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('voice.mic.granted'),
    }));
  });

  test('push-to-talk, mute, interrupt, and stop use WebRTC state only', async () => {
    const track = { enabled: true, stop: jest.fn() };
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

    expect(track.enabled).toBe(false);
    expect(elements.voiceSessionStatus.textContent).toBe('Connected');
    expect(tab.setPushToTalk(true)).toBe(true);
    expect(track.enabled).toBe(true);
    expect(tab.setPushToTalk(false)).toBe(true);
    expect(track.enabled).toBe(false);
    expect(tab.muteVoiceSession()).toBe(true);
    expect(track.enabled).toBe(false);
    expect(tab.interruptVoiceSession()).toBe(true);
    expect(dataChannel.sent).toContainEqual({ type: 'response.cancel' });
    tab.stopVoiceSession();
    expect(track.stop).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
  });

  test('desktop hold-to-talk handlers enable only while held and stop clears active state', async () => {
    const track = { enabled: true, stop: jest.fn() };
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
    tab.setupVoiceBrokerTab();

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

    const push = elements.voicePushToTalkBtn;
    const pointerDown = push.listeners.get('pointerdown');
    const pointerUp = push.listeners.get('pointerup');
    const pointerCancel = push.listeners.get('pointercancel');
    const pointerLeave = push.listeners.get('pointerleave');
    const keyDown = push.listeners.get('keydown');
    const keyUp = push.listeners.get('keyup');
    const event = () => ({ preventDefault: jest.fn(), pointerId: 7 });

    expect(track.enabled).toBe(false);
    pointerDown(event());
    expect(track.enabled).toBe(true);
    expect(push.dataset.active).toBe('true');
    pointerUp(event());
    expect(track.enabled).toBe(false);
    expect(push.dataset.active).toBe('false');

    pointerDown(event());
    expect(track.enabled).toBe(true);
    pointerCancel(event());
    expect(track.enabled).toBe(false);

    pointerDown(event());
    expect(track.enabled).toBe(true);
    pointerLeave(event());
    expect(track.enabled).toBe(false);

    keyDown({ key: ' ', repeat: false, preventDefault: jest.fn() });
    expect(track.enabled).toBe(true);
    keyUp({ key: ' ', preventDefault: jest.fn() });
    expect(track.enabled).toBe(false);

    keyDown({ key: 'Enter', repeat: false, preventDefault: jest.fn() });
    expect(track.enabled).toBe(true);
    tab.stopVoiceSession();
    expect(track.enabled).toBe(false);
    expect(track.stop).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
    expect(push.dataset.active).toBe('false');
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
    const track = { enabled: true, stop: jest.fn() };

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
          getAudioTracks: () => [{ enabled: true, stop: jest.fn() }],
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

  test('user transcript cancels generic voice response and still routes to broker', async () => {
    const dataChannel = {
      readyState: 'open',
      handlers: {},
      sent: [],
      addEventListener(event, handler) {
        this.handlers[event] = handler;
      },
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
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
          getAudioTracks: () => [{ enabled: true, stop: jest.fn() }],
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
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'push this',
      }),
    });
    dataChannel.handlers.message({
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'evt_1',
        transcript: 'push this to Mira pane',
      }),
    });
    await Promise.resolve();

    expect(dataChannel.sent).toContainEqual({ type: 'response.cancel' });
    expect(dataChannel.sent).toContainEqual({ type: 'output_audio_buffer.clear' });
    expect(elements.voiceSessionLog.textContent).toContain('Transcript received');
    expect(elements.voiceSessionLog.textContent).not.toContain('conversation.item.input_audio_transcription.delta');
    expect(elements.voiceSessionLog.textContent).not.toContain('conversation.item.input_audio_transcription.completed');
    expect(elements.voiceSessionLog.textContent).not.toContain('Generic voice response canceled');
    expect(fetchImpl).toHaveBeenLastCalledWith('http://127.0.0.1:43123/v1/voice/transcripts', expect.objectContaining({
      body: expect.stringContaining('push this to Mira pane'),
    }));
  });

  test('reports transcript route failures without blaming expected generic cancellation', async () => {
    const dataChannel = {
      readyState: 'open',
      handlers: {},
      sent: [],
      addEventListener(event, handler) {
        this.handlers[event] = handler;
      },
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
      close: jest.fn(),
    };
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: 'eph_test' }) })
      .mockResolvedValueOnce({ ok: true, text: async () => 'answer-sdp' })
      .mockRejectedValueOnce(new Error('broker down'));

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
          getAudioTracks: () => [{ enabled: true, stop: jest.fn() }],
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
        transcript: 'route me even if broker is down',
      }),
    });
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(dataChannel.sent).toContainEqual({ type: 'response.cancel' });
    expect(elements.voiceSessionLog.textContent).toContain('Transcript route failed: broker down');
    expect(elements.voiceBrokerError.textContent).toBe('Transcript route failed: broker down');
    expect(elements.voiceSessionStatus.textContent).toBe('Transcript route failed');
    expect(elements.voiceSessionLog.textContent).not.toContain('Generic voice response canceled');
  });

  test('does not cancel Realtime response while speaking a Mira egress reply', () => {
    const dataChannel = {
      readyState: 'open',
      sent: [],
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
    };
    const session = { dataChannel };

    tab.speakMiraReply(session, 'This is the actual Mira reply.');
    expect(tab.cancelGenericRealtimeResponse(session, 'response.created')).toBe(false);
    expect(dataChannel.sent.filter((event) => event.type === 'response.cancel')).toHaveLength(0);
  });

  test('speaks Architect replies through the Realtime data channel', () => {
    const dataChannel = {
      readyState: 'open',
      sent: [],
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
    };

    expect(tab.speakMiraReply(
      { dataChannel },
      '[AGENT MSG - reply via hm-send.js] (MIRA/ARCH #35): This is Mira speaking through the voice mouth.'
    )).toBe(true);

    expect(dataChannel.sent).toEqual([
      expect.objectContaining({
        type: 'response.create',
        response: expect.objectContaining({
          input: [],
          output_modalities: ['audio'],
          instructions: expect.stringContaining('This is Mira speaking through the voice mouth.'),
        }),
      }),
    ]);
    expect(dataChannel.sent[0].response.instructions).not.toContain('(ARCH #35)');
    expect(dataChannel.sent[0].response.instructions).not.toContain('MIRA/ARCH');
    expect(dataChannel.sent[0].response.instructions).not.toContain('AGENT MSG');
  });

  test('strips leading persona and voice-routing labels from spoken egress only', () => {
    const dataChannel = {
      readyState: 'open',
      sent: [],
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
    };

    expect(tab.speakMiraReply(
      { dataChannel },
      '[Voice from James] (MIRA): Mira: Please keep Mira in the actual sentence.'
    )).toBe(true);

    const spoken = dataChannel.sent[0].response.instructions;
    expect(spoken).toContain('Please keep Mira in the actual sentence.');
    expect(spoken).not.toContain('[Voice from James]');
    expect(spoken).not.toContain('(MIRA):');
    expect(spoken).not.toContain('Mira: Please');
  });

  test('polls voice egress and speaks new Architect messages once', async () => {
    const dataChannel = {
      readyState: 'open',
      sent: [],
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
    };
    const session = {
      dataChannel,
      egressSinceMs: 1777883000000,
      spokenMessageIds: new Set(),
    };
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        messages: [{
          messageId: 'mira-reply-1',
          text: 'I am answering as Mira now.',
          timestampMs: 1777883000123,
        }],
      }),
    }));
    const status = {
      lane: { broker: { address: { address: '127.0.0.1', port: 43123 } } },
      config: {
        endpointShape: {
          egress: { path: '/v1/voice/egress' },
        },
      },
    };

    await tab.pollVoiceEgressOnce(session, status, fetchImpl);
    await tab.pollVoiceEgressOnce(session, status, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/v1/voice/egress?sinceMs=1777883000000&limit=10',
      { method: 'GET' }
    );
    expect(dataChannel.sent.filter((event) => event.type === 'response.create')).toHaveLength(1);
    expect(session.egressSinceMs).toBe(1777883000124);
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
