'use strict';

const { spawn, execFileSync } = require('child_process');
const path = require('path');

describe('Mira runtime bridge manual-plan API', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const runtimeTsconfig = path.join(repoRoot, 'mira', 'runtime', 'tsconfig.json');
  const tscBin = path.join(repoRoot, 'ui', 'node_modules', 'typescript', 'bin', 'tsc');
  const compiledServerPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'server.js');
  let serverProcess;
  let baseUrl;

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
  });

  function startServer() {
    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, [compiledServerPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          MIRA_RUNTIME_PORT: '0',
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
      response: expect.objectContaining({
        role: 'mira',
        content: expect.stringContaining('Runtime state:'),
      }),
      suggestedTeamPlan: null,
    }));
    expect(payload.response.content).toContain('full continuity not claimed');
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
