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
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function postJson(port, requestPath, payload) {
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

  function getJson(port, requestPath) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: requestPath }, (res) => {
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

  test('builds restartless broker config and Realtime client-secret session payload shape', () => {
    const config = voiceBroker.getVoiceBrokerConfig({
      OPENAI_API_KEY: 'sk-test',
      SQUIDRUN_VOICE_BROKER_PORT: '43123',
      SQUIDRUN_REALTIME_MODEL: 'gpt-realtime',
      SQUIDRUN_REALTIME_VOICE: 'marin',
    });

    expect(config).toEqual(expect.objectContaining({
      enabled: true,
      host: '127.0.0.1',
      port: 43123,
      model: 'gpt-realtime',
      voice: 'marin',
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
    expect(payload.session.instructions).toContain('Current SquidRun context:');
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

    expect(config.model).toBe('gpt-realtime-1.5');
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
      model: 'gpt-realtime-1.5',
      instructions: 'Voice panel test',
    }));
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
        rawBody: 'Yep, I am here through voice now.',
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
      expect(queryCommsJournalEntries).toHaveBeenCalledWith(expect.objectContaining({
        senderRole: 'architect',
        targetRole: 'user',
        order: 'asc',
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
