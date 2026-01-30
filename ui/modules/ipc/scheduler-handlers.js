/**
 * Scheduler IPC Handlers
 * Channels: get-schedules, add-schedule, update-schedule, delete-schedule,
 * run-schedule-now, emit-schedule-event, complete-schedule
 */

const schedulerModule = require('../scheduler');

function registerSchedulerHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerSchedulerHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const missingDependency = (name) => ({ success: false, error: `${name} not available` });

  if (!ctx.scheduler) {
    ctx.scheduler = schedulerModule.createScheduler({
      triggers: ctx.triggers,
      workspacePath: ctx.WORKSPACE_PATH,
    });
    ctx.scheduler.init();
  }

  ipcMain.handle('get-schedules', () => {
    if (!ctx.scheduler) return missingDependency('scheduler');
    return { success: true, schedules: ctx.scheduler.listSchedules() };
  });

  ipcMain.handle('add-schedule', (event, payload) => {
    if (!ctx.scheduler) return missingDependency('scheduler');
    const schedule = ctx.scheduler.addSchedule(payload || {});
    return { success: true, schedule };
  });

  ipcMain.handle('update-schedule', (event, id, patch) => {
    if (!ctx.scheduler) return missingDependency('scheduler');
    const schedule = ctx.scheduler.updateSchedule(id, patch || {});
    if (!schedule) return { success: false, error: 'not_found' };
    return { success: true, schedule };
  });

  ipcMain.handle('delete-schedule', (event, id) => {
    if (!ctx.scheduler) return missingDependency('scheduler');
    return { success: ctx.scheduler.deleteSchedule(id) };
  });

  ipcMain.handle('run-schedule-now', (event, id) => {
    if (!ctx.scheduler) return missingDependency('scheduler');
    return ctx.scheduler.runNow(id);
  });

  ipcMain.handle('emit-schedule-event', (event, eventName, payload) => {
    if (!ctx.scheduler) return missingDependency('scheduler');
    return { success: true, results: ctx.scheduler.emitEvent(eventName, payload) };
  });

  ipcMain.handle('complete-schedule', (event, id, status) => {
    if (!ctx.scheduler) return missingDependency('scheduler');
    return { success: ctx.scheduler.markCompleted(id, status) };
  });
}

module.exports = { registerSchedulerHandlers };
