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
      getDaemonProcessId: () => 4242,
      writerFactory: () => writer,
      lookupPaneLaunch: (db, query) => ({
        ok: true,
        launchId: `pl_${String(query.paneId).repeat(32)}`,
        appGeneration: query.appGeneration,
        paneId: query.paneId,
        role: ({ 1: 'architect', 2: 'builder', 3: 'oracle' })[query.paneId],
        daemonProcessId: query.daemonProcessId,
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
      getDaemonProcessId: () => 4242,
      writerFactory: () => writer,
      lookupPaneLaunch: (_db, query) => ({
        ok: true,
        launchId: `pl_${String(query.paneId).repeat(32)}`,
        appGeneration: query.appGeneration,
        paneId: query.paneId,
        role: ({ 1: 'architect', 2: 'builder', 3: 'oracle' })[query.paneId],
        daemonProcessId: query.daemonProcessId,
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

  test('binds lookups to the Team Room owner process and rejects a foreign launcher row', () => {
    const writer = writerHarness();
    const lookupPaneLaunch = jest.fn((_db, query) => ({
      ok: true,
      launchId: `pl_${String(query.paneId).repeat(32)}`,
      appGeneration: query.appGeneration,
      paneId: query.paneId,
      role: ({ 1: 'architect', 2: 'builder', 3: 'oracle' })[query.paneId],
      daemonProcessId: '9999',
    }));
    const resolver = createTeamRoomCliBindingResolver({
      getProfileName: () => 'main',
      getDaemonProcessId: () => 4242,
      writerFactory: () => writer,
      lookupPaneLaunch,
    });

    expect(resolver({ appGeneration: 'app-session-512' }))
      .toEqual(expect.objectContaining({ ok: false, reason: 'team_room_cli_launch_binding_mismatch' }));
    expect(lookupPaneLaunch).toHaveBeenCalledWith(writer.db, expect.objectContaining({
      appGeneration: 'app-session-512',
      paneId: '1',
      daemonProcessId: '4242',
      allowIncomplete: true,
    }));
    expect(writer.close).toHaveBeenCalledTimes(1);
  });
});
