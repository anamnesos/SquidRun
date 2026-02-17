/**
 * Context Injection Manager
 * Handles reading and injecting context files for agents
 */

const path = require('path');
const fs = require('fs');
const log = require('../logger');
const { PANE_ROLES, WORKSPACE_PATH, resolveCoordPath } = require('../../config');
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
  if (id === '2') return 'builder';
  if (id === '5') return 'oracle';
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

function parseSessionFromText(content) {
  const text = String(content || '');
  const patterns = [
    /Session:\s*(\d+)/i,
    /\|\s*Session\s+(\d+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }

  return 0;
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => asNonEmptyString(item))
    .filter(Boolean);
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

  resolveCoordFile(relPath) {
    if (typeof resolveCoordPath === 'function') {
      return resolveCoordPath(relPath, {});
    }
    return path.join(WORKSPACE_PATH, relPath);
  }

  readAppStatusSession() {
    try {
      const filePath = this.resolveCoordFile('app-status.json');
      const raw = this.readFileIfExists(filePath);
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      const session = Number.parseInt(parsed?.session, 10);
      return Number.isInteger(session) && session > 0 ? session : 0;
    } catch {
      return 0;
    }
  }

  buildContextSnapshotFallback(paneId) {
    const filePath = this.resolveCoordFile(path.join('context-snapshots', `${paneId}.md`));
    const text = this.readFileIfExists(filePath);
    if (!text) return null;

    const session = parseSessionFromText(text);
    const completedMatch = text.match(/^Completed:\s*(.+)$/im);
    const nextMatch = text.match(/^Next:\s*(.+)$/im);
    const testsMatch = text.match(/^Tests:\s*(.+)$/im);

    const completed = completedMatch ? parseList(completedMatch[1]).slice(0, 3) : [];
    const next = nextMatch ? parseList(nextMatch[1]).slice(0, 3) : [];
    const tests = asNonEmptyString(testsMatch?.[1] || '');

    const lines = [];
    if (session > 0) lines.push(`- Session: ${session}`);
    completed.forEach((item) => lines.push(`- Completed: ${item}`));
    next.forEach((item) => lines.push(`- Next: ${item}`));
    if (tests) lines.push(`- Tests: ${tests}`);

    if (lines.length === 0) return null;
    return { session, lines };
  }

  async buildRuntimeMemorySnapshot(paneId) {
    const role = canonicalRoleFromPane(paneId);
    const parts = [];
    let ledgerLines = [];
    let ledgerSession = 0;
    let ledgerAvailable = false;

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
        const session = Number.parseInt(ledgerContext.session, 10);
        const completed = Array.isArray(ledgerContext.completed)
          ? ledgerContext.completed.slice(0, 3)
          : [];
        const notYetDone = Array.isArray(ledgerContext.not_yet_done)
          ? ledgerContext.not_yet_done.slice(0, 3)
          : [];

        if (Number.isInteger(session) && session > 0) {
          ledgerSession = session;
          ledgerLines.push(`- Session: ${session}`);
        }
        for (const item of completed) ledgerLines.push(`- Completed: ${asNonEmptyString(item)}`);
        for (const item of notYetDone) ledgerLines.push(`- Next: ${asNonEmptyString(item)}`);
        ledgerLines = ledgerLines.filter((line) => !line.endsWith(': '));
        ledgerAvailable = ledgerLines.length > 0;
      }
    } catch (err) {
      log.warn('ContextInjection', `Evidence Ledger runtime query failed: ${err.message}`);
    }

    const appStatusSession = this.readAppStatusSession();
    const snapshotFallback = this.buildContextSnapshotFallback(paneId);
    const snapshotSession = snapshotFallback?.session || 0;
    const ledgerIsStale = ledgerAvailable && ledgerSession > 0 && (
      (appStatusSession > 0 && appStatusSession > ledgerSession)
      || (snapshotSession > 0 && snapshotSession > ledgerSession)
    );

    if (ledgerAvailable && !ledgerIsStale) {
      parts.push('### Evidence Ledger\n' + ledgerLines.join('\n'));
    } else if (snapshotFallback?.lines?.length > 0) {
      parts.push('### Context Snapshot Fallback\n' + snapshotFallback.lines.join('\n'));
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
      builder: '## BUILDER',
      oracle: '## ORACLE',
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
      if (line.startsWith('**Builder / Oracle')) {
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

  _buildActiveProjectSection() {
    try {
      const state = this.ctx?.watcher?.readState?.();
      const project = typeof state?.project === 'string' ? state.project.trim() : '';
      if (!project) return '';

      const hivemindRoot = path.resolve(this.projectRoot);
      const normalizedProject = path.resolve(project);

      // Skip if project IS Hivemind itself (developer mode)
      if (normalizedProject === hivemindRoot) return '';

      const projectName = path.basename(normalizedProject);
      const lines = [
        '## Active Project',
        `- Project: ${projectName}`,
        `- Path: ${normalizedProject}`,
        `- Hivemind root: ${hivemindRoot}`,
        '',
        `Your working directory is the project above, NOT Hivemind. Hivemind coordination files (.hivemind/app-status.json, triggers, etc.) are at the Hivemind root path.`,
      ];
      return lines.join('\n');
    } catch (_) {
      return '';
    }
  }

  _buildUserProfileSection() {
    const settings = this.ctx.currentSettings || {};
    const name = asNonEmptyString(settings.userName);
    if (!name) return '';

    const level = asNonEmptyString(settings.userExperienceLevel) || 'intermediate';
    const style = asNonEmptyString(settings.userPreferredStyle) || 'balanced';

    const LEVEL_LABELS = {
      beginner: 'Beginner — explain concepts thoroughly, avoid jargon, provide examples',
      intermediate: 'Intermediate — standard explanations, some jargon is fine',
      advanced: 'Advanced — be concise, skip basic explanations',
      expert: 'Expert — minimal explanation, focus on implementation details',
    };
    const STYLE_LABELS = {
      detailed: 'Detailed — thorough, step-by-step explanations',
      balanced: 'Balanced — standard detail level',
      concise: 'Concise — brief and direct, minimal prose',
    };

    const lines = [
      '## User Profile',
      `- Name: ${name}`,
      `- Experience: ${LEVEL_LABELS[level] || level}`,
      `- Communication: ${STYLE_LABELS[style] || style}`,
      '',
      `Address the user as "${name}". Adjust your language and detail level to match their experience and communication preferences.`,
    ];

    return lines.join('\n');
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

    // 5. Active project context — explicit project awareness for agents
    const projectSection = this._buildActiveProjectSection();
    if (projectSection) {
      parts.push(projectSection);
    }

    // 6. User profile — name, experience level, communication preferences
    const userProfile = this._buildUserProfileSection();
    if (userProfile) {
      parts.push(userProfile);
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
