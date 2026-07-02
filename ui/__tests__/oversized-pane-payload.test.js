'use strict';

/**
 * S464 telegram-loss fix: oversized inbound payloads must NEVER be silently
 * dropped - they materialize to a full-message file and deliver as a short
 * pointer that preserves the [Telegram from ...] reply-routing marker.
 */

const fs = require('fs');
const { materializeOversizedPanePayload } = require('../modules/main/squidrun-app');

describe('oversized pane payload materialization (the drop that ate James\'s words)', () => {
  const cleanup = [];
  afterAll(() => {
    for (const filePath of cleanup) {
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    }
  });

  test('telegram payload materializes with marker-preserving pointer', () => {
    const body = `[Telegram from James] ${'important words '.repeat(300)}`;
    const result = materializeOversizedPanePayload(body, {
      messageId: 'telegram-in-test-oversized-1',
      paneId: '1',
    });
    expect(result).not.toBeNull();
    cleanup.push(result.filePath);
    // Pointer must open with the Telegram marker so pane reply-routing
    // discipline still triggers on materialized user messages.
    expect(result.pointerText.startsWith('[Telegram from James]')).toBe(true);
    expect(result.pointerText).toContain('FULL MSG AT');
    expect(result.pointerText).toContain('HEAD:');
    expect(result.pointerText).toContain('TAIL:');
    // The pointer is always small enough for the direct-pty path.
    expect(Buffer.byteLength(result.pointerText, 'utf8')).toBeLessThan(2048);
    // The full body is durably on disk, byte-exact.
    const written = fs.readFileSync(result.filePath, 'utf8');
    expect(written).toContain('important words');
    expect(written).toContain(`bytesUtf8: ${Buffer.byteLength(body, 'utf8')}`);
  });

  test('non-telegram payload gets a plain pointer (no invented marker)', () => {
    const body = `plain oversized payload ${'x'.repeat(5000)}`;
    const result = materializeOversizedPanePayload(body, {
      messageId: 'sms-in-test-oversized-2',
      paneId: '1',
    });
    expect(result).not.toBeNull();
    cleanup.push(result.filePath);
    expect(result.pointerText.startsWith('(FULL MSG AT')).toBe(true);
    expect(result.pointerText).not.toContain('[Telegram');
  });

  test('unsafe messageId characters cannot escape the coord directory', () => {
    const result = materializeOversizedPanePayload('body '.repeat(100), {
      messageId: '../../evil\\path:id',
      paneId: '2',
    });
    expect(result).not.toBeNull();
    cleanup.push(result.filePath);
    expect(result.filePath).toContain('full-agent-messages');
    expect(result.filePath).not.toContain('..');
  });
});
