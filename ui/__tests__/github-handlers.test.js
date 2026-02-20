const mockCreateGitHubService = jest.fn();

jest.mock('../modules/main/github-service', () => ({
  createGitHubService: (...args) => mockCreateGitHubService(...args),
}));

const {
  GITHUB_CHANNEL_ACTIONS,
  executeGitHubOperation,
  registerGitHubHandlers,
  unregisterGitHubHandlers,
} = require('../modules/ipc/github-handlers');

describe('github IPC handlers', () => {
  let service;
  let ipcMain;
  let ctx;

  beforeEach(() => {
    service = {
      createPR: jest.fn(async (payload) => ({ number: 1, title: payload.title || null })),
      buildPRBody: jest.fn(async () => 'generated-body'),
      updatePR: jest.fn(async (number) => ({ number: Number(number), state: 'OPEN' })),
      getPR: jest.fn(async (number) => ({ number: Number(number), state: 'OPEN' })),
      listPRs: jest.fn(async () => []),
      mergePR: jest.fn(async (number) => ({ merged: true, number: Number(number) })),
      createIssue: jest.fn(async (payload) => ({ number: 10, title: payload.title || null })),
      getIssue: jest.fn(async (number) => ({ number: Number(number), state: 'OPEN' })),
      listIssues: jest.fn(async () => []),
      closeIssue: jest.fn(async (number) => ({ number: Number(number), state: 'CLOSED' })),
      addIssueComment: jest.fn(async () => ({ id: 'c1' })),
      getChecks: jest.fn(async () => [{ name: 'build', status: 'completed' }]),
      getWorkflowRuns: jest.fn(async () => [{ id: 123 }]),
      getRepo: jest.fn(async () => ({ owner: 'acme', repo: 'squidrun' })),
      getAuthStatus: jest.fn(async () => ({ authenticated: true })),
    };
    mockCreateGitHubService.mockReset();
    mockCreateGitHubService.mockReturnValue(service);

    ipcMain = {
      handle: jest.fn(),
      removeHandler: jest.fn(),
    };
    ctx = {
      ipcMain,
      WORKSPACE_PATH: '/repo/path',
    };
  });

  test('registers all github IPC channels', () => {
    registerGitHubHandlers(ctx);
    expect(ipcMain.handle).toHaveBeenCalledTimes(GITHUB_CHANNEL_ACTIONS.size);
    for (const [channel] of GITHUB_CHANNEL_ACTIONS.entries()) {
      expect(ipcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function));
    }
  });

  test('create-pr channel routes to service.createPR', async () => {
    registerGitHubHandlers(ctx);
    const createHandler = ipcMain.handle.mock.calls.find(([channel]) => channel === 'github:create-pr')[1];

    const result = await createHandler({}, { title: 'Test PR' });

    expect(result).toEqual({
      ok: true,
      action: 'createPR',
      pr: { number: 1, title: 'Test PR' },
    });
    expect(service.createPR).toHaveBeenCalledWith({ title: 'Test PR' });
  });

  test('build-pr-body channel routes to service.buildPRBody', async () => {
    registerGitHubHandlers(ctx);
    const buildHandler = ipcMain.handle.mock.calls.find(([channel]) => channel === 'github:build-pr-body')[1];

    const result = await buildHandler({}, { title: 'Auto PR', sessionNumber: 88 });

    expect(result).toEqual({
      ok: true,
      action: 'buildPRBody',
      body: 'generated-body',
    });
    expect(service.buildPRBody).toHaveBeenCalledWith({ title: 'Auto PR', sessionNumber: 88 });
  });

  test('get-pr returns missing_pr_number when id is absent', async () => {
    const result = await executeGitHubOperation('getPR', {}, { githubService: service });
    expect(result).toEqual({
      ok: false,
      action: 'getPR',
      reason: 'missing_pr_number',
    });
  });

  test('issue-comment returns missing_comment_body when body is absent', async () => {
    const result = await executeGitHubOperation('addIssueComment', { number: '12' }, { githubService: service });
    expect(result).toEqual({
      ok: false,
      action: 'addIssueComment',
      reason: 'missing_comment_body',
    });
  });

  test('status action returns auth and repo snapshot', async () => {
    const result = await executeGitHubOperation('status', {}, { githubService: service });

    expect(result).toEqual({
      ok: true,
      action: 'status',
      auth: { authenticated: true },
      repo: { owner: 'acme', repo: 'squidrun' },
      repoError: null,
    });
  });

  test('unknown action returns unknown_action', async () => {
    const result = await executeGitHubOperation('unknown', {}, { githubService: service });
    expect(result).toEqual({
      ok: false,
      reason: 'unknown_action',
      action: 'unknown',
    });
  });

  test('unregister removes all github channels', () => {
    unregisterGitHubHandlers(ctx);
    for (const [channel] of GITHUB_CHANNEL_ACTIONS.entries()) {
      expect(ipcMain.removeHandler).toHaveBeenCalledWith(channel);
    }
  });
});
