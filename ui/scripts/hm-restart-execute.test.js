'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const restartExecute = require('./hm-restart-execute');

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

describe('hm-restart-execute', () => {
  let tempRoot;

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

  test('discovers the parent Electron process from tasklist output', () => {
    const tasklistOutput = [
      '"Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"',
      '"electron.exe","29364","Console","1","150,000 K","Running","JAMES\\James","0:01:00","SquidRun"',
      '"powershell.exe","41000","Console","1","80,000 K","Running","JAMES\\James","0:00:05","Terminal"',
    ].join('\r\n');

    const processes = restartExecute.listElectronProcesses('D:\\projects\\squidrun', {
      tasklistOutput,
    });

    expect(processes).toEqual([
      expect.objectContaining({
        pid: 29364,
        name: 'electron.exe',
        windowTitle: 'SquidRun',
        matchReason: 'direct_project_match',
      }),
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
        CommandLine: '"D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe" "D:\\projects\\squidrun\\ui" --profile=eunbyeol --window=eunbyeol --standalone-window',
      },
    ]);

    expect(processes).toEqual([
      expect.objectContaining({
        pid: 29364,
        matchReason: 'direct_project_match',
      }),
    ]);
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
    const steps = readJsonLines(path.join(tempRoot, '.squidrun', 'coord', 'restart-execute-log.jsonl'))
      .map((entry) => entry.step);
    expect(steps).toEqual([
      'preflight_check',
      'shutdown_start',
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
