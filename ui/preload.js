const { contextBridge, ipcRenderer } = require('electron');
const { createPreloadApi } = require('./modules/bridge/preload-api');
const { createRendererModules } = require('./modules/bridge/renderer-modules');

const bridgeApi = createPreloadApi(ipcRenderer);
bridgeApi.rendererModules = createRendererModules();

function exposeLegacyAliases(exposeFn, api) {
  exposeFn('squidrun', api);
  exposeFn('hivemind', api);
  exposeFn('squidrunAPI', api);
  exposeFn('api', api);
}

if (process.contextIsolated) {
  exposeLegacyAliases((name, value) => contextBridge.exposeInMainWorld(name, value), bridgeApi);
} else {
  exposeLegacyAliases((name, value) => {
    window[name] = value;
  }, bridgeApi);
}
