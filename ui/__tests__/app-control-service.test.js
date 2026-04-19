const { executeAppControlAction } = require('../modules/main/app-control-service');

describe('app-control-service', () => {
  test('reload-renderers reloads every live window without restarting the main process', () => {
    const mainReload = jest.fn();
    const sideReload = jest.fn();

    const result = executeAppControlAction({
      getAppWindows: () => ([
        ['main', {
          isDestroyed: () => false,
          webContents: { reloadIgnoringCache: mainReload },
        }],
        ['eunbyeol', {
          isDestroyed: () => false,
          webContents: { reloadIgnoringCache: sideReload },
        }],
      ]),
    }, 'reload-renderers');

    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'reload-renderers',
      reloadedWindowKeys: ['main', 'eunbyeol'],
      windowCount: 2,
    }));
    expect(mainReload).toHaveBeenCalledTimes(1);
    expect(sideReload).toHaveBeenCalledTimes(1);
  });
});
