const { contextBridge, ipcRenderer } = require('electron');
const { createPreloadApi } = require('./modules/bridge/preload-api');
const { createRendererModules } = require('./modules/bridge/renderer-modules');

const bridgeApi = createPreloadApi(ipcRenderer);

function exposeLegacyAliases(exposeFn, api) {
  exposeFn('squidrun', api);
  exposeFn('hivemind', api);
  exposeFn('squidrunAPI', api);
  exposeFn('api', api);
}

// Expose bridge on the preload's own window BEFORE loading renderer modules.
// Renderer modules run in the preload context and resolve the bridge via
// window.squidrun (through renderer-bridge.js). Without this, they can't
// find the bridge because contextBridge only exposes to the renderer page.
exposeLegacyAliases((name, value) => { window[name] = value; }, bridgeApi);

bridgeApi.rendererModules = createRendererModules();

if (process.contextIsolated) {
  exposeLegacyAliases((name, value) => contextBridge.exposeInMainWorld(name, value), bridgeApi);
}
