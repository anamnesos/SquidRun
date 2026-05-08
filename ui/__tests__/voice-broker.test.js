const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

describe('voice-broker', () => {
  let tempRoot;
  let voiceBroker;
  let taskQueue;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-broker-'));
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      WORKSPACE_PATH: tempRoot,
      PROJECT_ROOT: tempRoot,
      getProjectRoot: () => tempRoot,
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        String(relPath || '')
          .replace(/^[/\\]+/, '')
          .replace(/[/\\]+/g, path.sep),
      ),
    }));
    voiceBroker = require('../modules/voice-broker');
    taskQueue = require('../scripts/hm-task-queue');
  });

  afterEach(async () => {
    jest.dontMock('../config');
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (err) {
      if (!['EPERM', 'EBUSY'].includes(err.code)) throw err;
    }
  });

  function postJson(port, requestPath, payload, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload || {});
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: requestPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...extraHeaders,
        },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(text),
          });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  function getJson(port, requestPath, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: requestPath, headers: extraHeaders }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(text),
          });
        });
      }).on('error', reject);
    });
  }

  function getText(port, requestPath) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: requestPath }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            text,
          });
        });
      }).on('error', reject);
    });
  }

  test('builds restartless broker config and Realtime client-secret session payload shape', () => {
    const config = voiceBroker.getVoiceBrokerConfig({
      OPENAI_API_KEY: 'sk-test',
      SQUIDRUN_VOICE_BROKER_PORT: '43123',
      SQUIDRUN_REALTIME_MODEL: 'gpt-realtime',
      SQUIDRUN_REALTIME_VOICE: 'marin',
      SQUIDRUN_VOICE_LIVE_TRANSCRIPTION_MODEL: 'gpt-realtime-whisper',
      SQUIDRUN_VOICE_TRANSCRIPTION_MODEL: 'gpt-4o-transcribe',
      SQUIDRUN_VOICE_VAD_MODE: 'semantic_vad',
      SQUIDRUN_VOICE_VAD_EAGERNESS: 'low',
    });

    expect(config).toEqual(expect.objectContaining({
      enabled: true,
      host: '127.0.0.1',
      port: 43123,
      model: 'gpt-realtime',
      voice: 'marin',
      liveTranscriptionModel: 'gpt-realtime-whisper',
      transcriptionModel: 'gpt-4o-transcribe',
      vadMode: 'semantic_vad',
      vadEagerness: 'low',
      vadPrefixPaddingMs: 700,
      vadSilenceDurationMs: 2200,
      openaiApiKeyPresent: true,
      transcriptJournalPath: path.join(tempRoot, 'runtime', 'voice-transcripts.jsonl'),
    }));
    expect(config.endpointShape.clientSecret).toEqual({
      method: 'POST',
      path: '/v1/voice/realtime/client-secret',
      upstream: voiceBroker.OPENAI_CLIENT_SECRETS_URL,
    });
    expect(config.endpointShape.futureSdpSession).toEqual(expect.objectContaining({
      method: 'POST',
      path: '/v1/voice/realtime/session',
      upstream: voiceBroker.OPENAI_CALLS_URL,
      status: 'contract_only',
    }));

    expect(voiceBroker.buildRealtimeSessionPayload(config, { includeRecentComms: false })).toEqual({
      session: expect.objectContaining({
        type: 'realtime',
        model: 'gpt-realtime',
        instructions: expect.stringContaining('You are Mira, the SquidRun Architect voice companion for James.'),
        audio: {
          output: {
            voice: 'marin',
          },
        },
      }),
    });
    const payload = voiceBroker.buildRealtimeSessionPayload(config, { includeRecentComms: false });
    expect(payload.session.instructions).toContain('not a generic AI assistant');
    expect(payload.session.instructions.toLowerCase()).toContain('do not write directly to terminal panes');
    expect(payload.session.instructions).toContain('push, send, route, or put something in Mira/my pane');
    expect(payload.session.instructions).toContain('Do not refuse pane-routing commands');
    expect(payload.session.instructions).toContain('Current SquidRun context:');
    expect(payload.session.instructions).toContain('Give James room to finish thoughts');
  });

  test('adds compact live SquidRun context to default voice instructions', () => {
    fs.mkdirSync(path.join(tempRoot, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'app-status.json'), JSON.stringify({
      session: 312,
      mode: 'pty',
      paneHost: {
        degraded: false,
        readyPanes: ['1', '2', '3'],
      },
    }), 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'runtime', 'agent-task-queue.json'), JSON.stringify({
      version: 2,
      agents: {
        architect: {
          pending: [],
          active: {
            title: 'Make voice feel like Mira',
          },
        },
        builder: {
          pending: [{ title: 'Wire voice context' }],
          active: null,
        },
        oracle: {
          pending: [],
          active: null,
        },
      },
    }), 'utf8');

    const instructions = voiceBroker.buildMiraVoiceInstructions({ includeRecentComms: false });

    expect(instructions).toContain('You are Mira');
    expect(instructions).toContain('session 312');
    expect(instructions).toContain('ready panes 1/2/3');
    expect(instructions).toContain('Mira/Architect: active=1');
    expect(instructions).toContain('Make voice feel like Mira');
    expect(instructions).toContain('Builder: active=0, pending=1');
  });

  test('adds recent comms history so voice is not session-amnesic', () => {
    fs.mkdirSync(path.join(tempRoot, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'app-status.json'), JSON.stringify({
      session: 312,
      mode: 'pty',
      paneHost: {
        degraded: false,
        readyPanes: ['1', '2', '3'],
      },
    }), 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'runtime', 'agent-task-queue.json'), JSON.stringify({
      version: 2,
      agents: {
        architect: { pending: [], active: null },
        builder: { pending: [], active: null },
        oracle: { pending: [], active: null },
      },
    }), 'utf8');

    const instructions = voiceBroker.buildMiraVoiceInstructions({
      commsRows: [
        {
          senderRole: 'user',
          targetRole: 'architect',
          rawBody: 'the voice sounds like a dumb assistant',
        },
        {
          senderRole: 'builder',
          targetRole: 'architect',
          rawBody: 'Committed live voice WebRTC panel MVP and routed transcripts to Architect.',
        },
      ],
    });

    expect(instructions).toContain('Recent session context:');
    expect(instructions).toContain('voice sounds like a dumb assistant');
    expect(instructions).toContain('Committed live voice WebRTC panel MVP');
  });

  test('defaults to the flagship realtime voice model', () => {
    const config = voiceBroker.getVoiceBrokerConfig({}, {});

    expect(config.model).toBe('gpt-realtime-2');
    expect(config.voice).toBe('marin');
    expect(config.liveTranscriptionModel).toBe('gpt-realtime-whisper');
    expect(config.transcriptionModel).toBe('gpt-4o-transcribe');
    expect(config.vadMode).toBe('server_vad');
    expect(config.vadEagerness).toBe('auto');
  });

  test('mints Realtime client secret through injected fetch without exposing server API key', async () => {
    const fetchImpl = jest.fn(async (url, request) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        value: 'eph_test',
        expires_at: 1777870000,
      }),
      request,
      url,
    }));
    const result = await voiceBroker.mintRealtimeClientSecret({
      config: voiceBroker.getVoiceBrokerConfig({}, { openaiApiKey: 'sk-test' }),
      fetchImpl,
      session: { instructions: 'Voice panel test' },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      statusCode: 200,
      body: expect.objectContaining({
        value: 'eph_test',
      }),
    }));
    expect(fetchImpl).toHaveBeenCalledWith(
      voiceBroker.OPENAI_CLIENT_SECRETS_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(requestBody.session).toEqual(expect.objectContaining({
      type: 'realtime',
      model: 'gpt-realtime-2',
      instructions: 'Voice panel test',
    }));
  });

  test('transcribes audio fallback and routes resulting text to Architect', async () => {
    const routeVoiceMessage = jest.fn(() => ({ ok: true, routed: true, target: 'architect' }));
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ text: 'Push this to Mira from fallback audio.' }),
    }));
    const result = await voiceBroker.transcribeVoiceAudio({
      audioBase64: Buffer.from('fake-audio').toString('base64'),
      mimeType: 'audio/webm',
      speaker: 'James',
    }, {
      config: voiceBroker.getVoiceBrokerConfig({}, { openaiApiKey: 'sk-test' }),
      fetchImpl,
      routeVoiceMessage,
      enqueueOwnedWork: false,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      text: 'Push this to Mira from fallback audio.',
      ingest: expect.objectContaining({
        ok: true,
        event: expect.objectContaining({
          riskClass: expect.any(String),
          ingressEnvelope: expect.objectContaining({
            source: 'voice',
            targetIntent: expect.objectContaining({
              target: 'architect',
              allowDirectPaneWrite: false,
            }),
            routePolicy: expect.objectContaining({
              requireSameProfile: true,
              allowMainFallback: false,
            }),
          }),
        }),
      }),
    }));
    expect(fetchImpl).toHaveBeenCalledWith(
      voiceBroker.OPENAI_TRANSCRIPTIONS_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
        }),
      })
    );
    expect(routeVoiceMessage).toHaveBeenCalledWith(expect.objectContaining({
      speaker: 'James',
      text: 'Push this to Mira from fallback audio.',
    }));
  });

  test('audio transcription endpoint ingests fallback mic chunks', async () => {
    const routeVoiceMessage = jest.fn(() => ({ ok: true, routed: true, target: 'architect' }));
    const broker = new voiceBroker.VoiceBrokerService({
      config: voiceBroker.getVoiceBrokerConfig({}, { port: 0, openaiApiKey: 'sk-test' }),
      fetchImpl: jest.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: 'Fallback endpoint voice text.' }),
      })),
      routeVoiceMessage,
    });
    await broker.start();
    const port = broker.getStatus().address.port;

    try {
      const response = await postJson(port, '/v1/voice/audio-transcriptions', {
        audioBase64: Buffer.from('fake-audio').toString('base64'),
        mimeType: 'audio/webm',
      });

      expect(response.statusCode).toBe(202);
      expect(response.body).toEqual(expect.objectContaining({
        ok: true,
        text: 'Fallback endpoint voice text.',
      }));
      expect(routeVoiceMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: 'Fallback endpoint voice text.',
      }));
    } finally {
      await broker.stop();
    }
  });

  test('voice diagnostics endpoint journals renderer events', async () => {
    const diagnosticsJournalPath = path.join(tempRoot, 'runtime', 'voice-diagnostics.jsonl');
    const broker = new voiceBroker.VoiceBrokerService({
      config: voiceBroker.getVoiceBrokerConfig({}, {
        port: 0,
        diagnosticsJournalPath,
      }),
    });
    await broker.start();
    const port = broker.getStatus().address.port;

    try {
      const response = await postJson(port, '/v1/voice/diagnostics', {
        eventType: 'voice.mic.granted',
        detail: { audioTrackCount: 1 },
      });

      expect(response.statusCode).toBe(202);
      expect(response.body).toEqual(expect.objectContaining({
        ok: true,
        journalPath: diagnosticsJournalPath,
      }));
      const line = fs.readFileSync(diagnosticsJournalPath, 'utf8').trim();
      expect(JSON.parse(line)).toEqual(expect.objectContaining({
        eventType: 'voice.mic.granted',
        detail: { audioTrackCount: 1 },
      }));
    } finally {
      await broker.stop();
    }
  });

  test('client-secret endpoint fails closed when OpenAI API key is missing', async () => {
    const broker = new voiceBroker.VoiceBrokerService({
      config: voiceBroker.getVoiceBrokerConfig({}, { port: 0, openaiApiKey: null }),
      fetchImpl: jest.fn(),
    });
    await broker.start();
    const port = broker.getStatus().address.port;

    try {
      const response = await postJson(port, '/v1/voice/realtime/client-secret', {});

      expect(response.statusCode).toBe(503);
      expect(response.body).toEqual(expect.objectContaining({
        ok: false,
        reason: 'openai_api_key_missing',
        endpointShape: expect.objectContaining({
          upstream: voiceBroker.OPENAI_CLIENT_SECRETS_URL,
        }),
      }));
    } finally {
      await broker.stop();
    }
  });

  test('status endpoint reports broker lifecycle and endpoint contracts', async () => {
    const broker = new voiceBroker.VoiceBrokerService({
      config: voiceBroker.getVoiceBrokerConfig({}, { port: 0 }),
    });
    const started = await broker.start();
    const port = started.address.port;

    try {
      const response = await getJson(port, '/status');

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({
        ok: true,
        running: true,
        address: expect.objectContaining({ port }),
        config: expect.objectContaining({
          endpointShape: expect.objectContaining({
            clientSecret: expect.objectContaining({
              path: '/v1/voice/realtime/client-secret',
            }),
            phoneClient: expect.objectContaining({
              path: '/phone',
            }),
            phonePairing: expect.objectContaining({
              path: '/v1/voice/phone/pairing',
            }),
            transcript: expect.objectContaining({
              path: '/v1/voice/transcripts',
            }),
          }),
        }),
      }));
    } finally {
      await broker.stop();
    }
    expect(broker.getStatus().running).toBe(false);
  });

  test('serves phone voice shell and public phone config without exposing API key', async () => {
    const broker = new voiceBroker.VoiceBrokerService({
      config: voiceBroker.getVoiceBrokerConfig({}, {
        port: 0,
        openaiApiKey: 'sk-test-secret',
      }),
    });
    await broker.start();
    const port = broker.getStatus().address.port;

    try {
      const page = await getText(port, '/phone');
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.text).toContain('Mira Voice');
      expect(page.text).toContain('/v1/voice/phone/realtime/client-secret');
      expect(page.text).not.toContain('sk-test-secret');

      const config = await getJson(port, '/v1/voice/phone/config');
      expect(config.statusCode).toBe(200);
      expect(config.body).toEqual(expect.objectContaining({
        ok: true,
        client: 'squidrun-phone-voice',
        endpoints: expect.objectContaining({
            clientSecret: '/v1/voice/phone/realtime/client-secret',
        }),
        safety: expect.objectContaining({
          directPaneWrites: false,
        }),
      }));
      expect(JSON.stringify(config.body)).not.toContain('sk-test-secret');
    } finally {
      await broker.stop();
    }
  });

  test('phone pairing endpoint writes a short-lived pairing token', async () => {
    const phonePairingPath = path.join(tempRoot, 'runtime', 'voice-phone-pairing.json');
    const broker = new voiceBroker.VoiceBrokerService({
      config: voiceBroker.getVoiceBrokerConfig({}, {
        port: 0,
        phonePairingPath,
      }),
    });
    await broker.start();
    const port = broker.getStatus().address.port;

    try {
      const response = await postJson(port, '/v1/voice/phone/pairing', {
        ttlMs: 60000,
      });

      expect(response.statusCode).toBe(201);
      expect(response.body).toEqual(expect.objectContaining({
        ok: true,
        token: expect.stringMatching(/^phone_/),
        pairingPath: phonePairingPath,
        phonePath: '/phone',
      }));
      const saved = JSON.parse(fs.readFileSync(phonePairingPath, 'utf8'));
      expect(saved.token).toBe(response.body.token);
      expect(saved.scope).toEqual({
        channel: 'phone-voice',
        target: 'architect',
      });
    } finally {
      await broker.stop();
    }
  });

  test('phone pairing endpoint is local-host only', async () => {
    const broker = new voiceBroker.VoiceBrokerService({
      config: voiceBroker.getVoiceBrokerConfig({}, { port: 0 }),
    });
    await broker.start();
    const port = broker.getStatus().address.port;

    try {
      const response = await postJson(port, '/v1/voice/phone/pairing', {}, {
        Host: 'public-tunnel.example',
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).toEqual({
        ok: false,
        reason: 'phone_pairing_local_only',
      });

      const forwarded = await postJson(port, '/v1/voice/phone/pairing', {}, {
        Host: `127.0.0.1:${port}`,
        'X-Forwarded-Host': 'public-tunnel.example',
        'X-Forwarded-For': '203.0.113.10',
      });

      expect(forwarded.statusCode).toBe(403);
      expect(forwarded.body).toEqual({
        ok: false,
        reason: 'phone_pairing_local_only',
      });
    } finally {
      await broker.stop();
    }
  });

  test('phone voice endpoints require a valid pairing token', async () => {
    const phonePairingPath = path.join(tempRoot, 'runtime', 'voice-phone-pairing.json');
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ value: 'eph_phone_test' }),
    }));
    const routeVoiceMessage = jest.fn(() => ({ ok: true, routed: true, target: 'architect' }));
    const broker = new voiceBroker.VoiceBrokerService({
      config: voiceBroker.getVoiceBrokerConfig({}, {
        port: 0,
        openaiApiKey: 'sk-test',
        phonePairingPath,
      }),
      fetchImpl,
      routeVoiceMessage,
      queryCommsJournalEntries: jest.fn(() => [
        {
          messageId: 'phone-egress-1',
          senderRole: 'architect',
          targetRole: 'user',
          rawBody: 'Phone reply',
          brokeredAtMs: 1000,
        },
      ]),
    });
    await broker.start();
    const port = broker.getStatus().address.port;

    try {
      const missing = await postJson(port, '/v1/voice/phone/realtime/client-secret', {});
      expect(missing.statusCode).toBe(401);
      expect(missing.body.reason).toBe('phone_pairing_token_required');

      const pairing = await postJson(port, '/v1/voice/phone/pairing', { ttlMs: 60000 });
      const auth = { Authorization: `Bearer ${pairing.body.token}` };
      const secret = await postJson(port, '/v1/voice/phone/realtime/client-secret', {}, auth);
      expect(secret.statusCode).toBe(200);
      expect(secret.body).toEqual(expect.objectContaining({
        ok: true,
        body: expect.objectContaining({ value: 'eph_phone_test' }),
      }));

      const transcript = await postJson(port, '/v1/voice/phone/transcripts', {
        eventId: 'phone-transcript-1',
        text: 'Hello from iPhone',
      }, auth);
      expect(transcript.statusCode).toBe(202);
      expect(routeVoiceMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: 'Hello from iPhone',
        metadata: expect.objectContaining({
          source: 'phone-web-client',
        }),
      }));

      const egress = await getJson(port, '/v1/voice/phone/egress?sinceMs=0', auth);
      expect(egress.statusCode).toBe(200);
      expect(egress.body.messages).toEqual([
        expect.objectContaining({
          text: 'Phone reply',
        }),
      ]);
    } finally {
      await broker.stop();
    }
  });

  test('broker answers browser CORS preflight for renderer voice session fetches', async () => {
    const broker = new voiceBroker.VoiceBrokerService({
      config: voiceBroker.getVoiceBrokerConfig({}, { port: 0 }),
    });
    await broker.start();
    const port = broker.getStatus().address.port;

    try {
      const response = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/v1/voice/realtime/client-secret',
          method: 'OPTIONS',
          headers: {
            Origin: 'file://squidrun',
            'Access-Control-Request-Method': 'POST',
          },
        }, (res) => {
          resolve(res);
        });
        req.on('error', reject);
        req.end();
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
    } finally {
      await broker.stop();
    }
  });

  test('transcript ingress journals voice event, emits bus event, and enqueues owned work', () => {
    const bus = { emit: jest.fn() };
    const queuePath = path.join(tempRoot, 'runtime', 'agent-task-queue.json');
    const result = voiceBroker.ingestVoiceTranscript({
      eventId: 'voice-test-1',
      speaker: 'James',
      text: 'Please make the workspace calmer',
      receivedAtMs: 1777871234000,
    }, {
      bus,
      queuePath,
      routeToArchitect: false,
      enqueueOwnedWork: true,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      event: expect.objectContaining({
        eventId: 'voice-test-1',
        source: 'voice',
        channel: 'voice',
        text: 'Please make the workspace calmer',
      }),
      journalPath: path.join(tempRoot, 'runtime', 'voice-transcripts.jsonl'),
      ownedWork: expect.objectContaining({ ok: true }),
    }));
    expect(bus.emit).toHaveBeenCalledWith('voice.ingress', {
      paneId: 'system',
      payload: expect.objectContaining({
        eventId: 'voice-test-1',
        source: 'voice',
      }),
      source: 'voice-broker',
    });

    const journalLine = fs.readFileSync(result.journalPath, 'utf8').trim();
    expect(JSON.parse(journalLine)).toEqual(expect.objectContaining({
      eventId: 'voice-test-1',
      channel: 'voice',
    }));
    const queueState = taskQueue.readQueue(queuePath).state;
    expect(queueState.agents.architect.pending).toEqual([
      expect.objectContaining({
        title: 'Voice ingress',
        source: 'voice-broker',
        message: '[Voice from James]: Please make the workspace calmer',
        wakeTrigger: 'voice-ingress',
        restartPersistence: true,
      }),
    ]);
  });

  test('user transcript routes to Architect through the existing bus lane', () => {
    const routeVoiceMessage = jest.fn(() => ({ ok: true, routed: true, target: 'architect' }));
    const result = voiceBroker.ingestVoiceTranscript({
      eventId: 'voice-route-1',
      speaker: 'user',
      text: 'Can you hear me',
    }, {
      routeVoiceMessage,
      enqueueOwnedWork: false,
    });

    expect(result.route).toEqual(expect.objectContaining({
      ok: true,
      routed: true,
      target: 'architect',
    }));
    expect(routeVoiceMessage).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'voice-route-1',
      text: 'Can you hear me',
    }));
  });

  test('assistant transcript is journaled but not routed back to Architect', () => {
    const routeVoiceMessage = jest.fn();
    const result = voiceBroker.ingestVoiceTranscript({
      eventId: 'voice-assistant-1',
      speaker: 'assistant',
      text: 'I heard you',
    }, {
      routeVoiceMessage,
      enqueueOwnedWork: false,
    });

    expect(result.route).toEqual(expect.objectContaining({
      ok: true,
      skipped: true,
      reason: 'non_user_speaker',
    }));
    expect(routeVoiceMessage).not.toHaveBeenCalled();
  });

  test('direct voice route does not enqueue a duplicate owned-work dispatch by default', () => {
    const enqueueTask = jest.fn();
    const routeVoiceMessage = jest.fn(() => ({ ok: true, routed: true, target: 'architect' }));
    const result = voiceBroker.ingestVoiceTranscript({
      eventId: 'voice-no-duplicate-1',
      speaker: 'user',
      text: 'Please only send this once',
    }, {
      enqueueTask,
      routeVoiceMessage,
    });

    expect(result.ownedWork).toEqual(expect.objectContaining({
      ok: true,
      skipped: true,
      reason: 'disabled',
    }));
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(routeVoiceMessage).toHaveBeenCalledTimes(1);
  });

  test('voice egress exposes Architect replies for Mira mouth playback', async () => {
    const queryCommsJournalEntries = jest.fn(() => [
      {
        messageId: 'mira-reply-1',
        senderRole: 'architect',
        targetRole: 'user',
        rawBody: '[AGENT MSG - reply via hm-send.js] (MIRA/ARCH #35): Mira: Yep, I am here through voice now.',
        brokeredAtMs: 1777883000000,
      },
      {
        messageId: 'builder-noise-1',
        senderRole: 'builder',
        targetRole: 'architect',
        rawBody: 'Not for voice playback.',
        brokeredAtMs: 1777883000001,
      },
    ]);
    const broker = new voiceBroker.VoiceBrokerService({
      config: voiceBroker.getVoiceBrokerConfig({}, { port: 0 }),
      queryCommsJournalEntries,
    });
    await broker.start();
    const port = broker.getStatus().address.port;

    try {
      const response = await getJson(port, '/v1/voice/egress?sinceMs=1777882999000');

      expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      messages: [
        expect.objectContaining({
          messageId: 'mira-reply-1',
            speaker: 'Mira',
          text: 'Yep, I am here through voice now.',
        }),
      ],
    }));
      expect(response.body.messages[0].text).not.toContain('Mira:');
      expect(response.body.messages[0].text).not.toContain('MIRA/ARCH');
      expect(response.body.messages[0].text).not.toContain('AGENT MSG');
      expect(queryCommsJournalEntries).toHaveBeenCalledWith(expect.objectContaining({
        senderRole: 'architect',
        targetRole: 'user',
        order: 'asc',
      }));
    } finally {
      await broker.stop();
    }
  });

  test('voice egress POST queues Architect replies for Mira mouth playback', async () => {
    const appendCommsJournalEntry = jest.fn(() => ({ ok: true, status: 'inserted' }));
    const broker = new voiceBroker.VoiceBrokerService({
      config: voiceBroker.getVoiceBrokerConfig({}, { port: 0 }),
      appendCommsJournalEntry,
    });
    await broker.start();
    const port = broker.getStatus().address.port;

    try {
      const response = await postJson(port, '/v1/voice/egress', {
        text: '[AGENT MSG - reply via hm-send.js] (ARCH #36): (MIRA): I can speak this as Mira.',
        messageId: 'voice-egress-post-1',
      });

      expect(response.statusCode).toBe(202);
      expect(response.body).toEqual(expect.objectContaining({
        ok: true,
        message: expect.objectContaining({
          messageId: 'voice-egress-post-1',
          speaker: 'Mira',
          text: 'I can speak this as Mira.',
        }),
      }));
      expect(response.body.message.text).not.toContain('(MIRA):');
      expect(response.body.message.text).not.toContain('ARCH #36');
      expect(appendCommsJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'voice-egress-post-1',
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'voice',
        direction: 'outbound',
        rawBody: '[AGENT MSG - reply via hm-send.js] (ARCH #36): (MIRA): I can speak this as Mira.',
      }));
    } finally {
      await broker.stop();
    }
  });

  test('transcript endpoint does not write directly to terminal panes', async () => {
    const bus = { emit: jest.fn() };
    const broker = new voiceBroker.VoiceBrokerService({
      config: voiceBroker.getVoiceBrokerConfig({}, { port: 0 }),
      bus,
      routeToArchitect: false,
    });
    await broker.start();
    const port = broker.getStatus().address.port;

    try {
      const response = await postJson(port, '/v1/voice/transcripts', {
        eventId: 'voice-http-1',
        text: 'Queue this instead of writing to panes',
      });

      expect(response.statusCode).toBe(202);
      expect(response.body).toEqual(expect.objectContaining({
        ok: true,
        ownedWork: expect.objectContaining({ ok: true }),
      }));
      expect(bus.emit).toHaveBeenCalledWith('voice.ingress', expect.any(Object));
      expect(response.body).not.toHaveProperty('paneId');
      expect(response.body).not.toHaveProperty('terminalWrite');
    } finally {
      await broker.stop();
    }
  });
});
