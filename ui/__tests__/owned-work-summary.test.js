const fs = require('fs');
const os = require('os');
const path = require('path');

describe('owned-work-summary', () => {
  let tempRoot;
  let queuePath;
  let queue;
  let summary;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-work-summary-'));
    queuePath = path.join(tempRoot, 'runtime-eunbyeol', 'agent-task-queue.json');
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      getActiveProfile: () => 'eunbyeol',
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        String(relPath || '')
          .replace(/^[/\\]+/, '')
          .replace(/[/\\]+/g, path.sep),
      ),
    }));
    queue = require('../scripts/hm-task-queue');
    summary = require('../modules/owned-work-summary');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('../config');
  });

  test('returns concise whatImCarrying summary per agent and profile', () => {
    const nowMs = Date.parse('2026-05-04T10:00:00Z');
    queue.writeQueue({
      version: 2,
      updatedAt: '2026-05-04T09:59:00.000Z',
      agents: {
        builder: {
          pending: [
            {
              taskId: 'builder-blocked-1',
              owner: 'builder',
              state: 'blocked',
              riskClass: 'approval_required',
              message: 'Send customer invoice email',
              blockedReason: 'Needs James approval',
              wakeTrigger: 'user approval',
              continueAfter: '2026-05-05T00:00:00.000Z',
              restartPersistence: true,
              lastAdvancedAt: nowMs - 2000,
            },
          ],
          active: {
            taskId: 'builder-active-1',
            owner: 'builder',
            state: 'active',
            riskClass: 'caution',
            title: 'Routing patch',
            message: 'Debug infra routing patch',
            nextStep: 'Run focused tests',
            source: 'architect',
            wakeTrigger: 'post-wake',
            handoffSummary: 'Patch is in validation',
            lastAdvancedAt: nowMs - 120000,
          },
          history: [
            { taskId: 'builder-done-1', message: 'Done', state: 'done' },
          ],
        },
        oracle: {
          pending: [
            {
              taskId: 'oracle-stale-1',
              owner: 'oracle',
              state: 'queued',
              riskClass: 'safe',
              message: 'Read docs',
              lastAdvancedAt: nowMs - 7200000,
            },
          ],
          active: null,
          history: [],
        },
      },
    }, queuePath);

    const result = summary.buildOwnedWorkSummary({
      queuePath,
      profileName: 'eunbyeol',
      nowMs,
      staleAfterMs: 60000,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      profileName: 'eunbyeol',
      queuePath,
      updatedAt: expect.any(String),
      staleAfterMs: 60000,
      generatedAtMs: nowMs,
    }));
    expect(result.whatImCarrying.agents.builder.active).toEqual(expect.objectContaining({
      taskId: 'builder-active-1',
      title: 'Routing patch',
      state: 'active',
      riskClass: 'caution',
      nextStep: 'Run focused tests',
      blockedReason: null,
      wakeTrigger: 'post-wake',
      continueAfter: null,
      restartPersistence: true,
      source: 'architect',
      stale: true,
      handoffSummary: 'Patch is in validation',
    }));
    expect(result.whatImCarrying.agents.builder).toEqual(expect.objectContaining({
      pendingCount: 1,
      historyCount: 1,
      carriedCount: 2,
      staleCount: 1,
      blockedCount: 1,
      approvalRequiredCount: 1,
    }));
    expect(result.whatImCarrying.agents.oracle).toEqual(expect.objectContaining({
      active: null,
      pendingCount: 1,
      carriedCount: 1,
      staleCount: 1,
      blockedCount: 0,
      approvalRequiredCount: 0,
    }));
    expect(result.whatImCarrying.totals).toEqual(expect.objectContaining({
      activeCount: 1,
      carriedCount: 3,
      staleCount: 2,
      blockedCount: 1,
      approvalRequiredCount: 1,
    }));
  });

  test('registers read-only IPC handler for owned-work summary', async () => {
    queue.enqueueTask({
      agent: 'builder',
      message: 'Debug infra routing patch with tests',
    }, { queuePath });

    const handlers = new Map();
    const ipcMain = {
      handle: jest.fn((channel, handler) => handlers.set(channel, handler)),
      removeHandler: jest.fn((channel) => handlers.delete(channel)),
    };
    const { registerOwnedWorkHandlers } = require('../modules/ipc/owned-work-handlers');

    registerOwnedWorkHandlers({ ipcMain });
    expect(ipcMain.handle).toHaveBeenCalledWith('get-owned-work-summary', expect.any(Function));

    const result = await handlers.get('get-owned-work-summary')({}, {
      queuePath,
      profileName: 'eunbyeol',
      staleAfterMs: 60000,
    });

    expect(result.whatImCarrying.agents.builder).toEqual(expect.objectContaining({
      pendingCount: 1,
      carriedCount: 1,
      approvalRequiredCount: 0,
    }));

    registerOwnedWorkHandlers.unregister({ ipcMain });
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('get-owned-work-summary');
    expect(handlers.has('get-owned-work-summary')).toBe(false);
  });

  test('exposes owned-work IPC through handler registry and channel policy', () => {
    const { registerOwnedWorkHandlers } = require('../modules/ipc/owned-work-handlers');
    const { DEFAULT_HANDLERS } = require('../modules/ipc/handler-registry');
    const { isAllowedInvokeChannel } = require('../modules/bridge/channel-policy');

    expect(DEFAULT_HANDLERS).toContain(registerOwnedWorkHandlers);
    expect(isAllowedInvokeChannel('get-owned-work-summary')).toBe(true);
  });
});
