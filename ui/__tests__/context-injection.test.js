jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../modules/ipc/evidence-ledger-handlers', () => ({
  executeEvidenceLedgerOperation: jest.fn(),
}));

jest.mock('../modules/team-memory', () => ({
  executeTeamMemoryOperation: jest.fn(),
}));

const ContextInjectionManager = require('../modules/main/context-injection');
const { executeEvidenceLedgerOperation } = require('../modules/ipc/evidence-ledger-handlers');
const teamMemory = require('../modules/team-memory');

describe('context-injection runtime memory reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('buildContext composes docs + in-process ledger/team-memory snapshot', async () => {
    executeEvidenceLedgerOperation.mockResolvedValueOnce({
      session: 129,
      completed: ['Patched hm-claim query regression'],
      not_yet_done: ['Ship runtime write bridge'],
    });
    teamMemory.executeTeamMemoryOperation.mockResolvedValueOnce({
      ok: true,
      claims: [
        {
          status: 'confirmed',
          claimType: 'fact',
          statement: 'Use app-process canonical write path for memory events',
        },
      ],
    });

    const manager = new ContextInjectionManager({});
    jest.spyOn(manager, 'readFileIfExists').mockImplementation((filePath) => {
      if (filePath.endsWith('base-instructions.md')) return '# Base Instructions';
      if (filePath.endsWith('ROLES.md')) return '# ROLES';
      if (filePath.endsWith('codex-notes.md')) return '# Codex Notes';
      return '';
    });

    const context = await manager.buildContext('2', 'codex');

    expect(context).toContain('# Base Instructions');
    expect(context).toContain('# ROLES');
    expect(context).toContain('# Codex Notes');
    expect(context).toContain('## Runtime Memory Snapshot');
    expect(context).toContain('### Evidence Ledger');
    expect(context).toContain('### Team Memory');
    expect(context).toContain('Use app-process canonical write path');

    expect(executeEvidenceLedgerOperation).toHaveBeenCalledWith(
      'get-context',
      { preferSnapshot: true },
      expect.objectContaining({
        source: expect.objectContaining({
          via: 'context-injection',
          role: 'devops',
          paneId: '2',
        }),
      })
    );
    expect(teamMemory.executeTeamMemoryOperation).toHaveBeenCalledWith(
      'query-claims',
      expect.objectContaining({
        owner: 'devops',
        sessionsBack: 6,
      }),
      expect.objectContaining({
        source: expect.objectContaining({
          via: 'context-injection',
          role: 'devops',
          paneId: '2',
        }),
      })
    );
  });

  test('injectContext sends context payload to renderer', async () => {
    jest.useFakeTimers({ legacyFakeTimers: false });
    executeEvidenceLedgerOperation.mockResolvedValueOnce({
      session: 129,
      completed: ['Runtime check'],
      not_yet_done: [],
    });
    teamMemory.executeTeamMemoryOperation.mockResolvedValueOnce({
      ok: true,
      claims: [],
    });

    const send = jest.fn();
    const manager = new ContextInjectionManager({
      mainWindow: {
        isDestroyed: () => false,
        webContents: { send },
      },
    });
    jest.spyOn(manager, 'readFileIfExists').mockImplementation((filePath) => {
      if (filePath.endsWith('base-instructions.md')) return '# Base';
      if (filePath.endsWith('ROLES.md')) return '# Roles';
      return '';
    });

    await manager.injectContext('1', 'claude', 0);
    await jest.runAllTimersAsync();

    expect(send).toHaveBeenCalledWith(
      'inject-message',
      expect.objectContaining({
        panes: ['1'],
        message: expect.stringContaining('HIVEMIND CONTEXT INJECTION'),
      })
    );

  });
});
