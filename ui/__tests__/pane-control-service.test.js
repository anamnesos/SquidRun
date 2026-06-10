const { executePaneControlAction, detectPaneModel, normalizeAction } = require('../modules/main/pane-control-service');

describe('pane-control-service', () => {
  let ctx;

  beforeEach(() => {
    ctx = {
      daemonClient: {
        connected: true,
        write: jest.fn(),
      },
      mainWindow: {
        isDestroyed: jest.fn(() => false),
        webContents: {
          send: jest.fn(),
        },
      },
      currentSettings: {
        paneCommands: {
          '1': 'claude --dangerously-skip-permissions',
          '2': 'codex --yolo',
          '3': 'gemini',
        },
      },
      recoveryManager: {
        markExpectedExit: jest.fn(),
      },
      agentRunning: new Map([
        ['1', 'running'],
        ['2', 'running'],
        ['3', 'running'],
      ]),
    };
  });

  test('normalizeAction resolves supported aliases', () => {
    expect(normalizeAction('enter-pane')).toBe('enter');
    expect(normalizeAction('interrupt-pane')).toBe('interrupt');
    expect(normalizeAction('restart-pane')).toBe('restart');
    expect(normalizeAction('nudge-agent')).toBe('nudge');
  });

  test('detectPaneModel infers model from paneCommands', () => {
    expect(detectPaneModel('1', ctx.currentSettings)).toBe('claude');
    expect(detectPaneModel('2', ctx.currentSettings)).toBe('codex');
    expect(detectPaneModel('3', ctx.currentSettings)).toBe('gemini');
    expect(detectPaneModel('9', ctx.currentSettings)).toBe('claude');
  });

  test('enter uses sendTrustedEnter path for Claude panes', () => {
    const result = executePaneControlAction(ctx, 'enter', { paneId: '1' });

    expect(result.success).toBe(true);
    expect(result.method).toBe('sendTrustedEnter');
    expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('pane-enter', {
      paneId: '1',
      model: 'claude',
      method: 'sendTrustedEnter',
    });
    expect(ctx.daemonClient.write).not.toHaveBeenCalled();
  });

  test('enter uses raw PTY for Codex and Gemini', () => {
    const codex = executePaneControlAction(ctx, 'enter', { paneId: '2' });
    const gemini = executePaneControlAction(ctx, 'enter', { paneId: '3' });

    expect(codex.success).toBe(true);
    expect(codex.method).toBe('pty');
    expect(codex.model).toBe('codex');
    expect(ctx.daemonClient.write).toHaveBeenCalledWith('2', '\r');
    expect(gemini.success).toBe(true);
    expect(gemini.method).toBe('pty');
    expect(ctx.daemonClient.write).toHaveBeenCalledWith('3', '\r');
  });

  test('enter returns daemon_write_failed when daemon rejects write', () => {
    ctx.daemonClient.write.mockReturnValue(false);
    const result = executePaneControlAction(ctx, 'enter', { paneId: '2' });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      reason: 'daemon_write_failed',
      paneId: '2',
      action: 'enter',
    }));
  });

  test('interrupt sends SIGINT via daemon write', () => {
    const result = executePaneControlAction(ctx, 'interrupt', { paneId: '2' });
    expect(result).toEqual(expect.objectContaining({ success: true, method: 'sigint', paneId: '2' }));
    expect(ctx.daemonClient.write).toHaveBeenCalledWith('2', '\x03');
  });

  test('interrupt returns daemon_write_failed when daemon rejects write', () => {
    ctx.daemonClient.write.mockReturnValue(false);
    const result = executePaneControlAction(ctx, 'interrupt', { paneId: '2' });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      reason: 'daemon_write_failed',
      paneId: '2',
      action: 'interrupt',
    }));
  });

  test('restart marks expected exit and sends restart-pane event', () => {
    const result = executePaneControlAction(ctx, 'restart', { paneId: '1' });
    expect(result).toEqual(expect.objectContaining({ success: true, method: 'restart-pane', paneId: '1' }));
    expect(ctx.recoveryManager.markExpectedExit).toHaveBeenCalledWith('1', 'manual-restart');
    expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('restart-pane', { paneId: '1' });
  });

  test('nudge without message routes to nudge-pane event', () => {
    const result = executePaneControlAction(ctx, 'nudge', { paneId: '1' });
    expect(result).toEqual(expect.objectContaining({ success: true, method: 'nudge-pane', paneId: '1' }));
    expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('nudge-pane', { paneId: '1' });
  });

  test('nudge with message routes to nudge-agent inject-message path', () => {
    const result = executePaneControlAction(ctx, 'nudge', { paneId: '2', message: 'Check status' });
    expect(result).toEqual(expect.objectContaining({ success: true, method: 'nudge-agent', paneId: '2' }));
    expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('inject-message', {
      panes: ['2'],
      message: 'Check status\r',
    });
  });

  test('nudge with message fails when agent is not running', () => {
    ctx.agentRunning.set('2', 'stopped');
    const result = executePaneControlAction(ctx, 'nudge', { paneId: '2', message: 'Check status' });
    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'agent_not_running', paneId: '2' }));
  });

  test('normalizeAction resolves switch-model aliases', () => {
    expect(normalizeAction('switch-model')).toBe('switch-model');
    expect(normalizeAction('switch-pane-model')).toBe('switch-model');
    expect(normalizeAction('model-switch')).toBe('switch-model');
  });

  test('switch-model requires a model', () => {
    ctx.switchPaneModel = jest.fn();
    const result = executePaneControlAction(ctx, 'switch-model', { paneId: '2' });
    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'missing_model', paneId: '2' }));
    expect(ctx.switchPaneModel).not.toHaveBeenCalled();
  });

  test('switch-model fails when the shared flow is not wired', () => {
    const result = executePaneControlAction(ctx, 'switch-model', { paneId: '2', model: 'claude' });
    expect(result).toEqual(expect.objectContaining({
      success: false,
      reason: 'model_switch_unavailable',
      paneId: '2',
    }));
  });

  test('switch-model delegates to the shared flow and maps success', async () => {
    ctx.switchPaneModel = jest.fn().mockResolvedValue({ success: true, paneId: '2', model: 'claude' });
    const result = await executePaneControlAction(ctx, 'switch-model', { paneId: '2', model: 'Claude' });

    expect(ctx.switchPaneModel).toHaveBeenCalledWith('2', 'claude');
    expect(result).toEqual(expect.objectContaining({
      success: true,
      paneId: '2',
      action: 'switch-model',
      method: 'switch-pane-model',
      model: 'claude',
    }));
  });

  test('switch-model propagates a lease-blocked rejection with its reason', async () => {
    ctx.switchPaneModel = jest.fn().mockResolvedValue({
      success: false,
      reason: 'model_switch_blocked_restart_in_progress',
      activeClaimId: 'lease-1',
    });
    const result = await executePaneControlAction(ctx, 'switch-model', { paneId: '2', model: 'claude' });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      reason: 'model_switch_blocked_restart_in_progress',
      activeClaimId: 'lease-1',
      paneId: '2',
    }));
  });
});
