'use strict';

function createRendererModules() {
  return Object.freeze({
    log: require('../logger'),
    terminal: require('../terminal'),
    tabs: require('../tabs'),
    settings: require('../settings'),
    daemonHandlers: require('../daemon-handlers'),
    notifications: require('../notifications'),
    utils: require('../utils'),
    commandPalette: require('../command-palette'),
    projectRooms: require('../project-rooms'),
    statusStrip: require('../status-strip'),
    paneVisibility: require('../pane-visibility'),
    windowTeamBootstrap: require('../window-team-bootstrap'),
    workspacePaneShell: require('../workspace-pane-shell'),
    squidRoomSurface: require('../squid-room-surface'),
    miraLiveEntrypoint: require('../mira-live-entrypoint'),
    modelSelector: require('../model-selector'),
    config: require('../../config'),
    bus: require('../event-bus'),
    ipcRegistry: require('../renderer-ipc-registry'),
  });
}

module.exports = {
  createRendererModules,
};
