const os = require('os');
const { spawn } = require('child_process');
const log = require('../logger');

function createBackgroundProcessController(ctx) {
  const broadcastProcessList = () => {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      const processes = [];
      for (const [_id, { info }] of ctx.backgroundProcesses) {
        processes.push({
          id: info.id,
          command: info.command,
          args: info.args,
          pid: info.pid,
          status: info.status,
        });
      }
      ctx.mainWindow.webContents.send('processes-changed', processes);
    }
  };

  const getBackgroundProcesses = () => ctx.backgroundProcesses;

  const cleanupProcesses = () => {
    for (const [id, { process: proc, info }] of ctx.backgroundProcesses) {
      try {
        if (proc && info && info.status === 'running' && proc.pid) {
          if (os.platform() === 'win32') {
            spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { shell: true });
          } else {
            proc.kill('SIGTERM');
          }
        }
      } catch (err) {
        log.error('Cleanup', `Error killing process ${id}`, err.message);
      }
    }
    ctx.backgroundProcesses.clear();
  };

  return {
    broadcastProcessList,
    getBackgroundProcesses,
    cleanupProcesses,
  };
}

module.exports = { createBackgroundProcessController };
