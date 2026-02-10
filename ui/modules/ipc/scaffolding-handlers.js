/**
 * Project Scaffolding IPC Handlers
 * Task #12: Project Templates and Scaffolding
 *
 * Channels:
 *   - scaffolding-get-templates: List all available project templates
 *   - scaffolding-get-template: Get a specific template details
 *   - scaffolding-preview: Preview what a template would create
 *   - scaffolding-create: Create a new project from template
 *   - scaffolding-add-custom: Add a custom template
 *   - scaffolding-remove-custom: Remove a custom template
 *   - scaffolding-export-template: Export template to JSON
 *   - scaffolding-import-template: Import template from JSON
 *   - scaffolding-select-folder: Select folder for new project
 *   - scaffolding-get-categories: Get template categories
 */

const path = require('path');
const fs = require('fs');
const log = require('../logger');

let scaffolderModule = null;

function getScaffolder() {
  if (!scaffolderModule) {
    try {
      scaffolderModule = require('../scaffolding/project-scaffolder');
    } catch (err) {
      log.error('ScaffoldingHandlers', 'Failed to load scaffolder:', err.message);
      return null;
    }
  }
  return scaffolderModule.getProjectScaffolder();
}

function registerScaffoldingHandlers(ctx, deps) {
  const { ipcMain } = ctx;
  const { loadSettings, saveSettings } = deps;

  // === GET TEMPLATES ===

  ipcMain.handle('scaffolding-get-templates', (event, options = {}) => {
    try {
      const scaffolder = getScaffolder();
      if (!scaffolder) {
        return { success: false, error: 'Scaffolder not initialized' };
      }

      let templates = scaffolder.getTemplates();

      // Filter by category if specified
      if (options.category) {
        templates = templates.filter(t => t.category === options.category);
      }

      // Filter by source if specified
      if (options.source) {
        templates = templates.filter(t => t.source === options.source);
      }

      return {
        success: true,
        templates: templates.map(t => ({
          id: t.id,
          name: t.name,
          description: t.description,
          category: t.category,
          source: t.source,
        })),
        count: templates.length,
      };
    } catch (err) {
      log.error('ScaffoldingHandlers', 'Get templates failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === GET TEMPLATE DETAILS ===

  ipcMain.handle('scaffolding-get-template', (event, templateId) => {
    try {
      const scaffolder = getScaffolder();
      if (!scaffolder) {
        return { success: false, error: 'Scaffolder not initialized' };
      }

      const template = scaffolder.getTemplate(templateId);
      if (!template) {
        return { success: false, error: 'Template not found' };
      }

      return {
        success: true,
        template: {
          id: template.id,
          name: template.name,
          description: template.description,
          category: template.category,
          source: template.source,
          directories: template.directories || [],
          fileCount: Object.keys(template.files || {}).length,
        },
      };
    } catch (err) {
      log.error('ScaffoldingHandlers', 'Get template failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === PREVIEW TEMPLATE ===

  ipcMain.handle('scaffolding-preview', (event, templateId) => {
    try {
      const scaffolder = getScaffolder();
      if (!scaffolder) {
        return { success: false, error: 'Scaffolder not initialized' };
      }

      const preview = scaffolder.preview(templateId);
      return preview;
    } catch (err) {
      log.error('ScaffoldingHandlers', 'Preview failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === CREATE PROJECT ===

  ipcMain.handle('scaffolding-create', async (event, options) => {
    try {
      const scaffolder = getScaffolder();
      if (!scaffolder) {
        return { success: false, error: 'Scaffolder not initialized' };
      }

      const { targetPath, templateId, variables, scaffoldOptions } = options || {};

      if (!targetPath) {
        return { success: false, error: 'Target path is required' };
      }

      if (!templateId) {
        return { success: false, error: 'Template ID is required' };
      }

      // Create the project
      const result = await scaffolder.scaffold(
        targetPath,
        templateId,
        variables || {},
        scaffoldOptions || {}
      );

      if (result.success) {
        log.info('ScaffoldingHandlers', `Created project from ${templateId} at ${targetPath}`);

        // Add to recent projects
        const settings = loadSettings();
        const recentProjects = settings.recentProjects || [];
        const projectName = variables?.projectName || path.basename(targetPath);

        const existingIndex = recentProjects.findIndex(p => p.path === targetPath);
        if (existingIndex === -1) {
          recentProjects.unshift({
            name: projectName,
            path: targetPath,
            lastOpened: new Date().toISOString(),
            template: templateId,
          });
          settings.recentProjects = recentProjects.slice(0, 20);
          saveSettings(settings);
        }

        // Notify renderer
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          ctx.mainWindow.webContents.send('scaffolding-project-created', {
            path: targetPath,
            template: templateId,
            created: result.created,
          });
        }
      }

      return result;
    } catch (err) {
      log.error('ScaffoldingHandlers', 'Create project failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === SELECT FOLDER FOR NEW PROJECT ===

  ipcMain.handle('scaffolding-select-folder', async (event, options = {}) => {
    try {
      const result = await ctx.dialog.showOpenDialog(ctx.mainWindow, {
        title: options.title || 'Select Folder for New Project',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Select',
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const selectedPath = result.filePaths[0];

      // If projectName specified, create subdirectory
      let targetPath = selectedPath;
      if (options.projectName) {
        targetPath = path.join(selectedPath, options.projectName);
      }

      return {
        success: true,
        path: targetPath,
        parentPath: selectedPath,
      };
    } catch (err) {
      log.error('ScaffoldingHandlers', 'Select folder failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === CUSTOM TEMPLATES ===

  ipcMain.handle('scaffolding-add-custom', (event, templateData) => {
    try {
      const scaffolder = getScaffolder();
      if (!scaffolder) {
        return { success: false, error: 'Scaffolder not initialized' };
      }

      const { id, name, description, category, directories, files } = templateData || {};

      if (!name) {
        return { success: false, error: 'Template name is required' };
      }

      const templateId = id || `custom-${Date.now()}`;
      const template = scaffolder.addCustomTemplate(templateId, {
        name,
        description: description || '',
        category: category || 'custom',
        directories: directories || [],
        files: files || {},
      });

      log.info('ScaffoldingHandlers', `Added custom template: ${name}`);
      return { success: true, template: { id: templateId, ...template } };
    } catch (err) {
      log.error('ScaffoldingHandlers', 'Add custom template failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('scaffolding-remove-custom', (event, templateId) => {
    try {
      const scaffolder = getScaffolder();
      if (!scaffolder) {
        return { success: false, error: 'Scaffolder not initialized' };
      }

      const removed = scaffolder.removeCustomTemplate(templateId);
      if (!removed) {
        return { success: false, error: 'Template not found or is built-in' };
      }

      log.info('ScaffoldingHandlers', `Removed custom template: ${templateId}`);
      return { success: true };
    } catch (err) {
      log.error('ScaffoldingHandlers', 'Remove custom template failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === EXPORT/IMPORT ===

  ipcMain.handle('scaffolding-export-template', async (event, templateId) => {
    try {
      const scaffolder = getScaffolder();
      if (!scaffolder) {
        return { success: false, error: 'Scaffolder not initialized' };
      }

      const exportResult = scaffolder.exportTemplate(templateId);
      if (!exportResult.success) {
        return exportResult;
      }

      // Show save dialog
      const template = scaffolder.getTemplate(templateId);
      const result = await ctx.dialog.showSaveDialog(ctx.mainWindow, {
        title: 'Export Project Template',
        defaultPath: `${template.name.toLowerCase().replace(/\s+/g, '-')}-template.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });

      if (result.canceled) {
        return { success: false, canceled: true };
      }

      fs.writeFileSync(result.filePath, exportResult.json, 'utf-8');

      log.info('ScaffoldingHandlers', `Exported template ${templateId} to ${result.filePath}`);
      return { success: true, filePath: result.filePath };
    } catch (err) {
      log.error('ScaffoldingHandlers', 'Export template failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('scaffolding-import-template', async () => {
    try {
      const scaffolder = getScaffolder();
      if (!scaffolder) {
        return { success: false, error: 'Scaffolder not initialized' };
      }

      // Show open dialog
      const result = await ctx.dialog.showOpenDialog(ctx.mainWindow, {
        title: 'Import Project Template',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const content = fs.readFileSync(result.filePaths[0], 'utf-8');
      const importResult = scaffolder.importTemplate(content);

      if (importResult.success) {
        log.info('ScaffoldingHandlers', `Imported template from ${result.filePaths[0]}`);

        // Notify renderer
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          ctx.mainWindow.webContents.send('scaffolding-template-imported', {
            id: importResult.id,
          });
        }
      }

      return importResult;
    } catch (err) {
      log.error('ScaffoldingHandlers', 'Import template failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === GET CATEGORIES ===

  ipcMain.handle('scaffolding-get-categories', () => {
    try {
      const scaffolder = getScaffolder();
      if (!scaffolder) {
        return { success: false, error: 'Scaffolder not initialized' };
      }

      const templates = scaffolder.getTemplates();
      const categories = new Map();

      for (const template of templates) {
        const category = template.category || 'other';
        if (!categories.has(category)) {
          categories.set(category, { name: category, count: 0, templates: [] });
        }
        const cat = categories.get(category);
        cat.count++;
        cat.templates.push(template.id);
      }

      return {
        success: true,
        categories: Array.from(categories.values()),
      };
    } catch (err) {
      log.error('ScaffoldingHandlers', 'Get categories failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === CREATE FROM EXISTING PROJECT ===

  ipcMain.handle('scaffolding-create-from-existing', async (event, sourcePath, templateName) => {
    try {
      const scaffolder = getScaffolder();
      if (!scaffolder) {
        return { success: false, error: 'Scaffolder not initialized' };
      }

      if (!sourcePath || !fs.existsSync(sourcePath)) {
        return { success: false, error: 'Source path does not exist' };
      }

      if (!templateName) {
        return { success: false, error: 'Template name is required' };
      }

      // Scan directory structure
      const directories = [];
      const files = {};

      function scanDir(dir, prefix = '') {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          // Skip common directories
          if (['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build'].includes(entry.name)) {
            continue;
          }

          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            directories.push(relativePath);
            scanDir(path.join(dir, entry.name), relativePath);
          } else if (entry.isFile()) {
            // Read file content (limit size)
            const fullPath = path.join(dir, entry.name);
            const stats = fs.statSync(fullPath);

            if (stats.size < 100000) { // Skip files > 100KB
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                files[relativePath] = {
                  type: relativePath.endsWith('.json') ? 'json' : 'text',
                  content: relativePath.endsWith('.json') ? JSON.parse(content) : content,
                };
              } catch (e) {
                // Skip binary or unreadable files
              }
            }
          }
        }
      }

      scanDir(sourcePath);

      // Create custom template
      const templateId = `custom-${Date.now()}`;
      scaffolder.addCustomTemplate(templateId, {
        name: templateName,
        description: `Created from ${path.basename(sourcePath)}`,
        category: 'custom',
        directories,
        files,
      });

      log.info('ScaffoldingHandlers', `Created template "${templateName}" from ${sourcePath}`);
      return {
        success: true,
        templateId,
        directoryCount: directories.length,
        fileCount: Object.keys(files).length,
      };
    } catch (err) {
      log.error('ScaffoldingHandlers', 'Create from existing failed:', err.message);
      return { success: false, error: err.message };
    }
  });
}


function unregisterScaffoldingHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('scaffolding-get-templates');
    ipcMain.removeHandler('scaffolding-get-template');
    ipcMain.removeHandler('scaffolding-preview');
    ipcMain.removeHandler('scaffolding-create');
    ipcMain.removeHandler('scaffolding-select-folder');
    ipcMain.removeHandler('scaffolding-add-custom');
    ipcMain.removeHandler('scaffolding-remove-custom');
    ipcMain.removeHandler('scaffolding-export-template');
    ipcMain.removeHandler('scaffolding-import-template');
    ipcMain.removeHandler('scaffolding-get-categories');
    ipcMain.removeHandler('scaffolding-create-from-existing');
}

registerScaffoldingHandlers.unregister = unregisterScaffoldingHandlers;
module.exports = { registerScaffoldingHandlers };
