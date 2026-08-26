'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  RESTART_LAUNCH_PROBE_RESULT_ENV,
  RESTART_LAUNCH_PROBE_SCHEMA,
  inspectRestartLaunchProbeWindow,
  resolveRestartLaunchProbeResultPath,
  validateRestartLaunchProbeRenderer,
  writeRestartLaunchProbeResult,
} = require('../modules/main/restart-launch-probe');
const {
  cleanupOwnedProbeRoot,
  main,
  runRestartLaunchProbe,
  waitForProbeProcessesToExit,
} = require('../scripts/hm-restart-launch-probe');

function validRendererSnapshot() {
  return {
    readyState: 'complete',
    title: 'SquidRun',
    hasBody: true,
    terminalCount: 3,
    preloadBridgeReady: true,
    rendererModulesReady: true,
    rendererModulesLoadError: null,
    rendererScriptReady: true,
  };
}

describe('restart launch probe', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-restart-launch-probe-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('--help returns without preparing or launching a probe', async () => {
    const output = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(main(['--help'])).resolves.toEqual({ ok: true, help: true });
    expect(output).toHaveBeenCalledWith(expect.stringContaining('without launching Electron'));
  });

  test('writes results only inside the isolated runtime root', () => {
    const dataRoot = path.join(tempDir, 'data');
    const resultPath = path.join(dataRoot, '.squidrun', 'runtime', 'result.json');
    const env = {
      SQUIDRUN_RESTART_LAUNCH_PROBE: '1',
      SQUIDRUN_DATA_ROOT: dataRoot,
      SQUIDRUN_PROFILE: 'restart-preflight',
      [RESTART_LAUNCH_PROBE_RESULT_ENV]: resultPath,
    };

    expect(resolveRestartLaunchProbeResultPath(env)).toBe(resultPath);
    const result = writeRestartLaunchProbeResult({ ok: true, stage: 'renderer_ready' }, {
      env,
      nowMs: Date.parse('2026-08-23T10:00:00.000Z'),
    });
    expect(result).toEqual(expect.objectContaining({
      schema: RESTART_LAUNCH_PROBE_SCHEMA,
      ok: true,
      stage: 'renderer_ready',
      profile: 'restart-preflight',
    }));
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toEqual(result);

    expect(() => resolveRestartLaunchProbeResultPath({
      ...env,
      [RESTART_LAUNCH_PROBE_RESULT_ENV]: path.join(tempDir, 'outside.json'),
    })).toThrow('restart_launch_probe_result_path_outside_isolated_root');
  });

  test('requires the real shell, preload bridge, renderer modules, and renderer script marker', () => {
    expect(validateRestartLaunchProbeRenderer(validRendererSnapshot())).toEqual({
      ok: true,
      reason: null,
      failures: [],
    });
    expect(validateRestartLaunchProbeRenderer({
      ...validRendererSnapshot(),
      terminalCount: 2,
      rendererModulesLoadError: 'module missing',
      rendererScriptReady: false,
    })).toEqual(expect.objectContaining({
      ok: false,
      failures: expect.arrayContaining([
        'terminal_shell_incomplete',
        'renderer_modules_load_error',
        'renderer_script_marker_missing',
      ]),
    }));
  });

  test('inspects a loaded hidden window and rejects preload failures', async () => {
    const webContents = new EventEmitter();
    webContents.executeJavaScript = jest.fn().mockResolvedValue(validRendererSnapshot());
    const windowRef = new EventEmitter();
    windowRef.webContents = webContents;
    windowRef.isVisible = jest.fn(() => false);
    windowRef.isFocused = jest.fn(() => false);

    await expect(inspectRestartLaunchProbeWindow(windowRef, Promise.resolve())).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        stage: 'renderer_ready',
        visible: false,
        focused: false,
      })
    );

    const failedWebContents = new EventEmitter();
    failedWebContents.executeJavaScript = jest.fn(() => new Promise(() => {}));
    const failedWindow = new EventEmitter();
    failedWindow.webContents = failedWebContents;
    failedWindow.isVisible = jest.fn(() => false);
    failedWindow.isFocused = jest.fn(() => false);
    const pending = inspectRestartLaunchProbeWindow(failedWindow, new Promise(() => {}));
    failedWebContents.emit('preload-error', {}, 'preload.js', new Error('sharp missing'));
    await expect(pending).rejects.toMatchObject({ code: 'restart_launch_probe_preload_error' });
  });

  test('runs the exact Electron path in an isolated root and removes only its own green root', async () => {
    const projectRoot = path.join(tempDir, 'project');
    const electronPath = path.join(projectRoot, 'ui', 'node_modules', 'electron', 'dist', 'electron.exe');
    fs.mkdirSync(path.dirname(electronPath), { recursive: true });
    fs.writeFileSync(electronPath, 'fixture');
    let observedRoot = null;
    const runElectronProcess = jest.fn(async (_command, args, options) => {
      observedRoot = options.env.SQUIDRUN_DATA_ROOT;
      const resultPath = options.env[RESTART_LAUNCH_PROBE_RESULT_ENV];
      fs.writeFileSync(resultPath, `${JSON.stringify({
        schema: RESTART_LAUNCH_PROBE_SCHEMA,
        ok: true,
        stage: 'renderer_ready',
        profile: 'restart-preflight',
        dataRoot: observedRoot,
        renderer: {
          ok: true,
          stage: 'renderer_ready',
          snapshot: validRendererSnapshot(),
          visible: false,
          focused: false,
          processIds: [111, 112],
        },
      })}\n`);
      expect(args).toEqual([
        path.join(projectRoot, 'ui'),
        '--profile=restart-preflight',
        '--window=main',
      ]);
      expect(options.env.SQUIDRUN_BRIDGE_RELAY_MODE).toBe('off');
      expect(options.env.TELEGRAM_BOT_TOKEN).toBe('');
      return { ok: true, exitCode: 0, pid: 111 };
    });

    const result = await runRestartLaunchProbe(projectRoot, {
      tempDir,
      runElectronProcess,
      isProcessAlive: () => false,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      electronPath,
      cleanup: expect.objectContaining({ ok: true, removed: true }),
    }));
    expect(runElectronProcess).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(observedRoot)).toBe(false);
  });

  test('requires every reported probe process to be gone before green cleanup', async () => {
    const alive = new Set([111, 112]);
    const sleep = jest.fn(async () => {
      alive.clear();
    });

    await expect(waitForProbeProcessesToExit([111, 111, 112], {
      isProcessAlive: (pid) => alive.has(pid),
      processExitTimeoutMs: 100,
      sleep,
    })).resolves.toEqual({
      ok: true,
      checked: [111, 112],
      remaining: [],
    });
    expect(sleep).toHaveBeenCalledTimes(1);

    await expect(waitForProbeProcessesToExit([222], {
      isProcessAlive: () => true,
      processExitTimeoutMs: 0,
    })).resolves.toEqual({
      ok: false,
      checked: [222],
      remaining: [222],
    });
  });

  test('preserves a red probe root for evidence and refuses unowned cleanup targets', async () => {
    const projectRoot = path.join(tempDir, 'project');
    const electronPath = path.join(projectRoot, 'ui', 'node_modules', 'electron', 'dist', 'electron.exe');
    fs.mkdirSync(path.dirname(electronPath), { recursive: true });
    fs.writeFileSync(electronPath, 'fixture');

    const result = await runRestartLaunchProbe(projectRoot, {
      tempDir,
      runElectronProcess: jest.fn(async () => ({
        ok: false,
        reason: 'process_failed',
        exitCode: 1,
        stderr: 'missing sharp',
      })),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'restart_launch_probe_process_failed',
    }));
    expect(fs.existsSync(result.probeRoot)).toBe(true);
    expect(cleanupOwnedProbeRoot(projectRoot, { tempDir })).toEqual(expect.objectContaining({
      ok: false,
      reason: 'probe_root_not_owned',
    }));
  });
});
