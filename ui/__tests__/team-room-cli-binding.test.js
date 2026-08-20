'use strict';

const { createTeamRoomCliBindingResolver } = require('../modules/main/team-room-cli-binding');

function writerHarness() {
  const writer = { db: { marker: 'server-registry' }, open: jest.fn(() => ({ ok: true })), close: jest.fn() };
  return writer;
}

describe('Team Room CLI server-registry binding', () => {
  test('joins every agent to an exact server-issued pane launch and seals the five-field tuple', () => {
    const writer = writerHarness();
    const resolver = createTeamRoomCliBindingResolver({
      getProfileName: () => 'main',
      writerFactory: () => writer,
      lookupPaneLaunch: (db, query) => ({
        ok: true,
        launchId: `pl_${String(query.paneId).repeat(32)}`,
        appGeneration: query.appGeneration,
        paneId: query.paneId,
        role: ({ 1: 'architect', 2: 'builder', 3: 'oracle' })[query.paneId],
      }),
    });
    const result = resolver({ appGeneration: 'app-session-512' });
    expect(result.ok).toBe(true);
    expect(result.bindings.builder).toEqual({
      role: 'builder', paneId: '2', profileName: 'main',
      paneLaunchId: `pl_${'2'.repeat(32)}`, appGeneration: 'app-session-512',
    });
    expect(writer.close).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['stale generation', { appGeneration: 'app-session-511' }],
    ['wrong pane', { paneId: '3' }],
    ['wrong role', { role: 'oracle' }],
    ['invented launch shape', { launchId: `pl_${'x'.repeat(32)}` }],
  ])('fails closed on %s returned by the registry', (_label, override) => {
    const writer = writerHarness();
    const resolver = createTeamRoomCliBindingResolver({
      getProfileName: () => 'main',
      writerFactory: () => writer,
      lookupPaneLaunch: (_db, query) => ({
        ok: true,
        launchId: `pl_${String(query.paneId).repeat(32)}`,
        appGeneration: query.appGeneration,
        paneId: query.paneId,
        role: ({ 1: 'architect', 2: 'builder', 3: 'oracle' })[query.paneId],
        ...override,
      }),
    });
    expect(resolver({ appGeneration: 'app-session-512' }))
      .toEqual(expect.objectContaining({ ok: false, reason: 'team_room_cli_launch_binding_mismatch' }));
    expect(writer.close).toHaveBeenCalledTimes(1);
  });

  test('rejects a non-room profile before consulting the launch registry', () => {
    const writer = writerHarness();
    const resolver = createTeamRoomCliBindingResolver({
      getProfileName: () => 'customer-a',
      writerFactory: () => writer,
    });
    expect(resolver({ appGeneration: 'app-session-512' }))
      .toEqual({ ok: false, reason: 'team_room_cli_profile_binding_mismatch' });
    expect(writer.open).not.toHaveBeenCalled();
  });
});
