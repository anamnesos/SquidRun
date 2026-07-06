const fs = require('fs');
const path = require('path');
const Module = require('module');
const { contextBridge, ipcRenderer } = require('electron');

function installLocalScriptShebangLoader() {
  const originalLoader = Module._extensions?.['.js'];
  if (typeof originalLoader !== 'function') return;
  if (Module._squidrunLocalScriptShebangLoaderInstalled) return;
  Module._squidrunLocalScriptShebangLoaderInstalled = true;

  const scriptsRoot = path.resolve(__dirname, 'scripts');
  Module._extensions['.js'] = function loadLocalScript(module, filename) {
    const resolved = path.resolve(filename);
    if (resolved.startsWith(`${scriptsRoot}${path.sep}`)) {
      const source = fs.readFileSync(resolved, 'utf8');
      if (source.startsWith('#!')) {
        module._compile(source.replace(/^#!.*(?:\r?\n|$)/, ''), resolved);
        return;
      }
    }
    return originalLoader(module, filename);
  };
}

installLocalScriptShebangLoader();

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

try {
  bridgeApi.rendererModules = createRendererModules();
  bridgeApi.rendererModulesLoadError = null;
} catch (error) {
  const message = error?.stack || error?.message || String(error || 'unknown_renderer_modules_error');
  console.error(`[Preload] rendererModules load failed:\n${message}`);
  bridgeApi.rendererModules = null;
  bridgeApi.rendererModulesLoadError = {
    message: error?.message || String(error || 'unknown_renderer_modules_error'),
    stack: error?.stack || null,
  };
}

if (process.contextIsolated) {
  exposeBridgeAliases((name, value) => contextBridge.exposeInMainWorld(name, value), bridgeApi);
}
