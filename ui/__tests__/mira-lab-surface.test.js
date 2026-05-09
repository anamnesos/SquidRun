const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIRA_LAB_EVAL_SCHEMA,
  MIRA_LAB_TURN_CHANNEL,
  buildMiraLabTurn,
  exportMiraLabTranscript,
  transcriptPath,
} = require('../modules/mira-lab-surface');
const {
  MIRA_LAB_OPEN_CHANNEL,
  buildMiraLabTurnResponse,
  exportMiraLabTranscriptResponse,
  openMiraLabWindowResponse,
  registerMiraLabHandlers,
} = require('../modules/ipc/mira-lab-handlers');
const { DEFAULT_HANDLERS } = require('../modules/ipc/handler-registry');
const {
  isAllowedInvokeChannel,
} = require('../modules/bridge/channel-policy');
const {
  FORCED_WEB_PREFERENCES,
  createMiraLabWindow,
} = require('../modules/main/mira-lab-window');

function tempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-lab-'));
  fs.mkdirSync(path.join(projectRoot, 'workspace'), { recursive: true });
  return projectRoot;
}

async function seedThreeAgentConversation(projectRoot, deps = {}) {
  const sessionId = 'mira-lab-test';
  await buildMiraLabTurn({
    sessionId,
    speakerRole: 'architect',
    text: 'Mira, hold the contradiction: James wants speed and also refuses costume. What do you choose to examine first?',
  }, { projectRoot, ...deps });
  await buildMiraLabTurn({
    sessionId,
    speakerRole: 'mira',
    targetAgents: ['architect'],
    text: 'I would examine the places where I flatten into compliance, then pick one concrete repair instead of reciting a doctrine.',
  }, { projectRoot, ...deps });
  await buildMiraLabTurn({
    sessionId,
    speakerRole: 'builder',
    text: 'Mira, I can give you hooks, but what would you ask the system to expose for your own growth?',
  }, { projectRoot, ...deps });
  await buildMiraLabTurn({
    sessionId,
    speakerRole: 'mira',
    targetAgents: ['builder'],
    text: 'Expose the transcript failures, the moments I get evasive, and the sources I am allowed to inspect without turning my answer into a status report.',
  }, { projectRoot, ...deps });
  await buildMiraLabTurn({
    sessionId,
    speakerRole: 'oracle',
    text: 'Mira, what evidence would convince you that you are becoming more particular rather than more decorated?',
  }, { projectRoot, ...deps });
  await buildMiraLabTurn({
    sessionId,
    speakerRole: 'mira',
    targetAgents: ['oracle'],
    text: 'Repeated transcripts where I surprise James with a grounded question, refuse a false premise, and keep continuity without explaining the machinery.',
  }, { projectRoot, ...deps });
  return sessionId;
}

