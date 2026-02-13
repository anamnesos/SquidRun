/**
 * Comprehensive PTY Handler Tests
 * Target: Full coverage of pty-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
  createDepsMock,
} = require('./helpers/ipc-harness');

// Mock electron clipboard
jest.mock('electron', () => ({
  clipboard: {
    readText: jest.fn(() => 'original-clipboard'),
    writeText: jest.fn(),
  },
}));

const { registerPtyHandlers } = require('../modules/ipc/pty-handlers');

describe('PTY Handlers', () => {
  let harness;
  let ctx;
  let deps;

  beforeEach(() => {
    jest.useFakeTimers();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    deps = createDepsMock();
    registerPtyHandlers(ctx, deps);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('pty-create', () => {
    test('returns error when daemon not connected', async () => {
      ctx.daemonClient.connected = false;
      const result = await harness.invoke('pty-create', '1', '/test/dir');
      expect(result).toEqual({ error: 'Daemon not connected' });
    });

    test('spawns terminal with instance dir when available', async () => {
      ctx.daemonClient.connected = true;
      const result = await harness.invoke('pty-create', '1', '/fallback/dir');

      expect(ctx.daemonClient.spawn).toHaveBeenCalled();
      expect(result.paneId).toBe('1');
      expect(result.dryRun).toBe(false);
    });

    test('uses workingDir when instance dir not available', async () => {
      ctx.daemonClient.connected = true;
      ctx.INSTANCE_DIRS = {}; // Clear instance dirs
      const result = await harness.invoke('pty-create', '99', '/custom/dir');

      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith('99', '/custom/dir', false, null);
    });

    test('spawns with codex-exec mode when paneCommand includes codex', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '2': 'codex --mode exec' };

      await harness.invoke('pty-create', '2', '/test/dir');

      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        '2',
        expect.any(String),
        false,
        'codex-exec'
      );
    });

    test('spawns with null mode for claude command', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '1': 'claude' };

      await harness.invoke('pty-create', '1', '/test/dir');

      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        '1',
        expect.any(String),
        false,
        null
      );
    });

    test('respects dryRun setting', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.dryRun = true;

      const result = await harness.invoke('pty-create', '1', '/test');

      expect(result.dryRun).toBe(true);
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith('1', expect.any(String), true, null);
    });
  });

  describe('pty-write', () => {
    test('writes data when daemon connected', async () => {
      ctx.daemonClient.connected = true;
      await harness.invoke('pty-write', '1', 'test data');

      expect(ctx.daemonClient.write).toHaveBeenCalledWith('1', 'test data');
    });

    test('does nothing when daemon not connected', async () => {
      ctx.daemonClient.connected = false;
      await harness.invoke('pty-write', '1', 'test data');

      expect(ctx.daemonClient.write).not.toHaveBeenCalled();
    });

    test('does nothing when daemonClient is null', async () => {
      ctx.daemonClient = null;
      await harness.invoke('pty-write', '1', 'test data');
      // Should not throw
    });

    test('passes optional kernelMeta to daemon client', async () => {
      ctx.daemonClient.connected = true;
      const kernelMeta = { eventId: 'evt-1', correlationId: 'corr-1', source: 'injection.js' };

      await harness.invoke('pty-write', '1', 'test data', kernelMeta);

      expect(ctx.daemonClient.write).toHaveBeenCalledWith(
        '1',
        'test data',
        expect.objectContaining({
          eventId: 'evt-1',
          correlationId: 'corr-1',
          traceId: 'corr-1',
          source: 'injection.js',
        })
      );
    });
  });

  describe('pty-write-chunked', () => {
    test('writes chunked data when daemon connected', async () => {
      ctx.daemonClient.connected = true;
      const payload = 'A'.repeat(4200);
      const result = await harness.invoke('pty-write-chunked', '1', payload, { chunkSize: 2048 });

      expect(result).toEqual({ success: true, chunks: 3, chunkSize: 2048 });
      expect(ctx.daemonClient.write).toHaveBeenCalledTimes(3);
      const sent = ctx.daemonClient.write.mock.calls.map(call => call[1]).join('');
      expect(sent).toBe(payload);
    });

    test('does nothing when daemon not connected', async () => {
      ctx.daemonClient.connected = false;
      const result = await harness.invoke('pty-write-chunked', '1', 'test data', { chunkSize: 2048 });

      expect(result).toBeUndefined();
      expect(ctx.daemonClient.write).not.toHaveBeenCalled();
    });

    test('clamps chunk size to allowed bounds', async () => {
      ctx.daemonClient.connected = true;
      const payload = 'B'.repeat(20000);

      const result = await harness.invoke('pty-write-chunked', '1', payload, { chunkSize: 9999 });

      expect(result).toEqual({ success: true, chunks: 3, chunkSize: 8192 });
      expect(ctx.daemonClient.write).toHaveBeenCalledTimes(3);
      expect(ctx.daemonClient.write.mock.calls[0][1]).toHaveLength(8192);
    });

    test('forwards chunk kernel metadata with unique event ids', async () => {
      ctx.daemonClient.connected = true;
      const payload = 'C'.repeat(3000);
      const kernelMeta = {
        eventId: 'evt-1',
        correlationId: 'corr-1',
        parentEventId: 'evt-parent-1',
        source: 'injection.js',
      };

      await harness.invoke('pty-write-chunked', '1', payload, { chunkSize: 2048 }, kernelMeta);

      expect(ctx.daemonClient.write).toHaveBeenCalledTimes(2);
      expect(ctx.daemonClient.write.mock.calls[0][2]).toEqual(expect.objectContaining({
        correlationId: 'corr-1',
        traceId: 'corr-1',
        parentEventId: 'evt-parent-1',
        source: 'injection.js',
        eventId: 'evt-1-c1',
      }));
      expect(ctx.daemonClient.write.mock.calls[1][2]).toEqual(expect.objectContaining({
        correlationId: 'corr-1',
        traceId: 'corr-1',
        parentEventId: 'evt-parent-1',
        source: 'injection.js',
        eventId: 'evt-1-c2',
      }));
    });

    test('uses writeAndWaitAck when daemon supports ack handshake', async () => {
      ctx.daemonClient.connected = true;
      ctx.daemonClient.writeAndWaitAck = jest.fn().mockResolvedValue({ success: true, status: 'accepted' });
      const payload = 'D'.repeat(4200);

      const result = await harness.invoke('pty-write-chunked', '1', payload, { chunkSize: 2048 });

      expect(result).toEqual({ success: true, chunks: 3, chunkSize: 2048 });
      expect(ctx.daemonClient.writeAndWaitAck).toHaveBeenCalledTimes(3);
    });

    test('returns failure when writeAndWaitAck fails', async () => {
      ctx.daemonClient.connected = true;
      ctx.daemonClient.writeAndWaitAck = jest.fn().mockResolvedValue({
        success: false,
        status: 'ack_timeout',
        error: 'write ack timeout after 2500ms',
      });

      const result = await harness.invoke('pty-write-chunked', '1', 'hello world', { chunkSize: 2048 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('write ack timeout');
      expect(ctx.daemonClient.writeAndWaitAck).toHaveBeenCalledTimes(1);
    });
  });

  describe('interrupt-pane', () => {
    test('returns error when daemon not connected', async () => {
      ctx.daemonClient.connected = false;
      const result = await harness.invoke('interrupt-pane', '1');

      expect(result).toEqual({ success: false, error: 'Daemon not connected' });
    });

    test('returns error when paneId not provided', async () => {
      ctx.daemonClient.connected = true;
      const result = await harness.invoke('interrupt-pane', null);

      expect(result).toEqual({ success: false, error: 'paneId required' });
    });

    test('sends Ctrl+C to pane when valid', async () => {
      ctx.daemonClient.connected = true;
      const result = await harness.invoke('interrupt-pane', '3');

      expect(ctx.daemonClient.write).toHaveBeenCalledWith('3', '\x03');
      expect(result).toEqual({ success: true });
    });
  });

  describe('codex-exec', () => {
    test('returns error when daemon not connected', async () => {
      ctx.daemonClient.connected = false;
      const result = await harness.invoke('codex-exec', '2', 'test prompt');

      expect(result).toEqual({ success: false, error: 'Daemon not connected' });
    });

    test('executes codex with prompt', async () => {
      ctx.daemonClient.connected = true;
      const result = await harness.invoke('codex-exec', '2', 'write hello world');

      expect(ctx.daemonClient.codexExec).toHaveBeenCalledWith('2', 'write hello world');
      expect(result).toEqual({ success: true, status: 'sent_without_ack', requestId: null });
    });

    test('uses empty string when prompt is falsy', async () => {
      ctx.daemonClient.connected = true;
      await harness.invoke('codex-exec', '2', null);

      expect(ctx.daemonClient.codexExec).toHaveBeenCalledWith('2', '');
    });

    test('awaits codexExecAndWait when available', async () => {
      ctx.daemonClient.connected = true;
      ctx.daemonClient.codexExecAndWait = jest.fn().mockResolvedValue({
        success: true,
        status: 'accepted',
        requestId: 'codex-exec-1',
      });

      const result = await harness.invoke('codex-exec', '2', 'run something');

      expect(ctx.daemonClient.codexExecAndWait).toHaveBeenCalledWith('2', 'run something');
      expect(result).toEqual({ success: true, status: 'accepted', requestId: 'codex-exec-1' });
      expect(ctx.daemonClient.codexExec).not.toHaveBeenCalled();
    });

    test('returns failure when codexExecAndWait rejects execution', async () => {
      ctx.daemonClient.connected = true;
      ctx.daemonClient.codexExecAndWait = jest.fn().mockResolvedValue({
        success: false,
        status: 'rejected',
        error: 'Codex exec already running',
      });

      const result = await harness.invoke('codex-exec', '2', 'run something');

      expect(result).toEqual({
        success: false,
        status: 'rejected',
        error: 'Codex exec already running',
      });
    });
  });

  describe('send-trusted-enter', () => {
    test('sends enter key events to main window', async () => {
      await harness.invoke('send-trusted-enter');

      expect(ctx.mainWindow.webContents.sendInputEvent).toHaveBeenCalledTimes(3);
      expect(ctx.mainWindow.webContents.sendInputEvent).toHaveBeenCalledWith({ type: 'keyDown', keyCode: 'Return' });
      expect(ctx.mainWindow.webContents.sendInputEvent).toHaveBeenCalledWith({ type: 'char', keyCode: 'Return' });
      expect(ctx.mainWindow.webContents.sendInputEvent).toHaveBeenCalledWith({ type: 'keyUp', keyCode: 'Return' });
    });

    test('does nothing when mainWindow is null', async () => {
      ctx.mainWindow = null;
      await harness.invoke('send-trusted-enter');
      // Should not throw
    });

    test('does nothing when webContents is null', async () => {
      ctx.mainWindow.webContents = null;
      await harness.invoke('send-trusted-enter');
      // Should not throw
    });
  });

  describe('clipboard-paste-text', () => {
    test('pastes text via clipboard and restores original', async () => {
      const { clipboard } = require('electron');

      await harness.invoke('clipboard-paste-text', 'pasted text');

      expect(clipboard.readText).toHaveBeenCalled();
      expect(clipboard.writeText).toHaveBeenCalledWith('pasted text');
      expect(ctx.mainWindow.webContents.sendInputEvent).toHaveBeenCalledWith({ type: 'keyDown', keyCode: 'Control' });

      // Fast-forward timer to restore clipboard
      jest.advanceTimersByTime(250);
      expect(clipboard.writeText).toHaveBeenCalledWith('original-clipboard');
    });

    test('does nothing when mainWindow is null', async () => {
      ctx.mainWindow = null;
      const { clipboard } = require('electron');

      await harness.invoke('clipboard-paste-text', 'text');

      expect(clipboard.readText).not.toHaveBeenCalled();
    });
  });

  describe('pty-resize', () => {
    test('resizes when daemon connected', async () => {
      ctx.daemonClient.connected = true;
      await harness.invoke('pty-resize', '1', 120, 40);

      expect(ctx.daemonClient.resize).toHaveBeenCalledWith('1', 120, 40);
    });

    test('does nothing when daemon not connected', async () => {
      ctx.daemonClient.connected = false;
      await harness.invoke('pty-resize', '1', 120, 40);

      expect(ctx.daemonClient.resize).not.toHaveBeenCalled();
    });

    test('passes optional kernelMeta to daemon resize', async () => {
      ctx.daemonClient.connected = true;
      const kernelMeta = { correlationId: 'corr-resize', source: 'renderer.js' };

      await harness.invoke('pty-resize', '1', 120, 40, kernelMeta);

      expect(ctx.daemonClient.resize).toHaveBeenCalledWith(
        '1',
        120,
        40,
        expect.objectContaining({
          correlationId: 'corr-resize',
          traceId: 'corr-resize',
          source: 'renderer.js',
        })
      );
    });
  });

  describe('pty-kill', () => {
    test('kills terminal when daemon connected', async () => {
      ctx.daemonClient.connected = true;
      await harness.invoke('pty-kill', '1');

      expect(ctx.daemonClient.kill).toHaveBeenCalledWith('1');
    });

    test('does nothing when daemon not connected', async () => {
      ctx.daemonClient.connected = false;
      await harness.invoke('pty-kill', '1');

      expect(ctx.daemonClient.kill).not.toHaveBeenCalled();
    });
  });

  describe('spawn-claude', () => {
    test('simulates spawn in dry-run mode', async () => {
      ctx.currentSettings.dryRun = true;
      const result = await harness.invoke('spawn-claude', '1', '/dir');

      expect(result).toEqual({ success: true, command: null, dryRun: true });
      expect(ctx.agentRunning.get('1')).toBe('running');
      expect(deps.broadcastClaudeState).toHaveBeenCalled();
    });

    test('returns error when daemon not connected', async () => {
      ctx.daemonClient.connected = false;
      const result = await harness.invoke('spawn-claude', '1', '/dir');

      expect(result).toEqual({ success: false, error: 'Daemon not connected' });
    });

    test('spawns claude with permission flags', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '1': 'claude' };

      const result = await harness.invoke('spawn-claude', '1', '/dir');

      expect(result.success).toBe(true);
      expect(result.command).toContain('--dangerously-skip-permissions');
      expect(ctx.agentRunning.get('1')).toBe('starting');
      expect(deps.broadcastClaudeState).toHaveBeenCalled();
      expect(deps.recordSessionStart).toHaveBeenCalledWith('1');
    });

    test('spawns codex with yolo flag', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '2': 'codex' };

      const result = await harness.invoke('spawn-claude', '2', '/dir');

      expect(result.success).toBe(true);
      expect(result.command).toContain('--yolo');
    });

    test('does not duplicate permission flags', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '1': 'claude --dangerously-skip-permissions' };

      const result = await harness.invoke('spawn-claude', '1', '/dir');

      const flagCount = (result.command.match(/--dangerously-skip-permissions/g) || []).length;
      expect(flagCount).toBe(1);
    });

    test('does not duplicate yolo flag for codex', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '2': 'codex --yolo' };

      const result = await harness.invoke('spawn-claude', '2', '/dir');

      const flagCount = (result.command.match(/--yolo/g) || []).length;
      expect(flagCount).toBe(1);
    });

    test('handles --dangerously-bypass-approvals-and-sandbox for codex', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '2': 'codex --dangerously-bypass-approvals-and-sandbox' };

      const result = await harness.invoke('spawn-claude', '2', '/dir');

      expect(result.command).not.toContain('--yolo');
      expect(result.command).toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    test('defaults to claude when no paneCommand set', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = {};

      const result = await harness.invoke('spawn-claude', '1', '/dir');

      expect(result.command).toContain('claude');
      expect(result.command).toContain('--dangerously-skip-permissions');
    });

    test('defaults to claude when paneCommand is empty string', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '1': '   ' };

      const result = await harness.invoke('spawn-claude', '1', '/dir');

      expect(result.command).toBe('claude --dangerously-skip-permissions');
    });
  });

  describe('get-claude-state', () => {
    test('returns agent running state as object', async () => {
      ctx.agentRunning.set('1', 'running');
      ctx.agentRunning.set('2', 'idle');

      const result = await harness.invoke('get-claude-state');

      expect(result).toEqual({ '1': 'running', '2': 'idle' });
    });

    test('returns empty object when no agents running', async () => {
      const result = await harness.invoke('get-claude-state');

      expect(result).toEqual({});
    });
  });

  describe('get-daemon-terminals', () => {
    test('returns terminals from daemon client', async () => {
      const terminals = [{ paneId: '1', alive: true }, { paneId: '2', alive: false }];
      ctx.daemonClient.getTerminals.mockReturnValue(terminals);

      const result = await harness.invoke('get-daemon-terminals');

      expect(result).toEqual(terminals);
    });

    test('returns empty array when daemon client is null', async () => {
      ctx.daemonClient = null;
      const result = await harness.invoke('get-daemon-terminals');

      expect(result).toEqual([]);
    });
  });
});
