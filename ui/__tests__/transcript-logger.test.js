/**
 * Transcript Logger Tests
 * Target: Full coverage of modules/memory/transcript-logger.js
 */

// Create mock memory-store before requiring the module
const mockMemoryStore = {
  PANE_ROLES: {
    '1': 'architect',
    '2': 'orchestrator',
    '3': 'implementer-a',
    '4': 'implementer-b',
    '5': 'investigator',
    '6': 'reviewer'
  },
  getRoleFromPaneId: jest.fn(id => mockMemoryStore.PANE_ROLES[String(id)] || `pane-${id}`),
  appendTranscript: jest.fn(),
  addSharedDecision: jest.fn(),
  readTranscript: jest.fn(() => []),
  getTranscriptStats: jest.fn(() => ({}))
};

jest.mock('../modules/memory/memory-store', () => mockMemoryStore);

// Require after mocking
const transcriptLogger = require('../modules/memory/transcript-logger');

describe('Transcript Logger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Force flush to clear any pending logs
    transcriptLogger.forceFlush();
    jest.useRealTimers();
  });

  describe('EntryType constants', () => {
    test('exports entry type constants', () => {
      expect(transcriptLogger.EntryType.INPUT).toBe('input');
      expect(transcriptLogger.EntryType.OUTPUT).toBe('output');
      expect(transcriptLogger.EntryType.TOOL_USE).toBe('tool_use');
      expect(transcriptLogger.EntryType.TOOL_RESULT).toBe('tool_result');
      expect(transcriptLogger.EntryType.SYSTEM).toBe('system');
      expect(transcriptLogger.EntryType.DECISION).toBe('decision');
      expect(transcriptLogger.EntryType.ERROR).toBe('error');
      expect(transcriptLogger.EntryType.STATE).toBe('state');
    });
  });

  describe('logInput', () => {
    test('logs input message for pane', () => {
      transcriptLogger.logInput('1', 'Hello world', { source: 'user' });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          type: 'input',
          paneId: '1',
          content: 'Hello world',
          metadata: expect.objectContaining({
            source: 'user',
            contentLength: 11
          })
        })
      );
    });

    test('truncates long content', () => {
      const longContent = 'x'.repeat(15000);
      transcriptLogger.logInput('1', longContent);
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          content: expect.stringContaining('[truncated')
        })
      );
    });

    test('handles empty content', () => {
      transcriptLogger.logInput('1', '');
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          content: '',
          metadata: expect.objectContaining({ contentLength: 0 })
        })
      );
    });
  });

  describe('logOutput', () => {
    test('logs output message for pane', () => {
      transcriptLogger.logOutput('2', 'Response text', { tokens: 50 });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'orchestrator',
        expect.objectContaining({
          type: 'output',
          paneId: '2',
          content: 'Response text',
          metadata: expect.objectContaining({
            tokens: 50,
            contentLength: 13
          })
        })
      );
    });
  });

  describe('logToolUse', () => {
    test('logs tool invocation', () => {
      transcriptLogger.logToolUse('1', 'Read', { file_path: '/test.js' });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          type: 'tool_use',
          content: 'Tool: Read',
          metadata: expect.objectContaining({
            toolName: 'Read',
            params: expect.objectContaining({ file_path: '/test.js' })
          })
        })
      );
    });

    test('redacts sensitive parameters', () => {
      transcriptLogger.logToolUse('1', 'ApiCall', {
        url: 'http://example.com',
        password: 'secret123',
        apiToken: 'tok_abc',
        authKey: 'key123'
      });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          metadata: expect.objectContaining({
            params: expect.objectContaining({
              url: 'http://example.com',
              password: '[REDACTED]',
              apiToken: '[REDACTED]',
              authKey: '[REDACTED]'
            })
          })
        })
      );
    });

    test('truncates long parameter values', () => {
      const longValue = 'x'.repeat(1500);
      transcriptLogger.logToolUse('1', 'Write', { content: longValue });
      transcriptLogger.forceFlush();

      const call = mockMemoryStore.appendTranscript.mock.calls[0];
      expect(call[1].metadata.params.content).toContain('[truncated]');
      expect(call[1].metadata.params.content.length).toBeLessThan(1500);
    });

    test('handles non-object params', () => {
      transcriptLogger.logToolUse('1', 'Test', null);
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          metadata: expect.objectContaining({
            params: null
          })
        })
      );
    });
  });

  describe('logToolResult', () => {
    test('logs tool result string', () => {
      transcriptLogger.logToolResult('1', 'Read', 'file contents here');
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          type: 'tool_result',
          content: 'file contents here',
          metadata: expect.objectContaining({
            toolName: 'Read',
            success: true
          })
        })
      );
    });

    test('logs tool result object', () => {
      transcriptLogger.logToolResult('1', 'Glob', { files: ['a.js', 'b.js'] });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          content: expect.stringContaining('files')
        })
      );
    });

    test('marks error results correctly', () => {
      transcriptLogger.logToolResult('1', 'Bash', 'Command failed', { error: true });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          metadata: expect.objectContaining({
            success: false
          })
        })
      );
    });
  });

  describe('logSystem', () => {
    test('logs system message', () => {
      transcriptLogger.logSystem('3', 'Process started', { pid: 1234 });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'implementer-a',
        expect.objectContaining({
          type: 'system',
          content: 'Process started',
          metadata: expect.objectContaining({ pid: 1234 })
        })
      );
    });
  });

  describe('logDecision', () => {
    test('logs decision with rationale', () => {
      transcriptLogger.logDecision('1', 'Use TypeScript', 'Better type safety');
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          type: 'decision',
          content: 'Use TypeScript',
          metadata: expect.objectContaining({
            rationale: 'Better type safety',
            decisionId: expect.stringMatching(/^dec-\d+-/)
          })
        })
      );
    });

    test('adds decision to shared decisions', () => {
      transcriptLogger.logDecision('1', 'Use React', 'Component model');
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.addSharedDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'Use React',
          rationale: 'Component model',
          agent: 'architect',
          paneId: '1'
        })
      );
    });

    test('handles empty rationale', () => {
      transcriptLogger.logDecision('1', 'Quick fix');
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          metadata: expect.objectContaining({
            rationale: ''
          })
        })
      );
    });
  });

  describe('logError', () => {
    test('logs error with Error object', () => {
      const error = new Error('Something went wrong');
      transcriptLogger.logError('1', 'Operation failed', error);
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          type: 'error',
          content: 'Operation failed',
          metadata: expect.objectContaining({
            errorMessage: 'Something went wrong',
            errorStack: expect.stringContaining('Error: Something went wrong')
          })
        })
      );
    });

    test('logs error without Error object', () => {
      transcriptLogger.logError('1', 'Unknown error', null);
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          metadata: expect.objectContaining({
            errorMessage: '',
            errorStack: ''
          })
        })
      );
    });

    test('logs error with string error', () => {
      transcriptLogger.logError('1', 'Failed', 'Custom error message');
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          metadata: expect.objectContaining({
            errorMessage: 'Custom error message'
          })
        })
      );
    });

    test('truncates long error stacks', () => {
      const error = new Error('Test');
      error.stack = Array(20).fill('at test (/path/to/file.js:1:1)').join('\n');
      transcriptLogger.logError('1', 'Stack test', error);
      transcriptLogger.forceFlush();

      const call = mockMemoryStore.appendTranscript.mock.calls[0];
      const stackLines = call[1].metadata.errorStack.split('\n');
      expect(stackLines.length).toBeLessThanOrEqual(5);
    });
  });

  describe('logState', () => {
    test('logs state transition', () => {
      transcriptLogger.logState('1', 'idle', 'processing', { trigger: 'message' });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          type: 'state',
          content: 'idle -> processing',
          metadata: expect.objectContaining({
            fromState: 'idle',
            toState: 'processing',
            trigger: 'message'
          })
        })
      );
    });
  });

  describe('logTriggerMessage', () => {
    test('logs message for both source and target', () => {
      transcriptLogger.logTriggerMessage('1', '6', 'Please review');
      transcriptLogger.forceFlush();

      // Should log output for source (architect)
      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          type: 'output',
          metadata: expect.objectContaining({
            messageType: 'trigger_sent',
            target: 'reviewer',
            targetPaneId: '6'
          })
        })
      );

      // Should log input for target (reviewer)
      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'reviewer',
        expect.objectContaining({
          type: 'input',
          metadata: expect.objectContaining({
            messageType: 'trigger_received',
            source: 'architect',
            sourcePaneId: '1'
          })
        })
      );
    });

    test('handles null source pane', () => {
      transcriptLogger.logTriggerMessage(null, '6', 'System message');
      transcriptLogger.forceFlush();

      // Should only log for target
      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledTimes(1);
      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'reviewer',
        expect.objectContaining({
          type: 'input'
        })
      );
    });

    test('handles null target pane', () => {
      transcriptLogger.logTriggerMessage('1', null, 'Broadcast');
      transcriptLogger.forceFlush();

      // Should only log for source
      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledTimes(1);
      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          type: 'output'
        })
      );
    });
  });

  describe('logCodexEvent', () => {
    test('logs message_start event', () => {
      transcriptLogger.logCodexEvent('2', {
        type: 'message_start',
        content: 'Starting response',
        id: 'msg-123',
        model: 'gpt-4'
      });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'orchestrator',
        expect.objectContaining({
          type: 'output',
          content: 'Starting response',
          metadata: expect.objectContaining({
            codexEvent: 'message_start',
            messageId: 'msg-123',
            model: 'gpt-4'
          })
        })
      );
    });

    test('logs message event', () => {
      transcriptLogger.logCodexEvent('2', {
        type: 'message',
        message: 'Full message content'
      });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'orchestrator',
        expect.objectContaining({
          type: 'output',
          content: 'Full message content'
        })
      );
    });

    test('logs tool_use event', () => {
      transcriptLogger.logCodexEvent('2', {
        type: 'tool_use',
        name: 'read_file',
        id: 'tool-456'
      });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'orchestrator',
        expect.objectContaining({
          type: 'tool_use',
          content: 'Tool: read_file',
          metadata: expect.objectContaining({
            codexEvent: 'tool_use',
            toolName: 'read_file',
            toolId: 'tool-456'
          })
        })
      );
    });

    test('logs tool_use with unknown tool', () => {
      transcriptLogger.logCodexEvent('2', {
        type: 'tool_use'
        // No name provided
      });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'orchestrator',
        expect.objectContaining({
          content: 'Tool: unknown'
        })
      );
    });

    test('logs tool_result event', () => {
      transcriptLogger.logCodexEvent('2', {
        type: 'tool_result',
        content: 'Tool output here',
        tool_use_id: 'tool-456',
        is_error: false
      });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'orchestrator',
        expect.objectContaining({
          type: 'tool_result',
          content: 'Tool output here',
          metadata: expect.objectContaining({
            codexEvent: 'tool_result',
            toolId: 'tool-456',
            isError: false
          })
        })
      );
    });

    test('skips text streaming events', () => {
      transcriptLogger.logCodexEvent('2', { type: 'text', delta: 'abc' });
      transcriptLogger.logCodexEvent('2', { type: 'content_block_delta', delta: 'xyz' });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).not.toHaveBeenCalled();
    });

    test('logs session_meta event', () => {
      transcriptLogger.logCodexEvent('2', {
        type: 'session_meta',
        session_id: 'sess-789'
      });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'orchestrator',
        expect.objectContaining({
          type: 'system',
          content: 'Session: sess-789',
          metadata: expect.objectContaining({
            codexEvent: 'session_meta',
            sessionId: 'sess-789'
          })
        })
      );
    });

    test('logs message_stop event', () => {
      transcriptLogger.logCodexEvent('2', {
        type: 'message_stop',
        stop_reason: 'end_turn'
      });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'orchestrator',
        expect.objectContaining({
          type: 'system',
          content: 'Message complete',
          metadata: expect.objectContaining({
            codexEvent: 'message_stop',
            stopReason: 'end_turn'
          })
        })
      );
    });

    test('logs done event', () => {
      transcriptLogger.logCodexEvent('2', { type: 'done' });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'orchestrator',
        expect.objectContaining({
          content: 'Message complete',
          metadata: expect.objectContaining({
            codexEvent: 'done'
          })
        })
      );
    });

    test('logs unknown event types as system', () => {
      transcriptLogger.logCodexEvent('2', {
        type: 'custom_event',
        data: 'custom data'
      });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'orchestrator',
        expect.objectContaining({
          type: 'system',
          content: 'Codex event: custom_event',
          metadata: expect.objectContaining({
            codexEvent: 'custom_event',
            raw: expect.stringContaining('custom_event')
          })
        })
      );
    });

    test('handles event with no type', () => {
      transcriptLogger.logCodexEvent('2', { data: 'no type' });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'orchestrator',
        expect.objectContaining({
          content: 'Codex event: unknown'
        })
      );
    });
  });

  describe('Buffer and Flush', () => {
    test('batches logs and flushes after interval', () => {
      transcriptLogger.logInput('1', 'Message 1');
      transcriptLogger.logInput('1', 'Message 2');

      // Should not flush immediately
      expect(mockMemoryStore.appendTranscript).not.toHaveBeenCalled();

      // Advance timer
      jest.advanceTimersByTime(5000);

      // Now should be flushed
      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledTimes(2);
    });

    test('forceFlush immediately writes all buffered logs', () => {
      transcriptLogger.logInput('1', 'Test 1');
      transcriptLogger.logOutput('1', 'Test 2');

      expect(mockMemoryStore.appendTranscript).not.toHaveBeenCalled();

      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledTimes(2);
    });

    test('forceFlush clears pending timer', () => {
      transcriptLogger.logInput('1', 'Test');

      transcriptLogger.forceFlush();
      jest.clearAllMocks();

      // Advancing timer should not cause another flush
      jest.advanceTimersByTime(5000);
      expect(mockMemoryStore.appendTranscript).not.toHaveBeenCalled();
    });

    test('multiple flushes within interval consolidate', () => {
      transcriptLogger.logInput('1', 'A');
      jest.advanceTimersByTime(2000);
      transcriptLogger.logInput('1', 'B');
      jest.advanceTimersByTime(2000);
      transcriptLogger.logInput('1', 'C');
      jest.advanceTimersByTime(2000);

      // First timer should have fired at 5s, flushing A and B
      // C was added at 4s, so it's in the next batch
      expect(mockMemoryStore.appendTranscript).toHaveBeenCalled();
    });

    test('adds timestamp to each entry', () => {
      const before = new Date().toISOString();
      transcriptLogger.logInput('1', 'Test');
      transcriptLogger.forceFlush();

      const call = mockMemoryStore.appendTranscript.mock.calls[0];
      expect(call[1].timestamp).toBeDefined();
      expect(new Date(call[1].timestamp)).toBeInstanceOf(Date);
    });
  });

  describe('Session Management', () => {
    test('startSession logs system event', () => {
      transcriptLogger.startSession('1', { sessionId: 'sess-1' });
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          type: 'system',
          content: 'Session started',
          metadata: expect.objectContaining({
            sessionStart: true,
            sessionId: 'sess-1'
          })
        })
      );
    });

    test('endSession logs and forces flush', () => {
      transcriptLogger.logInput('1', 'Some work');
      transcriptLogger.endSession('1', { duration: 3600 });

      // Should have flushed both the input and the session end
      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'architect',
        expect.objectContaining({
          content: 'Session ended',
          metadata: expect.objectContaining({
            sessionEnd: true,
            duration: 3600
          })
        })
      );
    });
  });

  describe('Query Functions', () => {
    test('getRecentTranscript retrieves from store', () => {
      mockMemoryStore.readTranscript.mockReturnValue([
        { type: 'input', content: 'test' }
      ]);

      const result = transcriptLogger.getRecentTranscript('1', 100);

      expect(mockMemoryStore.readTranscript).toHaveBeenCalledWith('architect', { limit: 100 });
      expect(result).toHaveLength(1);
    });

    test('getRecentTranscript uses default limit', () => {
      transcriptLogger.getRecentTranscript('1');

      expect(mockMemoryStore.readTranscript).toHaveBeenCalledWith('architect', { limit: 50 });
    });

    test('getTranscriptStats retrieves from store', () => {
      mockMemoryStore.getTranscriptStats.mockReturnValue({
        totalEntries: 150,
        inputCount: 75,
        outputCount: 75
      });

      const result = transcriptLogger.getTranscriptStats('1');

      expect(mockMemoryStore.getTranscriptStats).toHaveBeenCalledWith('architect');
      expect(result.totalEntries).toBe(150);
    });
  });

  describe('Edge Cases', () => {
    test('handles unknown pane ID', () => {
      transcriptLogger.logInput('99', 'Unknown pane');
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith(
        'pane-99',
        expect.objectContaining({
          paneId: '99'
        })
      );
    });

    test('throws on null content (contentLength access)', () => {
      // Note: The code accesses content.length before truncating,
      // so null content causes an error. This is a known limitation.
      expect(() => {
        transcriptLogger.logInput('1', null);
      }).toThrow();
    });

    test('logs across multiple roles correctly', () => {
      transcriptLogger.logInput('1', 'Architect input');
      transcriptLogger.logInput('2', 'Orchestrator input');
      transcriptLogger.logInput('3', 'Implementer input');
      transcriptLogger.forceFlush();

      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith('architect', expect.anything());
      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith('orchestrator', expect.anything());
      expect(mockMemoryStore.appendTranscript).toHaveBeenCalledWith('implementer-a', expect.anything());
    });
  });
});
