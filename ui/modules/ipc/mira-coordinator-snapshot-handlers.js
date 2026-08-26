'use strict';

const { getProjectRoot } = require('../../config');
const {
  MIRA_COORDINATOR_SNAPSHOT_CHANNEL,
  buildMiraCoordinatorSnapshotV0,
} = require('../mira-core/coordinator-snapshot-v0');

function buildMiraCoordinatorSnapshotResponse(payload = {}, options = {}) {
  return buildMiraCoordinatorSnapshotV0(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

function registerMiraCoordinatorSnapshotHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerMiraCoordinatorSnapshotHandlers requires ctx.ipcMain');
  }
  const ipcMain = ctx.ipcMain;
  ipcMain.handle(MIRA_COORDINATOR_SNAPSHOT_CHANNEL, (_event, payload = {}) =>
    buildMiraCoordinatorSnapshotResponse(payload, deps));
}

function unregisterMiraCoordinatorSnapshotHandlers(ctx) {
  const ipcMain = ctx && ctx.ipcMain;
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  ipcMain.removeHandler(MIRA_COORDINATOR_SNAPSHOT_CHANNEL);
}

registerMiraCoordinatorSnapshotHandlers.unregister = unregisterMiraCoordinatorSnapshotHandlers;

module.exports = {
  MIRA_COORDINATOR_SNAPSHOT_CHANNEL,
  buildMiraCoordinatorSnapshotResponse,
  registerMiraCoordinatorSnapshotHandlers,
  unregisterMiraCoordinatorSnapshotHandlers,
};
