const path = require('path');

const mockResolveGlobalPath = jest.fn();

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
}));

jest.mock('../modules/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

jest.mock('../config', () => ({
  WORKSPACE_PATH: '/workspace',
  GLOBAL_STATE_ROOT: '/global-state',
  resolveGlobalPath: (...args) => mockResolveGlobalPath(...args),
}));

const fs = require('fs');
const UsageManager = require('../modules/main/usage-manager');

describe('UsageManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveGlobalPath.mockReturnValue('/global-state/usage-stats.json');
    fs.existsSync.mockReturnValue(false);
    fs.mkdirSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => {});
    fs.renameSync.mockImplementation(() => {});
  });

  test('resolves usage-stats path via resolveGlobalPath', () => {
    const ctx = {};
    const manager = new UsageManager(ctx);

    expect(mockResolveGlobalPath).toHaveBeenCalledWith('usage-stats.json', { forWrite: true });
    expect(manager.usageFilePath).toBe('/global-state/usage-stats.json');
  });

  test('saveUsageStats ensures parent directory and writes atomically', () => {
    const ctx = {};
    const manager = new UsageManager(ctx);

    manager.saveUsageStats();

    expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname('/global-state/usage-stats.json'), { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/global-state/usage-stats.json.tmp',
      expect.any(String),
      'utf-8'
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      '/global-state/usage-stats.json.tmp',
      '/global-state/usage-stats.json'
    );
  });
});
