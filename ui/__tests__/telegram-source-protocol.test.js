/**
 * v7 §1 — which transport protocol a queue record belongs to, and the promise
 * that answering that question did not disturb the twelve records already in
 * the live queue.
 *
 * The load-bearing test here is not the classifier. It is the pinned digest:
 * v7 requires the canonical source digest to COVER the new protocol tuple and
 * simultaneously requires existing records to stay legacy BYTE-FOR-BYTE. Those
 * pull in opposite directions, and the way to prove the resolution works is a
 * literal digest computed from the pre-change implementation.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('../modules/telegram-inbound-durable-queue');

const tempRoots = [];
afterAll(() => {
  for (const root of tempRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const {
  TRANSPORT_PROTOCOL_V1,
  DECISION_CUTOVER_ID,
  PROTOCOL_FIELDS,
  SOURCE_PROTOCOLS,
  readStampedProtocol,
  classifySourceRecord,
  isDecisionProtocolSource,
  buildSourceProtocolStamp,
} = require('../modules/main/telegram-source-protocol');
const { canonicalQueuedPayloadDigest } = require('../modules/main/telegram-consumed-proof');
const { acceptInbound } = require('../modules/main/telegram-ingress-spool');

/** A record shaped like the ones sitting in the live queue right now. */
const LEGACY_RECORD = Object.freeze({
  updateId: 808499316,
  updateKind: 'message',
  text: 'Hello? are you there',
  chatId: REDACTED,
  from: 'James',
  messageId: 'telegram-in-808499316',
  routeKey: 'main',
  targetProfile: 'main',
  targetWindow: 'main',
  media: null,
  photo: null,
  video: null,
  document: null,
});

const PHOTO_RECORD = Object.freeze({
  ...LEGACY_RECORD,
  updateId: 808499320,
  text: '[Photo received]',
  photo: { kind: 'photo', fileId: 'AgAC', fileUniqueId: 'AQAD', fileSize: 1234 },
});

const STAMP = Object.freeze({
  transportProtocol: TRANSPORT_PROTOCOL_V1,
  decisionCutoverId: DECISION_CUTOVER_ID,
  producerAppGeneration: 'app-session-492',
  producerSessionId: 'sess-1',
});

// ===================================================================
// COMPUTED FROM THE PRE-CHANGE IMPLEMENTATION, then pinned as literals.
//
// Not "whatever the code says today" - that would pass no matter what the code
// did. These were produced by loading the committed parent's
// telegram-consumed-proof.js and hashing the fixtures above with it. If a
// future edit changes the legacy shape by so much as a key order, these fail,
// and the live queue's twelve digests are exactly what would have moved.
// ===================================================================
const LEGACY_DIGEST_BEFORE_V7 = 'e1bb0688a3e81a5e92e4f2390715c448b854fb287b62c973d74e3bcaadd8fe56';
const PHOTO_DIGEST_BEFORE_V7 = 'bd3e26362003f90f859cc36585937561b9d2b4792edbcf0cb89f69c9dc6f4035';

describe('v7 section 1 - the legacy queue does not move', () => {
  test('a live-shaped legacy record hashes to its exact pre-change digest', () => {
    expect(canonicalQueuedPayloadDigest(LEGACY_RECORD)).toBe(LEGACY_DIGEST_BEFORE_V7);
    expect(canonicalQueuedPayloadDigest(PHOTO_RECORD)).toBe(PHOTO_DIGEST_BEFORE_V7);
  });

  test('a HALF-stamped record is legacy, and hashes exactly like a legacy one', () => {
    // v7 §1: "Any record missing/unknown/incoherent in this tuple is legacy."
    // The digest has to agree with the classifier, or a record could be routed
    // as legacy while joining as post-cutover.
    for (const partial of [
      { transportProtocol: TRANSPORT_PROTOCOL_V1 },
      { transportProtocol: TRANSPORT_PROTOCOL_V1, decisionCutoverId: DECISION_CUTOVER_ID },
      { ...STAMP, producerSessionId: '   ' },
      { ...STAMP, producerAppGeneration: undefined },
      { ...STAMP, transportProtocol: 'decision_v2' },
      { ...STAMP, transportProtocol: 'DECISION_V1' },
    ]) {
      const record = { ...LEGACY_RECORD, ...partial };
      expect(classifySourceRecord(record).protocol).toBe(SOURCE_PROTOCOLS.LEGACY);
      expect(canonicalQueuedPayloadDigest(record)).toBe(LEGACY_DIGEST_BEFORE_V7);
    }
  });

  test('a fully stamped record is post-cutover and its digest covers the tuple', () => {
    const stamped = { ...LEGACY_RECORD, ...STAMP };
    expect(classifySourceRecord(stamped).protocol).toBe(SOURCE_PROTOCOLS.DECISION_V1);
    const base = canonicalQueuedPayloadDigest(stamped);
    expect(base).not.toBe(LEGACY_DIGEST_BEFORE_V7);

    // EVERY field of the tuple moves the digest. A field that is stored but not
    // covered is a field that can change without anything noticing.
    for (const field of ['decisionCutoverId', 'producerAppGeneration', 'producerSessionId']) {
      const altered = { ...stamped, [field]: `${STAMP[field]}-different` };
      expect(canonicalQueuedPayloadDigest(altered)).not.toBe(base);
    }
  });
});

