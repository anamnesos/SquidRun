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
      initialContext: readInitialWindowContextFromLocation('?windowKey=private-profile&windowTeam=private-profile'),
    });

    expect(bootstrap.shouldDeferAutoSpawn()).toBe(true);

    bootstrap.handleWindowContext({
      windowKey: 'private-profile',
      windowTeam: 'private-profile',
      sessionScopeId: 'app-test:private-profile',
      startupBundlePath: 'D:\\projects\\squidrun\\.squidrun\\runtime\\window-teams\\private-profile\\startup-bundle.md',
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
      initialContext: readInitialWindowContextFromLocation('?windowKey=private-profile&windowTeam=private-profile'),
    });

    bootstrap.handleWindowContext({
      windowKey: 'private-profile',
      windowTeam: 'private-profile',
      autoBootAgents: true,
    });

    await expect(bootstrap.maybeRunSecondaryAutoBoot({ reconnectedToExisting: false })).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        ran: true,
        windowKey: 'private-profile',
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
