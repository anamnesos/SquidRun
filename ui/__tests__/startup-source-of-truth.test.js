const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UI_ROOT = path.resolve(__dirname, '..');

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8');
}

describe('Startup Source Of Truth', () => {
  test('startup docs point to ROLES and avoid legacy startup files', () => {
    const startupDocs = [
      'AGENTS.md',
      path.join('docs', 'models', 'base-instructions.md'),
    ];
    const forbidden = [
      'workspace/shared_context.md',
      'session-handoff.json',
      'SPRINT.md',
      'MAP.md',
      'CLEANUP.md',
    ];

    for (const relPath of startupDocs) {
      const content = readRepoFile(relPath);
      expect(content).toContain('ROLES.md');
      for (const token of forbidden) {
        expect(content).not.toContain(token);
      }
    }
  });

  test('startup auto-injection manager has been removed', () => {
    const removedPath = path.join(UI_ROOT, 'modules', 'main', 'context-injection.js');
    expect(fs.existsSync(removedPath)).toBe(false);
  });

  test('runtime refresh/watchdog paths do not depend on shared_context startup flow', () => {
    const daemonHandlers = fs.readFileSync(path.join(UI_ROOT, 'modules', 'daemon-handlers.js'), 'utf-8');
    const terminalDaemon = fs.readFileSync(path.join(UI_ROOT, 'terminal-daemon.js'), 'utf-8');

    expect(daemonHandlers).not.toContain('/read workspace/shared_context.md');
    expect(terminalDaemon).not.toContain('shared_context.md');
  });

  test('legacy docs in docs/roles are explicit archive stubs', () => {
    const roleDocs = [
      path.join('docs', 'roles', 'ARCH.md'),
      path.join('docs', 'roles', 'BUILDER.md'),
      path.join('docs', 'roles', 'ORACLE.md'),
    ];

    for (const relPath of roleDocs) {
      const content = readRepoFile(relPath).toLowerCase();
      expect(content).toContain('archived');
      expect(content).toContain('roles.md');
    }
  });
});