describe('v7 section 1 - protocol membership is declared, never inferred', () => {
  test('the stamp must be complete, own, and exact', () => {
    expect(readStampedProtocol({ ...LEGACY_RECORD, ...STAMP })).toEqual(STAMP);
    expect(readStampedProtocol(LEGACY_RECORD)).toBeNull();
    expect(readStampedProtocol(null)).toBeNull();
    expect(readStampedProtocol('decision_v1')).toBeNull();
    expect(readStampedProtocol([])).toBeNull();

    // INHERITED IS NOT DECLARED. A record that satisfies the tuple through a
    // prototype has not stated anything about itself.
    const inherited = Object.assign(Object.create(STAMP), LEGACY_RECORD);
    expect(readStampedProtocol(inherited)).toBeNull();
    expect(isDecisionProtocolSource(inherited)).toBe(false);

    // Non-string values are not names.
    for (const bad of [1, true, null, {}, ['decision_v1']]) {
      expect(readStampedProtocol({ ...LEGACY_RECORD, ...STAMP, producerSessionId: bad })).toBeNull();
    }
  });

  test('NOTHING infers membership from time, environment, or a missing latch', () => {
    // v7 §1, verbatim: "They are never inferred from time, environment, process
    // start, or lack of a legacy latch." Every one of these records is brand
    // new, has no legacy attempt latch anywhere, and is still legacy - because
    // it did not say otherwise.
    const freshWithNoLatch = {
      ...LEGACY_RECORD,
      updateId: 999000001,
      timestampMs: Date.now(),
      receivedAtMs: Date.now(),
    };
    expect(classifySourceRecord(freshWithNoLatch).protocol).toBe(SOURCE_PROTOCOLS.LEGACY);
    expect(isDecisionProtocolSource(freshWithNoLatch)).toBe(false);
  });

  test('a producer that cannot name itself does not get to stamp', () => {
    expect(buildSourceProtocolStamp({ appGeneration: 'g', sessionId: 's' })).toEqual({
      transportProtocol: TRANSPORT_PROTOCOL_V1,
      decisionCutoverId: DECISION_CUTOVER_ID,
      producerAppGeneration: 'g',
      producerSessionId: 's',
    });
    expect(buildSourceProtocolStamp({ appGeneration: 'g' })).toBeNull();
    expect(buildSourceProtocolStamp({ sessionId: 's' })).toBeNull();
    expect(buildSourceProtocolStamp({ appGeneration: '  ', sessionId: 's' })).toBeNull();
    expect(buildSourceProtocolStamp({})).toBeNull();
  });

  test('the durable queue persists exactly the canonical stamp field list', () => {
    // The queue names the fields itself to stay free of the admission modules.
    // Two copies of a list is how one of them silently stops matching, so the
    // copies are asserted equal here rather than trusted to stay in step.
    expect(queue.SOURCE_PROTOCOL_FIELDS).toEqual(PROTOCOL_FIELDS);
  });

  test('the cutover id is a pinned literal, not derived from anything mutable', () => {
    // Same rule as TELEGRAM_CUTOVER_ID, and it additionally feeds the stable
    // legacy fence material in v7 §4 - a value that moved between boots would
    // remint a fence required to be stable.
    expect(DECISION_CUTOVER_ID).toBe('tg-decision-cutover-v1');
    expect(buildSourceProtocolStamp({ appGeneration: 'g', sessionId: 's' }).decisionCutoverId)
      .toBe(buildSourceProtocolStamp({ appGeneration: 'g2', sessionId: 's2' }).decisionCutoverId);
  });
});

