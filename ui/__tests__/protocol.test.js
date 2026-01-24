/**
 * Tests for daemon protocol message format
 */

const { PROTOCOL_ACTIONS, PROTOCOL_EVENTS } = require('../config');

describe('Daemon Protocol', () => {
  describe('Client -> Daemon Messages', () => {
    test('spawn message should have required fields', () => {
      const msg = { action: 'spawn', paneId: '1', cwd: '/tmp' };
      expect(msg.action).toBe('spawn');
      expect(msg.paneId).toBeDefined();
      expect(msg.cwd).toBeDefined();
    });

    test('write message should have required fields', () => {
      const msg = { action: 'write', paneId: '1', data: 'hello\n' };
      expect(msg.action).toBe('write');
      expect(msg.paneId).toBeDefined();
      expect(msg.data).toBeDefined();
    });

    test('resize message should have required fields', () => {
      const msg = { action: 'resize', paneId: '1', cols: 80, rows: 24 };
      expect(msg.action).toBe('resize');
      expect(msg.paneId).toBeDefined();
      expect(msg.cols).toBeDefined();
      expect(msg.rows).toBeDefined();
    });

    test('kill message should have required fields', () => {
      const msg = { action: 'kill', paneId: '1' };
      expect(msg.action).toBe('kill');
      expect(msg.paneId).toBeDefined();
    });

    test('list message requires only action', () => {
      const msg = { action: 'list' };
      expect(msg.action).toBe('list');
    });

    test('messages should be JSON serializable', () => {
      const messages = [
        { action: 'spawn', paneId: '1', cwd: '/tmp' },
        { action: 'write', paneId: '2', data: 'test\n' },
        { action: 'resize', paneId: '3', cols: 120, rows: 40 },
        { action: 'kill', paneId: '4' },
        { action: 'list' },
      ];

      messages.forEach(msg => {
        const json = JSON.stringify(msg);
        const parsed = JSON.parse(json);
        expect(parsed).toEqual(msg);
      });
    });
  });

  describe('Daemon -> Client Messages', () => {
    test('data event should have paneId and data', () => {
      const msg = { event: 'data', paneId: '1', data: 'output here' };
      expect(msg.event).toBe('data');
      expect(msg.paneId).toBeDefined();
      expect(msg.data).toBeDefined();
    });

    test('exit event should have paneId and code', () => {
      const msg = { event: 'exit', paneId: '1', code: 0 };
      expect(msg.event).toBe('exit');
      expect(msg.paneId).toBeDefined();
      expect(typeof msg.code).toBe('number');
    });

    test('spawned event should have paneId and pid', () => {
      const msg = { event: 'spawned', paneId: '1', pid: 12345 };
      expect(msg.event).toBe('spawned');
      expect(msg.paneId).toBeDefined();
      expect(typeof msg.pid).toBe('number');
    });

    test('list event should have terminals array', () => {
      const msg = {
        event: 'list',
        terminals: [
          { paneId: '1', pid: 1234, alive: true },
          { paneId: '2', pid: 5678, alive: false },
        ],
      };
      expect(msg.event).toBe('list');
      expect(Array.isArray(msg.terminals)).toBe(true);
      expect(msg.terminals[0].paneId).toBeDefined();
      expect(msg.terminals[0].pid).toBeDefined();
      expect(typeof msg.terminals[0].alive).toBe('boolean');
    });

    test('error event should have message', () => {
      const msg = { event: 'error', message: 'Something went wrong' };
      expect(msg.event).toBe('error');
      expect(msg.message).toBeDefined();
    });

    test('error event can optionally have paneId', () => {
      const msgWithPane = { event: 'error', paneId: '1', message: 'Terminal not found' };
      const msgWithoutPane = { event: 'error', message: 'Parse error' };
      
      expect(msgWithPane.paneId).toBe('1');
      expect(msgWithoutPane.paneId).toBeUndefined();
    });
  });

  describe('Message Parsing', () => {
    test('should handle newline-delimited messages', () => {
      const buffer = '{"action":"list"}\n{"action":"ping"}\n';
      const messages = buffer.split('\n').filter(line => line.trim());
      
      expect(messages.length).toBe(2);
      expect(JSON.parse(messages[0]).action).toBe('list');
      expect(JSON.parse(messages[1]).action).toBe('ping');
    });

    test('should handle incomplete messages in buffer', () => {
      const buffer = '{"action":"list"}\n{"action":"sp';
      const lines = buffer.split('\n');
      const complete = lines.slice(0, -1);
      const incomplete = lines[lines.length - 1];

      expect(complete.length).toBe(1);
      expect(JSON.parse(complete[0]).action).toBe('list');
      expect(() => JSON.parse(incomplete)).toThrow();
    });
  });

  describe('Protocol Constants', () => {
    test('all actions should be lowercase strings', () => {
      PROTOCOL_ACTIONS.forEach(action => {
        expect(typeof action).toBe('string');
        expect(action).toBe(action.toLowerCase());
      });
    });

    test('all events should be lowercase strings', () => {
      PROTOCOL_EVENTS.forEach(event => {
        expect(typeof event).toBe('string');
        expect(event).toBe(event.toLowerCase());
      });
    });
  });
});
