'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendJsonlWithRotation,
  rotateFileIfNeeded,
} = require('../modules/runtime-log-rotation');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-log-rotation-'));
}

function cleanupTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('runtime log rotation', () => {
  test('rotates over-cap files and deletes the oldest retained segment', () => {
    const tempDir = makeTempDir();
    const logPath = path.join(tempDir, 'runtime', 'large.jsonl');

    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'active-file', 'utf8');
      fs.writeFileSync(`${logPath}.1`, 'first-old', 'utf8');
      fs.writeFileSync(`${logPath}.2`, 'second-old', 'utf8');

      const result = rotateFileIfNeeded(logPath, 'incoming-line', {
        maxBytes: 5,
        maxFiles: 2,
        consumer: 'test-consumer',
      });

      expect(result).toEqual(expect.objectContaining({
        rotated: true,
        deletedCount: 1,
        reason: 'rotated_oldest_segment_deleted_if_present',
        consumer: 'test-consumer',
      }));
      expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe('active-file');
      expect(fs.readFileSync(`${logPath}.2`, 'utf8')).toBe('first-old');
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  test('appendJsonlWithRotation writes a new active file after rotation', () => {
    const tempDir = makeTempDir();
    const logPath = path.join(tempDir, 'runtime', 'events.jsonl');

    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'x'.repeat(20), 'utf8');

      const result = appendJsonlWithRotation(logPath, { event: 'after-rotation' }, {
        maxBytes: 10,
        maxFiles: 2,
      });

      expect(result.rotation.rotated).toBe(true);
      expect(JSON.parse(fs.readFileSync(logPath, 'utf8').trim())).toEqual({ event: 'after-rotation' });
      expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe('x'.repeat(20));
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
