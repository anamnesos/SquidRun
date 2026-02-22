const {
  BackgroundAgentManager,
  containsCompletionSignal,
  appendCompletionDirective,
} = require('../modules/main/background-agent-manager');

describe('background-agent-manager completion lifecycle', () => {
  test('containsCompletionSignal only matches standalone completion lines', () => {
    expect(containsCompletionSignal('__HM_BG_DONE__')).toBe(true);
    expect(containsCompletionSignal('[BG_TASK_COMPLETE].')).toBe(true);
    expect(containsCompletionSignal('When complete, print __HM_BG_DONE__.')).toBe(false);
    expect(containsCompletionSignal('prefix [BG_TASK_COMPLETE] suffix')).toBe(false);
  });

  test('appendCompletionDirective appends sentinel instruction once', () => {
    const appended = appendCompletionDirective('Implement task A');
    expect(appended).toContain('__HM_BG_DONE__');
    expect(appended).toContain('on its own line');

    const existing = appendCompletionDirective('Implement task B\n__HM_BG_DONE__');
    const sentinelCount = (existing.match(/__HM_BG_DONE__/g) || []).length;
    expect(sentinelCount).toBe(1);
  });

  test('spawn startup contract does not include completion sentinel token', async () => {
    jest.useFakeTimers();
    const daemonClient = {
      connected: true,
      spawn: jest.fn(),
      write: jest.fn(),
      kill: jest.fn(),
    };

    const manager = new BackgroundAgentManager({
      getDaemonClient: () => daemonClient,
      getSettings: () => ({
        paneCommands: { '2': 'codex --yolo' },
      }),
      getSessionScopeId: () => 'app-session-1',
      resolveBuilderCwd: () => '/repo',
    });

    const result = await manager.spawnAgent({ ownerPaneId: '2', alias: 'builder-bg-1' });
    expect(result.ok).toBe(true);

    jest.advanceTimersByTime(7000);

    const writes = daemonClient.write.mock.calls.map((call) => String(call[1] || ''));
    expect(writes.length).toBeGreaterThanOrEqual(3);
    const startupContracts = writes.filter((payload) => payload.includes('headless Background Builder Agent'));
    expect(startupContracts.length).toBeGreaterThanOrEqual(2);
    for (const payload of writes) {
      expect(payload).not.toContain('__HM_BG_DONE__');
      expect(payload).not.toContain('[BG_TASK_COMPLETE]');
    }
    for (const contract of startupContracts) {
      expect(contract).toContain('Background-agent override');
      expect(contract).toContain('hm-send.js builder');
      expect(contract).not.toMatch(/hm-send\.js\s+architect/i);
      expect(contract).toContain('Never send startup or status check-ins to Architect');
    }

    jest.useRealTimers();
  });

  test('sendMessageToAgent appends completion directive and completion signal triggers kill', async () => {
    const daemonClient = {
      connected: true,
      spawn: jest.fn(),
      write: jest.fn(),
      kill: jest.fn(),
    };

    const manager = new BackgroundAgentManager({
      getDaemonClient: () => daemonClient,
      getSettings: () => ({}),
      getSessionScopeId: () => null,
      resolveBuilderCwd: () => '/repo',
    });

    manager.agents.set('bg-2-1', {
      alias: 'builder-bg-1',
      paneId: 'bg-2-1',
      ownerPaneId: '2',
      status: 'running',
      createdAtMs: Date.now(),
      lastActivityAtMs: Date.now(),
    });

    const sendResult = await manager.sendMessageToAgent('builder-bg-1', 'Take ownership of test task', {
      fromRole: 'builder',
    });
    expect(sendResult.ok).toBe(true);
    expect(daemonClient.write).toHaveBeenCalled();
    const sentPayload = String(daemonClient.write.mock.calls[0][1] || '');
    expect(sentPayload).toContain('__HM_BG_DONE__');

    const killSpy = jest.spyOn(manager, 'killAgent').mockResolvedValue({ ok: true });

    manager.handleDaemonData('bg-2-1', 'When done, print __HM_BG_DONE__.');
    expect(killSpy).not.toHaveBeenCalled();

    manager.handleDaemonData('bg-2-1', '__HM_BG_DONE__\n');
    expect(killSpy).toHaveBeenCalledWith('bg-2-1', { reason: 'task_completed' });
  });
});
