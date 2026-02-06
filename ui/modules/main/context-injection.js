/**
 * Context Injection Manager
 * Handles reading and injecting context files for agents
 *
 * Supports two modes:
 * 1. Modular (new): Combines base-instructions.md + role file + model notes
 * 2. Legacy: Reads CLAUDE.md, AGENTS.md, or GEMINI.md from instance directory
 */

const path = require('path');
const fs = require('fs');
const log = require('../logger');
const { INSTANCE_DIRS, PANE_ROLES } = require('../../config');

// Map pane IDs to role file names
const ROLE_FILES = {
  '1': 'ARCH.md',
  '2': 'INFRA.md',
  '4': 'BACK.md',
  '5': 'ANA.md',
};

// Map model types to model notes files
const MODEL_NOTES = {
  'claude': 'claude-notes.md',
  'codex': 'codex-notes.md',
  'gemini': 'gemini-notes.md',
};

class ContextInjectionManager {
  constructor(appContext) {
    this.ctx = appContext;
    // Docs directory for modular files
    this.docsDir = path.join(__dirname, '..', '..', '..', 'docs');
  }

  /**
   * Read a file if it exists, return empty string otherwise
   */
  readFileIfExists(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
    } catch (err) {
      log.warn('ContextInjection', `Failed to read ${filePath}: ${err.message}`);
    }
    return '';
  }

  /**
   * Build modular context from base + role + model notes
   */
  buildModularContext(paneId, model) {
    const parts = [];

    // 1. Base instructions (shared by all)
    const basePath = path.join(this.docsDir, 'models', 'base-instructions.md');
    const baseContent = this.readFileIfExists(basePath);
    if (baseContent) {
      parts.push(baseContent);
    }

    // 2. Role-specific file
    const roleFile = ROLE_FILES[paneId];
    if (roleFile) {
      const rolePath = path.join(this.docsDir, 'roles', roleFile);
      const roleContent = this.readFileIfExists(rolePath);
      if (roleContent) {
        parts.push(roleContent);
      }
    }

    // 3. Model-specific notes
    const modelFile = MODEL_NOTES[model];
    if (modelFile) {
      const modelPath = path.join(this.docsDir, 'models', modelFile);
      const modelContent = this.readFileIfExists(modelPath);
      if (modelContent) {
        parts.push(modelContent);
      }
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * Build legacy context from instance directory files
   */
  buildLegacyContext(paneId, model) {
    const instanceDir = INSTANCE_DIRS[paneId];
    if (!instanceDir || !fs.existsSync(instanceDir)) {
      return '';
    }

    const claudePath = path.join(instanceDir, 'CLAUDE.md');
    const agentsPath = path.join(instanceDir, 'AGENTS.md');
    const geminiPath = path.join(instanceDir, 'GEMINI.md');

    // Select file based on model type
    if (model === 'gemini') {
      return this.readFileIfExists(geminiPath) || this.readFileIfExists(claudePath);
    } else if (model === 'codex') {
      return this.readFileIfExists(agentsPath) || this.readFileIfExists(claudePath);
    } else {
      return this.readFileIfExists(claudePath);
    }
  }

  /**
   * Inject context for a specific pane
   * @param {string} paneId - Pane ID
   * @param {string} model - Model type ('claude', 'codex', 'gemini')
   * @param {number} delay - Delay in ms before injection
   */
  async injectContext(paneId, model, delay = 5000) {
    const id = String(paneId);

    // Schedule injection
    setTimeout(async () => {
      try {
        // Try modular context first
        let injectionText = this.buildModularContext(id, model);

        // Fall back to legacy if modular files don't exist
        if (!injectionText.trim()) {
          log.info('ContextInjection', `No modular context for pane ${id}, using legacy`);
          injectionText = this.buildLegacyContext(id, model);
        }

        if (injectionText && this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
          const role = PANE_ROLES[id] || `Pane ${id}`;
          const header = `\r\n# HIVEMIND CONTEXT INJECTION: ${role} configuration\r\n`;

          log.info('ContextInjection', `Injecting ${injectionText.length} bytes of context to pane ${id} (${model})`);

          this.ctx.mainWindow.webContents.send('inject-message', {
            panes: [id],
            message: header + injectionText + '\r',
            meta: { source: 'auto-context-injection' }
          });
        } else if (!injectionText) {
          log.warn('ContextInjection', `No context found for pane ${id}`);
        }
      } catch (err) {
        log.error('ContextInjection', `Context injection failed for pane ${id}:`, err.message);
      }
    }, delay);
  }
}

module.exports = ContextInjectionManager;
