'use strict';

const {
  captureCodexResumeOutput,
  emitTerminalExitLifecycle,
  handleClaudeResumeOutput,
  handleCodexResumeExit,
} = require('../modules/terminal-resume-retry-producer');

const LAUNCH_ID = `pl_${'a'.repeat(32)}`;
const APP_GENERATION = 'app-session-534';
const REQUEST_ID = 'pane-spawn-original';

function exactTerminal(overrides = {}) {
  return {
    paneId: '3',
    pid: 6666,
    alive: true,
    paneLaunchId: LAUNCH_ID,
    appGeneration: APP_GENERATION,
    spawnRequestId: REQUEST_ID,
    claudeCollisionRecoveryAttempted: false,
    codexResumeRecoveryAttempted: false,
    codexResumeFailureHandled: false,
    codexResumeFailureCandidate: null,
    codexResumeStartupBuffer: '',
    codexResumeStartupDeadline: Date.now() + 30_000,
    ...overrides,
  };
}

function exactIdentity(terminal) {
  return {
    pid: terminal.pid,
    alive: terminal.alive === true,
    paneLaunchId: terminal.paneLaunchId,
    appGeneration: terminal.appGeneration,
    spawnRequestId: terminal.spawnRequestId,
  };
}

function emitExit(terminal, exitCode = 1) {
  const order = [];
  const result = emitTerminalExitLifecycle({
    terminal,
    exitCode,
    identityFor: exactIdentity,
    emit: (event) => order.push(event),
    beforeExit: () => order.push({ event: 'release' }),
  });
  return { order, result };
}

describe('terminal resume retry producer', () => {
  test('Claude collision latches exact retry before kill and emits it once before the exact exit', () => {
    const terminal = exactTerminal({ paneId: '1' });
    const sideEffects = [];
    const spawnTerminal = jest.fn();
    const handled = handleClaudeResumeOutput({
      terminal,
      data: 'Error: session id 11111111-1111-4111-8111-111111111111 is already in use.',
      spawnCommandOnCreate: true,
      resumeDecision: {
        cli: 'claude',
        mode: 'resume',
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    }, {
      remintSession: () => {
        sideEffects.push('remint');
        return { sessionId: '22222222-2222-4222-8222-222222222222' };
      },
      onCollision: () => sideEffects.push(`latched:${terminal.appOwnedRetryReason}`),
      killProcess: () => {
        sideEffects.push(`kill:${terminal.appOwnedRetryReason}`);
        terminal.alive = false;
      },
      // Supplying this extra dependency proves the producer has no direct
      // respawn effect; its only output is the later retry event.
      spawnTerminal,
    });

    expect(handled).toEqual(expect.objectContaining({
      handled: true,
      reason: 'claude_session_collision',
      remintedSessionId: '22222222-2222-4222-8222-222222222222',
    }));
    expect(sideEffects).toEqual([
      'remint',
      'latched:claude_session_collision',
      'kill:claude_session_collision',
    ]);
    expect(spawnTerminal).not.toHaveBeenCalled();

    const { order, result } = emitExit(terminal);
    expect(order.map((entry) => entry.event)).toEqual([
      'spawn-retry-requested',
      'release',
      'exit',
    ]);
    expect(result.retryEvent).toEqual(expect.objectContaining({
      reason: 'claude_session_collision',
      paneId: '1',
      pid: 6666,
      paneLaunchId: LAUNCH_ID,
      appGeneration: APP_GENERATION,
      spawnRequestId: REQUEST_ID,
    }));

    const duplicate = emitExit(terminal);
    expect(duplicate.order.filter((entry) => entry.event === 'spawn-retry-requested')).toHaveLength(0);
  });

  test('Codex missing resume emits one exact app retry before exit and never respawns in the producer', () => {
    const terminal = exactTerminal();
    const spawnTerminal = jest.fn();
    captureCodexResumeOutput({
      terminal,
      data: 'ERROR: No saved sess',
      spawnCommandOnCreate: true,
      resumeDecision: {
        cli: 'codex',
        mode: 'resume',
        sessionId: '33333333-3333-4333-8333-333333333333',
      },
      nowMs: Date.now(),
    });
    const captured = captureCodexResumeOutput({
      terminal,
      data: 'ion found with ID 33333333-3333-4333-8333-333333333333.',
      spawnCommandOnCreate: true,
      resumeDecision: {
        cli: 'codex',
        mode: 'resume',
        sessionId: '33333333-3333-4333-8333-333333333333',
      },
      nowMs: Date.now(),
    });
    expect(captured.failure).toBe('missing_or_corrupt');

    terminal.alive = false;
    const handled = handleCodexResumeExit({
      terminal,
      exitCode: 1,
    }, {
      clearBinding: () => ({ ok: true, cleared: true }),
      spawnTerminal,
    });
    expect(handled).toEqual(expect.objectContaining({
      handled: true,
      action: 'retry_cold',
      retryReason: 'codex_missing_resume',
    }));
    expect(spawnTerminal).not.toHaveBeenCalled();

    const { order, result } = emitExit(terminal);
    expect(order.map((entry) => entry.event)).toEqual([
      'spawn-retry-requested',
      'release',
      'exit',
    ]);
    expect(result.retryEvent).toEqual(expect.objectContaining({
      reason: 'codex_missing_resume',
      paneId: '3',
      pid: 6666,
      paneLaunchId: LAUNCH_ID,
      appGeneration: APP_GENERATION,
      spawnRequestId: REQUEST_ID,
    }));
  });

  test.each([
    {
      name: 'nonmatching output',
      output: 'regular startup output',
      clearResult: { ok: true, cleared: true },
      expectedAction: 'none',
    },
    {
      name: 'active writer',
      output: 'thread already has an active writer',
      clearResult: { ok: true, cleared: true },
      expectedAction: 'hold_active_writer',
    },
    {
      name: 'rotated binding',
      output: 'ERROR: No saved session found with ID 33333333-3333-4333-8333-333333333333.',
      clearResult: {
        ok: true,
        cleared: false,
        rotated: true,
        currentSessionId: '44444444-4444-4444-8444-444444444444',
      },
      expectedAction: 'hold_rotated',
    },
  ])('$name emits zero retry', ({ output, clearResult, expectedAction }) => {
    const terminal = exactTerminal();
    captureCodexResumeOutput({
      terminal,
      data: output,
      spawnCommandOnCreate: true,
      resumeDecision: {
        cli: 'codex',
        mode: 'resume',
        sessionId: '33333333-3333-4333-8333-333333333333',
      },
      nowMs: Date.now(),
    });
    terminal.alive = false;
    const handled = handleCodexResumeExit({ terminal, exitCode: 1 }, {
      clearBinding: () => clearResult,
    });
    expect(handled.action).toBe(expectedAction);
    const { order } = emitExit(terminal);
    expect(order.filter((entry) => entry.event === 'spawn-retry-requested')).toHaveLength(0);
  });

  test('missing exact launch provenance emits exit but zero retry', () => {
    const terminal = exactTerminal({
      alive: false,
      appOwnedRetryReason: 'codex_missing_resume',
      spawnRequestId: null,
    });
    const { order } = emitExit(terminal);
    expect(order.map((entry) => entry.event)).toEqual(['release', 'exit']);
  });
});
