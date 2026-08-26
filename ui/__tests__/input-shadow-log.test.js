const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  INPUT_SHADOW_RECOVERY_CONSUMER,
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
      expect(result.rotation.consumer).toBe(INPUT_SHADOW_RECOVERY_CONSUMER);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('rotates with a multi-session recovery consumer marker', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'input-shadow-log-rotate-'));
    const logPath = path.join(tempRoot, 'runtime', 'user-input-shadow.jsonl');

    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'x'.repeat(64), 'utf8');

      const result = appendInputShadowLog(
        { paneId: '2', source: 'pty-write', text: 'after rotation', byteLen: 14 },
        { logPath, rotateMaxBytes: 32, rotateMaxFiles: 2 }
      );

      expect(result.ok).toBe(true);
      expect(result.rotation).toEqual(expect.objectContaining({
        rotated: true,
        consumer: INPUT_SHADOW_RECOVERY_CONSUMER,
      }));
      expect(fs.existsSync(`${logPath}.1`)).toBe(true);
      const entry = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
      expect(entry.text).toBe('after rotation');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
