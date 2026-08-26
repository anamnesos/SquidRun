'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIRA_AUTOMATION_SCHEDULER_CURIOSITY_SCHEMA,
  readMiraAutomationSchedulerCuriosity,
} = require('../modules/mira-automation-scheduler-curiosity');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-scheduler-curiosity-'));
}

describe('Mira automation scheduler curiosity', () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  });

  test('reads compact scheduler metadata without exposing raw task input or mutating schedules', () => {
    projectRoot = tempProject();
    const statePath = path.join(projectRoot, '.squidrun', 'runtime', 'schedules.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      lastUpdated: '2026-05-12T19:50:00.000Z',
      schedules: [
        {
          id: 'raw-schedule-id-1',
          name: 'Quiet interval curiosity burst',
          type: 'interval',
          input: 'run a sensitive internal task body that should not be echoed',
          taskType: 'builder',
          active: true,
          intervalMs: 1800000,
          nextRun: '2026-05-12T20:30:00.000Z',
          lastRunAt: '2026-05-12T20:00:00.000Z',
          lastStatus: 'success',
          history: [{ at: '2026-05-12T20:00:00.000Z' }],
        },
        {
          id: 'raw-schedule-id-2',
          name: 'Post-commit review',
          type: 'event',
          eventName: 'post-commit',
          active: false,
        },
      ],
    }), 'utf8');

    const result = readMiraAutomationSchedulerCuriosity({}, {
      projectRoot,
      schedulerStatePaths: [statePath],
      nowMs: Date.parse('2026-05-12T20:10:00.000Z'),
    });

    expect(result.schema).toBe(MIRA_AUTOMATION_SCHEDULER_CURIOSITY_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('scheduler_state_read_only');
    expect(result.state_found).toBe(true);
    expect(result.schedule_count).toBe(2);
    expect(result.active_count).toBe(1);
    expect(result.due_soon_count).toBe(1);
    expect(result.type_counts).toEqual(expect.objectContaining({
      interval: 1,
      event: 1,
    }));
    expect(result.next_schedule).toEqual(expect.objectContaining({
      name: 'Quiet interval curiosity burst',
      interval_minutes: 30,
      has_input: true,
      history_count: 1,
    }));
    expect(result.next_schedule.schedule_ref).toMatch(/^schedule:/);
    expect(JSON.stringify(result)).not.toContain('sensitive internal task body');
    expect(JSON.stringify(result)).not.toContain('raw-schedule-id-1');
    expect(result.scheduler_operations).toEqual(expect.arrayContaining([
      'get-schedules',
      'add-schedule',
      'run-schedule-now',
    ]));
    expect(result.consequence_controls).toEqual(expect.objectContaining({
      internal_only: true,
      read_only: true,
      schedule_created: false,
      schedule_updated: false,
      schedule_deleted: false,
      schedule_run_performed: false,
      external_send_performed: false,
    }));
  });

  test('treats missing schedule state as readable empty scheduler metadata', () => {
    projectRoot = tempProject();
    const result = readMiraAutomationSchedulerCuriosity({}, {
      projectRoot,
      schedulerStatePaths: [path.join(projectRoot, 'missing-schedules.json')],
    });

    expect(result.ok).toBe(true);
    expect(result.decision).toBe('scheduler_state_read_only');
    expect(result.state_found).toBe(false);
    expect(result.schedule_count).toBe(0);
    expect(result.active_count).toBe(0);
    expect(result.no_mutation_performed).toBe(true);
  });

  test('reports parse errors without creating, running, or updating schedules', () => {
    projectRoot = tempProject();
    const statePath = path.join(projectRoot, 'schedules.json');
    fs.writeFileSync(statePath, '{ not json', 'utf8');

    const result = readMiraAutomationSchedulerCuriosity({}, {
      projectRoot,
      schedulerStatePaths: [statePath],
    });

    expect(result.ok).toBe(false);
    expect(result.decision).toBe('unavailable_in_this_runtime');
    expect(result.reason).toBe('scheduler_state_parse_error');
    expect(result.no_mutation_performed).toBe(true);
    expect(result.consequence_controls).toEqual(expect.objectContaining({
      read_only: true,
      schedule_created: false,
      schedule_updated: false,
      schedule_run_performed: false,
      external_send_performed: false,
    }));
  });
});
