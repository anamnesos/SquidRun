const fs = require('fs');
const os = require('os');
const path = require('path');

const bridge = require('../modules/main/codex-computer-use-native-bridge');
const proof = require('../modules/main/codex-computer-use-proof');
const cli = require('../scripts/hm-codex-computer-use-bridge');

const MAIN_ROOT = 'D:\\projects\\squidrun';
const sideprofile_ROOT = 'D:\\SquidRun\\sideprofile\\workspace';
const PIPE_PATH = '\\\\.\\pipe\\codex-computer-use-f214874c-b61b-4d31-ba3a-e2618aa80e34';
const ROTATED_PIPE_PATH = '\\\\.\\pipe\\codex-computer-use-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BROWSER_PIPE = 'chrome-native-messaging-7d407dc4-9b7e-4488-824a-7a7475447ca5';
const OFFICIAL_CODEX_BROWSER_PIPE = 'codex-browser-use-42d55c5a-9e4d-45ba-bbe3-a7fa46d8e618';
const ENUMERATED_CODEX_BROWSER_PIPE = 'codex-browser-use\\42d55c5a-9e4d-45ba-bbe3-a7fa46d8e618';
const UNRELATED_BROWSER_PIPE = 'other-browser-use-42d55c5a-9e4d-45ba-bbe3-a7fa46d8e618';

function codexConfig(options = {}) {
  const pipePath = options.pipePath === undefined ? PIPE_PATH : options.pipePath;
  return [
    '[mcp_servers.node_repl.env]',
    `SKY_CUA_NATIVE_PIPE = ${JSON.stringify(options.nativePipeEnabled === false ? '0' : '1')}`,
    pipePath == null ? '' : `SKY_CUA_NATIVE_PIPE_DIRECTORY = '${pipePath}'`,
    '',
    '[plugins."computer-use@openai-bundled"]',
    `enabled = ${options.pluginEnabled === false ? 'false' : 'true'}`,
    '',
    '[shell_environment_policy.set]',
    'BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"',
    '',
  ].join('\n');
}

function desktopOwnerProcess(overrides = {}) {
  return {
    ProcessId: 52000,
    ParentProcessId: 1000,
    Name: 'ChatGPT.exe',
    ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.11231.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe',
    CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.11231.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe"',
    ...overrides,
  };
}

function probeOptions(overrides = {}) {
  return {
    platform: 'win32',
    projectRoot: MAIN_ROOT,
    paneId: '2',
    profile: 'main',
    env: {
      SQUIDRUN_PROJECT_ROOT: MAIN_ROOT,
      SQUIDRUN_PANE_ID: '2',
      SQUIDRUN_PROFILE: 'main',
    },
    readFile: () => codexConfig(),
    listDesktopProcesses: () => ({ ok: true, processes: [] }),
    listComputerUsePipes: () => ({ ok: true, pipes: [] }),
    pipeExists: () => false,
    now: '2026-07-29T23:00:00.000Z',
    ...overrides,
  };
}

function readyProbeState(pipePath = PIPE_PATH, overrides = {}) {
  return {
    pipeReady: true,
    status: 'ready',
    projectRoot: MAIN_ROOT,
    paneId: '2',
    profile: 'main',
    config: {
      configPath: 'C:\\Users\\James\\.codex\\config.toml',
      pipePath,
    },
    desktopOwner: {
      probeOk: true,
      running: true,
    },
    pipe: {
      path: pipePath,
      present: true,
      exactPipeIsUnique: true,
    },
    ...overrides,
  };
}