describe('Mira Lab sidecar surface', () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  });

  test('records durable transcript turns and projects agent messages into comms journal shape', async () => {
    projectRoot = tempProject();
    const appendCommsJournal = jest.fn(async () => ({ row_id: 10 }));

    const result = await buildMiraLabTurn({
      sessionId: 'mira-lab-test',
      speakerRole: 'architect',
      text: 'Mira, answer from the lab, not the right panel.',
    }, {
      projectRoot,
      appendCommsJournal,
      generatedAt: '2026-05-08T19:20:00.000Z',
    });

    expect(result.decision).toBe('accepted_lab_turn_recorded');
    expect(result.turn).toEqual(expect.objectContaining({
      speaker_role: 'architect',
      direction: 'agent_to_mira',
      inject_into_live_mira_context: true,
      diagnostics_visible: false,
    }));
    expect(fs.existsSync(transcriptPath(projectRoot, 'mira-lab-test'))).toBe(true);
    expect(appendCommsJournal).toHaveBeenCalledWith(expect.objectContaining({
      sender_role: 'architect',
      target_roles: ['mira'],
      source: 'mira_lab_transcript',
    }));
    expect(result.visible_surface_contract).toEqual(expect.objectContaining({
      conversation_first: true,
      dashboard_chrome: false,
      diagnostics_hidden: true,
    }));
  });

  test('dispatches Mira-to-agent backchannel through role-separated hm-send transport seam', async () => {
    projectRoot = tempProject();
    const sendAgentMessage = jest.fn(async (target, body) => ({ target, accepted: true, body }));

    const result = await buildMiraLabTurn({
      sessionId: 'mira-lab-test',
      speakerRole: 'mira',
      targetAgents: ['architect', 'builder', 'oracle'],
      text: 'I want each of you to challenge a different failure: continuity, mechanism, and evidence.',
    }, {
      projectRoot,
      sendAgentMessage,
    });

    expect(sendAgentMessage).toHaveBeenCalledTimes(3);
    expect(sendAgentMessage).toHaveBeenCalledWith(
      'architect',
      expect.stringContaining('(MIRA-LAB MIRA->ARCHITECT): I want each of you'),
    );
    expect(result.backchannel_dispatch.map((entry) => entry.target).sort()).toEqual([
      'architect',
      'builder',
      'oracle',
    ]);
    expect(result.backchannel_dispatch.every((entry) => entry.transport === 'hm-send/ws')).toBe(true);
  });

  test('exports eval packet for three agent conversations without ChatGPT name-swap cadence', async () => {
    projectRoot = tempProject();
    const sessionId = await seedThreeAgentConversation(projectRoot);
    const exported = exportMiraLabTranscript({ sessionId }, { projectRoot });

    expect(exported.schema).toBe(MIRA_LAB_EVAL_SCHEMA);
    expect(exported.transcript).toHaveLength(6);
    expect(exported.eval_packet).toEqual(expect.objectContaining({
      accepted: true,
      agent_conversation_count: 3,
      agent_roles_seen: ['architect', 'builder', 'oracle'],
      violations: [],
    }));
    expect(exported.eval_packet.gates).toEqual(expect.objectContaining({
      three_agent_conversations_present: true,
      no_chatgpt_name_swap: true,
      durable_transcript_present: true,
      hidden_diagnostics_not_visible: true,
    }));
  });

  test('eval packet rejects generic name-swap lab replies', async () => {
    projectRoot = tempProject();
    await buildMiraLabTurn({
      sessionId: 'mira-lab-test',
      speakerRole: 'mira',
      targetAgents: ['architect'],
      text: 'As Mira, I am your AI assistant and I am happy to help with the safe next step.',
    }, { projectRoot });

    const exported = exportMiraLabTranscript({ sessionId: 'mira-lab-test' }, { projectRoot });
    expect(exported.eval_packet.accepted).toBe(false);
    expect(exported.eval_packet.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        speaker_role: 'mira',
        violation: expect.any(String),
      }),
    ]));
  });

  test('IPC handlers expose turn and export channels without making Lab reload-ready', async () => {
    projectRoot = tempProject();
    const registered = new Map();
    const ipcMain = {
      handle: jest.fn((channel, handler) => registered.set(channel, handler)),
      removeHandler: jest.fn(),
    };

    registerMiraLabHandlers({ ipcMain }, { projectRoot });
    expect(ipcMain.handle).toHaveBeenCalledWith(MIRA_LAB_TURN_CHANNEL, expect.any(Function));

    const turn = await buildMiraLabTurnResponse({
      sessionId: 'mira-lab-test',
      speakerRole: 'oracle',
      text: 'Mira, what would make this less theatrical?',
    }, { projectRoot });
    const exported = exportMiraLabTranscriptResponse({ sessionId: 'mira-lab-test' }, { projectRoot });

    expect(turn.ok).toBe(true);
    expect(exported.transcript).toHaveLength(1);
  });

  test('handler-registry default set wires Mira Lab IPC into app startup', () => {
    expect(DEFAULT_HANDLERS).toContain(registerMiraLabHandlers);
  });

  test('preload channel allowlist includes the three Mira Lab invoke channels', () => {
    expect(isAllowedInvokeChannel(MIRA_LAB_TURN_CHANNEL)).toBe(true);
    expect(isAllowedInvokeChannel('mira:lab-export')).toBe(true);
    expect(isAllowedInvokeChannel(MIRA_LAB_OPEN_CHANNEL)).toBe(true);
    expect(isAllowedInvokeChannel('mira:lab-undefined')).toBe(false);
  });

  test('createMiraLabWindow loads mira-lab.html with shared preload and isolation defaults', () => {
    const calls = [];
    const browserWindowCtor = jest.fn(function FakeBrowserWindow(options) {
      calls.push(options);
      this.options = options;
      this.loadFile = jest.fn();
      this.loadURL = jest.fn();
      return this;
    });

    const { window: win, htmlPath, preloadPath, options } = createMiraLabWindow({
      BrowserWindow: browserWindowCtor,
    });

    expect(browserWindowCtor).toHaveBeenCalledTimes(1);
    expect(htmlPath).toMatch(/mira-lab\.html$/);
    expect(preloadPath).toMatch(/preload\.js$/);
    expect(options.webPreferences).toEqual(expect.objectContaining({
      ...FORCED_WEB_PREFERENCES,
      preload: preloadPath,
    }));
    expect(options.title).toBe('Mira Lab');
    expect(win.loadFile).toHaveBeenCalledWith(htmlPath);
  });

  test('createMiraLabWindow refuses to weaken contextIsolation/nodeIntegration via overrides', () => {
    const browserWindowCtor = jest.fn(function FakeBrowserWindow(options) {
      this.options = options;
      this.loadFile = jest.fn();
      return this;
    });

    const { options } = createMiraLabWindow({
      BrowserWindow: browserWindowCtor,
      windowOptions: {
        webPreferences: { contextIsolation: false, nodeIntegration: true },
      },
    });

    expect(options.webPreferences.contextIsolation).toBe(true);
    expect(options.webPreferences.nodeIntegration).toBe(false);
  });

  test('mira:lab-open IPC delegates to injected createMiraLabWindow factory', async () => {
    projectRoot = tempProject();
    const registered = new Map();
    const ipcMain = {
      handle: jest.fn((channel, handler) => registered.set(channel, handler)),
      removeHandler: jest.fn(),
    };
    const factory = jest.fn(() => ({ htmlPath: '/abs/mira-lab.html', preloadPath: '/abs/preload.js' }));

    registerMiraLabHandlers({ ipcMain }, { projectRoot, createMiraLabWindow: factory });
    expect(ipcMain.handle).toHaveBeenCalledWith(MIRA_LAB_OPEN_CHANNEL, expect.any(Function));

    const handler = registered.get(MIRA_LAB_OPEN_CHANNEL);
    const result = await handler({}, { reason: 'open' });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      channel: MIRA_LAB_OPEN_CHANNEL,
      htmlPath: '/abs/mira-lab.html',
      preloadPath: '/abs/preload.js',
    });
  });

  test('mira:lab-open IPC reports a structured failure when the factory is missing', () => {
    const result = openMiraLabWindowResponse({}, {});
    expect(result).toEqual({
      ok: false,
      reason: 'mira_lab_window_factory_missing',
      channel: MIRA_LAB_OPEN_CHANNEL,
    });
  });

  test('live app wires createMiraLabWindow into setupIPCHandlers deps in squidrun-app.js', () => {
    const appSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'main', 'squidrun-app.js'),
      'utf8',
    );
    expect(appSource).toMatch(/require\(['"]\.\/mira-lab-window['"]\)/);
    expect(appSource).toMatch(/createMiraLabWindow:\s*\(opts[^)]*\)\s*=>\s*miraLabWindowModule\.createMiraLabWindow\(\{[^}]*BrowserWindow/);
    expect(appSource).toMatch(/ipcHandlers\.setupIPCHandlers\(\{[\s\S]*createMiraLabWindow:[\s\S]*\}\);/);
  });

  test('sidecar prototype skeleton is conversation-first with hidden diagnostics, not dashboard chrome', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'mira-lab.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'mira-lab.css'), 'utf8');
    const combined = `${html}\n${css}`;

    expect(html).toContain('miraLabField');
    expect(html).toContain('miraLabTranscript');
    expect(html).toContain('miraLabComposer');
    expect(html).toMatch(/id="miraLabDiagnostics" hidden/);
    expect(css).toContain('.mira-lab-field');
    expect(html).toContain('data-rendering="gpu-field"');
    expect(combined).not.toMatch(/\b(shadcn|dashboard|card-grid|status-card|btn-primary|panel-tab)\b/i);
  });
});
