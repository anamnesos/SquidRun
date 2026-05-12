'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Mira work continuation curiosity', () => {
  let tempRoot;
  let queuePath;
  let queue;
  let adapter;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mira-work-continuation-'));
    queuePath = path.join(tempRoot, 'runtime', 'agent-task-queue.json');
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      getActiveProfile: () => 'main',
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        String(relPath || '').replace(/^[/\\]+/, '').replace(/[/\\]+/g, path.sep),
      ),
    }));
    queue = require('../scripts/hm-task-queue');
    adapter = require('../modules/mira-work-continuation-curiosity');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('../config');
  });

  test('reads owned-work summary and exposes the next dispatch-ready continuation without dispatching', () => {
    const nowMs = Date.parse('2026-05-12T20:20:00.000Z');
    queue.writeQueue({
      version: 2,
      updatedAt: '2026-05-12T20:19:00.000Z',
      agents: {
        builder: {
          active: {
            taskId: 'builder-active-1',
            owner: 'builder',
            state: 'active',
            riskClass: 'caution',
            title: 'Scheduler lane',
            message: 'Finish the scheduler lane.',
            nextStep: 'Run focused scheduler tests.',
            lastAdvancedAt: nowMs - 120000,
          },
          pending: [],
          history: [],
        },
        oracle: {
          active: null,
          pending: [
            {
              taskId: 'oracle-safe-1',
              owner: 'oracle',
              state: 'queued',
              riskClass: 'safe',
              title: 'Review next lane',
              message: 'Review next lane.',
              nextStep: 'Check work continuation adapter evidence.',
              source: 'mira',
              wakeTrigger: 'post-wake',
              lastAdvancedAt: nowMs - 1000,
            },
            {
              taskId: 'oracle-held-1',
              owner: 'oracle',
              state: 'queued',
              riskClass: 'approval_required',
              title: 'Send customer mail',
              message: 'Send customer mail.',
              blockedReason: 'Needs James approval',
              wakeTrigger: 'post-wake',
              lastAdvancedAt: nowMs - 1000,
            },
          ],
          history: [],
        },
      },
    }, queuePath);

    const result = adapter.readMiraWorkContinuationCuriosity({
      queuePath,
      nowMs,
      wakeTrigger: 'post-wake',
      staleAfterMs: 60000,
    });

    expect(result.schema).toBe(adapter.MIRA_WORK_CONTINUATION_CURIOSITY_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('work_continuation_read_only');
    expect(result.totals).toEqual(expect.objectContaining({
      active_count: 1,
      carried_count: 3,
      approval_required_count: 1,
    }));
    expect(result.agents.builder).toEqual(expect.objectContaining({
      active_task_id: 'builder-active-1',
      active_title: 'Scheduler lane',
      stale_count: 1,
    }));
    expect(result.next_action).toEqual(expect.objectContaining({
      agent: 'oracle',
      task_id: 'oracle-safe-1',
      risk_class: 'safe',
      next_step: 'Check work continuation adapter evidence.',
      resume_command: 'node ui/scripts/hm-task-queue.js wake --dispatch --agent oracle --trigger post-wake',
    }));
    expect(result.held_count).toBe(1);
    expect(result.held_reasons).toContain('approval_required');
    expect(result.consequence_controls).toEqual(expect.objectContaining({
      read_only: true,
      queue_mutation_performed: false,
      dispatch_performed: false,
      external_send_performed: false,
    }));
  });

  test('returns a clean no-action shape when no owned work is due', () => {
    const nowMs = Date.parse('2026-05-12T20:20:00.000Z');
    queue.writeQueue({
      version: 2,
      updatedAt: '2026-05-12T20:19:00.000Z',
      agents: {},
    }, queuePath);

    const result = adapter.readMiraWorkContinuationCuriosity({ queuePath, nowMs });

    expect(result.ok).toBe(true);
    expect(result.next_action).toBe(null);
    expect(result.next_action_reason).toBe('no_due_owned_work');
    expect(result.totals.carried_count).toBe(0);
    expect(result.no_mutation_performed).toBe(true);
  });
});
