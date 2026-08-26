'use strict';

const {
  isNativeArtifact,
  parseArgs,
  runCli,
  serializeError,
} = require('../scripts/build-1b-native-probe');

describe('Build 1B packaged native probe contract', () => {
  test('parses explicit commit provenance and receipt path', () => {
    expect(parseArgs([
      '--expect-commit', '34b29f79',
      '--output', 'D:\\qa\\native-receipt.json',
      '--resources-path', 'D:\\qa\\win-unpacked\\resources',
      '--timeout-ms', '20000',
    ])).toEqual({
      expectCommit: '34b29f79',
      output: 'D:\\qa\\native-receipt.json',
      resourcesPath: 'D:\\qa\\win-unpacked\\resources',
      timeoutMs: 20000,
    });
  });

  test.each([
    ['better_sqlite3.node', true],
    ['node-pty/prebuilds/win32-x64/pty.node', true],
    ['sqlite-vec-windows-x64/vec0.dll', true],
    ['sqlite-vec-windows-x64/README.md', false],
    ['ordinary.dll', false],
  ])('classifies native artifact %s', (filePath, expected) => {
    expect(isNativeArtifact(filePath)).toBe(expected);
  });

  test('serializes exact native load failures for receipts', () => {
    const error = new Error('native ABI mismatch');
    expect(serializeError(error)).toEqual(expect.objectContaining({
      name: 'Error',
      message: 'native ABI mismatch',
      stack: expect.stringContaining('native ABI mismatch'),
    }));
  });

  test('exports the eval-safe packaged CLI entry point', () => {
    expect(typeof runCli).toBe('function');
  });
});
