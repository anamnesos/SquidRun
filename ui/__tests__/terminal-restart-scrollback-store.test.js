const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildRestartScrollbackSnapshot,
  hydrateTerminalFromRestartSnapshot,
  loadRestartScrollbackSnapshot,
  mergeScrollbackWithRestartSnapshot,
  saveRestartScrollbackSnapshot,
} = require('../modules/terminal-restart-scrollback-store');

describe('terminal restart scrollback store', () => {
  test('builds a per-pane snapshot from terminal scrollback', () => {
    const snapshot = buildRestartScrollbackSnapshot([
      {
        paneId: '2',
        cwd: 'D:/projects/squidrun',
        alive: true,
        mode: 'pty',
        scrollback: 'builder mid-work tail',
        lastActivity: 123,
      },
    ], { savedAt: '2026-06-09T00:00:00.000Z' });

    expect(snapshot.panes['2']).toEqual(expect.objectContaining({
      paneId: '2',
      cwd: 'D:/projects/squidrun',
      scrollback: 'builder mid-work tail',
      scrollbackChars: 21,
      lastActivity: 123,
    }));
  });

  test('preserves previous pane scrollback when a fresh terminal has no body yet', () => {
    const previous = buildRestartScrollbackSnapshot([
      { paneId: '2', scrollback: 'old visible work' },
    ]);

    const next = buildRestartScrollbackSnapshot([
      { paneId: '2', scrollback: '' },
    ], { previousSnapshot: previous });

    expect(next.panes['2'].scrollback).toBe('old visible work');
  });

  test('hydrates a respawned terminal by prepending saved scrollback before fresh output', () => {
    const snapshot = buildRestartScrollbackSnapshot([
      { paneId: '2', scrollback: 'before restart mid-work tail\n' },
    ]);
    const terminal = {
      paneId: '2',
      scrollback: 'fresh prompt after restart',
      scrollbackMaxSize: 50000,
    };

    hydrateTerminalFromRestartSnapshot(terminal, snapshot);

    expect(terminal.scrollback).toContain('before restart mid-work tail');
    expect(terminal.scrollback).toContain('fresh prompt after restart');
    expect(terminal.restartScrollbackHydrated).toBe(true);
  });

  test('does not duplicate preserved scrollback already present in current body', () => {
    const merged = mergeScrollbackWithRestartSnapshot(
      'old tail\nfresh output',
      { scrollback: 'old tail\n' }
    );

    expect(merged).toBe('old tail\nfresh output');
  });

  test('saves and loads snapshots from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-scrollback-'));
    const filePath = path.join(dir, 'terminal-restart-scrollback.json');

    saveRestartScrollbackSnapshot(filePath, [
      { paneId: 'trustquote-app', cwd: 'D:/projects/TrustQuote', scrollback: 'app body' },
    ]);

    const loaded = loadRestartScrollbackSnapshot(filePath);
    expect(loaded.panes['trustquote-app']).toEqual(expect.objectContaining({
      cwd: 'D:/projects/TrustQuote',
      scrollback: 'app body',
    }));
  });
});
