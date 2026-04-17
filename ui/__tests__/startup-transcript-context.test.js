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

  test('builds compact main-window startup context from trading knowledge, recent comms, and transcript index', () => {
    const tradingPath = path.join(tempRoot, 'workspace', 'knowledge', 'trading-operations.md');
    const casePath = path.join(tempRoot, 'workspace', 'knowledge', 'case-operations.md');
    const indexPath = path.join(tempRoot, '.squidrun', 'runtime', 'transcript-index.jsonl');
    const metaPath = path.join(tempRoot, '.squidrun', 'runtime', 'transcript-index-meta.json');
    const dbPath = path.join(tempRoot, '.squidrun', 'runtime', 'evidence-ledger.db');

    fs.writeFileSync(tradingPath, [
      '- **Open positions**: ETH SHORT -1.7113 @ $2,008.10',
      '- **Thesis**: dead cat bounce failed at $2,020',
    ].join('\n'));
    fs.writeFileSync(casePath, [
      '### Case 3: Qeline Shop (큐라인샵) — Counterfeit Goods',
      '| 11 | Monday 3/30 customs call with team lead | 은별 action | ⚠️ WAITING |',
    ].join('\n'));

    fs.writeFileSync(indexPath, [
      JSON.stringify({
        id: 'rec-1',
        sourceCitation: 'C:\\archive\\session.jsonl:10',
        speaker: 'user',
        timestamp: '2026-03-28T22:55:34.659Z',
        text: 'James said Qeline first mattered because of his wife\'s brother and Michelle Aviso.',
        entities: ['Qeline', 'Michelle Aviso'],
        tags: ['qeline_case'],
      }),
      JSON.stringify({
        id: 'rec-2',
        sourceCitation: 'C:\\archive\\session.jsonl:20',
        speaker: 'assistant',
        timestamp: '2026-03-28T21:00:00.000Z',
        text: 'The live Hyperliquid ETH short is real money and should be checked first.',
        entities: ['Hyperliquid', 'ETH'],
        tags: ['trading'],
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
        raw_body TEXT
      );
    `);
    db.prepare(`
      INSERT INTO comms_journal (sender_role, target_role, channel, raw_body)
      VALUES (?, ?, ?, ?)
    `).run('architect', 'builder', 'ws', 'Parser shipped and verified. Now wire it into session-start for Qeline and ETH short startup recovery.');
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
    expect(result.activeItems.join('\n')).toContain('Open positions');
    expect(result.activeItems.join('\n')).not.toContain('Qeline Shop');
    expect(result.context).toContain('Recovered Transcript Context');
    expect(result.context).toContain('Hyperliquid ETH short');
    expect(result.context).toContain('C:\\archive\\session.jsonl:20');
  });

  test('defaults missing windowKey to main so Eunbyeol case items are not force-loaded into main startup context', () => {
    const tradingPath = path.join(tempRoot, 'workspace', 'knowledge', 'trading-operations.md');
    const casePath = path.join(tempRoot, 'workspace', 'knowledge', 'case-operations.md');
    const indexPath = path.join(tempRoot, '.squidrun', 'runtime', 'transcript-index.jsonl');
    const metaPath = path.join(tempRoot, '.squidrun', 'runtime', 'transcript-index-meta.json');
    const dbPath = path.join(tempRoot, '.squidrun', 'runtime', 'evidence-ledger.db');

    fs.writeFileSync(tradingPath, '- **Open positions**: ETH SHORT -1.7113 @ $2,008.10');
    fs.writeFileSync(casePath, [
      '### Case 3: Qeline Shop (큐라인샵) — Counterfeit Goods',
      '| 11 | Monday 3/30 customs call with team lead | 은별 action | ⚠️ WAITING |',
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
      'Eunbyeol case update',
      'app-session-275:eunbyeol',
      JSON.stringify({ chatId: '8754356993', windowKey: 'eunbyeol' })
    );
    db.close();

    const result = buildStartupTranscriptContext({
      projectRoot: tempRoot,
      indexPath,
      metaPath,
      evidenceLedgerDbPath: dbPath,
    });

    expect(result.ok).toBe(true);
    expect(result.activeItems.join('\n')).toContain('Open positions');
    expect(result.activeItems.join('\n')).not.toContain('Qeline Shop');
    expect(result.activeItems.join('\n')).not.toContain('Eunbyeol case update');
  });
});
