const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveElectronRebuildCli,
  runElectronRebuild,
} = require('../scripts/postinstall-electron-rebuild');

describe('postinstall electron rebuild launcher', () => {
  test('resolves the package CLI rather than a shell shim', () => {
    const cliPath = resolveElectronRebuildCli(path.resolve(__dirname, '..'));

    expect(fs.existsSync(cliPath)).toBe(true);
    expect(cliPath.replaceAll('\\', '/')).toMatch(/@electron\/rebuild\/lib\/cli\.js$/);
  });

  test('keeps Windows-style install paths with spaces out of shell parsing', () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'SquidRun install path with spaces ')
    );
    const nodePath = path.join(tempRoot, 'Program Files', 'node.exe');
    const rebuildCliPath = path.join(
      tempRoot,
      'node_modules',
      '@electron',
      'rebuild',
      'lib',
      'cli.js'
    );
    let invocation = null;

    try {
      const result = runElectronRebuild({
        projectRoot: tempRoot,
        nodePath,
        rebuildCliPath,
        spawnImpl(command, args, options) {
          invocation = { command, args, options };
          return { status: 0 };
        },
      });

      expect(result.status).toBe(0);
      expect(invocation).toEqual({
        command: nodePath,
        args: [rebuildCliPath, '-f', '-o', 'better-sqlite3'],
        options: {
          cwd: tempRoot,
          stdio: 'inherit',
          shell: false,
        },
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
