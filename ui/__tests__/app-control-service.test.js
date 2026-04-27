const { executeAppControlAction } = require('../modules/main/app-control-service');

describe('app-control-service', () => {
  test('reload-renderers reloads every live window without restarting the main process', () => {
    const mainReload = jest.fn();
    const sideReload = jest.fn();
    const paneHostReload = jest.fn();

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
      getPaneHostWindows: () => ([
        ['pane-host', {
          isDestroyed: () => false,
          webContents: { reloadIgnoringCache: paneHostReload },
        }],
      ]),
    }, 'reload-renderers');

    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'reload-renderers',
      reloadedWindowKeys: ['main', 'eunbyeol', 'pane-host'],
      windowCount: 3,
    }));
    expect(mainReload).toHaveBeenCalledTimes(1);
    expect(sideReload).toHaveBeenCalledTimes(1);
    expect(paneHostReload).toHaveBeenCalledTimes(1);
  });

  test('reload-renderers only reloads a shared window once when registries overlap', () => {
    const reload = jest.fn();
    const sharedWindow = {
      isDestroyed: () => false,
      webContents: { reloadIgnoringCache: reload },
    };

    const result = executeAppControlAction({
      getAppWindows: () => ([['main', sharedWindow]]),
      getPaneHostWindows: () => ([['pane-host', sharedWindow]]),
    }, 'reload-renderers');

    expect(result).toEqual(expect.objectContaining({
      success: true,
      reloadedWindowKeys: ['main'],
      windowCount: 1,
    }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
