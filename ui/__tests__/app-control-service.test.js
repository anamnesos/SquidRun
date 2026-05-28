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
        ['scoped', {
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
      reloadedWindowKeys: ['main', 'scoped', 'pane-host'],
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

  test('restart-telegram-poller delegates to the app poller lifecycle without reloading panes', () => {
    const restartTelegramPoller = jest.fn(() => ({
      success: true,
      started: true,
      reason: 'test',
    }));

    const result = executeAppControlAction({
      restartTelegramPoller,
    }, 'restart-telegram-poller', { reason: 'test' });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'restart-telegram-poller',
      started: true,
      reason: 'test',
    }));
    expect(restartTelegramPoller).toHaveBeenCalledWith({ reason: 'test' });
  });

  test('restart-telegram-poller does not inspect or reload side-profile windows', () => {
    const restartTelegramPoller = jest.fn(() => ({
      success: true,
      started: true,
      reason: 'eunbyeol-router-boundary',
    }));
    const getAppWindows = jest.fn(() => {
      throw new Error('window reload path must not be used for Telegram restart');
    });
    const getPaneHostWindows = jest.fn(() => {
      throw new Error('pane-host reload path must not be used for Telegram restart');
    });

    const result = executeAppControlAction({
      restartTelegramPoller,
      getAppWindows,
      getPaneHostWindows,
    }, 'restart-telegram-poller', { reason: 'eunbyeol-router-boundary' });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'restart-telegram-poller',
      started: true,
      reason: 'eunbyeol-router-boundary',
    }));
    expect(restartTelegramPoller).toHaveBeenCalledWith({ reason: 'eunbyeol-router-boundary' });
    expect(getAppWindows).not.toHaveBeenCalled();
    expect(getPaneHostWindows).not.toHaveBeenCalled();
  });

  test('restart-telegram-poller reports unavailable when the app lacks a restart hook', () => {
    expect(executeAppControlAction({}, 'restart-telegram-poller')).toEqual(expect.objectContaining({
      success: false,
      action: 'restart-telegram-poller',
      reason: 'restart_unavailable',
    }));
  });

  test('open-mira-lab opens or focuses the Mira Lab window via openAppWindow without restart', async () => {
    const openAppWindow = jest.fn().mockResolvedValue({
      ok: true,
      windowKey: 'mira-lab',
      title: 'Mira Lab',
      status: 'reused_existing',
    });

    const result = await executeAppControlAction({ openAppWindow }, 'open-mira-lab');

    expect(openAppWindow).toHaveBeenCalledWith('mira-lab', {});
    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'open-mira-lab',
      windowKey: 'mira-lab',
      status: 'reused_existing',
    }));
    expect(result.note).toMatch(/without restarting the Electron main process/i);
  });

  test('open-mira-lab accepts the legacy aliases and surfaces window-factory failure reasons', async () => {
    const openAppWindow = jest.fn().mockResolvedValue({
      ok: false,
      windowKey: 'mira-lab',
      reason: 'mira_lab_window_factory_returned_no_window',
    });

    const result = await executeAppControlAction({ openAppWindow }, 'mira-lab');

    expect(openAppWindow).toHaveBeenCalledWith('mira-lab', {});
    expect(result).toEqual(expect.objectContaining({
      success: false,
      action: 'open-mira-lab',
      reason: 'mira_lab_window_factory_returned_no_window',
    }));
  });

  test('open-mira-lab reports unavailable when the app does not expose openAppWindow', () => {
    const result = executeAppControlAction({}, 'open-mira-lab');
    expect(result).toEqual(expect.objectContaining({
      success: false,
      action: 'open-mira-lab',
      reason: 'open_window_unavailable',
    }));
  });

  test('open-mira-lab catches openAppWindow failures and reports them without throwing', async () => {
    const openAppWindow = jest.fn(() => { throw new Error('window registry unavailable'); });
    const result = await executeAppControlAction({ openAppWindow }, 'open-mira-lab');
    expect(result).toEqual(expect.objectContaining({
      success: false,
      action: 'open-mira-lab',
      reason: 'open_window_failed',
      error: 'window registry unavailable',
    }));
  });

  test('open-trustquote-workspace opens the real workspace without auto-booting duplicate agents', async () => {
    const openAppWindow = jest.fn().mockResolvedValue({
      ok: true,
      windowKey: 'trustquote',
      status: 'opened',
    });

    const result = await executeAppControlAction({ openAppWindow }, 'open-trustquote-workspace');

    expect(openAppWindow).toHaveBeenCalledWith('trustquote', {
      autoBootAgents: false,
      profileName: 'trustquote',
    });
    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'open-trustquote-workspace',
      windowKey: 'trustquote',
      status: 'opened',
    }));
    expect(result.note).toMatch(/without starting duplicate agents/i);
  });
});
