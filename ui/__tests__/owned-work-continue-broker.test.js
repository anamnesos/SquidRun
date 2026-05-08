const fs = require('fs');
const os = require('os');
const path = require('path');

describe('owned-work-continue-broker', () => {
  let tempRoot;
  let queuePath;
  let queue;
  let broker;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-work-continue-'));
    queuePath = path.join(tempRoot, 'runtime', 'agent-task-queue.json');
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
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

  test('returns one safe/caution next-action card from due owned work', () => {
    const nowMs = Date.parse('2026-05-04T12:00:00Z');
    queue.writeQueue({
      agents: {
        builder: {
          pending: [
            {
              taskId: 'builder-safe-1',
              owner: 'builder',
              state: 'queued',
              riskClass: 'safe',
              title: 'Docs pass',
              message: 'Update docs and tests',
              nextStep: 'Write the missing workflow note.',
              wakeTrigger: 'post-wake',
              lastAdvancedAt: nowMs - 1000,
            },
          ],
          active: null,
          history: [],
        },
      },
    }, queuePath);

    const result = broker.buildOwnedWorkContinueCard({
      queuePath,
      nowMs,
      wakeTrigger: 'post-wake',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      hasNextAction: true,
      queuePath,
    }));
    expect(result.nextAction).toEqual(expect.objectContaining({
      action: 'continue_owned_work',
      agent: 'builder',
      taskId: 'builder-safe-1',
      riskClass: 'safe',
      nextStep: 'Write the missing workflow note.',
      resumeCommand: 'node ui/scripts/hm-task-queue.js wake --dispatch --agent builder --trigger post-wake',
    }));
    expect(result.nextAction.prompt).toContain('[OWNED-WORK CONTINUE]');
  });

  test('does not offer approval-required work as the next action', () => {
    const nowMs = Date.parse('2026-05-04T12:00:00Z');
    queue.writeQueue({
      agents: {
        builder: {
          pending: [
            {
              taskId: 'builder-invoice-1',
              owner: 'builder',
              state: 'queued',
              riskClass: 'approval_required',
              message: 'Send customer invoice email',
              wakeTrigger: 'post-wake',
              lastAdvancedAt: nowMs - 1000,
            },
          ],
          active: null,
          history: [],
        },
      },
    }, queuePath);

    const result = broker.buildOwnedWorkContinueCard({
      queuePath,
      nowMs,
      wakeTrigger: 'post-wake',
    });

    expect(result.hasNextAction).toBe(false);
    expect(result.reason).toBe('no_dispatch_ready_owned_work');
    expect(result.counts.approvalRequired).toBe(1);
    expect(result.held[0]).toEqual(expect.objectContaining({
      riskClass: 'approval_required',
      dispatchReady: false,
    }));
  });
});
