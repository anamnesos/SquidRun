const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const { TeamMemoryStore } = require('../modules/team-memory/store');
const {
  extractTaggedClaimsFromComms,
  extractTaggedItems,
} = require('../modules/team-memory/comms-tagged-extractor');

function hasSqliteDriver() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') return true;
  } catch {
    // Continue to next fallback.
  }
  try {
    // eslint-disable-next-line global-require
    require('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

const maybeDescribe = hasSqliteDriver() ? describe : describe.skip;

maybeDescribe('team-memory comms tagged extractor', () => {
  let tempDir;
  let evidenceStore;
  let memoryStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-tagged-extract-'));
    evidenceStore = new EvidenceLedgerStore({
      dbPath: path.join(tempDir, 'evidence-ledger.db'),
      enabled: true,
    });
    memoryStore = new TeamMemoryStore({
      dbPath: path.join(tempDir, 'team-memory.sqlite'),
      enabled: true,
    });
    expect(evidenceStore.init().ok).toBe(true);
    expect(memoryStore.init().ok).toBe(true);
  });

  afterEach(() => {
    try { evidenceStore?.close(); } catch {}
    try { memoryStore?.close(); } catch {}
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('extractTaggedItems parses allowed tags only', () => {
    const tagged = extractTaggedItems([
      '(ARCHITECT #1): DECISION: Adopt single handoff',
      '(ARCHITECT #2): TASK: Implement startup brief',
      '(ORACLE #1): FINDING: Telegram ingress missing',
      '(BUILDER #3): BLOCKER: delivery ack timeout',
      '(BUILDER #4): NOTE: not included',
    ].join('\n'));

    expect(tagged).toEqual([
      { tag: 'DECISION', detail: 'Adopt single handoff' },
      { tag: 'TASK', detail: 'Implement startup brief' },
      { tag: 'FINDING', detail: 'Telegram ingress missing' },
      { tag: 'BLOCKER', detail: 'delivery ack timeout' },
    ]);
  });

  test('extracts tagged claims from comms_journal and is idempotent', () => {
    const nowMs = 2000;
    evidenceStore.upsertCommsJournal({
      messageId: 'msg-1',
      sessionId: 's_1',
      senderRole: 'architect',
      targetRole: 'builder',
      channel: 'ws',
      direction: 'outbound',
      sentAtMs: 1000,
      brokeredAtMs: 1005,
      rawBody: '(ARCHITECT #1): DECISION: Move to session handoff\nTASK: Build startup brief',
      status: 'brokered',
      metadata: { traceId: 'trace-1' },
    }, { nowMs });
    evidenceStore.upsertCommsJournal({
      messageId: 'msg-2',
      sessionId: 's_1',
      senderRole: 'oracle',
      targetRole: 'architect',
      channel: 'ws',
      direction: 'outbound',
      sentAtMs: 1100,
      brokeredAtMs: 1110,
      rawBody: '(ORACLE #1): FINDING: hm-telegram bypasses hm-send',
      status: 'brokered',
      metadata: { traceId: 'trace-2' },
    }, { nowMs });

    const first = extractTaggedClaimsFromComms({
      teamDb: memoryStore.db,
      evidenceLedgerDbPath: evidenceStore.dbPath,
      sessionId: 's_1',
      limit: 100,
      nowMs: 3000,
    });
    expect(first.ok).toBe(true);
    expect(first.insertedClaims).toBe(3);
    expect(first.duplicateClaims).toBe(0);

    const second = extractTaggedClaimsFromComms({
      teamDb: memoryStore.db,
      evidenceLedgerDbPath: evidenceStore.dbPath,
      sessionId: 's_1',
      limit: 100,
      nowMs: 4000,
    });
    expect(second.ok).toBe(true);
    expect(second.insertedClaims).toBe(0);
    expect(second.duplicateClaims).toBeGreaterThanOrEqual(3);

    const rows = memoryStore.db.prepare(`
      SELECT claim_type, confidence, statement
      FROM claims
      ORDER BY statement ASC
    `).all();
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.claim_type === 'decision')).toBe(true);
    expect(rows.some((row) => row.claim_type === 'hypothesis')).toBe(true);
    expect(rows.some((row) => row.claim_type === 'fact')).toBe(true);
    expect(rows.every((row) => Number(row.confidence) > 0 && Number(row.confidence) <= 1)).toBe(true);
  });
});
