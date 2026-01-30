/**
 * Tests for modules/codex-exec.js
 */

const { EventEmitter } = require('events');
const { createCodexExecRunner } = require('../modules/codex-exec');

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const { spawn } = require('child_process');

function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: jest.fn(),
    end: jest.fn(),
  };
  child.unref = jest.fn();
  return child;
}

describe('codex-exec runner', () => {
  let broadcast;
  let logInfo;
  let logWarn;

  beforeEach(() => {
    broadcast = jest.fn();
    logInfo = jest.fn();
    logWarn = jest.fn();
    spawn.mockReset();
  });

  test('requires a broadcast function', () => {
    expect(() => createCodexExecRunner()).toThrow(/broadcast/);
  });

  test('returns error when terminal missing or not alive', () => {
    const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
    const result = runner.runCodexExec('4', { alive: false }, 'hi');
    expect(result.success).toBe(false);
  });

  test('spawns codex exec with --cd when no session id', () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
    const terminal = { alive: true, mode: 'codex-exec', cwd: 'C:\\work' };

    const result = runner.runCodexExec('4', terminal, 'hello');
    expect(result.success).toBe(true);

    const [cmd, args, options] = spawn.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(args).toEqual(expect.arrayContaining([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--cd',
      'C:\\work',
      '-',
    ]));
    expect(options.shell).toBe(true);

    expect(terminal.execProcess).toBe(child);
    expect(child.stdin.write.mock.calls[0][0]).toBe('hello');
    expect(child.stdin.write.mock.calls[1][0]).toBe('\n');
    expect(child.stdin.end).toHaveBeenCalled();
  });

  test('spawns codex exec with resume when session id exists', () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
    const terminal = {
      alive: true,
      mode: 'codex-exec',
      cwd: 'C:\\work',
      codexSessionId: 'thread-123',
    };

    runner.runCodexExec('4', terminal, 'hello');

    const [, args] = spawn.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
      'thread-123',
      '-',
    ]));
  });

  test('captures session id and broadcasts delta output', () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
    const terminal = { alive: true, mode: 'codex-exec', cwd: 'C:\\work' };

    runner.runCodexExec('4', terminal, 'go');

    const sessionLine = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'sess-1' },
    }) + '\n';
    child.stdout.emit('data', Buffer.from(sessionLine));
    expect(terminal.codexSessionId).toBe('sess-1');

    const deltaLine = JSON.stringify({
      type: 'response.output_text.delta',
      delta: { text: 'Hello' },
    }) + '\n';
    child.stdout.emit('data', Buffer.from(deltaLine));

    const broadcastData = broadcast.mock.calls.map(call => call[0].data);
    // Output now includes ANSI color codes (cyan for Working)
    expect(broadcastData.some(d => d && d.includes('[Working...]'))).toBe(true);
    expect(broadcastData).toContain('Hello');
  });

  test('handles non-JSON output by emitting raw line', () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
    const terminal = { alive: true, mode: 'codex-exec', cwd: 'C:\\work' };

    runner.runCodexExec('4', terminal, 'hi');
    child.stdout.emit('data', Buffer.from('not-json\n'));

    const payloads = broadcast.mock.calls.map(call => call[0].data);
    expect(payloads).toContain('not-json\r\n');
  });

  test('returns busy when exec already running', () => {
    const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
    const terminal = { alive: true, mode: 'codex-exec', execProcess: {} };

    const result = runner.runCodexExec('4', terminal, 'hi');
    expect(result.success).toBe(false);
    expect(broadcast).toHaveBeenCalled();
    expect(broadcast.mock.calls[0][0].data).toMatch(/busy/i);
  });
});
