'use strict';

const {
  createTeamRoomPaneDelivery,
  createTeamRoomRouteScopeResolver,
  normalizeTeamRoomPaneDeliveryResult,
} = require('../modules/main/team-room-pane-delivery');

function delivery(profileName = 'main', paneId = '2') {
  return {
    member: { memberId: 'builder', paneId },
    activation: { activationId: 'tra-1', profileName, roomId: 'main' },
    message: { messageId: 'trm-1', rootMessageId: 'trm-1' },
    prompt: 'Room message',
  };
}

describe('Team Room pane delivery', () => {
  test('accepts only an actual expected-pane outcome with no missing or failed pane', () => {
    expect(normalizeTeamRoomPaneDeliveryResult({
      accepted: true,
      queued: true,
      details: { ackedPanes: ['2'], unverifiedPanes: [], missingPanes: [], failedPanes: [] },
    }, '2')).toEqual(expect.objectContaining({ ok: true, verified: true, outcome: 'acked' }));
    expect(normalizeTeamRoomPaneDeliveryResult({
      accepted: true,
      queued: true,
      details: { ackedPanes: [], unverifiedPanes: ['2'], missingPanes: [], failedPanes: [] },
    }, '2')).toEqual(expect.objectContaining({ ok: true, verified: false, outcome: 'unverified' }));
    expect(normalizeTeamRoomPaneDeliveryResult({
      accepted: true,
      queued: true,
      details: { ackedPanes: [], unverifiedPanes: [], missingPanes: ['2'], failedPanes: [] },
    }, '2')).toEqual(expect.objectContaining({ ok: false, reason: 'team_room_pane_outcome_missing' }));
    expect(normalizeTeamRoomPaneDeliveryResult({
      accepted: true,
      queued: true,
      details: { ackedPanes: [], unverifiedPanes: [], missingPanes: [], failedPanes: ['2'] },
    }, '2')).toEqual(expect.objectContaining({ ok: false, reason: 'team_room_pane_delivery_failed' }));
    expect(normalizeTeamRoomPaneDeliveryResult({
      accepted: true,
      queued: true,
      details: { ackedPanes: [], unverifiedPanes: [], missingPanes: [], failedPanes: [] },
    }, '2')).toEqual(expect.objectContaining({ ok: false, reason: 'team_room_expected_pane_outcome_missing' }));
  });

  test('binds main and second-profile routing to exact live window scopes', () => {
    const windows = new Map([
      ['main', { isDestroyed: () => false }],
      ['sideprofile', { isDestroyed: () => false }],
    ]);
    const scopes = new Map([
      ['main', { windowKey: 'main', profileName: 'main', sessionScopeId: 'app-session-512:main' }],
      ['sideprofile', { windowKey: 'sideprofile', profileName: 'sideprofile', sessionScopeId: 'app-session-512:sideprofile' }],
    ]);
    const resolve = createTeamRoomRouteScopeResolver({
      getAppWindow: (key) => windows.get(key),
      getWindowScope: (key) => scopes.get(key),
    });
    expect(resolve(delivery('main'))).toEqual(expect.objectContaining({
      ok: true, windowKey: 'main', profileName: 'main', sessionScopeId: 'app-session-512:main', paneId: '2',
    }));
    expect(resolve(delivery('sideprofile'))).toEqual(expect.objectContaining({
      ok: true, windowKey: 'sideprofile', profileName: 'sideprofile', sessionScopeId: 'app-session-512:sideprofile', paneId: '2',
    }));
    windows.delete('sideprofile');
    expect(resolve(delivery('sideprofile'))).toEqual(expect.objectContaining({
      ok: false, reason: 'team_room_route_window_unavailable',
    }));
  });

  test('passes explicit scope and waits for target outcome before reporting adapter success', async () => {
    const sendDirectMessage = jest.fn(async (_targets, _message, _fromRole, options) => ({
      accepted: true,
      queued: true,
      deliveryId: 'delivery-1',
      details: { ackedPanes: ['2'], unverifiedPanes: [], missingPanes: [], failedPanes: [] },
      options,
    }));
    const deliver = createTeamRoomPaneDelivery({
      sendDirectMessage,
      resolveRouteScope: () => ({
        ok: true,
        paneId: '2',
        windowKey: 'main',
        profileName: 'main',
        sessionScopeId: 'app-session-512:main',
      }),
    });
    await expect(deliver(delivery())).resolves.toEqual(expect.objectContaining({ ok: true, deliveryId: 'delivery-1' }));
    expect(sendDirectMessage).toHaveBeenCalledWith(
      ['2'],
      'Room message',
      'team-room',
      expect.objectContaining({
        awaitDelivery: true,
        meta: expect.objectContaining({
          windowKey: 'main',
          profileName: 'main',
          sessionScopeId: 'app-session-512:main',
          routeKind: 'team-room-activation',
        }),
      })
    );
  });
});
