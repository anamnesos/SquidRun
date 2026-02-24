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
  resolveCoordPath: (relPath, opts) => {
    const p = require('path');
    return p.join('<project-root>\\.squidrun', relPath);
  },
}));

jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn((name) => {
      if (name === 'userData') return '/tmp/squidrun-userdata';
      return '/tmp';
    }),
  },
}));

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const log = require('../modules/logger');
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
      '3': 'gemini --yolo --include-directories "<custom-workspace>"',
    };

    const result = manager.autoDetectPaneCommandsOnStartup();

    expect(result.changed).toBe(false);
    expect(manager.saveSettings).not.toHaveBeenCalled();
    expect(ctx.currentSettings.paneCommands).toEqual({
      '1': 'codex --yolo',
      '2': 'claude',
      '3': 'gemini --yolo --include-directories "<custom-workspace>"',
    });
  });

  test('rewrites only missing/blank paneCommands, preserves user choices even if CLI unavailable', () => {
    mockCliAvailability({ claude: true, codex: true, gemini: false });
    ctx.currentSettings.paneCommands = {
      '1': '   ',
      '2': 'codex --yolo',
      '3': 'gemini --yolo --include-directories "<project-root>"',
    };

    const result = manager.autoDetectPaneCommandsOnStartup();

    expect(result.changed).toBe(true);
    // Only pane 1 (blank) gets rewritten — Pane 3 (gemini, user-chosen) is preserved
    expect(result.updatedPanes).toEqual(['1']);
    expect(ctx.currentSettings.paneCommands).toEqual({
      '1': 'claude --permission-mode acceptEdits',
      '2': 'codex --yolo',
      '3': 'gemini --yolo --include-directories "<project-root>"',
    });
    expect(manager.saveSettings).toHaveBeenCalledWith({
      paneCommands: {
        '1': 'claude --permission-mode acceptEdits',
        '2': 'codex --yolo',
        '3': 'gemini --yolo --include-directories "<project-root>"',
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
    expect(String(statusWriteCall[0])).toContain('.squidrun');
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

  test('writeAppStatus accepts legacy snake_case session_number field', () => {
    fs.existsSync.mockImplementation((targetPath) => String(targetPath).endsWith('app-status.json'));
    fs.readFileSync.mockImplementation((targetPath) => {
      if (String(targetPath).endsWith('app-status.json')) {
        return JSON.stringify({
          started: '2026-02-15T00:00:00.000Z',
          session_number: 212,
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

    expect(status.session).toBe(212);
    expect(status.session_number).toBeUndefined();
    expect(status.sessionNumber).toBeUndefined();
    expect(status.currentSession).toBeUndefined();
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

  test('writeAppStatus honors sessionFloor when incrementing startup session', () => {
    fs.existsSync.mockImplementation((targetPath) => String(targetPath).endsWith('app-status.json'));
    fs.readFileSync.mockImplementation((targetPath) => {
      if (String(targetPath).endsWith('app-status.json')) {
        return JSON.stringify({
          started: '2026-02-15T00:00:00.000Z',
          session: 2,
          mode: 'pty',
        });
      }
      return '';
    });

    ctx.currentSettings = { dryRun: false, sdkMode: false, autoSpawn: true };
    manager.writeAppStatus({ incrementSession: true, sessionFloor: 170 });

    const statusWriteCall = fs.writeFileSync.mock.calls
      .filter((call) => String(call[0]).endsWith('app-status.json.tmp'))
      .pop();
    const status = JSON.parse(statusWriteCall[1]);

    expect(status.session).toBe(171);
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

describe('SettingsManager packaged persistence defaults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    app.isPackaged = false;
    app.getPath.mockImplementation((name) => {
      if (name === 'userData') return '/tmp/squidrun-userdata';
      if (name === 'appData') return '/tmp';
      if (name === 'home') return '/tmp';
      return '/tmp';
    });
  });

  test('uses userData settings path and project operating mode for packaged builds', () => {
    app.isPackaged = true;
    const ctx = {};
    const manager = new SettingsManager(ctx);

    expect(app.getPath).toHaveBeenCalledWith('userData');
    expect(manager.settingsPath).toBe(path.join('/tmp/squidrun-userdata', 'settings.json'));
    expect(ctx.currentSettings.operatingMode).toBe('project');
  });

  test('bootstraps packaged settings file on first launch with project mode defaults', () => {
    app.isPackaged = true;
    fs.existsSync.mockReturnValue(false);

    const ctx = {};
    const manager = new SettingsManager(ctx);
    manager.loadSettings();

    const settingsWrite = fs.writeFileSync.mock.calls.find((call) => String(call[0]).endsWith('settings.json.tmp'));
    expect(settingsWrite).toBeDefined();
    expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(manager.settingsPath), { recursive: true });
    expect(fs.renameSync).toHaveBeenCalledWith(`${manager.settingsPath}.tmp`, manager.settingsPath);

    const persisted = JSON.parse(settingsWrite[1]);
    expect(persisted.operatingMode).toBe('project');
  });

  test('saveSettings logs detailed diagnostics when packaged write fails', () => {
    app.isPackaged = true;
    fs.writeFileSync.mockImplementationOnce(() => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    });

    const ctx = {};
    const manager = new SettingsManager(ctx);
    manager.saveSettings({ operatingMode: 'project' });

    expect(log.error).toHaveBeenCalledWith(
      'Settings',
      'Error saving settings',
      expect.objectContaining({
        error: 'permission denied',
        code: 'EACCES',
        isPackaged: true,
        settingsPath: path.join('/tmp/squidrun-userdata', 'settings.json'),
        userDataPath: '/tmp/squidrun-userdata',
      })
    );
  });
});

describe('SettingsManager SMTP credential persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('obfuscates smtpPass at rest while keeping plaintext in memory', () => {
    const ctx = {};
    const manager = new SettingsManager(ctx);

    manager.saveSettings({ smtpPass: 'super-secret' });

    const settingsWrite = fs.writeFileSync.mock.calls.find((call) => String(call[0]).endsWith('settings.json.tmp'));
    expect(settingsWrite).toBeDefined();
    const persisted = JSON.parse(settingsWrite[1]);
    expect(persisted.smtpPass).toMatch(/^obf:v1:/);
    expect(persisted.smtpPass).not.toBe('super-secret');
    expect(ctx.currentSettings.smtpPass).toBe('super-secret');
  });

  test('decodes obfuscated smtpPass on load and keeps TLS verify enabled by default', () => {
    const firstCtx = {};
    const firstManager = new SettingsManager(firstCtx);
    firstManager.saveSettings({ smtpPass: 'mail-pass-123' });
    const firstWrite = fs.writeFileSync.mock.calls.find((call) => String(call[0]).endsWith('settings.json.tmp'));
    const encodedPass = JSON.parse(firstWrite[1]).smtpPass;

    jest.clearAllMocks();
    fs.existsSync.mockImplementation((targetPath) => String(targetPath).endsWith('settings.json'));
    fs.readFileSync.mockImplementation((targetPath) => {
      if (String(targetPath).endsWith('settings.json')) {
        return JSON.stringify({ smtpPass: encodedPass });
      }
      return '';
    });

    const secondCtx = {};
    const secondManager = new SettingsManager(secondCtx);
    const loaded = secondManager.loadSettings();

    expect(loaded.smtpPass).toBe('mail-pass-123');
    expect(loaded.smtpRejectUnauthorized).toBe(true);
  });
});
