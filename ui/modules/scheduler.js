/**
 * Task Scheduler
 * Supports once, interval, cron, and event-based schedules.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');
const taskParser = require('./task-parser');

const DEFAULT_SCHEDULE_STATE = {
  schedules: [],
  lastUpdated: null,
};

const HISTORY_LIMIT = 100;
const CHECK_INTERVAL_MS = 30000;

function generateId() {
  return crypto.randomBytes(6).toString('hex');
}

function nowMs() {
  return Date.now();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getDateParts(date, timeZone) {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
    };
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    });
    const parts = formatter.formatToParts(date);
    const lookup = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      year: parseInt(lookup.year, 10),
      month: parseInt(lookup.month, 10),
      day: parseInt(lookup.day, 10),
      hour: parseInt(lookup.hour, 10),
      minute: parseInt(lookup.minute, 10),
      weekday: weekdayMap[lookup.weekday] ?? 0,
    };
  } catch (err) {
    log.warn('Scheduler', `Invalid timezone ${timeZone}, falling back to local`);
    return getDateParts(date, null);
  }
}

function parseCronField(field, min, max) {
  const values = new Set();
  const parts = field.split(',');
  for (const part of parts) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }
    const stepMatch = part.match(/^(\*|\d+)-(\d+)?\/?(\d+)?$/);
    if (stepMatch) {
      let start = stepMatch[1] === '*' ? min : parseInt(stepMatch[1], 10);
      let end = stepMatch[2] ? parseInt(stepMatch[2], 10) : (stepMatch[1] === '*' ? max : start);
      const step = stepMatch[3] ? parseInt(stepMatch[3], 10) : 1;
      start = clamp(start, min, max);
      end = clamp(end, min, max);
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (!Number.isNaN(step) && step > 0) {
        for (let i = min; i <= max; i += step) values.add(i);
      }
      continue;
    }
    const num = parseInt(part, 10);
    if (!Number.isNaN(num)) {
      values.add(clamp(num, min, max));
    }
  }
  return values;
}

function matchesCron(date, cron, timeZone) {
  if (!cron) return false;
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minField, hourField, dayField, monthField, weekdayField] = parts;
  const dateParts = getDateParts(date, timeZone);
  const minutes = parseCronField(minField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const days = parseCronField(dayField, 1, 31);
  const months = parseCronField(monthField, 1, 12);
  const weekdays = parseCronField(weekdayField, 0, 6);
  return minutes.has(dateParts.minute)
    && hours.has(dateParts.hour)
    && days.has(dateParts.day)
    && months.has(dateParts.month)
    && weekdays.has(dateParts.weekday);
}

function computeNextCron(afterDate, cron, timeZone) {
  const start = new Date(afterDate.getTime() + 60000);
  for (let i = 0; i < 60 * 24 * 14; i++) {
    const candidate = new Date(start.getTime() + i * 60000);
    if (matchesCron(candidate, cron, timeZone)) {
      return candidate;
    }
  }
  return null;
}

function computeNextRun(schedule, referenceDate = new Date()) {
  if (!schedule.active) return null;
  if (schedule.type === 'event') return null;

  if (schedule.type === 'once') {
    const runAt = schedule.runAt ? new Date(schedule.runAt) : null;
    if (!runAt || Number.isNaN(runAt.getTime())) return null;
    return runAt.getTime() > referenceDate.getTime() ? runAt : null;
  }

  if (schedule.type === 'interval') {
    const intervalMs = schedule.intervalMs || 0;
    if (!intervalMs) return null;
    const last = schedule.lastRunAt ? new Date(schedule.lastRunAt) : referenceDate;
    const next = new Date(last.getTime() + intervalMs);
    return next;
  }

  if (schedule.type === 'cron') {
    const next = computeNextCron(referenceDate, schedule.cron, schedule.timeZone);
    return next;
  }

  return null;
}

function createScheduler({ triggers, workspacePath }) {
  const filePath = path.join(workspacePath, 'schedules.json');
  let scheduleState = { ...DEFAULT_SCHEDULE_STATE };
  let timer = null;

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        scheduleState = { ...DEFAULT_SCHEDULE_STATE, ...JSON.parse(content) };
      }
    } catch (err) {
      log.error('Scheduler', 'Failed to load schedules', err.message);
    }
    scheduleState.schedules = scheduleState.schedules || [];
  }

  function save() {
    try {
      scheduleState.lastUpdated = new Date().toISOString();
      const tempPath = filePath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(scheduleState, null, 2), 'utf-8');
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      log.error('Scheduler', 'Failed to save schedules', err.message);
    }
  }

  function ensureNextRun(schedule) {
    const next = computeNextRun(schedule, new Date());
    schedule.nextRun = next ? next.toISOString() : null;
  }

  function listSchedules() {
    return scheduleState.schedules.map(item => ({ ...item }));
  }

  function addSchedule(payload) {
    const schedule = {
      id: generateId(),
      name: payload.name || payload.input?.slice(0, 60) || 'Scheduled task',
      type: payload.type || 'once',
      input: payload.input || '',
      taskType: payload.taskType || null,
      active: payload.active !== false,
      runAt: payload.runAt || null,
      intervalMs: payload.intervalMs || null,
      cron: payload.cron || null,
      timeZone: payload.timeZone || null,
      eventName: payload.eventName || null,
      chainAfter: payload.chainAfter || null,
      chainRequiresSuccess: payload.chainRequiresSuccess !== false,
      lastRunAt: null,
      lastStatus: null,
      nextRun: null,
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    ensureNextRun(schedule);
    scheduleState.schedules.push(schedule);
    save();
    return schedule;
  }

  function updateSchedule(id, patch) {
    const schedule = scheduleState.schedules.find(s => s.id === id);
    if (!schedule) return null;

    Object.assign(schedule, patch);
    schedule.updatedAt = new Date().toISOString();
    ensureNextRun(schedule);
    save();
    return schedule;
  }

  function deleteSchedule(id) {
    const idx = scheduleState.schedules.findIndex(s => s.id === id);
    if (idx === -1) return false;
    scheduleState.schedules.splice(idx, 1);
    save();
    return true;
  }

  function recordHistory(schedule, entry) {
    schedule.history = schedule.history || [];
    schedule.history.push(entry);
    if (schedule.history.length > HISTORY_LIMIT) {
      schedule.history = schedule.history.slice(-HISTORY_LIMIT);
    }
  }

  function runTask(schedule, reason = 'scheduled') {
    if (!triggers || typeof triggers.routeTask !== 'function') {
      return { success: false, reason: 'missing_triggers' };
    }

    const parsed = taskParser.parseTaskInput(schedule.input || schedule.name || '');
    const results = [];
    let success = true;

    if (!parsed.success) {
      return { success: false, reason: 'parse_failed' };
    }

    for (const task of parsed.subtasks) {
      const result = triggers.routeTask(task.taskType, task.text);
      results.push({ task, result });
      if (!result.success) success = false;
    }

    schedule.lastRunAt = new Date().toISOString();
    schedule.lastStatus = success ? 'success' : 'failed';
    recordHistory(schedule, {
      at: schedule.lastRunAt,
      status: schedule.lastStatus,
      reason,
      tasks: results.map(r => ({
        taskType: r.task.taskType,
        text: r.task.text,
        paneId: r.result.paneId || null,
        success: r.result.success,
      })),
    });

    if (schedule.type === 'once') {
      schedule.active = false;
      schedule.nextRun = null;
    } else {
      ensureNextRun(schedule);
    }

    save();
    return { success, results };
  }

  function checkDueSchedules() {
    const now = new Date();
    let fired = 0;
    for (const schedule of scheduleState.schedules) {
      if (!schedule.active) continue;
      if (schedule.chainAfter) {
        const parent = scheduleState.schedules.find(s => s.id === schedule.chainAfter);
        if (!parent || parent.lastStatus !== 'success') {
          continue;
        }
      }
      if (schedule.type === 'event') continue;
      if (!schedule.nextRun) ensureNextRun(schedule);
      if (!schedule.nextRun) continue;
      const nextRun = new Date(schedule.nextRun);
      if (nextRun <= now) {
        const result = runTask(schedule, 'time');
        fired += result.success ? 1 : 0;
      }
    }
    return fired;
  }

  function emitEvent(eventName, payload) {
    const now = new Date();
    const matched = scheduleState.schedules.filter(s => s.active && s.type === 'event' && s.eventName === eventName);
    const results = [];
    matched.forEach(schedule => {
      schedule.lastRunAt = now.toISOString();
      const result = runTask(schedule, 'event');
      results.push({ scheduleId: schedule.id, result });
    });
    save();
    return results;
  }

  function markCompleted(id, status = 'success') {
    const schedule = scheduleState.schedules.find(s => s.id === id);
    if (!schedule) return false;
    schedule.lastStatus = status;
    schedule.lastRunAt = new Date().toISOString();
    ensureNextRun(schedule);
    save();
    return true;
  }

  function start() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      try {
        checkDueSchedules();
      } catch (err) {
        log.error('Scheduler', 'Tick error', err.message);
      }
    }, CHECK_INTERVAL_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function init() {
    load();
    scheduleState.schedules.forEach(ensureNextRun);
    save();
    start();
  }

  function runNow(id) {
    const schedule = scheduleState.schedules.find(s => s.id === id);
    if (!schedule) return { success: false, reason: 'not_found' };
    const result = runTask(schedule, 'manual');
    save();
    return result;
  }

  return {
    init,
    listSchedules,
    addSchedule,
    updateSchedule,
    deleteSchedule,
    emitEvent,
    markCompleted,
    runNow,
    stop,
    checkDueSchedules,
  };
}

module.exports = {
  createScheduler,
  matchesCron,
  computeNextRun,
};
