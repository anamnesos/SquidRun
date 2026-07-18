const {
  loadSqliteExtension,
  resolveLoadableExtensionPath,
} = require('../modules/sqlite-compat');

describe('sqlite compatibility extension loading', () => {
  test('maps a packaged ASAR extension to its physical unpacked path', () => {
    const requestedPath = 'D:\\app\\resources\\app.asar\\node_modules\\sqlite-vec-windows-x64\\vec0.dll';
    const physicalPath = 'D:\\app\\resources\\app.asar.unpacked\\node_modules\\sqlite-vec-windows-x64\\vec0.dll';
    const existsSync = jest.fn((candidate) => candidate === physicalPath);

    expect(resolveLoadableExtensionPath(requestedPath, { existsSync })).toBe(physicalPath);
    expect(existsSync).toHaveBeenCalledWith(physicalPath);
  });

  test('keeps the requested path when no physical unpacked artifact exists', () => {
    const requestedPath = '/opt/app/resources/app.asar/node_modules/sqlite-vec-linux-x64/vec0.so';

    expect(resolveLoadableExtensionPath(requestedPath, { existsSync: () => false })).toBe(requestedPath);
  });

  test('loads the physical extension path instead of the virtual ASAR path', () => {
    const requestedPath = 'D:\\app\\resources\\app.asar\\node_modules\\sqlite-vec-windows-x64\\vec0.dll';
    const physicalPath = 'D:\\app\\resources\\app.asar.unpacked\\node_modules\\sqlite-vec-windows-x64\\vec0.dll';
    const db = { loadExtension: jest.fn() };
    const extension = { getLoadablePath: jest.fn(() => requestedPath) };

    expect(loadSqliteExtension(db, extension, {
      existsSync: (candidate) => candidate === physicalPath,
    })).toEqual({ requestedPath, loadedPath: physicalPath });
    expect(extension.getLoadablePath).toHaveBeenCalledTimes(1);
    expect(db.loadExtension).toHaveBeenCalledWith(physicalPath);
  });

  test('rejects a database without an extension-loading seam', () => {
    expect(() => loadSqliteExtension({}, 'vec0.dll')).toThrow('sqlite_extension_loader_unavailable');
  });
});
