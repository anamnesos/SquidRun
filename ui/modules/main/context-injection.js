/**
 * Context Injection Manager
 * Handles reading and injecting context files for agents
 */

const path = require('path');
const fs = require('fs');
const log = require('../logger');
const { PANE_ROLES } = require('../../config');
const { executeEvidenceLedgerOperation } = require('../ipc/evidence-ledger-handlers');
const teamMemory = require('../team-memory');

// Map model types to model notes files
const MODEL_NOTES = {
  'claude': 'claude-notes.md',
  'codex': 'codex-notes.md',
  'gemini': 'gemini-notes.md',
};

function canonicalRoleFromPane(paneId) {
  const id = String(paneId || '');
  if (id === '1') return 'architect';
  if (id === '2') return 'devops';
  if (id === '5') return 'analyst';
  return 'system';
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '';
}

function summarizeClaimStatement(statement, maxLength = 120) {
  const text = asNonEmptyString(statement).replace(/\s+/g, ' ');
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

class ContextInjectionManager {
  constructor(appContext) {
    this.ctx = appContext;
    this.projectRoot = path.join(__dirname, '..', '..', '..');
    this.docsDir = path.join(this.projectRoot, 'docs');
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

  async buildRuntimeMemorySnapshot(paneId) {
    const role = canonicalRoleFromPane(paneId);
    const parts = [];

    try {
      const ledgerContext = await executeEvidenceLedgerOperation(
        'get-context',
        { preferSnapshot: true },
        {
          source: {
            via: 'context-injection',
            role,
            paneId: String(paneId || ''),
          },
        }
      );

      if (ledgerContext?.ok !== false && ledgerContext && typeof ledgerContext === 'object') {
        const session = ledgerContext.session;
        const completed = Array.isArray(ledgerContext.completed)
          ? ledgerContext.completed.slice(0, 3)
          : [];
        const notYetDone = Array.isArray(ledgerContext.not_yet_done)
          ? ledgerContext.not_yet_done.slice(0, 3)
          : [];

        const ledgerLines = [];
        if (session !== null && session !== undefined) ledgerLines.push(`- Session: ${session}`);
        for (const item of completed) ledgerLines.push(`- Completed: ${asNonEmptyString(item)}`);
        for (const item of notYetDone) ledgerLines.push(`- Next: ${asNonEmptyString(item)}`);

        if (ledgerLines.length > 0) {
          parts.push('### Evidence Ledger\n' + ledgerLines.join('\n'));
        }
      }
    } catch (err) {
      log.warn('ContextInjection', `Evidence Ledger runtime query failed: ${err.message}`);
    }

    try {
      const claimResult = await teamMemory.executeTeamMemoryOperation(
        'query-claims',
        {
          owner: role,
          sessionsBack: 6,
          limit: 5,
        },
        {
          source: {
            via: 'context-injection',
            role,
            paneId: String(paneId || ''),
          },
        }
      );

      if (claimResult?.ok && Array.isArray(claimResult.claims) && claimResult.claims.length > 0) {
        const claimLines = claimResult.claims.slice(0, 3).map((claim, index) => {
          const statement = summarizeClaimStatement(claim.statement);
          const status = asNonEmptyString(claim.status) || 'proposed';
          const claimType = asNonEmptyString(claim.claimType || claim.claim_type) || 'fact';
          return `${index + 1}. (${status}/${claimType}) ${statement}`;
        });
        parts.push('### Team Memory\n' + claimLines.join('\n'));
      }
    } catch (err) {
      log.warn('ContextInjection', `Team Memory runtime query failed: ${err.message}`);
    }

    if (parts.length === 0) return '';
    return ['## Runtime Memory Snapshot', ...parts].join('\n\n');
  }

  /**
   * Scope ROLES.md to only include sections relevant to the given pane.
   * Strips other roles' ## sections and irrelevant startup baseline sub-sections.
   */
  _scopeRolesContent(fullContent, paneId) {
    const role = canonicalRoleFromPane(paneId);
    const roleSections = {
      architect: '## ARCHITECT',
      devops: '## DEVOPS',
      analyst: '## ANALYST',
    };
    const myRoleHeader = roleSections[role];
    if (!myRoleHeader) return fullContent;

    const allRoleHeaders = Object.values(roleSections);
    const isArchitect = role === 'architect';
    const lines = fullContent.split('\n');
    const result = [];
    let skipRoleSection = false;
    let skipStartupBlock = false;

    for (const line of lines) {
      // Top-level role section headers — keep only this pane's role
      const isRoleSectionHeader = allRoleHeaders.some(h => line.startsWith(h));
      if (isRoleSectionHeader) {
        skipRoleSection = !line.startsWith(myRoleHeader);
        skipStartupBlock = false; // reset on any section boundary
        if (!skipRoleSection) result.push(line);
        continue;
      }

      // Any non-role ## header ends both role section and startup block skips
      if (line.startsWith('## ')) {
        skipRoleSection = false;
        skipStartupBlock = false;
      }
      if (skipRoleSection) continue;

      // Scope startup baseline sub-sections (bold markers within ### Startup Baseline)
      if (line.startsWith('**Architect (pane 1):')) {
        skipStartupBlock = !isArchitect;
        if (!skipStartupBlock) result.push(line);
        continue;
      }
      if (line.startsWith('**DevOps / Analyst')) {
        skipStartupBlock = isArchitect;
        if (!skipStartupBlock) result.push(line);
        continue;
      }

      // Bold marker or section header ends startup block skip
      if (skipStartupBlock && (line.startsWith('**') || line.startsWith('#'))) {
        skipStartupBlock = false;
      }
      if (!skipStartupBlock) {
        result.push(line);
      }
    }

    return result.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  async buildContext(paneId, model) {
    const parts = [];

    // 1. Shared startup/communication baseline
    const basePath = path.join(this.docsDir, 'models', 'base-instructions.md');
    const baseContent = this.readFileIfExists(basePath);
    if (baseContent) {
      parts.push(baseContent);
    }

    // 2. Canonical role contract — scoped to this pane's role only
    const rolesPath = path.join(this.projectRoot, 'ROLES.md');
    const rolesContent = this.readFileIfExists(rolesPath);
    if (rolesContent) {
      parts.push(this._scopeRolesContent(rolesContent, paneId));
    }

    // 3. Model-specific runtime quirks
    const modelFile = MODEL_NOTES[model];
    if (modelFile) {
      const modelPath = path.join(this.docsDir, 'models', modelFile);
      const modelContent = this.readFileIfExists(modelPath);
      if (modelContent) {
        parts.push(modelContent);
      }
    }

    const runtimeSnapshot = await this.buildRuntimeMemorySnapshot(paneId);
    if (runtimeSnapshot) {
      parts.push(runtimeSnapshot);
    }

    return parts.join('\n\n---\n\n');
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
        const injectionText = await this.buildContext(id, model);

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
