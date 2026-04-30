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
        title: 'Fix X',
        message: 'Full task description',
        source: 'architect',
        priority: 'high',
      }),
    }));

    const saved = JSON.parse(fs.readFileSync(queue.getQueuePath(), 'utf8'));
    expect(saved.agents.builder.pending).toHaveLength(1);
    expect(saved.agents.builder.pending[0]).toEqual(expect.objectContaining({
      title: 'Fix X',
      message: 'Full task description',
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
            status: 'running',
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
        status: 'running',
      }),
    }));
    expect(queue.formatListResult(result)).toContain('builder: pending=0 active=builder-active-1:running');
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
            status: 'running',
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
        status: 'completed',
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
});
