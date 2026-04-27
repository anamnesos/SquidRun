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

    const result = await restartExecute.executeRestart({
      projectRoot: tempRoot,
      instance: 'james-main',
      reason: 'green preflight test',
      nowMs: Date.parse('2026-04-27T00:05:00.000Z'),
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
      windowsHide: true,
      stdio: 'ignore',
    }));
    expect(unref).toHaveBeenCalled();
    expect(result.relaunch.pid).toBe(222);
    const steps = readJsonLines(path.join(tempRoot, '.squidrun', 'coord', 'restart-execute-log.jsonl'))
      .map((entry) => entry.step);
    expect(steps).toEqual(['preflight_check', 'shutdown_start', 'shutdown_complete', 'relaunch_complete']);
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
});
