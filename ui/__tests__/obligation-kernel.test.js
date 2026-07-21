const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const {
  sanitizeObligationRead,
} = require('../modules/main/obligation-kernel');
const {
  validateNoticePayload,
  listNotices,
  resolvePaths,
  runObligationNaturalBeat,
} = require('../scripts/hm-next-session-notices');

describe('obligation kernel v0 O-series gates', () => {
  let tempDir;
  let dbPath;
  let spoolPath;
  let store;
  let clock;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-obligation-kernel-'));
    dbPath = path.join(tempDir, 'evidence-ledger.db');
    spoolPath = path.join(tempDir, '.squidrun', 'runtime', 'next-session-notices');
    store = new EvidenceLedgerStore({ dbPath, enabled: true });
    expect(store.init().ok).toBe(true);
    clock = 1000;
  });

  afterEach(() => {
    try { store?.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function upsert(entry, nowMs = ++clock) {
    return store.upsertCommsJournal({
      sessionId: 'app-session-480',
      channel: 'ws',
      direction: 'outbound',
      sentAtMs: nowMs,
      brokeredAtMs: nowMs,
      status: 'routed',
      attempt: 1,
      rawBody: '',
      ...entry,
    }, { nowMs });
  }

  function createExpectation(overrides = {}) {
    const result = upsert({
      messageId: `hm-expects-${clock}`,
      senderRole: 'builder',
      targetRole: 'oracle',
      rawBody: '(BUILDER): Gate reply requested.',
      metadata: {
        expects: { class: 'verdict', staleness_class: 'turn' },
      },
      ...overrides,
    });
    expect(result.ok).toBe(true);
    const obligationId = result.obligation.creation.obligationId;
    return { result, obligationId, obligation: store.getObligation(obligationId) };
  }

  test('O1 makes actor-fault fields inexpressible at write and strips-and-flags them at read', () => {
    const schemaBefore = store.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'obligations'
    `).get().sql.toLowerCase();
    expect(schemaBefore).not.toMatch(/who_failed|\bfault\b|\bblame\b|missed_by/);
    const writerSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'main', 'evidence-ledger-store.js'),
      'utf8'
    );
    expect(writerSource).not.toMatch(/['"](?:who_failed|fault|blame|missed_by)['"]\s*:/);

    const inbound = upsert({
      messageId: 'james-inbound-o1',
      senderRole: 'user',
      targetRole: 'architect',
      channel: 'telegram',
      direction: 'inbound',
      status: 'brokered',
      rawBody: 'Can you take this?',
    });
    expect(inbound.ok).toBe(true);
    const rejectedCreate = store.createObligation({
      fromRowId: inbound.rowId,
      creditor: 'james',
      obligor: 'builder',
      class: 'answer',
      staleness: 'turn',
      actor: 'builder',
      metadata: { who_failed: 'nobody' },
    });
    expect(rejectedCreate).toMatchObject({ ok: false, reason: 'blame_field_forbidden' });

    const smuggledSend = upsert({
      messageId: 'smuggled-expects-o1',
      senderRole: 'builder',
      targetRole: 'oracle',
      metadata: {
        expects: {
          class: 'verdict',
          staleness_class: 'turn',
          missed_by: 'nobody',
        },
      },
    });
    expect(smuggledSend).toMatchObject({ ok: false, reason: 'blame_field_forbidden' });
    expect(store.queryCommsJournal({ messageId: 'smuggled-expects-o1' })).toHaveLength(0);

    const { obligationId } = createExpectation({ messageId: 'valid-o1' });
    const proof = upsert({
      messageId: 'proof-o1',
      senderRole: 'oracle',
      targetRole: 'builder',
      rawBody: 'Verdict packet.',
    });
    const rejectedFulfill = store.fulfillObligation({
      obligationId,
      byRowId: proof.rowId,
      actor: 'oracle',
      nested: { fault: 'not expressible' },
    });
    expect(rejectedFulfill).toMatchObject({ ok: false, reason: 'blame_field_forbidden' });

    const rejectedGenericEvent = store.appendEvent({
      eventId: 'adversarial-obligation-event',
      traceId: `obligation:${obligationId}`,
      type: 'obligation.fulfilled',
      stage: 'obligation',
      source: 'adversarial-test',
      payload: { obligationId, blame: 'not writable' },
    });
    expect(rejectedGenericEvent).toMatchObject({ ok: false, reason: 'blame_field_forbidden' });

    const sanitized = sanitizeObligationRead({
      obligationId,
      status: 'open',
      detail: { blame: 'strip me', safe: true },
      oracle_failure_count: 2,
      failureCounts: { builder: 1 },
      trustquote_app_failures: 3,
    });
    expect(sanitized.flagged).toBe(true);
    expect(sanitized.value).toEqual({
      obligationId,
      status: 'open',
      detail: { safe: true },
    });

    store.db.exec('ALTER TABLE obligations ADD COLUMN blame TEXT;');
    store.db.prepare('UPDATE obligations SET blame = ? WHERE obligation_id = ?')
      .run('adversarial legacy column', obligationId);
    const created = store.getObligation(obligationId);
    store.db.prepare('UPDATE ledger_events SET evidence_refs_json = ? WHERE event_id = ?')
      .run(JSON.stringify([{ kind: 'legacy', blame: 'strip this too', safe: true }]), created.createdEventId);
    const read = store.queryObligations({});
    expect(read.readIntegrity.flagged).toBe(true);
    expect(read.readIntegrity.redactedFields).toContain('$.blame');
    expect(read.obligations[0]).not.toHaveProperty('blame');
    const singleRead = store.getObligation(obligationId);
    expect(singleRead).not.toHaveProperty('blame');
    expect(singleRead.readIntegrity).toMatchObject({
      flagged: true,
      redactedFields: ['$.blame'],
    });
    const trace = store.queryTrace(`obligation:${obligationId}`);
    expect(trace.events[0].evidenceRefs).toEqual([{ kind: 'legacy', safe: true }]);
    expect(trace.events[0].meta.readIntegrity).toMatchObject({
      flagged: true,
      redactedFields: ['$.evidenceRefs[0].blame'],
    });
  });

  test('O2 and O7 create only from metadata at proof-qualified routing and roll journal plus event back together', () => {
    const proseOnly = upsert({
      messageId: 'prose-only-o2',
      senderRole: 'builder',
      targetRole: 'oracle',
      rawBody: 'Please reply with a verdict.',
      metadata: {},
    });
    expect(proseOnly.ok).toBe(true);
    expect(store.queryObligations({}).count).toBe(0);

    const recorded = upsert({
      messageId: 'phantom-o7',
      senderRole: 'builder',
      targetRole: 'oracle',
      rawBody: 'Explicit expectation.',
      status: 'recorded',
      brokeredAtMs: null,
      metadata: { expects: { class: 'receipt', staleness_class: 'beat' } },
    });
    expect(recorded.ok).toBe(true);
    expect(recorded.obligation.creation.status).toBe('awaiting_route_proof');
    expect(store.queryObligations({}).count).toBe(0);
    expect(store.queryEvents({ type: 'obligation.created' })).toHaveLength(0);

    const failed = upsert({
      messageId: 'phantom-o7',
      senderRole: 'builder',
      targetRole: 'oracle',
      status: 'failed',
      brokeredAtMs: null,
    });
    expect(failed.ok).toBe(true);
    expect(store.queryObligations({}).count).toBe(0);
    expect(store.queryEvents({ type: 'obligation.created' })).toHaveLength(0);

    store.db.exec(`
      CREATE TRIGGER test_block_obligation_event
      BEFORE INSERT ON ledger_events
      WHEN NEW.type = 'obligation.created'
      BEGIN
        SELECT RAISE(ABORT, 'test_event_block');
      END;
    `);
    const blockedRoute = upsert({
      messageId: 'phantom-o7',
      senderRole: 'builder',
      targetRole: 'oracle',
      status: 'routed',
    });
    expect(blockedRoute.ok).toBe(false);
    expect(store.queryCommsJournal({ messageId: 'phantom-o7' })[0].status).toBe('failed');
    expect(store.queryObligations({}).count).toBe(0);

    store.db.exec('DROP TRIGGER test_block_obligation_event;');
    const routed = upsert({
      messageId: 'phantom-o7',
      senderRole: 'builder',
      targetRole: 'oracle',
      status: 'routed',
    });
    expect(routed).toMatchObject({
      ok: true,
      obligation: { creation: { status: 'created', created: true } },
    });
    const acked = upsert({
      messageId: 'phantom-o7',
      senderRole: 'builder',
      targetRole: 'oracle',
      status: 'acked',
    });
    expect(acked.obligation.creation.status).toBe('duplicate');
    expect(store.queryObligations({}).count).toBe(1);
    expect(store.queryEvents({ type: 'obligation.created' })).toHaveLength(1);
  });

  test('O3 and O6 use journal boundaries rather than deadlines and contain no resident-process primitives', () => {
    const schema = store.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'obligations'
    `).get().sql.toLowerCase();
    expect(schema).not.toMatch(/deadline|due_(?:at|ms|timestamp)/);
    expect(schema).toContain("'turn'");
    expect(schema).toContain("'beat'");
    expect(schema).toContain("'day'");
    expect(schema).toContain("'open'");

    const source = createExpectation({
      messageId: 'day-source-o3',
      sessionId: 'app-session-480:squid-room',
      metadata: { expects: { class: 'packet', staleness_class: 'day' } },
    });
    const sameBoundary = upsert({
      messageId: 'same-boundary-o3',
      sessionId: 'app-session-480',
      senderRole: 'architect',
      targetRole: 'builder',
    });
    const sameScan = store.lapseObligations({
      beatRowId: sameBoundary.rowId,
      spoolPath,
    }, { validateNotice: validateNoticePayload });
    expect(sameScan).toMatchObject({ ok: true, count: 0 });
    expect(store.getObligation(source.obligationId).status).toBe('open');

    const nextBoundary = upsert({
      messageId: 'next-boundary-o3',
      sessionId: 'app-session-481',
      senderRole: 'architect',
      targetRole: 'builder',
    });
    const nextScan = store.lapseObligations({
      beatRowId: nextBoundary.rowId,
      spoolPath,
    }, { validateNotice: validateNoticePayload });
    expect(nextScan).toMatchObject({ ok: true, count: 1 });

    const kernelSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'main', 'obligation-kernel.js'),
      'utf8'
    );
    expect(kernelSource).not.toMatch(/setInterval\s*\(/);
    expect(kernelSource).not.toMatch(/setTimeout\s*\(/);
    expect(kernelSource).not.toMatch(/child_process|detached\s*:/);
  });

  test('O3 upgrades the pre-release lax draft schema atomically and preserves valid projection rows', () => {
    const source = upsert({
      messageId: 'legacy-schema-source-o3',
      senderRole: 'builder',
      targetRole: 'oracle',
      rawBody: 'Legacy schema migration source.',
      metadata: {},
    });
    store.db.exec('DROP TABLE obligations;');
    store.db.exec(`
      CREATE TABLE obligations (
        obligation_id TEXT PRIMARY KEY,
        created_from_row_id INTEGER NOT NULL UNIQUE,
        creditor_address TEXT NOT NULL,
        obligor_address TEXT NOT NULL CHECK (obligor_address <> 'james'),
        expected_class TEXT NOT NULL CHECK (expected_class IN ('verdict', 'ack', 'packet', 'answer', 'receipt')),
        staleness_class TEXT NOT NULL CHECK (staleness_class IN ('turn', 'beat', 'day', 'open')),
        lease_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'fulfilled', 'released', 'lapsed')) DEFAULT 'open',
        fulfilled_by_row_id INTEGER,
        released_reason TEXT,
        created_event_id TEXT NOT NULL UNIQUE,
        last_event_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY (created_from_row_id) REFERENCES comms_journal(row_id) ON DELETE RESTRICT,
        FOREIGN KEY (fulfilled_by_row_id) REFERENCES comms_journal(row_id) ON DELETE RESTRICT
      );
    `);
    store.db.prepare(`
      INSERT INTO obligations (
        obligation_id, created_from_row_id, creditor_address, obligor_address,
        expected_class, staleness_class, lease_id, status,
        fulfilled_by_row_id, released_reason, created_event_id, last_event_id,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'builder', 'oracle', 'verdict', 'open', NULL, 'open', NULL, NULL, ?, ?, ?, ?)
    `).run(
      `obl_${'a'.repeat(64)}`,
      source.rowId,
      `oble_${'b'.repeat(64)}`,
      `oble_${'b'.repeat(64)}`,
      clock,
      clock
    );
    store.close();

    store = new EvidenceLedgerStore({ dbPath, enabled: true });
    expect(store.init().ok).toBe(true);
    const migratedSql = store.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'obligations'
    `).get().sql.toLowerCase();
    expect(migratedSql).toMatch(/creditor_address\s+text\s+not\s+null\s+check/);
    expect(migratedSql).toMatch(/obligor_address\s+text\s+not\s+null\s+check/);
    expect(store.queryObligations({})).toMatchObject({
      ok: true,
      count: 1,
      obligations: [expect.objectContaining({
        obligationId: `obl_${'a'.repeat(64)}`,
        createdFromRowId: source.rowId,
        creditorAddress: 'builder',
        obligorAddress: 'oracle',
      })],
    });
    expect(store.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'obligations_v11_legacy'
    `).get()).toBeUndefined();
  });

  test('O4 requires a re-derivable routed row and appends fulfillment to the existing graph spine', () => {
    const { obligationId, obligation } = createExpectation({ messageId: 'source-o4' });
    const dangling = store.fulfillObligation({
      obligationId,
      byRowId: 999999,
      actor: 'oracle',
    });
    expect(dangling).toMatchObject({ ok: false, reason: 'fulfillment_row_missing' });

    const recordedProof = upsert({
      messageId: 'recorded-proof-o4',
      senderRole: 'oracle',
      targetRole: 'builder',
      status: 'recorded',
      brokeredAtMs: null,
      rawBody: 'Not delivered.',
    });
    const unproved = store.fulfillObligation({
      obligationId,
      byRowId: recordedProof.rowId,
      actor: 'oracle',
    });
    expect(unproved).toMatchObject({ ok: false, reason: 'fulfillment_row_not_proof_qualified' });

    const proof = upsert({
      messageId: 'routed-proof-o4',
      senderRole: 'oracle',
      targetRole: 'builder',
      rawBody: 'Verdict delivered.',
    });
    const fulfilled = store.fulfillObligation({
      obligationId,
      byRowId: proof.rowId,
      actor: 'oracle',
    });
    expect(fulfilled).toMatchObject({ ok: true, status: 'fulfilled' });
    expect(store.getObligation(obligationId)).toMatchObject({
      status: 'fulfilled',
      fulfilledByRowId: proof.rowId,
    });

    const trace = store.queryTrace(`obligation:${obligationId}`);
    expect(trace.events.map((event) => event.type)).toEqual([
      'obligation.created',
      'obligation.fulfilled',
    ]);
    expect(trace.events[1].evidenceRefs.map((ref) => ref.path)).toEqual([
      `comms_journal:${obligation.createdFromRowId}`,
      `comms_journal:${proof.rowId}`,
    ]);
    expect(trace.edges).toEqual([
      expect.objectContaining({
        from_event_id: obligation.createdEventId,
        to_event_id: trace.events[1].eventId,
        edge_type: 'parent',
      }),
    ]);
  });

  test('O5 and O8 surface a silent ended turn at the next existing natural beat', () => {
    const { obligationId } = createExpectation({ messageId: 'silent-turn-o8' });
    const beforeBeat = store.lapseObligations({ spoolPath }, { validateNotice: validateNoticePayload });
    expect(beforeBeat).toMatchObject({ ok: true, count: 0 });
    expect(fs.existsSync(spoolPath)).toBe(false);

    store.close();
    const startupBeat = runObligationNaturalBeat({
      projectRoot: tempDir,
      dbPath,
      spoolPath,
      role: 'oracle',
      nowMs: ++clock,
    });
    expect(startupBeat).toMatchObject({
      ok: true,
      naturalBeat: {
        ok: true,
        role: 'oracle',
        kind: 'startup-notices',
      },
      lapseScan: { count: 1 },
      count: 1,
    });
    expect(startupBeat.lapseScan.naturalBeatRowId).toBe(startupBeat.naturalBeat.naturalBeatRowId);
    expect(startupBeat.obligations[0]).toMatchObject({
      obligationId,
      status: 'lapsed',
    });

    const noticePath = startupBeat.lapseScan.lapsed[0].noticePath;
    const notice = JSON.parse(fs.readFileSync(noticePath, 'utf8'));
    expect(validateNoticePayload(notice).ok).toBe(true);
    expect(notice.message).toContain(obligationId);
    expect(notice.message).toContain(`comms row ${startupBeat.obligations[0].createdFromRowId}`);
    expect(notice.message.toLowerCase()).not.toMatch(/oracle|failed|fault|blame|missed/);

    const paths = resolvePaths(tempDir);
    const listed = listNotices({
      role: 'builder',
      spoolPath: paths.spoolPath,
      ackReceiptRoot: paths.ackReceiptRoot,
    });
    expect(listed.ok).toBe(true);
    expect(listed.notices).toEqual([
      expect.objectContaining({
        topic: `obligation:${obligationId}`,
        status: 'lapsed',
      }),
    ]);

    store = new EvidenceLedgerStore({ dbPath, enabled: true });
    expect(store.init().ok).toBe(true);
    const fulfillment = upsert({
      messageId: 'post-lapse-proof-o8',
      senderRole: 'oracle',
      targetRole: 'builder',
      metadata: { fulfills: { obligation_id: obligationId } },
    });
    expect(fulfillment.obligation.fulfillment.fulfilled).toBe(true);
    store.close();
    const resolvedBeat = runObligationNaturalBeat({
      projectRoot: tempDir,
      dbPath,
      spoolPath,
      role: 'builder',
      nowMs: ++clock,
    });
    expect(resolvedBeat.resolvedObligationIds).toContain(obligationId);
    const filtered = listNotices({
      role: 'builder',
      spoolPath: paths.spoolPath,
      ackReceiptRoot: paths.ackReceiptRoot,
      resolvedObligationIds: resolvedBeat.resolvedObligationIds,
    });
    expect(filtered.notices).toHaveLength(0);
    store = null;
  });

  test('James is a creditor but never an obligor, and explicit reply metadata can fulfill his thread', () => {
    const inbound = upsert({
      messageId: 'james-inbound-primary',
      senderRole: 'user',
      targetRole: 'architect',
      channel: 'telegram',
      direction: 'inbound',
      status: 'brokered',
      rawBody: 'Please check the room state.',
      metadata: { source: 'telegram-poller' },
    });
    const created = store.createObligation({
      fromRowId: inbound.rowId,
      creditor: 'james',
      obligor: 'builder',
      class: 'answer',
      staleness: 'turn',
      actor: 'builder',
    });
    expect(created).toMatchObject({
      ok: true,
      status: 'created',
      obligation: {
        creditorAddress: 'james',
        obligorAddress: 'builder',
      },
    });
    const tableColumns = store.db.prepare('PRAGMA table_info(obligations)').all().map((row) => row.name);
    expect(tableColumns).not.toContain('created_from_message_id');

    const forbidden = store.createObligation({
      fromRowId: inbound.rowId,
      creditor: 'builder',
      obligor: 'james',
      class: 'ack',
      staleness: 'open',
      actor: 'builder',
    });
    expect(forbidden).toMatchObject({ ok: false, reason: 'obligor_address_invalid' });

    const reply = upsert({
      messageId: 'james-answer-primary',
      senderRole: 'builder',
      targetRole: 'telegram',
      channel: 'telegram',
      rawBody: 'Here is the checked answer.',
      metadata: {
        fulfills: { obligation_id: created.obligation.obligationId },
      },
    });
    expect(reply).toMatchObject({
      ok: true,
      obligation: { fulfillment: { fulfilled: true } },
    });
    expect(store.getObligation(created.obligation.obligationId).status).toBe('fulfilled');
  });

  test('release is limited to the creator or Mira and remains an event-backed normal outcome', () => {
    const first = createExpectation({ messageId: 'release-source-one' });
    const rejected = store.releaseObligation({
      obligationId: first.obligationId,
      actor: 'oracle',
      reason: 'Request superseded.',
    });
    expect(rejected).toMatchObject({ ok: false, reason: 'release_actor_not_creator_or_mira' });
    const released = store.releaseObligation({
      obligationId: first.obligationId,
      actor: 'builder',
      reason: 'Request superseded.',
    });
    expect(released).toMatchObject({ ok: true, status: 'released' });

    const second = createExpectation({ messageId: 'release-source-two' });
    const miraReleased = store.releaseObligation({
      obligationId: second.obligationId,
      actor: 'mira',
      reason: 'Room synthesis closed the expectation.',
    });
    expect(miraReleased).toMatchObject({ ok: true, status: 'released' });
    const trace = store.queryTrace(`obligation:${second.obligationId}`);
    expect(trace.events.map((event) => event.type)).toEqual([
      'obligation.created',
      'obligation.released',
    ]);
    expect(trace.edges).toHaveLength(1);
    expect(store.prune({ nowMs: 1_000_000, retentionMs: 1000, maxRows: 1, reclaim: false }).ok).toBe(true);
    expect(store.queryTrace(`obligation:${second.obligationId}`).events).toHaveLength(2);
  });

  test('the CLI creates and lists a James-creditor obligation from an actual inbound row', () => {
    const inbound = upsert({
      messageId: 'james-cli-inbound',
      senderRole: 'user',
      targetRole: 'architect',
      channel: 'telegram',
      direction: 'inbound',
      status: 'brokered',
      rawBody: 'CLI source.',
    });
    store.close();
    store = null;
    const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-obligations.js');
    const create = spawnSync(process.execPath, [
      scriptPath,
      'create',
      '--db', dbPath,
      '--project-root', tempDir,
      '--from-row', String(inbound.rowId),
      '--creditor', 'james',
      '--obligor', 'builder',
      '--class', 'answer',
      '--staleness', 'open',
      '--actor', 'builder',
    ], { encoding: 'utf8' });
    expect(create.status).toBe(0);
    const created = JSON.parse(create.stdout);
    expect(created).toMatchObject({ ok: true, status: 'created' });

    const list = spawnSync(process.execPath, [
      scriptPath,
      'list',
      '--db', dbPath,
      '--project-root', tempDir,
      '--address', 'builder',
    ], { encoding: 'utf8' });
    expect(list.status).toBe(0);
    const listed = JSON.parse(list.stdout);
    expect(listed).toMatchObject({ ok: true, count: 1 });
    expect(listed.obligations[0]).toMatchObject({
      creditorAddress: 'james',
      obligorAddress: 'builder',
      status: 'open',
    });

    const unknownFlag = spawnSync(process.execPath, [
      scriptPath,
      'create',
      '--db', dbPath,
      '--project-root', tempDir,
      '--from-row', String(inbound.rowId),
      '--creditor', 'james',
      '--obligor', 'builder',
      '--class', 'answer',
      '--staleness', 'open',
      '--actor', 'builder',
      '--metadata', '{"blame":"silently ignored before this gate"}',
    ], { encoding: 'utf8' });
    expect(unknownFlag.status).toBe(1);
    expect(JSON.parse(unknownFlag.stdout)).toMatchObject({
      ok: false,
      status: 'invalid',
      reason: 'unknown_flag',
      flags: ['metadata'],
    });
  });
});
