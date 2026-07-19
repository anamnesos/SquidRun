'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolvePaths,
  listNotices,
  createListingBatch,
  acknowledgeAll,
} = require('../scripts/hm-next-session-notices');

describe('hm-next-session-notices thin spool', () => {
  let root;
  let paths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-next-session-'));
    paths = resolvePaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeNotice(name = 'main-e28-restoration.json') {
    fs.mkdirSync(paths.spoolPath, { recursive: true });
    const noticePath = path.join(paths.spoolPath, name);
    fs.writeFileSync(noticePath, JSON.stringify({
      schema: 'squidrun.next_session_notice.v1',
      audience: ['architect', 'builder', 'oracle'],
      topic: 'build1b-main-e28-restoration',
      status: 'complete',
      createdAt: '2026-07-18T22:00:00.000Z',
      message: 'Read the restoration receipt.',
      expectedHead: 'a'.repeat(40),
      registrationEpochMs: Date.parse('2026-07-18T21:00:00.000Z'),
      restorationReceiptPath: path.join(root, 'restoration.json'),
      donePath: path.join(root, 'done.json'),
    }), 'utf8');
    return noticePath;
  }

  function listBatch(options) {
    return createListingBatch(listNotices(options), options);
  }

  function acknowledgeListed(options) {
    const listing = listBatch(options);
    if (!listing.ok || !listing.batchToken) return listing;
    return acknowledgeAll({ ...options, batchToken: listing.batchToken });
  }

  test('missing spool directory is a visible zero-notice success', () => {
    const result = listNotices({ role: 'builder', spoolPath: paths.spoolPath });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      role: 'builder',
      directoryPresent: false,
      count: 0,
      notices: [],
    }));
  });

  test('list filters by role audience and keeps the authoritative notice intact', () => {
    const noticePath = writeNotice();
    fs.writeFileSync(path.join(paths.spoolPath, 'architect-only.json'), JSON.stringify({
      schema: 'squidrun.next_session_notice.v1',
      audience: ['architect'],
      topic: 'architect-only',
      status: 'fyi',
      createdAt: '2026-07-18T22:00:00.000Z',
      message: 'Architect only.',
    }), 'utf8');

    const result = listNotices({ role: 'builder', spoolPath: paths.spoolPath });

    expect(result.count).toBe(1);
    expect(result.notices[0].noticePath).toBe(noticePath);
    expect(fs.existsSync(noticePath)).toBe(true);
  });

  test('ack-all is one cheap idempotent command and retains an ack receipt', () => {
    const noticePath = writeNotice();
    const options = {
      role: 'builder',
      spoolPath: paths.spoolPath,
      ackReceiptRoot: paths.ackReceiptRoot,
      nowMs: Date.parse('2026-07-18T22:01:00.000Z'),
      paneId: '2',
      sessionId: 'app-session-481',
    };

    const listing = listBatch(options);
    const first = acknowledgeAll({ ...options, batchToken: listing.batchToken });
    const second = acknowledgeAll({ ...options, batchToken: listing.batchToken });

    expect(first).toEqual(expect.objectContaining({ ok: true, listedCount: 1, acknowledgedCount: 1 }));
    expect(fs.existsSync(first.results[0].receiptPath)).toBe(true);
    expect(second).toEqual(expect.objectContaining({ ok: true, listedCount: 1, acknowledgedCount: 1 }));
    const notice = JSON.parse(fs.readFileSync(noticePath, 'utf8'));
    expect(notice.acknowledgements.builder).toEqual(expect.objectContaining({
      role: 'builder',
      paneId: '2',
      sessionId: 'app-session-481',
    }));
    expect(notice.fullyAcknowledged).toBe(false);
  });

  test('accepted noncanonical audience spelling stays acknowledged after receipt verification', () => {
    const noticePath = writeNotice('noncanonical-audience.json');
    const notice = JSON.parse(fs.readFileSync(noticePath, 'utf8'));
    notice.audience = ['Architect', 'Builder', 'Oracle'];
    fs.writeFileSync(noticePath, JSON.stringify(notice), 'utf8');
    const options = {
      role: 'builder',
      spoolPath: paths.spoolPath,
      ackReceiptRoot: paths.ackReceiptRoot,
    };

    expect(acknowledgeListed(options)).toEqual(expect.objectContaining({
      ok: true,
      listedCount: 1,
      acknowledgedCount: 1,
    }));
    expect(listNotices(options)).toEqual(expect.objectContaining({ ok: true, count: 0 }));
  });

  test('notice remains authoritative until every audience role acknowledges', () => {
    const noticePath = writeNotice();
    for (const role of ['architect', 'builder', 'oracle']) {
      const result = acknowledgeListed({
        role,
        spoolPath: paths.spoolPath,
        ackReceiptRoot: paths.ackReceiptRoot,
        nowMs: Date.parse(`2026-07-18T22:0${role.length}:00.000Z`),
      });
      expect(result.ok).toBe(true);
      expect(fs.existsSync(noticePath)).toBe(true);
    }

    const notice = JSON.parse(fs.readFileSync(noticePath, 'utf8'));
    expect(Object.keys(notice.acknowledgements).sort()).toEqual(['architect', 'builder', 'oracle']);
    expect(notice.fullyAcknowledged).toBe(true);
    expect(fs.existsSync(noticePath)).toBe(true);
    expect(listNotices({ role: 'architect', spoolPath: paths.spoolPath }).count).toBe(0);
    expect(listNotices({ role: 'builder', spoolPath: paths.spoolPath }).count).toBe(0);
    expect(listNotices({ role: 'oracle', spoolPath: paths.spoolPath }).count).toBe(0);
  });

  test('malformed notice or acknowledgement data is surfaced instead of becoming zero work', () => {
    fs.mkdirSync(paths.spoolPath, { recursive: true });
    fs.writeFileSync(path.join(paths.spoolPath, 'broken.json'), '{', 'utf8');
    fs.writeFileSync(path.join(paths.spoolPath, 'bad-ack.json'), JSON.stringify({
      schema: 'squidrun.next_session_notice.v1',
      audience: ['builder'],
      topic: 'bad-ack',
      status: 'complete',
      createdAt: '2026-07-18T22:00:00.000Z',
      message: 'Bad acknowledgement fixture.',
      acknowledgements: { builder: 'not-a-receipt' },
    }), 'utf8');

    const result = listNotices({ role: 'builder', spoolPath: paths.spoolPath });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_notice_or_acknowledgement_data');
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'json_read_or_parse_failed' }),
      expect.objectContaining({ reason: 'acknowledgement_not_object', role: 'builder' }),
    ]));
  });

  test('ack receipt failure leaves the authoritative notice visible and unacknowledged', () => {
    const noticePath = writeNotice();
    const options = {
      role: 'builder',
      spoolPath: paths.spoolPath,
      ackReceiptRoot: paths.ackReceiptRoot,
    };
    const listing = listBatch(options);
    fs.mkdirSync(paths.ackReceiptRoot, { recursive: true });
    fs.writeFileSync(path.join(paths.ackReceiptRoot, 'main-e28-restoration'), 'not-a-directory', 'utf8');

    const result = acknowledgeAll({ ...options, batchToken: listing.batchToken });

    expect(result.ok).toBe(false);
    expect(result.results[0].reason).toBe('acknowledgement_transaction_failed');
    const notice = JSON.parse(fs.readFileSync(noticePath, 'utf8'));
    expect(notice.acknowledgements?.builder).toBeUndefined();
    expect(listNotices({ role: 'builder', spoolPath: paths.spoolPath }).count).toBe(1);
  });

  test('prepared receipt crash state stays visible and is repaired by ack-all', () => {
    const noticePath = writeNotice();
    const receiptPath = path.join(paths.ackReceiptRoot, 'main-e28-restoration', 'prepared.json');
    const acknowledgement = {
      role: 'builder',
      acknowledgedAt: '2026-07-18T22:05:00.000Z',
      pid: 1234,
      paneId: null,
      sessionId: null,
      receiptPath,
    };
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, JSON.stringify({
      schema: 'squidrun.next_session_notice_ack.v1',
      phase: 'prepared_before_notice_update',
      role: 'builder',
      acknowledgement,
    }), 'utf8');
    const notice = JSON.parse(fs.readFileSync(noticePath, 'utf8'));
    notice.acknowledgements = { builder: acknowledgement };
    fs.writeFileSync(noticePath, JSON.stringify(notice), 'utf8');

    const listing = listNotices({ role: 'builder', spoolPath: paths.spoolPath });
    expect(listing).toEqual(expect.objectContaining({ ok: true, count: 1 }));
    expect(listing.notices[0].acknowledgementRepairRequired).toBe(true);

    const repaired = acknowledgeListed({
      role: 'builder',
      spoolPath: paths.spoolPath,
      ackReceiptRoot: paths.ackReceiptRoot,
    });
    expect(repaired.ok).toBe(true);
    expect(listNotices({ role: 'builder', spoolPath: paths.spoolPath }).count).toBe(0);
    const updated = JSON.parse(fs.readFileSync(noticePath, 'utf8'));
    expect(updated.acknowledgements.builder.receiptPath).not.toBe(receiptPath);
    expect(JSON.parse(fs.readFileSync(updated.acknowledgements.builder.receiptPath, 'utf8')).phase).toBe('committed');
  });

  test('missing schema, status, timestamp, or message is surfaced and cannot be acknowledged', () => {
    fs.mkdirSync(paths.spoolPath, { recursive: true });
    const noticePath = path.join(paths.spoolPath, 'underspecified.json');
    fs.writeFileSync(noticePath, JSON.stringify({
      audience: ['builder'],
      topic: 'underspecified',
    }), 'utf8');

    const listing = listNotices({
      role: 'builder',
      spoolPath: paths.spoolPath,
      ackReceiptRoot: paths.ackReceiptRoot,
    });
    const acknowledgement = acknowledgeListed({
      role: 'builder',
      spoolPath: paths.spoolPath,
      ackReceiptRoot: paths.ackReceiptRoot,
    });

    expect(listing.ok).toBe(false);
    expect(listing.errors).toContainEqual(expect.objectContaining({ reason: 'notice_schema_invalid' }));
    expect(acknowledgement.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(noticePath, 'utf8')).acknowledgements).toBeUndefined();
  });

  test('tampered committed receipt fields cannot hide an authoritative notice', () => {
    const noticePath = writeNotice();
    const options = {
      role: 'builder',
      spoolPath: paths.spoolPath,
      ackReceiptRoot: paths.ackReceiptRoot,
      nowMs: Date.parse('2026-07-18T22:06:00.000Z'),
    };
    const acknowledged = acknowledgeListed(options);
    const receiptPath = acknowledged.results[0].receiptPath;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.noticeId = 'different-notice';
    receipt.acknowledgement.acknowledgedAt = '2026-07-18T22:07:00.000Z';
    fs.writeFileSync(receiptPath, JSON.stringify(receipt), 'utf8');

    const listing = listNotices(options);

    expect(listing).toEqual(expect.objectContaining({ ok: true, count: 1 }));
    expect(listing.notices[0]).toEqual(expect.objectContaining({
      noticePath,
      acknowledgementRepairRequired: true,
    }));
  });

  test('changed authoritative notice content invalidates an older acknowledgement receipt', () => {
    const noticePath = writeNotice('changed-content.json');
    const options = {
      role: 'builder',
      spoolPath: paths.spoolPath,
      ackReceiptRoot: paths.ackReceiptRoot,
    };
    expect(acknowledgeListed(options).ok).toBe(true);
    const notice = JSON.parse(fs.readFileSync(noticePath, 'utf8'));
    notice.createdAt = '2026-07-18T23:00:00.000Z';
    notice.message = 'The authoritative content changed.';
    fs.writeFileSync(noticePath, JSON.stringify(notice), 'utf8');

    const listing = listNotices(options);

    expect(listing).toEqual(expect.objectContaining({ ok: true, count: 1 }));
    expect(listing.notices[0]).toEqual(expect.objectContaining({
      noticePath,
      acknowledgementRepairRequired: true,
    }));
  });

  test('ack-all acknowledges only the content-bound batch that was actually listed', () => {
    const firstPath = writeNotice('first.json');
    const options = { role: 'builder', spoolPath: paths.spoolPath, ackReceiptRoot: paths.ackReceiptRoot };
    const listing = listBatch(options);
    const latePath = writeNotice('arrived-after-list.json');

    const result = acknowledgeAll({ ...options, batchToken: listing.batchToken });

    expect(result).toEqual(expect.objectContaining({ ok: true, listedCount: 1, acknowledgedCount: 1 }));
    expect(JSON.parse(fs.readFileSync(firstPath, 'utf8')).acknowledgements.builder).toBeDefined();
    expect(JSON.parse(fs.readFileSync(latePath, 'utf8')).acknowledgements?.builder).toBeUndefined();
    expect(listNotices(options).notices.map((notice) => notice.noticePath)).toContain(latePath);
  });

  test('a listed notice that changes before ack is refused without acknowledging it', () => {
    const noticePath = writeNotice('changed-after-list.json');
    const options = { role: 'builder', spoolPath: paths.spoolPath, ackReceiptRoot: paths.ackReceiptRoot };
    const listing = listBatch(options);
    const notice = JSON.parse(fs.readFileSync(noticePath, 'utf8'));
    notice.message = 'Changed after it was displayed.';
    fs.writeFileSync(noticePath, JSON.stringify(notice), 'utf8');

    const result = acknowledgeAll({ ...options, batchToken: listing.batchToken });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'listed_notice_changed_or_invalid' }));
    expect(JSON.parse(fs.readFileSync(noticePath, 'utf8')).acknowledgements?.builder).toBeUndefined();
  });

  test('Build 1B E28 notices require their topic-specific recovery anchors', () => {
    fs.mkdirSync(paths.spoolPath, { recursive: true });
    fs.writeFileSync(path.join(paths.spoolPath, 'missing-anchors.json'), JSON.stringify({
      schema: 'squidrun.next_session_notice.v1',
      audience: ['architect', 'builder', 'oracle'],
      topic: 'build1b-main-e28-restoration',
      status: 'complete',
      createdAt: '2026-07-18T22:00:00.000Z',
      message: 'Missing the recovery anchors.',
    }), 'utf8');

    const listing = listNotices({ role: 'builder', spoolPath: paths.spoolPath, ackReceiptRoot: paths.ackReceiptRoot });

    expect(listing).toEqual(expect.objectContaining({ ok: false, reason: 'invalid_notice_or_acknowledgement_data' }));
    expect(listing.errors).toContainEqual(expect.objectContaining({ reason: 'build1b_e28_notice_contract_invalid' }));
  });
});