describe('Codex Computer Use native bridge ownership', () => {
  test('classifies the current stale Desktop-owned config without inventing a helper launch', async () => {
    const result = await bridge.probeCodexComputerUseNativeBridge(probeOptions());

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'blocked',
      reason: 'codex_desktop_owner_not_running',
      owner: 'codex_desktop',
      pipeReady: false,
      newCodexPaneCanAttach: false,
    }));
    expect(result.config).toEqual(expect.objectContaining({
      pluginEnabled: true,
      nativePipeEnabled: true,
      pipePath: PIPE_PATH,
      pipePathSupported: true,
    }));
    expect(result.supportedContract).toEqual(expect.objectContaining({
      squidrunStartsHelper: false,
      squidrunImplementsNativeProtocol: false,
      squidrunMutatesCodexConfig: false,
      exactDesktopAumidLaunchAllowed: true,
      squidrunPaneOptInSetting: 'codexComputerUsePaneIds',
      squidrunPaneOptInDefault: [],
      desktopOwnsPipeServer: true,
      desktopOwnsHelperLifecycle: true,
      existingNodeReplPipeOverrideSupported: false,
      existingPaneRetargetFromModelCodeSupported: false,
      existingPaneRebindMethod: 'unresolved',
    }));
  });

  test('reports ready only when the exact configured pipe and exact Desktop owner coexist', async () => {
    const result = await bridge.probeCodexComputerUseNativeBridge(probeOptions({
      listDesktopProcesses: () => ({
        ok: true,
        processes: [desktopOwnerProcess()],
      }),
      listComputerUsePipes: () => ({ ok: true, pipes: [PIPE_PATH] }),
      pipeExists: (value) => value === PIPE_PATH,
    }));

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'ready',
      reason: 'exact_codex_desktop_pipe_ready',
      pipeReady: true,
      newCodexPaneCanAttach: true,
      existingCodexPaneAttachmentProven: false,
    }));
    expect(result.desktopOwner.running).toBe(true);
    expect(result.desktopOwner.processes).toEqual([
      expect.objectContaining({ pid: 52000 }),
    ]);
  });

  test('accepts only the manifest-backed Codex package ChatGPT.exe owner', async () => {
    const candidates = [
      {
        Name: 'codex.exe',
        ExecutablePath: 'C:\\Users\\James\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.exe',
      },
      {
        Name: 'Codex.exe',
        ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.11231.0_x64__2p2nqsd0c76g0\\app\\Codex.exe',
      },
      {
        Name: 'ChatGPT.exe',
        ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT-Desktop_1.2026.190.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe',
      },
      {
        Name: 'ChatGPT.exe',
        ExecutablePath: `${sideprofile_ROOT}\\OpenAI.Codex_26.721.11231.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe`,
      },
      {
        Name: 'ChatGPT.exe',
        ExecutablePath: 'D:\\foreign\\OpenAI.Codex_26.721.11231.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe',
      },
    ];

    for (const candidate of candidates) {
      expect(bridge.isOfficialCodexDesktopOwnerProcess(candidate)).toBe(false);
    }
    expect(bridge.isOfficialCodexDesktopOwnerProcess(desktopOwnerProcess())).toBe(true);

    const result = await bridge.probeCodexComputerUseNativeBridge(probeOptions({
      listDesktopProcesses: () => ({ ok: true, processes: candidates }),
      pipeExists: () => true,
    }));
    expect(result.reason).toBe('computer_use_pipe_has_no_exact_desktop_owner');
    expect(result.pipeReady).toBe(false);
  });

  test('fails closed when the Desktop owner probe is unavailable', async () => {
    const result = await bridge.probeCodexComputerUseNativeBridge(probeOptions({
      listDesktopProcesses: () => ({
        ok: false,
        reason: 'desktop_owner_probe_timeout',
        processes: [],
      }),
      pipeExists: () => true,
    }));

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'blocked',
      reason: 'desktop_owner_probe_timeout',
      pipeReady: false,
    }));
  });

  test('yields to the event loop while the Desktop owner probe is pending', async () => {
    let releaseOwnerProbe;
    const ownerProbePending = new Promise((resolve) => {
      releaseOwnerProbe = resolve;
    });
    let eventLoopYielded = false;
    const resultPromise = bridge.probeCodexComputerUseNativeBridge(probeOptions({
      listDesktopProcesses: async () => ownerProbePending,
    }));

    await new Promise((resolve) => {
      setImmediate(() => {
        eventLoopYielded = true;
        resolve();
      });
    });
    expect(eventLoopYielded).toBe(true);

    releaseOwnerProbe({ ok: true, processes: [] });
    await expect(resultPromise).resolves.toEqual(expect.objectContaining({
      reason: 'codex_desktop_owner_not_running',
    }));
  });

  test('does not fall back to the main CODEX_HOME when an explicit profile config is missing', () => {
    const requestedPaths = [];
    const result = bridge.readCodexComputerUseConfig({
      env: { CODEX_HOME: 'D:\\SquidRun\\sideprofile\\.codex' },
      homeDir: 'C:\\Users\\James',
      readFile: (filePath) => {
        requestedPaths.push(filePath);
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('codex_config_missing');
    expect(requestedPaths).toHaveLength(1);
    expect(requestedPaths[0]).toBe(path.resolve('D:\\SquidRun\\sideprofile\\.codex\\config.toml'));
  });
});

describe('Codex Computer Use supported preparation flow', () => {
  test('requires explicit owner-launch authorization and leaves processes untouched by default', async () => {
    const launchOwner = jest.fn();
    const result = await bridge.prepareCodexComputerUseNativeBridge({
      platform: 'win32',
      projectRoot: MAIN_ROOT,
      workspace: MAIN_ROOT,
      paneId: '2',
      profile: 'main',
      launchOwner: false,
    }, {
      probe: async () => ({
        pipeReady: false,
        reason: 'codex_desktop_owner_not_running',
      }),
      launchOwner,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'blocked',
      reason: 'explicit_codex_desktop_owner_launch_required',
      ownerLaunchDispatched: false,
      ownerLaunched: false,
    }));
    expect(launchOwner).not.toHaveBeenCalled();
  });

  test('dry-run describes the supported Desktop owner launch without launching it', async () => {
    const launchOwner = jest.fn();
    const listBrowserPipes = jest.fn()
      .mockResolvedValueOnce({ ok: true, pipes: [BROWSER_PIPE] })
      .mockResolvedValueOnce({
        ok: true,
        pipes: [BROWSER_PIPE, ENUMERATED_CODEX_BROWSER_PIPE],
      });
    const result = await bridge.prepareCodexComputerUseNativeBridge({
      platform: 'win32',
      projectRoot: MAIN_ROOT,
      workspace: MAIN_ROOT,
      paneId: '2',
      profile: 'main',
      launchOwner: true,
      dryRun: true,
    }, {
      probe: async () => ({
        pipeReady: false,
        reason: 'codex_desktop_owner_not_running',
      }),
      launchOwner,
      listBrowserPipes,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'dry_run',
      wouldLaunchOwner: true,
      aumid: bridge.CODEX_DESKTOP_AUMID,
      newCodexPanePreflightWouldBeRequiredAfterLaunch: true,
      existingPaneAttachmentProven: false,
      existingPaneRebindMethod: 'unresolved',
      targetPaneRestartRequired: null,
    }));
    expect(launchOwner).not.toHaveBeenCalled();
    expect(listBrowserPipes).toHaveBeenCalledTimes(1);
  });

  test('refuses sideprofile or another side profile before probing or launching', async () => {
    const probe = jest.fn();
    const launchOwner = jest.fn();
    const result = await bridge.prepareCodexComputerUseNativeBridge({
      platform: 'win32',
      projectRoot: sideprofile_ROOT,
      workspace: sideprofile_ROOT,
      profile: 'sideprofile',
      launchOwner: true,
    }, { probe, launchOwner });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'non_main_profile_owner_launch_refused',
    }));
    expect(probe).not.toHaveBeenCalled();
    expect(launchOwner).not.toHaveBeenCalled();
  });

  test('refuses a foreign workspace from the main profile', async () => {
    const probe = jest.fn();
    const launchOwner = jest.fn();
    const result = await bridge.prepareCodexComputerUseNativeBridge({
      platform: 'win32',
      projectRoot: MAIN_ROOT,
      workspace: sideprofile_ROOT,
      profile: 'main',
      launchOwner: true,
    }, { probe, launchOwner });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'workspace_root_mismatch',
    }));
    expect(probe).not.toHaveBeenCalled();
    expect(launchOwner).not.toHaveBeenCalled();
  });

  test('launches only exact Codex Desktop, waits for its pipe, and leaves current-pane rebind unresolved', async () => {
    let now = 0;
    const states = [
      { pipeReady: false, reason: 'codex_desktop_owner_not_running' },
      readyProbeState(),
      readyProbeState(),
    ];
    let latestState = states[0];
    const probe = jest.fn(async () => {
      latestState = states.length > 0 ? states.shift() : latestState;
      return latestState;
    });
    const launchOwner = jest.fn(async () => ({
      ok: true,
      status: 'codex_desktop_owner_launch_requested',
      aumid: bridge.CODEX_DESKTOP_AUMID,
    }));
    const listBrowserPipes = jest.fn()
      .mockResolvedValueOnce({ ok: true, pipes: [BROWSER_PIPE] })
      .mockResolvedValueOnce({
        ok: true,
        pipes: [BROWSER_PIPE, ENUMERATED_CODEX_BROWSER_PIPE],
      });

    const result = await bridge.prepareCodexComputerUseNativeBridge({
      platform: 'win32',
      projectRoot: MAIN_ROOT,
      workspace: MAIN_ROOT,
      paneId: '2',
      profile: 'main',
      launchOwner: true,
      timeoutMs: 1000,
      intervalMs: 50,
    }, {
      probe,
      launchOwner,
      listBrowserPipes,
      nowMs: () => now,
      sleep: async (ms) => { now += ms; },
    });

    expect(launchOwner).toHaveBeenCalledTimes(1);
    expect(launchOwner).toHaveBeenCalledWith({
      aumid: bridge.CODEX_DESKTOP_AUMID,
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'ready',
      reason: 'codex_desktop_owner_launched_and_exact_pipe_ready',
      ownerLaunchDispatched: true,
      ownerLaunched: true,
      newCodexPanePreflightReady: true,
      existingPaneAttachmentProven: false,
      existingPaneRebindMethod: 'unresolved',
      targetPaneRestartRequired: null,
      listWindowsProofRequired: true,
      generation: expect.objectContaining({
        schema: bridge.PIPE_GENERATION_SCHEMA,
        pipePath: PIPE_PATH,
      }),
    }));
    expect(result.browserPipeSnapshot).toEqual({
      before: { ok: true, reason: null, error: null, pipes: [BROWSER_PIPE] },
      after: {
        ok: true,
        reason: null,
        error: null,
        pipes: [BROWSER_PIPE, ENUMERATED_CODEX_BROWSER_PIPE],
      },
      reSnapshotted: true,
    });
    expect(listBrowserPipes).toHaveBeenCalledTimes(2);
  });

  test('refuses a generation that rotates between readiness reads', async () => {
    const launchOwner = jest.fn();
    const states = [
      readyProbeState(),
      readyProbeState(ROTATED_PIPE_PATH),
    ];
    const probe = jest.fn(async () => states.shift());

    const result = await bridge.prepareCodexComputerUseNativeBridge({
      platform: 'win32',
      projectRoot: MAIN_ROOT,
      workspace: MAIN_ROOT,
      paneId: '2',
      profile: 'main',
      launchOwner: true,
      intervalMs: 25,
    }, {
      probe,
      launchOwner,
      sleep: async () => {},
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'blocked',
      reason: 'computer_use_pipe_generation_unstable',
      newCodexPanePreflightReady: false,
      generation: expect.objectContaining({ pipePath: ROTATED_PIPE_PATH }),
      previousGeneration: expect.objectContaining({ pipePath: PIPE_PATH }),
    }));
    expect(launchOwner).not.toHaveBeenCalled();
  });

  test('allows an already-ready unchanged browser snapshot', () => {
    expect(bridge.browserPipeSnapshotTransitionAllowed(
      { ok: true, pipes: [BROWSER_PIPE] },
      { ok: true, pipes: [BROWSER_PIPE] }
    )).toBe(true);
  });

  test('allows only an exact official Codex browser pipe addition', () => {
    expect(bridge.browserPipeSnapshotTransitionAllowed(
      { ok: true, pipes: [BROWSER_PIPE] },
      { ok: true, pipes: [BROWSER_PIPE, OFFICIAL_CODEX_BROWSER_PIPE] }
    )).toBe(true);
    expect(bridge.browserPipeSnapshotTransitionAllowed(
      { ok: true, pipes: [BROWSER_PIPE] },
      { ok: true, pipes: [BROWSER_PIPE, ENUMERATED_CODEX_BROWSER_PIPE] }
    )).toBe(true);
    expect(bridge.browserPipeSnapshotTransitionAllowed(
      { ok: true, pipes: [BROWSER_PIPE] },
      {
        ok: true,
        pipes: [
          BROWSER_PIPE,
          'codex-browser-use/42d55c5a-9e4d-45ba-bbe3-a7fa46d8e618',
        ],
      }
    )).toBe(false);
  });

  test('blocks removal of any pre-existing browser or Chrome pipe', () => {
    expect(bridge.browserPipeSnapshotTransitionAllowed(
      { ok: true, pipes: [BROWSER_PIPE] },
      { ok: true, pipes: [] }
    )).toBe(false);
  });

  test('blocks an unrelated browser pipe addition', () => {
    expect(bridge.browserPipeSnapshotTransitionAllowed(
      { ok: true, pipes: [BROWSER_PIPE] },
      { ok: true, pipes: [BROWSER_PIPE, UNRELATED_BROWSER_PIPE] }
    )).toBe(false);
  });

  test('blocks pane readiness when an existing browser pipe disappears during owner preflight', async () => {
    let now = 0;
    const states = [
      { pipeReady: false, reason: 'codex_desktop_owner_not_running' },
      readyProbeState(),
      readyProbeState(),
    ];
    let latestState = states[0];
    const result = await bridge.prepareCodexComputerUseNativeBridge({
      platform: 'win32',
      projectRoot: MAIN_ROOT,
      workspace: MAIN_ROOT,
      paneId: '2',
      profile: 'main',
      launchOwner: true,
      timeoutMs: 1000,
      intervalMs: 50,
    }, {
      probe: async () => {
        latestState = states.length > 0 ? states.shift() : latestState;
        return latestState;
      },
      launchOwner: async () => ({ ok: true }),
      listBrowserPipes: jest.fn()
        .mockResolvedValueOnce({ ok: true, pipes: [BROWSER_PIPE] })
        .mockResolvedValueOnce({ ok: true, pipes: [] }),
      nowMs: () => now,
      sleep: async (ms) => { now += ms; },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'blocked',
      reason: 'browser_pipe_snapshot_changed_during_preflight',
      ownerLaunchDispatched: true,
      ownerLaunched: true,
      newCodexPanePreflightReady: false,
    }));
    expect(result.browserPipeSnapshot).toEqual({
      before: { ok: true, reason: null, error: null, pipes: [BROWSER_PIPE] },
      after: { ok: true, reason: null, error: null, pipes: [] },
      reSnapshotted: true,
    });
  });

  test('post-spawn confirmation fails closed after owner generation rotation', async () => {
    const expectedGeneration = bridge.captureCodexComputerUsePipeGeneration(readyProbeState());
    const result = await bridge.confirmCodexComputerUsePipeGeneration(
      expectedGeneration,
      {
        platform: 'win32',
        projectRoot: MAIN_ROOT,
        paneId: '2',
        profile: 'main',
      },
      {
        probe: async () => readyProbeState(ROTATED_PIPE_PATH),
      }
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'blocked',
      reason: 'computer_use_pipe_generation_changed',
      expectedGeneration: expect.objectContaining({ pipePath: PIPE_PATH }),
      actualGeneration: expect.objectContaining({ pipePath: ROTATED_PIPE_PATH }),
    }));
  });

  test('times out fail-closed without claiming attachment', async () => {
    let now = 0;
    const launchResult = {
      ok: true,
      dispatchInvoked: true,
      exitStatus: 1,
      exitStatusAuthoritative: false,
    };
    const result = await bridge.prepareCodexComputerUseNativeBridge({
      platform: 'win32',
      projectRoot: MAIN_ROOT,
      workspace: MAIN_ROOT,
      paneId: '2',
      profile: 'main',
      launchOwner: true,
      timeoutMs: 250,
      intervalMs: 100,
    }, {
      probe: async () => ({
        pipeReady: false,
        reason: 'codex_desktop_pipe_not_ready',
        desktopOwner: {
          probeOk: true,
          running: false,
        },
      }),
      launchOwner: async () => launchResult,
      listBrowserPipes: async () => ({ ok: true, pipes: [BROWSER_PIPE] }),
      nowMs: () => now,
      sleep: async (ms) => { now += ms; },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'blocked',
      reason: 'codex_desktop_pipe_ready_timeout',
      ownerLaunchDispatched: true,
      ownerLaunched: false,
      launchResult,
      newCodexPanePreflightReady: false,
      existingPaneAttachmentProven: false,
      existingPaneRebindMethod: 'unresolved',
      targetPaneRestartRequired: null,
      listWindowsProofRequired: true,
    }));
  });

  test('official owner launch uses only the exact Codex AUMID, never a ChatGPT shortcut', async () => {
    const calls = [];
    const result = await bridge.defaultLaunchCodexDesktopOwner({
      platform: 'win32',
      runner: async (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      aumid: 'OpenAI.Codex_2p2nqsd0c76g0!App',
      reason: 'exact_codex_desktop_aumid_dispatch_invoked',
      dispatchInvoked: true,
      exitStatus: 0,
      exitStatusAuthoritative: false,
    }));
    expect(calls).toEqual([{
      command: 'explorer.exe',
      args: ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'],
    }]);
    expect(JSON.stringify(calls)).not.toMatch(/ChatGPT/iu);
  });

  test('treats explorer exit 1 as non-authoritative and continues exact owner-pipe polling', async () => {
    let now = 0;
    const states = [
      { pipeReady: false, reason: 'codex_desktop_owner_not_running' },
      readyProbeState(),
      readyProbeState(),
    ];
    let latestState = states[0];
    const runner = jest.fn(async () => ({
      error: Object.assign(new Error('explorer exited with code 1'), { code: 1 }),
      status: 1,
      stdout: '',
      stderr: '',
    }));

    const result = await bridge.prepareCodexComputerUseNativeBridge({
      platform: 'win32',
      projectRoot: MAIN_ROOT,
      workspace: MAIN_ROOT,
      paneId: '2',
      profile: 'main',
      launchOwner: true,
      timeoutMs: 1000,
      intervalMs: 50,
    }, {
      probe: async () => {
        latestState = states.length > 0 ? states.shift() : latestState;
        return latestState;
      },
      runner,
      listBrowserPipes: jest.fn()
        .mockResolvedValueOnce({ ok: true, pipes: [BROWSER_PIPE] })
        .mockResolvedValueOnce({ ok: true, pipes: [BROWSER_PIPE] }),
      nowMs: () => now,
      sleep: async (ms) => { now += ms; },
    });

    expect(runner).toHaveBeenCalledWith(
      'explorer.exe',
      ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'],
      expect.objectContaining({ windowsHide: true })
    );
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'ready',
      reason: 'codex_desktop_owner_launched_and_exact_pipe_ready',
      ownerLaunchDispatched: true,
      ownerLaunched: true,
      newCodexPanePreflightReady: true,
      launchResult: expect.objectContaining({
        ok: true,
        dispatchInvoked: true,
        exitStatus: 1,
        exitStatusAuthoritative: false,
        reason: 'exact_codex_desktop_aumid_dispatch_invoked',
      }),
    }));
  });

  test('blocks before readiness polling when explorer cannot be spawned', async () => {
    const probe = jest.fn(async () => ({
      pipeReady: false,
      reason: 'codex_desktop_owner_not_running',
    }));
    const runner = jest.fn(async () => ({
      error: Object.assign(new Error('spawn explorer.exe ENOENT'), { code: 'ENOENT' }),
      status: null,
      spawned: false,
      stdout: '',
      stderr: '',
    }));
    const listBrowserPipes = jest.fn(async () => ({ ok: true, pipes: [BROWSER_PIPE] }));

    const result = await bridge.prepareCodexComputerUseNativeBridge({
      platform: 'win32',
      projectRoot: MAIN_ROOT,
      workspace: MAIN_ROOT,
      paneId: '2',
      profile: 'main',
      launchOwner: true,
      timeoutMs: 1000,
      intervalMs: 50,
    }, {
      probe,
      runner,
      listBrowserPipes,
      sleep: async () => {
        throw new Error('readiness polling must not begin after spawn failure');
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'blocked',
      reason: 'codex_desktop_owner_launch_failed',
      ownerLaunchDispatched: false,
      ownerLaunched: false,
      launchResult: expect.objectContaining({
        ok: false,
        dispatchInvoked: false,
        exitStatus: null,
        exitStatusAuthoritative: false,
      }),
    }));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(listBrowserPipes).toHaveBeenCalledTimes(2);
  });

  test('keeps an explorer spawn exception blocking', async () => {
    const result = await bridge.defaultLaunchCodexDesktopOwner({
      platform: 'win32',
      runner: async () => {
        throw Object.assign(new Error('spawn explorer.exe EACCES'), { code: 'EACCES' });
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'blocked',
      reason: 'codex_desktop_aumid_launch_failed',
      aumid: bridge.CODEX_DESKTOP_AUMID,
      error: 'spawn explorer.exe EACCES',
    }));
  });
});

