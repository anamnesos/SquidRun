/**
 * Template IPC Handlers
 * Channels: save-template, load-template, list-templates, get-templates, get-template, delete-template
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { getBuiltInTemplates } = require('../agent-templates');

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
      log.error('Templates', 'Error loading:', err.message);
    }
    return [];
  }

  function getAllTemplates() {
    const saved = loadTemplates();
    const builtIns = getBuiltInTemplates();
    const seen = new Set();
    const combined = [];

    builtIns.forEach(template => {
      if (seen.has(template.id)) return;
      seen.add(template.id);
      combined.push({ ...template, source: 'builtin' });
    });

    saved.forEach(template => {
      if (seen.has(template.id)) return;
      seen.add(template.id);
      combined.push({ ...template, source: template.source || 'user' });
    });

    return combined;
  }

  function saveTemplates(templates) {
    try {
      const tempPath = TEMPLATES_FILE_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(templates, null, 2), 'utf-8');
      fs.renameSync(tempPath, TEMPLATES_FILE_PATH);
    } catch (err) {
      log.error('Templates', 'Error saving:', err.message);
    }
  }

  function normalizeTemplateInput(templateInput) {
    if (typeof templateInput === 'string') {
      const settings = loadSettings();
      const { paneProjects, ...config } = settings || {};
      return { name: templateInput, config, paneProjects };
    }
    return templateInput;
  }

  function listTemplates() {
    const templates = getAllTemplates();
    return {
      success: true,
      templates: templates.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        source: t.source || (t.builtIn ? 'builtin' : 'user'),
      })),
    };
  }

  function findTemplate(templateId) {
    const templates = getAllTemplates();
    return templates.find(t => t.id === templateId || t.name === templateId) || null;
  }

  ipcMain.handle('save-template', (event, templateInput) => {
    const template = normalizeTemplateInput(templateInput);
    if (!template || !template.name) {
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
    log.info('Templates', `Saved template: ${template.name}`);

    return { success: true, template: newTemplate };
  });

  ipcMain.handle('load-template', (event, templateId) => {
    const template = findTemplate(templateId);

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

    log.info('Templates', `Loaded template: ${template.name}`);

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('template-loaded', template);
      ctx.mainWindow.webContents.send('settings-changed', settings);
    }

    return { success: true, template, name: template.name };
  });

  ipcMain.handle('list-templates', () => listTemplates());
  ipcMain.handle('get-templates', () => listTemplates());

  ipcMain.handle('get-template', (event, templateId) => {
    const template = findTemplate(templateId);

    if (!template) {
      return { success: false, error: 'Template not found' };
    }

    return { success: true, template };
  });

  ipcMain.handle('delete-template', (event, templateId) => {
    const templates = loadTemplates();
    const builtIn = getBuiltInTemplates().find(t => t.id === templateId || t.name === templateId);
    if (builtIn) {
      return { success: false, error: 'Cannot delete built-in template' };
    }
    const index = templates.findIndex(t => t.id === templateId || t.name === templateId);

    if (index < 0) {
      return { success: false, error: 'Template not found' };
    }

    const deleted = templates.splice(index, 1)[0];
    saveTemplates(templates);

    log.info('Templates', `Deleted template: ${deleted.name}`);
    return { success: true };
  });

  ipcMain.handle('export-template', (event, templateId, options = {}) => {
    const template = findTemplate(templateId);
    if (!template) return { success: false, error: 'Template not found' };
    const payload = { ...template };
    if (options && options.stripMeta) {
      delete payload.updatedAt;
      delete payload.createdAt;
      delete payload.source;
      delete payload.builtIn;
    }
    return {
      success: true,
      template: payload,
      json: JSON.stringify(payload, null, 2),
    };
  });

  ipcMain.handle('export-templates', (event, options = {}) => {
    const includeBuiltIns = options.includeBuiltIns === true;
    const templates = includeBuiltIns ? getAllTemplates() : loadTemplates();
    return {
      success: true,
      templates,
      json: JSON.stringify(templates, null, 2),
    };
  });

  function normalizeImportedTemplates(input) {
    let payload = input;
    if (typeof payload === 'string') {
      payload = JSON.parse(payload);
    }
    if (payload && payload.templates && Array.isArray(payload.templates)) {
      return payload.templates;
    }
    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload && typeof payload === 'object') {
      return [payload];
    }
    return [];
  }

  function storeImportedTemplates(items) {
    const templates = loadTemplates();
    const imported = [];
    items.forEach(item => {
      if (!item || !item.name) return;
      const template = {
        id: item.id || `tmpl-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        name: item.name,
        description: item.description || '',
        config: item.config || {},
        paneProjects: item.paneProjects || {},
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: item.source || 'imported',
      };
      const existingIndex = templates.findIndex(t => t.id === template.id || t.name === template.name);
      if (existingIndex >= 0) {
        templates[existingIndex] = template;
      } else {
        templates.push(template);
      }
      imported.push(template);
    });
    if (templates.length > 50) {
      templates.splice(0, templates.length - 50);
    }
    saveTemplates(templates);
    return imported;
  }

  ipcMain.handle('import-template', (event, templateInput) => {
    try {
      const items = normalizeImportedTemplates(templateInput);
      const imported = storeImportedTemplates(items);
      return { success: true, imported };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('import-templates', (event, templateInput) => {
    try {
      const items = normalizeImportedTemplates(templateInput);
      const imported = storeImportedTemplates(items);
      return { success: true, imported };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

function unregisterTemplateHandlers(ctx) {
  const { ipcMain } = ctx;
  if (ipcMain) {
    ipcMain.removeHandler('save-template');
    ipcMain.removeHandler('load-template');
    ipcMain.removeHandler('list-templates');
    ipcMain.removeHandler('get-templates');
    ipcMain.removeHandler('get-template');
    ipcMain.removeHandler('delete-template');
    ipcMain.removeHandler('export-template');
    ipcMain.removeHandler('export-templates');
    ipcMain.removeHandler('import-template');
    ipcMain.removeHandler('import-templates');
  }
}

registerTemplateHandlers.unregister = unregisterTemplateHandlers;

module.exports = { registerTemplateHandlers };
