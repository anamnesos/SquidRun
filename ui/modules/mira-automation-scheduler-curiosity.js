'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MIRA_AUTOMATION_SCHEDULER_CURIOSITY_SCHEMA = 'squidrun.mira.automation_scheduler_curiosity_read_v0';

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function oneLine(value, max = 120) {
  const text = trimText(value).replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableRef(value) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(trimText(value)).digest('hex').slice(0, 12);
}

function defaultSchedulerStatePaths(projectRoot) {
  const globalRoot = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'squidrun')
    : path.join(os.homedir(), '.config', 'squidrun');
  return [
    path.join(globalRoot, 'schedules.json'),
    path.join(projectRoot, '.squidrun', 'runtime', 'schedules.json'),
    path.join(projectRoot, 'workspace', 'schedules.json'),
  ];
}

function normalizeSchedulerStatePaths(payload = {}, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const raw = options.schedulerStatePaths
    || payload.schedulerStatePaths
    || payload.scheduleStatePaths
    || payload.paths
    || payload.path;
  if (raw) {
    const entries = Array.isArray(raw) ? raw : [raw];
    return entries.map((entry) => path.resolve(projectRoot, trimText(entry))).filter(Boolean);
  }
  return defaultSchedulerStatePaths(projectRoot);
}

function readFirstScheduleState(paths) {
  const checked = [];
  for (const filePath of paths) {
    const exists = fs.existsSync(filePath);
    checked.push({ path: filePath, exists });
    if (!exists) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { ok: true, filePath, parsed, checked };
    } catch (err) {
      return {
        ok: false,
        reason: 'scheduler_state_parse_error',
        error: err?.message || String(err),
        filePath,
        checked,
      };
    }
  }
  return {
    ok: true,
    filePath: null,
    parsed: { schedules: [], lastUpdated: null },
    checked,
  };
}

function safeScheduleType(value) {
  const type = trimText(value).toLowerCase();
  return ['once', 'interval', 'cron', 'event'].includes(type) ? type : 'unknown';
}

function compactIntervalMinutes(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round((ms / 60000) * 100) / 100;
}

function compactSchedule(schedule = {}, nowMs = Date.now()) {
  const type = safeScheduleType(schedule.type);
  const nextRunMs = schedule.nextRun ? Date.parse(schedule.nextRun) : NaN;
  const lastRunMs = schedule.lastRunAt ? Date.parse(schedule.lastRunAt) : NaN;
  return {
    schedule_ref: `schedule:${stableRef(schedule.id || schedule.name || JSON.stringify(schedule))}`,
    name: oneLine(schedule.name || 'Scheduled task', 80),
    type,
    task_type: trimText(schedule.taskType) || null,
    active: schedule.active !== false,
    next_run: Number.isFinite(nextRunMs) ? new Date(nextRunMs).toISOString() : null,
    next_run_in_minutes: Number.isFinite(nextRunMs) ? Math.round(((nextRunMs - nowMs) / 60000) * 100) / 100 : null,
    last_run_at: Number.isFinite(lastRunMs) ? new Date(lastRunMs).toISOString() : null,
    last_status: trimText(schedule.lastStatus) || null,
    event_name: type === 'event' ? oneLine(schedule.eventName, 80) || null : null,
    interval_minutes: type === 'interval' ? compactIntervalMinutes(schedule.intervalMs) : null,
    cron_present: type === 'cron' ? Boolean(trimText(schedule.cron)) : null,
    has_input: Boolean(trimText(schedule.input)),
    history_count: asArray(schedule.history).length,
  };
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = trimText(item[key]) || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function readMiraAutomationSchedulerCuriosity(payload = {}, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || payload.projectRoot || process.cwd());
  const paths = normalizeSchedulerStatePaths(payload, { ...options, projectRoot });
  const nowMs = Number.isFinite(Number(options.nowMs || payload.nowMs))
    ? Number(options.nowMs || payload.nowMs)
    : Date.now();
  const limit = Math.max(1, Math.min(80, Number(payload.limit || options.limit || 24) || 24));
  const stateRead = payload.schedulerState
    ? { ok: true, filePath: null, parsed: payload.schedulerState, checked: [] }
    : readFirstScheduleState(paths);

  if (!stateRead.ok) {
    return {
      schema: MIRA_AUTOMATION_SCHEDULER_CURIOSITY_SCHEMA,
      ok: false,
      decision: 'unavailable_in_this_runtime',
      reason: stateRead.reason || 'scheduler_state_unreadable',
      error: stateRead.error || null,
      state_path: stateRead.filePath || null,
      checked_paths: stateRead.checked || [],
      no_mutation_performed: true,
      consequence_controls: {
        internal_only: true,
        read_only: true,
        schedule_created: false,
        schedule_updated: false,
        schedule_run_performed: false,
        external_send_performed: false,
      },
    };
  }

  const state = stateRead.parsed && typeof stateRead.parsed === 'object' ? stateRead.parsed : {};
  const schedules = asArray(state.schedules);
  const compact = schedules
    .map((schedule) => compactSchedule(schedule, nowMs))
    .sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      const leftNext = left.next_run ? Date.parse(left.next_run) : Number.POSITIVE_INFINITY;
      const rightNext = right.next_run ? Date.parse(right.next_run) : Number.POSITIVE_INFINITY;
      return leftNext - rightNext || left.name.localeCompare(right.name);
    })
    .slice(0, limit);
  const dueSoon = compact.filter((schedule) => (
    schedule.active
    && Number.isFinite(Number(schedule.next_run_in_minutes))
    && Number(schedule.next_run_in_minutes) >= 0
    && Number(schedule.next_run_in_minutes) <= 60
  ));
  const overdue = compact.filter((schedule) => (
    schedule.active
    && Number.isFinite(Number(schedule.next_run_in_minutes))
    && Number(schedule.next_run_in_minutes) < 0
  ));
  const active = compact.filter((schedule) => schedule.active);

  return {
    schema: MIRA_AUTOMATION_SCHEDULER_CURIOSITY_SCHEMA,
    ok: true,
    decision: 'scheduler_state_read_only',
    state_found: Boolean(stateRead.filePath),
    state_path: stateRead.filePath || null,
    checked_paths: stateRead.checked || [],
    schedule_count: schedules.length,
    active_count: schedules.filter((schedule) => schedule.active !== false).length,
    due_soon_count: dueSoon.length,
    overdue_count: overdue.length,
    type_counts: countBy(compact, 'type'),
    last_updated: trimText(state.lastUpdated) || null,
    next_schedule: active.find((schedule) => schedule.next_run) || null,
    schedules: compact,
    scheduler_operations: [
      'get-schedules',
      'add-schedule',
      'update-schedule',
      'delete-schedule',
      'run-schedule-now',
      'emit-schedule-event',
      'complete-schedule',
    ],
    no_mutation_performed: true,
    consequence_controls: {
      internal_only: true,
      read_only: true,
      schedule_created: false,
      schedule_updated: false,
      schedule_deleted: false,
      schedule_run_performed: false,
      external_send_performed: false,
    },
  };
}

module.exports = {
  MIRA_AUTOMATION_SCHEDULER_CURIOSITY_SCHEMA,
  defaultSchedulerStatePaths,
  readMiraAutomationSchedulerCuriosity,
};
