const fs = require('fs');
const os = require('os');
const path = require('path');

describe('owned-work-continue-broker', () => {
  let tempRoot;
  let queue;
  let broker;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-work-continue-'));
    fs.mkdirSync(path.join(tempRoot, 'runtime'), { recursive: true });
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      WORKSPACE_PATH: tempRoot,
      PROJECT_ROOT: tempRoot,
      getActiveProfile: () => 'main',
      resolveCoordRoot: () => tempRoot,
      getProjectRoot: () => tempRoot,
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        String(relPath || '').replace(/^[/\\]+/, '').replace(/[/\\]+/g, path.sep),
      ),
    }));
    queue = require('../scripts/hm-task-queue');
    broker = require('../modules/owned-work-continue-broker');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('../config');
  });

  test('returns the next safe owned-work continuation card', () => {
    const enqueued = queue.enqueueTask({
      agent: 'builder',
      title: 'Docs follow-up',
      message: 'Write docs for voice route',
      riskClass: 'safe',
      nextStep: 'Summarize voice route in docs',
      wakeTrigger: 'post-wake',
      source: 'architect',
    });

    const plan = broker.buildContinueBrokerPlan({
      nowMs: 1777887000000,
      trigger: 'post-wake',
    });

    expect(plan).toEqual(expect.objectContaining({
      ok: true,
      reason: 'continue_ready',
      profileName: 'main',
      counts: expect.objectContaining({
        ready: 1,
        held: 0,
      }),
      nextAction: expect.objectContaining({
        kind: 'owned_work_continue',
        agent: 'builder',
        taskId: enqueued.task.taskId,
        riskClass: 'safe',
        nextStep: 'Summarize voice route in docs',
        source: 'architect',
      }),
    }));
    expect(plan.nextAction.resumeCommand).toContain('hm-task-queue.js continue');
    expect(plan.nextAction.resumeCommand).toContain(enqueued.task.taskId);
  });

  test('holds approval-required work instead of selecting it', () => {
    queue.enqueueTask({
      agent: 'architect',
      title: 'Customer send',
      message: 'Send email to customer about invoice',
      nextStep: 'Send the email',
      wakeTrigger: 'post-wake',
    });

    const plan = broker.buildContinueBrokerPlan({
      nowMs: 1777887000000,
      trigger: 'post-wake',
    });

    expect(plan.nextAction).toBeNull();
    expect(plan.reason).toBe('only_held_work');
    expect(plan.held).toEqual([
      expect.objectContaining({
        agent: 'architect',
        riskClass: 'approval_required',
        holdReason: 'approval_required',
      }),
    ]);
  });

  test('reports no due continuation when wake trigger does not match', () => {
    queue.enqueueTask({
      agent: 'oracle',
      title: 'Later eval',
      message: 'Run read-only eval later',
      riskClass: 'safe',
      nextStep: 'Inspect eval harness',
      wakeTrigger: 'manual',
    });

    const plan = broker.buildContinueBrokerPlan({
      nowMs: 1777887000000,
      trigger: 'post-wake',
    });

    expect(plan).toEqual(expect.objectContaining({
      ok: true,
      reason: 'no_due_work',
      nextAction: null,
      counts: expect.objectContaining({
        ready: 0,
        held: 0,
      }),
    }));
    expect(broker.formatContinueBrokerPlan(plan)).toBe('No due owned-work continuation right now.');
  });
});
