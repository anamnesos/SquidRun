/**
 * Background Process IPC Handlers
 * Channels: spawn-process, list-processes, kill-process, get-process-output
 */

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createBackgroundProcessController } = require('./background-processes');

const ALLOWED_COMMANDS = new Set([
  'npm', 'npx', 'node', 'git', 'jest', 'eslint', 'tsc', 'prettier',
  'npm.cmd', 'npx.cmd', 'node.exe', 'git.exe',
]);

const WINDOWS_COMMAND_MAP = Object.freeze({
  npm: 'npm.cmd',
  npx: 'npx.cmd',
  jest: 'jest.cmd',
  eslint: 'eslint.cmd',
  tsc: 'tsc.cmd',
  prettier: 'prettier.cmd',
});
const DEFAULT_THROTTLE_QUEUE_MAX_ITEMS = 200;
const DEFAULT_THROTTLE_QUEUE_MAX_BYTES = 512 * 1024;

function toPositiveInt(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function registerProcessHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerProcessHandlers requires ctx.ipcMain');
  }
  const { ipcMain } = ctx;
  if (!ctx.backgroundProcesses) {
    ctx.backgroundProcesses = new Map();
  }
  if (typeof ctx.processIdCounter !== 'number') {
    ctx.processIdCounter = 1;
  }

  const { broadcastProcessList } = createBackgroundProcessController(ctx);

  ipcMain.handle('spawn-process', (event, command, args = [], cwd = null) => {
    try {
      if (typeof command !== 'string' || !command.trim()) {
        return { success: false, error: 'Invalid command' };
      }
      const requestedCommand = command.trim();
      const baseName = path.basename(requestedCommand).toLowerCase();
      if (!ALLOWED_COMMANDS.has(baseName)) {
        return { success: false, error: `Command not allowed: ${baseName}` };
      }
      if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) {
        return { success: false, error: 'Invalid args: must be array of strings' };
      }
      const id = `proc-${ctx.processIdCounter++}`;
      const workDir = cwd || process.cwd();

      const isWindows = os.platform() === 'win32';
      const spawnCommand = isWindows
        ? (WINDOWS_COMMAND_MAP[baseName] || requestedCommand)
        : requestedCommand;
      const spawnOptions = {
        cwd: workDir,
        shell: false,
        env: process.env,
      };

      const proc = spawn(spawnCommand, args, spawnOptions);

      const processInfo = {
        id,
        command: requestedCommand,
        args,
        cwd: workDir,
        pid: proc.pid,
        startTime: new Date().toISOString(),
        status: 'running',
        output: [],
      };

      const captureOutput = (data) => {
        const lines = data.toString().split('\n');
        processInfo.output.push(...lines);
        if (processInfo.output.length > 100) {
          processInfo.output = processInfo.output.slice(-100);
        }
      };

      proc.stdout.on('data', captureOutput);
      proc.stderr.on('data', captureOutput);

      let finalized = false;
      const finalizeProcess = (updater) => {
        if (finalized) return;
        finalized = true;
        if (typeof updater === 'function') {
          updater(processInfo);
        }
        ctx.backgroundProcesses.delete(id);
        broadcastProcessList();
      };

      proc.on('error', (err) => {
        finalizeProcess((info) => {
          info.status = 'error';
          info.error = err.message;
        });
      });

      proc.on('exit', (code) => {
        finalizeProcess((info) => {
          info.status = code === 0 ? 'stopped' : 'error';
          info.exitCode = code;
        });
      });

      ctx.backgroundProcesses.set(id, { process: proc, info: processInfo });
      broadcastProcessList();

      return { success: true, id, pid: proc.pid };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('list-processes', () => {
    const processes = [];
    for (const [_id, { info }] of ctx.backgroundProcesses) {
      processes.push({
        id: info.id,
        command: info.command,
        args: info.args,
        cwd: info.cwd,
        pid: info.pid,
        startTime: info.startTime,
        status: info.status,
        exitCode: info.exitCode,
        error: info.error,
      });
    }
    return { success: true, processes };
  });

  ipcMain.handle('kill-process', (event, processId) => {
    try {
      const entry = ctx.backgroundProcesses.get(processId);
      if (!entry) {
        return { success: false, error: 'Process not found' };
      }

      const { process: proc, info } = entry;

      if (os.platform() === 'win32') {
        spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t']);
      } else {
        proc.kill('SIGTERM');
      }

      info.status = 'stopped';
      broadcastProcessList();

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-process-output', (event, processId) => {
    const entry = ctx.backgroundProcesses.get(processId);
    if (!entry) {
      return { success: false, error: 'Process not found' };
    }
    return { success: true, output: entry.info.output.join('\n') };
  });

  ipcMain.handle('daemon-is-process-running', (event, pid) => {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) {
      return { running: false };
    }

    try {
      process.kill(numericPid, 0);
      return { running: true };
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
        return { running: true };
      }
      return { running: false };
    }
  });

  ipcMain.handle('get-daemon-runtime-config', () => ({
    throttleQueueMaxItems: toPositiveInt(
      process.env.SQUIDRUN_THROTTLE_QUEUE_MAX_ITEMS,
      DEFAULT_THROTTLE_QUEUE_MAX_ITEMS
    ),
    throttleQueueMaxBytes: toPositiveInt(
      process.env.SQUIDRUN_THROTTLE_QUEUE_MAX_BYTES,
      DEFAULT_THROTTLE_QUEUE_MAX_BYTES
    ),
  }));
}


function unregisterProcessHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('spawn-process');
    ipcMain.removeHandler('list-processes');
    ipcMain.removeHandler('kill-process');
    ipcMain.removeHandler('get-process-output');
    ipcMain.removeHandler('daemon-is-process-running');
    ipcMain.removeHandler('get-daemon-runtime-config');
}

registerProcessHandlers.unregister = unregisterProcessHandlers;
module.exports = { registerProcessHandlers };
