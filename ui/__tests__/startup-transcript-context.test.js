'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDatabaseSync } = require('../modules/sqlite-compat');
const { buildStartupTranscriptContext } = require('../modules/startup-transcript-context');

const DatabaseSync = getDatabaseSync();

describe('startup-transcript-context', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-startup-transcript-'));
    fs.mkdirSync(path.join(tempRoot, 'workspace', 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.squidrun', 'runtime'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('builds compact main-window startup context from recent comms and transcript index', () => {
    const casePath = path.join(tempRoot, 'workspace', 'knowledge', 'case-operations.md');
    const indexPath = path.join(tempRoot, '.squidrun', 'runtime', 'transcript-index.jsonl');
    const metaPath = path.join(tempRoot, '.squidrun', 'runtime', 'transcript-index-meta.json');
    const dbPath = path.join(tempRoot, '.squidrun', 'runtime', 'evidence-ledger.db');

    fs.writeFileSync(casePath, [
      '### Case 3: ExampleShop (ExampleShop) — Counterfeit Goods',
      '| 11 | Monday 3/30 evidence call with team lead | Scoped action | ⚠️ WAITING |',
    ].join('\n'));

    fs.writeFileSync(indexPath, [
      JSON.stringify({
        id: 'rec-1',
        sourceCitation: 'C:\\archive\\session.jsonl:10',
        speaker: 'user',
        timestamp: '2026-03-28T22:55:34.659Z',
        text: 'the user said ExampleShop first mattered because of his wife\'s brother and Example Person.',
        entities: ['ExampleShop', 'Example Person'],
        tags: ['qeline_case'],
      }),
      JSON.stringify({
        id: 'rec-2',
        sourceCitation: 'C:\\archive\\session.jsonl:20',
        speaker: 'assistant',
        timestamp: '2026-03-28T21:00:00.000Z',
        text: 'The session-start parser recovery is urgent and should be checked first.',
        entities: ['session-start parser'],
        tags: ['decision'],
      }),
    ].join('\n'));
    fs.writeFileSync(metaPath, JSON.stringify({
      builtAt: new Date().toISOString(),
      transcriptFileCount: 2,
      recordCount: 2,
    }, null, 2));

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE comms_journal (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_role TEXT,
        target_role TEXT,
        channel TEXT,
        raw_body TEXT,
        session_id TEXT,
        metadata_json TEXT
      );
    `);
    db.prepare(`
      INSERT INTO comms_journal (sender_role, target_role, channel, raw_body, session_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('architect', 'builder', 'ws', 'Parser shipped and verified. Now wire it into session-start recovery.', 'app-session-1', '{}');
    db.close();

    const result = buildStartupTranscriptContext({
      projectRoot: tempRoot,
      indexPath,
      metaPath,
      evidenceLedgerDbPath: dbPath,
      windowKey: 'main',
      maxResults: 4,
    });

    expect(result.ok).toBe(true);
    expect(result.activeItems.join('\n')).not.toContain('ExampleShop');
    expect(result.context).toContain('Recovered Transcript Context');
    expect(result.context).toContain('session-start parser recovery');
    expect(result.context).toContain('C:\\archive\\session.jsonl:20');
  });

  test('defaults missing windowKey to main so Scoped case items are not force-loaded into main startup context', () => {
    const casePath = path.join(tempRoot, 'workspace', 'knowledge', 'case-operations.md');
    const indexPath = path.join(tempRoot, '.squidrun', 'runtime', 'transcript-index.jsonl');
    const metaPath = path.join(tempRoot, '.squidrun', 'runtime', 'transcript-index-meta.json');
    const dbPath = path.join(tempRoot, '.squidrun', 'runtime', 'evidence-ledger.db');

    fs.writeFileSync(casePath, [
      '### Case 3: ExampleShop (ExampleShop) — Counterfeit Goods',
      '| 11 | Monday 3/30 evidence call with team lead | Scoped action | ⚠️ WAITING |',
    ].join('\n'));
    fs.writeFileSync(indexPath, '');
    fs.writeFileSync(metaPath, JSON.stringify({
      builtAt: new Date().toISOString(),
      transcriptFileCount: 0,
      recordCount: 0,
    }, null, 2));

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE comms_journal (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_role TEXT,
        target_role TEXT,
        channel TEXT,
        raw_body TEXT,
        session_id TEXT,
        metadata_json TEXT
      );
    `);
    db.prepare(`
      INSERT INTO comms_journal (sender_role, target_role, channel, raw_body, session_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'user',
      'architect',
      'telegram',
      'Scoped case update',
      'app-session-275:scoped',
      JSON.stringify({ chatId: '2222222222', windowKey: 'scoped' })
    );
    db.close();

    const result = buildStartupTranscriptContext({
      projectRoot: tempRoot,
      indexPath,
      metaPath,
      evidenceLedgerDbPath: dbPath,
    });

    expect(result.ok).toBe(true);
    expect(result.activeItems.join('\n')).not.toContain('ExampleShop');
    expect(result.activeItems.join('\n')).not.toContain('Scoped case update');
  });

  test('scopes recent comms to the requested side window during startup recovery', () => {
    const casePath = path.join(tempRoot, 'workspace', 'knowledge', 'case-operations.md');
    const indexPath = path.join(tempRoot, '.squidrun', 'runtime', 'transcript-index.jsonl');
    const metaPath = path.join(tempRoot, '.squidrun', 'runtime', 'transcript-index-meta.json');
    const dbPath = path.join(tempRoot, '.squidrun', 'runtime', 'evidence-ledger.db');

    fs.writeFileSync(casePath, [
      '### Case 3: ExampleShop (ExampleShop) — Counterfeit Goods',
      '| 11 | Monday 3/30 evidence call with team lead | Scoped action | ⚠️ WAITING |',
    ].join('\n'));
    fs.writeFileSync(indexPath, '');
    fs.writeFileSync(metaPath, JSON.stringify({
      builtAt: new Date().toISOString(),
      transcriptFileCount: 0,
      recordCount: 0,
    }, null, 2));

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE comms_journal (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_role TEXT,
        target_role TEXT,
        channel TEXT,
        raw_body TEXT,
        session_id TEXT,
        metadata_json TEXT
      );
    `);
    const insert = db.prepare(`
      INSERT INTO comms_journal (sender_role, target_role, channel, raw_body, session_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      'user',
      'architect',
      'telegram',
      'Main chat should stay main-only',
      'app-session-275',
      JSON.stringify({ chatId: '5613428850', windowKey: 'main' })
    );
    insert.run(
      'user',
      'architect',
      'telegram',
      'Scoped chat should appear in side startup only',
      'app-session-275:scoped',
      JSON.stringify({ chatId: '2222222222', windowKey: 'scoped' })
    );
    db.close();

    const result = buildStartupTranscriptContext({
      projectRoot: tempRoot,
      indexPath,
      metaPath,
      evidenceLedgerDbPath: dbPath,
      windowKey: 'scoped',
    });

    expect(result.ok).toBe(true);
    expect(result.activeItems.join('\n')).toContain('ExampleShop');
    expect(result.activeItems.join('\n')).toContain('Scoped chat should appear in side startup only');
    expect(result.activeItems.join('\n')).not.toContain('Main chat should stay main-only');
  });
});
