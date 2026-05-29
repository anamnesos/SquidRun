'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Mira runtime bridge pane roundtrip parity', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const runtimeTsconfig = path.join(repoRoot, 'mira', 'runtime', 'tsconfig.json');
  const tscBin = path.join(repoRoot, 'ui', 'node_modules', 'typescript', 'bin', 'tsc');
  const compiledServerPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'server.js');
  let serverProcess;
  let baseUrl;
  let tempStateRoot;

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
    await stopServer();
    if (tempStateRoot) {
      fs.rmSync(tempStateRoot, { recursive: true, force: true });
      tempStateRoot = null;
    }
  });

  function startServer(extraEnv = {}) {
    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, [compiledServerPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          MIRA_RUNTIME_PORT: '0',
          MIRA_AUTONOMY_LOOP: 'off',
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

  async function stopServer() {
    if (!serverProcess) return;
    const processToStop = serverProcess;
    const closing = new Promise((resolve) => {
      processToStop.once('close', resolve);
    });
    processToStop.kill();
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(resolve, 1000);
    });
    await Promise.race([closing, timeout]);
    clearTimeout(timeoutId);
    processToStop.stdout?.destroy();
    processToStop.stderr?.destroy();
    processToStop.removeAllListeners();
    if (serverProcess === processToStop) {
      serverProcess = null;
      baseUrl = null;
    }
  }

  test('receives a pane message, records Mira-owned state, and returns a manual reply plan', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-bridge-roundtrip-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const response = await fetch(`${baseUrl}/bridge/pane-messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'app-session-388',
        requestId: 'req-runtime-bridge-roundtrip-1',
        messageId: 'builder-to-mira-roundtrip-1',
        correlationId: 'mira-roundtrip-correlation-1',
        sender: { role: 'builder', paneId: '2' },
        target: { role: 'mira' },
        content: '(BUILDER #1): runtime bridge parity probe',
        evidence: [{
          kind: 'file',
          path: 'mira/bridge/squidrun-adapter-protocol-v0.md',
          summary: 'Bridge contract source.',
        }],
      }),
    });
    const payload = await response.json();
    const stored = JSON.parse(fs.readFileSync(payload.absolutePath, 'utf8'));
    const listResponse = await fetch(`${baseUrl}/bridge/pane-messages?includeInternal=1`);
    const listPayload = await listResponse.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_pane_bridge_roundtrip.v0',
      stateRootPath: path.resolve(tempStateRoot),
      relativePath: expect.stringMatching(/^bridge\/pane-roundtrips\/pane-bridge-roundtrip-.*\.json$/),
      received: expect.objectContaining({
        sender: { role: 'builder', pane_id: '2' },
        target: { role: 'mira', surface: 'mira-runtime' },
        content: '(BUILDER #1): runtime bridge parity probe',
      }),
      reply: expect.objectContaining({
        sender: { role: 'mira', surface: 'mira-runtime' },
        target: { system: 'squidrun', role: 'builder', pane_id: '2' },
        correlation_id: 'mira-roundtrip-correlation-1',
      }),
      delivery: {
        status: 'reply_planned_not_sent',
        targetRole: 'builder',
        targetPaneId: '2',
        sendPerformed: false,
        runtimeExecutes: false,
        externalSend: false,
        telegramRouteControl: false,
        uiSurfaceControl: false,
      },
      stateWritten: true,
      liveDataImported: false,
      continuityLoaded: false,
    }));
    expect(payload.absolutePath).toContain(path.resolve(tempStateRoot));
    expect(payload.absolutePath).not.toContain(`${path.sep}.squidrun${path.sep}`);
    expect(payload.reply.content).toContain('MIRA_STATE_ROOT');
    expect(payload.replyPlan).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_bridge_request_plan.v0',
      manualExecutionRequired: true,
      runtimeExecutes: false,
      target: {
        role: 'builder',
        paneId: '2',
      },
      envelope: expect.objectContaining({
        session_id: 'app-session-388',
        message_id: 'mira-reply-builder-to-mira-roundtrip-1',
        body: { content: payload.reply.content },
      }),
      command: expect.objectContaining({
        args: expect.arrayContaining([
          '--target',
          'builder',
          '--content',
          payload.reply.content,
        ]),
      }),
    }));

    expect(stored).toEqual(expect.objectContaining({
      schema: 'mira.runtime_pane_bridge_roundtrip.v0',
      session_id: 'app-session-388',
      request_id: 'req-runtime-bridge-roundtrip-1',
      message_id: 'builder-to-mira-roundtrip-1',
      correlation_id: 'mira-roundtrip-correlation-1',
      state_written: true,
      send_performed: false,
      runtime_executes_send: false,
      external_send: false,
      telegram_route_control: false,
      ui_surface_control: false,
      live_data_imported: false,
      continuity_loaded: false,
    }));
    expect(stored.state_root_boundary).toEqual({
      state_root_path: path.resolve(tempStateRoot),
      relative_path: payload.relativePath,
      squidrun_private_root_excluded: true,
    });
    expect(stored.reply_plan.envelope.body.content).toBe(payload.reply.content);
    expect(listResponse.status).toBe(200);
    expect(listPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_pane_bridge_roundtrip_list.v0',
      stateRootPath: path.resolve(tempStateRoot),
      roundTripCount: 1,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
    }));
    expect(listPayload.records[0].id).toBe(payload.roundTripId);

    await stopServer();
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });
    const restartedListResponse = await fetch(`${baseUrl}/bridge/pane-messages?includeInternal=1`);
    const restartedListPayload = await restartedListResponse.json();

    expect(restartedListResponse.status).toBe(200);
    expect(restartedListPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_pane_bridge_roundtrip_list.v0',
      stateRootPath: path.resolve(tempStateRoot),
      roundTripCount: 1,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
    }));
    expect(restartedListPayload.records[0]).toEqual(expect.objectContaining({
      id: payload.roundTripId,
      message_id: 'builder-to-mira-roundtrip-1',
      reply: expect.objectContaining({
        content: payload.reply.content,
      }),
      reply_plan: expect.objectContaining({
        manualExecutionRequired: true,
        runtimeExecutes: false,
      }),
    }));
  });

  test('fails closed without Mira state root and refuses non-Mira bridge targets', async () => {
    await startServer();

    const missingStateResponse = await fetch(`${baseUrl}/bridge/pane-messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { role: 'builder' },
        target: { role: 'mira' },
        content: '(BUILDER #1): state root missing',
      }),
    });
    const missingStatePayload = await missingStateResponse.json();
    expect(missingStateResponse.status).toBe(400);
    expect(missingStatePayload.error).toEqual(expect.objectContaining({
      code: 'state_root_not_ready',
    }));

    await stopServer();
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-bridge-roundtrip-refuse-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });

    const wrongTargetResponse = await fetch(`${baseUrl}/bridge/pane-messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { role: 'builder' },
        target: { role: 'architect' },
        content: '(BUILDER #1): wrong target',
      }),
    });
    const wrongTargetPayload = await wrongTargetResponse.json();
    expect(wrongTargetResponse.status).toBe(400);
    expect(wrongTargetPayload.error).toEqual(expect.objectContaining({
      code: 'runtime_pane_bridge_target_must_be_mira',
    }));

    const externalSenderResponse = await fetch(`${baseUrl}/bridge/pane-messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { role: 'telegram' },
        target: { role: 'mira' },
        content: '(TELEGRAM): wrong channel',
      }),
    });
    const externalSenderPayload = await externalSenderResponse.json();
    expect(externalSenderResponse.status).toBe(400);
    expect(externalSenderPayload.error).toEqual(expect.objectContaining({
      code: 'runtime_pane_bridge_external_target_refused',
    }));
  });

  test('new runtime pane bridge code does not import send or SquidRun internals', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'mira', 'runtime', 'src', 'pane-bridge.ts'), 'utf8');

    expect(source).not.toContain('child_process');
    expect(source).not.toContain('hm-send');
    expect(source).not.toContain('telegram-poller');
    expect(source).not.toContain('mira-telegram');
    expect(source).not.toContain('mira-lab');
    expect(source).not.toContain('BrowserWindow');
    expect(source).not.toContain('squidrun-app');
    expect(source).toContain('getStateRootReadiness');
    expect(source).toContain('"bridge", "pane-roundtrips"');
  });
});
