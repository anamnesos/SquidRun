/**
 * Settings IPC Handler Tests
 * Target: Full coverage of settings-handlers.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createIpcHarness,
  createDefaultContext,
  createDepsMock,
} = require('./helpers/ipc-harness');

// Mock feature-capabilities
jest.mock('../modules/feature-capabilities', () => ({
  getFeatureCapabilities: jest.fn(() => ({ imageGen: true, voice: false })),
}));

const { getFeatureCapabilities } = require('../modules/feature-capabilities');
const { registerSettingsHandlers } = require('../modules/ipc/settings-handlers');

describe('Settings Handlers', () => {
  let harness;
  let ctx;
  let deps;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    deps = createDepsMock();
    registerSettingsHandlers(ctx, deps);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('get-settings', () => {
    test('returns loaded settings', async () => {
      const mockSettings = { dryRun: true, watcherEnabled: false };
      deps.loadSettings.mockReturnValue(mockSettings);

      const result = await harness.invoke('get-settings');

      expect(deps.loadSettings).toHaveBeenCalled();
      expect(result).toEqual(mockSettings);
    });

    test('returns empty object when no settings', async () => {
      deps.loadSettings.mockReturnValue({});

      const result = await harness.invoke('get-settings');

      expect(result).toEqual({});
    });
  });

  describe('set-setting', () => {
    test('updates setting and saves', async () => {
      deps.loadSettings.mockReturnValue({ existing: true });

      const result = await harness.invoke('set-setting', 'newKey', 'newValue');

      expect(deps.loadSettings).toHaveBeenCalled();
      expect(deps.saveSettings).toHaveBeenCalledWith({ existing: true, newKey: 'newValue' });
      expect(result).toEqual({ existing: true, newKey: 'newValue' });
    });

    test('starts watcher when watcherEnabled set to true', async () => {
      deps.loadSettings.mockReturnValue({});

      await harness.invoke('set-setting', 'watcherEnabled', true);

      expect(ctx.watcher.startWatcher).toHaveBeenCalled();
    });

    test('stops watcher when watcherEnabled set to false', async () => {
      deps.loadSettings.mockReturnValue({});

      await harness.invoke('set-setting', 'watcherEnabled', false);

      expect(ctx.watcher.stopWatcher).toHaveBeenCalled();
    });

    test('does not affect watcher for other settings', async () => {
      deps.loadSettings.mockReturnValue({});

      await harness.invoke('set-setting', 'someOtherKey', true);

      expect(ctx.watcher.startWatcher).not.toHaveBeenCalled();
      expect(ctx.watcher.stopWatcher).not.toHaveBeenCalled();
    });

    test('overwrites existing setting', async () => {
      deps.loadSettings.mockReturnValue({ existing: 'old' });

      const result = await harness.invoke('set-setting', 'existing', 'new');

      expect(deps.saveSettings).toHaveBeenCalledWith({ existing: 'new' });
      expect(result.existing).toBe('new');
    });

    test('runs preflight scan when paneProjects paths change', async () => {
      const previousProject = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-prev-pane-'));
      const nextProject = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-next-pane-'));
      const preflightResults = [{ file: 'CLAUDE.md', hasAgentProtocols: true, conflicts: [] }];
      const firmwareManager = {
        runPreflight: jest.fn(() => preflightResults),
        getAllCachedPreflightResults: jest.fn(() => preflightResults),
        ensureFirmwareFiles: jest.fn(),
      };
      deps.firmwareManager = firmwareManager;
      deps.loadSettings.mockReturnValue({
        operatingMode: 'developer',
        firmwareInjectionEnabled: false,
        paneProjects: { '1': previousProject, '2': null, '5': null },
      });

      await harness.invoke('set-setting', 'paneProjects', {
        '1': nextProject,
        '2': null,
        '5': null,
      });

      expect(firmwareManager.runPreflight).toHaveBeenCalledWith(path.resolve(nextProject), { cache: true });
      expect(ctx.preflightScanResults).toEqual(preflightResults);
      expect(firmwareManager.ensureFirmwareFiles).not.toHaveBeenCalled();
    });

    test('regenerates firmware in project mode when preflight finds conflicts', async () => {
      const previousProject = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-prev-project-'));
      const nextProject = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-next-project-'));
      const conflictResults = [{
        file: 'CLAUDE.md',
        hasAgentProtocols: true,
        conflicts: ['[registry] Agent protocol conflict'],
      }];
      const firmwareManager = {
        runPreflight: jest.fn(() => conflictResults),
        getAllCachedPreflightResults: jest.fn(() => conflictResults),
        ensureFirmwareFiles: jest.fn(),
      };
      deps.firmwareManager = firmwareManager;
      deps.loadSettings.mockReturnValue({
        operatingMode: 'project',
        firmwareInjectionEnabled: true,
        paneProjects: { '1': previousProject, '2': null, '5': null },
      });

      await harness.invoke('set-setting', 'paneProjects', {
        '1': nextProject,
        '2': null,
        '5': null,
      });

      expect(firmwareManager.runPreflight).toHaveBeenCalledWith(path.resolve(nextProject), { cache: true });
      expect(firmwareManager.ensureFirmwareFiles).toHaveBeenCalledWith(conflictResults);
    });
  });

  describe('get-all-settings', () => {
    test('returns all settings', async () => {
      const mockSettings = { a: 1, b: 2, c: 3 };
      deps.loadSettings.mockReturnValue(mockSettings);

      const result = await harness.invoke('get-all-settings');

      expect(deps.loadSettings).toHaveBeenCalled();
      expect(result).toEqual(mockSettings);
    });
  });

  describe('get-feature-capabilities', () => {
    test('returns capabilities from process.env', async () => {
      const result = await harness.invoke('get-feature-capabilities');
      expect(getFeatureCapabilities).toHaveBeenCalledWith(process.env);
      expect(result).toEqual({ imageGen: true, voice: false });
    });
  });

  describe('preflight-scan', () => {
    test('runs manual preflight scan and returns results', async () => {
      const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-manual-preflight-'));
      const scanResults = [{
        file: 'GEMINI.md',
        hasAgentProtocols: true,
        conflicts: ['[protocol] conflicting protocol'],
      }];
      const firmwareManager = {
        runPreflight: jest.fn(() => scanResults),
        getAllCachedPreflightResults: jest.fn(() => scanResults),
        ensureFirmwareFiles: jest.fn(),
      };
      deps.firmwareManager = firmwareManager;
      deps.loadSettings.mockReturnValue({
        operatingMode: 'project',
        firmwareInjectionEnabled: true,
      });

      const result = await harness.invoke('preflight-scan', targetDir);

      expect(result.success).toBe(true);
      expect(result.targetDir).toBe(path.resolve(targetDir));
      expect(result.results).toEqual(scanResults);
      expect(result.hasConflicts).toBe(true);
      expect(firmwareManager.runPreflight).toHaveBeenCalledWith(path.resolve(targetDir), { cache: true });
      expect(firmwareManager.ensureFirmwareFiles).toHaveBeenCalledWith(scanResults);
    });

    test('returns error when directory does not exist', async () => {
      const firmwareManager = {
        runPreflight: jest.fn(),
      };
      deps.firmwareManager = firmwareManager;
      deps.loadSettings.mockReturnValue({ operatingMode: 'project', firmwareInjectionEnabled: true });

      const missingDir = path.join(os.tmpdir(), 'hivemind-does-not-exist', String(Date.now()));
      const result = await harness.invoke('preflight-scan', missingDir);

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
      expect(firmwareManager.runPreflight).not.toHaveBeenCalled();
    });
  });

  describe('get-api-keys', () => {
    test('returns null keys when .env does not exist', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(false);

      const result = await harness.invoke('get-api-keys');

      expect(result.ANTHROPIC_API_KEY).toBeNull();
      expect(result.OPENAI_API_KEY).toBeNull();
      expect(result.RECRAFT_API_KEY).toBeNull();
      expect(result.TELEGRAM_BOT_TOKEN).toBeNull();
    });

    test('returns masked keys from .env file', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(
        'ANTHROPIC_API_KEY=sk-ant-1234567890abcdef\nOPENAI_API_KEY=sk-proj-xyz123\nTELEGRAM_CHAT_ID=12345'
      );

      const result = await harness.invoke('get-api-keys');

      expect(result.ANTHROPIC_API_KEY).toBe('***cdef');
      expect(result.OPENAI_API_KEY).toBe('***z123');
      expect(result.TELEGRAM_CHAT_ID).toBe('***2345');
      expect(result.RECRAFT_API_KEY).toBeNull(); // not in .env
    });

    test('masks short keys with ****', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue('TELEGRAM_CHAT_ID=123');

      const result = await harness.invoke('get-api-keys');

      expect(result.TELEGRAM_CHAT_ID).toBe('****');
    });

    test('handles .env read error gracefully', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('perm denied'); });

      const result = await harness.invoke('get-api-keys');

      expect(result.ANTHROPIC_API_KEY).toBeNull();
    });

    test('ignores non-whitelisted env vars', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue('SECRET_STUFF=should_not_appear\nOPENAI_API_KEY=sk-test1234');

      const result = await harness.invoke('get-api-keys');

      expect(result).not.toHaveProperty('SECRET_STUFF');
      expect(result.OPENAI_API_KEY).toBe('***1234');
    });

    test('handles \\r in .env file', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue('OPENAI_API_KEY=sk-test5678\r\nRECRAFT_API_KEY=rk-abcdefgh\r\n');

      const result = await harness.invoke('get-api-keys');

      expect(result.OPENAI_API_KEY).toBe('***5678');
      expect(result.RECRAFT_API_KEY).toBe('***efgh');
    });
  });

  describe('set-api-keys', () => {
    beforeEach(() => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(false);
      jest.spyOn(fs, 'readFileSync').mockReturnValue('');
      jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    });

    test('rejects unknown key', async () => {
      const result = await harness.invoke('set-api-keys', { UNKNOWN_KEY: 'value' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown key');
    });

    test('rejects invalid ANTHROPIC_API_KEY format', async () => {
      const result = await harness.invoke('set-api-keys', { ANTHROPIC_API_KEY: 'invalid-key' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid format');
    });

    test('rejects invalid OPENAI_API_KEY format', async () => {
      const result = await harness.invoke('set-api-keys', { OPENAI_API_KEY: 'not-sk-prefix' });
      expect(result.success).toBe(false);
    });

    test('rejects invalid GOOGLE_API_KEY format', async () => {
      const result = await harness.invoke('set-api-keys', { GOOGLE_API_KEY: 'bad-prefix' });
      expect(result.success).toBe(false);
    });

    test('rejects invalid TWILIO_ACCOUNT_SID format', async () => {
      const result = await harness.invoke('set-api-keys', { TWILIO_ACCOUNT_SID: 'not-ac-prefix' });
      expect(result.success).toBe(false);
    });

    test('rejects invalid TWILIO_PHONE_NUMBER format', async () => {
      const result = await harness.invoke('set-api-keys', { TWILIO_PHONE_NUMBER: '5551234' });
      expect(result.success).toBe(false);
    });

    test('rejects invalid SMS_RECIPIENT format', async () => {
      const result = await harness.invoke('set-api-keys', { SMS_RECIPIENT: '5551234' });
      expect(result.success).toBe(false);
    });

    test('rejects invalid TELEGRAM_CHAT_ID format', async () => {
      const result = await harness.invoke('set-api-keys', { TELEGRAM_CHAT_ID: 'not-a-number' });
      expect(result.success).toBe(false);
    });

    test('accepts valid keys and writes .env', async () => {
      const result = await harness.invoke('set-api-keys', {
        OPENAI_API_KEY: 'sk-testkey12345'
      });
      expect(result.success).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(process.env.OPENAI_API_KEY).toBe('sk-testkey12345');
      expect(result.capabilities).toBeDefined();
    });

    test('updates existing key in .env', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('OPENAI_API_KEY=sk-old-key\nOTHER=val');

      const result = await harness.invoke('set-api-keys', { OPENAI_API_KEY: 'sk-new-key' });
      expect(result.success).toBe(true);

      const writtenContent = fs.writeFileSync.mock.calls[0][1];
      expect(writtenContent).toContain('OPENAI_API_KEY=sk-new-key');
      expect(writtenContent).toContain('OTHER=val');
    });

    test('appends new key to .env', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('OPENAI_API_KEY=sk-existing');

      const result = await harness.invoke('set-api-keys', { RECRAFT_API_KEY: 'rk-new' });
      expect(result.success).toBe(true);

      const writtenContent = fs.writeFileSync.mock.calls[0][1];
      expect(writtenContent).toContain('OPENAI_API_KEY=sk-existing');
      expect(writtenContent).toContain('RECRAFT_API_KEY=rk-new');
    });

    test('skips empty values', async () => {
      const result = await harness.invoke('set-api-keys', { OPENAI_API_KEY: '' });
      expect(result.success).toBe(true);
      // Should not have written anything meaningful
    });

    test('allows empty value (clears key)', async () => {
      // Empty string passes validator since validators check !v first
      const result = await harness.invoke('set-api-keys', { ANTHROPIC_API_KEY: '' });
      expect(result.success).toBe(true);
    });

    test('sends feature-capabilities-updated to renderer', async () => {
      const result = await harness.invoke('set-api-keys', { RECRAFT_API_KEY: 'rk-test' });
      expect(result.success).toBe(true);
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
        'feature-capabilities-updated',
        expect.any(Object)
      );
    });

    test('handles write error gracefully', async () => {
      fs.writeFileSync.mockImplementation(() => { throw new Error('disk full'); });
      const result = await harness.invoke('set-api-keys', { RECRAFT_API_KEY: 'rk-test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('disk full');
    });

    test('accepts valid TELEGRAM_CHAT_ID with negative number', async () => {
      const result = await harness.invoke('set-api-keys', { TELEGRAM_CHAT_ID: '-123456' });
      expect(result.success).toBe(true);
    });
  });

  describe('unregister', () => {
    test('removes all settings handlers', () => {
      registerSettingsHandlers.unregister({ ipcMain: harness.ipcMain });
      expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('get-settings');
      expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('set-setting');
      expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('get-all-settings');
      expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('get-api-keys');
      expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('set-api-keys');
      expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('get-feature-capabilities');
      expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('preflight-scan');
    });
  });
});
