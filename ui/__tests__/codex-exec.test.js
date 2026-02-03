/**
 * Tests for modules/codex-exec.js
 * Comprehensive coverage of Codex exec runner
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
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('createCodexExecRunner', () => {
    test('requires a broadcast function', () => {
      expect(() => createCodexExecRunner()).toThrow(/broadcast/);
    });

    test('throws when broadcast is not a function', () => {
      expect(() => createCodexExecRunner({ broadcast: 'not a func' })).toThrow(/broadcast/);
    });

    test('throws when broadcast is missing', () => {
      expect(() => createCodexExecRunner({})).toThrow(/broadcast/);
    });

    test('creates runner with minimal options', () => {
      const runner = createCodexExecRunner({ broadcast });
      expect(runner).toBeDefined();
      expect(typeof runner.runCodexExec).toBe('function');
    });

    test('accepts optional logInfo and logWarn', () => {
      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      expect(runner).toBeDefined();
    });

    test('accepts custom scrollbackMaxSize', () => {
      const runner = createCodexExecRunner({ broadcast, scrollbackMaxSize: 1000 });
      expect(runner).toBeDefined();
    });
  });

  describe('runCodexExec validation', () => {
    test('returns error when terminal missing or not alive', () => {
      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      const result = runner.runCodexExec('4', { alive: false }, 'hi');
      expect(result.success).toBe(false);
    });

    test('returns error when terminal is null', () => {
      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      const result = runner.runCodexExec('4', null, 'hi');
      expect(result).toEqual({ success: false, error: 'Terminal not found or not alive' });
    });

    test('returns error when mode is not codex-exec', () => {
      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      const result = runner.runCodexExec('4', { alive: true, mode: 'pty' }, 'hi');
      expect(result).toEqual({ success: false, error: 'Codex exec not enabled for this pane' });
    });

    test('returns busy when exec already running', () => {
      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      const terminal = { alive: true, mode: 'codex-exec', execProcess: {} };

      const result = runner.runCodexExec('4', terminal, 'hi');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Codex exec already running');
      expect(broadcast).toHaveBeenCalled();
      expect(broadcast.mock.calls[0][0].data).toMatch(/busy/i);
    });
  });

  describe('spawn behavior', () => {
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
      // shell can be true (non-Windows) or explicit path (Windows)
      expect(options.shell).toBeTruthy();
      expect(options.windowsHide).toBe(true);

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

    test('uses process.cwd when terminal.cwd not set', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'hello');

      const [, , options] = spawn.mock.calls[0];
      expect(options.cwd).toBe(process.cwd());
    });

    test('does not add extra newline if prompt ends with one', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'hello\n');

      expect(child.stdin.write).toHaveBeenCalledTimes(1);
      expect(child.stdin.write).toHaveBeenCalledWith('hello\n');
    });

    test('handles empty prompt', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, '');

      expect(child.stdin.write).toHaveBeenCalledWith('');
      expect(child.stdin.write).toHaveBeenCalledWith('\n');
    });

    test('handles non-string prompt', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, { object: 'prompt' });

      expect(child.stdin.write).toHaveBeenCalledWith('');
    });

    test('initializes terminal state', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'test');

      expect(terminal.execProcess).toBe(child);
      expect(terminal.execBuffer).toBe('');
      expect(terminal.execWorkingEmitted).toBe(false);
      expect(terminal.execDoneEmitted).toBe(false);
      expect(terminal.lastInputTime).toBeDefined();
    });
  });

  describe('stdout handling', () => {
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
      expect(terminal.codexHasSession).toBe(true);

      const deltaLine = JSON.stringify({
        type: 'response.output_text.delta',
        delta: { text: 'Hello' },
      }) + '\n';
      child.stdout.emit('data', Buffer.from(deltaLine));

      const broadcastData = broadcast.mock.calls.map(call => call[0].data);
      expect(broadcastData.some(d => d && d.includes('[Working...]'))).toBe(true);
      expect(broadcastData).toContain('Hello');
    });

    test('captures thread.started thread_id', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const threadStarted = JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc-123' });
      child.stdout.emit('data', Buffer.from(threadStarted + '\n'));

      expect(terminal.codexSessionId).toBe('thread-abc-123');
      expect(terminal.codexHasSession).toBe(true);
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

    test('handles partial JSON lines', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      // Send in two parts
      child.stdout.emit('data', Buffer.from('{"type":"test","pay'));
      child.stdout.emit('data', Buffer.from('load":{"text":"partial"}}\n'));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('partial'))).toBe(true);
    });

    test('handles multiple JSON lines in one chunk', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const twoLines =
        JSON.stringify({ type: 'test', payload: { text: 'first' } }) + '\n' +
        JSON.stringify({ type: 'test', payload: { text: 'second' } }) + '\n';
      child.stdout.emit('data', Buffer.from(twoLines));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('first'))).toBe(true);
      expect(payloads.some(d => d && d.includes('second'))).toBe(true);
    });

    test('silences metadata events', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      // First, trigger working marker with a start event so it's out of the way
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.started' }) + '\n'));
      broadcast.mockClear();

      // These should be silenced (no additional data events)
      const silentEvents = ['ping', 'rate_limit', 'message_completed', 'turn_completed',
        'content_block_start', 'content_block_stop', 'input_json_delta'];

      for (const eventType of silentEvents) {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: eventType }) + '\n'));
      }

      // No data events should be broadcast for silent events
      const dataEvents = broadcast.mock.calls.filter(c => c[0].event === 'data');
      expect(dataEvents).toHaveLength(0);
    });

    test('emits working marker on start events', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn_started' }) + '\n'));

      const workingCalls = broadcast.mock.calls.filter(c =>
        c[0].event === 'data' && c[0].data?.includes('[Working...]')
      );
      expect(workingCalls.length).toBeGreaterThan(0);
    });

    test('emits activity for thinking on start event', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.started' }) + '\n'));

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'codex-activity',
        paneId: '4',
        state: 'thinking',
      }));
    });

    test('emits streaming activity for delta events', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const delta = JSON.stringify({ type: 'content_block_delta', payload: { delta: { text: 'streaming' } } });
      child.stdout.emit('data', Buffer.from(delta + '\n'));

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'codex-activity',
        state: 'streaming',
      }));
    });

    test('only emits working marker once', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      // Multiple start events
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn_started' }) + '\n'));
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'message_started' }) + '\n'));
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.started' }) + '\n'));

      const workingCalls = broadcast.mock.calls.filter(c =>
        c[0].event === 'data' && c[0].data?.includes('[Working...]')
      );
      expect(workingCalls).toHaveLength(1);
    });
  });

  describe('text extraction', () => {
    test('extracts text from payload.text', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'response', payload: { text: 'extracted text' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('extracted text'))).toBe(true);
    });

    test('extracts text from delta.text', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'content', payload: { delta: { text: 'delta text' } } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('delta text'))).toBe(true);
    });

    test('extracts text from text_delta', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'content', payload: { text_delta: 'text delta value' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('text delta value'))).toBe(true);
    });

    test('extracts text from item.text (item.completed)', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'item.completed', payload: { item: { text: 'item completed text' } } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('item completed text'))).toBe(true);
    });

    test('extracts text from output field', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'agent_message', payload: { output: 'output text' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('output text'))).toBe(true);
    });

    test('extracts text from result field', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'task_complete', payload: { result: 'result text' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('result text'))).toBe(true);
    });

    test('extracts text from content string', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'message', payload: { content: 'content string' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('content string'))).toBe(true);
    });

    test('extracts text from content array', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({
        type: 'message',
        payload: {
          content: [
            { text: 'part1' },
            { content: 'part2' },
            { content: { text: 'part3' } },
          ],
        },
      });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('part1part2part3'))).toBe(true);
    });

    test('extracts text from message.content', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({
        type: 'response',
        payload: { message: { content: 'message content' } },
      });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('message content'))).toBe(true);
    });

    test('handles string payload directly', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'text', payload: 'direct string' });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('direct string'))).toBe(true);
    });
  });

  describe('auxiliary event formatting', () => {
    test('formats FILE events', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'file_write', payload: { file: '/path/to/file.js' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'data',
        data: expect.stringContaining('[FILE]'),
      }));
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'codex-activity',
        state: 'file',
      }));
    });

    test('formats multiple files', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'file', payload: { files: ['a.js', 'b.js', 'c.js'] } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const fileEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[FILE]')
      );
      expect(fileEvent[0].data).toContain('3 files');
    });

    test('formats single file from array', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'file', payload: { files: ['single.js'] } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const fileEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[FILE]')
      );
      expect(fileEvent[0].data).toContain('single.js');
    });

    test('formats file count', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'file_batch', payload: { count: 10 } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const fileEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[FILE]')
      );
      expect(fileEvent[0].data).toContain('10 files');
    });

    test('formats CMD events', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'command', payload: { command: 'npm test' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'data',
        data: expect.stringContaining('[CMD]'),
      }));
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'codex-activity',
        state: 'command',
      }));
    });

    test('extracts command from array', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'command', payload: { command: ['npm', 'run', 'test'] } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const cmdEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[CMD]')
      );
      expect(cmdEvent[0].data).toContain('npm run test');
    });

    test('formats TOOL events', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'tool_use', payload: { tool_name: 'read_file' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'data',
        data: expect.stringContaining('[TOOL]'),
      }));
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'codex-activity',
        state: 'tool',
      }));
    });

    test('skips completed events for commands', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');
      broadcast.mockClear();

      const event = JSON.stringify({ type: 'command_completed', payload: { command: 'done' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const cmdEvents = broadcast.mock.calls.filter(c =>
        c[0].event === 'data' && c[0].data?.includes('[CMD]')
      );
      expect(cmdEvents).toHaveLength(0);
    });

    test('skips completed events for tools', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');
      broadcast.mockClear();

      const event = JSON.stringify({ type: 'tool_completed', payload: { tool_name: 'read_file' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const toolEvents = broadcast.mock.calls.filter(c =>
        c[0].event === 'data' && c[0].data?.includes('[TOOL]')
      );
      expect(toolEvents).toHaveLength(0);
    });
  });

  describe('command extraction variants', () => {
    test('extracts from nested command object', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'command', payload: { command: { command: 'nested' } } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const cmdEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[CMD]')
      );
      expect(cmdEvent[0].data).toContain('nested');
    });

    test('extracts from command.args array', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'command', payload: { command: { args: ['git', 'status'] } } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const cmdEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[CMD]')
      );
      expect(cmdEvent[0].data).toContain('git status');
    });

    test('extracts from command_line', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'command', payload: { command_line: 'ls -la' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const cmdEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[CMD]')
      );
      expect(cmdEvent[0].data).toContain('ls -la');
    });

    test('extracts from commandLine', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'command', payload: { commandLine: 'echo hello' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const cmdEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[CMD]')
      );
      expect(cmdEvent[0].data).toContain('echo hello');
    });

    test('extracts from cmd field', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'command', payload: { cmd: 'pwd' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const cmdEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[CMD]')
      );
      expect(cmdEvent[0].data).toContain('pwd');
    });

    test('extracts from args array', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'command', payload: { args: ['node', 'app.js'] } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const cmdEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[CMD]')
      );
      expect(cmdEvent[0].data).toContain('node app.js');
    });

    test('extracts from argv array', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'command', payload: { argv: ['python', 'script.py'] } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const cmdEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[CMD]')
      );
      expect(cmdEvent[0].data).toContain('python script.py');
    });
  });

  describe('tool name extraction variants', () => {
    test('extracts from toolName', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'tool_use', payload: { toolName: 'searchFiles' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const toolEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[TOOL]')
      );
      expect(toolEvent[0].data).toContain('searchFiles');
    });

    test('extracts from name field', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'tool_use', payload: { name: 'webSearch' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const toolEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[TOOL]')
      );
      expect(toolEvent[0].data).toContain('webSearch');
    });

    test('extracts from tool string', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'tool_call', payload: { tool: 'readFile' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const toolEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[TOOL]')
      );
      expect(toolEvent[0].data).toContain('readFile');
    });

    test('extracts from tool.name', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'tool_use', payload: { tool: { name: 'executeCommand' } } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const toolEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[TOOL]')
      );
      expect(toolEvent[0].data).toContain('executeCommand');
    });

    test('extracts from tool_call.name', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'tool_use', payload: { tool_call: { name: 'analyzeCode' } } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const toolEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[TOOL]')
      );
      expect(toolEvent[0].data).toContain('analyzeCode');
    });

    test('extracts from tool_call.function.name', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'tool_use', payload: { tool_call: { function: { name: 'funcName' } } } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const toolEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[TOOL]')
      );
      expect(toolEvent[0].data).toContain('funcName');
    });

    test('extracts from function.name', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'tool_use', payload: { function: { name: 'myFunction' } } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const toolEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[TOOL]')
      );
      expect(toolEvent[0].data).toContain('myFunction');
    });
  });

  describe('tool detail extraction', () => {
    test('extracts query from input', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'tool_use', payload: { tool_name: 'search', input: { query: 'find files' } } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const toolEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[TOOL]')
      );
      expect(toolEvent[0].data).toContain('find files');
    });

    test('extracts string input directly', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'tool_use', payload: { tool_name: 'echo', input: 'direct string' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const toolEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[TOOL]')
      );
      expect(toolEvent[0].data).toContain('direct string');
    });
  });

  describe('file action derivation', () => {
    test('derives deleted action', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'file_delete', payload: { file: 'removed.txt', action: 'delete' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const fileEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[FILE]')
      );
      expect(fileEvent[0].data).toContain('deleted');
    });

    test('derives created action', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'file_create', payload: { file: 'new.txt', action: 'create' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const fileEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[FILE]')
      );
      expect(fileEvent[0].data).toContain('created');
    });

    test('derives edited action from write', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'file_write', payload: { file: 'edited.txt', action: 'write' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const fileEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[FILE]')
      );
      expect(fileEvent[0].data).toContain('edited');
    });

    test('defaults to updated action', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'file_touch', payload: { file: 'touched.txt' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const fileEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[FILE]')
      );
      expect(fileEvent[0].data).toContain('updated');
    });
  });

  describe('detail truncation', () => {
    test('truncates long details', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const longCommand = 'a'.repeat(200);
      const event = JSON.stringify({ type: 'command', payload: { command: longCommand } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const cmdEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[CMD]')
      );
      expect(cmdEvent[0].data.length).toBeLessThan(250);
      expect(cmdEvent[0].data).toContain('...');
    });

    test('collapses whitespace in details', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'command', payload: { command: 'echo   hello   \n\t  world' } });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const cmdEvent = broadcast.mock.calls.find(c =>
        c[0].event === 'data' && c[0].data?.includes('[CMD]')
      );
      expect(cmdEvent[0].data).toContain('echo hello world');
    });
  });

  describe('stderr handling', () => {
    test('broadcasts stderr output', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      child.stderr.emit('data', Buffer.from('Some error message'));

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'data',
        paneId: '4',
        data: expect.stringContaining('[Codex exec stderr]'),
      }));
    });
  });

  describe('process events', () => {
    test('handles process error', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      child.emit('error', new Error('spawn failed'));

      expect(terminal.execProcess).toBeNull();
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'data',
        data: expect.stringContaining('[Codex exec error]'),
      }));
    });

    test('handles process close with exit code 0', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      child.emit('close', 0);

      expect(terminal.execProcess).toBeNull();
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'data',
        data: expect.stringMatching(/\[Done \(exit 0\)\]/),
      }));
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'codex-activity',
        state: 'done',
        detail: 'Success',
      }));
    });

    test('handles process close with non-zero exit code', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      child.emit('close', 1);

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'data',
        data: expect.stringMatching(/\[Done \(exit 1\)\]/),
      }));
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'codex-activity',
        state: 'done',
        detail: 'Exit 1',
      }));
    });

    test('flushes remaining buffer on close', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      // Send partial data without newline
      child.stdout.emit('data', Buffer.from('{"type":"response","payload":{"text":"final"}}'));

      // Close should process remaining buffer
      child.emit('close', 0);

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('final'))).toBe(true);
    });

    test('emits ready activity after delay', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');
      child.emit('close', 0);

      jest.advanceTimersByTime(2000);

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        event: 'codex-activity',
        state: 'ready',
      }));
    });

    test('only emits done marker once', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');
      child.emit('close', 0);
      child.emit('close', 0); // Duplicate

      const doneCalls = broadcast.mock.calls.filter(c =>
        c[0].event === 'data' && c[0].data?.includes('[Done')
      );
      expect(doneCalls).toHaveLength(1);
    });
  });

  describe('scrollback management', () => {
    test('appends to scrollback', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      child.stdout.emit('data', Buffer.from('some output\n'));

      expect(terminal.scrollback).toBeDefined();
      expect(terminal.scrollback.length).toBeGreaterThan(0);
    });

    test('trims scrollback when exceeding max size', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo, scrollbackMaxSize: 100 });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      // Generate lots of output
      for (let i = 0; i < 20; i++) {
        child.stdout.emit('data', Buffer.from('x'.repeat(50) + '\n'));
      }

      expect(terminal.scrollback.length).toBeLessThanOrEqual(100);
    });
  });

  describe('BIDI control stripping', () => {
    test('strips LTR/RTL marks', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      // Text with BIDI controls (U+200E LTR, U+200F RTL)
      child.stdout.emit('data', Buffer.from('Hello\u200E world\u200F!\n'));

      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('Hello world!'))).toBe(true);
    });
  });

  describe('unknown event handling', () => {
    test('logs warning for unhandled events', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      const event = JSON.stringify({ type: 'completely_unknown_event', payload: {} });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      // logWarn receives a single string argument containing the event type
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('completely_unknown_event'));
    });
  });

  describe('edge case handling', () => {
    test('handles empty line gracefully', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      // Empty lines should be ignored (trimmed to nothing)
      child.stdout.emit('data', Buffer.from('\n\n\n'));

      // Should not throw
      expect(true).toBe(true);
    });

    test('handles whitespace-only lines gracefully', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      child.stdout.emit('data', Buffer.from('   \n'));

      // Should not throw
      expect(true).toBe(true);
    });

    test('handles JSON with null type', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      // JSON with null type - this should go through as unhandled
      child.stdout.emit('data', Buffer.from('{"type":null,"payload":{}}\n'));

      // Should log warning for unhandled event type
      expect(logWarn).toHaveBeenCalled();
    });

    test('handles JSON with missing type', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      child.stdout.emit('data', Buffer.from('{"payload":{"text":"no type"}}\n'));

      // Should still extract and broadcast the text
      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('no type'))).toBe(true);
    });

    test('handles numeric content in message event without crashing', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');
      broadcast.mockClear();

      // Send message event with numeric content - should not crash
      expect(() => {
        child.stdout.emit('data', Buffer.from('{"type":"message","payload":{"content":42}}\n'));
      }).not.toThrow();

      // Numeric content is not treated as text, so no text broadcast expected
      // (only the initial spawn broadcasts are made before mockClear)
    });

    test('handles boolean content in message event without crashing', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');
      broadcast.mockClear();

      // Send message event with boolean content - should not crash
      expect(() => {
        child.stdout.emit('data', Buffer.from('{"type":"message","payload":{"content":true}}\n'));
      }).not.toThrow();

      // Boolean content is not treated as text, so no text broadcast expected
    });

    test('extracts command from argv array', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      // Send command event with argv array
      child.stdout.emit('data', Buffer.from('{"type":"command","payload":{"argv":["npm","test"]}}\n'));

      expect(broadcast).toHaveBeenCalled();
      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('npm') && d.includes('test'))).toBe(true);
    });

    test('extracts tool name from function.name', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      // Send tool event with function.name
      child.stdout.emit('data', Buffer.from('{"type":"tool_use","payload":{"function":{"name":"read_file"}}}\n'));

      expect(broadcast).toHaveBeenCalled();
      const payloads = broadcast.mock.calls.map(call => call[0].data);
      expect(payloads.some(d => d && d.includes('read_file'))).toBe(true);
    });

    test('extracts tool detail from input.query', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo, logWarn });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');

      // Send tool event with input.query
      child.stdout.emit('data', Buffer.from('{"type":"tool_use","payload":{"name":"search","input":{"query":"find something"}}}\n'));

      expect(broadcast).toHaveBeenCalled();
    });
  });

  describe('reasoning/thinking styling', () => {
    test('applies dim+italic ANSI to reasoning item type', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');
      broadcast.mockClear();

      // Codex exec reasoning item
      const event = JSON.stringify({
        type: 'item.completed',
        payload: { item: { type: 'reasoning', text: 'Let me think about this...' } }
      });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const dataPayloads = broadcast.mock.calls
        .filter(c => c[0].event === 'data')
        .map(c => c[0].data);

      // Should contain DIM_ITALIC ANSI code (\x1b[2;3m) and RESET (\x1b[0m)
      expect(dataPayloads.some(d => d && d.includes('\x1b[2;3m') && d.includes('Let me think'))).toBe(true);
      expect(dataPayloads.some(d => d && d.includes('\x1b[0m'))).toBe(true);
    });

    test('does not apply styling to agent_message item type', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');
      broadcast.mockClear();

      // Codex exec agent_message item (decision/response)
      const event = JSON.stringify({
        type: 'item.completed',
        payload: { item: { type: 'agent_message', text: 'Here is my answer.' } }
      });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const dataPayloads = broadcast.mock.calls
        .filter(c => c[0].event === 'data')
        .map(c => c[0].data);

      // Should contain the text but NOT dim+italic ANSI code
      expect(dataPayloads.some(d => d && d.includes('Here is my answer'))).toBe(true);
      expect(dataPayloads.some(d => d && d.includes('\x1b[2;3m'))).toBe(false);
    });

    test('applies styling to delta with thinking type', () => {
      const child = createMockChild();
      spawn.mockReturnValue(child);

      const runner = createCodexExecRunner({ broadcast, logInfo });
      const terminal = { alive: true, mode: 'codex-exec' };

      runner.runCodexExec('4', terminal, 'go');
      broadcast.mockClear();

      // Claude API format delta with thinking type
      const event = JSON.stringify({
        type: 'content_block_delta',
        payload: { delta: { type: 'thinking', text: 'analyzing...' } }
      });
      child.stdout.emit('data', Buffer.from(event + '\n'));

      const dataPayloads = broadcast.mock.calls
        .filter(c => c[0].event === 'data')
        .map(c => c[0].data);

      // Should contain DIM_ITALIC ANSI code
      expect(dataPayloads.some(d => d && d.includes('\x1b[2;3m') && d.includes('analyzing'))).toBe(true);
    });
  });
});
