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
    statusStrip: require('../status-strip'),
    modelSelector: require('../model-selector'),
    config: require('../../config'),
    bus: require('../event-bus'),
    ipcRegistry: require('../renderer-ipc-registry'),
  });
}

module.exports = {
  createRendererModules,
};
