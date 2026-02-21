const { contextBridge, ipcRenderer } = require('electron');
const { createPreloadApi } = require('./modules/bridge/preload-api');
const { createRendererModules } = require('./modules/bridge/renderer-modules');

const bridgeApi = createPreloadApi(ipcRenderer);

function exposeBridgeAliases(exposeFn, api) {
  exposeFn('squidrun', api);
  exposeFn('squidrunAPI', api);
}

// Expose bridge on the preload's own window BEFORE loading renderer modules.
// Renderer modules run in the preload context and resolve the bridge via
// window.squidrun (through renderer-bridge.js). Without this, they can't
// find the bridge because contextBridge only exposes to the renderer page.
exposeBridgeAliases((name, value) => { window[name] = value; }, bridgeApi);

bridgeApi.rendererModules = createRendererModules();

if (process.contextIsolated) {
  exposeBridgeAliases((name, value) => contextBridge.exposeInMainWorld(name, value), bridgeApi);
}
