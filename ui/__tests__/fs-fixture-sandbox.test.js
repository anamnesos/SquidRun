'use strict';

/** The fixture sandbox keeps unix-absolute fixture roots off the real drive. */

const fs = require('fs');
const path = require('path');

const {
  FORBIDDEN_ROOTS,
  SANDBOX_ROOT,
  ORIGINALS,
  redirectFixturePath,
} = require('./fs-fixture-sandbox');

describe('fs fixture sandbox', () => {
  test('redirects fixture-root paths into the sandbox and leaves real paths alone', () => {
    const redirected = redirectFixturePath('/test/workspace/runtime/probe.json');
    expect(redirected.startsWith(SANDBOX_ROOT)).toBe(true);
    expect(redirected.endsWith(path.join('test', 'workspace', 'runtime', 'probe.json'))).toBe(true);

    expect(redirectFixturePath(__filename)).toBe(__filename);
    expect(redirectFixturePath('')).toBe('');
    expect(redirectFixturePath(null)).toBe(null);
  });

  test('write/read round-trip works through the redirect without touching the drive root', () => {
    const fixturePath = '/test/workspace/runtime/sandbox-roundtrip.json';
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, '{"ok":true}', 'utf8');

    expect(fs.existsSync(fixturePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(fixturePath, 'utf8'))).toEqual({ ok: true });

    // The REAL drive-root location must not exist (checked with pre-patch fs).
    const realTestRoot = FORBIDDEN_ROOTS.find((root) => root.endsWith(`${path.sep}test`));
    expect(ORIGINALS.existsSync(path.join(realTestRoot, 'workspace', 'runtime', 'sandbox-roundtrip.json'))).toBe(false);

    fs.rmSync(fixturePath);
    expect(fs.existsSync(fixturePath)).toBe(false);
  });

  test('two-path operations redirect both ends', () => {
    const src = '/custom/dir/source.txt';
    const dest = '/storage/project/dest.txt';
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(src, 'payload', 'utf8');
    fs.copyFileSync(src, dest);

    expect(fs.readFileSync(dest, 'utf8')).toBe('payload');
    for (const root of FORBIDDEN_ROOTS) {
      expect(ORIGINALS.existsSync(root)).toBe(false);
    }
  });

  test('realpathSync keeps its native static after patching', () => {
    expect(typeof fs.realpathSync.native).toBe('function');
  });
});
