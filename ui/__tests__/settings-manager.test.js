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
  WORKSPACE_PATH: 'D:\\projects\\hivemind\\workspace',
}));

const { spawnSync } = require('child_process');
const SettingsManager = require('../modules/main/settings-manager');

function mockCliAvailability(availability) {
  spawnSync.mockImplementation((cmd, args, options = {}) => {
    const target = Array.isArray(args) && args[0];
    const locatorCall = target && (cmd === 'where.exe' || cmd === 'which');

    if (locatorCall) {
      if (availability[target]) {
        return { status: 0, stdout: `C:\\mock\\${target}.exe\n`, stderr: '' };
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
      '5': 'gemini --yolo --include-directories "C:\\custom\\workspace"',
    };

    const result = manager.autoDetectPaneCommandsOnStartup();

    expect(result.changed).toBe(false);
    expect(manager.saveSettings).not.toHaveBeenCalled();
    expect(ctx.currentSettings.paneCommands).toEqual({
      '1': 'codex --yolo',
      '2': 'claude',
      '5': 'gemini --yolo --include-directories "C:\\custom\\workspace"',
    });
  });

  test('rewrites only missing/blank/unavailable paneCommands using preference matrix', () => {
    mockCliAvailability({ claude: true, codex: true, gemini: false });
    ctx.currentSettings.paneCommands = {
      '1': '   ',
      '2': 'codex --yolo',
      '5': 'gemini --yolo --include-directories "D:\\projects\\hivemind\\workspace"',
    };

    const result = manager.autoDetectPaneCommandsOnStartup();

    expect(result.changed).toBe(true);
    expect(result.updatedPanes.sort()).toEqual(['1', '5']);
    expect(ctx.currentSettings.paneCommands).toEqual({
      '1': 'claude',
      '2': 'codex --yolo',
      '5': 'codex',
    });
    expect(manager.saveSettings).toHaveBeenCalledWith({
      paneCommands: {
        '1': 'claude',
        '2': 'codex --yolo',
        '5': 'codex',
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
});

