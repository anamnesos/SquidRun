const fs = require('fs');
const os = require('os');
const path = require('path');

describe('hm-task-queue', () => {
  let tempRoot;
  let queue;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-task-queue-'));
    fs.mkdirSync(path.join(tempRoot, 'runtime'), { recursive: true });
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      WORKSPACE_PATH: tempRoot,
      PROJECT_ROOT: tempRoot,
      resolveCoordRoot: () => tempRoot,
      getProjectRoot: () => tempRoot,
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        String(relPath || '')
          .replace(/^[/\\]+/, '')
          .replace(/[/\\]+/g, path.sep),
      ),
    }));
    queue = require('../scripts/hm-task-queue');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('../config');
  });

  it('enqueues a task into the selected agent queue', () => {
    const result = queue.enqueueTask({
      agent: 'builder',
      title: 'Fix X',
      message: 'Full task description',
      source: 'architect',
      priority: 'high',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      pendingCount: 1,
      task: expect.objectContaining({
        owner: 'builder',
        state: 'queued',
        status: 'queued',
        riskClass: 'caution',
        nextStep: null,
        blockedReason: null,
        wakeTrigger: null,
        continueAfter: null,
        restartPersistence: true,
        lastAdvancedAt: expect.any(Number),
        handoffSummary: null,
        title: 'Fix X',
        message: 'Full task description',
        source: 'architect',
        priority: 'high',
      }),
    }));

    const saved = JSON.parse(fs.readFileSync(queue.getQueuePath(), 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.agents.builder.pending).toHaveLength(1);
    expect(saved.agents.builder.pending[0]).toEqual(expect.objectContaining({
      owner: 'builder',
      state: 'queued',
      title: 'Fix X',
      message: 'Full task description',
    }));
  });

  it('normalizes legacy v1 tasks into owned-work v2 fields', () => {
    queue.writeQueue({
      version: 1,
      agents: {
        builder: {
          pending: [
            {
              id: 'legacy-pending-1',
              message: 'Run focused tests for routing',
              status: 'pending',
            },
          ],
          active: {
            taskId: 'legacy-active-1',
            message: 'Debug watcher loop',
            status: 'running',
          },
          history: [
            {
              taskId: 'legacy-history-1',
              message: 'Docs update',
              status: 'completed',
            },
          ],
        },
      },
    });

    const { state } = queue.readQueue();

    expect(state.version).toBe(2);
    expect(state.agents.builder.pending[0]).toEqual(expect.objectContaining({
      taskId: 'legacy-pending-1',
      owner: 'builder',
      state: 'queued',
      riskClass: 'safe',
      restartPersistence: true,
      lastAdvancedAt: expect.any(Number),
    }));
    expect(state.agents.builder.active).toEqual(expect.objectContaining({
      taskId: 'legacy-active-1',
      state: 'active',
      riskClass: 'caution',
    }));
    expect(state.agents.builder.history[0]).toEqual(expect.objectContaining({
      taskId: 'legacy-history-1',
      state: 'done',
      riskClass: 'safe',
    }));
  });

  it('lists pending and active tasks per agent', () => {
    queue.enqueueTask({
      agent: 'builder',
      message: 'Queued task',
    });
    queue.writeQueue({
      version: 1,
      agents: {
        builder: {
          pending: [],
          active: {
            taskId: 'builder-active-1',
            message: 'Active task',
            state: 'active',
            nextStep: 'Ship the patch',
          },
          history: [],
        },
      },
    });

    const result = queue.listQueue();

    expect(result.summary.builder).toEqual(expect.objectContaining({
      pending: 0,
      active: expect.objectContaining({
        taskId: 'builder-active-1',
        state: 'active',
        nextStep: 'Ship the patch',
      }),
    }));
    expect(queue.formatListResult(result)).toContain('builder: pending=0 active=builder-active-1:active');
    expect(queue.formatListResult(result)).toContain('carrying=builder-active-1 risk=caution next=Ship the patch blocked=none');
  });

  it('activates, blocks, unblocks, and continues owned work', () => {
    const enqueued = queue.enqueueTask({
      agent: 'builder',
      title: 'Restartless routing',
      message: 'Patch infra routing with tests',
      nextStep: 'Open the runtime module',
    });

    const activated = queue.activateTask({
      agent: 'builder',
      taskId: enqueued.task.taskId,
      nextStep: 'Patch the handler route',
    });
    expect(activated).toEqual(expect.objectContaining({
      ok: true,
      task: expect.objectContaining({
        state: 'active',
        nextStep: 'Patch the handler route',
      }),
    }));

    const blocked = queue.blockTask({
      agent: 'builder',
      reason: 'Need static route evidence',
      wakeTrigger: 'evidence ready',
      continueAfter: '2026-05-04T10:00:00Z',
      handoffSummary: 'Waiting on proof, not user permission',
    });
    expect(blocked.task).toEqual(expect.objectContaining({
      state: 'blocked',
      blockedReason: 'Need static route evidence',
      wakeTrigger: 'evidence ready',
      continueAfter: '2026-05-04T10:00:00.000Z',
      handoffSummary: 'Waiting on proof, not user permission',
    }));

    const unblocked = queue.unblockTask({
      agent: 'builder',
      nextStep: 'Run the focused test',
    });
    expect(unblocked.task).toEqual(expect.objectContaining({
      state: 'active',
      blockedReason: null,
      nextStep: 'Run the focused test',
    }));

    queue.blockTask({ agent: 'builder', reason: 'Retry later' });
    const continued = queue.continueTask({
      agent: 'builder',
      nextStep: 'Continue from saved state',
    });
    expect(continued.task).toEqual(expect.objectContaining({
      state: 'active',
      blockedReason: null,
      nextStep: 'Continue from saved state',
    }));
  });

  it('moves an active task into history on complete', () => {
    queue.writeQueue({
      version: 1,
      agents: {
        builder: {
          pending: [],
          active: {
            taskId: 'builder-active-1',
            message: 'Active task',
            state: 'active',
          },
          history: [],
        },
      },
    });

    const result = queue.completeActiveTask({
      agent: 'builder',
      reason: 'manual_test',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      task: expect.objectContaining({
        taskId: 'builder-active-1',
        completionReason: 'manual_test',
        state: 'done',
        status: 'done',
      }),
    }));

    const saved = JSON.parse(fs.readFileSync(queue.getQueuePath(), 'utf8'));
    expect(saved.agents.builder.active).toBeNull();
    expect(saved.agents.builder.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'builder-active-1',
        completionReason: 'manual_test',
      }),
    ]));
  });

  it('moves a failed active task into history with failed state', () => {
    queue.writeQueue({
      version: 2,
      agents: {
        builder: {
          pending: [],
          active: {
            taskId: 'builder-active-2',
            message: 'Active task',
            state: 'active',
          },
          history: [],
        },
      },
    });

    const result = queue.failActiveTask({
      agent: 'builder',
      reason: 'test_failure',
      handoffSummary: 'Failed with evidence',
    });

    expect(result.task).toEqual(expect.objectContaining({
      taskId: 'builder-active-2',
      state: 'failed',
      completionReason: 'test_failure',
      handoffSummary: 'Failed with evidence',
    }));
    const saved = JSON.parse(fs.readFileSync(queue.getQueuePath(), 'utf8'));
    expect(saved.agents.builder.history).toEqual([
      expect.objectContaining({ taskId: 'builder-active-2', state: 'failed' }),
    ]);
  });

  it('defaults risk fail-closed for money/trading/auth/customer and safe/caution for reversible work', () => {
    const customer = queue.enqueueTask({
      agent: 'builder',
      message: 'Send customer invoice payment email',
    });
    const trading = queue.enqueueTask({
      agent: 'oracle',
      message: 'Review crypto trading position token auth',
    });
    const docs = queue.enqueueTask({
      agent: 'architect',
      message: 'Documentation and tests for restartless service boundary',
    });
    const infra = queue.enqueueTask({
      agent: 'builder',
      message: 'Debug infra routing patch with unit tests',
    });

    expect(customer.task.riskClass).toBe('approval_required');
    expect(trading.task.riskClass).toBe('approval_required');
    expect(docs.task.riskClass).toBe('safe');
    expect(infra.task.riskClass).toBe('safe');

    queue.activateTask({ agent: 'builder', taskId: customer.task.taskId });
    queue.blockTask({ agent: 'builder', reason: 'Needs user approval' });
    const continued = queue.continueTask({ agent: 'builder' });
    expect(continued).toEqual(expect.objectContaining({
      ok: false,
      reason: 'approval_required',
    }));
  });

  it('clears pending and active tasks for one agent without dropping history', () => {
    queue.writeQueue({
      version: 1,
      agents: {
        builder: {
          pending: [
            { taskId: 'builder-pending-1', message: 'Pending task' },
          ],
          active: {
            taskId: 'builder-active-1',
            message: 'Active task',
            status: 'running',
          },
          history: [
            { taskId: 'builder-history-1', message: 'History task', status: 'completed' },
          ],
        },
      },
    });

    const result = queue.clearQueue({ agent: 'builder' });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      agent: 'builder',
    }));

    const saved = JSON.parse(fs.readFileSync(queue.getQueuePath(), 'utf8'));
    expect(saved.agents.builder.pending).toEqual([]);
    expect(saved.agents.builder.active).toBeNull();
    expect(saved.agents.builder.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'builder-history-1' }),
    ]));
  });

  it('resolves profile-scoped queue paths through config', () => {
    jest.resetModules();
    jest.dontMock('../config');
    const previousProfile = process.env.SQUIDRUN_PROFILE;
    process.env.SQUIDRUN_PROFILE = 'eunbyeol';
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      resolveCoordPath: (relPath) => {
        const normalized = String(relPath || '').replace(/^[/\\]+/, '').replace(/[/\\]+/g, path.sep);
        const firstSep = normalized.indexOf(path.sep);
        const first = firstSep >= 0 ? normalized.slice(0, firstSep) : normalized;
        const rest = firstSep >= 0 ? normalized.slice(firstSep + 1) : '';
        const scopedFirst = process.env.SQUIDRUN_PROFILE === 'eunbyeol' && first === 'runtime'
          ? 'runtime-eunbyeol'
          : first;
        return path.join(tempRoot, scopedFirst, rest);
      },
    }));
    const scopedQueue = require('../scripts/hm-task-queue');

    try {
      expect(scopedQueue.getQueuePath()).toBe(path.join(tempRoot, 'runtime-eunbyeol', 'agent-task-queue.json'));
      scopedQueue.enqueueTask({ agent: 'builder', message: 'Scoped queue write' });
      expect(fs.existsSync(path.join(tempRoot, 'runtime-eunbyeol', 'agent-task-queue.json'))).toBe(true);
      expect(fs.existsSync(path.join(tempRoot, 'runtime', 'agent-task-queue.json'))).toBe(false);
    } finally {
      if (previousProfile === undefined) delete process.env.SQUIDRUN_PROFILE;
      else process.env.SQUIDRUN_PROFILE = previousProfile;
    }
  });

  it('runs owned-work transitions through the CLI main entrypoint', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      expect(queue.main([
        'enqueue',
        '--agent', 'builder',
        '--message', 'Debug infra queue with tests',
        '--title', 'Queue CLI',
        '--next-step', 'Activate it',
      ])).toBe(0);
      expect(queue.main(['list'])).toBe(0);
      expect(queue.main(['activate', '--agent', 'builder', '--next-step', 'Block it next'])).toBe(0);
      expect(queue.main(['block', '--agent', 'builder', '--reason', 'Waiting on restart window', '--wake-trigger', 'post-wake'])).toBe(0);
      expect(queue.main(['unblock', '--agent', 'builder', '--next-step', 'Continue it'])).toBe(0);
      expect(queue.main(['continue', '--agent', 'builder', '--next-step', 'Finish it'])).toBe(0);
      expect(queue.main(['complete', '--agent', 'builder', '--reason', 'done_by_cli'])).toBe(0);

      expect(queue.main(['enqueue', '--agent', 'oracle', '--message', 'Read-only docs check'])).toBe(0);
      expect(queue.main(['activate', '--agent', 'oracle'])).toBe(0);
      expect(queue.main(['fail', '--agent', 'oracle', '--reason', 'failed_by_cli'])).toBe(0);

      const saved = JSON.parse(fs.readFileSync(queue.getQueuePath(), 'utf8'));
      expect(saved.agents.builder.history).toEqual(expect.arrayContaining([
        expect.objectContaining({
          title: 'Queue CLI',
          state: 'done',
          completionReason: 'done_by_cli',
        }),
      ]));
      expect(saved.agents.oracle.history).toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: 'failed',
          completionReason: 'failed_by_cli',
        }),
      ]));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('builder: pending=1 active=none history=0'));
    } finally {
      logSpy.mockRestore();
    }
  });
});
