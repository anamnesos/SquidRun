const fs = require('fs');
const path = require('path');
const log = require('../logger');

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
      params: { paneId: 'string - Pane identifier (1, 2, 5)', workingDir: 'string - Working directory path' },
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
    'export-template': {
      category: 'Templates',
      description: 'Export a template as JSON',
      params: { templateId: 'string', options: 'object?' },
      returns: '{ success, template, json }',
    },
    'export-templates': {
      category: 'Templates',
      description: 'Export templates as JSON array',
      params: { options: 'object?' },
      returns: '{ success, templates, json }',
    },
    'import-template': {
      category: 'Templates',
      description: 'Import a template from JSON',
      params: { template: 'object|string' },
      returns: '{ success, imported }',
    },
    'import-templates': {
      category: 'Templates',
      description: 'Import multiple templates from JSON',
      params: { templates: 'object|string' },
      returns: '{ success, imported }',
    },
    // Agent Sharing (Task #22)
    'agent-config-list': {
      category: 'Agent Sharing',
      description: 'List saved agent configs across projects',
      params: {},
      returns: '{ success, configs, count }',
    },
    'agent-config-get': {
      category: 'Agent Sharing',
      description: 'Get an agent config for a project',
      params: { projectId: 'string?', projectPath: 'string?' },
      returns: '{ success, config, entry }',
    },
    'agent-config-save': {
      category: 'Agent Sharing',
      description: 'Save current agent config for a project',
      params: { projectId: 'string?', projectPath: 'string?', includePaneProjects: 'boolean?' },
      returns: '{ success, entry }',
    },
    'agent-config-apply': {
      category: 'Agent Sharing',
      description: 'Apply an agent config to current settings',
      params: { projectId: 'string?', projectPath: 'string?', merge: 'boolean?', applyPaneProjects: 'boolean?' },
      returns: '{ success, settings, config }',
    },
    'agent-config-export': {
      category: 'Agent Sharing',
      description: 'Export an agent config to JSON (optional file save)',
      params: { projectId: 'string?', projectPath: 'string?', filePath: 'string?', useDialog: 'boolean?' },
      returns: '{ success, json, filePath }',
    },
    'agent-config-import': {
      category: 'Agent Sharing',
      description: 'Import an agent config from JSON (optional apply)',
      params: { json: 'string|object?', filePath: 'string?', apply: 'boolean?' },
      returns: '{ success, entry, applied }',
    },
    'agent-config-share': {
      category: 'Agent Sharing',
      description: 'Copy agent config from one project to another',
      params: { sourceProjectId: 'string?', sourceProjectPath: 'string?', targetProjectId: 'string?', targetProjectPath: 'string?' },
      returns: '{ success, entry }',
    },
    'agent-config-delete': {
      category: 'Agent Sharing',
      description: 'Delete a saved agent config for a project',
      params: { projectId: 'string?', projectPath: 'string?' },
      returns: '{ success, deleted }',
    },
    // Agent Skill Marketplace (Task #16)
    'skill-marketplace-list': {
      category: 'Agent Skills',
      description: 'List available skills in the marketplace',
      params: { filters: '{ search?, installed?, published?, category?, tag? }' },
      returns: '{ success, skills }',
    },
    'skill-marketplace-get': {
      category: 'Agent Skills',
      description: 'Get details for a specific skill',
      params: { skillId: 'string' },
      returns: '{ success, skill }',
    },
    'skill-marketplace-publish': {
      category: 'Agent Skills',
      description: 'Publish a skill to the marketplace',
      params: { skill: 'object', options: '{ install? }' },
      returns: '{ success, skill }',
    },
    'skill-marketplace-install': {
      category: 'Agent Skills',
      description: 'Install a marketplace skill',
      params: { skillId: 'string', options: 'object?' },
      returns: '{ success, skill }',
    },
    'skill-marketplace-uninstall': {
      category: 'Agent Skills',
      description: 'Uninstall a marketplace skill',
      params: { skillId: 'string' },
      returns: '{ success }',
    },
    'skill-marketplace-delete': {
      category: 'Agent Skills',
      description: 'Delete a user skill from the marketplace',
      params: { skillId: 'string' },
      returns: '{ success }',
    },
    'skill-marketplace-export': {
      category: 'Agent Skills',
      description: 'Export skills as JSON (optional file save)',
      params: { skillId: 'string?', includeBuiltIns: 'boolean?', useDialog: 'boolean?', filePath: 'string?' },
      returns: '{ success, skills, json }',
    },
    'skill-marketplace-import': {
      category: 'Agent Skills',
      description: 'Import skills from JSON (optional file picker)',
      params: { data: 'string|object?', useDialog: 'boolean?', install: 'boolean?' },
      returns: '{ success, imported, count }',
    },
    'skill-marketplace-assign': {
      category: 'Agent Skills',
      description: 'Assign skills to an agent',
      params: { agentId: 'string', skillIds: 'string[]', autoInstall: 'boolean?', replace: 'boolean?' },
      returns: '{ success, assignments }',
    },
    'skill-marketplace-unassign': {
      category: 'Agent Skills',
      description: 'Remove skill assignments from an agent',
      params: { agentId: 'string', skillIds: 'string[]?' },
      returns: '{ success, assignments }',
    },
    'skill-marketplace-assignments': {
      category: 'Agent Skills',
      description: 'Get all skill assignments by agent',
      params: {},
      returns: '{ success, assignments }',
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
    'get-agent-health': {
      category: 'Recovery',
      description: 'Get health status for all agents',
      params: {},
      returns: '{ success, agents: { paneId: { alive, status, lastActivity, stuckCount, recoveryStep, recovering } } }',
    },
    'get-recovery-status': {
      category: 'Recovery',
      description: 'Get raw recovery manager status for all panes',
      params: {},
      returns: '{ success, status }',
    },
    'get-health-snapshot': {
      category: 'Recovery',
      description: 'Get recovery health snapshot with terminals and playbooks',
      params: {},
      returns: '{ success, snapshot }',
    },
    'get-recovery-playbooks': {
      category: 'Recovery',
      description: 'Get recovery playbook definitions',
      params: {},
      returns: '{ success, playbooks }',
    },
    'trigger-recovery': {
      category: 'Recovery',
      description: 'Schedule a recovery restart for a pane',
      params: { paneId: 'string', reason: 'string?' },
      returns: '{ success } | { success: false, error }',
    },
    'reset-recovery-circuit': {
      category: 'Recovery',
      description: 'Reset circuit breaker for a pane',
      params: { paneId: 'string' },
      returns: '{ success } | { success: false, error }',
    },
    'retry-recovery-task': {
      category: 'Recovery',
      description: 'Retry last task context for a pane with backoff',
      params: { paneId: 'string', reason: 'string?' },
      returns: '{ success } | { success: false, error }',
    },
    'record-recovery-task': {
      category: 'Recovery',
      description: 'Record last task context for recovery replay',
      params: { paneId: 'string', message: 'string', meta: 'object?' },
      returns: '{ success } | { success: false, error }',
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
    'parse-task-input': {
      category: 'Smart Routing',
      description: 'Parse natural language task input into subtasks',
      params: { input: 'string' },
      returns: '{ success, subtasks, ambiguity }',
    },
    'route-task-input': {
      category: 'Smart Routing',
      description: 'Parse and route natural language task input',
      params: { input: 'string', options: '{ force?: boolean }' },
      returns: '{ success, routed, ambiguity }',
    },
    'get-schedules': {
      category: 'Scheduling',
      description: 'Get all scheduled tasks',
      params: {},
      returns: '{ success, schedules }',
    },
    'add-schedule': {
      category: 'Scheduling',
      description: 'Create a new schedule entry',
      params: '{ name?, type?, input?, runAt?, intervalMs?, cron?, timeZone?, eventName?, chainAfter? }',
      returns: '{ success, schedule }',
    },
    'update-schedule': {
      category: 'Scheduling',
      description: 'Update an existing schedule entry',
      params: '{ id, patch }',
      returns: '{ success, schedule }',
    },
    'delete-schedule': {
      category: 'Scheduling',
      description: 'Delete a schedule entry',
      params: { id: 'string' },
      returns: '{ success }',
    },
    'run-schedule-now': {
      category: 'Scheduling',
      description: 'Trigger a schedule immediately',
      params: { id: 'string' },
      returns: '{ success, results }',
    },
    'emit-schedule-event': {
      category: 'Scheduling',
      description: 'Emit an event-based schedule trigger',
      params: { eventName: 'string', payload: 'object?' },
      returns: '{ success, results }',
    },
    'complete-schedule': {
      category: 'Scheduling',
      description: 'Mark a chained schedule as completed',
      params: { id: 'string', status: 'string' },
      returns: '{ success }',
    },
    'trigger-handoff': {
      category: 'Smart Routing',
      description: 'Trigger automatic handoff to next agent',
      params: { fromPaneId: 'string', message: 'string' },
      returns: 'Handoff result',
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
    // Backups
    'backup-list': {
      category: 'Backup',
      description: 'List available backups',
      params: {},
      returns: '{ success, backups }',
    },
    'backup-create': {
      category: 'Backup',
      description: 'Create a backup now',
      params: { options: 'object?' },
      returns: '{ success, backup } | { success: false, error }',
    },
    'backup-restore': {
      category: 'Backup',
      description: 'Restore a backup by id',
      params: { backupId: 'string', options: 'object?' },
      returns: '{ success, restored, filesRestored } | { success: false, error }',
    },
    'backup-delete': {
      category: 'Backup',
      description: 'Delete a backup by id',
      params: { backupId: 'string' },
      returns: '{ success } | { success: false, error }',
    },
    'backup-get-config': {
      category: 'Backup',
      description: 'Get backup configuration',
      params: {},
      returns: '{ success, config }',
    },
    'backup-update-config': {
      category: 'Backup',
      description: 'Update backup configuration',
      params: { patch: 'object' },
      returns: '{ success, config }',
    },
    'backup-prune': {
      category: 'Backup',
      description: 'Prune old backups per retention rules',
      params: {},
      returns: '{ success, removed }',
    },
    // Plugins
    'list-plugins': {
      category: 'Plugins',
      description: 'List all available plugins',
      params: {},
      returns: '{ success, plugins }',
    },
    'enable-plugin': {
      category: 'Plugins',
      description: 'Enable a plugin',
      params: { pluginId: 'string' },
      returns: '{ success } | { success: false, error }',
    },
    'disable-plugin': {
      category: 'Plugins',
      description: 'Disable a plugin',
      params: { pluginId: 'string' },
      returns: '{ success } | { success: false, error }',
    },
    'reload-plugin': {
      category: 'Plugins',
      description: 'Reload a plugin (unload + load)',
      params: { pluginId: 'string' },
      returns: '{ success } | { success: false, error }',
    },
    'reload-plugins': {
      category: 'Plugins',
      description: 'Rescan and reload all plugins',
      params: {},
      returns: '{ success, plugins }',
    },
    'run-plugin-command': {
      category: 'Plugins',
      description: 'Run a plugin command by id',
      params: { pluginId: 'string', commandId: 'string', args: 'object?' },
      returns: '{ success, result } | { success: false, error }',
    },
  };

  function generateApiDocs() {
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
      log.info('API Docs', `Generated documentation: ${Object.keys(IPC_HANDLER_DOCS).length} handlers`);
    } catch (err) {
      log.error('API Docs', 'Error saving:', err.message);
    }

    return {
      success: true,
      path: API_DOCS_PATH,
      handlerCount: Object.keys(IPC_HANDLER_DOCS).length,
      categoryCount: Object.keys(categories).length,
    };
  }

  ipcMain.handle('generate-api-docs', () => {
    return generateApiDocs();
  });

  ipcMain.handle('get-api-docs', () => {
    try {
      if (fs.existsSync(API_DOCS_PATH)) {
        const content = fs.readFileSync(API_DOCS_PATH, 'utf-8');
        return { success: true, content, path: API_DOCS_PATH };
      }

      // Generate if doesn't exist
      const result = generateApiDocs();
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
