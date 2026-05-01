'use strict';

const {
  createWindowTeamBootstrap,
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
});