describe('official list_windows verification seam', () => {
  const clientRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-cua-client-test-'));
  const clientPath = path.join(clientRoot, 'computer-use-client.mjs');
  fs.writeFileSync(clientPath, 'export async function setupComputerUseRuntime() {}\n');
  const clientSha256 = proof.sha256File(clientPath);
  const canonicalPlan = proof.buildCanonicalListWindowsPlan({
    clientPath,
    clientSha256,
  });
  const readyBridge = {
    pipeReady: true,
    projectRoot: MAIN_ROOT,
    paneId: '2',
    profile: 'main',
    config: {
      codexHome: 'C:\\Users\\James\\.codex',
      configPath: 'C:\\Users\\James\\.codex\\config.toml',
      pipePath: PIPE_PATH,
    },
    desktopOwner: { running: true },
    pipe: {
      path: PIPE_PATH,
      present: true,
      exactPipeIsUnique: true,
    },
  };
  const trustedClaim = {
    claimId: 'generation-claim-2',
    paneId: '2',
    workspace: MAIN_ROOT,
    projectRoot: MAIN_ROOT,
    profile: 'main',
    generation: bridge.captureCodexComputerUsePipeGeneration(readyBridge),
    commandAuthorizedAt: '2026-07-29T23:01:00.000Z',
    postSpawnConfirmedAt: '2026-07-29T23:01:01.000Z',
    proof: {
      state: 'armed',
      canonicalPlan,
      officialClientPath: clientPath,
      officialClientSha256: clientSha256,
    },
  };

  test('generates guidance then only the official plugin-wrapper list_windows call', () => {
    const result = bridge.buildOfficialListWindowsVerification({
      bridge: readyBridge,
      trustedClaim,
      projectRoot: MAIN_ROOT,
      paneId: '2',
      clientPath,
    });

    expect(result.ok).toBe(true);
    expect(result.transport).toBe('official_computer_use_plugin_wrapper');
    expect(result.snippet).toContain('setupComputerUseRuntime');
    expect(result.snippet).toContain("globalThis.sky.documentation('guidance')");
    expect(result.snippet).toContain('globalThis.sky.list_windows()');
    expect(result.snippet.indexOf("globalThis.sky.documentation('guidance')"))
      .toBeLessThan(result.snippet.indexOf('globalThis.sky.list_windows()'));
    expect(result.snippet).not.toContain('SKY_CUA_NATIVE_PIPE_DIRECTORY =');
    expect(result.snippet).not.toContain(PIPE_PATH);
    expect(result.snippet).not.toContain('expectedPaneId');
    expect(result.snippet).not.toContain('expectedPipePath');
    expect(result.snippet).not.toContain('privilegedPipePathNotExposedToModelCode');
    expect(result.snippet).not.toContain('officialWrapperListWindowsSucceededInTargetPane');
    expect(result.snippet).not.toContain('codex-computer-use.exe');
    expect(result.snippet).not.toContain('createConnection');
    expect(result.snippet).not.toContain('jsonrpc');
    expect(result.snippet).not.toContain('nodeRepl.env.SKY_CUA_NATIVE_PIPE_DIRECTORY =');
    expect(result.nonClaims).toEqual(expect.arrayContaining([
      'does_not_spawn_codex_computer_use_helper',
      'does_not_implement_native_pipe_protocol',
      'does_not_override_the_privileged_node_repl_pipe',
      'does_not_restart_or_kill_preexisting_squidrun_panes',
      'does_not_touch_browser_or_chrome_backends',
    ]));
  });

  test('refuses even minimal renderer-supplied list_windows evidence', () => {
    const result = bridge.verifyOfficialListWindowsProof({
      schema: bridge.LIST_WINDOWS_PROOF_SCHEMA,
      operation: 'list_windows',
      ok: true,
      workingDirectory: MAIN_ROOT,
      windowCount: 7,
    }, {
      bridge: readyBridge,
      trustedClaim,
      projectRoot: MAIN_ROOT,
      paneId: '2',
      platform: 'win32',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'blocked',
      reason: 'renderer_supplied_computer_use_proof_refused',
      reasons: ['renderer_supplied_computer_use_proof_refused'],
      operation: 'list_windows',
      windowCount: null,
      trustedClaimId: 'generation-claim-2',
    }));
  });

  test('reports every forged renderer field while refusing the whole proof surface', () => {
    const result = bridge.verifyOfficialListWindowsProof({
      schema: bridge.LIST_WINDOWS_PROOF_SCHEMA,
      operation: 'list_windows',
      ok: true,
      expectedPaneId: '2',
      expectedPipePath: PIPE_PATH,
      workingDirectory: MAIN_ROOT,
      officialWrapperListWindowsSucceededInTargetPane: true,
      privilegedPipePathNotExposedToModelCode: true,
      windowCount: 1,
    }, {
      bridge: readyBridge,
      trustedClaim,
      projectRoot: MAIN_ROOT,
      paneId: '2',
      platform: 'win32',
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(['renderer_supplied_computer_use_proof_refused']);
    expect(result.untrustedFields).toEqual([
      'expectedPaneId',
      'expectedPipePath',
      'officialWrapperListWindowsSucceededInTargetPane',
      'ok',
      'operation',
      'privilegedPipePathNotExposedToModelCode',
      'schema',
      'windowCount',
      'workingDirectory',
    ]);
  });

  test('rejects rotation before issuing the server-held canonical plan', () => {
    const rotatedBridge = {
      ...readyBridge,
      config: { ...readyBridge.config, pipePath: ROTATED_PIPE_PATH },
      pipe: { ...readyBridge.pipe, path: ROTATED_PIPE_PATH },
    };
    const result = bridge.buildOfficialListWindowsVerification({
      bridge: rotatedBridge,
      trustedClaim,
      projectRoot: MAIN_ROOT,
      paneId: '2',
      clientPath,
      platform: 'win32',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'trusted_generation_claim_stale',
    }));
  });

  test('rejects foreign-root, unready bridge, or missing trusted claim before plan issue', () => {
    const missing = bridge.buildOfficialListWindowsVerification({
      bridge: { ...readyBridge, pipeReady: false },
      projectRoot: MAIN_ROOT,
      paneId: '2',
      clientPath,
      platform: 'win32',
    });
    expect(missing).toEqual(expect.objectContaining({
      ok: false,
      reason: 'trusted_generation_claim_missing',
    }));

    const foreign = bridge.buildOfficialListWindowsVerification({
      bridge: readyBridge,
      trustedClaim: {
        ...trustedClaim,
        workspace: sideprofile_ROOT,
        projectRoot: sideprofile_ROOT,
      },
      projectRoot: MAIN_ROOT,
      paneId: '2',
      clientPath,
      platform: 'win32',
    });
    expect(foreign).toEqual(expect.objectContaining({
      ok: false,
      reason: 'trusted_generation_workspace_mismatch',
      reasons: ['trusted_generation_workspace_mismatch'],
    }));
  });
});

