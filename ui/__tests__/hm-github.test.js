const hmGithub = require('../scripts/hm-github');

describe('hm-github CLI helpers', () => {
  test('buildRequest maps status command', () => {
    expect(hmGithub.buildRequest(['status'], new Map())).toEqual({
      action: 'status',
      payload: {},
    });
  });

  test('buildRequest maps checks command with default ref', () => {
    expect(hmGithub.buildRequest(['checks'], new Map())).toEqual({
      action: 'getChecks',
      payload: { ref: 'HEAD' },
    });
  });

  test('buildRequest maps runs filters', () => {
    const options = new Map([
      ['branch', 'main'],
      ['status', 'completed'],
      ['limit', '10'],
    ]);

    expect(hmGithub.buildRequest(['runs'], options)).toEqual({
      action: 'getWorkflowRuns',
      payload: {
        branch: 'main',
        status: 'completed',
        limit: 10,
      },
    });
  });

  test('buildRequest maps pr create', () => {
    const options = new Map([
      ['title', 'Add feature'],
      ['body', 'details'],
      ['base', 'main'],
      ['head', 'feature/add'],
      ['draft', true],
    ]);

    expect(hmGithub.buildRequest(['pr', 'create'], options)).toEqual({
      action: 'createPR',
      payload: {
        title: 'Add feature',
        body: 'details',
        base: 'main',
        head: 'feature/add',
        draft: true,
      },
    });
  });

  test('buildRequest maps pr merge', () => {
    expect(hmGithub.buildRequest(['pr', 'merge', '42'], new Map([['method', 'squash']]))).toEqual({
      action: 'mergePR',
      payload: {
        number: '42',
        method: 'squash',
      },
    });
  });

  test('buildRequest maps issue comment body from positional text', () => {
    expect(hmGithub.buildRequest(['issue', 'comment', '12', 'Ship', 'it'], new Map())).toEqual({
      action: 'addIssueComment',
      payload: {
        number: '12',
        body: 'Ship it',
      },
    });
  });

  test('buildRequest throws when required args are missing', () => {
    expect(() => hmGithub.buildRequest(['pr', 'get'], new Map())).toThrow('pr get requires <number>');
    expect(() => hmGithub.buildRequest(['issue', 'create'], new Map())).toThrow('issue create requires --title');
  });
});
