'use strict';

const {
  ARM_STATE_PROJECTION_SCHEMA,
  buildArmStateProjection,
} = require('../main/arm-state-projection');

const ARM_STATE_PROJECTION_CHANNEL = 'arm-state:projection';

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function buildProjectionFilters(payload = {}) {
  const input = asObject(payload);
  return {
    ...(input.registryId || input.registry_id ? { registryId: input.registryId || input.registry_id } : {}),
    ...(input.appRoomId || input.app_room_id || input.roomId || input.room_id
      ? { appRoomId: input.appRoomId || input.app_room_id || input.roomId || input.room_id }
      : {}),
    ...(input.sessionId || input.session_id || input.sessionScopeId || input.session_scope_id
      ? { sessionId: input.sessionId || input.session_id || input.sessionScopeId || input.session_scope_id }
      : {}),
  };
}

function buildProjectionOptions(payload = {}, deps = {}) {
  const input = asObject(payload);
  return {
    ...(deps.dbPath ? { dbPath: deps.dbPath } : {}),
    ...(input.nowMs || input.now_ms ? { nowMs: Number(input.nowMs || input.now_ms) } : {}),
    includeRows: input.includeRows !== false && input.include_rows !== false,
  };
}

function buildArmStateProjectionResponse(payload = {}, deps = {}) {
  const projector = typeof deps.buildArmStateProjection === 'function'
    ? deps.buildArmStateProjection
    : buildArmStateProjection;
  try {
    const result = projector(buildProjectionFilters(payload), buildProjectionOptions(payload, deps));
    return {
      channel: ARM_STATE_PROJECTION_CHANNEL,
      schema: ARM_STATE_PROJECTION_SCHEMA,
      ...result,
      projectionOnly: result?.projectionOnly !== false,
      readOnly: result?.readOnly !== false,
      dispatchEnabled: false,
      executorEnabled: false,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'projection_failed',
      reason: err?.message || String(err),
      channel: ARM_STATE_PROJECTION_CHANNEL,
      schema: ARM_STATE_PROJECTION_SCHEMA,
      projectionOnly: true,
      readOnly: true,
      dispatchEnabled: false,
      executorEnabled: false,
      sideEffects: {
        writesPerformed: 0,
        dispatchesPerformed: 0,
        watchdogAdvancesPerformed: 0,
      },
    };
  }
}

function registerArmStateProjectionHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerArmStateProjectionHandlers requires ctx.ipcMain');
  }
  const ipcMain = ctx.ipcMain;
  if (typeof ipcMain.removeHandler === 'function') {
    ipcMain.removeHandler(ARM_STATE_PROJECTION_CHANNEL);
  }
  ipcMain.handle(ARM_STATE_PROJECTION_CHANNEL, (_event, payload = {}) =>
    buildArmStateProjectionResponse(payload, deps));
}

function unregisterArmStateProjectionHandlers(ctx) {
  const ipcMain = ctx && ctx.ipcMain;
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  ipcMain.removeHandler(ARM_STATE_PROJECTION_CHANNEL);
}

registerArmStateProjectionHandlers.unregister = unregisterArmStateProjectionHandlers;

module.exports = {
  ARM_STATE_PROJECTION_CHANNEL,
  buildArmStateProjectionResponse,
  buildProjectionFilters,
  buildProjectionOptions,
  registerArmStateProjectionHandlers,
  unregisterArmStateProjectionHandlers,
};
