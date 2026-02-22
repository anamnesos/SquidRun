/**
 * Settings capabilities IPC tests
 * Targets get-feature-capabilities + update broadcast on API key save.
 */

jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(() => ''),
  writeFileSync: jest.fn(),
}));

const fs = require('fs');
const {
  createIpcHarness,
  createDefaultContext,
  createDepsMock,
} = require('./helpers/ipc-harness');
const { registerSettingsHandlers } = require('../modules/ipc/settings-handlers');

describe('settings feature capabilities', () => {
  const originalEnv = process.env;
  let harness;
  let ctx;
  let deps;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.OPENAI_API_KEY;
    delete process.env.RECRAFT_API_KEY;

    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    deps = createDepsMock({
      loadSettings: jest.fn(() => ({})),
      saveSettings: jest.fn(),
    });

    registerSettingsHandlers(ctx, deps);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('get-feature-capabilities reflects process.env key availability', async () => {
    process.env.RECRAFT_API_KEY = 'rk-test-fake-key-do-not-use';

    const result = await harness.invoke('get-feature-capabilities');

    expect(result).toEqual({
      imageGenAvailable: true,
      voiceTranscriptionAvailable: false,
      recraftAvailable: true,
      openaiAvailable: false,
    });
  });

  test('set-api-keys emits feature-capabilities-updated and returns capabilities', async () => {
    const result = await harness.invoke('set-api-keys', {
      OPENAI_API_KEY: 'sk-test-fake-key-do-not-use',
    });

    expect(result.success).toBe(true);
    expect(result.capabilities).toEqual({
      imageGenAvailable: true,
      voiceTranscriptionAvailable: true,
      recraftAvailable: false,
      openaiAvailable: true,
    });
    expect(process.env.OPENAI_API_KEY).toBe('sk-test-fake-key-do-not-use');
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
      'feature-capabilities-updated',
      result.capabilities
    );
  });
});
