/**
 * Comprehensive PTY Handler Tests
 * Target: Full coverage of pty-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
  createDepsMock,
} = require('./helpers/ipc-harness');
const path = require('path');

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

    test('spawns terminal with resolver cwd when available', async () => {
      ctx.daemonClient.connected = true;
      const result = await harness.invoke('pty-create', '1', '/fallback/dir');

      expect(ctx.daemonClient.spawn).toHaveBeenCalled();
      expect(result.paneId).toBe('1');
      expect(result.dryRun).toBe(false);
    });

    test('uses paneProjects cwd for known panes when assigned', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneProjects = { '1': '/assigned/project' };

      const result = await harness.invoke('pty-create', '1', '/fallback/dir');
      const expectedCwd = path.resolve('/assigned/project');

      expect(result.cwd).toBe(expectedCwd);
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith('1', expectedCwd, false, null);
    });

    test('uses active state.project when pane has no explicit assignment', async () => {
      ctx.daemonClient.connected = true;
      ctx.watcher.readState = jest.fn(() => ({ project: '/active/project' }));
      ctx.currentSettings.paneProjects = {};

      const result = await harness.invoke('pty-create', '2', '/fallback/dir');
      const expectedCwd = path.resolve('/active/project');

      expect(result.cwd).toBe(expectedCwd);
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith('2', expectedCwd, false, null);
    });

    test('does not read or use state.project when operatingMode is developer', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.operatingMode = 'developer';
      ctx.currentSettings.paneProjects = {};
      ctx.watcher.readState = jest.fn(() => ({ project: '/active/project' }));

      const result = await harness.invoke('pty-create', '2', '/fallback/dir');
      const stateProjectCwd = path.resolve('/active/project');

      expect(ctx.watcher.readState).not.toHaveBeenCalled();
      expect(result.cwd).not.toBe(stateProjectCwd);
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith('2', result.cwd, false, null);
    });

    test('uses workingDir when pane cwd resolver has no mapping', async () => {
      ctx.daemonClient.connected = true;
      const result = await harness.invoke('pty-create', '99', '/custom/dir');

      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith('99', '/custom/dir', false, null);
    });

    test('spawns codex panes with null mode (interactive PTY, not codex-exec)', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '2': 'codex --mode exec' };

      await harness.invoke('pty-create', '2', '/test/dir');

      // All panes use interactive PTY mode — codex-exec mode removed
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        '2',
        expect.any(String),
        false,
        null
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

    test('sets GEMINI_SYSTEM_MD env for gemini panes when firmware injection is enabled', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.firmwareInjectionEnabled = true;
      ctx.currentSettings.paneCommands = { '3': 'gemini --yolo' };
      deps.firmwareManager = {
        ensureFirmwareForPane: jest.fn(() => ({ ok: true, firmwarePath: '/tmp/fw/oracle.md' })),
      };

      const result = await harness.invoke('pty-create', '3', '/fallback/dir');

      expect(result.paneId).toBe('3');
      expect(deps.firmwareManager.ensureFirmwareForPane).toHaveBeenCalledWith('3');
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        '3',
        expect.any(String),
        false,
        null,
        { GEMINI_SYSTEM_MD: '/tmp/fw/oracle.md' }
      );
    });
  });

  describe('pty-write', () => {
    test('writes data when daemon connected', async () => {
      ctx.daemonClient.connected = true;
      ctx.daemonClient.write.mockReturnValue(true);
      const result = await harness.invoke('pty-write', '1', 'test data');

      expect(ctx.daemonClient.write).toHaveBeenCalledWith('1', 'test data');
      expect(result).toEqual({ success: true });
    });

    test('returns daemon_not_connected when daemon not connected', async () => {
      ctx.daemonClient.connected = false;
      const result = await harness.invoke('pty-write', '1', 'test data');

      expect(ctx.daemonClient.write).not.toHaveBeenCalled();
      expect(result).toEqual({ success: false, error: 'daemon_not_connected' });
    });

    test('returns daemon_not_connected when daemonClient is null', async () => {
      ctx.daemonClient = null;
      const result = await harness.invoke('pty-write', '1', 'test data');
      expect(result).toEqual({ success: false, error: 'daemon_not_connected' });
    });

    test('returns daemon_write_failed when daemon rejects write', async () => {
      ctx.daemonClient.connected = true;
      ctx.daemonClient.write.mockReturnValue(false);

      const result = await harness.invoke('pty-write', '1', 'test data');

      expect(ctx.daemonClient.write).toHaveBeenCalledWith('1', 'test data');
      expect(result).toEqual({ success: false, error: 'daemon_write_failed' });
    });

    test('passes optional kernelMeta to daemon client', async () => {
      ctx.daemonClient.connected = true;
      ctx.daemonClient.write.mockReturnValue(true);
      const kernelMeta = { eventId: 'evt-1', correlationId: 'corr-1', source: 'injection.js' };

      const result = await harness.invoke('pty-write', '1', 'test data', kernelMeta);

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
      expect(result).toEqual({ success: true });
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

    test('returns error when daemon rejects interrupt write', async () => {
      ctx.daemonClient.connected = true;
      ctx.daemonClient.write.mockReturnValue(false);

      const result = await harness.invoke('interrupt-pane', '3');

      expect(ctx.daemonClient.write).toHaveBeenCalledWith('3', '\x03');
      expect(result).toEqual({ success: false, error: 'daemon_write_failed' });
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
    test('injects text via webContents.insertText without touching clipboard', async () => {
      const { clipboard } = require('electron');
      ctx.mainWindow.webContents.insertText = jest.fn().mockResolvedValue(undefined);

      const result = await harness.invoke('clipboard-paste-text', 'pasted text');

      expect(result).toEqual({ success: true, method: 'insertText', insertedLength: 11 });
      expect(ctx.mainWindow.webContents.insertText).toHaveBeenCalledWith('pasted text');
      expect(ctx.mainWindow.webContents.sendInputEvent).not.toHaveBeenCalled();
      expect(clipboard.readText).not.toHaveBeenCalled();
      expect(clipboard.writeText).not.toHaveBeenCalled();
    });

    test('falls back to sendInputEvent when insertText is unavailable', async () => {
      delete ctx.mainWindow.webContents.insertText;

      const result = await harness.invoke('clipboard-paste-text', 'a\r\nb');

      expect(result).toEqual({ success: true, method: 'sendInputEvent', insertedLength: 4, fallback: true });
      expect(ctx.mainWindow.webContents.sendInputEvent).toHaveBeenCalledTimes(5);
      expect(ctx.mainWindow.webContents.sendInputEvent).toHaveBeenNthCalledWith(1, { type: 'char', keyCode: 'a' });
      expect(ctx.mainWindow.webContents.sendInputEvent).toHaveBeenNthCalledWith(2, { type: 'keyDown', keyCode: 'Return' });
      expect(ctx.mainWindow.webContents.sendInputEvent).toHaveBeenNthCalledWith(3, { type: 'char', keyCode: 'Return' });
      expect(ctx.mainWindow.webContents.sendInputEvent).toHaveBeenNthCalledWith(4, { type: 'keyUp', keyCode: 'Return' });
      expect(ctx.mainWindow.webContents.sendInputEvent).toHaveBeenNthCalledWith(5, { type: 'char', keyCode: 'b' });
    });

    test('returns noop when text is empty', async () => {
      ctx.mainWindow.webContents.insertText = jest.fn().mockResolvedValue(undefined);

      const result = await harness.invoke('clipboard-paste-text', '');

      expect(result).toEqual({ success: true, method: 'noop', insertedLength: 0 });
      expect(ctx.mainWindow.webContents.insertText).not.toHaveBeenCalled();
      expect(ctx.mainWindow.webContents.sendInputEvent).not.toHaveBeenCalled();
    });

    test('returns structured error when mainWindow is null', async () => {
      ctx.mainWindow = null;
      const result = await harness.invoke('clipboard-paste-text', 'text');

      expect(result).toEqual({
        success: false,
        method: null,
        insertedLength: 0,
        error: 'mainWindow not available',
      });
    });
  });

  describe('clipboard-write', () => {
    test('writes provided text into the native clipboard', async () => {
      const { clipboard } = require('electron');

      const result = await harness.invoke('clipboard-write', 'selected text');

      expect(result).toEqual({ success: true });
      expect(clipboard.writeText).toHaveBeenCalledWith('selected text');
    });

    test('returns error when clipboard write throws', async () => {
      const { clipboard } = require('electron');
      clipboard.writeText.mockImplementationOnce(() => {
        throw new Error('write failed');
      });

      const result = await harness.invoke('clipboard-write', 'text');

      expect(result).toEqual({ success: false, error: 'write failed' });
    });
  });

  describe('input-edit-action', () => {
    test('invokes mapped webContents edit method', async () => {
      ctx.mainWindow.webContents.copy = jest.fn();

      const result = await harness.invoke('input-edit-action', 'copy');

      expect(ctx.mainWindow.webContents.copy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true });
    });

    test('returns unsupported_action for invalid action', async () => {
      const result = await harness.invoke('input-edit-action', 'redo');
      expect(result).toEqual({ success: false, error: 'unsupported_action' });
    });

    test('returns error when mainWindow is unavailable', async () => {
      ctx.mainWindow = null;
      const result = await harness.invoke('input-edit-action', 'paste');
      expect(result).toEqual({ success: false, error: 'mainWindow not available' });
    });
  });

  describe('pty-resize', () => {
    test('blocks resize requests from hidden pane-host windows', async () => {
      ctx.daemonClient.connected = true;
      const handler = harness.handlers.get('pty-resize');
      const paneHostEvent = {
        senderFrame: {
          url: 'file:///<project-root>/ui/pane-host.html?paneId=1',
        },
      };

      const result = await handler(paneHostEvent, '1', 120, 40);

      expect(result).toEqual({ ignored: true, reason: 'pane_host_resize_blocked' });
      expect(ctx.daemonClient.resize).not.toHaveBeenCalled();
    });

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
    beforeEach(() => {
      ctx.currentSettings.allowAllPermissions = true;
      ctx.currentSettings.autonomyConsentGiven = true;
    });

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
      expect(deps.recordSessionLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          paneId: '1',
          status: 'started',
          reason: 'spawn_requested',
        })
      );
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

    test('adds --system-prompt-file for claude when firmware injection is enabled', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.firmwareInjectionEnabled = true;
      ctx.currentSettings.paneCommands = { '1': 'claude' };
      deps.firmwareManager = {
        ensureFirmwareForPane: jest.fn(() => ({ ok: true, firmwarePath: '/tmp/fw/architect.md' })),
      };

      const result = await harness.invoke('spawn-claude', '1', '/dir');

      expect(deps.firmwareManager.ensureFirmwareForPane).toHaveBeenCalledWith('1');
      expect(result.command).toContain('--system-prompt-file "/tmp/fw/architect.md"');
      expect(result.command).toContain('--dangerously-skip-permissions');
    });

    test('writes Codex override when firmware injection is enabled', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.firmwareInjectionEnabled = true;
      ctx.currentSettings.paneCommands = { '2': 'codex' };
      deps.firmwareManager = {
        applyCodexOverrideForPane: jest.fn(() => ({ ok: true, overridePath: '/tmp/.codex/rules/AGENTS.override.md' })),
      };

      const result = await harness.invoke('spawn-claude', '2', '/dir');

      expect(deps.firmwareManager.applyCodexOverrideForPane).toHaveBeenCalledWith('2');
      expect(result.command).toContain('codex');
      expect(result.command).toContain('--yolo');
    });

    test('does not append autonomy flags when consent is pending', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '1': 'claude', '2': 'codex' };
      ctx.currentSettings.autonomyConsentGiven = false;

      const claude = await harness.invoke('spawn-claude', '1', '/dir');
      const codex = await harness.invoke('spawn-claude', '2', '/dir');

      expect(claude.command).toBe('claude');
      expect(codex.command).toBe('codex');
    });

    test('does not append autonomy flags when user declines autonomy', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '1': 'claude', '2': 'codex' };
      ctx.currentSettings.allowAllPermissions = false;

      const claude = await harness.invoke('spawn-claude', '1', '/dir');
      const codex = await harness.invoke('spawn-claude', '2', '/dir');

      expect(claude.command).toBe('claude');
      expect(codex.command).toBe('codex');
    });
  });

  describe('intent-update', () => {
    test('delegates to updateIntentState dependency when available', async () => {
      deps.updateIntentState.mockResolvedValueOnce({ ok: true, paneId: '2' });
      const result = await harness.invoke('intent-update', {
        paneId: '2',
        intent: 'Deploying patch',
      });
      expect(deps.updateIntentState).toHaveBeenCalledWith(
        expect.objectContaining({
          paneId: '2',
          intent: 'Deploying patch',
        })
      );
      expect(result).toEqual({ ok: true, paneId: '2' });
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
