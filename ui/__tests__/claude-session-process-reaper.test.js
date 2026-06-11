const {
  reapClaudeSessionProcesses,
  reapClaudeSessionForCommand,
} = require('../modules/claude-session-process-reaper');

describe('claude-session-process-reaper', () => {
  test('kills only processes carrying the exact pinned Claude session id', async () => {
    const killed = [];
    const sessionId = '11111111-1111-4111-8111-111111111111';

    const result = await reapClaudeSessionProcesses(sessionId, {
      findProcesses: () => [
        {
          pid: 1234,
          name: 'powershell.exe',
          commandLine: `powershell -Command claude --session-id ${sessionId}`,
        },
        {
          pid: process.pid,
          name: 'node.exe',
          commandLine: `node test --session-id ${sessionId}`,
        },
      ],
      killProcessTree: async (pid) => {
        killed.push(pid);
        return { pid, signal: 'test-kill-tree' };
      },
    });

    expect(result.ok).toBe(true);
    expect(killed).toEqual([1234]);
    expect(result.killed).toEqual([
      expect.objectContaining({ pid: 1234, signal: 'test-kill-tree' }),
    ]);
  });

  test('skips commands without a Claude pin', async () => {
    const result = await reapClaudeSessionForCommand('codex --yolo', {
      findProcesses: jest.fn(() => {
        throw new Error('should not scan');
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      skipped: true,
      reason: 'command_not_pinned',
    }));
  });
});
