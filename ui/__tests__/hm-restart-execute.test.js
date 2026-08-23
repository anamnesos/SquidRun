'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const restartExecute = require('../scripts/hm-restart-execute');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonLine(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeRegistry(projectRoot, liveInstance = {}, templateInstance = {}) {
  const baseInstance = {
    id: 'james-main',
    coordPath: '.squidrun/coord',
    architectInbox: '.squidrun/coord/architect-inbox.jsonl',
    appStatusPath: '.squidrun/app-status.json',
    launchCommand: {
      command: 'node',
      args: ['fake-launch.js'],
      cwd: '.',
    },
  };
  writeJson(path.join(projectRoot, '.squidrun', 'operator-registry.template.json'), {
    schemaVersion: 1,
    instances: [
      {
        ...baseInstance,
        ...templateInstance,
      },
    ],
  });
  writeJson(path.join(projectRoot, '.squidrun', 'operator-registry.json'), {
    schemaVersion: 1,
    instances: [
      {
        ...baseInstance,
        ...liveInstance,
      },
    ],
  });
  writeJson(path.join(projectRoot, '.squidrun', 'app-status.json'), {
    settingsPersistence: {
      cwd: path.join(projectRoot, 'ui'),
    },
  });
}

function writeMultiInstanceRegistry(projectRoot, profileWorkspaceRoot) {
  const mainInstance = {
    id: 'james-main',
    profile: 'main',
    coordPath: '.squidrun/coord',
    architectInbox: '.squidrun/coord/architect-inbox.jsonl',
    appStatusPath: '.squidrun/app-status.json',
  };
  const clientInstance = {
    id: 'client-sideprofile',
    profile: 'sideprofile',
    coordPath: '.squidrun/coord-sideprofile',
    architectInbox: '.squidrun/coord-sideprofile/architect-inbox.jsonl',
    appStatusPath: '.squidrun/app-status-sideprofile.json',
    allowedRuntimePaths: [
      '.squidrun/runtime-sideprofile',
      '.squidrun/settings-sideprofile',
    ],
  };
  writeJson(path.join(projectRoot, '.squidrun', 'operator-registry.template.json'), {
    schemaVersion: 1,
    instances: [mainInstance, clientInstance],
  });
  writeJson(path.join(projectRoot, '.squidrun', 'operator-registry.json'), {
    schemaVersion: 1,
    instances: [mainInstance, clientInstance],
  });
  writeJson(path.join(projectRoot, '.squidrun', 'app-status.json'), {
    lastUpdated: '2026-06-11T06:00:00.000Z',
    settingsPersistence: {
      cwd: path.join(projectRoot, 'ui'),
      userDataPath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui',
    },
  });
  writeJson(path.join(projectRoot, '.squidrun', 'app-status-sideprofile.json'), {
    lastUpdated: '2026-05-04T00:04:54.639Z',
    session: 186,
    settingsPersistence: {
      cwd: path.join(projectRoot, 'ui'),
      userDataPath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui\\sideprofile',
    },
  });
  fs.mkdirSync(path.join(projectRoot, '.squidrun', 'coord-sideprofile'), { recursive: true });
  if (profileWorkspaceRoot) {
    writeJson(path.join(profileWorkspaceRoot, '.squidrun', 'link.json'), {
      squidrun_root: projectRoot,
      workspace: profileWorkspaceRoot,
      profile: 'sideprofile',
    });
    writeJson(path.join(profileWorkspaceRoot, '.squidrun', 'app-status-sideprofile.json'), {
      lastUpdated: '2026-06-11T06:16:51.396Z',
      session: 212,
      settingsPersistence: {
        cwd: path.join(projectRoot, 'ui'),
        settingsPath: path.join(profileWorkspaceRoot, '.squidrun', 'settings-sideprofile', 'settings.json'),
        appStatusPath: path.join(profileWorkspaceRoot, '.squidrun', 'app-status-sideprofile.json'),
        userDataPath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui\\sideprofile',
      },
    });
  }
}

function processRowsWithDescendants() {
  return [
    {
      ProcessId: 111,
      ParentProcessId: 99,
      Name: 'electron.exe',
      ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
      CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" .',
    },
    {
      ProcessId: 201,
      ParentProcessId: 111,
      Name: 'claude.exe',
      ExecutablePath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\claude.exe',
      CommandLine: 'claude --dangerously-skip-permissions',
    },
    {
      ProcessId: 202,
      ParentProcessId: 111,
      Name: 'claude.exe',
      ExecutablePath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\claude.exe',
      CommandLine: 'claude --dangerously-skip-permissions',
    },
    {
      ProcessId: 203,
      ParentProcessId: 202,
      Name: 'claude.exe',
      ExecutablePath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\claude.exe',
      CommandLine: 'claude --dangerously-skip-permissions',
    },
  ];
}

function orphanSweepRows(projectRoot = 'D:\\projects\\squidrun') {
  return [
    {
      ProcessId: 500,
      ParentProcessId: 99,
      Name: 'electron.exe',
      ExecutablePath: `${projectRoot}\\ui\\node_modules\\electron\\dist\\electron.exe`,
      CommandLine: `"${projectRoot}\\ui\\node_modules\\electron\\dist\\electron.exe" .`,
    },
    {
      ProcessId: 501,
      ParentProcessId: 500,
      Name: 'node.exe',
      ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
      CommandLine: `node ${projectRoot}\\ui\\terminal-daemon.js`,
    },
    {
      ProcessId: 502,
      ParentProcessId: 501,
      Name: 'claude.exe',
      ExecutablePath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\claude.exe',
      CommandLine: 'claude --dangerously-skip-permissions',
    },
    {
      ProcessId: 38852,
      ParentProcessId: 42,
      Name: 'node.exe',
      ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
      CommandLine: `node ${projectRoot}\\ui\\terminal-daemon.js`,
    },
    {
      ProcessId: 41552,
      ParentProcessId: 38852,
      Name: 'powershell.exe',
      ExecutablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      CommandLine: 'powershell.exe',
    },
    {
      ProcessId: 44480,
      ParentProcessId: 41552,
      Name: 'claude.exe',
      ExecutablePath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\claude.exe',
      CommandLine: 'claude --dangerously-skip-permissions',
    },
  ];
}