describe('v7 section 1 - the spool is the only place a record is stamped', () => {
  function captureAppend() {
    const appended = [];
    return {
      appended,
      append: (dir, record) => { appended.push(record); return { ok: true, deduped: false }; },
    };
  }

  const baseInput = {
    dataRoot: process.platform === 'win32' ? 'D:\\tmp\\ingress' : '/tmp/ingress',
    routeKey: 'main',
    text: 'hello',
    from: 'James',
    metadata: { updateId: 999000002, chatId: REDACTED, messageId: 'm1' },
  };

  test('a producer that names itself writes a post-cutover record', () => {
    const deps = captureAppend();
    const result = acceptInbound({
      ...baseInput,
      producerAppGeneration: 'app-session-492',
      producerSessionId: 'sess-1',
    }, deps);
    expect(result.ok).toBe(true);
    expect(deps.appended).toHaveLength(1);
    expect(classifySourceRecord(deps.appended[0]).protocol).toBe(SOURCE_PROTOCOLS.DECISION_V1);
    expect(deps.appended[0].decisionCutoverId).toBe(DECISION_CUTOVER_ID);
  });

  test('a producer that cannot name itself APPENDS NOTHING', () => {
    // I had this backwards, and Architect #105 proved it from the call graph:
    // squidrun-app.js returns {ok:false} on spool refusal and logs "holding
    // cursor", so refusing does NOT lose James's message - the Telegram cursor
    // stays held and the update is retried. Writing it unstamped is the actual
    // damage: it creates a NEW legacy obligation after settlement, changing the
    // journal fingerprints that v7 §4's stable fence is derived from.
    for (const missing of [
      {},
      { producerAppGeneration: 'app-session-492' },
      { producerSessionId: 'sess-1' },
      { producerAppGeneration: '   ', producerSessionId: 'sess-1' },
      { producerAppGeneration: 'app-session-492', producerSessionId: null },
      { producerAppGeneration: 492, producerSessionId: 'sess-1' },
    ]) {
      const deps = captureAppend();
      const result = acceptInbound({ ...baseInput, ...missing }, deps);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('missing_producer_protocol_identity');
      // THE ZERO-APPEND ASSERTION. A refusal that still wrote would be the
      // exact invariant break, wearing a refusal's return value.
      expect(deps.appended).toHaveLength(0);
    }
  });

  test('an arbitrary decisionCutoverId cannot override the release literal', () => {
    const deps = captureAppend();
    acceptInbound({
      ...baseInput,
      producerAppGeneration: 'app-session-492',
      producerSessionId: 'sess-1',
      decisionCutoverId: 'attacker-chosen-cutover',
    }, deps);
    expect(deps.appended[0].decisionCutoverId).toBe(DECISION_CUTOVER_ID);
  });

  test('ARCH #106: an ACK-loss replay across G to G+1 cannot rewrite the stamp', () => {
    // v7 calls these source fields immutable. A same-generation replay proves
    // only that dedupe works; the restart boundary is where a second generation
    // would be tempted to restamp the record with ITS identity, and that would
    // silently move the canonical digest that decisions and proofs join on.
    //
    // Real spool, real durable queue, real temp directory - no injected append.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-source-protocol-'));
    tempRoots.push(root);
    const metadata = { updateId: 999000003, chatId: REDACTED, messageId: 'm-replay' };

    const first = acceptInbound({
      dataRoot: root,
      routeKey: 'main',
      text: 'the same message',
      from: 'James',
      metadata,
      targetProfile: 'main',
      targetWindow: 'main',
      producerAppGeneration: 'app-session-G1',
      producerSessionId: 'sess-G1',
    });
    expect(first.ok).toBe(true);
    expect(first.deduped).toBe(false);

    const [storedAfterFirst] = queue.readPending(first.dir);
    const digestAfterFirst = canonicalQueuedPayloadDigest(storedAfterFirst);

    // G+1: the app restarted, the ack never landed, the same update arrives.
    const replay = acceptInbound({
      dataRoot: root,
      routeKey: 'main',
      text: 'the same message',
      from: 'James',
      metadata,
      targetProfile: 'main',
      targetWindow: 'main',
      producerAppGeneration: 'app-session-G2',
      producerSessionId: 'sess-G2',
    });
    expect(replay.ok).toBe(true);
    expect(replay.deduped).toBe(true);

    const stored = queue.readPending(first.dir);
    expect(stored).toHaveLength(1);
    // THE SOLE RECORD STILL BELONGS TO G1.
    expect(stored[0].producerAppGeneration).toBe('app-session-G1');
    expect(stored[0].producerSessionId).toBe('sess-G1');
    expect(stored[0].decisionCutoverId).toBe(DECISION_CUTOVER_ID);
    expect(canonicalQueuedPayloadDigest(stored[0])).toBe(digestAfterFirst);
  });

  test('PRODUCTION CALL GRAPH: both app append sites stamp, and refusal holds the cursor', () => {
    // Static, because the point is that no reachable production path can append
    // anonymously - not that one particular test managed to make it refuse.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'main', 'squidrun-app.js'),
      'utf8'
    );
    const callSites = src.split('telegramIngressSpool.acceptInbound({').slice(1);
    expect(callSites).toHaveLength(2);
    for (const site of callSites) {
      const args = site.slice(0, site.indexOf('});'));
      expect(args).toContain('producerAppGeneration: currentAppGeneration()');
      expect(args).toContain('producerSessionId: this.commsSessionScopeId');
    }
    // And the refusal is a HOLD, not a drop: this is why failing closed is safe.
    expect(src).toContain('Telegram ingress spool refused update');
    expect(src).toContain('holding cursor');
  });
});
