const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  materializeSessionHandoff,
  buildSessionHandoffMarkdown,
  removeLegacyPaneHandoffFiles,
} = require('../modules/main/auto-handoff-materializer');

describe('auto-handoff-materializer', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-auto-handoff-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('buildSessionHandoffMarkdown is deterministic and includes explicit tags + trace ids', () => {
    const rows = [
      {
        messageId: 'm1',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #1): DECISION: Use single handoff file',
        brokeredAtMs: 1000,
        metadata: { traceId: 'trc-1' },
      },
      {
        messageId: 'm2',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'failed',
        ackStatus: 'failed',
        errorCode: 'delivery_timeout',
        rawBody: '(BUILDER #1): Attempted delivery',
        brokeredAtMs: 1500,
        metadata: { traceId: 'trc-2' },
      },
    ];

    const first = buildSessionHandoffMarkdown(rows, { sessionId: 's1', nowMs: 2000 });
    const second = buildSessionHandoffMarkdown(rows, { sessionId: 's1', nowMs: 2000 });

    expect(first).toBe(second);
    expect(first).toContain('Session Handoff Index (auto-generated, deterministic)');
    expect(first).toContain('DECISION');
    expect(first).toContain('trc-1');
    expect(first).toContain('delivery_timeout');
  });

  test('materializeSessionHandoff writes once and skips rewrite when unchanged', () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const rows = [
      {
        messageId: 'm1',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #1): TASK: Implement phase 3',
        brokeredAtMs: 1000,
        metadata: { traceId: 'trc-1' },
      },
    ];

    const first = materializeSessionHandoff({
      rows,
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-a',
      nowMs: 5000,
    });
    const second = materializeSessionHandoff({
      rows,
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-a',
      nowMs: 5000,
    });

    expect(first.ok).toBe(true);
    expect(first.written).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.written).toBe(false);
    expect(fs.existsSync(outputPath)).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf8');
    expect(content).toContain('TASK');
  });

  test('removeLegacyPaneHandoffFiles deletes legacy files', () => {
    const handoffsDir = path.join(tempDir, 'handoffs');
    fs.mkdirSync(handoffsDir, { recursive: true });
    fs.writeFileSync(path.join(handoffsDir, '1.md'), 'a', 'utf8');
    fs.writeFileSync(path.join(handoffsDir, '2.md'), 'b', 'utf8');
    fs.writeFileSync(path.join(handoffsDir, '5.md'), 'c', 'utf8');

    const result = removeLegacyPaneHandoffFiles({
      roots: [handoffsDir],
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toHaveLength(3);
    expect(fs.existsSync(path.join(handoffsDir, '1.md'))).toBe(false);
    expect(fs.existsSync(path.join(handoffsDir, '2.md'))).toBe(false);
    expect(fs.existsSync(path.join(handoffsDir, '5.md'))).toBe(false);
  });
});
