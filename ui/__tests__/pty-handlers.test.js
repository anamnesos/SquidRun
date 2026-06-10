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
const fs = require('fs');
const os = require('os');
const { encodeClaudeProjectDir } = require('../modules/cli-resume-invocation');
const { loadPaneSessionIds } = require('../modules/pane-session-id-store');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Mock electron clipboard
jest.mock('electron', () => ({
  clipboard: {
    readText: jest.fn(() => 'original-clipboard'),
    writeText: jest.fn(),
  },
}));

const { registerPtyHandlers, _internals } = require('../modules/ipc/pty-handlers');

function withPlatform(platformValue, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const restore = () => {
    Object.defineProperty(process, 'platform', descriptor);
  };
  Object.defineProperty(process, 'platform', { value: platformValue });
  try {
    const result = callback();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

describe('PTY Handlers', () => {
  let harness;
  let ctx;
  let deps;
  let tmpDir;

  beforeEach(() => {
    jest.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-handlers-'));
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    deps = createDepsMock();
    deps.paneSessionIdsFilePath = path.join(tmpDir, 'pane-session-ids.json');
    deps.resumeHomeDir = path.join(tmpDir, 'home');
    registerPtyHandlers(ctx, deps);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('windows temp compatibility', () => {
    test('resolves a spaceless non-.squidrun temp dir for Claude on Windows', () => {
      const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
      const cwd = 'D:\\projects\\squidrun';
      const expected = 'D:\\squidrun-tmp';

      const result = withPlatform('win32', () => _internals.resolveWindowsClaudeTempDir(cwd));

      expect(result).toBe(expected);
      expect(result).not.toMatch(/\s/);
      expect(_internals.isInsideSquidRunPrivateRoot(result)).toBe(false);
      expect(mkdirSpy).toHaveBeenCalledWith(expected, { recursive: true });
      mkdirSpy.mockRestore();
    });

    test('skips explicit Windows temp roots inside .squidrun', () => {
      const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
      const cwd = 'D:\\projects\\squidrun';
      const rejectedTemp = path.win32.join(cwd, '.squidrun', 'tmp');
      const expected = 'D:\\squidrun-tmp';

      const result = withPlatform('win32', () => _internals.resolveWindowsClaudeTempDir(cwd, {
        SQUIDRUN_WINDOWS_TMP: rejectedTemp,
        SystemDrive: 'D:',
      }));

      expect(result).toBe(expected);
      expect(_internals.isInsideSquidRunPrivateRoot(result)).toBe(false);
      expect(mkdirSpy).not.toHaveBeenCalledWith(rejectedTemp, { recursive: true });
      expect(mkdirSpy).toHaveBeenCalledWith(expected, { recursive: true });
      mkdirSpy.mockRestore();
    });

    test('falls back to drive-root temp when cwd contains spaces', () => {
      const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
      const cwd = 'D:\\Users\\Example User\\project';
      const expected = 'D:\\squidrun-tmp';

      const result = withPlatform('win32', () => _internals.resolveWindowsClaudeTempDir(cwd));

      expect(result).toBe(expected);
      expect(result).not.toMatch(/\s/);
      expect(mkdirSpy).toHaveBeenCalledWith(expected, { recursive: true });
      mkdirSpy.mockRestore();
    });
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
      const expectedEnv = process.platform === 'win32'
        ? expect.objectContaining({
          TEMP: expect.any(String),
          TMP: expect.any(String),
          TMPDIR: expect.any(String),
        })
        : null;

      expect(result.cwd).toBe(expectedCwd);
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        '1',
        expectedCwd,
        false,
        null,
        expectedEnv,
        { paneCommand: '' }
      );
    });

    test('uses active state.project when pane has no explicit assignment', async () => {
      ctx.daemonClient.connected = true;
      ctx.watcher.readState = jest.fn(() => ({ project: '/active/project' }));
      ctx.currentSettings.paneProjects = {};

      const result = await harness.invoke('pty-create', '2', '/fallback/dir');
      const expectedCwd = path.resolve('/active/project');
      const expectedEnv = process.platform === 'win32'
        ? expect.objectContaining({
          TEMP: expect.any(String),
          TMP: expect.any(String),
          TMPDIR: expect.any(String),
        })
        : null;

      expect(result.cwd).toBe(expectedCwd);
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        '2',
        expectedCwd,
        false,
        null,
        expectedEnv,
        { paneCommand: '' }
      );
    });

    test('does not read or use state.project when operatingMode is developer', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.operatingMode = 'developer';
      ctx.currentSettings.paneProjects = {};
      ctx.watcher.readState = jest.fn(() => ({ project: '/active/project' }));

      const result = await harness.invoke('pty-create', '2', '/fallback/dir');
      const stateProjectCwd = path.resolve('/active/project');
      const expectedEnv = process.platform === 'win32'
        ? expect.objectContaining({
          TEMP: expect.any(String),
          TMP: expect.any(String),
          TMPDIR: expect.any(String),
        })
        : null;

      expect(ctx.watcher.readState).not.toHaveBeenCalled();
      expect(result.cwd).not.toBe(stateProjectCwd);
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        '2',
        result.cwd,
        false,
        null,
        expectedEnv,
        { paneCommand: '' }
      );
    });

    test('uses workingDir when pane cwd resolver has no mapping', async () => {
      ctx.daemonClient.connected = true;
      const result = await harness.invoke('pty-create', '99', '/custom/dir');
      const expectedEnv = process.platform === 'win32'
        ? expect.objectContaining({
          TEMP: expect.any(String),
          TMP: expect.any(String),
          TMPDIR: expect.any(String),
        })
        : null;

      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        '99',
        '/custom/dir',
        false,
        null,
        expectedEnv,
        { paneCommand: '' }
      );
    });

    test('can create dynamic Squid Room arm panes with command, env, and workingDir at spawn time', async () => {
      ctx.daemonClient.connected = true;
      const workingDir = 'D:\\projects\\TrustQuote';

      const result = await harness.invoke('pty-create', 'trustquote-app', workingDir, {
        paneCommand: 'codex --yolo',
        spawnCommandOnCreate: true,
        preferWorkingDir: true,
        env: {
          SQUIDRUN_ROLE: 'trustquote-app',
          SQUIDRUN_SESSION_SCOPE_ID: 'app-session-413:squid-room',
          SQUIDRUN_PROFILE: 'main',
          SQUIDRUN_WINDOW_KEY: 'squid-room',
          SQUIDRUN_WORKING_DIR: workingDir,
        },
      });

      expect(result).toEqual(expect.objectContaining({
        paneId: 'trustquote-app',
        cwd: workingDir,
        paneCommand: 'codex --yolo',
        spawnCommandOnCreate: true,
      }));
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        'trustquote-app',
        workingDir,
        false,
        null,
        expect.objectContaining({
          SQUIDRUN_ROLE: 'trustquote-app',
          SQUIDRUN_SESSION_SCOPE_ID: 'app-session-413:squid-room',
          SQUIDRUN_PROFILE: 'main',
          SQUIDRUN_WINDOW_KEY: 'squid-room',
          SQUIDRUN_WORKING_DIR: workingDir,
        }),
        {
          paneCommand: 'codex --yolo',
          spawnCommandOnCreate: true,
        }
      );
    });

    test('spawns codex panes with null mode (interactive PTY, not codex-exec)', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '2': 'codex --mode exec' };
      const expectedEnv = process.platform === 'win32'
        ? expect.objectContaining({
          TEMP: expect.any(String),
          TMP: expect.any(String),
        })
        : null;

      await harness.invoke('pty-create', '2', '/test/dir');

      // All panes use interactive PTY mode — codex-exec mode removed
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        '2',
        expect.any(String),
        false,
        null,
        expectedEnv,
        { paneCommand: 'codex --mode exec' }
      );
    });

    test('spawns with null mode for claude command', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '1': 'claude' };

      await harness.invoke('pty-create', '1', '/test/dir');

      const spawnCall = ctx.daemonClient.spawn.mock.calls[0];
      expect(spawnCall[0]).toBe('1');
      expect(spawnCall[2]).toBe(false);
      expect(spawnCall[3]).toBe(null);
      expect(spawnCall[5]).toEqual({ paneCommand: 'claude' });
      if (process.platform === 'win32') {
        expect(spawnCall[4]).toEqual(expect.objectContaining({
          TEMP: expect.any(String),
          TMP: expect.any(String),
          TMPDIR: expect.any(String),
        }));
      } else {
        expect(spawnCall[4]).toBe(null);
      }
    });

    test('injects spaceless TEMP/TMP/TMPDIR for Claude panes on Windows', async () => {
      const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '99': 'claude' };
      const workingDir = 'D:\\projects\\squidrun';
      const expectedTemp = 'D:\\squidrun-tmp';

      await withPlatform('win32', async () => {
        await harness.invoke('pty-create', '99', workingDir);
      });

      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        '99',
        workingDir,
        false,
        null,
        expect.objectContaining({
          TEMP: expectedTemp,
          TMP: expectedTemp,
          TMPDIR: expectedTemp,
        }),
        { paneCommand: 'claude' }
      );
      expect(_internals.isInsideSquidRunPrivateRoot(expectedTemp)).toBe(false);
      mkdirSpy.mockRestore();
    });

    test('respects dryRun setting', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.dryRun = true;

      const result = await harness.invoke('pty-create', '1', '/test');
      const expectedEnv = process.platform === 'win32'
        ? expect.objectContaining({
          TEMP: expect.any(String),
          TMP: expect.any(String),
          TMPDIR: expect.any(String),
        })
        : null;

      expect(result.dryRun).toBe(true);
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        '1',
        expect.any(String),
        true,
        null,
        expectedEnv,
        { paneCommand: '' }
      );
    });

    test('sets GEMINI_SYSTEM_MD env for gemini panes when firmware injection is enabled', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.firmwareInjectionEnabled = true;
      ctx.currentSettings.paneCommands = { '3': 'gemini --yolo' };
      deps.firmwareManager = {
        ensureFirmwareForPane: jest.fn(() => ({ ok: true, firmwarePath: '/tmp/fw/oracle.md' })),
      };

      const result = await harness.invoke('pty-create', '3', '/fallback/dir');
      const expectedEnv = process.platform === 'win32'
        ? expect.objectContaining({
          GEMINI_SYSTEM_MD: '/tmp/fw/oracle.md',
          TEMP: expect.any(String),
          TMP: expect.any(String),
        })
        : { GEMINI_SYSTEM_MD: '/tmp/fw/oracle.md' };

      expect(result.paneId).toBe('3');
      expect(deps.firmwareManager.ensureFirmwareForPane).toHaveBeenCalledWith('3');
      expect(ctx.daemonClient.spawn).toHaveBeenCalledWith(
        '3',
        expect.any(String),
        false,
        null,
        expectedEnv,
        { paneCommand: 'gemini --yolo' }
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

    test('writes large payload (chunking now handled pre-IPC)', async () => {
      ctx.daemonClient.connected = true;
      ctx.daemonClient.write.mockReturnValue(true);
      const payload = 'X'.repeat(2500);

      const invokePromise = harness.invoke('pty-write', '1', payload);
      await jest.runAllTimersAsync();
      const result = await invokePromise;

      expect(result).toEqual({ success: true, chunked: true, chunks: 10, chunkSize: 256 });
      expect(ctx.daemonClient.write).toHaveBeenCalled();
    });

    test('returns failure when large write fails', async () => {
      ctx.daemonClient.connected = true;
      ctx.daemonClient.write.mockReturnValue(false);
      const payload = 'Y'.repeat(2500);

      const result = await harness.invoke('pty-write', '1', payload);

      expect(ctx.daemonClient.write).toHaveBeenCalled();
      expect(result).toEqual({ success: false, error: 'Failed to send write to daemon' });
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

    test('honors 256-byte chunks for hm-send visible fallback writes', async () => {
      ctx.daemonClient.connected = true;
      const payload = `HEAD-${'M'.repeat(740)}-MIDDLE-${'T'.repeat(740)}-TAIL`;
      const result = await harness.invoke('pty-write-chunked', '1', payload, {
        chunkSize: 256,
        yieldEveryChunks: 0,
      });

      expect(result).toEqual({ success: true, chunks: 6, chunkSize: 256 });
      expect(ctx.daemonClient.write).toHaveBeenCalledTimes(6);
      expect(ctx.daemonClient.write.mock.calls[0][1]).toContain('HEAD-');
      expect(ctx.daemonClient.write.mock.calls[2][1]).toContain('MIDDLE');
      expect(ctx.daemonClient.write.mock.calls[5][1]).toContain('-TAIL');
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

    test('waits for each chunk ack before sending the next chunk', async () => {
      ctx.daemonClient.connected = true;
      const resolvers = [];
      ctx.daemonClient.writeAndWaitAck = jest.fn(() => new Promise((resolve) => {
        resolvers.push(resolve);
      }));
      const payload = 'E'.repeat(4200);

      const resultPromise = harness.invoke('pty-write-chunked', '1', payload, { chunkSize: 2048 });
      await Promise.resolve();

      expect(ctx.daemonClient.writeAndWaitAck).toHaveBeenCalledTimes(1);
      expect(ctx.daemonClient.writeAndWaitAck.mock.calls[0][1]).toBe(payload.slice(0, 2048));

      resolvers.shift()({ success: true, status: 'accepted' });
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      expect(ctx.daemonClient.writeAndWaitAck).toHaveBeenCalledTimes(2);
      expect(ctx.daemonClient.writeAndWaitAck.mock.calls[1][1]).toBe(payload.slice(2048, 4096));

      resolvers.shift()({ success: true, status: 'accepted' });
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      expect(ctx.daemonClient.writeAndWaitAck).toHaveBeenCalledTimes(3);
      expect(ctx.daemonClient.writeAndWaitAck.mock.calls[2][1]).toBe(payload.slice(4096));

      resolvers.shift()({ success: true, status: 'accepted' });
      await expect(resultPromise).resolves.toEqual({ success: true, chunks: 3, chunkSize: 2048 });
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

  describe('startup-injection-claim', () => {
    test('preload bridge allowlist exposes atomic startup injection claim channel', async () => {
      const { isAllowedInvokeChannel } = require('../modules/bridge/channel-policy');
      const { createPreloadApi } = require('../modules/bridge/preload-api');
      const ipcRenderer = {
        invoke: jest.fn().mockResolvedValue({ ok: true, claimed: true }),
        send: jest.fn(),
        on: jest.fn(),
        removeListener: jest.fn(),
        removeAllListeners: jest.fn(),
      };

      const api = createPreloadApi(ipcRenderer);
      await expect(api.pty.claimStartupInjection({ paneId: '1', source: 'spawn' }))
        .resolves.toEqual({ ok: true, claimed: true });

      expect(isAllowedInvokeChannel('startup-injection-claim')).toBe(true);
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('startup-injection-claim', {
        paneId: '1',
        source: 'spawn',
      });
    });

    test('atomically grants the first per-pane claim and denies later claimants', async () => {
      const first = await harness.invoke('startup-injection-claim', {
        paneId: '1',
        source: 'main-window',
        windowKey: 'main',
      });
      const second = await harness.invoke('startup-injection-claim', {
        paneId: '1',
        source: 'squid-room',
        windowKey: 'squid-room',
      });

      expect(first).toEqual(expect.objectContaining({
        ok: true,
        claimed: true,
        paneId: '1',
        claim: expect.objectContaining({
          paneId: '1',
          source: 'main-window',
          windowKey: 'main',
        }),
      }));
      expect(second).toEqual(expect.objectContaining({
        ok: true,
        claimed: false,
        paneId: '1',
        reason: 'startup_injection_already_claimed',
        claim: expect.objectContaining({
          source: 'main-window',
          windowKey: 'main',
        }),
      }));
    });

    test('pty-create starts a new lifecycle and clears the prior claim', async () => {
      ctx.daemonClient.connected = true;

      await harness.invoke('startup-injection-claim', { paneId: '2', source: 'first-renderer' });
      const denied = await harness.invoke('startup-injection-claim', { paneId: '2', source: 'second-renderer' });
      expect(denied.claimed).toBe(false);

      await harness.invoke('pty-create', '2', '/workspace');
      const reclaimed = await harness.invoke('startup-injection-claim', { paneId: '2', source: 'new-pty' });

      expect(reclaimed).toEqual(expect.objectContaining({
        ok: true,
        claimed: true,
        paneId: '2',
        claim: expect.objectContaining({ source: 'new-pty' }),
      }));
    });

    test('pty-kill clears the prior claim', async () => {
      ctx.daemonClient.connected = true;

      await harness.invoke('startup-injection-claim', { paneId: '3', source: 'first-renderer' });
      await harness.invoke('pty-kill', '3');
      const reclaimed = await harness.invoke('startup-injection-claim', { paneId: '3', source: 'after-kill' });

      expect(reclaimed).toEqual(expect.objectContaining({
        ok: true,
        claimed: true,
        paneId: '3',
        claim: expect.objectContaining({ source: 'after-kill' }),
      }));
    });
  });

  describe('spawn-claude', () => {
    beforeEach(() => {
      ctx.currentSettings.allowAllPermissions = true;
      ctx.currentSettings.autonomyConsentGiven = true;
    });

    const extractResumeId = (command) => {
      const match = String(command || '').match(/(?:--session-id|--resume)\s+([0-9a-f-]{36})/i);
      return match ? match[1] : null;
    };

    const writeClaudeSession = (cwd, sessionId) => {
      const dir = path.join(deps.resumeHomeDir, '.claude', 'projects', encodeClaudeProjectDir(cwd));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n');
    };

    test('simulates spawn in dry-run mode', async () => {
      ctx.currentSettings.dryRun = true;
      const result = await harness.invoke('spawn-claude', '1', '/dir');

      expect(result).toEqual({ success: true, command: null, dryRun: true });
      expect(ctx.agentRunning.get('1')).toBe('running');
      expect(deps.broadcastClaudeState).toHaveBeenCalled();
      expect(fs.existsSync(deps.paneSessionIdsFilePath)).toBe(false);
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

      expect(result.command).toMatch(/^claude --dangerously-skip-permissions --session-id [0-9a-f-]{36}$/);
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

      expect(claude.command).toMatch(/^claude --session-id [0-9a-f-]{36}$/);
      expect(claude.command).not.toContain('--dangerously-skip-permissions');
      expect(codex.command).toBe('codex');
    });

    test('does not append autonomy flags when user declines autonomy', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.paneCommands = { '1': 'claude', '2': 'codex' };
      ctx.currentSettings.allowAllPermissions = false;

      const claude = await harness.invoke('spawn-claude', '1', '/dir');
      const codex = await harness.invoke('spawn-claude', '2', '/dir');

      expect(claude.command).toMatch(/^claude --session-id [0-9a-f-]{36}$/);
      expect(claude.command).not.toContain('--dangerously-skip-permissions');
      expect(codex.command).toBe('codex');
    });

    test('registered spawn-claude composes distinct --session-id flags for panes 1/2/3', async () => {
      const cwd = 'D:\\projects\\squidrun';
      ctx.daemonClient.connected = true;
      ctx.currentSettings.allowAllPermissions = false;
      ctx.currentSettings.paneCommands = { '1': 'claude', '2': 'claude', '3': 'claude' };
      ctx.currentSettings.paneProjects = { '1': cwd, '2': cwd, '3': cwd };

      const pane1 = await harness.invoke('spawn-claude', '1', '/ignored');
      const pane2 = await harness.invoke('spawn-claude', '2', '/ignored');
      const pane3 = await harness.invoke('spawn-claude', '3', '/ignored');

      const ids = [pane1, pane2, pane3].map((result) => extractResumeId(result.command));
      expect(ids).toHaveLength(3);
      expect(ids.every((id) => UUID_RE.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(3);
      expect(pane1.command).toBe(`claude --session-id ${ids[0]}`);
      expect(pane2.command).toBe(`claude --session-id ${ids[1]}`);
      expect(pane3.command).toBe(`claude --session-id ${ids[2]}`);

      const store = loadPaneSessionIds(deps.paneSessionIdsFilePath);
      expect(store.panes).toEqual(expect.objectContaining({
        '1': ids[0],
        '2': ids[1],
        '3': ids[2],
      }));
    });

    test('registered spawn-claude re-probes session existence and switches create to resume', async () => {
      const cwd = 'D:\\projects\\squidrun';
      ctx.daemonClient.connected = true;
      ctx.currentSettings.allowAllPermissions = false;
      ctx.currentSettings.paneCommands = { '1': 'claude' };
      ctx.currentSettings.paneProjects = { '1': cwd };

      const first = await harness.invoke('spawn-claude', '1', '/ignored');
      const sessionId = extractResumeId(first.command);
      expect(first.command).toBe(`claude --session-id ${sessionId}`);

      writeClaudeSession(cwd, sessionId);
      const second = await harness.invoke('spawn-claude', '1', '/ignored');

      expect(second.command).toBe(`claude --resume ${sessionId}`);
    });

    test('registered spawn-claude does not append duplicate resume flags when command is already pinned', async () => {
      const pinnedId = '11111111-1111-4111-8111-111111111111';
      ctx.daemonClient.connected = true;
      ctx.currentSettings.allowAllPermissions = false;
      ctx.currentSettings.paneCommands = { '1': `claude --session-id ${pinnedId}` };

      const result = await harness.invoke('spawn-claude', '1', '/ignored');

      expect(result.command).toBe(`claude --session-id ${pinnedId}`);
      expect((result.command.match(/--session-id/g) || []).length).toBe(1);
      expect(fs.existsSync(deps.paneSessionIdsFilePath)).toBe(false);
    });

    test('registered spawn-claude leaves codex cold-start commands unpinned', async () => {
      ctx.daemonClient.connected = true;
      ctx.currentSettings.allowAllPermissions = false;
      ctx.currentSettings.paneCommands = { '2': 'codex --interactive' };

      const result = await harness.invoke('spawn-claude', '2', '/ignored');

      expect(result.command).toBe('codex --interactive');
      expect(result.command).not.toContain('--session-id');
      expect(result.command).not.toContain('--resume');
      expect(fs.existsSync(deps.paneSessionIdsFilePath)).toBe(false);
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

  describe('terminal-fit-telemetry (Bug A)', () => {
    test('preload bridge allowlist exposes terminal-fit-telemetry', async () => {
      const { isAllowedInvokeChannel } = require('../modules/bridge/channel-policy');
      const { createPreloadApi } = require('../modules/bridge/preload-api');
      const ipcRenderer = {
        invoke: jest.fn().mockResolvedValue({ ok: true }),
        send: jest.fn(),
        on: jest.fn(),
        removeListener: jest.fn(),
        removeAllListeners: jest.fn(),
      };

      const api = createPreloadApi(ipcRenderer);
      await expect(api.pty.recordFitTelemetry({ paneId: '1' })).resolves.toEqual({ ok: true });

      expect(isAllowedInvokeChannel('terminal-fit-telemetry')).toBe(true);
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('terminal-fit-telemetry', { paneId: '1' });
    });

    test('rejects a payload with no paneId without writing', async () => {
      const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const result = await harness.invoke('terminal-fit-telemetry', {});
      expect(result).toEqual({ ignored: true, reason: 'missing_pane_id' });
      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
    });

    test('appendTerminalFitTelemetry caps the file at 300 lines (no unbounded growth)', () => {
      const existing = Array.from({ length: 305 }, (_, i) => JSON.stringify({ paneId: '1', ts: i })).join('\n');
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(existing);
      let written = '';
      jest.spyOn(fs, 'writeFileSync').mockImplementation((_p, data) => { written = data; });

      _internals.appendTerminalFitTelemetry({ paneId: '1', ts: 999, painted: true });

      const lines = written.trim().split('\n');
      expect(lines.length).toBe(300);
      expect(lines[lines.length - 1]).toContain('"ts":999');
      jest.restoreAllMocks();
    });
  });
});
