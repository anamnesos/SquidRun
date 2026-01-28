const fs = require('fs');
const path = require('path');

function registerApiDocsHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerApiDocsHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const API_DOCS_PATH = path.join(ctx.WORKSPACE_PATH, 'api-docs.md');

  const IPC_HANDLER_DOCS = {
    // PTY Handlers
    'pty-create': {
      category: 'PTY/Terminal',
      description: 'Create a new pseudo-terminal for a pane',
      params: { paneId: 'string - Pane identifier (1-6)', workingDir: 'string - Working directory path' },
      returns: '{ paneId, cwd, dryRun } | { error }',
    },
    'pty-write': {
      category: 'PTY/Terminal',
      description: 'Write data to a terminal',
      params: { paneId: 'string', data: 'string - Data to write' },
      returns: 'void',
    },
    'codex-exec': {
      category: 'PTY/Terminal',
      description: 'Run Codex exec (non-interactive) for a pane',
      params: { paneId: 'string', prompt: 'string - Prompt to send to codex exec' },
      returns: '{ success } | { success: false, error }',
    },
    'pty-resize': {
      category: 'PTY/Terminal',
      description: 'Resize a terminal',
      params: { paneId: 'string', cols: 'number', rows: 'number' },
      returns: 'void',
    },
    'pty-kill': {
      category: 'PTY/Terminal',
      description: 'Kill a terminal process',
      params: { paneId: 'string' },
      returns: 'void',
    },
    'spawn-claude': {
      category: 'PTY/Terminal',
      description: 'Spawn agent CLI in a terminal pane',
      params: { paneId: 'string', workingDir: 'string' },
      returns: '{ success, command, dryRun? } | { success: false, error }',
    },
    'get-claude-state': {
      category: 'PTY/Terminal',
      description: 'Get agent running state for all panes',
      params: {},
      returns: '{ paneId: "idle"|"starting"|"running" }',
    },
    'get-daemon-terminals': {
      category: 'PTY/Terminal',
      description: 'Get list of active daemon terminals',
      params: {},
      returns: 'Terminal[]',
    },
    // Shared Context
    'read-shared-context': {
      category: 'Shared Context',
      description: 'Read shared context file content',
      params: {},
      returns: '{ success, content } | { success: false, error }',
    },
    'write-shared-context': {
      category: 'Shared Context',
      description: 'Write content to shared context file',
      params: { content: 'string' },
      returns: '{ success } | { success: false, error }',
    },
    'get-shared-context-path': {
      category: 'Shared Context',
      description: 'Get the path to shared context file',
      params: {},
      returns: 'string - File path',
    },
    // State Management
    'get-state': {
      category: 'State',
      description: 'Get current workflow state',
      params: {},
      returns: 'State object',
    },
    'set-state': {
      category: 'State',
      description: 'Set workflow state',
      params: { newState: 'string' },
      returns: 'State object',
    },
    'trigger-sync': {
      category: 'State',
      description: 'Trigger sync notification to all agents',
      params: { file: 'string - File that changed (default: shared_context.md)' },
      returns: '{ success, file }',
    },
    'broadcast-message': {
      category: 'State',
      description: 'Broadcast a message to all agents',
      params: { message: 'string' },
      returns: 'Result object',
    },
    // Settings
    'get-settings': {
      category: 'Settings',
      description: 'Get current settings',
      params: {},
      returns: 'Settings object',
    },
    'set-setting': {
      category: 'Settings',
      description: 'Set a single setting value',
      params: { key: 'string', value: 'any' },
      returns: 'Settings object',
    },
    'get-all-settings': {
      category: 'Settings',
      description: 'Get all settings',
      params: {},
      returns: 'Settings object',
    },
    // Project Management
    'select-project': {
      category: 'Projects',
      description: 'Open folder picker to select a project',
      params: {},
      returns: '{ success, path, name } | { success: false, canceled }',
    },
    'get-project': {
      category: 'Projects',
      description: 'Get current project path',
      params: {},
      returns: 'string | null',
    },
    'get-recent-projects': {
      category: 'Projects',
      description: 'Get list of recent projects',
      params: {},
      returns: '{ success, projects: Project[] }',
    },
    'switch-project': {
      category: 'Projects',
      description: 'Switch to a different project',
      params: { projectPath: 'string' },
      returns: '{ success, path, name } | { success: false, error }',
    },
    // Per-Pane Projects (V5)
    'set-pane-project': {
      category: 'Multi-Project',
      description: 'Assign a project to a specific pane',
      params: { paneId: 'string', projectPath: 'string | null' },
      returns: '{ success, paneId, projectPath }',
    },
    'get-pane-project': {
      category: 'Multi-Project',
      description: 'Get project assigned to a pane',
      params: { paneId: 'string' },
      returns: '{ success, paneId, projectPath }',
    },
    'get-all-pane-projects': {
      category: 'Multi-Project',
      description: 'Get all pane project assignments',
      params: {},
      returns: '{ success, paneProjects }',
    },
    // Templates (V5)
    'save-template': {
      category: 'Templates',
      description: 'Save a configuration template',
      params: { template: '{ name, description?, config?, paneProjects? }' },
      returns: '{ success, template }',
    },
    'load-template': {
      category: 'Templates',
      description: 'Load and apply a template',
      params: { templateId: 'string' },
      returns: '{ success, template }',
    },
    'list-templates': {
      category: 'Templates',
      description: 'List all saved templates',
      params: {},
      returns: '{ success, templates: TemplateSummary[] }',
    },
    'delete-template': {
      category: 'Templates',
      description: 'Delete a template',
      params: { templateId: 'string' },
      returns: '{ success }',
    },
    // Agent Claims (V4)
    'claim-agent': {
      category: 'Agent Management',
      description: 'Claim an agent for a task',
      params: { paneId: 'string', taskId: 'string', description: 'string' },
      returns: 'Claim result',
    },
    'release-agent': {
      category: 'Agent Management',
      description: 'Release an agent claim',
      params: { paneId: 'string' },
      returns: 'Release result',
    },
    'get-claims': {
      category: 'Agent Management',
      description: 'Get all active agent claims',
      params: {},
      returns: 'Claims object',
    },
    'nudge-agent': {
      category: 'Agent Management',
      description: 'Send a nudge message to a stuck agent',
      params: { paneId: 'string', message: 'string?' },
      returns: '{ success, pane }',
    },
    'nudge-all-stuck': {
      category: 'Agent Management',
      description: 'Nudge all stuck agents',
      params: {},
      returns: '{ success, nudged: string[] }',
    },
    // Smart Routing (V6)
    'route-task': {
      category: 'Smart Routing',
      description: 'Route a task to the best agent',
      params: { taskType: 'string', message: 'string' },
      returns: 'Routing result',
    },
    'get-best-agent': {
      category: 'Smart Routing',
      description: 'Get the best agent for a task type',
      params: { taskType: 'string' },
      returns: 'Agent recommendation',
    },
    'trigger-handoff': {
      category: 'Smart Routing',
      description: 'Trigger automatic handoff to next agent',
      params: { fromPaneId: 'string', message: 'string' },
      returns: 'Handoff result',
    },
    // Conflict Resolution (V6)
    'request-file-access': {
      category: 'Conflict Resolution',
      description: 'Request exclusive access to a file',
      params: { filePath: 'string', paneId: 'string', operation: 'string' },
      returns: '{ granted, queued?, position? }',
    },
    'release-file-access': {
      category: 'Conflict Resolution',
      description: 'Release file access lock',
      params: { filePath: 'string', paneId: 'string' },
      returns: 'Release result',
    },
    'get-conflict-queue-status': {
      category: 'Conflict Resolution',
      description: 'Get current conflict queue status',
      params: {},
      returns: 'Queue status object',
    },
    // Learning (V6)
    'record-task-outcome': {
      category: 'Learning',
      description: 'Record task success/failure for learning',
      params: { taskType: 'string', paneId: 'string', success: 'boolean', timeMs: 'number' },
      returns: '{ success, successRate, newWeight }',
    },
    'get-learning-data': {
      category: 'Learning',
      description: 'Get all learning data and insights',
      params: {},
      returns: '{ taskTypes, routingWeights, insights }',
    },
    'get-best-agent-for-task': {
      category: 'Learning',
      description: 'Get best agent based on historical performance',
      params: { taskType: 'string' },
      returns: '{ bestAgent, reason }',
    },
    // Activity Log (V7)
    'get-activity-log': {
      category: 'Observability',
      description: 'Get activity log entries with optional filters',
      params: { filter: '{ type?, paneId?, since?, search? }' },
      returns: '{ success, entries, total }',
    },
    'log-activity': {
      category: 'Observability',
      description: 'Log a custom activity entry',
      params: { type: 'string', paneId: 'string', message: 'string', details: 'object' },
      returns: '{ success }',
    },
    'clear-activity-log': {
      category: 'Observability',
      description: 'Clear all activity log entries',
      params: {},
      returns: '{ success }',
    },
    // Validation (V7)
    'validate-output': {
      category: 'Quality',
      description: 'Validate text output for completeness',
      params: { text: 'string', options: '{ checkSyntax?, checkJson?, language? }' },
      returns: '{ valid, confidence, issues, warnings }',
    },
    'validate-file': {
      category: 'Quality',
      description: 'Validate a file for completeness',
      params: { filePath: 'string', options: 'object' },
      returns: '{ valid, confidence, issues, filePath }',
    },
    'check-completion-quality': {
      category: 'Quality',
      description: 'Check quality of claimed work',
      params: { paneId: 'string', claimedWork: 'string' },
      returns: '{ qualityScore, issues, blocked }',
    },
    // Rollback (V7)
    'create-checkpoint': {
      category: 'Rollback',
      description: 'Create a file checkpoint for rollback',
      params: { files: 'string[]', label: 'string' },
      returns: '{ success, checkpointId, files }',
    },
    'list-checkpoints': {
      category: 'Rollback',
      description: 'List all available checkpoints',
      params: {},
      returns: '{ success, checkpoints }',
    },
    'rollback-checkpoint': {
      category: 'Rollback',
      description: 'Restore files from a checkpoint',
      params: { checkpointId: 'string' },
      returns: '{ success, restored }',
    },
    'get-checkpoint-diff': {
      category: 'Rollback',
      description: 'Get diff between checkpoint and current files',
      params: { checkpointId: 'string' },
      returns: '{ success, diffs }',
    },
    // Test Execution (V8)
    'detect-test-framework': {
      category: 'Testing',
      description: 'Detect test framework in a project',
      params: { projectPath: 'string' },
      returns: '{ success, frameworks, recommended }',
    },
    'run-tests': {
      category: 'Testing',
      description: 'Run tests in a project',
      params: { projectPath: 'string', frameworkName: 'string?' },
      returns: '{ success, results }',
    },
    'get-test-results': {
      category: 'Testing',
      description: 'Get last test run results',
      params: {},
      returns: '{ success, results }',
    },
    'get-test-status': {
      category: 'Testing',
      description: 'Get current test run status',
      params: {},
      returns: '{ success, running, currentRun }',
    },
    // CI (V8)
    'run-pre-commit-checks': {
      category: 'CI',
      description: 'Run all pre-commit validation checks',
      params: { projectPath: 'string' },
      returns: '{ success, passed, checks }',
    },
    'get-ci-status': {
      category: 'CI',
      description: 'Get CI check status',
      params: {},
      returns: '{ success, status, enabled }',
    },
    'should-block-commit': {
      category: 'CI',
      description: 'Check if commit should be blocked',
      params: {},
      returns: '{ success, block, reason }',
    },
    // Usage Stats
    'get-usage-stats': {
      category: 'Usage',
      description: 'Get session usage statistics',
      params: {},
      returns: '{ totalSpawns, sessionTime, estimatedCost, ... }',
    },
    'reset-usage-stats': {
      category: 'Usage',
      description: 'Reset all usage statistics',
      params: {},
      returns: '{ success }',
    },
    'get-session-history': {
      category: 'Usage',
      description: 'Get session history',
      params: { limit: 'number' },
      returns: '{ success, history, total }',
    },
    // Performance (V5)
    'record-completion': {
      category: 'Performance',
      description: 'Record agent task completion',
      params: { paneId: 'string' },
      returns: '{ success, completions }',
    },
    'record-error': {
      category: 'Performance',
      description: 'Record agent error',
      params: { paneId: 'string' },
      returns: '{ success, errors }',
    },
    'get-performance': {
      category: 'Performance',
      description: 'Get agent performance metrics',
      params: {},
      returns: '{ success, agents, lastUpdated }',
    },
    // Screenshots
    'save-screenshot': {
      category: 'Screenshots',
      description: 'Save a screenshot',
      params: { base64Data: 'string', originalName: 'string' },
      returns: '{ success, filename, path }',
    },
    'list-screenshots': {
      category: 'Screenshots',
      description: 'List all screenshots',
      params: {},
      returns: '{ success, files }',
    },
    // Background Processes
    'spawn-process': {
      category: 'Processes',
      description: 'Spawn a background process',
      params: { command: 'string', args: 'string[]', cwd: 'string' },
      returns: '{ success, id, pid }',
    },
    'list-processes': {
      category: 'Processes',
      description: 'List all background processes',
      params: {},
      returns: '{ success, processes }',
    },
    'kill-process': {
      category: 'Processes',
      description: 'Kill a background process',
      params: { processId: 'string' },
      returns: '{ success }',
    },
  };

  ipcMain.handle('generate-api-docs', () => {
    const categories = {};

    // Group by category
    for (const [handler, doc] of Object.entries(IPC_HANDLER_DOCS)) {
      const cat = doc.category || 'Uncategorized';
      if (!categories[cat]) {
        categories[cat] = [];
      }
      categories[cat].push({ handler, ...doc });
    }

    // Generate markdown
    let markdown = `# Hivemind IPC API Documentation\n\n`;
    markdown += `Generated: ${new Date().toISOString()}\n\n`;
    markdown += `Total Handlers: ${Object.keys(IPC_HANDLER_DOCS).length}\n\n`;
    markdown += `---\n\n`;

    // Table of Contents
    markdown += `## Table of Contents\n\n`;
    for (const cat of Object.keys(categories).sort()) {
      markdown += `- [${cat}](#${cat.toLowerCase().replace(/[^a-z0-9]+/g, '-')})\n`;
    }
    markdown += `\n---\n\n`;

    // Each category
    for (const cat of Object.keys(categories).sort()) {
      markdown += `## ${cat}\n\n`;

      for (const doc of categories[cat]) {
        markdown += `### \`${doc.handler}\`\n\n`;
        markdown += `${doc.description}\n\n`;

        if (Object.keys(doc.params).length > 0) {
          markdown += `**Parameters:**\n`;
          for (const [param, desc] of Object.entries(doc.params)) {
            markdown += `- \`${param}\`: ${desc}\n`;
          }
          markdown += `\n`;
        } else {
          markdown += `**Parameters:** None\n\n`;
        }

        markdown += `**Returns:** \`${doc.returns}\`\n\n`;
        markdown += `---\n\n`;
      }
    }

    // Save to file
    try {
      fs.writeFileSync(API_DOCS_PATH, markdown, 'utf-8');
      console.log(`[API Docs] Generated documentation: ${Object.keys(IPC_HANDLER_DOCS).length} handlers`);
    } catch (err) {
      console.error('[API Docs] Error saving:', err.message);
    }

    return {
      success: true,
      path: API_DOCS_PATH,
      handlerCount: Object.keys(IPC_HANDLER_DOCS).length,
      categoryCount: Object.keys(categories).length,
    };
  });

  ipcMain.handle('get-api-docs', () => {
    try {
      if (fs.existsSync(API_DOCS_PATH)) {
        const content = fs.readFileSync(API_DOCS_PATH, 'utf-8');
        return { success: true, content, path: API_DOCS_PATH };
      }

      // Generate if doesn't exist
      const result = ipcMain._events['generate-api-docs']?.[0]?.();
      if (result?.success) {
        const content = fs.readFileSync(API_DOCS_PATH, 'utf-8');
        return { success: true, content, path: API_DOCS_PATH };
      }

      return { success: false, error: 'Documentation not generated' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-handler-doc', (event, handlerName) => {
    const doc = IPC_HANDLER_DOCS[handlerName];
    if (!doc) {
      return { success: false, error: 'Handler not found' };
    }
    return { success: true, handler: handlerName, ...doc };
  });

  ipcMain.handle('list-api-handlers', () => {
    const handlers = Object.entries(IPC_HANDLER_DOCS).map(([name, doc]) => ({
      name,
      category: doc.category,
      description: doc.description,
    }));

    return {
      success: true,
      handlers,
      total: handlers.length,
    };
  });

  ipcMain.handle('search-api-docs', (event, query) => {
    const queryLower = query.toLowerCase();
    const matches = [];

    for (const [handler, doc] of Object.entries(IPC_HANDLER_DOCS)) {
      const searchText = `${handler} ${doc.description} ${doc.category}`.toLowerCase();
      if (searchText.includes(queryLower)) {
        matches.push({ handler, ...doc });
      }
    }

    return {
      success: true,
      query,
      matches,
      count: matches.length,
    };
  });
}

module.exports = {
  registerApiDocsHandlers,
};
