/**
 * CLI Identity
 * Handles detection and reporting of CLI identities per pane
 */

const path = require('path');

class CliIdentityManager {
  constructor(appContext) {
    this.ctx = appContext;
  }

  extractBaseCommand(command) {
    if (!command || typeof command !== 'string') return '';
    const trimmed = command.trim();
    if (!trimmed) return '';

    let token = trimmed;
    const firstChar = trimmed[0];
    if (firstChar === '"' || firstChar === "'") {
      const end = trimmed.indexOf(firstChar, 1);
      token = end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
    } else {
      const match = trimmed.match(/^\S+/);
      token = match ? match[0] : trimmed;
    }

    let base = path.basename(token).toLowerCase();
    if (base.endsWith('.exe')) {
      base = base.slice(0, -4);
    }
    return base;
  }

  detectCliIdentity(command) {
    const base = this.extractBaseCommand(command);
    const normalized = (command || '').toLowerCase();
    if (!base && !normalized) return null;

    if (base.includes('claude') || normalized.includes('claude')) {
      return { label: 'Claude Code', provider: 'Anthropic' };
    }
    if (base.includes('codex') || normalized.includes('codex')) {
      return { label: 'Codex', provider: 'OpenAI' };
    }
    if (base.includes('gemini') || normalized.includes('gemini')) {
      return { label: 'Gemini', provider: 'Google' };
    }

    if (!base) return null;
    return { label: base };
  }

  getPaneCommandForIdentity(paneId) {
    const id = String(paneId);
    const paneCommands = this.ctx.currentSettings?.paneCommands || {}; 
    let cmd = (paneCommands[id] || '').trim();
    if (!cmd) cmd = 'claude';
    return cmd;
  }

  emitPaneCliIdentity(data) {
    if (!data) return;
    const id = data.paneId ? String(data.paneId) : '';
    if (!id) return;

    const payload = {
      paneId: id,
      label: data.label,
      provider: data.provider,
      version: data.version,
    };

    const prev = this.ctx.paneCliIdentity.get(id);
    if (prev &&
      prev.label === payload.label &&
      prev.provider === payload.provider &&
      prev.version === payload.version) {
      return;
    }

    this.ctx.paneCliIdentity.set(id, payload);

    if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
      this.ctx.mainWindow.webContents.send('pane-cli-identity', payload);
    }
  }

  inferAndEmitCliIdentity(paneId, command) {
    const identity = this.detectCliIdentity(command);
    if (!identity) return;
    this.emitPaneCliIdentity({ paneId, ...identity });
  }
}

module.exports = CliIdentityManager;