describe('hm-codex-computer-use-bridge CLI', () => {
  test('status emits deterministic read-only JSON', async () => {
    const logger = jest.fn();
    const result = {
      ok: false,
      schema: bridge.BRIDGE_SCHEMA,
      status: 'blocked',
      reason: 'codex_desktop_owner_not_running',
    };
    const exitCode = await cli.main([
      'status',
      '--workspace',
      MAIN_ROOT,
      '--pane-id',
      '2',
    ], {
      env: { SQUIDRUN_PROFILE: 'main' },
      projectRoot: MAIN_ROOT,
      probe: async () => result,
      logger,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(logger.mock.calls[0][0])).toEqual(result);
  });

  test('prepare dry-run forwards explicit owner-launch intent without any live runner', async () => {
    const logger = jest.fn();
    const prepare = jest.fn(async (input) => ({
      ok: true,
      status: 'dry_run',
      launchOwner: input.launchOwner,
      dryRun: input.dryRun,
    }));
    const exitCode = await cli.main([
      'prepare',
      '--workspace',
      MAIN_ROOT,
      '--pane-id',
      '2',
      '--launch-owner',
      '--dry-run',
    ], {
      env: { SQUIDRUN_PROFILE: 'main' },
      projectRoot: MAIN_ROOT,
      prepare,
      logger,
    });

    expect(exitCode).toBe(0);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: path.resolve(MAIN_ROOT),
      workspace: path.resolve(MAIN_ROOT),
      paneId: '2',
      profile: 'main',
      launchOwner: true,
      dryRun: true,
    }), expect.any(Object));
  });

  test('activate forwards only explicit current-session authority to the standalone controller', async () => {
    const logger = jest.fn();
    const activate = jest.fn(async (input) => ({
      ok: true,
      status: 'passed',
      command: input.command,
      launchOwner: input.launchOwner,
      executeCurrentSessionProof: input.executeCurrentSessionProof,
    }));
    const exitCode = await cli.main([
      'activate',
      '--workspace',
      MAIN_ROOT,
      '--profile',
      'main',
      '--launch-owner',
      '--execute-current-session-proof',
      '--proof-timeout-ms',
      '30000',
    ], {
      env: {},
      projectRoot: MAIN_ROOT,
      activate,
      logger,
    });

    expect(exitCode).toBe(0);
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: path.resolve(MAIN_ROOT),
      workspace: path.resolve(MAIN_ROOT),
      profile: 'main',
      command: 'codex --yolo',
      launchOwner: true,
      executeCurrentSessionProof: true,
      proofTimeoutMs: '30000',
    }), expect.any(Object));
  });
});
