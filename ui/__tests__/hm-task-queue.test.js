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

  it('fails closed on malformed existing queue JSON instead of returning empty state', () => {
    const queuePath = queue.getQueuePath();
    fs.writeFileSync(queuePath, '{"agents": { "builder": ');

    expect(() => queue.readQueue()).toThrow(/agent_task_queue_json_parse_error/);

    const broken = queue.readQueue(queuePath, { onBroken: 'return' });
    expect(broken).toEqual(expect.objectContaining({
      ok: false,
      status: 'broken',
      queuePath,
      brokenState: expect.objectContaining({
        code: 'BROKEN_JSON_STATE',
        reason: 'agent_task_queue_json_parse_error',
        filePath: queuePath,
      }),
    }));
  });

  it('blocks queue mutation when the current queue JSON is malformed', () => {
    const queuePath = queue.getQueuePath();
    fs.writeFileSync(queuePath, '{"agents": { "builder": ');

    expect(() => queue.enqueueTask({
      agent: 'builder',
      message: 'Must not erase broken queue',
    })).toThrow(/agent_task_queue_json_parse_error/);
    expect(fs.readFileSync(queuePath, 'utf8')).toBe('{"agents": { "builder": ');
  });

  it('preserves a malformed queue file before an explicit direct rewrite', () => {
    const queuePath = queue.getQueuePath();
    fs.writeFileSync(queuePath, '{"agents": { "builder": ');

    const saved = queue.writeQueue({
      version: 2,
      agents: {
        builder: {
          pending: [
            { taskId: 'replacement-task', message: 'Replacement task' },
          ],
        },
      },
    });

    expect(saved.preservedBrokenState).toEqual(expect.objectContaining({
      store: 'agent_task_queue',
      sourcePath: queuePath,
      reason: 'agent_task_queue_json_parse_error',
      backupPath: expect.stringContaining('agent-task-queue.json.broken-'),
    }));
    expect(fs.readFileSync(saved.preservedBrokenState.backupPath, 'utf8')).toBe('{"agents": { "builder": ');
    expect(queue.readQueue().state.agents.builder.pending[0]).toEqual(expect.objectContaining({
      taskId: 'replacement-task',
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

  it('collects due post-wake candidates and holds approval-required work', () => {
    const now = Date.parse('2026-05-04T12:00:00Z');
    queue.writeQueue({
      version: 2,
      agents: {
        architect: {
          pending: [
            {
              taskId: 'architect-approval',
              owner: 'architect',
              state: 'queued',
              riskClass: 'approval_required',
              message: 'Send customer invoice update',
              wakeTrigger: 'post-wake',
              restartPersistence: true,
            },
          ],
        },
        builder: {
          pending: [
            {
              taskId: 'builder-due',
              owner: 'builder',
              state: 'queued',
              riskClass: 'safe',
              title: 'Wake hook tests',
              message: 'Run restartless unit tests',
              nextStep: 'Run focused tests',
              wakeTrigger: 'post-wake',
              continueAfter: '2026-05-04T11:59:00Z',
              restartPersistence: true,
            },
            {
              taskId: 'builder-future',
              owner: 'builder',
              state: 'queued',
              riskClass: 'safe',
              message: 'Future task',
              wakeTrigger: 'post-wake',
              continueAfter: '2026-05-04T13:00:00Z',
              restartPersistence: true,
            },
            {
              taskId: 'builder-nonpersistent',
              owner: 'builder',
              state: 'queued',
              riskClass: 'caution',
              message: 'Do not resume',
              wakeTrigger: 'post-wake',
              restartPersistence: false,
            },
          ],
          active: null,
          history: [],
        },
        oracle: {
          pending: [
            {
              taskId: 'oracle-due',
              owner: 'oracle',
              state: 'blocked',
              riskClass: 'caution',
              message: 'Investigate restart boundary',
              blockedReason: 'Waiting for restart',
              wakeTrigger: 'restart',
              restartPersistence: true,
            },
            {
              taskId: 'oracle-manual',
              owner: 'oracle',
              state: 'waiting',
              riskClass: 'safe',
              message: 'Manual-only task',
              wakeTrigger: 'manual',
              restartPersistence: true,
            },
          ],
          active: null,
          history: [],
        },
      },
    });

    const result = queue.collectWakeCandidates({
      wakeTrigger: 'post-wake',
      nowMs: now,
    });

    expect(result.candidates.map((candidate) => candidate.taskId)).toEqual([
      'builder-due',
      'oracle-due',
    ]);
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      agent: 'builder',
      riskClass: 'safe',
      dispatchReady: true,
      nextStep: 'Run focused tests',
    }));
    expect(result.candidates[0].prompt).toContain('[OWNED-WORK CONTINUE]');
    expect(result.candidates[0].prompt).toContain('Resume only the bounded safe/caution next step');
    expect(result.held).toEqual([
      expect.objectContaining({
        agent: 'architect',
        taskId: 'architect-approval',
        riskClass: 'approval_required',
        dispatchReady: false,
        holdReason: 'approval_required',
        blockedReason: queue.DEFAULT_APPROVAL_HOLD_REASON,
      }),
    ]);
  });

  it('dispatches due safe/caution work and persists approval-required holds', async () => {
    const now = Date.parse('2026-05-04T12:00:00Z');
    queue.writeQueue({
      version: 2,
      agents: {
        architect: {
          pending: [
            {
              taskId: 'architect-approval',
              owner: 'architect',
              state: 'queued',
              riskClass: 'approval_required',
              message: 'Customer-facing approval item',
              wakeTrigger: 'post-wake',
              restartPersistence: true,
            },
          ],
          active: null,
          history: [],
        },
        builder: {
          pending: [
            {
              taskId: 'builder-due',
              owner: 'builder',
              state: 'queued',
              riskClass: 'safe',
              title: 'Wake hook tests',
              message: 'Run restartless unit tests',
              nextStep: 'Run focused tests',
              wakeTrigger: 'post-wake',
              restartPersistence: true,
            },
          ],
          active: null,
          history: [],
        },
        oracle: {
          pending: [
            {
              taskId: 'oracle-due',
              owner: 'oracle',
              state: 'blocked',
              riskClass: 'caution',
              message: 'Investigate restart boundary',
              blockedReason: 'Waiting for restart',
              wakeTrigger: 'post-wake',
              restartPersistence: true,
            },
          ],
          active: null,
          history: [],
        },
      },
    });
    const dispatcher = jest.fn(async (candidate) => ({
      ok: true,
      emittedPrompt: candidate.prompt,
    }));

    const result = await queue.dispatchWakeCandidates({
      wakeTrigger: 'post-wake',
      nowMs: now,
      dispatcher,
    });

    expect(dispatcher).toHaveBeenCalledTimes(2);
    expect(dispatcher.mock.calls[0][0]).toEqual(expect.objectContaining({
      agent: 'builder',
      taskId: 'builder-due',
      prompt: expect.stringContaining('Risk: safe'),
    }));
    expect(result.dispatched.map((candidate) => candidate.taskId)).toEqual([
      'builder-due',
      'oracle-due',
    ]);
    expect(result.held).toEqual([
      expect.objectContaining({
        taskId: 'architect-approval',
        holdReason: 'approval_required',
      }),
    ]);

    const saved = queue.readQueue().state;
    expect(saved.agents.builder.active).toEqual(expect.objectContaining({
      taskId: 'builder-due',
      state: 'active',
      blockedReason: null,
      lastDispatchAtMs: now,
    }));
    expect(saved.agents.oracle.active).toEqual(expect.objectContaining({
      taskId: 'oracle-due',
      state: 'active',
      blockedReason: null,
    }));
    expect(saved.agents.architect.pending[0]).toEqual(expect.objectContaining({
      taskId: 'architect-approval',
      state: 'blocked',
      blockedReason: queue.DEFAULT_APPROVAL_HOLD_REASON,
      riskClass: 'approval_required',
    }));
  });

  it('runs wake dry-run and dispatch through the CLI entrypoint', async () => {
    const now = Date.parse('2026-05-04T12:00:00Z');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      queue.writeQueue({
        version: 2,
        agents: {
          builder: {
            pending: [
              {
                taskId: 'builder-cli-wake',
                owner: 'builder',
                state: 'waiting',
                riskClass: 'caution',
                message: 'Patch restartless wake hook',
                nextStep: 'Run CLI dispatch test',
                wakeTrigger: 'post-wake',
                restartPersistence: true,
              },
            ],
            active: null,
            history: [],
          },
        },
      });

      expect(queue.main([
        'wake',
        '--trigger', 'post-wake',
        '--now', String(now),
      ])).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('candidates=1 held=0 dispatched=0 skipped=0'));

      const dispatchExit = await queue.main([
        'wake',
        '--dispatch',
        '--trigger', 'post-wake',
        '--now', String(now),
      ]);

      expect(dispatchExit).toBe(0);
      const saved = queue.readQueue().state;
      expect(saved.agents.builder.active).toEqual(expect.objectContaining({
        taskId: 'builder-cli-wake',
        state: 'active',
        nextStep: 'Run CLI dispatch test',
        lastDispatchAtMs: now,
      }));
      expect(logSpy).toHaveBeenLastCalledWith(expect.stringContaining('"dispatched"'));
    } finally {
      logSpy.mockRestore();
    }
  });
});
