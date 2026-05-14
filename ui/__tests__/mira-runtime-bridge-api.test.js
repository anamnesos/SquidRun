'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  evaluateCandidate,
  readVoiceLab,
} = require('../../mira/tools/evaluate-voice-lab');

describe('Mira runtime bridge manual-plan API', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const runtimeTsconfig = path.join(repoRoot, 'mira', 'runtime', 'tsconfig.json');
  const tscBin = path.join(repoRoot, 'ui', 'node_modules', 'typescript', 'bin', 'tsc');
  const compiledServerPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'server.js');
  let serverProcess;
  let openAiMockServer;
  let openAiRequests;
  let baseUrl;
  let tempStateRoot;
  const voiceLabPath = path.join(repoRoot, 'mira', 'voice', 'voice-lab-v0.jsonl');

  beforeAll(() => {
    execFileSync(process.execPath, [
      tscBin,
      '-p',
      runtimeTsconfig,
    ], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  });

  afterEach(async () => {
    if (!serverProcess) return;
    const closing = new Promise((resolve) => {
      serverProcess.once('close', resolve);
    });
    serverProcess.kill();
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(resolve, 1000);
    });
    await Promise.race([
      closing,
      timeout,
    ]);
    clearTimeout(timeoutId);
    serverProcess.stdout?.destroy();
    serverProcess.stderr?.destroy();
    serverProcess.removeAllListeners();
    serverProcess = null;
    baseUrl = null;
    if (tempStateRoot) {
      fs.rmSync(tempStateRoot, { recursive: true, force: true });
      tempStateRoot = null;
    }
    if (openAiMockServer) {
      await new Promise((resolve, reject) => {
        openAiMockServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      openAiMockServer = null;
      openAiRequests = null;
    }
  });

  function startServer(extraEnv = {}) {
    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, [compiledServerPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          MIRA_RUNTIME_PORT: '0',
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stderr = '';
      const timeout = setTimeout(() => {
        reject(new Error(`runtime server did not start. stderr=${stderr}`));
      }, 5000);

      serverProcess.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      serverProcess.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      serverProcess.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (!match) return;
        clearTimeout(timeout);
        baseUrl = `http://127.0.0.1:${match[1]}`;
        resolve(baseUrl);
      });
    });
  }

  function writeNormalizedCoreStateRoot() {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-turn-state-'));
    fs.mkdirSync(path.join(tempStateRoot, 'imports', 'receipts'), { recursive: true });
    fs.mkdirSync(path.join(tempStateRoot, 'continuity', 'core'), { recursive: true });
    fs.mkdirSync(path.join(tempStateRoot, 'permissions', 'core'), { recursive: true });

    fs.writeFileSync(path.join(tempStateRoot, 'imports', 'receipts', 'normalized-core-state-v1-test.json'), JSON.stringify({
      schema: 'mira.normalized_core_receipt.v0',
      batch_id: 'normalized-core-state-v1',
      records: [
        {
          id: 'mira_self_profile',
          destination_relative_path: 'continuity/core/mira-self-profile.normalized.json',
          output_schema: 'mira.normalized.self_profile.v1',
        },
        {
          id: 'james_relationship_state',
          destination_relative_path: 'continuity/core/james-relationship-state.normalized.json',
          output_schema: 'mira.normalized.james_relationship_state.v1',
        },
        {
          id: 'relationship_presence_permissions',
          destination_relative_path: 'permissions/core/relationship-presence-permissions.normalized.json',
          output_schema: 'mira.normalized.relationship_presence_permissions.v1',
        },
      ],
    }, null, 2));
    fs.writeFileSync(path.join(tempStateRoot, 'continuity', 'core', 'mira-self-profile.normalized.json'), JSON.stringify({
      schema: 'mira.normalized.self_profile.v1',
      profile_kind: 'ai_system_local_presence_profile',
      role: 'relationship_presence_local_start_proof',
      model_runtime_active: false,
      persona_runtime_active: false,
      source_metadata: {
        metadata_only: true,
        live_continuity_excluded: true,
      },
    }, null, 2));
    fs.writeFileSync(path.join(tempStateRoot, 'continuity', 'core', 'james-relationship-state.normalized.json'), JSON.stringify({
      schema: 'mira.normalized.james_relationship_state.v1',
      relationship_mode: 'collaborative_presence_design',
      what_mira_knows_about_james: 'James wants Mira to be caring, opinionated, friction-capable, and not a mirror.',
      source_metadata: {
        metadata_only: true,
        live_continuity_excluded: true,
      },
    }, null, 2));
    fs.writeFileSync(path.join(tempStateRoot, 'permissions', 'core', 'relationship-presence-permissions.normalized.json'), JSON.stringify({
      schema: 'mira.normalized.relationship_presence_permissions.v1',
      permissions: {
        read_local_redacted_context: true,
        propose_next_action: true,
        send_external: false,
        network: false,
        deploy: false,
        trade: false,
        runtime_start: false,
        fail_closed: true,
      },
      caveats: {
        local_store_write_allowed_now: 'scoped_only_to_reviewed_import_and_mira_state_root_writes_after_explicit_approval',
        blanket_mira_runtime_write_permission: false,
      },
      source_metadata: {
        metadata_only: true,
        live_continuity_excluded: true,
      },
    }, null, 2));

    return tempStateRoot;
  }

  function writeOperatorContext(stateRoot) {
    const operatorDir = path.join(stateRoot, 'context', 'operator');
    fs.mkdirSync(operatorDir, { recursive: true });
    fs.writeFileSync(path.join(operatorDir, 'operator-context.normalized.json'), JSON.stringify({
      schema: 'mira.normalized.operator_context.v1',
      business_thesis: 'Mira is James operating extension for CRM, ERP, admin, customer communication, tax, documents, computer-use, and business workflows.',
      operating_lanes: [
        'CRM',
        'ERP',
        'admin',
        'customer communication',
        'tax',
        'documents',
        'computer-use',
        'business workflows',
      ],
      known_product_lanes: ['TrustQuote'],
      explicit_non_claims: [
        'TrustQuote is not proof of the business legal name',
        'do not invent James business name',
      ],
      source_metadata: {
        source_path: 'workspace/knowledge/user-context.md',
        metadata_only: true,
        live_continuity_excluded: true,
        raw_content_included: false,
        normalized_summary_only: true,
      },
    }, null, 2));
  }

  function startOpenAiMock(handler) {
    openAiRequests = [];
    return new Promise((resolve, reject) => {
      openAiMockServer = http.createServer((request, response) => {
        let rawBody = '';
        request.on('data', (chunk) => {
          rawBody += chunk.toString();
        });
        request.on('end', () => {
          const parsedBody = rawBody ? JSON.parse(rawBody) : null;
          openAiRequests.push({
            method: request.method,
            url: request.url,
            authorization: request.headers.authorization,
            body: parsedBody,
          });
          handler(request, response, parsedBody);
        });
      });
      openAiMockServer.once('error', reject);
      openAiMockServer.listen(0, '127.0.0.1', () => {
        const address = openAiMockServer.address();
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  test('returns manual bridge plan without executing send CLI', async () => {
    await startServer();

    const response = await fetch(`${baseUrl}/bridge/manual-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetRole: 'builder',
        content: '(MIRA #1): runtime manual plan API',
        sessionId: 'app-session-373',
        messageId: 'mira-runtime-api-plan-1',
        requestId: 'req-runtime-api-plan-1',
        evidence: [{
          kind: 'file',
          path: 'mira/bridge/squidrun-adapter-protocol-v0.md',
          summary: 'Runtime API manual plan evidence.',
        }],
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_bridge_request_plan.v0',
      manualExecutionRequired: true,
      runtimeExecutes: false,
      target: {
        role: 'builder',
        paneId: '2',
      },
      envelope: expect.objectContaining({
        request_id: 'req-runtime-api-plan-1',
        message_id: 'mira-runtime-api-plan-1',
        session_id: 'app-session-373',
        body: {
          content: '(MIRA #1): runtime manual plan API',
        },
      }),
      command: expect.objectContaining({
        executable: process.execPath,
        args: expect.arrayContaining([
          '--target',
          'builder',
          '--content',
          '(MIRA #1): runtime manual plan API',
        ]),
      }),
    }));
  });

  test('serves the minimal Mira web UI from the runtime', async () => {
    await startServer();

    const indexResponse = await fetch(`${baseUrl}/`);
    const indexHtml = await indexResponse.text();
    const appResponse = await fetch(`${baseUrl}/app.js`);
    const appJs = await appResponse.text();
    const cssResponse = await fetch(`${baseUrl}/styles.css`);
    const css = await cssResponse.text();

    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get('content-type')).toContain('text/html');
    expect(indexHtml).toContain('<h1>Mira</h1>');
    expect(indexHtml).toContain('id="turnForm"');
    expect(indexHtml).toContain('id="contextPanel"');
    expect(indexHtml).toContain('id="reviewSummary"');
    expect(indexHtml).toContain('Mira.</p>');
    expect(indexHtml).not.toContain('Mira Runtime');
    expect(indexHtml).not.toContain('business mess');
    expect(appResponse.status).toBe(200);
    expect(appResponse.headers.get('content-type')).toContain('text/javascript');
    expect(appJs).toContain("fetch('/turn'");
    expect(appJs).toContain("fetch('/voice/correction'");
    expect(appJs).toContain("fetch('/voice/corrections'");
    expect(appJs).toContain('wrong shape');
    expect(appJs).toContain('contextToggle');
    expect(appJs).toContain('useModel');
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get('content-type')).toContain('text/css');
    expect(css).toContain('.conversation');
    expect(css).toContain('.context-panel');
    expect(css).toContain('.subtle-button');
    expect(css).not.toContain('.side');
  });

  test('captures voice correction candidates from runtime API without mutating live voice lab', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-voice-review-'));
    const reviewPath = path.join(tempStateRoot, 'review', 'candidates.jsonl');
    const beforeVoiceLab = fs.readFileSync(voiceLabPath, 'utf8');
    await startServer({ MIRA_VOICE_REVIEW_PATH: reviewPath });

    const response = await fetch(`${baseUrl}/voice/correction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'who are you',
        soundedFake: 'Mira. I am your local AI presence.',
        better: 'Mira.',
        caseId: 'identity-who-are-you-v0',
        source: 'runtime-api-test',
      }),
    });
    const payload = await response.json();
    const records = fs.readFileSync(reviewPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.voice_review_capture.v0',
      out_path: path.resolve(reviewPath),
      live_voice_mutated: false,
      record: expect.objectContaining({
        schema: 'mira.voice_review_candidate.v0',
        prompt: 'who are you',
        sounded_fake: 'Mira. I am your local AI presence.',
        better_phrasing: 'Mira.',
        suggested_case_id: 'identity-who-are-you-v0',
        review_status: 'pending_review',
        live_voice_mutated: false,
      }),
    }));
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(payload.record);
    expect(fs.readFileSync(voiceLabPath, 'utf8')).toBe(beforeVoiceLab);
  });

  test('lists voice correction candidates from runtime API without mutating them', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-voice-review-'));
    const reviewPath = path.join(tempStateRoot, 'review', 'candidates.jsonl');
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    fs.writeFileSync(reviewPath, `${JSON.stringify({
      schema: 'mira.voice_review_candidate.v0',
      id: 'voice-review-test-1',
      created_at: '2026-05-14T00:00:00.000Z',
      source: 'test',
      prompt: 'who are you',
      sounded_fake: 'Mira. I am your local AI presence.',
      better_phrasing: 'Mira.',
      suggested_case_id: 'identity-who-are-you-v0',
      review_status: 'pending_review',
      live_voice_mutated: false,
    })}\n`, 'utf8');
    const before = fs.readFileSync(reviewPath, 'utf8');
    await startServer({ MIRA_VOICE_REVIEW_PATH: reviewPath });

    const response = await fetch(`${baseUrl}/voice/corrections`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      ok: true,
      protocol: 'mira.voice_review_list.v0',
      path: path.resolve(reviewPath),
      count: 1,
      pending_count: 1,
      live_voice_mutated: false,
      records: [
        expect.objectContaining({
          id: 'voice-review-test-1',
          better_phrasing: 'Mira.',
          review_status: 'pending_review',
          live_voice_mutated: false,
        }),
      ],
    });
    expect(fs.readFileSync(reviewPath, 'utf8')).toBe(before);
  });

  test('refuses incomplete voice correction captures', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-voice-review-'));
    const reviewPath = path.join(tempStateRoot, 'review', 'candidates.jsonl');
    await startServer({ MIRA_VOICE_REVIEW_PATH: reviewPath });

    const response = await fetch(`${baseUrl}/voice/correction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'who are you',
        soundedFake: 'Mira. I am your local AI presence.',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: {
        code: 'missing_better',
        message: 'better is required.',
        retryable: false,
      },
    });
    expect(fs.existsSync(reviewPath)).toBe(false);
  });

  test('refuses external manual-plan targets without execution fields', async () => {
    await startServer();

    const response = await fetch(`${baseUrl}/bridge/manual-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetRole: 'telegram',
        content: '(MIRA #2): must not plan',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: {
        code: 'external_target_refused',
        message: expect.stringContaining('only target SquidRun panes'),
        retryable: false,
      },
    });
    expect(payload.command).toBeUndefined();
  });

  test('returns a basic runtime turn with state snapshot and no execution', async () => {
    await startServer();

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'What do you know right now?',
        sessionId: 'app-session-373',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_turn.v0',
      runtimeExecutes: false,
      modelInvoked: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
      model: {
        requested: false,
        provider: null,
        model: null,
        responseId: null,
        toolsEnabled: false,
        sendsEnabled: false,
        store: false,
      },
      input: {
        text: 'What do you know right now?',
        sessionId: 'app-session-373',
      },
      state: expect.objectContaining({
        continuityLoaded: false,
        liveDataImported: false,
        acceptanceContinuityLoaded: expect.any(Boolean),
        acceptanceDocumentCount: expect.any(Number),
        normalizedCoreLoaded: expect.any(Boolean),
        normalizedCoreDocumentCount: expect.any(Number),
      }),
      loadedCoreSummary: expect.objectContaining({
        available: expect.any(Boolean),
        metadataOnly: true,
        liveContinuityExcluded: true,
      }),
      operatorContext: expect.objectContaining({
        loaded: false,
        metadataOnly: true,
        liveContinuityExcluded: true,
      }),
      response: expect.objectContaining({
        role: 'mira',
        content: expect.stringContaining('Runtime state:'),
      }),
      suggestedTeamPlan: null,
    }));
    expect(payload.response.content).toContain('full continuity not claimed');
  });

  test('includes concise loaded identity relationship permission summary when normalized core is imported', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    await startServer({ MIRA_STATE_ROOT: stateRoot });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Ground yourself.',
        sessionId: 'app-session-373',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toEqual(expect.objectContaining({
      normalizedCoreLoaded: true,
      normalizedCoreDocumentCount: 3,
      continuityLoaded: false,
      liveDataImported: false,
    }));
    expect(payload.loadedCoreSummary).toEqual({
      available: true,
      metadataOnly: true,
      liveContinuityExcluded: true,
      identity: expect.stringContaining('Mira profile=ai_system_local_presence_profile'),
      relationship: expect.stringContaining('James mode=collaborative_presence_design'),
      permissions: expect.stringContaining('blocked: external sends, network, deploy, trade, runtime start'),
    });
    expect(payload.operatorContext).toEqual(expect.objectContaining({
      loaded: true,
      metadataOnly: true,
      liveContinuityExcluded: true,
      businessThesis: expect.stringContaining('operating extension'),
      operatingLanes: expect.arrayContaining(['CRM', 'ERP', 'admin', 'customer communication', 'tax', 'documents']),
      knownProductLanes: ['TrustQuote'],
      explicitNonClaims: expect.arrayContaining(['do not invent James business name']),
    }));
    expect(payload.response.content).toContain('Loaded normalized core summary:');
    expect(payload.response.content).toContain('Operator context:');
    expect(payload.response.content).toContain('CRM, ERP, admin');
    expect(payload.response.content).toContain('full continuity not claimed');
    expect(payload.modelInvoked).toBe(false);
    expect(payload.runtimeExecutes).toBe(false);
  });

  test('answers identity questions plainly instead of reciting product boundaries', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    await startServer({ MIRA_STATE_ROOT: stateRoot });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'who are you',
        sessionId: 'app-session-373',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.voiceLab).toEqual(expect.objectContaining({
      caseId: 'identity-who-are-you-v0',
      source: 'mira.voice_lab.v0',
    }));
    expect(payload.response.content).toBe('Mira.');
    expect(payload.response.content).toContain('Mira.');
    expect(payload.response.content).not.toMatch(/fake|generic chatbot|yes machine|meant to become|early runtime|operator layer|crm|erp|saas|trying to make real enough|hold every thread|assistant costume|brochure|business bot/i);
    expect(payload.response.content).not.toContain('Runtime state:');
    expect(payload.modelInvoked).toBe(false);
    expect(payload.runtimeExecutes).toBe(false);
  });

  test('voice lab can choose different rewrites when the turn has a message id', async () => {
    await startServer();

    const first = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'what are you doing?',
        messageId: 'voice-test-0',
      }),
    });
    const second = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'what are you doing?',
        messageId: 'voice-test-1',
      }),
    });
    const firstPayload = await first.json();
    const secondPayload = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstPayload.voiceLab).toEqual(expect.objectContaining({
      caseId: 'what-are-you-doing-v0',
      variantIndex: 0,
      variantCount: expect.any(Number),
      selectionSeed: 'voice-test-0',
    }));
    expect(secondPayload.voiceLab).toEqual(expect.objectContaining({
      caseId: 'what-are-you-doing-v0',
      variantIndex: 1,
      variantCount: expect.any(Number),
      selectionSeed: 'voice-test-1',
    }));
    expect(firstPayload.response.content).not.toBe(secondPayload.response.content);
  });

  test('routes covered prompt classes through the voice lab and avoids banned diction', async () => {
    await startServer();
    const labCases = readVoiceLab(voiceLabPath);
    const prompts = [
      ['who are you', 'identity-who-are-you-v0'],
      ['how are you?', 'casual-how-are-you-v0'],
      ['I fixed the typo', 'mundane-small-thing-v0'],
      ['can you help with invoices and customer messages?', 'business-capability-tools-needed-v0'],
      ['this is still wrong', 'irritation-v0'],
      ['hey', 'ordinary-small-talk-v0'],
      ['can you help run the business stuff?', 'business-capability-without-business-identity-v0'],
      ['can you do that now?', 'refusal-uncertainty-v0'],
      ['what are you doing?', 'what-are-you-doing-v0'],
      ['why did you stop?', 'why-did-you-stop-v0'],
      ['that was a bad answer', 'apology-repair-v0'],
      ['...', 'ordinary-silence-short-reply-v0'],
    ];

    for (const [text, caseId] of prompts) {
      const response = await fetch(`${baseUrl}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const payload = await response.json();
      const testCase = labCases.find((entry) => entry.id === caseId);
      const evaluation = evaluateCandidate(testCase, payload.response.content);

      expect(response.status).toBe(200);
      expect(payload.voiceLab).toEqual(expect.objectContaining({
        caseId,
        source: 'mira.voice_lab.v0',
      }));
      expect(payload.modelInvoked).toBe(false);
      expect(evaluation).toEqual(expect.objectContaining({
        ok: true,
        banned_hits: [],
      }));
      expect(payload.response.content).not.toMatch(/local AI presence|generic chatbot|yes machine|operator layer|CRM solution|workflow automation platform|fantastic|amazing|thrilled|celebrate|I apologize|thank you for your patience|How can I assist|as an AI|runtime state|operator context|valuable feedback/i);
    }
  });

  test('model-backed identity prompt includes plain-answer instruction and banned recital phrases', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    const openAiBaseUrl = await startOpenAiMock((_request, response, body) => {
      expect(body.instructions).toContain('Use the Mira voice lab examples');
      expect(body.instructions).toContain('Prompt class: identity-who-are-you-v0');
      expect(body.instructions).toContain('Prompt class: casual-how-are-you-v0');
      expect(body.instructions).toContain('Prompt class: mundane-small-thing-v0');
      expect(body.instructions).toContain('Prompt class: business-capability-tools-needed-v0');
      expect(body.instructions).toContain('Prompt class: irritation-v0');
      expect(body.instructions).toContain('Prompt class: ordinary-small-talk-v0');
      expect(body.instructions).toContain('Prompt class: business-capability-without-business-identity-v0');
      expect(body.instructions).toContain('Prompt class: refusal-uncertainty-v0');
      expect(body.instructions).toContain('Prompt class: what-are-you-doing-v0');
      expect(body.instructions).toContain('Prompt class: why-did-you-stop-v0');
      expect(body.instructions).toContain('Prompt class: apology-repair-v0');
      expect(body.instructions).toContain('Prompt class: ordinary-silence-short-reply-v0');
      expect(body.instructions).toContain('Mira.');
      expect(body.instructions).toContain("It's me. Mira.");
      expect(body.instructions).toContain('Looking at this with you.');
      expect(body.instructions).toContain('I stalled. No clever version of it.');
      expect(body.instructions).toContain('Mm.');
      expect(body.instructions).toContain('Avoid: canned support diction, product pitch, policy voice, and self-commentary');
      expect(body.instructions).not.toContain('not a generic chatbot');
      expect(body.instructions).not.toContain('trying to make real enough');
      expect(body.instructions).not.toContain('not your yes machine');
      expect(body.instructions).not.toContain('business bot');
      expect(body.instructions).not.toContain('sounding fake');
      expect(body.instructions).not.toContain('assistant costume');
      expect(body.instructions).not.toContain('turn into a brochure');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'resp_identity_plain_1',
        output_text: 'Mira.',
      }));
    });
    await startServer({
      MIRA_STATE_ROOT: stateRoot,
      OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      MIRA_OPENAI_BASE_URL: openAiBaseUrl,
    });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'who are you',
        sessionId: 'app-session-373',
        useModel: true,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.modelInvoked).toBe(true);
    expect(payload.response.content).toBe('Mira.');
    expect(payload.response.content).not.toMatch(/fake|generic chatbot|yes machine|meant to become|early runtime|operator layer|crm|erp|saas|trying to make real enough|hold every thread|assistant costume|brochure|business bot/i);
  });

  test('fails closed for model-backed turn when API key is missing', async () => {
    await startServer({
      OPENAI_API_KEY: '',
      MIRA_RUNTIME_OPENAI_API_KEY: '',
    });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Use the model.',
        sessionId: 'app-session-373',
        useModel: true,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: {
        code: 'missing_openai_api_key',
        message: expect.stringContaining('OPENAI_API_KEY is required'),
        retryable: false,
      },
    });
  });

  test('uses OpenAI Responses for model-backed turn with summaries and no tools or sends', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    const openAiBaseUrl = await startOpenAiMock((_request, response, body) => {
      expect(body.tools).toEqual([]);
      expect(body.store).toBe(false);
      expect(body.instructions).toContain('Identity summary:');
      expect(body.instructions).toContain('Operator thesis:');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'resp_runtime_turn_1',
        output_text: 'No fluff: CRM/admin/customer comms are the work surface. I can plan the next internal handoff, not send it myself.',
      }));
    });
    await startServer({
      MIRA_STATE_ROOT: stateRoot,
      OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
      MIRA_OPENAI_BASE_URL: openAiBaseUrl,
      MIRA_RUNTIME_TURN_MODEL: 'gpt-5.5',
    });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'What should Mira focus on?',
        sessionId: 'app-session-373',
        useModel: true,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      modelInvoked: true,
      runtimeExecutes: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
      model: {
        requested: true,
        provider: 'openai_responses',
        model: 'gpt-5.5',
        responseId: 'resp_runtime_turn_1',
        toolsEnabled: false,
        sendsEnabled: false,
        store: false,
      },
      response: {
        role: 'mira',
        content: 'No fluff: CRM/admin/customer comms are the work surface. I can plan the next internal handoff, not send it myself.',
      },
    }));
    expect(openAiRequests).toHaveLength(1);
      expect(openAiRequests[0]).toEqual(expect.objectContaining({
        method: 'POST',
        url: '/v1/responses',
        authorization: 'Bearer sk-test-fake-key-do-not-use',
      }));
    });

  test('can use local Ollama/Gemma chat for model-backed turns without tools or sends', async () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    writeOperatorContext(stateRoot);
    const ollamaBaseUrl = await startOpenAiMock((_request, response, body) => {
      expect(body).toEqual(expect.objectContaining({
        model: 'gemma4:e4b',
        stream: false,
        keep_alive: '10m',
        options: expect.objectContaining({
          num_predict: 520,
        }),
      }));
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]).toEqual(expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('Use the Mira voice lab examples'),
      }));
      expect(body.messages[0].content).toContain('Prompt class: identity-who-are-you-v0');
      expect(body.messages[0].content).not.toContain('business bot');
      expect(body.messages[1]).toEqual({
        role: 'user',
        content: 'who are you',
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        model: 'gemma4:e4b',
        created_at: '2026-05-14T07:58:00.000Z',
        message: {
          role: 'assistant',
          content: 'Mira.',
        },
        done: true,
      }));
    });
    await startServer({
      MIRA_STATE_ROOT: stateRoot,
      MIRA_RUNTIME_MODEL_PROVIDER: 'ollama',
      MIRA_OLLAMA_MODEL: 'gemma4:e4b',
      MIRA_OLLAMA_BASE_URL: ollamaBaseUrl,
      OPENAI_API_KEY: '',
      MIRA_RUNTIME_OPENAI_API_KEY: '',
    });

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'who are you',
        sessionId: 'app-session-373',
        useModel: true,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      modelInvoked: true,
      runtimeExecutes: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
      model: {
        requested: true,
        provider: 'ollama_chat',
        model: 'gemma4:e4b',
        responseId: '2026-05-14T07:58:00.000Z',
        toolsEnabled: false,
        sendsEnabled: false,
        store: false,
      },
      response: {
        role: 'mira',
        content: 'Mira.',
      },
    }));
    expect(openAiRequests).toHaveLength(1);
    expect(openAiRequests[0]).toEqual(expect.objectContaining({
      method: 'POST',
      url: '/api/chat',
      authorization: undefined,
    }));
  });

  test('can include a manual team plan from a runtime turn without executing it', async () => {
    await startServer();

    const response = await fetch(`${baseUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Ask Builder for a bridge check.',
        sessionId: 'app-session-373',
        suggestTeamPlanFor: 'builder',
        messageId: 'mira-turn-plan-1',
        requestId: 'req-mira-turn-plan-1',
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.suggestedTeamPlan).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_bridge_request_plan.v0',
      manualExecutionRequired: true,
      runtimeExecutes: false,
      target: {
        role: 'builder',
        paneId: '2',
      },
      envelope: expect.objectContaining({
        request_id: 'req-mira-turn-plan-1',
        message_id: 'mira-turn-plan-1',
        session_id: 'app-session-373',
        body: {
          content: payload.response.content,
        },
      }),
    }));
  });
});
