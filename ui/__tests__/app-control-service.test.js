const {
  executeAppControlAction,
  normalizeAction,
} = require('../modules/main/app-control-service');

describe('app-control-service', () => {
  test('normalizeAction resolves close-window aliases', () => {
    expect(normalizeAction('close-trustquote')).toBe('close-trustquote-workspace');
    expect(normalizeAction('close-trustquote-window')).toBe('close-trustquote-workspace');
    expect(normalizeAction('close-window')).toBe('close-app-window');
    expect(normalizeAction('close-app-window')).toBe('close-app-window');
    expect(normalizeAction('scroll-probe')).toBe('terminal-scroll-probe');
    expect(normalizeAction('probe-terminal-scroll')).toBe('terminal-scroll-probe');
    expect(normalizeAction('timeline')).toBe('open-human-timeline-sidecar');
    expect(normalizeAction('today-feed')).toBe('open-human-timeline-sidecar');
  });

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

  test('terminal-scroll-probe is unavailable in packaged builds', () => {
    const result = executeAppControlAction({
      isPackaged: true,
      getAppWindow: jest.fn(),
    }, 'terminal-scroll-probe', {
      windowKey: 'squid-room',
      containerId: 'terminal-trustquote-app',
      op: 'dispatchKey',
      key: 'PageUp',
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      action: 'terminal-scroll-probe',
      reason: 'terminal_scroll_probe_dev_only',
    }));
  });

  test('terminal-scroll-probe validates explicit window, container, and op input', () => {
    const result = executeAppControlAction({
      isPackaged: false,
      getAppWindow: jest.fn(),
    }, 'terminal-scroll-probe', {
      windowKey: '',
      containerId: 'bad container id',
      op: 'dispatchKey',
      key: 'Escape',
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      action: 'terminal-scroll-probe',
      reason: 'terminal_scroll_probe_invalid_payload',
    }));
    expect(result.errors).toEqual(expect.arrayContaining([
      'windowKey_required',
      'containerId_invalid',
      'key_unsupported',
    ]));
  });

  test('terminal-scroll-probe executes a fixed textarea key probe against the requested renderer window', async () => {
    const executeJavaScript = jest.fn().mockResolvedValue({
      success: true,
      requestedWindowKey: 'squid-room',
      windowKey: 'squid-room',
      containerId: 'terminal-trustquote-app',
      paneId: 'trustquote-app',
      op: 'dispatchKey',
      key: 'PageUp',
      dispatchTarget: 'xterm-helper-textarea',
      before: { viewportY: 26 },
      after: { viewportY: 12 },
      moved: true,
    });
    const getAppWindow = jest.fn(() => ({
      isDestroyed: () => false,
      webContents: { executeJavaScript },
    }));

    const result = await executeAppControlAction({
      isPackaged: false,
      getAppWindow,
    }, 'terminal-scroll-probe', {
      windowKey: 'squid-room',
      containerId: 'terminal-trustquote-app',
      op: 'dispatchKey',
      key: 'PageUp',
    });

    expect(getAppWindow).toHaveBeenCalledWith('squid-room');
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    const [script, userGesture] = executeJavaScript.mock.calls[0];
    expect(userGesture).toBe(true);
    // The injected script must delegate into the isolated world (where the
    // terminal + expando live) rather than read the expando from the main world.
    expect(script).toContain('runTerminalScrollProbe');
    expect(script).toContain('rendererModules');
    expect(script).toContain('"op":"dispatchKey"');
    expect(script).toContain('"key":"PageUp"');
    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'terminal-scroll-probe',
      requestedWindowKey: 'squid-room',
      dispatchTarget: 'xterm-helper-textarea',
      moved: true,
    }));
  });

  test('terminal-scroll-probe accepts selector-based dispatchSelect with an explicit value', async () => {
    const executeJavaScript = jest.fn().mockResolvedValue({
      success: true,
      requestedWindowKey: 'squid-room',
      windowKey: 'squid-room',
      selector: '#model-selector-3',
      op: 'dispatchSelect',
      requestedValue: 'codex',
      valueAfter: 'codex',
      disabledAfter: true,
      changeAccepted: true,
    });
    const getAppWindow = jest.fn(() => ({
      isDestroyed: () => false,
      webContents: { executeJavaScript },
    }));

    const result = await executeAppControlAction({
      isPackaged: false,
      getAppWindow,
    }, 'terminal-scroll-probe', {
      windowKey: 'squid-room',
      selector: '#model-selector-3',
      op: 'dispatchSelect',
      value: 'codex',
    });

    expect(getAppWindow).toHaveBeenCalledWith('squid-room');
    const [script, userGesture] = executeJavaScript.mock.calls[0];
    expect(userGesture).toBe(true);
    expect(script).toContain('"op":"dispatchSelect"');
    expect(script).toContain('"selector":"#model-selector-3"');
    expect(script).toContain('"value":"codex"');
    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'terminal-scroll-probe',
      selector: '#model-selector-3',
      requestedValue: 'codex',
      disabledAfter: true,
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

  test('open-live-task-audit-sidecar opens the task audit sidecar without restart', async () => {
    const openAppWindow = jest.fn().mockResolvedValue({
      ok: true,
      windowKey: 'live-task-audit-sidecar',
      status: 'opened',
    });

    const result = await executeAppControlAction({ openAppWindow }, 'task-audit');

    expect(openAppWindow).toHaveBeenCalledWith('live-task-audit-sidecar', {});
    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'open-live-task-audit-sidecar',
      windowKey: 'live-task-audit-sidecar',
      status: 'opened',
    }));
    expect(result.note).toMatch(/sidecar opened\/focused without restarting/i);
  });

  test('open-human-timeline-sidecar opens the Today feed without restart', async () => {
    const openAppWindow = jest.fn().mockResolvedValue({
      ok: true,
      windowKey: 'human-timeline-sidecar',
      status: 'opened',
    });

    const result = await executeAppControlAction({ openAppWindow }, 'timeline');

    expect(openAppWindow).toHaveBeenCalledWith('human-timeline-sidecar', {});
    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'open-human-timeline-sidecar',
      windowKey: 'human-timeline-sidecar',
      status: 'opened',
    }));
    expect(result.note).toMatch(/without restarting the Electron main process/i);
  });

  test('open-squid-room opens a main-profile surface window with auto-boot disabled', async () => {
    const openAppWindow = jest.fn().mockResolvedValue({
      ok: true,
      windowKey: 'squid-room',
      status: 'opened',
    });

    const result = await executeAppControlAction({ openAppWindow }, 'open-squid-room');

    expect(openAppWindow).toHaveBeenCalledWith('squid-room', {
      autoBootAgents: false,
      profileName: 'main',
      windowTeam: 'squid-room',
      displayOnly: true,
      skipStartupBundle: true,
    });
    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'open-squid-room',
      windowKey: 'squid-room',
      status: 'opened',
    }));
    expect(result.note).toMatch(/main-profile surface window/i);
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

  test('close-trustquote-workspace delegates to the existing non-main close path', async () => {
    const closeAppWindow = jest.fn().mockResolvedValue({
      ok: true,
      windowKey: 'trustquote',
      status: 'closed',
    });

    const result = await executeAppControlAction({ closeAppWindow }, 'close-trustquote-workspace');

    expect(closeAppWindow).toHaveBeenCalledWith('trustquote');
    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'close-trustquote-workspace',
      windowKey: 'trustquote',
      status: 'closed',
    }));
    expect(result.note).toMatch(/without stopping the Electron main process/i);
  });

  test('close-app-window refuses main before calling the app close hook', async () => {
    const closeAppWindow = jest.fn();

    const result = await executeAppControlAction({ closeAppWindow }, 'close-app-window', {
      windowKey: 'main',
    });

    expect(closeAppWindow).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      success: false,
      action: 'close-app-window',
      windowKey: 'main',
      reason: 'main_window_requires_quit',
    }));
  });

  test('close-app-window surfaces missing non-main windows without stopping the app', async () => {
    const closeAppWindow = jest.fn().mockResolvedValue({
      ok: false,
      windowKey: 'trustquote',
      reason: 'window_not_found',
    });

    const result = await executeAppControlAction({ closeAppWindow }, 'close-app-window', {
      windowKey: 'trustquote',
    });

    expect(closeAppWindow).toHaveBeenCalledWith('trustquote');
    expect(result).toEqual(expect.objectContaining({
      success: false,
      action: 'close-app-window',
      windowKey: 'trustquote',
      reason: 'window_not_found',
    }));
  });
});
