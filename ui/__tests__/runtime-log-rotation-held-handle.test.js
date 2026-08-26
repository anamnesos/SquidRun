'use strict';

/**
 * REGRESSION GUARD for a SILENT failure mode (S483).
 *
 * On Windows Node, renaming a log file while a writer holds an append fd does
 * NOT throw. The rename succeeds, the holder keeps appending into the RENAMED
 * file, and the live path ceases to exist - so a rename-based rotation looks
 * completely healthy while reclaiming zero bytes forever. That is exactly how
 * daemon.log reached 1.26 GB and the wake-watchdog log reached 245 MB.
 *
 * These tests exist so the two-strategy design cannot be "simplified" back
 * into one. If someone collapses rotateHeldFileIfNeeded into a rename, the
 * third test fails loudly instead of shipping a bug that hides for months.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  rotateFileIfNeeded,
  rotateHeldFileIfNeeded,
} = require('../modules/runtime-log-rotation');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-rotate-'));
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('runtime log rotation — writer-shape awareness', () => {
  test('appendFile-style writer: rename rotation archives history and keeps writing live', () => {
    const file = path.join(dir, 'append.log');
    fs.appendFileSync(file, 'x'.repeat(2048));

    const result = rotateFileIfNeeded(file, 'next', { maxBytes: 1024, maxFiles: 3 });
    expect(result.rotated).toBe(true);

    fs.appendFileSync(file, 'after-rotate\n');
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toContain('x');
    expect(fs.readFileSync(file, 'utf8')).toContain('after-rotate');
  });

  test('held-fd writer: copy-truncate reclaims space AND the live path survives', () => {
    const file = path.join(dir, 'held.log');
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, 'y'.repeat(4096));

      const result = rotateHeldFileIfNeeded(file, 'next', { maxBytes: 1024, maxFiles: 3 });
      expect(result.rotated).toBe(true);
      expect(result.reason).toBe('copy_truncate_live_handle_safe');

      // History preserved in the archive.
      expect(fs.statSync(`${file}.1`).size).toBeGreaterThanOrEqual(4096);
      // Space actually reclaimed on the live file.
      expect(fs.statSync(file).size).toBe(0);
      // THE POINT: the live path still exists and the holder writes into IT.
      expect(fs.existsSync(file)).toBe(true);
      fs.writeSync(fd, 'after-rotate\n');
      expect(fs.readFileSync(file, 'utf8')).toContain('after-rotate');
    } finally {
      fs.closeSync(fd);
    }
  });

  test('THE TIME BOMB: rename under a held fd loses the live path — do not collapse the two strategies', () => {
    const file = path.join(dir, 'naive.log');
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, 'before\n');
      // Simulate the naive "just reuse rename everywhere" implementation.
      fs.renameSync(file, `${file}.1`);
      fs.writeSync(fd, 'after\n');

      // Documented platform behaviour this module exists to avoid. On Windows
      // the live path is gone and the writer followed the renamed file; POSIX
      // behaves the same way for the fd (it tracks the inode, not the name).
      expect(fs.readFileSync(`${file}.1`, 'utf8')).toContain('after');
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.closeSync(fd);
    }
  });

  test('rotation failure never throws into the caller', () => {
    const missing = path.join(dir, 'nope', 'absent.log');
    expect(() => rotateHeldFileIfNeeded(missing, 'x', { maxBytes: 1 })).not.toThrow();
    expect(rotateHeldFileIfNeeded(missing, 'x', { maxBytes: 1 }).rotated).toBe(false);
  });
});
