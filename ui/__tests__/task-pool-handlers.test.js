const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../modules/team-memory', () => ({
  executeTeamMemoryOperation: jest.fn(async () => ({ ok: true, claims: [] })),
  appendPatternHookEvent: jest.fn(async () => ({ ok: true, queued: true })),
}));

describe('task-pool handlers team-memory hooks', () => {
  let workspacePath;
  let handlers;
  let ipcMain;
  let mainWindow;
  let registerTaskPoolHandlers;
  let teamMemory;

  beforeEach(() => {
    jest.resetModules();
    handlers = new Map();
    ipcMain = {
      handle: jest.fn((channel, handler) => {
        handlers.set(channel, handler);
      }),
      removeHandler: jest.fn(),
    };
    mainWindow = {
      isDestroyed: jest.fn(() => false),
      webContents: {
        send: jest.fn(),
      },
    };
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-task-pool-'));
    fs.mkdirSync(path.join(workspacePath, 'triggers'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'task-pool.json'), JSON.stringify({
      tasks: [
        {
          id: 'T-1',
          subject: 'Fix trigger routing',
          description: 'Investigate delivery path',
          metadata: { domain: 'backend' },
          blockedBy: [],
          status: 'open',
          owner: null,
        },
      ],
      lastUpdated: new Date().toISOString(),
    }, null, 2));

    teamMemory = require('../modules/team-memory');
    ({ registerTaskPoolHandlers } = require('../modules/ipc/task-pool-handlers'));
  });

  afterEach(() => {
    try {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  test('claim-task injects read-before-work context and emits task pattern event', async () => {
    teamMemory.executeTeamMemoryOperation.mockImplementation(async (action) => {
      if (action === 'query-claims') {
        return {
          ok: true,
          claims: [
            {
              id: 'clm_1',
              status: 'confirmed',
              claimType: 'fact',
              owner: 'builder',
              confidence: 0.9,
              updatedAt: Date.now(),
              statement: 'Prior trigger routing fix used delivery verification ACKs.',
            },
          ],
        };
      }
      return { ok: true };
    });

    registerTaskPoolHandlers({
      ipcMain,
      mainWindow,
      WORKSPACE_PATH: workspacePath,
      watcher: null,
    });

    const claimHandler = handlers.get('claim-task');
    const result = await claimHandler({}, { paneId: '2', taskId: 'T-1', domain: 'backend' });

    expect(result.success).toBe(true);
    expect(result.memoryContext).toEqual(expect.objectContaining({ claimsUsed: 1 }));
    expect(teamMemory.executeTeamMemoryOperation).toHaveBeenCalledWith(
      'query-claims',
      expect.any(Object)
    );
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'inject-message',
      expect.objectContaining({
        panes: ['2'],
        message: expect.stringContaining('[TEAM MEMORY]'),
      })
    );
    expect(teamMemory.appendPatternHookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task.status_changed',
        status: 'in_progress',
      })
    );
  });

  test('update-task-status writes close claim and task status pattern event', async () => {
    registerTaskPoolHandlers({
      ipcMain,
      mainWindow,
      WORKSPACE_PATH: workspacePath,
      watcher: null,
    });

    const updateHandler = handlers.get('update-task-status');
    const result = await updateHandler({}, 'T-1', 'failed', {
      session: 's_123',
      error: { message: 'Terminal submit timed out' },
    });

    expect(result.success).toBe(true);
    expect(teamMemory.executeTeamMemoryOperation).toHaveBeenCalledWith(
      'create-claim',
      expect.objectContaining({
        claimType: 'negative',
        idempotencyKey: expect.stringContaining('task-close:T-1:failed'),
      })
    );
    expect(teamMemory.appendPatternHookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task.status_changed',
        status: 'failed',
      })
    );
  });
});
