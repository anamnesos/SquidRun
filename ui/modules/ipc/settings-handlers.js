/**
 * Settings IPC Handlers
 * Channels: get-settings, set-setting, get-all-settings
 */

function registerSettingsHandlers(ctx, deps) {
  const { ipcMain } = ctx;
  const { loadSettings, saveSettings } = deps;

  ipcMain.handle('get-settings', () => {
    return loadSettings();
  });

  ipcMain.handle('set-setting', (event, key, value) => {
    const settings = loadSettings();
    settings[key] = value;
    saveSettings(settings);

    if (key === 'watcherEnabled') {
      if (value) {
        ctx.watcher.startWatcher();
      } else {
        ctx.watcher.stopWatcher();
      }
    }

    return settings;
  });

  ipcMain.handle('get-all-settings', () => {
    return loadSettings();
  });
}

module.exports = { registerSettingsHandlers };
