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

  test('spawnAgent cleans up state when daemon spawn is rejected', async () => {
    const daemonClient = {
      connected: true,
      spawn: jest.fn().mockReturnValue(false),
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

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('spawn_rejected');
    expect(String(result.error || '')).toContain('Daemon rejected spawn request');
    expect(result.alias).toBe('builder-bg-1');
    expect(result.paneId).toBe('bg-2-1');
    expect(manager.listAgents()).toHaveLength(0);
    expect(manager.getAgentState('builder-bg-1')).toBeNull();
    expect(daemonClient.write).not.toHaveBeenCalled();
  });

  test('spawnAgent cleans up state when startup command write is rejected', async () => {
    jest.useFakeTimers();
    const daemonClient = {
      connected: true,
      spawn: jest.fn(),
      write: jest.fn().mockReturnValueOnce(false),
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

    jest.advanceTimersByTime(200);

    expect(daemonClient.write).toHaveBeenCalledTimes(1);
    expect(daemonClient.kill).toHaveBeenCalledWith('bg-2-1');
    expect(manager.listAgents()).toHaveLength(0);
    expect(manager.getAgentState('builder-bg-1')).toBeNull();
    jest.useRealTimers();
  });

  test('spawnAgent cleans up state when startup contract write is rejected', async () => {
    jest.useFakeTimers();
    const daemonClient = {
      connected: true,
      spawn: jest.fn(),
      write: jest
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false),
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

    expect(daemonClient.write).toHaveBeenCalledTimes(2);
    expect(daemonClient.kill).toHaveBeenCalledWith('bg-2-1');
    expect(manager.listAgents()).toHaveLength(0);
    expect(manager.getAgentState('builder-bg-1')).toBeNull();
    jest.useRealTimers();
  });

  test('sendMessageToAgent appends completion directive and completion signal triggers kill', async () => {
    const daemonClient = {
      connected: true,
      spawn: jest.fn(),
      write: jest.fn().mockReturnValue(true),
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
    expect(sendResult.success).toBe(true);
    expect(sendResult.accepted).toBe(true);
    expect(sendResult.queued).toBe(true);
    expect(sendResult.verified).toBe(true);
    expect(sendResult.status).toBe('delivered.daemon_write');
    expect(daemonClient.write).toHaveBeenCalled();
    const sentPayload = String(daemonClient.write.mock.calls[0][1] || '');
    expect(sentPayload).toContain('__HM_BG_DONE__');

    const killSpy = jest.spyOn(manager, 'killAgent').mockResolvedValue({ ok: true });

    manager.handleDaemonData('bg-2-1', 'When done, print __HM_BG_DONE__.');
    expect(killSpy).not.toHaveBeenCalled();

    manager.handleDaemonData('bg-2-1', '__HM_BG_DONE__\n');
    expect(killSpy).toHaveBeenCalledWith('bg-2-1', { reason: 'task_completed' });
  });

  test('sendMessageToAgent returns failure when daemon write is rejected', async () => {
    const daemonClient = {
      connected: true,
      spawn: jest.fn(),
      write: jest.fn().mockReturnValue(false),
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

    expect(daemonClient.write).toHaveBeenCalled();
    expect(sendResult).toMatchObject({
      success: false,
      ok: false,
      accepted: false,
      queued: false,
      verified: false,
      status: 'daemon_write_failed',
      paneId: 'bg-2-1',
      alias: 'builder-bg-1',
    });
  });

  test('runWatchdogTick queues idle kills after scanning agents', () => {
    const events = [];
    const daemonClient = {
      connected: true,
      getTerminals: jest.fn(() => [
        { paneId: 'bg-2-1', alive: true },
        { paneId: 'bg-2-2', alive: true },
      ]),
      getLastActivity: jest.fn((paneId) => {
        events.push(`activity:${paneId}`);
        return 0;
      }),
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
    manager.idleTtlMs = 1;

    const nowMs = Date.now();
    manager.agents.set('bg-2-1', {
      alias: 'builder-bg-1',
      paneId: 'bg-2-1',
      ownerPaneId: '2',
      status: 'running',
      createdAtMs: nowMs - 10_000,
      lastActivityAtMs: nowMs - 10_000,
    });
    manager.agents.set('bg-2-2', {
      alias: 'builder-bg-2',
      paneId: 'bg-2-2',
      ownerPaneId: '2',
      status: 'running',
      createdAtMs: nowMs - 10_000,
      lastActivityAtMs: nowMs - 10_000,
    });

    jest.spyOn(manager, 'killAgent').mockImplementation(async (paneId) => {
      events.push(`kill:${paneId}`);
      return { ok: true };
    });

    manager.runWatchdogTick(nowMs);

    expect(events.slice(0, 2)).toEqual(['activity:bg-2-1', 'activity:bg-2-2']);
    expect(events).toEqual(expect.arrayContaining(['kill:bg-2-1', 'kill:bg-2-2']));
    expect(events.findIndex((entry) => entry.startsWith('kill:'))).toBeGreaterThan(1);
  });
});
