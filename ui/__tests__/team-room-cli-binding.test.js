'use strict';

const { createTeamRoomCliBindingResolver } = require('../modules/main/team-room-cli-binding');

function writerHarness() {
  const writer = { db: { marker: 'server-registry' }, open: jest.fn(() => ({ ok: true })), close: jest.fn() };
  return writer;
}

const ROLE_BY_PANE = Object.freeze({ 1: 'architect', 2: 'builder', 3: 'oracle' });

function currentPaneLaunch(paneId, override = {}) {
  return {
    paneId: String(paneId),
    pid: 7000 + Number(paneId),
    alive: true,
    paneLaunchId: `pl_${String(paneId).repeat(32)}`,
    appGeneration: 'app-session-512',
    ...override,
  };
}

function registryLaunch(query, override = {}) {
  const paneId = String(query.launchId || '').slice(3, 4);
  return {
    ok: true,
    launchId: query.launchId,
    appGeneration: 'app-session-512',
    paneId,
    role: ROLE_BY_PANE[paneId],
    daemonProcessId: '4242',
    state: 'launching',
    ...override,
  };
}

describe('Team Room CLI server-registry binding', () => {
  test('joins every agent to an exact server-issued pane launch and seals the five-field tuple', () => {
    const writer = writerHarness();
    const resolver = createTeamRoomCliBindingResolver({
      getProfileName: () => 'main',
      getDaemonProcessId: () => 4242,
      getCurrentPaneLaunch: (paneId) => currentPaneLaunch(paneId),
      writerFactory: () => writer,
      lookupPaneLaunchById: (_db, query) => registryLaunch(query),
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
      getCurrentPaneLaunch: (paneId) => currentPaneLaunch(paneId),
      writerFactory: () => writer,
      lookupPaneLaunchById: (_db, query) => registryLaunch(query, override),
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
    const lookupPaneLaunchById = jest.fn((_db, query) => registryLaunch(query, {
      daemonProcessId: '9999',
    }));
    const resolver = createTeamRoomCliBindingResolver({
      getProfileName: () => 'main',
      getDaemonProcessId: () => 4242,
      getCurrentPaneLaunch: (paneId) => currentPaneLaunch(paneId),
      writerFactory: () => writer,
      lookupPaneLaunchById,
    });

    expect(resolver({ appGeneration: 'app-session-512' }))
      .toEqual(expect.objectContaining({ ok: false, reason: 'team_room_cli_launch_binding_mismatch' }));
    expect(lookupPaneLaunchById).toHaveBeenCalledWith(writer.db, {
      launchId: `pl_${'1'.repeat(32)}`,
    });
    expect(writer.close).toHaveBeenCalledTimes(1);
  });

  test('binds the app-observed current launch even while an older completed row also exists', () => {
    const writer = writerHarness();
    const currentOracleLaunchId = `pl_${'9'.repeat(32)}`;
    const lookupPaneLaunchById = jest.fn((_db, query) => {
      if (query.launchId === currentOracleLaunchId) {
        return registryLaunch(query, { paneId: '3', role: 'oracle', state: 'launching' });
      }
      return registryLaunch(query, { state: 'complete' });
    });
    const resolver = createTeamRoomCliBindingResolver({
      getProfileName: () => 'main',
      getDaemonProcessId: () => 4242,
      getCurrentPaneLaunch: (paneId) => currentPaneLaunch(paneId, paneId === '3'
        ? { paneLaunchId: currentOracleLaunchId }
        : {}),
      writerFactory: () => writer,
      lookupPaneLaunchById,
    });

    expect(resolver({ appGeneration: 'app-session-512' })).toEqual(expect.objectContaining({
      ok: true,
      bindings: expect.objectContaining({
        oracle: expect.objectContaining({ paneLaunchId: currentOracleLaunchId }),
      }),
    }));
    expect(lookupPaneLaunchById).toHaveBeenCalledWith(writer.db, {
      launchId: currentOracleLaunchId,
    });
  });

  test.each([
    ['missing terminal', () => null],
    ['dead terminal', (paneId) => currentPaneLaunch(paneId, { alive: false })],
    ['missing terminal process', (paneId) => currentPaneLaunch(paneId, { pid: null })],
    ['wrong generation', (paneId) => currentPaneLaunch(paneId, { appGeneration: 'app-session-511' })],
    ['malformed launch', (paneId) => currentPaneLaunch(paneId, { paneLaunchId: 'pl_not-an-id' })],
  ])('refuses %s before opening the registry', (_label, getCurrentPaneLaunch) => {
    const writer = writerHarness();
    const resolver = createTeamRoomCliBindingResolver({
      getProfileName: () => 'main',
      getDaemonProcessId: () => 4242,
      getCurrentPaneLaunch,
      writerFactory: () => writer,
    });

    expect(resolver({ appGeneration: 'app-session-512' })).toEqual({
      ok: false,
      reason: 'team_room_cli_current_launch_unavailable',
      detail: { role: 'architect' },
    });
    expect(writer.open).not.toHaveBeenCalled();
  });
});
