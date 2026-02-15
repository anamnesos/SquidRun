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

describe('_scopeRolesContent — role-scoped ROLES.md injection', () => {
  const FULL_ROLES = [
    '# ROLES.md',
    '',
    '## Purpose',
    'Canonical role definitions.',
    '',
    '## Runtime Identity',
    '- Pane 1: Architect',
    '- Pane 2: DevOps',
    '- Pane 5: Analyst',
    '',
    '## Shared Operating Baseline',
    '- Project root: D:/projects/hivemind/',
    '',
    '### Startup Baseline',
    '',
    '**Architect (pane 1):**',
    '1. Query Evidence Ledger context.',
    '2. Read app-status.json.',
    '',
    '**DevOps / Analyst (panes 2, 5):**',
    '1. Verify auto-injected context.',
    '2. Check in to Architect.',
    '',
    '## ARCHITECT',
    'Coordinate DevOps and Analyst work.',
    'Own commit sequencing.',
    '',
    '## DEVOPS',
    'Implement infrastructure/backend.',
    'Own daemon/process lifecycle.',
    '',
    '## ANALYST (ORACLE)',
    'System monitor and vision-provider.',
    'Root-cause findings.',
    '',
    '## Global Rules',
    '- Prefer simple solutions.',
    '- Validate before claiming completion.',
  ].join('\n');

  let manager;
  beforeEach(() => {
    manager = new ContextInjectionManager({});
  });

  test('pane 1 (Architect) gets only ARCHITECT role section', () => {
    const scoped = manager._scopeRolesContent(FULL_ROLES, '1');
    expect(scoped).toContain('## ARCHITECT');
    expect(scoped).toContain('Coordinate DevOps');
    expect(scoped).not.toContain('## DEVOPS');
    expect(scoped).not.toContain('## ANALYST');
    expect(scoped).toContain('## Global Rules');
    expect(scoped).toContain('## Purpose');
  });

  test('pane 2 (DevOps) gets only DEVOPS role section', () => {
    const scoped = manager._scopeRolesContent(FULL_ROLES, '2');
    expect(scoped).toContain('## DEVOPS');
    expect(scoped).toContain('Implement infrastructure');
    expect(scoped).not.toContain('## ARCHITECT');
    expect(scoped).not.toContain('## ANALYST');
    expect(scoped).toContain('## Global Rules');
  });

  test('pane 5 (Analyst) gets only ANALYST role section', () => {
    const scoped = manager._scopeRolesContent(FULL_ROLES, '5');
    expect(scoped).toContain('## ANALYST');
    expect(scoped).toContain('System monitor');
    expect(scoped).not.toContain('## ARCHITECT');
    expect(scoped).not.toContain('## DEVOPS');
    expect(scoped).toContain('## Global Rules');
  });

  test('startup baseline scoped: Architect gets own baseline, not workers', () => {
    const scoped = manager._scopeRolesContent(FULL_ROLES, '1');
    expect(scoped).toContain('**Architect (pane 1):**');
    expect(scoped).toContain('Query Evidence Ledger');
    expect(scoped).not.toContain('**DevOps / Analyst');
    expect(scoped).not.toContain('Verify auto-injected context');
  });

  test('startup baseline scoped: DevOps gets worker baseline, not Architect', () => {
    const scoped = manager._scopeRolesContent(FULL_ROLES, '2');
    expect(scoped).toContain('**DevOps / Analyst');
    expect(scoped).toContain('Verify auto-injected context');
    expect(scoped).not.toContain('**Architect (pane 1):**');
    expect(scoped).not.toContain('Query Evidence Ledger');
  });

  test('shared sections preserved for all panes', () => {
    for (const paneId of ['1', '2', '5']) {
      const scoped = manager._scopeRolesContent(FULL_ROLES, paneId);
      expect(scoped).toContain('## Purpose');
      expect(scoped).toContain('## Runtime Identity');
      expect(scoped).toContain('## Shared Operating Baseline');
      expect(scoped).toContain('## Global Rules');
    }
  });

  test('unknown pane returns full content unchanged', () => {
    const scoped = manager._scopeRolesContent(FULL_ROLES, '99');
    expect(scoped).toBe(FULL_ROLES);
  });

  test('collapses excessive blank lines', () => {
    const scoped = manager._scopeRolesContent(FULL_ROLES, '1');
    expect(scoped).not.toMatch(/\n{3,}/);
  });
});
