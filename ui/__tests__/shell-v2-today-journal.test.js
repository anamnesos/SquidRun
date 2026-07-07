const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FULL_AGENT_MESSAGE_REL_DIR,
  extractRowScopeKey,
  queryShellV2TodayJournal,
  readTodayFullMessage,
} = require('../modules/main/shell-v2-today-journal');

describe('shell-v2 Today journal helper', () => {
  test('derives scope from metadata/session and forces main rows only', () => {
    const rows = [
      {
        rowId: 4,
        messageId: 'hm-explicit-main',
        sessionId: 'app-session-476:shellv2qa',
        senderRole: 'system',
        targetRole: 'architect',
        channel: 'system',
        direction: 'outbound',
        brokeredAtMs: 1600,
        rawBody: '[DOORBELL] explicit main row',
        status: 'recorded',
        metadata: { scope: 'main', windowKey: 'main' },
      },
      {
        rowId: 3,
        messageId: 'hm-main',
        sessionId: 'app-session-476',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        brokeredAtMs: 1500,
        rawBody: '[TASK] main row',
        status: 'routed',
        metadata: {},
      },
      {
        rowId: 2,
        messageId: 'hm-side-metadata',
        sessionId: 'app-session-476',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        brokeredAtMs: 1400,
        rawBody: '[TASK] side row',
        status: 'routed',
        metadata: { windowKey: 'scoped' },
      },
      {
        rowId: 1,
        messageId: 'hm-side-session',
        sessionId: 'app-session-476:scoped',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        brokeredAtMs: 1300,
        rawBody: '[TASK] scoped session row',
        status: 'routed',
        metadata: {},
      },
    ];
    const queryEntries = jest.fn(() => rows);

    const result = queryShellV2TodayJournal({
      dayStartMs: 1000,
      dayEndMs: 2000,
      limit: 10,
    }, { queryEntries });

    expect(queryEntries).toHaveBeenCalledWith({
      sinceMs: 1000,
      untilMs: 1999,
      order: 'desc',
      limit: 20,
    });
    expect(result.ok).toBe(true);
    expect(result.scope).toBe('main');
    expect(result.rows.map((row) => row.messageId)).toEqual(['hm-explicit-main', 'hm-main']);
    expect(extractRowScopeKey(rows[0])).toBe('main');
    expect(extractRowScopeKey(rows[1])).toBe('main');
    expect(extractRowScopeKey(rows[2])).toBe('scoped');
    expect(extractRowScopeKey(rows[3])).toBe('scoped');
  });

  test('lazy full-message read is constrained to coord/full-agent-messages by message id', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-today-full-'));
    try {
      const fullDir = path.join(tempDir, FULL_AGENT_MESSAGE_REL_DIR);
      fs.mkdirSync(fullDir, { recursive: true });
      fs.writeFileSync(path.join(fullDir, 'hm-full.txt'), 'materialized payload', 'utf8');

      const result = readTodayFullMessage({ messageId: 'hm-full' }, { coordRoot: tempDir });

      expect(result.ok).toBe(true);
      expect(result.bytes).toBe(Buffer.byteLength('materialized payload', 'utf8'));
      expect(result.shaShort).toHaveLength(12);
      expect(result.content).toBe('materialized payload');
      expect(readTodayFullMessage({ messageId: '../hm-full' }, { coordRoot: tempDir })).toEqual({
        ok: false,
        reason: 'invalid_message_id',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