function duplexProcessRows(projectRoot = 'D:\\projects\\squidrun') {
  return [
    {
      ProcessId: 100,
      ParentProcessId: 10,
      Name: 'electron.exe',
      ExecutablePath: `${projectRoot}\\ui\\node_modules\\electron\\dist\\electron.exe`,
      CommandLine: `"${projectRoot}\\ui\\node_modules\\electron\\dist\\electron.exe" .`,
    },
    {
      ProcessId: 101,
      ParentProcessId: 100,
      Name: 'electron.exe',
      ExecutablePath: `${projectRoot}\\ui\\node_modules\\electron\\dist\\electron.exe`,
      CommandLine: `"${projectRoot}\\ui\\node_modules\\electron\\dist\\electron.exe" --type=renderer --user-data-dir="C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui" --app-path="${projectRoot}\\ui"`,
    },
    {
      ProcessId: 200,
      ParentProcessId: 20,
      Name: 'electron.exe',
      ExecutablePath: `${projectRoot}\\ui\\node_modules\\electron\\dist\\electron.exe`,
      CommandLine: `"${projectRoot}\\ui\\node_modules\\electron\\dist\\electron.exe" . --profile=sideprofile --window=sideprofile --standalone-window`,
    },
    {
      ProcessId: 201,
      ParentProcessId: 200,
      Name: 'electron.exe',
      ExecutablePath: `${projectRoot}\\ui\\node_modules\\electron\\dist\\electron.exe`,
      CommandLine: `"${projectRoot}\\ui\\node_modules\\electron\\dist\\electron.exe" --type=renderer --user-data-dir="C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui\\sideprofile" --app-path="${projectRoot}\\ui"`,
    },
  ];
}

function mainAndStandaloneInstallRows() {
  return [
    {
      ProcessId: 700,
      ParentProcessId: 10,
      Name: 'electron.exe',
      ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
      CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" .',
    },
    {
      ProcessId: 701,
      ParentProcessId: 700,
      Name: 'electron.exe',
      ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
      CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" --type=renderer --app-path="D:\\projects\\squidrun\\ui"',
    },
    {
      ProcessId: 800,
      ParentProcessId: 20,
      Name: 'sr-electron.exe',
      ExecutablePath: 'D:\\SquidRun\\sideprofile\\versions\\0.1.34-171113b6\\sr-electron.exe',
      CommandLine: '"D:\\SquidRun\\sideprofile\\versions\\0.1.34-171113b6\\sr-electron.exe"',
    },
    {
      ProcessId: 801,
      ParentProcessId: 800,
      Name: 'sr-electron.exe',
      ExecutablePath: 'D:\\SquidRun\\sideprofile\\versions\\0.1.34-171113b6\\sr-electron.exe',
      CommandLine: 'D:\\SquidRun\\sideprofile\\versions\\0.1.34-171113b6\\sr-electron.exe D:\\SquidRun\\sideprofile\\versions\\0.1.34-171113b6\\resources\\app.asar\\supervisor-daemon.js',
    },
    {
      ProcessId: 802,
      ParentProcessId: 800,
      Name: 'sr-electron.exe',
      ExecutablePath: 'D:\\SquidRun\\sideprofile\\versions\\0.1.34-171113b6\\sr-electron.exe',
      CommandLine: 'D:\\SquidRun\\sideprofile\\versions\\0.1.34-171113b6\\sr-electron.exe D:\\SquidRun\\sideprofile\\versions\\0.1.34-171113b6\\resources\\app.asar.unpacked\\terminal-daemon.js',
    },
  ];
}

function processRowsWithExecutorAncestry() {
  return [
    {
      ProcessId: 111,
      ParentProcessId: 99,
      Name: 'electron.exe',
      ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
      CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" . --profile=sideprofile --window=sideprofile --standalone-window',
    },
    {
      ProcessId: 120,
      ParentProcessId: 111,
      Name: 'electron.exe',
      ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
      CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" --type=renderer --user-data-dir="C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui\\sideprofile"',
    },
    {
      ProcessId: 130,
      ParentProcessId: 111,
      Name: 'electron.exe',
      ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
      CommandLine: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe D:\\projects\\squidrun\\ui\\modules\\watcher-worker.js',
    },
    {
      ProcessId: 201,
      ParentProcessId: 111,
      Name: 'node.exe',
      ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
      CommandLine: 'node D:\\projects\\squidrun\\ui\\terminal-daemon.js',
    },
    {
      ProcessId: 202,
      ParentProcessId: 201,
      Name: 'powershell.exe',
      ExecutablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      CommandLine: 'powershell.exe -NoLogo -NoProfile -Command codex',
    },
    {
      ProcessId: 203,
      ParentProcessId: 202,
      Name: 'node.exe',
      ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
      CommandLine: 'node D:\\projects\\squidrun\\ui\\scripts\\hm-restart-execute.js --instance client-sideprofile',
    },
    {
      ProcessId: 204,
      ParentProcessId: 203,
      Name: 'node.exe',
      ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
      CommandLine: 'node @modelcontextprotocol/server-github',
    },
  ];
}

