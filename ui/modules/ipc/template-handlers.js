/**
 * Template IPC Handlers
 * Channels: save-template, load-template, list-templates, get-template, delete-template
 */

const fs = require('fs');
const path = require('path');

function registerTemplateHandlers(ctx, deps) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  const { loadSettings, saveSettings } = deps;

  const TEMPLATES_FILE_PATH = path.join(WORKSPACE_PATH, 'templates.json');

  function loadTemplates() {
    try {
      if (fs.existsSync(TEMPLATES_FILE_PATH)) {
        const content = fs.readFileSync(TEMPLATES_FILE_PATH, 'utf-8');
        return JSON.parse(content);
      }
    } catch (err) {
      console.error('[Templates] Error loading:', err.message);
    }
    return [];
  }

  function saveTemplates(templates) {
    try {
      const tempPath = TEMPLATES_FILE_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(templates, null, 2), 'utf-8');
      fs.renameSync(tempPath, TEMPLATES_FILE_PATH);
    } catch (err) {
      console.error('[Templates] Error saving:', err.message);
    }
  }

  ipcMain.handle('save-template', (event, template) => {
    if (!template.name) {
      return { success: false, error: 'Template name is required' };
    }

    const templates = loadTemplates();
    const existingIndex = templates.findIndex(t => t.name === template.name);

    const newTemplate = {
      id: existingIndex >= 0 ? templates[existingIndex].id : `tmpl-${Date.now()}`,
      name: template.name,
      description: template.description || '',
      config: template.config || {},
      paneProjects: template.paneProjects || {},
      createdAt: existingIndex >= 0 ? templates[existingIndex].createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      templates[existingIndex] = newTemplate;
    } else {
      templates.push(newTemplate);
    }

    if (templates.length > 20) {
      templates.splice(0, templates.length - 20);
    }

    saveTemplates(templates);
    console.log(`[Templates] Saved template: ${template.name}`);

    return { success: true, template: newTemplate };
  });

  ipcMain.handle('load-template', (event, templateId) => {
    const templates = loadTemplates();
    const template = templates.find(t => t.id === templateId || t.name === templateId);

    if (!template) {
      return { success: false, error: 'Template not found' };
    }

    const settings = loadSettings();

    if (template.paneProjects) {
      settings.paneProjects = { ...settings.paneProjects, ...template.paneProjects };
    }

    if (template.config) {
      Object.assign(settings, template.config);
    }

    saveSettings(settings);

    console.log(`[Templates] Loaded template: ${template.name}`);

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('template-loaded', template);
      ctx.mainWindow.webContents.send('settings-changed', settings);
    }

    return { success: true, template };
  });

  ipcMain.handle('list-templates', () => {
    const templates = loadTemplates();
    return {
      success: true,
      templates: templates.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    };
  });

  ipcMain.handle('get-template', (event, templateId) => {
    const templates = loadTemplates();
    const template = templates.find(t => t.id === templateId || t.name === templateId);

    if (!template) {
      return { success: false, error: 'Template not found' };
    }

    return { success: true, template };
  });

  ipcMain.handle('delete-template', (event, templateId) => {
    const templates = loadTemplates();
    const index = templates.findIndex(t => t.id === templateId || t.name === templateId);

    if (index < 0) {
      return { success: false, error: 'Template not found' };
    }

    const deleted = templates.splice(index, 1)[0];
    saveTemplates(templates);

    console.log(`[Templates] Deleted template: ${deleted.name}`);
    return { success: true };
  });
}

module.exports = { registerTemplateHandlers };
