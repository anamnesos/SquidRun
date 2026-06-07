'use strict';

const {
  createWindowTeamBootstrap,
  normalizeWindowContext,
  readInitialWindowContextFromLocation,
} = require('../modules/window-team-bootstrap');

describe('window-team-bootstrap', () => {
  test('defers auto-spawn for a secondary window until full window context arrives', () => {
    const settings = {
      checkAutoSpawn: jest.fn(),
    };
    const terminal = {
      spawnAllAgents: jest.fn(),
    };
    const bootstrap = createWindowTeamBootstrap({
      settings,
      terminal,
      initialContext: readInitialWindowContextFromLocation('?windowKey=scoped&windowTeam=scoped'),
    });

    expect(bootstrap.shouldDeferAutoSpawn()).toBe(true);

    bootstrap.handleWindowContext({
      windowKey: 'scoped',
      windowTeam: 'scoped',
      sessionScopeId: 'app-test:scoped',
      startupBundlePath: 'D:\\projects\\squidrun\\.squidrun\\runtime\\window-teams\\scoped\\startup-bundle.md',
      startupSourceFiles: ['D:\\projects\\squidrun\\workspace\\knowledge\\case-operations.md'],
      startupBundleReady: true,
      autoBootAgents: true,
    });

    expect(bootstrap.shouldDeferAutoSpawn()).toBe(false);
  });

  test('runs secondary-window auto-boot through the shared auto-spawn path once context is loaded', async () => {
    const settings = {
      checkAutoSpawn: jest.fn().mockResolvedValue({ ok: true }),
    };
    const terminal = {
      spawnAllAgents: jest.fn(),
    };
    const bootstrap = createWindowTeamBootstrap({
      settings,
      terminal,
      initialContext: readInitialWindowContextFromLocation('?windowKey=scoped&windowTeam=scoped'),
    });

    bootstrap.handleWindowContext({
      windowKey: 'scoped',
      windowTeam: 'scoped',
      autoBootAgents: true,
      startupBundlePath: 'D:\\bundle.md',
      startupBundleReady: true,
    });

    await expect(bootstrap.maybeRunSecondaryAutoBoot({ reconnectedToExisting: false })).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        ran: true,
        windowKey: 'scoped',
      })
    );
    expect(settings.checkAutoSpawn).toHaveBeenCalledWith(terminal.spawnAllAgents, false);
  });

  test('does not auto-boot the main window path', async () => {
    const settings = {
      checkAutoSpawn: jest.fn(),
    };
    const terminal = {
      spawnAllAgents: jest.fn(),
    };
    const bootstrap = createWindowTeamBootstrap({
      settings,
      terminal,
      initialContext: readInitialWindowContextFromLocation('?windowKey=main&windowTeam=main'),
    });
    bootstrap.handleWindowContext({
      windowKey: 'main',
      windowTeam: 'main',
      autoBootAgents: false,
    });

    await expect(bootstrap.maybeRunSecondaryAutoBoot({ reconnectedToExisting: false })).resolves.toEqual(
      expect.objectContaining({
        skipped: true,
        reason: 'main_window',
      })
    );
    expect(settings.checkAutoSpawn).not.toHaveBeenCalled();
  });

  test('carries standalone lifecycle metadata for profile window controls', () => {
    expect(normalizeWindowContext({
      windowKey: 'scoped',
      profileName: 'scoped',
      standaloneWindow: true,
      lifecycleMode: 'standalone-profile-app',
    })).toEqual(expect.objectContaining({
      windowKey: 'scoped',
      profileName: 'scoped',
      standaloneWindow: true,
      lifecycleMode: 'standalone-profile-app',
    }));
  });

  test('does not treat a side-profile loadFile bundle path as ready unless it was freshly materialized', () => {
    const initialContext = readInitialWindowContextFromLocation(
      '?windowKey=eunbyeol&windowTeam=eunbyeol&profileName=eunbyeol&profileLabel=Eunbyeol&sessionScopeId=app-test%3Aeunbyeol&startupBundlePath=D%3A%5Cbundle.md&autoBootAgents=true&standaloneWindow=true&lifecycleMode=standalone-profile-app&contextReady=true'
    );

    expect(initialContext).toEqual(expect.objectContaining({
      loaded: false,
      windowKey: 'eunbyeol',
      windowTeam: 'eunbyeol',
      profileName: 'eunbyeol',
      profileLabel: 'Eunbyeol',
      sessionScopeId: 'app-test:eunbyeol',
      startupBundlePath: 'D:\\bundle.md',
      startupBundleReady: false,
      autoBootAgents: true,
      standaloneWindow: true,
      lifecycleMode: 'standalone-profile-app',
    }));

    const bootstrap = createWindowTeamBootstrap({
      settings: { checkAutoSpawn: jest.fn() },
      terminal: { spawnAllAgents: jest.fn() },
      initialContext,
    });
    expect(bootstrap.shouldDeferAutoSpawn()).toBe(true);
  });

  test('treats rich loadFile query context as ready when side bundle freshness is explicit', () => {
    const initialContext = readInitialWindowContextFromLocation(
      '?windowKey=eunbyeol&windowTeam=eunbyeol&profileName=eunbyeol&profileLabel=Eunbyeol&sessionScopeId=app-test%3Aeunbyeol&startupBundlePath=D%3A%5Cbundle.md&startupBundleReady=true&autoBootAgents=true&standaloneWindow=true&lifecycleMode=standalone-profile-app&contextReady=true'
    );

    expect(initialContext).toEqual(expect.objectContaining({
      loaded: true,
      windowKey: 'eunbyeol',
      profileName: 'eunbyeol',
      startupBundlePath: 'D:\\bundle.md',
      startupBundleReady: true,
      autoBootAgents: true,
    }));

    const bootstrap = createWindowTeamBootstrap({
      settings: { checkAutoSpawn: jest.fn() },
      terminal: { spawnAllAgents: jest.fn() },
      initialContext,
    });
    expect(bootstrap.shouldDeferAutoSpawn()).toBe(false);
  });

  test('treats Squid Room surface context as loaded without startup bundle and keeps auto-boot disabled', async () => {
    const initialContext = readInitialWindowContextFromLocation(
      '?windowKey=squid-room&windowTeam=squid-room&profileName=main&sessionScopeId=app-test%3Asquid-room&autoBootAgents=false&displayOnly=true&skipStartupBundle=true&contextReady=true'
    );

    expect(initialContext).toEqual(expect.objectContaining({
      loaded: true,
      windowKey: 'squid-room',
      windowTeam: 'squid-room',
      profileName: 'main',
      startupBundlePath: '',
      startupBundleReady: false,
      autoBootAgents: false,
      displayOnly: true,
      skipStartupBundle: true,
    }));

    const settings = { checkAutoSpawn: jest.fn() };
    const bootstrap = createWindowTeamBootstrap({
      settings,
      terminal: { spawnAllAgents: jest.fn() },
      initialContext,
    });

    expect(bootstrap.shouldDeferAutoSpawn()).toBe(false);
    await expect(bootstrap.maybeRunSecondaryAutoBoot({ reconnectedToExisting: false })).resolves.toEqual(
      expect.objectContaining({
        skipped: true,
        reason: 'auto_boot_disabled',
      })
    );
    expect(settings.checkAutoSpawn).not.toHaveBeenCalled();
  });
});
