const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendInputShadowLog,
  _internals,
} = require('../modules/input-shadow-log');

describe('input shadow log', () => {
  test('truncates text to the configured byte budget with an explicit marker', () => {
    const result = _internals.truncateTextForShadowLog('x'.repeat(200), 96);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('truncated for shadow log');
    expect(result.truncationMarker).toContain('fullByteLen=200');
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(96);
  });

  test('appendInputShadowLog never throws when the log path is unusable', () => {
    expect(() => {
      appendInputShadowLog(
        { paneId: '2', source: 'ipc-handler', text: 'hello', byteLen: 5 },
        { logPath: os.tmpdir(), maxTextBytes: 64 }
      );
    }).not.toThrow();
  });

  test('writes a JSONL row with correct byteLen and text', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'input-shadow-log-'));
    const logPath = path.join(tempRoot, 'runtime', 'user-input-shadow.jsonl');
    const text = 'known string Δ';

    try {
      const result = appendInputShadowLog(
        {
          paneId: '2',
          source: 'pty-write',
          byteLen: Buffer.byteLength(text, 'utf8'),
          text,
        },
        { logPath }
      );

      expect(result.ok).toBe(true);
      const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(entry).toMatchObject({
        paneId: '2',
        source: 'pty-write',
        byteLen: Buffer.byteLength(text, 'utf8'),
        textLen: text.length,
        text,
      });
      expect(entry.ts).toEqual(expect.any(String));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
