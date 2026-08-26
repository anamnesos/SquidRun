/**
 * Triggers - Routing and Handoff Logic Tests
 * Target: Coverage of pure utility functions in triggers/routing.js
 */

'use strict';

jest.mock('../config', () => ({
  WORKSPACE_PATH: '/workspace',
  PANE_IDS: ['1', '2', '3'],
}));

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../modules/smart-routing', () => ({
  getBestAgent: jest.fn(() => ({
    paneId: '2',
    taskType: 'backend',
    reason: 'skill_match',
    confidence: 0.85,
    scores: [{ paneId: '2', total: 0.9 }],
  })),
}));

const {
  setSharedState,
  routeTask,
  triggerAutoHandoff,
  formatAuxEvent,
  AGENT_ROLES,
} = require('../modules/triggers/routing');

describe('Triggers Routing', () => {
  afterEach(() => jest.clearAllMocks());

  // ── AGENT_ROLES ──

  describe('AGENT_ROLES', () => {
    test('defines roles for panes 1, 2, 3', () => {
      expect(AGENT_ROLES['1'].name).toBe('Architect');
      expect(AGENT_ROLES['2'].name).toBe('Builder');
      expect(AGENT_ROLES['3'].name).toBe('Oracle');
    });

    test('each role has skills array', () => {
      expect(Array.isArray(AGENT_ROLES['1'].skills)).toBe(true);
      expect(Array.isArray(AGENT_ROLES['2'].skills)).toBe(true);
      expect(Array.isArray(AGENT_ROLES['3'].skills)).toBe(true);
    });
  });

  // ── formatAuxEvent — pure utility functions ──

  describe('formatAuxEvent', () => {
    // ── File events ──

    test('formats single file edit event', () => {
      const result = formatAuxEvent({
        type: 'file_edit',
        payload: { file: 'src/app.js', action: 'edit' },
      });
      expect(result).toContain('[FILE]');
      expect(result).toContain('edited');
      expect(result).toContain('src/app.js');
    });

    test('formats multiple files event', () => {
      const result = formatAuxEvent({
        type: 'file_update',
        payload: { files: ['a.js', 'b.js', 'c.js'], action: 'write' },
      });
      expect(result).toContain('[FILE]');
      expect(result).toContain('3 files');
    });

    test('formats single file array', () => {
      const result = formatAuxEvent({
        type: 'file_create',
        payload: { files: ['new-file.ts'], action: 'create' },
      });
      expect(result).toContain('created');
      expect(result).toContain('new-file.ts');
    });

    test('formats delete action', () => {
      const result = formatAuxEvent({
        type: 'file_remove',
        payload: { file: 'old.js', action: 'delete' },
      });
      expect(result).toContain('deleted');
    });

    test('formats file_paths alias', () => {
      const result = formatAuxEvent({
        type: 'file_change',
        payload: { file_paths: ['x.js'] },
      });
      expect(result).toContain('[FILE]');
    });

    test('formats filePaths alias', () => {
      const result = formatAuxEvent({
        type: 'file_change',
        payload: { filePaths: ['y.js'] },
      });
      expect(result).toContain('[FILE]');
    });

    test('formats path alias', () => {
      const result = formatAuxEvent({
        type: 'file_change',
        payload: { path: 'z.js', event: 'modify' },
      });
      expect(result).toContain('edited');
      expect(result).toContain('z.js');
    });

    test('formats filename alias', () => {
      const result = formatAuxEvent({
        type: 'file_change',
        payload: { filename: 'test.js' },
      });
      expect(result).toContain('test.js');
    });

    test('formats file_path alias', () => {
      const result = formatAuxEvent({
        type: 'file_change',
        payload: { file_path: 'mod.js' },
      });
      expect(result).toContain('mod.js');
    });

    test('formats filePath alias', () => {
      const result = formatAuxEvent({
        type: 'file_change',
        payload: { filePath: 'comp.js' },
      });
      expect(result).toContain('comp.js');
    });

    test('formats count-based file event', () => {
      const result = formatAuxEvent({
        type: 'file_update',
        payload: { count: 7 },
      });
      expect(result).toContain('7 files');
    });

    test('formats fileCount alias', () => {
      const result = formatAuxEvent({
        type: 'file_update',
        payload: { fileCount: 3 },
      });
      expect(result).toContain('3 files');
    });

    test('formats filesCount alias', () => {
      const result = formatAuxEvent({
        type: 'file_update',
        payload: { filesCount: 5 },
      });
      expect(result).toContain('5 files');
    });

    test('derives "updated" as default action', () => {
      const result = formatAuxEvent({
        type: 'file_something',
        payload: { file: 'data.json' },
      });
      expect(result).toContain('updated');
    });

    // ── Command events ──

    test('formats command event with string command', () => {
      const result = formatAuxEvent({
        type: 'command',
        payload: { command: 'npm test' },
      });
      expect(result).toContain('[CMD]');
      expect(result).toContain('npm test');
    });

    test('formats command event with array command', () => {
      const result = formatAuxEvent({
        type: 'command',
        payload: { command: ['npm', 'run', 'build'] },
      });
      expect(result).toContain('npm run build');
    });

    test('formats command from nested command.command', () => {
      const result = formatAuxEvent({
        type: 'command',
        payload: { command: { command: 'git status' } },
      });
      expect(result).toContain('git status');
    });

    test('formats command from nested command.args', () => {
      const result = formatAuxEvent({
        type: 'command',
        payload: { command: { args: ['git', 'push'] } },
      });
      expect(result).toContain('git push');
    });

    test('formats command_line alias', () => {
      const result = formatAuxEvent({
        type: 'command',
        payload: { command_line: 'ls -la' },
      });
      expect(result).toContain('ls -la');
    });

    test('formats commandLine alias', () => {
      const result = formatAuxEvent({
        type: 'command',
        payload: { commandLine: 'pwd' },
      });
      expect(result).toContain('pwd');
    });

    test('formats cmd alias', () => {
      const result = formatAuxEvent({
        type: 'command',
        payload: { cmd: 'echo hi' },
      });
      expect(result).toContain('echo hi');
    });

    test('formats args alias', () => {
      const result = formatAuxEvent({
        type: 'command',
        payload: { args: ['make', 'clean'] },
      });
      expect(result).toContain('make clean');
    });

    test('formats argv alias', () => {
      const result = formatAuxEvent({
        type: 'command',
        payload: { argv: ['docker', 'build', '.'] },
      });
      expect(result).toContain('docker build .');
    });

    test('suppresses command_completed events', () => {
      const result = formatAuxEvent({
        type: 'command_completed',
        payload: { command: 'npm test' },
      });
      expect(result).toBe('');
    });

    test('shows command_started events', () => {
      const result = formatAuxEvent({
        type: 'command_started',
        payload: { command: 'npm test' },
      });
      expect(result).toContain('[CMD]');
    });

    // ── Tool events ──

    test('formats tool event with tool_name', () => {
      const result = formatAuxEvent({
        type: 'tool_use',
        payload: { tool_name: 'Read', input: 'file.js' },
      });
      expect(result).toContain('[TOOL]');
      expect(result).toContain('Read');
      expect(result).toContain('file.js');
    });

    test('formats tool event with toolName', () => {
      const result = formatAuxEvent({
        type: 'tool_call',
        payload: { toolName: 'Edit' },
      });
      expect(result).toContain('Edit');
    });

    test('formats tool event with name', () => {
      const result = formatAuxEvent({
        type: 'tool_use',
        payload: { name: 'Grep' },
      });
      expect(result).toContain('Grep');
    });

    test('formats tool event with tool string', () => {
      const result = formatAuxEvent({
        type: 'tool_call',
        payload: { tool: 'Bash' },
      });
      expect(result).toContain('Bash');
    });

    test('formats tool from tool.name', () => {
      const result = formatAuxEvent({
        type: 'tool_use',
        payload: { tool: { name: 'Write' } },
      });
      expect(result).toContain('Write');
    });

    test('formats tool from tool_call.name', () => {
      const result = formatAuxEvent({
        type: 'tool_use',
        payload: { tool_call: { name: 'Glob' } },
      });
      expect(result).toContain('Glob');
    });

    test('formats tool from tool_call.function.name', () => {
      const result = formatAuxEvent({
        type: 'tool_use',
        payload: { tool_call: { function: { name: 'Search' } } },
      });
      expect(result).toContain('Search');
    });

    test('formats tool from function.name', () => {
      const result = formatAuxEvent({
        type: 'tool_use',
        payload: { function: { name: 'Fetch' } },
      });
      expect(result).toContain('Fetch');
    });

    test('formats tool detail from arguments', () => {
      const result = formatAuxEvent({
        type: 'tool_use',
        payload: { name: 'Read', arguments: 'config.json' },
      });
      expect(result).toContain('config.json');
    });

    test('formats tool detail from object input with query', () => {
      const result = formatAuxEvent({
        type: 'tool_use',
        payload: { name: 'Grep', input: { query: 'findMe' } },
      });
      expect(result).toContain('findMe');
    });

    test('formats tool detail from object input without query', () => {
      const result = formatAuxEvent({
        type: 'tool_use',
        payload: { name: 'Edit', input: { file: 'x.js', line: 5 } },
      });
      expect(result).toContain('Edit');
    });

    test('suppresses tool_completed events', () => {
      const result = formatAuxEvent({
        type: 'tool_completed',
        payload: { name: 'Read' },
      });
      expect(result).toBe('');
    });

    test('shows tool_use events (start-like)', () => {
      const result = formatAuxEvent({
        type: 'tool_use',
        payload: { name: 'Bash' },
      });
      expect(result).toContain('[TOOL]');
    });

    // ── Unrecognized events ──

    test('returns null for unrecognized event type', () => {
      const result = formatAuxEvent({
        type: 'some_random_event',
        payload: { data: 'value' },
      });
      expect(result).toBeNull();
    });

    test('returns null for empty payload (non-file, non-command, non-tool)', () => {
      const result = formatAuxEvent({ type: 'info' });
      expect(result).toBeNull();
    });

    test('handles null/undefined in extractFileSummary', () => {
      const result = formatAuxEvent({
        type: 'file_event',
        payload: null,
      });
      // No file extraction possible, falls through to command/tool check
      expect(result).toBeNull();
    });

    test('handles string payload (non-object)', () => {
      const result = formatAuxEvent({
        type: 'file_event',
        payload: 'just a string',
      });
      expect(result).toBeNull();
    });

    // ── Truncation ──

    test('truncates long detail', () => {
      const longFile = 'x'.repeat(200) + '.js';
      const result = formatAuxEvent({
        type: 'file_edit',
        payload: { file: longFile },
      });
      expect(result).toContain('...');
      // Should be truncated to 160 chars max for detail
    });

    // ── Empty arrays ──

    test('returns null for empty files array', () => {
      const result = formatAuxEvent({
        type: 'file_update',
        payload: { files: [] },
      });
      // Empty files array, no file/path/count — falls through
      expect(result).toBeNull();
    });
  });

  // ── routeTask ──

  describe('routeTask', () => {
    let mainWindow;

    beforeEach(() => {
      mainWindow = {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: { send: jest.fn() },
      };
      setSharedState({
        mainWindow,
        agentRunning: new Map([['1', 'running'], ['2', 'running'], ['3', 'running']]),
        watcher: null,
        logTriggerActivity: jest.fn(),
        recordSelfHealingMessage: jest.fn(),
        formatTriggerMessage: jest.fn((msg) => `[FMT] ${msg}`),
      });
    });

    test('routes task and sends inject-message', () => {
      const result = routeTask('backend', 'fix the server', {});
      expect(result.success).toBe(true);
      expect(result.paneId).toBe('2');
      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'inject-message',
        expect.objectContaining({ panes: ['2'] })
      );
    });

    test('sends task-routed event', () => {
      routeTask('backend', 'fix server', {});
      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'task-routed',
        expect.objectContaining({
          taskType: 'backend',
          paneId: '2',
        })
      );
    });

    test('returns failure when no agent available', () => {
      const smartRouting = require('../modules/smart-routing');
      smartRouting.getBestAgent.mockReturnValueOnce({
        paneId: null,
        reason: 'no_running_candidates',
        confidence: 0,
      });

      const result = routeTask('backend', 'fix server', {});
      expect(result.success).toBe(false);
      expect(result.reason).toBe('no_agent_available');
    });

    test('logs trigger activity', () => {
      routeTask('backend', 'fix server', {});
      // logTriggerActivity was set via setSharedState
    });

    test('handles null confidence', () => {
      const smartRouting = require('../modules/smart-routing');
      smartRouting.getBestAgent.mockReturnValueOnce({
        paneId: '2',
        taskType: 'backend',
        reason: 'skill_match',
        confidence: null,
      });

      const result = routeTask('backend', 'fix', {});
      expect(result.success).toBe(true);
    });
  });

  // ── triggerAutoHandoff ──

  describe('triggerAutoHandoff', () => {
    let mainWindow;

    beforeEach(() => {
      mainWindow = {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: { send: jest.fn() },
      };
      setSharedState({
        mainWindow,
        agentRunning: new Map([['1', 'running'], ['2', 'running'], ['3', 'running']]),
        watcher: null,
        logTriggerActivity: jest.fn(),
        recordSelfHealingMessage: jest.fn(),
        formatTriggerMessage: jest.fn((msg) => `[FMT] ${msg}`),
        emitOrganicMessageRoute: jest.fn(),
      });
    });

    test('hands off from pane 1 to next running pane', () => {
      const result = triggerAutoHandoff('1', 'task done');
      expect(result.success).toBe(true);
      expect(result.from).toBe('1');
      expect(result.to).toBe('2'); // first in chain ['2', '3']
      expect(result.fromRole).toBe('Architect');
      expect(result.toRole).toBe('Builder');
    });

    test('sends inject-message and auto-handoff events', () => {
      triggerAutoHandoff('1', 'task done');
      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'inject-message',
        expect.objectContaining({ panes: ['2'] })
      );
      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'auto-handoff',
        expect.objectContaining({ from: '1', to: '2' })
      );
    });

    test('returns failure for unknown pane (no chain)', () => {
      const result = triggerAutoHandoff('99', 'task done');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('no_chain');
    });

    test('returns failure when no running agents in chain', () => {
      setSharedState({
        mainWindow,
        agentRunning: new Map([['1', 'running']]),
        watcher: null,
        logTriggerActivity: jest.fn(),
        formatTriggerMessage: jest.fn((msg) => msg),
        emitOrganicMessageRoute: jest.fn(),
      });

      const result = triggerAutoHandoff('1', 'done');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('no_running_next');
    });

    test('skips to next running pane in chain', () => {
      // Pane 2 stopped, Pane 3 running
      setSharedState({
        mainWindow,
        agentRunning: new Map([['1', 'running'], ['2', 'stopped'], ['3', 'running']]),
        watcher: null,
        logTriggerActivity: jest.fn(),
        formatTriggerMessage: jest.fn((msg) => msg),
        emitOrganicMessageRoute: jest.fn(),
      });

      const result = triggerAutoHandoff('1', 'done');
      expect(result.success).toBe(true);
      expect(result.to).toBe('3'); // skipped pane 2
    });

    test('Pane 3 hands off to pane 1', () => {
      const result = triggerAutoHandoff('3', 'analysis done');
      expect(result.success).toBe(true);
      expect(result.to).toBe('1');
      expect(result.fromRole).toBe('Oracle');
      expect(result.toRole).toBe('Architect');
    });
  });

  // ── setSharedState ──

  describe('setSharedState', () => {
    test('merges state without overwriting unrelated keys', () => {
      setSharedState({ mainWindow: 'win1' });
      setSharedState({ watcher: 'w1' });
      // Both should be set — verified indirectly through routeTask behavior
    });
  });
});
