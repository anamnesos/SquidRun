/**
 * Tests for modules/main/settings-manager.js
 * Covers startup CLI auto-detection and paneCommands rewrite policy.
 */

jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(() => ''),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
}));

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../config', () => ({
  WORKSPACE_PATH: 'workspace',
  resolvePaneCwd: () => '<project-root>',
  resolveGlobalPath: (relPath, opts) => {
    const p = require('path');
    return p.join('<global-state-root>', relPath);
  },
  resolveCoordPath: (relPath, opts) => {
    const p = require('path');
    return p.join('<project-root>\\.hivemind', relPath);
  },
}));

const { spawnSync } = require('child_process');
const fs = require('fs');
const SettingsManager = require('../modules/main/settings-manager');

function mockCliAvailability(availability) {
  spawnSync.mockImplementation((cmd, args, options = {}) => {
    const target = Array.isArray(args) && args[0];
    const locatorCall = target && (cmd === 'where.exe' || cmd === 'which');

    if (locatorCall) {
      if (availability[target]) {
        return { status: 0, stdout: `<cli-bin>/${target}\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    }

    if (Array.isArray(args) && args[0] === '--version') {
      const cli = String(cmd);
      if (availability[cli]) {
        return { status: 0, stdout: '1.0.0', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    }

    return { status: 1, stdout: '', stderr: '' };
  });
}

describe('SettingsManager CLI auto-detection', () => {
  let ctx;
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = {};
    manager = new SettingsManager(ctx);
    jest.spyOn(manager, 'saveSettings').mockImplementation((partial) => {
      Object.assign(ctx.currentSettings, partial);
      return ctx.currentSettings;
    });
  });

  test('does not clobber valid manual paneCommands when referenced CLIs are available', () => {
    mockCliAvailability({ claude: true, codex: true, gemini: true });
    ctx.currentSettings.paneCommands = {
      '1': 'codex --yolo',
      '2': 'claude',
      '5': 'gemini --yolo --include-directories "<custom-workspace>"',
    };

    const result = manager.autoDetectPaneCommandsOnStartup();

    expect(result.changed).toBe(false);
    expect(manager.saveSettings).not.toHaveBeenCalled();
    expect(ctx.currentSettings.paneCommands).toEqual({
      '1': 'codex --yolo',
      '2': 'claude',
      '5': 'gemini --yolo --include-directories "<custom-workspace>"',
    });
  });

  test('rewrites only missing/blank paneCommands, preserves user choices even if CLI unavailable', () => {
    mockCliAvailability({ claude: true, codex: true, gemini: false });
    ctx.currentSettings.paneCommands = {
      '1': '   ',
      '2': 'codex --yolo',
      '5': 'gemini --yolo --include-directories "<project-root>"',
    };

    const result = manager.autoDetectPaneCommandsOnStartup();

    expect(result.changed).toBe(true);
    // Only pane 1 (blank) gets rewritten — pane 5 (gemini, user-chosen) is preserved
    expect(result.updatedPanes).toEqual(['1']);
    expect(ctx.currentSettings.paneCommands).toEqual({
      '1': 'claude',
      '2': 'codex --yolo',
      '5': 'gemini --yolo --include-directories "<project-root>"',
    });
    expect(manager.saveSettings).toHaveBeenCalledWith({
      paneCommands: {
        '1': 'claude',
        '2': 'codex --yolo',
        '5': 'gemini --yolo --include-directories "<project-root>"',
      },
    });
  });

  test('uses short spawnSync timeouts and Windows locator on Windows', () => {
    mockCliAvailability({ claude: true, codex: false, gemini: false });

    manager.autoDetectPaneCommandsOnStartup();

    const allCalls = spawnSync.mock.calls;
    const locatorCalls = allCalls.filter(([cmd, args]) => Array.isArray(args) && args.length === 1 && (cmd === 'where.exe' || cmd === 'which'));
    const versionCalls = allCalls.filter(([, args]) => Array.isArray(args) && args[0] === '--version');

    if (process.platform === 'win32') {
      expect(locatorCalls.every(([cmd]) => cmd === 'where.exe')).toBe(true);
    }

    expect(locatorCalls.length).toBeGreaterThanOrEqual(3);
    expect(versionCalls.length).toBeGreaterThanOrEqual(1);
    expect(locatorCalls.every(([, , opts]) => opts && opts.timeout > 0 && opts.timeout <= 3000)).toBe(true);
    expect(versionCalls.every(([, , opts]) => opts && opts.timeout > 0 && opts.timeout <= 3000)).toBe(true);
  });

  test('writeAppStatus includes explicit mode field', () => {
    ctx.currentSettings = { dryRun: false, sdkMode: false, autoSpawn: true };
    manager.writeAppStatus();

    const statusWriteCall = fs.writeFileSync.mock.calls.find((call) => String(call[0]).endsWith('app-status.json.tmp'));
    expect(statusWriteCall).toBeDefined();
    const serialized = statusWriteCall[1];
    const status = JSON.parse(serialized);
    expect(status.mode).toBe('pty');
    expect(status.dryRun).toBe(false);
    expect(status.autoSpawn).toBe(true);

    ctx.currentSettings = { dryRun: true, sdkMode: false, autoSpawn: false };
    manager.writeAppStatus();
    const statusWriteCallDryRun = fs.writeFileSync.mock.calls
      .filter((call) => String(call[0]).endsWith('app-status.json.tmp'))
      .pop();
    const statusDryRun = JSON.parse(statusWriteCallDryRun[1]);
    expect(statusDryRun.mode).toBe('dry-run');

    ctx.currentSettings = { dryRun: false, sdkMode: true, autoSpawn: false };
    manager.writeAppStatus();
    const statusWriteCallSdk = fs.writeFileSync.mock.calls
      .filter((call) => String(call[0]).endsWith('app-status.json.tmp'))
      .pop();
    const statusSdk = JSON.parse(statusWriteCallSdk[1]);
    expect(statusSdk.mode).toBe('sdk');
  });

  test('writeAppStatus preserves existing session on non-daemon restarts', () => {
    fs.existsSync.mockImplementation((targetPath) => String(targetPath).endsWith('app-status.json'));
    fs.readFileSync.mockImplementation((targetPath) => {
      if (String(targetPath).endsWith('app-status.json')) {
        return JSON.stringify({
          started: '2026-02-15T00:00:00.000Z',
          session: 146,
          mode: 'pty',
        });
      }
      return '';
    });

    ctx.currentSettings = { dryRun: false, sdkMode: false, autoSpawn: true };
    manager.writeAppStatus();

    const statusWriteCall = fs.writeFileSync.mock.calls
      .filter((call) => String(call[0]).endsWith('app-status.json.tmp'))
      .pop();
    const status = JSON.parse(statusWriteCall[1]);

    expect(status.session).toBe(146);
    expect(status.started).toBe('2026-02-15T00:00:00.000Z');
  });

  test('writeAppStatus increments session only when daemon start is requested', () => {
    fs.existsSync.mockImplementation((targetPath) => String(targetPath).endsWith('app-status.json'));
    fs.readFileSync.mockImplementation((targetPath) => {
      if (String(targetPath).endsWith('app-status.json')) {
        return JSON.stringify({
          started: '2026-02-15T00:00:00.000Z',
          session: 146,
          mode: 'pty',
        });
      }
      return '';
    });

    ctx.currentSettings = { dryRun: false, sdkMode: false, autoSpawn: true };
    manager.writeAppStatus({ incrementSession: true });

    const statusWriteCall = fs.writeFileSync.mock.calls
      .filter((call) => String(call[0]).endsWith('app-status.json.tmp'))
      .pop();
    const status = JSON.parse(statusWriteCall[1]);

    expect(status.session).toBe(147);
    expect(status.started).not.toBe('2026-02-15T00:00:00.000Z');
  });

  test('writeAppStatus merges statusPatch fields into app status payload', () => {
    ctx.currentSettings = { dryRun: false, sdkMode: false, autoSpawn: true };
    manager.writeAppStatus({
      statusPatch: {
        paneHost: {
          degraded: true,
          missingPanes: ['2'],
          lastErrorReason: 'inject_hidden_window_unavailable',
        },
      },
    });

    const statusWriteCall = fs.writeFileSync.mock.calls
      .filter((call) => String(call[0]).endsWith('app-status.json.tmp'))
      .pop();
    const status = JSON.parse(statusWriteCall[1]);
    expect(status.paneHost).toEqual(
      expect.objectContaining({
        degraded: true,
        missingPanes: ['2'],
        lastErrorReason: 'inject_hidden_window_unavailable',
      })
    );
  });
});
