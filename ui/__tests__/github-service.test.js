jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));
jest.mock('../modules/transition-ledger', () => ({
  getStats: jest.fn(() => ({
    active: 0,
    settledVerified: 0,
    failed: 0,
    timedOut: 0,
  })),
}));

const { execFile } = require('child_process');
const transitionLedger = require('../modules/transition-ledger');
const { createGitHubService } = require('../modules/main/github-service');

function resolveExec(stdout = '', stderr = '') {
  execFile.mockImplementationOnce((command, args, options, callback) => {
    callback(null, stdout, stderr);
  });
}

function rejectExec(error) {
  execFile.mockImplementationOnce((command, args, options, callback) => {
    callback(error, error.stdout || '', error.stderr || '');
  });
}

describe('github-service (Phase 1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    transitionLedger.getStats.mockReturnValue({
      active: 0,
      settledVerified: 0,
      failed: 0,
      timedOut: 0,
    });
  });

  test('getAuthStatus returns authenticated true with viewer details', async () => {
    const service = createGitHubService({ cwd: '/repo/path' });

    resolveExec('Logged in to github.com');
    resolveExec(JSON.stringify({
      login: 'octocat',
      name: 'The Octocat',
      html_url: 'https://github.com/octocat',
    }));

    const result = await service.getAuthStatus();

    expect(result).toEqual({
      authenticated: true,
      reason: 'ok',
      hostname: 'github.com',
      login: 'octocat',
      url: 'https://github.com/octocat',
      name: 'The Octocat',
    });

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['auth', 'status', '--hostname', 'github.com'],
      expect.objectContaining({ cwd: '/repo/path' }),
      expect.any(Function)
    );
  });

  test('getAuthStatus returns not_authenticated when gh auth is missing', async () => {
    const service = createGitHubService();
    const err = new Error('not authenticated');
    err.code = 1;
    err.stderr = 'Run gh auth login to authenticate';
    rejectExec(err);

    const result = await service.getAuthStatus();

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe('not_authenticated');
  });

  test('getAuthStatus returns gh_not_installed when command is unavailable', async () => {
    const service = createGitHubService();
    const err = new Error('spawn gh ENOENT');
    err.code = 'ENOENT';
    rejectExec(err);

    const result = await service.getAuthStatus();

    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe('gh_not_installed');
  });

  test('getRepo returns normalized repository metadata', async () => {
    const service = createGitHubService();

    resolveExec(JSON.stringify({
      name: 'hivemind',
      nameWithOwner: 'acme/hivemind',
      owner: { login: 'acme' },
      defaultBranchRef: { name: 'main' },
      url: 'https://github.com/acme/hivemind',
    }));

    const repo = await service.getRepo();

    expect(repo).toEqual({
      owner: 'acme',
      repo: 'hivemind',
      full_name: 'acme/hivemind',
      default_branch: 'main',
      url: 'https://github.com/acme/hivemind',
    });
  });

  test('getRepo throws normalized error metadata', async () => {
    const service = createGitHubService();
    const err = new Error('not a git repository');
    err.code = 1;
    err.stderr = 'not a git repository';
    rejectExec(err);

    await expect(service.getRepo()).rejects.toMatchObject({
      name: 'GitHubServiceError',
      reason: 'not_a_repository',
      context: 'get-repo',
    });
  });

  test('listPRs returns normalized pull requests', async () => {
    const service = createGitHubService();
    resolveExec(JSON.stringify([
      {
        number: 42,
        title: 'Add github integration',
        body: 'Body',
        state: 'OPEN',
        isDraft: false,
        url: 'https://github.com/acme/hivemind/pull/42',
        headRefName: 'feature/github',
        baseRefName: 'main',
        mergeable: 'MERGEABLE',
        author: { login: 'devops' },
      },
    ]));

    const prs = await service.listPRs({ state: 'open', head: 'feature/github', base: 'main', limit: 10 });

    expect(prs).toEqual([
      expect.objectContaining({
        number: 42,
        title: 'Add github integration',
        url: 'https://github.com/acme/hivemind/pull/42',
        head: 'feature/github',
        base: 'main',
        author: 'devops',
      }),
    ]);
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'list', '--state', 'open', '--head', 'feature/github', '--base', 'main', '--limit', '10']),
      expect.any(Object),
      expect.any(Function)
    );
  });

  test('getPR returns normalized PR details', async () => {
    const service = createGitHubService();
    resolveExec(JSON.stringify({
      number: 99,
      title: 'Improve ws routing',
      body: 'test body',
      state: 'OPEN',
      isDraft: true,
      url: 'https://github.com/acme/hivemind/pull/99',
      headRefName: 'feature/ws',
      baseRefName: 'main',
      mergeStateStatus: 'UNKNOWN',
      statusCheckRollup: [
        { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/build' },
      ],
      author: { login: 'architect' },
    }));

    const pr = await service.getPR(99);
    expect(pr).toEqual(expect.objectContaining({
      number: 99,
      draft: true,
      author: 'architect',
      checks: [
        expect.objectContaining({ name: 'build', conclusion: 'SUCCESS' }),
      ],
    }));
  });

  test('createPR returns fetched PR when gh supports --json', async () => {
    const service = createGitHubService();

    resolveExec(JSON.stringify({ number: 7, url: 'https://github.com/acme/hivemind/pull/7' }));
    resolveExec(JSON.stringify({
      number: 7,
      title: 'Add PR service',
      body: 'phase2',
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/acme/hivemind/pull/7',
      headRefName: 'feature/pr-service',
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      author: { login: 'devops' },
    }));

    const pr = await service.createPR({
      title: 'Add PR service',
      body: 'phase2',
      base: 'main',
      head: 'feature/pr-service',
      draft: true,
    });

    expect(pr).toEqual(expect.objectContaining({
      number: 7,
      title: 'Add PR service',
      draft: false,
    }));
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'gh',
      expect.arrayContaining(['pr', 'create', '--title', 'Add PR service', '--body', 'phase2', '--base', 'main', '--head', 'feature/pr-service', '--draft', '--json', 'number,url']),
      expect.any(Object),
      expect.any(Function)
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'gh',
      expect.arrayContaining(['pr', 'view', '7', '--json']),
      expect.any(Object),
      expect.any(Function)
    );
  });

  test('buildPRBody includes session context, commit summary, tests, and transition stats', async () => {
    const service = createGitHubService();
    transitionLedger.getStats.mockReturnValue({
      active: 2,
      settledVerified: 4,
      failed: 1,
      timedOut: 2,
    });

    resolveExec('origin/main\n');
    resolveExec('abc123\x1ffeat: wiring complete\x1fAll green: 146 suites, 2748 tests\x1edef456\x1ffix: edge case\x1f\x1e');

    const body = await service.buildPRBody({
      title: 'Wire phase 6',
      description: 'Integrate transition-ledger data into PR body generation.',
      sessionNumber: 91,
      issueNumbers: [12, 34],
    });

    expect(body).toContain('## Summary');
    expect(body).toContain('Integrate transition-ledger data into PR body generation.');
    expect(body).toContain('## Session 91 Changes');
    expect(body).toContain('- 2 commits');
    expect(body).toContain('- 146 suites, 2748 tests passing');
    expect(body).toContain('## Transition Ledger');
    expect(body).toContain('- 2 active transitions');
    expect(body).toContain('- 4 verified this session');
    expect(body).toContain('- 3 failed/timed out');
    expect(body).toContain('## Linked Issues');
    expect(body).toContain('- Closes #12');
    expect(body).toContain('- Closes #34');
    expect(body).toContain('🤖 Generated by Hivemind Architect');
  });

  test('buildPRBody falls back when transition ledger stats are unavailable', async () => {
    const service = createGitHubService();
    transitionLedger.getStats.mockImplementation(() => {
      throw new Error('transition ledger unavailable');
    });

    const upstreamErr = new Error('no upstream');
    upstreamErr.code = 1;
    rejectExec(upstreamErr);
    resolveExec('abc123\x1fchore: cleanup\x1f\x1e');

    const body = await service.buildPRBody({
      title: 'Fallback body',
      description: 'Fallback path should still produce a body',
    });

    expect(body).toContain('## Session Current Changes');
    expect(body).toContain('- 1 commits');
    expect(body).toContain('## Transition Ledger');
    expect(body).toContain('- unavailable in this runtime context');
  });

  test('createPR auto-generates body when body is not provided', async () => {
    const service = createGitHubService();
    transitionLedger.getStats.mockReturnValue({
      active: 1,
      settledVerified: 2,
      failed: 0,
      timedOut: 1,
    });

    resolveExec('origin/main\n');
    resolveExec('abc123\x1ffeat: auto body\x1f146 suites, 2748 tests\x1e');
    resolveExec(JSON.stringify({ number: 23, url: 'https://github.com/acme/hivemind/pull/23' }));
    resolveExec(JSON.stringify({
      number: 23,
      title: 'Auto body PR',
      body: 'generated',
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/acme/hivemind/pull/23',
      headRefName: 'feature/auto-body',
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      author: { login: 'devops' },
    }));

    await service.createPR({
      title: 'Auto body PR',
      description: 'Create PR with generated body',
      sessionNumber: 99,
      issueNumbers: [88],
      base: 'main',
      head: 'feature/auto-body',
    });

    const createArgs = execFile.mock.calls[2][1];
    const bodyFlagIndex = createArgs.indexOf('--body');
    expect(bodyFlagIndex).toBeGreaterThan(-1);
    expect(createArgs[bodyFlagIndex + 1]).toContain('## Session 99 Changes');
    expect(createArgs[bodyFlagIndex + 1]).toContain('- Closes #88');
  });

  test('createPR uses explicit body as-is and skips auto generation', async () => {
    const service = createGitHubService();

    resolveExec(JSON.stringify({ number: 24, url: 'https://github.com/acme/hivemind/pull/24' }));
    resolveExec(JSON.stringify({
      number: 24,
      title: 'Manual body PR',
      body: 'manual-body',
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/acme/hivemind/pull/24',
      headRefName: 'feature/manual',
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      author: { login: 'devops' },
    }));

    await service.createPR({
      title: 'Manual body PR',
      body: 'manual-body',
      base: 'main',
      head: 'feature/manual',
    });

    expect(execFile.mock.calls[0][0]).toBe('gh');
    const createArgs = execFile.mock.calls[0][1];
    expect(createArgs).toEqual(expect.arrayContaining(['--body', 'manual-body']));
    expect(execFile.mock.calls.some((call) => call[0] === 'git')).toBe(false);
  });

  test('updatePR edits metadata and closes PR when requested', async () => {
    const service = createGitHubService();

    resolveExec('edited');
    resolveExec('closed');
    resolveExec(JSON.stringify({
      number: 15,
      title: 'Updated title',
      body: 'Updated body',
      state: 'CLOSED',
      isDraft: false,
      url: 'https://github.com/acme/hivemind/pull/15',
      headRefName: 'feature/old',
      baseRefName: 'main',
      author: { login: 'devops' },
    }));

    const result = await service.updatePR(15, {
      title: 'Updated title',
      body: 'Updated body',
      state: 'closed',
    });

    expect(result).toEqual(expect.objectContaining({
      number: 15,
      state: 'CLOSED',
      title: 'Updated title',
    }));
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['pr', 'edit', '15', '--title', 'Updated title', '--body', 'Updated body'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['pr', 'close', '15'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  test('mergePR runs gh merge with selected strategy', async () => {
    const service = createGitHubService();
    resolveExec('Merged pull request #21');

    const result = await service.mergePR(21, { method: 'squash' });

    expect(result).toEqual({
      merged: true,
      number: 21,
      method: 'squash',
      message: 'Merged pull request #21',
    });
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      ['pr', 'merge', '21', '--squash', '--delete-branch'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  test('mergePR rejects unsupported merge method', async () => {
    const service = createGitHubService();

    await expect(service.mergePR(5, { method: 'invalid' })).rejects.toMatchObject({
      reason: 'invalid_input',
      context: 'pr-merge',
    });
  });

  test('listIssues returns normalized issues', async () => {
    const service = createGitHubService();
    resolveExec(JSON.stringify([
      {
        number: 12,
        title: 'Bug in pane routing',
        body: 'Details',
        state: 'OPEN',
        url: 'https://github.com/acme/hivemind/issues/12',
        labels: [{ name: 'bug' }, { name: 'high-priority' }],
        assignees: [{ login: 'devops' }],
        author: { login: 'architect' },
      },
    ]));

    const issues = await service.listIssues({ state: 'open', labels: 'bug,high-priority', limit: 20 });

    expect(issues).toEqual([
      {
        number: 12,
        title: 'Bug in pane routing',
        body: 'Details',
        state: 'OPEN',
        url: 'https://github.com/acme/hivemind/issues/12',
        html_url: 'https://github.com/acme/hivemind/issues/12',
        author: 'architect',
        labels: ['bug', 'high-priority'],
        assignees: ['devops'],
      },
    ]);
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['issue', 'list', '--state', 'open', '--label', 'bug', '--label', 'high-priority', '--limit', '20']),
      expect.any(Object),
      expect.any(Function)
    );
  });

  test('getIssue returns normalized issue details', async () => {
    const service = createGitHubService();
    resolveExec(JSON.stringify({
      number: 33,
      title: 'Improve docs',
      body: 'Body',
      state: 'OPEN',
      url: 'https://github.com/acme/hivemind/issues/33',
      labels: [{ name: 'docs' }],
      assignees: [{ login: 'analyst' }],
      author: { login: 'architect' },
    }));

    const issue = await service.getIssue(33);
    expect(issue).toEqual(expect.objectContaining({
      number: 33,
      title: 'Improve docs',
      labels: ['docs'],
      assignees: ['analyst'],
      author: 'architect',
    }));
  });

  test('createIssue creates and returns issue details', async () => {
    const service = createGitHubService();
    resolveExec(JSON.stringify({ number: 88, url: 'https://github.com/acme/hivemind/issues/88' }));
    resolveExec(JSON.stringify({
      number: 88,
      title: 'New issue',
      body: 'Need fix',
      state: 'OPEN',
      url: 'https://github.com/acme/hivemind/issues/88',
      labels: [{ name: 'bug' }],
      assignees: [{ login: 'devops' }],
      author: { login: 'architect' },
    }));

    const issue = await service.createIssue({
      title: 'New issue',
      body: 'Need fix',
      labels: ['bug'],
      assignees: ['devops'],
    });

    expect(issue).toEqual(expect.objectContaining({
      number: 88,
      title: 'New issue',
      labels: ['bug'],
      assignees: ['devops'],
    }));
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'gh',
      expect.arrayContaining(['issue', 'create', '--title', 'New issue', '--body', 'Need fix', '--label', 'bug', '--assignee', 'devops', '--json', 'number,url']),
      expect.any(Object),
      expect.any(Function)
    );
  });

  test('closeIssue closes and fetches latest issue state', async () => {
    const service = createGitHubService();
    resolveExec('closed');
    resolveExec(JSON.stringify({
      number: 10,
      title: 'Stale issue',
      body: '',
      state: 'CLOSED',
      url: 'https://github.com/acme/hivemind/issues/10',
      labels: [],
      assignees: [],
      author: { login: 'devops' },
    }));

    const issue = await service.closeIssue(10);

    expect(issue).toEqual(expect.objectContaining({
      number: 10,
      state: 'CLOSED',
    }));
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['issue', 'close', '10'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  test('addIssueComment returns comment metadata', async () => {
    const service = createGitHubService();
    resolveExec(JSON.stringify({
      id: 'c_123',
      url: 'https://github.com/acme/hivemind/issues/12#issuecomment-123',
    }));

    const comment = await service.addIssueComment(12, 'Acknowledged');

    expect(comment).toEqual({
      id: 'c_123',
      url: 'https://github.com/acme/hivemind/issues/12#issuecomment-123',
    });
  });

  test('addIssueComment validates body', async () => {
    const service = createGitHubService();

    await expect(service.addIssueComment(12, '   ')).rejects.toMatchObject({
      reason: 'invalid_input',
      context: 'issue-comment',
    });
  });

  test('getChecks returns normalized check runs for ref', async () => {
    const service = createGitHubService();

    resolveExec(JSON.stringify({
      name: 'hivemind',
      nameWithOwner: 'acme/hivemind',
      owner: { login: 'acme' },
      defaultBranchRef: { name: 'main' },
      url: 'https://github.com/acme/hivemind',
    }));
    resolveExec(JSON.stringify({
      check_runs: [
        {
          name: 'test',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/acme/hivemind/actions/runs/1',
        },
      ],
    }));

    const checks = await service.getChecks({ ref: 'HEAD' });
    expect(checks).toEqual([
      {
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/acme/hivemind/actions/runs/1',
      },
    ]);
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['api', 'repos/acme/hivemind/commits/HEAD/check-runs'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  test('getWorkflowRuns returns normalized run list', async () => {
    const service = createGitHubService();
    resolveExec(JSON.stringify([
      {
        databaseId: 777,
        name: 'CI',
        workflowName: 'build-and-test',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/acme/hivemind/actions/runs/777',
        headBranch: 'main',
        headSha: 'abc123',
        event: 'push',
        createdAt: '2026-02-14T12:00:00Z',
        updatedAt: '2026-02-14T12:05:00Z',
      },
    ]));

    const runs = await service.getWorkflowRuns({ branch: 'main', status: 'completed', limit: 5 });

    expect(runs).toEqual([
      {
        id: 777,
        name: 'CI',
        workflow: 'build-and-test',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/acme/hivemind/actions/runs/777',
        branch: 'main',
        sha: 'abc123',
        event: 'push',
        created_at: '2026-02-14T12:00:00Z',
        updated_at: '2026-02-14T12:05:00Z',
      },
    ]);
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'run',
        'list',
        '--branch',
        'main',
        '--status',
        'completed',
        '--limit',
        '5',
      ]),
      expect.any(Object),
      expect.any(Function)
    );
  });
});
