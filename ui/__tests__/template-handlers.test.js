/**
 * Template IPC Handler Tests
 * Target: Full coverage of template-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

// Mock agent-templates
jest.mock('../modules/agent-templates', () => ({
  getBuiltInTemplates: jest.fn(() => [
    { id: 'builtin-1', name: 'Built-in Template', builtIn: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  ]),
}));

const fs = require('fs');
const { getBuiltInTemplates } = require('../modules/agent-templates');
const { registerTemplateHandlers } = require('../modules/ipc/template-handlers');

describe('Template Handlers', () => {
  let harness;
  let ctx;
  let deps;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    deps = {
      loadSettings: jest.fn(() => ({ theme: 'dark', autoSave: true })),
      saveSettings: jest.fn(),
    };

    // Default: no existing templates
    fs.existsSync.mockReturnValue(false);

    registerTemplateHandlers(ctx, deps);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('save-template', () => {
    test('saves new template with full object', async () => {
      const template = {
        name: 'My Template',
        description: 'Test template',
        config: { theme: 'light' },
        paneProjects: { '1': '/project' },
      };

      const result = await harness.invoke('save-template', template);

      expect(result.success).toBe(true);
      expect(result.template.name).toBe('My Template');
      expect(result.template.id).toMatch(/^tmpl-\d+$/);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('saves template from string name', async () => {
      const result = await harness.invoke('save-template', 'Quick Save');

      expect(result.success).toBe(true);
      expect(result.template.name).toBe('Quick Save');
      expect(deps.loadSettings).toHaveBeenCalled();
    });

    test('returns error when name is missing', async () => {
      const result = await harness.invoke('save-template', { description: 'No name' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('name is required');
    });

    test('updates existing template', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-123', name: 'Existing', createdAt: '2026-01-01' },
      ]));

      const result = await harness.invoke('save-template', { name: 'Existing', config: { updated: true } });

      expect(result.success).toBe(true);
      expect(result.template.id).toBe('tmpl-123'); // Same ID
      expect(result.template.createdAt).toBe('2026-01-01'); // Same creation date
    });

    test('limits templates to 20', async () => {
      const existingTemplates = Array.from({ length: 25 }, (_, i) => ({
        id: `tmpl-${i}`,
        name: `Template ${i}`,
      }));
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(existingTemplates));

      await harness.invoke('save-template', { name: 'New Template' });

      const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(writtenData.length).toBeLessThanOrEqual(20);
    });

    test('saves atomically', async () => {
      await harness.invoke('save-template', { name: 'Test' });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        'utf-8'
      );
      expect(fs.renameSync).toHaveBeenCalled();
    });
  });

  describe('load-template', () => {
    test('loads template by ID', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-123', name: 'My Template', config: { theme: 'dark' }, paneProjects: { '1': '/proj' } },
      ]));

      const result = await harness.invoke('load-template', 'tmpl-123');

      expect(result.success).toBe(true);
      expect(result.template.id).toBe('tmpl-123');
      expect(deps.saveSettings).toHaveBeenCalled();
    });

    test('loads template by name', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-123', name: 'My Template', config: {} },
      ]));

      const result = await harness.invoke('load-template', 'My Template');

      expect(result.success).toBe(true);
      expect(result.name).toBe('My Template');
    });

    test('returns error when template not found', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('[]');

      const result = await harness.invoke('load-template', 'unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('merges paneProjects into settings', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-1', name: 'Test', paneProjects: { '1': '/new/path', '2': '/other' } },
      ]));
      deps.loadSettings.mockReturnValue({ paneProjects: { '1': '/old', '3': '/keep' } });

      await harness.invoke('load-template', 'tmpl-1');

      const savedSettings = deps.saveSettings.mock.calls[0][0];
      expect(savedSettings.paneProjects['1']).toBe('/new/path');
      expect(savedSettings.paneProjects['2']).toBe('/other');
      expect(savedSettings.paneProjects['3']).toBe('/keep');
    });

    test('merges config into settings', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-1', name: 'Test', config: { newSetting: true } },
      ]));

      await harness.invoke('load-template', 'tmpl-1');

      const savedSettings = deps.saveSettings.mock.calls[0][0];
      expect(savedSettings.newSetting).toBe(true);
    });

    test('sends template-loaded and settings-changed events', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-1', name: 'Test', config: {} },
      ]));

      await harness.invoke('load-template', 'tmpl-1');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('template-loaded', expect.any(Object));
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('settings-changed', expect.any(Object));
    });

    test('handles destroyed mainWindow', async () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-1', name: 'Test', config: {} },
      ]));

      const result = await harness.invoke('load-template', 'tmpl-1');

      expect(result.success).toBe(true);
      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('list-templates / get-templates', () => {
    test('returns built-in templates when no saved templates', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('list-templates');

      expect(result.success).toBe(true);
      expect(result.templates.length).toBe(1);
      expect(result.templates[0].id).toBe('builtin-1');
      expect(result.templates[0].source).toBe('builtin');
    });

    test('returns template summaries with saved templates', async () => {
      getBuiltInTemplates.mockReturnValue([]); // No built-ins for this test
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-1', name: 'Template 1', description: 'Desc', createdAt: '2026-01-01', updatedAt: '2026-01-02', config: { extra: 'data' } },
      ]));

      const result = await harness.invoke('list-templates');

      expect(result.templates.length).toBe(1);
      expect(result.templates[0].id).toBe('tmpl-1');
      expect(result.templates[0].name).toBe('Template 1');
      expect(result.templates[0].config).toBeUndefined(); // Not included in summary
    });

    test('get-templates returns same as list-templates', async () => {
      fs.existsSync.mockReturnValue(false);

      const listResult = await harness.invoke('list-templates');
      const getResult = await harness.invoke('get-templates');

      expect(listResult).toEqual(getResult);
    });

    test('deduplicates templates by ID (built-in takes precedence)', async () => {
      getBuiltInTemplates.mockReturnValue([
        { id: 'shared-id', name: 'Built-in Version', builtIn: true },
      ]);
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'shared-id', name: 'Saved Version' },
      ]));

      const result = await harness.invoke('list-templates');

      expect(result.templates.length).toBe(1);
      expect(result.templates[0].source).toBe('builtin');
    });
  });

  describe('get-template', () => {
    test('returns full template by ID', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-1', name: 'Test', config: { full: 'data' } },
      ]));

      const result = await harness.invoke('get-template', 'tmpl-1');

      expect(result.success).toBe(true);
      expect(result.template.config).toBeDefined();
    });

    test('returns error when not found', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('[]');

      const result = await harness.invoke('get-template', 'unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('delete-template', () => {
    test('deletes template by ID', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-1', name: 'To Delete' },
        { id: 'tmpl-2', name: 'Keep' },
      ]));

      const result = await harness.invoke('delete-template', 'tmpl-1');

      expect(result.success).toBe(true);
      const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(writtenData.length).toBe(1);
      expect(writtenData[0].id).toBe('tmpl-2');
    });

    test('deletes template by name', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-1', name: 'Delete Me' },
      ]));

      const result = await harness.invoke('delete-template', 'Delete Me');

      expect(result.success).toBe(true);
    });

    test('returns error when not found', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('[]');

      const result = await harness.invoke('delete-template', 'unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('cannot delete built-in template', async () => {
      getBuiltInTemplates.mockReturnValue([
        { id: 'builtin-1', name: 'Built-in Template', builtIn: true },
      ]);
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('[]');

      const result = await harness.invoke('delete-template', 'builtin-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot delete built-in');
    });
  });

  describe('error handling', () => {
    test('loadTemplates handles JSON parse error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('invalid json {{{');

      // list-templates calls loadTemplates internally
      const result = await harness.invoke('list-templates');

      // Should return built-ins when load fails
      expect(result.success).toBe(true);
    });

    test('saveTemplates handles write error', async () => {
      fs.existsSync.mockReturnValue(false);
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // save-template calls saveTemplates
      const result = await harness.invoke('save-template', { name: 'Test' });

      // Save still returns success but logs error internally
      expect(result.success).toBe(true);
    });
  });

  describe('export-template', () => {
    test('exports template by ID', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-1', name: 'Export Me', config: { key: 'value' }, createdAt: '2026-01-01' },
      ]));

      const result = await harness.invoke('export-template', 'tmpl-1');

      expect(result.success).toBe(true);
      expect(result.template.name).toBe('Export Me');
      expect(result.json).toContain('Export Me');
    });

    test('exports template with stripMeta option', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-1', name: 'Test', createdAt: '2026-01-01', updatedAt: '2026-01-02', source: 'user' },
      ]));

      const result = await harness.invoke('export-template', 'tmpl-1', { stripMeta: true });

      expect(result.success).toBe(true);
      expect(result.template.createdAt).toBeUndefined();
      expect(result.template.updatedAt).toBeUndefined();
      expect(result.template.source).toBeUndefined();
    });

    test('returns error when template not found', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('[]');

      const result = await harness.invoke('export-template', 'unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('export-templates', () => {
    test('exports all saved templates', async () => {
      getBuiltInTemplates.mockReturnValue([]);
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-1', name: 'Template 1' },
        { id: 'tmpl-2', name: 'Template 2' },
      ]));

      const result = await harness.invoke('export-templates');

      expect(result.success).toBe(true);
      expect(result.templates.length).toBe(2);
      expect(result.json).toContain('Template 1');
    });

    test('includes built-ins when requested', async () => {
      getBuiltInTemplates.mockReturnValue([
        { id: 'builtin-1', name: 'Built-in', builtIn: true },
      ]);
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('export-templates', { includeBuiltIns: true });

      expect(result.success).toBe(true);
      expect(result.templates.some(t => t.id === 'builtin-1')).toBe(true);
    });
  });

  describe('import-template', () => {
    test('imports single template object', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('import-template', {
        name: 'Imported Template',
        config: { theme: 'dark' },
      });

      expect(result.success).toBe(true);
      expect(result.imported.length).toBe(1);
      expect(result.imported[0].name).toBe('Imported Template');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('imports from JSON string', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('import-template', JSON.stringify({
        name: 'From String',
      }));

      expect(result.success).toBe(true);
      expect(result.imported[0].name).toBe('From String');
    });

    test('imports array of templates', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('import-template', [
        { name: 'Template A' },
        { name: 'Template B' },
      ]);

      expect(result.success).toBe(true);
      expect(result.imported.length).toBe(2);
    });

    test('imports from object with templates array', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('import-template', {
        templates: [{ name: 'Nested Template' }],
      });

      expect(result.success).toBe(true);
      expect(result.imported[0].name).toBe('Nested Template');
    });

    test('handles invalid JSON string', async () => {
      const result = await harness.invoke('import-template', 'not valid json {{{');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('skips templates without name', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('import-template', [
        { name: 'Valid' },
        { description: 'No name' },
        null,
      ]);

      expect(result.imported.length).toBe(1);
    });

    test('updates existing template on import', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { id: 'tmpl-existing', name: 'Existing', config: { old: true } },
      ]));

      const result = await harness.invoke('import-template', {
        id: 'tmpl-existing',
        name: 'Existing',
        config: { updated: true },
      });

      expect(result.success).toBe(true);
      const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(writtenData.length).toBe(1);
      expect(writtenData[0].config.updated).toBe(true);
    });

    test('limits imported templates to 50', async () => {
      const existingTemplates = Array.from({ length: 55 }, (_, i) => ({
        id: `tmpl-${i}`,
        name: `Template ${i}`,
      }));
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(existingTemplates));

      await harness.invoke('import-template', { name: 'New Import' });

      const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(writtenData.length).toBeLessThanOrEqual(50);
    });

    test('handles empty input', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('import-template', null);

      expect(result.success).toBe(true);
      expect(result.imported.length).toBe(0);
    });
  });

  describe('import-templates', () => {
    test('imports multiple templates (alias)', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('import-templates', [
        { name: 'Batch A' },
        { name: 'Batch B' },
      ]);

      expect(result.success).toBe(true);
      expect(result.imported.length).toBe(2);
    });

    test('handles parse error', async () => {
      const result = await harness.invoke('import-templates', '{invalid}');

      expect(result.success).toBe(false);
    });
  });
});
