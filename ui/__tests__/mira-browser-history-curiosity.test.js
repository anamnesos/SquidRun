'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIRA_BROWSER_HISTORY_CURIOSITY_SCHEMA,
  chromeTimeToIso,
  readMiraBrowserHistoryCuriosity,
} = require('../modules/mira-browser-history-curiosity');
const { openDatabase } = require('../modules/sqlite-compat');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-browser-history-'));
}

function chromeTime(iso) {
  return (Date.parse(iso) - Date.UTC(1601, 0, 1)) * 1000;
}

function seedHistoryDb(filePath) {
  const db = openDatabase(filePath);
  try {
    db.exec(`
      CREATE TABLE urls (
        id INTEGER PRIMARY KEY,
        url TEXT,
        title TEXT,
        visit_count INTEGER,
        typed_count INTEGER,
        last_visit_time INTEGER
      );
    `);
    const insert = db.prepare(`
      INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run('https://example.com/search?q=secret-token#private', 'Example search', 4, 1, chromeTime('2026-05-12T10:00:00.000Z'));
    insert.run('https://docs.example.com/guide?session=abc', 'Docs guide', 2, 0, chromeTime('2026-05-12T09:00:00.000Z'));
    insert.run('notaurl', 'Broken row', 1, 0, chromeTime('2026-05-12T08:00:00.000Z'));
  } finally {
    db.close();
  }
}

describe('Mira browser history curiosity', () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  test('reads compact browser metadata from a temp-copied Chromium History DB', () => {
    root = tempDir();
    const historyPath = path.join(root, 'History');
    seedHistoryDb(historyPath);

    const result = readMiraBrowserHistoryCuriosity({
      historyPaths: [{ browser: 'chrome', profile: 'Default', path: historyPath }],
      limit: 5,
    }, { tempRoot: root });

    expect(result.schema).toBe(MIRA_BROWSER_HISTORY_CURIOSITY_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('browser_history_read_only');
    expect(result.browser).toBe('chrome');
    expect(result.profile).toBe('Default');
    expect(result.result_count).toBe(2);
    expect(result.top_hosts).toEqual(expect.arrayContaining([
      { host: 'docs.example.com', count: 1 },
      { host: 'example.com', count: 1 },
    ]));
    expect(result.results[0]).toEqual(expect.objectContaining({
      host: 'example.com',
      title: 'Example search',
      safe_url: 'https://example.com/search',
      visit_count: 4,
      typed_count: 1,
      last_visit_at: '2026-05-12T10:00:00.000Z',
    }));
    expect(JSON.stringify(result)).not.toMatch(/secret-token|session=abc|#private|\?/);
    expect(result.consequence_controls).toEqual(expect.objectContaining({
      internal_only: true,
      read_only: true,
      browser_mutation_performed: false,
      cookies_read: false,
      auth_store_read: false,
      external_send_performed: false,
    }));
  });

  test('reports unavailable when no local history DB exists', () => {
    root = tempDir();
    const missingPath = path.join(root, 'MissingHistory');

    const result = readMiraBrowserHistoryCuriosity({
      historyPaths: [{ browser: 'chrome', profile: 'Default', path: missingPath }],
    });

    expect(result.ok).toBe(false);
    expect(result.decision).toBe('unavailable_in_this_runtime');
    expect(result.reason).toBe('browser_history_missing');
    expect(result.checked_profiles).toEqual([{
      browser: 'chrome',
      profile: 'Default',
      exists: false,
    }]);
    expect(fs.existsSync(missingPath)).toBe(false);
    expect(result.no_mutation_performed).toBe(true);
  });

  test('returns a clean unavailable state when the database is unreadable', () => {
    root = tempDir();
    const historyPath = path.join(root, 'History');
    fs.writeFileSync(historyPath, 'not sqlite', 'utf8');

    const result = readMiraBrowserHistoryCuriosity({
      historyPaths: [{ browser: 'chrome', profile: 'Corrupt', path: historyPath }],
    }, { tempRoot: root });

    expect(result.ok).toBe(false);
    expect(result.decision).toBe('unavailable_in_this_runtime');
    expect(result.reason).toBe('browser_history_read_failed');
    expect(result.browser).toBe('chrome');
    expect(result.profile).toBe('Corrupt');
    expect(result.no_mutation_performed).toBe(true);
  });

  test('converts Chromium microsecond timestamps to ISO strings', () => {
    expect(chromeTimeToIso(chromeTime('2026-05-12T10:00:00.000Z'))).toBe('2026-05-12T10:00:00.000Z');
    expect(chromeTimeToIso(0)).toBeNull();
  });
});
