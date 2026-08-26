'use strict';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function paneSet(value) {
  return new Set((Array.isArray(value) ? value : []).map((item) => String(item)));
}

function normalizeTeamRoomPaneDeliveryResult(result, expectedPaneId) {
  const paneId = String(expectedPaneId || '').trim();
  if (!paneId) return { ok: false, reason: 'team_room_expected_pane_required' };
  if (!result || result.accepted !== true || result.queued !== true) {
    return { ok: false, reason: result?.status || result?.reason || 'team_room_pane_dispatch_rejected' };
  }
  const details = result.details && typeof result.details === 'object' ? result.details : {};
  const ackedPanes = paneSet(details.ackedPanes);
  const unverifiedPanes = paneSet(details.unverifiedPanes);
  const missingPanes = paneSet(details.missingPanes);
  const failedPanes = paneSet(details.failedPanes);
  if (missingPanes.size > 0) return { ok: false, reason: 'team_room_pane_outcome_missing' };
  if (failedPanes.size > 0) return { ok: false, reason: 'team_room_pane_delivery_failed' };
  if (!ackedPanes.has(paneId) && !unverifiedPanes.has(paneId)) {
    return { ok: false, reason: 'team_room_expected_pane_outcome_missing' };
  }
  return {
    ok: true,
    deliveryId: result.deliveryId || null,
    verified: ackedPanes.has(paneId),
    outcome: ackedPanes.has(paneId) ? 'acked' : 'unverified',
  };
}

function createTeamRoomRouteScopeResolver(options = {}) {
  if (typeof options.getAppWindow !== 'function') throw new Error('team_room_get_app_window_required');
  if (typeof options.getWindowScope !== 'function') throw new Error('team_room_get_window_scope_required');
  return ({ activation, member }) => {
    const profileName = text(activation?.profileName);
    const paneId = text(member?.paneId);
    if (!profileName) return { ok: false, reason: 'team_room_route_profile_required' };
    if (!paneId) return { ok: false, reason: 'team_room_route_pane_required' };
    const windowKey = profileName === 'main' ? 'main' : profileName;
    const windowRef = options.getAppWindow(windowKey);
    if (!windowRef || (typeof windowRef.isDestroyed === 'function' && windowRef.isDestroyed())) {
      return { ok: false, reason: 'team_room_route_window_unavailable', windowKey, profileName };
    }
    const scope = options.getWindowScope(windowKey);
    if (!scope || text(scope.windowKey) !== windowKey || text(scope.profileName) !== profileName
      || !text(scope.sessionScopeId)) {
      return { ok: false, reason: 'team_room_route_scope_unavailable', windowKey, profileName };
    }
    return {
      ok: true,
      windowKey,
      profileName,
      sessionScopeId: text(scope.sessionScopeId),
      paneId,
    };
  };
}

function createTeamRoomPaneDelivery(options = {}) {
  if (typeof options.sendDirectMessage !== 'function') throw new Error('team_room_send_direct_message_required');
  if (typeof options.resolveRouteScope !== 'function') throw new Error('team_room_route_scope_resolver_required');
  const deliveryTimeoutMs = Math.max(1_000, Number(options.deliveryTimeoutMs) || 8_000);
  return async (delivery = {}) => {
    const paneId = text(delivery?.member?.paneId);
    if (!paneId || paneId !== text(delivery?.member?.paneId)) {
      return { ok: false, reason: 'team_room_delivery_pane_invalid' };
    }
    const scope = options.resolveRouteScope(delivery);
    if (!scope?.ok) return scope || { ok: false, reason: 'team_room_route_scope_unavailable' };
    if (scope.paneId !== paneId || scope.profileName !== text(delivery?.activation?.profileName)) {
      return { ok: false, reason: 'team_room_route_scope_mismatch' };
    }
    let result;
    try {
      result = await Promise.resolve(options.sendDirectMessage(
        [paneId],
        String(delivery.prompt || ''),
        'team-room',
        {
          awaitDelivery: true,
          deliveryTimeoutMs,
          traceContext: {
            traceId: delivery.activation?.activationId || null,
            correlationId: delivery.message?.rootMessageId || delivery.message?.messageId || null,
            messageId: delivery.message?.messageId || null,
          },
          meta: {
            windowKey: scope.windowKey,
            profileName: scope.profileName,
            sessionScopeId: scope.sessionScopeId,
            routeKind: 'team-room-activation',
            roomMessageId: delivery.message?.messageId || null,
            roomActivationId: delivery.activation?.activationId || null,
            preferHiddenPaneHost: false,
            disableVisibleFallback: false,
          },
        }
      ));
    } catch (error) {
      return { ok: false, reason: `team_room_pane_dispatch_error:${error.message}` };
    }
    return normalizeTeamRoomPaneDeliveryResult(result, paneId);
  };
}

module.exports = {
  createTeamRoomPaneDelivery,
  createTeamRoomRouteScopeResolver,
  normalizeTeamRoomPaneDeliveryResult,
};
