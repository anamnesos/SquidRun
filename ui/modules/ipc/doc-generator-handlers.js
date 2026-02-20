/**
 * Documentation Generator IPC Handlers - Task #23
 *
 * Channels:
 * - docs-generate-file: Generate docs for a single file
 * - docs-generate-directory: Generate docs for a directory
 * - docs-generate-project: Generate docs for entire project
 * - docs-preview: Preview generated documentation
 * - docs-export: Export documentation to files
 * - docs-get-config: Get documentation config
 * - docs-set-config: Update documentation config
 * - docs-get-coverage: Get documentation coverage stats
 * - docs-get-undocumented: Get list of undocumented items
 */

const path = require('path');
const fs = require('fs');

function registerDocGeneratorHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  if (!ipcMain || !WORKSPACE_PATH) return;

  // Lazy load doc generator
  let docGenerator = null;
  let generatorInstance = null;

  function getGenerator(options = {}) {
    if (!docGenerator) {
      docGenerator = require('../analysis/doc-generator');
    }
    if (!generatorInstance || options.refresh) {
      generatorInstance = docGenerator.createDocGenerator({
        projectName: options.projectName || 'SquidRun',
        version: options.version || '1.0.0',
        format: options.format || 'markdown',
        ...options,
      });
    }
    return generatorInstance;
  }

  // Documentation config storage
  const CONFIG_PATH = path.join(WORKSPACE_PATH, 'memory', '_docs-config.json');
  const CACHE_PATH = path.join(WORKSPACE_PATH, 'memory', '_docs-cache');

  // Default config
  let docsConfig = {
    projectName: 'SquidRun',
    version: '1.0.0',
    format: 'markdown',
    outputDir: './docs/api',
    includePrivate: false,
    recursive: true,
    ignore: ['node_modules', '__tests__', 'coverage', '.test.', '.spec.'],
    filePatterns: ['.js', '.ts', '.mjs'],
  };

  // Load config
  function loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        docsConfig = { ...docsConfig, ...data };
      }
    } catch (err) {
      console.error('[DocGenerator] Failed to load config:', err);
    }
  }

  // Save config
  function saveConfig() {
    try {
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(docsConfig, null, 2));
    } catch (err) {
      console.error('[DocGenerator] Failed to save config:', err);
    }
  }

  // Ensure cache directory exists
  function ensureCache() {
    if (!fs.existsSync(CACHE_PATH)) {
      fs.mkdirSync(CACHE_PATH, { recursive: true });
    }
  }

  // Initialize
  loadConfig();

  /**
   * Generate documentation for a single file
   */
  ipcMain.handle('docs-generate-file', async (event, payload = {}) => {
    const { filePath, format = docsConfig.format } = payload;

    if (!filePath) {
      return { success: false, error: 'File path required' };
    }

    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(WORKSPACE_PATH, '..', filePath);

    try {
      const generator = getGenerator({ format });
      const result = await generator.generateForFile(fullPath);

      // Cache result
      if (result.success) {
        ensureCache();
        const cacheFile = path.join(CACHE_PATH, `${path.basename(filePath)}.json`);
        fs.writeFileSync(cacheFile, JSON.stringify({
          timestamp: Date.now(),
          filePath: fullPath,
          ...result,
        }, null, 2));
      }

      return result;
    } catch (err) {
      console.error('[DocGenerator] Generate file error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Generate documentation for a directory
   */
  ipcMain.handle('docs-generate-directory', async (event, payload = {}) => {
    const { dirPath, recursive = docsConfig.recursive, format = docsConfig.format } = payload;

    const fullPath = dirPath
      ? (path.isAbsolute(dirPath) ? dirPath : path.join(WORKSPACE_PATH, '..', dirPath))
      : path.join(WORKSPACE_PATH, '..');

    try {
      const generator = getGenerator({ format });
      const ignorePattern = new RegExp(docsConfig.ignore.join('|'));
      const filePattern = new RegExp(`(${docsConfig.filePatterns.map(p => p.replace('.', '\\.')).join('|')})$`);

      const result = await generator.generateForDirectory(fullPath, {
        recursive,
        pattern: filePattern,
        ignore: ignorePattern,
      });

      return result;
    } catch (err) {
      console.error('[DocGenerator] Generate directory error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Generate documentation for entire project
   */
  ipcMain.handle('docs-generate-project', async (event, payload = {}) => {
    const { outputDir, format = docsConfig.format } = payload;
    const projectPath = path.join(WORKSPACE_PATH, '..');

    try {
      const generator = getGenerator({
        format,
        projectName: docsConfig.projectName,
        version: docsConfig.version,
      });

      const ignorePattern = new RegExp(docsConfig.ignore.join('|'));
      const filePattern = new RegExp(`(${docsConfig.filePatterns.map(p => p.replace('.', '\\.')).join('|')})$`);

      const result = await generator.generateForDirectory(projectPath, {
        recursive: true,
        pattern: filePattern,
        ignore: ignorePattern,
      });

      // Write to output directory if specified
      if (outputDir && result.success) {
        const outPath = path.isAbsolute(outputDir)
          ? outputDir
          : path.join(projectPath, outputDir);

        await generator.writeDocumentation(result, outPath);
        result.outputDir = outPath;
      }

      return result;
    } catch (err) {
      console.error('[DocGenerator] Generate project error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Preview generated documentation (returns markdown/html without saving)
   */
  ipcMain.handle('docs-preview', async (event, payload = {}) => {
    const { filePath, format = 'markdown' } = payload;

    if (!filePath) {
      return { success: false, error: 'File path required' };
    }

    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(WORKSPACE_PATH, '..', filePath);

    try {
      const generator = getGenerator({ format });
      const result = await generator.generateForFile(fullPath);

      if (!result.success) {
        return result;
      }

      return {
        success: true,
        preview: result.documentation,
        format,
        elements: result.elements.length,
        stats: result.stats,
      };
    } catch (err) {
      console.error('[DocGenerator] Preview error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Export documentation to files
   */
  ipcMain.handle('docs-export', async (event, payload = {}) => {
    const { dirPath, outputDir, format = docsConfig.format } = payload;

    const sourcePath = dirPath
      ? (path.isAbsolute(dirPath) ? dirPath : path.join(WORKSPACE_PATH, '..', dirPath))
      : path.join(WORKSPACE_PATH, '..');

    const outPath = outputDir
      ? (path.isAbsolute(outputDir) ? outputDir : path.join(WORKSPACE_PATH, '..', outputDir))
      : path.join(WORKSPACE_PATH, '..', docsConfig.outputDir);

    try {
      const generator = getGenerator({ format });
      const ignorePattern = new RegExp(docsConfig.ignore.join('|'));
      const filePattern = new RegExp(`(${docsConfig.filePatterns.map(p => p.replace('.', '\\.')).join('|')})$`);

      const result = await generator.generateForDirectory(sourcePath, {
        recursive: true,
        pattern: filePattern,
        ignore: ignorePattern,
      });

      if (!result.success) {
        return result;
      }

      await generator.writeDocumentation(result, outPath);

      return {
        success: true,
        outputDir: outPath,
        files: result.files,
        totalElements: result.totalElements,
      };
    } catch (err) {
      console.error('[DocGenerator] Export error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get documentation configuration
   */
  ipcMain.handle('docs-get-config', async () => {
    return { success: true, config: docsConfig };
  });

  /**
   * Update documentation configuration
   */
  ipcMain.handle('docs-set-config', async (event, payload = {}) => {
    const { config } = payload;

    if (!config) {
      return { success: false, error: 'Config required' };
    }

    docsConfig = { ...docsConfig, ...config };
    saveConfig();

    // Refresh generator with new config
    generatorInstance = null;

    return { success: true, config: docsConfig };
  });

  /**
   * Get documentation coverage statistics
   */
  ipcMain.handle('docs-get-coverage', async (event, payload = {}) => {
    const { dirPath } = payload;

    const fullPath = dirPath
      ? (path.isAbsolute(dirPath) ? dirPath : path.join(WORKSPACE_PATH, '..', dirPath))
      : path.join(WORKSPACE_PATH, '..');

    try {
      const generator = getGenerator();
      const ignorePattern = new RegExp(docsConfig.ignore.join('|'));
      const filePattern = new RegExp(`(${docsConfig.filePatterns.map(p => p.replace('.', '\\.')).join('|')})$`);

      const result = await generator.generateForDirectory(fullPath, {
        recursive: true,
        pattern: filePattern,
        ignore: ignorePattern,
      });

      if (!result.success) {
        return result;
      }

      const documented = result.stats.documented;
      const total = result.stats.functions + result.stats.classes;
      const coverage = total > 0 ? Math.round((documented / total) * 100) : 100;

      return {
        success: true,
        coverage,
        documented,
        undocumented: result.stats.undocumented,
        total,
        files: result.files,
        stats: result.stats,
      };
    } catch (err) {
      console.error('[DocGenerator] Coverage error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get list of undocumented items
   */
  ipcMain.handle('docs-get-undocumented', async (event, payload = {}) => {
    const { dirPath } = payload;

    const fullPath = dirPath
      ? (path.isAbsolute(dirPath) ? dirPath : path.join(WORKSPACE_PATH, '..', dirPath))
      : path.join(WORKSPACE_PATH, '..');

    try {
      const generator = getGenerator();
      const ignorePattern = new RegExp(docsConfig.ignore.join('|'));
      const filePattern = new RegExp(`(${docsConfig.filePatterns.map(p => p.replace('.', '\\.')).join('|')})$`);

      const result = await generator.generateForDirectory(fullPath, {
        recursive: true,
        pattern: filePattern,
        ignore: ignorePattern,
      });

      if (!result.success) {
        return result;
      }

      // Find undocumented items
      const undocumented = [];
      for (const fileResult of result.results) {
        for (const element of fileResult.elements) {
          if ((element.type === 'function' || element.type === 'class') && !element.description && element.exported) {
            undocumented.push({
              file: path.relative(fullPath, fileResult.filePath),
              name: element.name,
              type: element.type,
              line: element.line,
            });
          }
        }
      }

      return {
        success: true,
        undocumented,
        count: undocumented.length,
      };
    } catch (err) {
      console.error('[DocGenerator] Undocumented error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Generate docs for specific IPC module (helpful for this project)
   */
  ipcMain.handle('docs-generate-ipc', async (event, payload = {}) => {
    const { format = 'markdown' } = payload;
    const ipcPath = path.join(WORKSPACE_PATH, '..', 'ui', 'modules', 'ipc');

    try {
      const generator = getGenerator({ format, projectName: 'SquidRun IPC Handlers' });
      const result = await generator.generateForDirectory(ipcPath, {
        recursive: false,
        pattern: /\.js$/,
        ignore: /\.test\.|\.spec\./,
      });

      return result;
    } catch (err) {
      console.error('[DocGenerator] IPC docs error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get cached documentation
   */
  ipcMain.handle('docs-get-cached', async (event, payload = {}) => {
    const { filePath } = payload;

    try {
      ensureCache();

      if (filePath) {
        const cacheFile = path.join(CACHE_PATH, `${path.basename(filePath)}.json`);
        if (fs.existsSync(cacheFile)) {
          const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
          return { success: true, cached: data };
        }
        return { success: false, error: 'Not cached' };
      }

      // List all cached files
      const files = fs.readdirSync(CACHE_PATH).filter(f => f.endsWith('.json'));
      const cached = files.map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(CACHE_PATH, f), 'utf-8'));
          return {
            file: f.replace('.json', ''),
            timestamp: data.timestamp,
            elements: data.elements?.length || 0,
          };
        } catch {
          return null;
        }
      }).filter(Boolean);

      return { success: true, cached };
    } catch (err) {
      console.error('[DocGenerator] Cache error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Clear documentation cache
   */
  ipcMain.handle('docs-clear-cache', async () => {
    try {
      if (fs.existsSync(CACHE_PATH)) {
        const files = fs.readdirSync(CACHE_PATH);
        for (const file of files) {
          fs.unlinkSync(path.join(CACHE_PATH, file));
        }
      }
      return { success: true };
    } catch (err) {
      console.error('[DocGenerator] Clear cache error:', err);
      return { success: false, error: err.message };
    }
  });
}


function unregisterDocGeneratorHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('docs-generate-file');
    ipcMain.removeHandler('docs-generate-directory');
    ipcMain.removeHandler('docs-generate-project');
    ipcMain.removeHandler('docs-preview');
    ipcMain.removeHandler('docs-export');
    ipcMain.removeHandler('docs-get-config');
    ipcMain.removeHandler('docs-set-config');
    ipcMain.removeHandler('docs-get-coverage');
    ipcMain.removeHandler('docs-get-undocumented');
    ipcMain.removeHandler('docs-generate-ipc');
    ipcMain.removeHandler('docs-get-cached');
    ipcMain.removeHandler('docs-clear-cache');
}

registerDocGeneratorHandlers.unregister = unregisterDocGeneratorHandlers;
module.exports = { registerDocGeneratorHandlers };