describe('hm-restart-execute', () => {
  let tempRoot;

  const greenRestartLaunchProbe = () => ({
    ok: true,
    reason: null,
    renderer: { visible: false, focused: false },
  });

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-restart-execute-'));
    fs.mkdirSync(path.join(tempRoot, '.squidrun', 'coord'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('requires a fresh green preflight before touching processes', async () => {
    writeRegistry(tempRoot);
    const runNodeScript = jest.fn(() => ({ status: 0 }));
    const listElectronProcesses = jest.fn(() => [{ pid: 111 }]);

    const result = await restartExecute.executeRestart({
      projectRoot: tempRoot,
      instance: 'james-main',
      reason: 'manual test restart',
      nowMs: Date.parse('2026-04-27T00:05:00.000Z'),
      listElectronProcesses,
      runNodeScript,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      stage: 'preflight',
      reason: 'missing_green_preflight',
    }));
    expect(listElectronProcesses).not.toHaveBeenCalled();
    expect(runNodeScript).toHaveBeenCalledTimes(1);
    expect(runNodeScript.mock.calls[0][0]).toEqual(expect.stringContaining('hm-anomaly.js'));
    expect(runNodeScript.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'type=restart_execute_failure',
      'src=hm-restart-execute',
      'sev=high',
      '--json',
    ]));
  });

  test('does not infer a restart target from process name or window title without a root path', () => {
    const tasklistOutput = [
      '"Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"',
      '"electron.exe","29364","Console","1","150,000 K","Running","EXAMPLE\\ExampleUser","0:01:00","SquidRun"',
      '"powershell.exe","41000","Console","1","80,000 K","Running","EXAMPLE\\ExampleUser","0:00:05","Terminal"',
    ].join('\r\n');

    const processes = restartExecute.listElectronProcesses('D:\\projects\\squidrun', {
      tasklistOutput,
    });

    expect(processes).toEqual([]);
  });

  test('refuses to touch processes when installed dependency integrity is red', async () => {
    writeRegistry(tempRoot);
    appendJsonLine(path.join(tempRoot, '.squidrun', 'coord', 'architect-inbox.jsonl'), {
      type: 'restart_preflight',
      instance: 'james-main',
      status: 'green',
      timestampUtc: '2026-04-27T00:04:30.000Z',
    });
    const listElectronProcesses = jest.fn(() => [{ pid: 111 }]);
    const runNodeScript = jest.fn(() => ({ status: 0 }));

    const result = await restartExecute.executeRestart({
      projectRoot: tempRoot,
      instance: 'james-main',
      reason: 'dependency red test',
      nowMs: Date.parse('2026-04-27T00:05:00.000Z'),
      checkDependencyIntegrity: jest.fn(() => ({ ok: false, reason: 'npm_tree_invalid' })),
      listElectronProcesses,
      runNodeScript,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      stage: 'dependency_integrity',
      reason: 'npm_tree_invalid',
    }));
    expect(listElectronProcesses).not.toHaveBeenCalled();
    expect(runNodeScript.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'type=restart_execute_dependency_integrity_failed',
      'src=hm-restart-execute',
    ]));
    const steps = readJsonLines(path.join(tempRoot, '.squidrun', 'coord', 'restart-execute-log.jsonl'))
      .map((entry) => entry.step);
    expect(steps).toEqual(['preflight_check', 'dependency_integrity_check']);
  });

  test('refuses to touch processes when the isolated real launch probe is red', async () => {
    writeRegistry(tempRoot);
    appendJsonLine(path.join(tempRoot, '.squidrun', 'coord', 'architect-inbox.jsonl'), {
      type: 'restart_preflight',
      instance: 'james-main',
      status: 'green',
      timestampUtc: '2026-04-27T00:04:30.000Z',
    });
    const listElectronProcesses = jest.fn(() => [{ pid: 111 }]);
    const runNodeScript = jest.fn(() => ({ status: 0 }));

    const result = await restartExecute.executeRestart({
      projectRoot: tempRoot,
      instance: 'james-main',
      reason: 'launch probe red test',
      nowMs: Date.parse('2026-04-27T00:05:00.000Z'),
      checkDependencyIntegrity: jest.fn(() => ({ ok: true, reason: null })),
      runRestartLaunchProbe: jest.fn(() => ({
        ok: false,
        reason: 'restart_launch_probe_process_failed',
      })),
      listElectronProcesses,
      runNodeScript,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      stage: 'restart_launch_probe',
      reason: 'restart_launch_probe_process_failed',
    }));
    expect(listElectronProcesses).not.toHaveBeenCalled();
    expect(runNodeScript.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'type=restart_execute_launch_probe_failed',
      'src=hm-restart-execute',
    ]));
    const steps = readJsonLines(path.join(tempRoot, '.squidrun', 'coord', 'restart-execute-log.jsonl'))
      .map((entry) => entry.step);
    expect(steps).toEqual([
      'preflight_check',
      'dependency_integrity_check',
      'restart_launch_probe_check',
    ]);
  });

  test('selects only the top-level main SquidRun Electron parent from process rows', () => {
    const processes = restartExecute.selectSquidRunElectronProcesses('D:\\projects\\squidrun', [
      {
        ProcessId: 29364,
        ParentProcessId: 11588,
        Name: 'electron.exe',
        ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
        CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" .',
      },
      {
        ProcessId: 44792,
        ParentProcessId: 29364,
        Name: 'electron.exe',
        ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
        CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" --type=renderer --app-path="D:\\projects\\squidrun\\ui"',
      },
      {
        ProcessId: 34056,
        ParentProcessId: 29364,
        Name: 'electron.exe',
        ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
        CommandLine: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe D:\\projects\\squidrun\\ui\\modules\\team-memory\\worker.js',
      },
      {
        ProcessId: 31184,
        ParentProcessId: 36520,
        Name: 'electron.exe',
        ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
        CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" "D:\\projects\\squidrun\\ui" --profile=scoped --window=scoped --standalone-window',
      },
    ]);

    expect(processes).toEqual([
      expect.objectContaining({
        pid: 29364,
        matchReason: 'direct_project_match',
      }),
    ]);
  });

  test('main restart selection ignores standalone installs outside the main root', () => {
    const processes = restartExecute.selectSquidRunElectronProcesses(
      'D:\\projects\\squidrun',
      mainAndStandaloneInstallRows(),
      {
        instanceConfig: {
          id: 'james-main',
          profile: 'main',
          appStatusPath: path.join(tempRoot, '.squidrun', 'app-status.json'),
          appStatus: {
            settingsPersistence: {
              userDataPath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui',
            },
          },
        },
      }
    );

    expect(processes).toEqual([
      expect.objectContaining({
        pid: 700,
        matchReason: expect.stringContaining('instance_main'),
      }),
    ]);
    expect(processes.map((proc) => proc.pid)).not.toEqual(expect.arrayContaining([800, 801, 802]));
  });

  test('main restart rejects a foreign app.asar loaded by the main Electron host', () => {
    const processes = restartExecute.selectSquidRunElectronProcesses(
      'D:\\projects\\squidrun',
      [
        {
          ProcessId: 500,
          ParentProcessId: 10,
          Name: 'electron.exe',
          ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
          CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" .',
        },
        {
          ProcessId: 28480,
          ParentProcessId: 20,
          Name: 'electron.exe',
          ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
          CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" D:\\SquidRun\\sideprofile\\versions\\0.1.34-4c186a10\\resources\\app.asar',
        },
        {
          ProcessId: 37240,
          ParentProcessId: 28480,
          Name: 'electron.exe',
          ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
          CommandLine: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe D:\\SquidRun\\sideprofile\\versions\\0.1.34-4c186a10\\resources\\app.asar\\scripts\\hm-bidirectional-wake-watchdog.js run --state D:\\SquidRun\\sideprofile\\.squidrun\\runtime\\bidirectional-wake-state.json --interval-ms 60000',
        },
      ],
      {
        instanceConfig: {
          id: 'james-main',
          profile: 'main',
          appStatusPath: path.join(tempRoot, '.squidrun', 'app-status.json'),
          appStatus: {
            settingsPersistence: {
              userDataPath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui',
            },
          },
        },
      }
    );

    expect(processes).toEqual([
      expect.objectContaining({
        pid: 500,
        matchReason: 'instance_main_default',
      }),
    ]);
    expect(processes.map((proc) => proc.pid)).not.toEqual(expect.arrayContaining([28480, 37240]));
  });

  test('does not select Electron-hosted script helpers as restart targets', () => {
    const processes = restartExecute.selectSquidRunElectronProcesses('D:\\projects\\squidrun', [
      {
        ProcessId: 500,
        ParentProcessId: 42,
        Name: 'electron.exe',
        ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
        CommandLine: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe D:\\projects\\squidrun\\ui\\scripts\\hm-bidirectional-wake-watchdog.js run',
      },
    ]);

    expect(processes).toEqual([]);
  });

  test('does not classify a foreign installer stored under the SquidRun project root as Electron', () => {
    expect(restartExecute.processExecutableBasename(
      'D:\\projects\\squidrun\\.squidrun\\runtime\\installers\\tailscale-setup-1.102.3.exe'
    )).toBe('tailscale-setup-1.102.3.exe');
    expect(restartExecute.processExecutableBasename(
      'D:/projects/squidrun/.squidrun/runtime/installers/tailscale-setup-1.102.3.exe'
    )).toBe('tailscale-setup-1.102.3.exe');
    const rows = [
      {
        ProcessId: 30920,
        ParentProcessId: 14208,
        Name: 'electron.exe',
        ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
        CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" .',
      },
      {
        ProcessId: 41068,
        ParentProcessId: 31928,
        Name: 'tailscale-setup-1.102.3.exe',
        ExecutablePath: 'D:\\projects\\squidrun\\.squidrun\\runtime\\installers\\tailscale-setup-1.102.3.exe',
        CommandLine: 'D:\\projects\\squidrun\\.squidrun\\runtime\\installers\\tailscale-setup-1.102.3.exe',
      },
    ];
    const instanceConfig = {
      id: 'james-main',
      profile: 'main',
      appStatusPath: path.join(tempRoot, '.squidrun', 'app-status.json'),
      appStatus: {
        settingsPersistence: {
          userDataPath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui',
        },
      },
    };

    const processes = restartExecute.selectSquidRunElectronProcesses(
      'D:\\projects\\squidrun', rows, { instanceConfig }
    );
    const killOrder = restartExecute.buildShutdownKillOrder(processes, rows, { protectExecutorTree: false });

    expect(processes.map((proc) => proc.pid)).toEqual([30920]);
    expect(killOrder.map((proc) => proc.pid)).toEqual([30920]);
    expect(processes.map((proc) => proc.pid)).not.toContain(41068);
    expect(killOrder.map((proc) => proc.pid)).not.toContain(41068);
  });

  test('selects only the requested client instance in a live-duplex process set', () => {
    const instanceConfig = {
      id: 'client-sideprofile',
      profile: 'sideprofile',
      appStatusPath: path.join(tempRoot, '.squidrun', 'app-status-sideprofile.json'),
      appStatus: {
        settingsPersistence: {
          userDataPath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui\\sideprofile',
        },
      },
    };

    const processes = restartExecute.selectSquidRunElectronProcesses(
      'D:\\projects\\squidrun',
      duplexProcessRows(),
      { instanceConfig }
    );

    expect(processes).toEqual([
      expect.objectContaining({
        pid: 200,
        matchReason: expect.stringContaining('instance'),
      }),
    ]);
  });

  test('shutdown refuses ambiguous project-root Electron when no instance attribution exists', async () => {
    const killed = [];
    const instanceConfig = {
      id: 'client-sideprofile',
      profile: 'sideprofile',
      appStatusPath: path.join(tempRoot, '.squidrun', 'app-status-sideprofile.json'),
    };

    const result = await restartExecute.shutdownElectronProcesses('D:\\projects\\squidrun', {
      instanceConfig,
      processRows: [
        {
          ProcessId: 100,
          ParentProcessId: 10,
          Name: 'electron.exe',
          ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
          CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" .',
        },
      ],
      killProcess: (pid) => killed.push(pid),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'no_instance_attributed_process',
    }));
    expect(killed).toEqual([]);
  });

  test('loads client registry from shared root and prefers the fresh profile app-status path', () => {
    const profileWorkspaceRoot = path.join(tempRoot, '.squidrun', 'profiles', 'sideprofile', 'workspace');
    writeMultiInstanceRegistry(tempRoot, profileWorkspaceRoot);

    const instanceConfig = restartExecute.loadInstanceConfig(profileWorkspaceRoot, 'client-sideprofile');

    expect(instanceConfig.registryRoot).toBe(tempRoot);
    expect(instanceConfig.profileWorkspaceRoot).toBe(profileWorkspaceRoot);
    expect(instanceConfig.appStatusPath).toBe(path.join(
      profileWorkspaceRoot,
      '.squidrun',
      'app-status-sideprofile.json'
    ));
  });

  test('default relaunch replays captured instance commandLine and env when registry launchCommand is absent', () => {
    const instanceConfig = {
      id: 'client-sideprofile',
      profile: 'sideprofile',
      registryRoot: tempRoot,
      profileWorkspaceRoot: path.join(tempRoot, '.squidrun', 'profiles', 'sideprofile', 'workspace'),
      appStatusPath: path.join(tempRoot, '.squidrun', 'profiles', 'sideprofile', 'workspace', '.squidrun', 'app-status-sideprofile.json'),
      launchCommand: {},
    };
    writeJson(instanceConfig.appStatusPath, {
      settingsPersistence: {
        cwd: path.join(tempRoot, 'ui'),
        userDataPath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui\\sideprofile',
      },
    });

    const launch = restartExecute.defaultLaunchCommand(tempRoot, instanceConfig, {
      commandLine: '"C:\\Program Files\\Electron\\electron.exe" . --profile=sideprofile --window=sideprofile --standalone-window',
      cwd: path.join(tempRoot, 'ui'),
      env: {
        SQUIDRUN_PROFILE: 'sideprofile',
        SQUIDRUN_WINDOW_KEY: 'sideprofile',
        KEEP_FOR_RELAUNCH: '1',
      },
    });

    expect(launch.command).toBe('C:\\Program Files\\Electron\\electron.exe');
    expect(launch.args).toEqual(['.', '--profile=sideprofile', '--window=sideprofile', '--standalone-window']);
    expect(launch.cwd).toBe(path.join(tempRoot, 'ui'));
    expect(launch.env).toEqual(expect.objectContaining({
      SQUIDRUN_PROFILE: 'sideprofile',
      SQUIDRUN_WINDOW_KEY: 'sideprofile',
      SQUIDRUN_INSTANCE_ID: 'client-sideprofile',
      KEEP_FOR_RELAUNCH: '1',
    }));
  });

  test('default main relaunch ignores captured helper commandLine and uses npm start', () => {
    const instanceConfig = {
      id: 'james-main',
      profile: 'main',
      registryRoot: tempRoot,
      appStatusPath: path.join(tempRoot, '.squidrun', 'app-status.json'),
      launchCommand: {},
    };
    writeJson(instanceConfig.appStatusPath, {
      settingsPersistence: {
        cwd: path.join(tempRoot, 'ui'),
      },
    });

    const launch = restartExecute.defaultLaunchCommand(tempRoot, instanceConfig, {
      commandLine: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe D:\\projects\\squidrun\\ui\\scripts\\hm-bidirectional-wake-watchdog.js run',
      cwd: path.join(tempRoot, 'ui'),
      instanceAttributed: true,
    });

    expect(launch.command).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm');
    expect(launch.args).toEqual(['start']);
    expect(launch.cwd).toBe(path.join(tempRoot, 'ui'));
    expect(launch.env).toEqual(expect.objectContaining({
      SQUIDRUN_PROFILE: 'main',
      SQUIDRUN_WINDOW_KEY: 'main',
      SQUIDRUN_INSTANCE_ID: 'james-main',
    }));
  });

  test('shutdown skips pane descendants and kills only Electron descendants before the parent', async () => {
    const killed = [];

    const result = await restartExecute.shutdownElectronProcesses('D:\\projects\\squidrun', {
      processRows: processRowsWithDescendants(),
      killProcess: (pid, proc) => killed.push({ pid, role: proc.role }),
      processExists: jest.fn(() => false),
    });

    expect(result.ok).toBe(true);
    expect(killed).toEqual([{ pid: 111, role: 'target' }]);
    expect(result.skipped.map((proc) => proc.pid)).toEqual(expect.arrayContaining([201, 202, 203]));
  });

  test('shutdown excludes executor pid and ancestor pane chain from kill order and logs attempts before kill', async () => {
    const killed = [];
    const killAttempts = [];
    const instanceConfig = {
      id: 'client-sideprofile',
      profile: 'sideprofile',
      appStatusPath: path.join(tempRoot, '.squidrun', 'app-status-sideprofile.json'),
      appStatus: {
        settingsPersistence: {
          userDataPath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui\\sideprofile',
        },
      },
    };

    const result = await restartExecute.shutdownElectronProcesses('D:\\projects\\squidrun', {
      instanceConfig,
      executorPid: 203,
      processRows: processRowsWithExecutorAncestry(),
      onShutdownKillAttempt: (entry) => killAttempts.push(entry),
      killProcess: (pid, proc) => killed.push({ pid, role: proc.role, name: proc.name }),
      processExists: jest.fn(() => false),
    });

    expect(result.ok).toBe(true);
    expect(killed).toEqual([
      { pid: 130, role: 'descendant', name: 'electron.exe' },
      { pid: 120, role: 'descendant', name: 'electron.exe' },
      { pid: 111, role: 'target', name: 'electron.exe' },
    ]);
    expect(result.skipped.map((proc) => proc.pid)).toEqual(expect.arrayContaining([201, 202, 203, 204]));
    expect(result.killOrder.map((proc) => proc.pid)).not.toEqual(expect.arrayContaining([201, 202, 203, 204]));
    expect(killAttempts.map((entry) => entry.pid)).toEqual([130, 120, 111]);
    expect(killAttempts[0]).toEqual(expect.objectContaining({
      step: 'shutdown_kill_attempt',
      pid: 130,
      role: 'descendant',
    }));
  });

  test('shutdown kills only Electron when no descendants exist', async () => {
    const killed = [];

    const result = await restartExecute.shutdownElectronProcesses('D:\\projects\\squidrun', {
      processRows: [
        {
          ProcessId: 111,
          ParentProcessId: 99,
          Name: 'electron.exe',
          ExecutablePath: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
          CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" .',
        },
      ],
      killProcess: (pid, proc) => killed.push({ pid, role: proc.role }),
      processExists: jest.fn(() => false),
    });

    expect(result.ok).toBe(true);
    expect(killed).toEqual([{ pid: 111, role: 'target' }]);
  });

  test('shutdown for main install does not kill standalone sideprofile processes', async () => {
    const killed = [];

    const result = await restartExecute.shutdownElectronProcesses('D:\\projects\\squidrun', {
      instanceConfig: {
        id: 'james-main',
        profile: 'main',
        appStatusPath: path.join(tempRoot, '.squidrun', 'app-status.json'),
        appStatus: {
          settingsPersistence: {
            userDataPath: 'C:\\Users\\ExampleUser\\AppData\\Roaming\\squidrun-ui',
          },
        },
      },
      processRows: mainAndStandaloneInstallRows(),
      killProcess: (pid, proc) => killed.push({ pid, role: proc.role, executablePath: proc.executablePath }),
      processExists: jest.fn(() => false),
    });

    expect(result.ok).toBe(true);
    expect(killed.map((proc) => proc.pid)).toEqual([701, 700]);
    expect(killed.map((proc) => proc.executablePath).join('\n')).not.toContain('D:\\SquidRun\\sideprofile');
  });

  test('orphan sweep excludes fresh Electron descendants and kills stale terminal tree', async () => {
    const killed = [];

    const result = await restartExecute.sweepOrphanProcesses('D:\\projects\\squidrun', {
      orphanSweepProcessRows: orphanSweepRows(),
      killProcess: (pid, proc) => killed.push({ pid, role: proc.role }),
      processExists: jest.fn(() => false),
    });

    expect(result.ok).toBe(true);
    expect(killed).toEqual([
      { pid: 44480, role: 'orphan' },
      { pid: 38852, role: 'orphan' },
    ]);
    expect(result.killed.map((proc) => proc.pid)).not.toEqual(expect.arrayContaining([500, 501, 502]));
  });

  test('exits cleanly on a simulated shutdown and relaunch', async () => {
    writeRegistry(tempRoot);
    appendJsonLine(path.join(tempRoot, '.squidrun', 'coord', 'architect-inbox.jsonl'), {
      type: 'audit_grade',
      instance: 'james-main',
      grade: 'green',
      timestampUtc: '2026-04-27T00:04:30.000Z',
    });
    const unref = jest.fn();
    const killProcess = jest.fn();
    const spawn = jest.fn(() => ({ pid: 222, unref }));
    const launchStartedMs = Date.parse('2026-04-27T00:05:00.000Z');
    const captureAppStatus = jest.fn()
      .mockReturnValueOnce({
        exists: true,
        timestampMs: Date.parse('2026-04-27T00:00:00.000Z'),
        session: '301',
        pid: null,
        mtimeMs: 1,
      })
      .mockReturnValueOnce({
        exists: true,
        timestampMs: Date.parse('2026-04-27T00:05:02.000Z'),
        session: '302',
        pid: null,
        mtimeMs: 2,
      });

    const result = await restartExecute.executeRestart({
      projectRoot: tempRoot,
      instance: 'james-main',
      reason: 'green preflight test',
      checkDependencyIntegrity: jest.fn(() => ({ ok: true, reason: null })),
      runRestartLaunchProbe: jest.fn(greenRestartLaunchProbe),
      nowMs: launchStartedMs,
      launchStartedMs,
      now: jest.fn(() => launchStartedMs),
      captureAppStatus,
      listElectronProcesses: jest.fn(() => [{ pid: 111, name: 'electron.exe' }]),
      processExists: jest.fn(() => false),
      killProcess,
      spawn,
      runNodeScript: jest.fn(),
    });

    expect(result.ok).toBe(true);
    expect(killProcess).toHaveBeenCalledWith(111, expect.objectContaining({ pid: 111 }));
    expect(spawn).toHaveBeenCalledWith('node', ['fake-launch.js'], expect.objectContaining({
      cwd: tempRoot,
      detached: true,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: 'ignore',
    }));
    expect(unref).toHaveBeenCalled();
    expect(result.relaunch.pid).toBe(222);
    expect(result.verification.ok).toBe(true);
    expect(result.orphanSweep).toBeNull();
    const steps = readJsonLines(path.join(tempRoot, '.squidrun', 'coord', 'restart-execute-log.jsonl'))
      .map((entry) => entry.step);
    expect(steps).toEqual([
      'preflight_check',
      'dependency_integrity_check',
      'restart_launch_probe_check',
      'shutdown_start',
      'shutdown_kill_attempt',
      'shutdown_complete',
      'relaunch_started',
      'relaunch_verification_complete',
    ]);
  });

  test('logs an anomaly when simulated shutdown fails', async () => {
    writeRegistry(tempRoot);
    appendJsonLine(path.join(tempRoot, '.squidrun', 'coord', 'architect-inbox.jsonl'), {
      type: 'restart_preflight',
      instance: 'james-main',
      status: 'green',
      timestampUtc: '2026-04-27T00:04:30.000Z',
    });
    const runNodeScript = jest.fn(() => ({ status: 0 }));

    const result = await restartExecute.executeRestart({
      projectRoot: tempRoot,
      instance: 'james-main',
      reason: 'shutdown failure test',
      checkDependencyIntegrity: jest.fn(() => ({ ok: true, reason: null })),
      runRestartLaunchProbe: jest.fn(greenRestartLaunchProbe),
      nowMs: Date.parse('2026-04-27T00:05:00.000Z'),
      listElectronProcesses: jest.fn(() => [{ pid: 111, name: 'electron.exe' }]),
      killProcess: jest.fn(() => {
        throw new Error('simulated kill failure');
      }),
      runNodeScript,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      stage: 'shutdown',
      reason: 'kill_failed',
    }));
    expect(runNodeScript).toHaveBeenCalledTimes(1);
    expect(runNodeScript.mock.calls[0][0]).toEqual(expect.stringContaining('hm-anomaly.js'));
    expect(runNodeScript.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'type=restart_execute_failure',
      'src=hm-restart-execute',
      'sev=high',
      '--json',
    ]));
    expect(runNodeScript.mock.calls[0][1].some((arg) => String(arg).includes('simulated kill failure'))).toBe(true);
  });

  test('logs an anomaly when Windows launcher spawn throws EINVAL', async () => {
    writeRegistry(tempRoot);
    appendJsonLine(path.join(tempRoot, '.squidrun', 'coord', 'architect-inbox.jsonl'), {
      type: 'restart_preflight',
      instance: 'james-main',
      status: 'green',
      timestampUtc: '2026-04-27T00:04:30.000Z',
    });
    const runNodeScript = jest.fn(() => ({ status: 0 }));
    const spawnError = new Error('spawn EINVAL');
    spawnError.code = 'EINVAL';

    const result = await restartExecute.executeRestart({
      projectRoot: tempRoot,
      instance: 'james-main',
      reason: 'spawn failure test',
      checkDependencyIntegrity: jest.fn(() => ({ ok: true, reason: null })),
      runRestartLaunchProbe: jest.fn(greenRestartLaunchProbe),
      nowMs: Date.parse('2026-04-27T00:05:00.000Z'),
      launchStartedMs: Date.parse('2026-04-27T00:05:00.000Z'),
      captureAppStatus: jest.fn(() => ({
        exists: true,
        timestampMs: Date.parse('2026-04-27T00:00:00.000Z'),
        session: '301',
        pid: null,
        mtimeMs: 1,
      })),
      listElectronProcesses: jest.fn(() => [{ pid: 111, name: 'electron.exe' }]),
      processExists: jest.fn(() => false),
      killProcess: jest.fn(),
      spawn: jest.fn(() => {
        throw spawnError;
      }),
      runNodeScript,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      stage: 'relaunch',
      reason: 'relaunch_failed',
      error: 'spawn EINVAL',
    }));
    expect(runNodeScript).toHaveBeenCalledTimes(1);
    expect(runNodeScript.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'type=restart_execute_failure',
      'src=hm-restart-execute',
      'sev=high',
      '--json',
    ]));
  });

  test('refuses to relaunch and logs no_target_found when shutdown finds no Electron process', async () => {
    writeRegistry(tempRoot);
    appendJsonLine(path.join(tempRoot, '.squidrun', 'coord', 'architect-inbox.jsonl'), {
      type: 'restart_preflight',
      instance: 'james-main',
      status: 'green',
      timestampUtc: '2026-04-27T00:04:30.000Z',
    });
    const runNodeScript = jest.fn(() => ({ status: 0 }));
    const spawn = jest.fn();

    const result = await restartExecute.executeRestart({
      projectRoot: tempRoot,
      instance: 'james-main',
      reason: 'no target test',
      checkDependencyIntegrity: jest.fn(() => ({ ok: true, reason: null })),
      runRestartLaunchProbe: jest.fn(greenRestartLaunchProbe),
      nowMs: Date.parse('2026-04-27T00:05:00.000Z'),
      captureAppStatus: jest.fn(() => ({
        exists: true,
        timestampMs: Date.parse('2026-04-27T00:00:00.000Z'),
        session: '301',
        pid: null,
        mtimeMs: 1,
      })),
      listElectronProcesses: jest.fn(() => []),
      spawn,
      runNodeScript,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      stage: 'shutdown',
      reason: 'no_target_found',
    }));
    expect(spawn).not.toHaveBeenCalled();
    expect(runNodeScript).toHaveBeenCalledTimes(1);
    expect(runNodeScript.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'type=restart_execute_no_target_found',
      'src=hm-restart-execute',
      'sev=high',
      '--json',
    ]));
  });

  test('logs orphan_descendants when a pre-shutdown child process survives', async () => {
    writeRegistry(tempRoot);
    appendJsonLine(path.join(tempRoot, '.squidrun', 'coord', 'architect-inbox.jsonl'), {
      type: 'restart_preflight',
      instance: 'james-main',
      status: 'green',
      timestampUtc: '2026-04-27T00:04:30.000Z',
    });
    const runNodeScript = jest.fn(() => ({ status: 0 }));
    let clockMs = Date.parse('2026-04-27T00:05:00.000Z');

    const result = await restartExecute.executeRestart({
      projectRoot: tempRoot,
      instance: 'james-main',
      reason: 'orphan descendant test',
      checkDependencyIntegrity: jest.fn(() => ({ ok: true, reason: null })),
      runRestartLaunchProbe: jest.fn(greenRestartLaunchProbe),
      nowMs: Date.parse('2026-04-27T00:05:00.000Z'),
      captureAppStatus: jest.fn(() => ({
        exists: true,
        timestampMs: Date.parse('2026-04-27T00:00:00.000Z'),
        session: '301',
        pid: null,
        mtimeMs: 1,
      })),
      processRows: [
        {
          ProcessId: 111,
          ParentProcessId: 99,
          Name: 'electron.exe',
          ExecutablePath: path.join(tempRoot, 'ui', 'node_modules', 'electron', 'dist', 'electron.exe'),
          CommandLine: `"${path.join(tempRoot, 'ui', 'node_modules', 'electron', 'dist', 'electron.exe')}" .`,
        },
        {
          ProcessId: 203,
          ParentProcessId: 111,
          Name: 'electron.exe',
          ExecutablePath: path.join(tempRoot, 'ui', 'node_modules', 'electron', 'dist', 'electron.exe'),
          CommandLine: `"${path.join(tempRoot, 'ui', 'node_modules', 'electron', 'dist', 'electron.exe')}" --type=renderer --app-path="${path.join(tempRoot, 'ui')}"`,
        },
      ],
      killProcess: jest.fn(),
      processExists: jest.fn((pid) => pid === 203),
      sleep: jest.fn(() => Promise.resolve()),
      now: jest.fn(() => {
        clockMs += 300;
        return clockMs;
      }),
      shutdownTimeoutMs: 1000,
      runNodeScript,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      stage: 'shutdown',
      reason: 'orphan_descendants',
    }));
    expect(result.shutdown.orphanDescendants).toEqual([
      expect.objectContaining({
        pid: 203,
        role: 'descendant',
      }),
    ]);
    expect(runNodeScript).toHaveBeenCalledTimes(1);
    expect(runNodeScript.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'type=restart_execute_orphan_descendants',
      'src=hm-restart-execute',
      'sev=high',
      '--json',
    ]));
  });

  test('opt-in executeRestart orphan sweep runs after verified relaunch', async () => {
    writeRegistry(tempRoot);
    appendJsonLine(path.join(tempRoot, '.squidrun', 'coord', 'architect-inbox.jsonl'), {
      type: 'audit_grade',
      instance: 'james-main',
      grade: 'green',
      timestampUtc: '2026-04-27T00:04:30.000Z',
    });
    const killed = [];
    const launchStartedMs = Date.parse('2026-04-27T00:05:00.000Z');
    const captureAppStatus = jest.fn()
      .mockReturnValueOnce({
        exists: true,
        timestampMs: Date.parse('2026-04-27T00:00:00.000Z'),
        session: '301',
        pid: null,
        mtimeMs: 1,
      })
      .mockReturnValueOnce({
        exists: true,
        timestampMs: Date.parse('2026-04-27T00:05:02.000Z'),
        session: '302',
        pid: null,
        mtimeMs: 2,
      });

    const result = await restartExecute.executeRestart({
      projectRoot: tempRoot,
      instance: 'james-main',
      reason: 'sweep test',
      checkDependencyIntegrity: jest.fn(() => ({ ok: true, reason: null })),
      runRestartLaunchProbe: jest.fn(greenRestartLaunchProbe),
      nowMs: launchStartedMs,
      launchStartedMs,
      now: jest.fn(() => launchStartedMs),
      captureAppStatus,
      listElectronProcesses: jest.fn(() => [{ pid: 111, name: 'electron.exe' }]),
      processExists: jest.fn(() => false),
      killProcess: (pid, proc) => killed.push({ pid, role: proc.role }),
      spawn: jest.fn(() => ({ pid: 222, unref: jest.fn() })),
      sweepOrphans: true,
      orphanSweepProcessRows: orphanSweepRows(tempRoot),
      runNodeScript: jest.fn(),
    });

    expect(result.ok).toBe(true);
    expect(result.orphanSweep).toEqual(expect.objectContaining({ ok: true }));
    expect(killed).toEqual(expect.arrayContaining([
      { pid: 111, role: 'target' },
      { pid: 44480, role: 'orphan' },
      { pid: 38852, role: 'orphan' },
    ]));
    const steps = readJsonLines(path.join(tempRoot, '.squidrun', 'coord', 'restart-execute-log.jsonl'))
      .map((entry) => entry.step);
    expect(steps).toContain('orphan_sweep_complete');
  });

  test('logs relaunch_unverified when app-status does not refresh after launcher success', async () => {
    writeRegistry(tempRoot);
    appendJsonLine(path.join(tempRoot, '.squidrun', 'coord', 'architect-inbox.jsonl'), {
      type: 'audit_grade',
      instance: 'james-main',
      grade: 'green',
      timestampUtc: '2026-04-27T00:04:30.000Z',
    });
    const runNodeScript = jest.fn(() => ({ status: 0 }));
    const staleSnapshot = {
      exists: true,
      timestampMs: Date.parse('2026-04-27T00:00:00.000Z'),
      session: '301',
      pid: null,
      mtimeMs: 1,
    };
    let clockMs = Date.parse('2026-04-27T00:05:00.000Z');

    const result = await restartExecute.executeRestart({
      projectRoot: tempRoot,
      instance: 'james-main',
      reason: 'unverified relaunch test',
      checkDependencyIntegrity: jest.fn(() => ({ ok: true, reason: null })),
      runRestartLaunchProbe: jest.fn(greenRestartLaunchProbe),
      nowMs: Date.parse('2026-04-27T00:05:00.000Z'),
      launchStartedMs: Date.parse('2026-04-27T00:05:00.000Z'),
      captureAppStatus: jest.fn(() => staleSnapshot),
      listElectronProcesses: jest.fn(() => [{ pid: 111, name: 'electron.exe' }]),
      processExists: jest.fn(() => false),
      killProcess: jest.fn(),
      spawn: jest.fn(() => ({ pid: 222, unref: jest.fn() })),
      sleep: jest.fn(() => Promise.resolve()),
      now: jest.fn(() => {
        clockMs += 300;
        return clockMs;
      }),
      relaunchVerifyTimeoutMs: 1000,
      relaunchVerifyPollMs: 25,
      runNodeScript,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      stage: 'relaunch_verification',
      reason: 'relaunch_unverified',
    }));
    expect(runNodeScript).toHaveBeenCalledTimes(1);
    expect(runNodeScript.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'type=restart_execute_relaunch_unverified',
      'src=hm-restart-execute',
      'sev=high',
      '--json',
    ]));
  });
});
