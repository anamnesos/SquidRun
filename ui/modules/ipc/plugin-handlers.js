/**
 * Plugin IPC Handlers
 * Channels: list-plugins, enable-plugin, disable-plugin, reload-plugin,
 *           run-plugin-command, reload-plugins
 */

function registerPluginHandlers(ctx, deps) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerPluginHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const getManager = () => deps?.pluginManager || ctx.pluginManager;

  ipcMain.handle('list-plugins', () => {
    const manager = getManager();
    if (!manager) return { success: false, error: 'Plugin manager unavailable' };
    return { success: true, plugins: manager.listPlugins() };
  });

  ipcMain.handle('enable-plugin', (event, pluginId) => {
    const manager = getManager();
    if (!manager) return { success: false, error: 'Plugin manager unavailable' };
    if (!pluginId) return { success: false, error: 'pluginId required' };
    return manager.enablePlugin(String(pluginId));
  });

  ipcMain.handle('disable-plugin', (event, pluginId) => {
    const manager = getManager();
    if (!manager) return { success: false, error: 'Plugin manager unavailable' };
    if (!pluginId) return { success: false, error: 'pluginId required' };
    return manager.disablePlugin(String(pluginId));
  });

  ipcMain.handle('reload-plugin', (event, pluginId) => {
    const manager = getManager();
    if (!manager) return { success: false, error: 'Plugin manager unavailable' };
    if (!pluginId) return { success: false, error: 'pluginId required' };
    return manager.reloadPlugin(String(pluginId));
  });

  ipcMain.handle('reload-plugins', () => {
    const manager = getManager();
    if (!manager) return { success: false, error: 'Plugin manager unavailable' };
    const plugins = manager.loadAll();
    return { success: true, plugins };
  });

  ipcMain.handle('run-plugin-command', async (event, pluginId, commandId, args = {}) => {
    const manager = getManager();
    if (!manager) return { success: false, error: 'Plugin manager unavailable' };
    if (!pluginId || !commandId) {
      return { success: false, error: 'pluginId and commandId required' };
    }
    return manager.runCommand(String(pluginId), String(commandId), args);
  });
}

module.exports = { registerPluginHandlers };
