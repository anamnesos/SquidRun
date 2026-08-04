/**
 * v7 section 2 - the mandatory legacy-file gate.
 *
 * The parser's job is to refuse, so almost every test here is a refusal. The
 * two that are not carry the whole weight: the CURRENT LIVE-SHAPED v0 attempt
 * must parse (a gate that rejected 808499316 would wedge the queue it exists to
 * unwedge), and an attempt plus a reviewed terminal disposition for the same
 * update must retire without injection - that pair is the resolved shape, not a
 * conflict.
 */
const legacyJournal = require('../modules/main/telegram-legacy-journal');

const {
  GATE_ACTIONS,
  ATTEMPT_STATE_VALUES,
  TERMINAL_DISPOSITION_VALUES,
  isRecognizedAttemptState,
  isRecognizedTerminalDisposition,
  readLegacyJournalSnapshot,
  evaluateLegacySourceGate,
} = legacyJournal;
const {
  TRANSPORT_PROTOCOL_V1,
  DECISION_CUTOVER_ID,
} = require('../modules/main/telegram-source-protocol');

const LIVE_UPDATE = 808499316;

/** Reads from memory so a test can hand over bytes no real writer would emit. */
function snapshotOf({ attempts = null, dispositions = null } = {}) {
  const reads = [];
  const result = readLegacyJournalSnapshot('/spool/main', {
    readFile: (file) => {
      reads.push(file);
      const raw = file.endsWith('delivery-attempts.jsonl') ? attempts : dispositions;
      if (raw === null) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return raw;
    },
  });
  return { result, reads };
}

const legacyRecord = (updateId = LIVE_UPDATE) => ({ updateId, text: 'hi', routeKey: 'main' });
const decisionRecord = (updateId = 999000010) => ({
  ...legacyRecord(updateId),
  transportProtocol: TRANSPORT_PROTOCOL_V1,
  decisionCutoverId: DECISION_CUTOVER_ID,
  producerAppGeneration: 'app-session-492',
  producerSessionId: 'sess-1',
});

describe('v7 section 2 - the snapshot reads each file exactly once', () => {
  test('one read of each sidecar per pass, and missing is the defined empty state', () => {
    const { result, reads } = snapshotOf({});
    expect(result.ok).toBe(true);
    expect(result.attempts.size).toBe(0);
    expect(result.dispositions.size).toBe(0);
    expect(result.reads).toEqual({ attempts: 1, dispositions: 1 });
    expect(reads).toHaveLength(2);
  });

  test('an empty file is not a missing file, and both are legal', () => {
    const { result } = snapshotOf({ attempts: '', dispositions: '' });
    expect(result.ok).toBe(true);
    expect(result.reads).toEqual({ attempts: 1, dispositions: 1 });
  });
});

describe('v7 section 2 - the current live records must survive the gate', () => {
  test('THE LIVE v0 ATTEMPT PARSES: no atMs, no generation', () => {
    // Exactly the bytes in the live spool today. If this ever stops parsing,
    // the head of James's queue can never be reasoned about again.
    const { result } = snapshotOf({
      attempts: `{"updateId":${LIVE_UPDATE},"state":"attempted"}\n`,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts.get(LIVE_UPDATE)).toEqual({
      state: 'attempted', atMs: null, generation: null,
    });
  });

  test('attempt WITHOUT a terminal disposition HOLDs, and touches nothing', () => {
    const { result } = snapshotOf({
      attempts: `{"updateId":${LIVE_UPDATE},"state":"attempted"}\n`,
    });
    const gate = evaluateLegacySourceGate({ record: legacyRecord(), snapshot: result });
    expect(gate.action).toBe(GATE_ACTIONS.HOLD_ATTEMPTED);
    expect(gate.hold).toBe(true);
    expect(gate.deliver).toBe(false);
    expect(gate.decision).toBe(false);
  });

  test('THE 316 CASE: attempt PLUS reviewed disposition retires with zero injection', () => {
    // Cross-file for the same update is the RESOLVED shape, not a conflict.
    const { result } = snapshotOf({
      attempts: `{"updateId":${LIVE_UPDATE},"state":"attempted"}\n`,
      dispositions: `{"updateId":${LIVE_UPDATE},"disposition":"consumed_verified_out_of_band","evidence":"ledger rows 78452/78453"}\n`,
    });
    expect(result.ok).toBe(true);
    const gate = evaluateLegacySourceGate({ record: legacyRecord(), snapshot: result });
    expect(gate.action).toBe(GATE_ACTIONS.RETIRE_TERMINAL);
    expect(gate.retire).toBe(true);
    expect(gate.deliver).toBe(false);
    expect(gate.decision).toBe(false);
    expect(gate.evidence).toBe('ledger rows 78452/78453');
  });

  test('retryable, or no journal match at all, is the legacy pane path only', () => {
    const retryable = snapshotOf({ attempts: `{"updateId":${LIVE_UPDATE},"state":"retryable"}\n` }).result;
    const retryGate = evaluateLegacySourceGate({ record: legacyRecord(), snapshot: retryable });
    expect(retryGate.action).toBe(GATE_ACTIONS.LEGACY_PANE_ONLY);
    expect(retryGate.decision).toBe(false);

    const none = snapshotOf({}).result;
    const noneGate = evaluateLegacySourceGate({ record: legacyRecord(), snapshot: none });
    expect(noneGate.action).toBe(GATE_ACTIONS.LEGACY_PANE_ONLY);
    expect(noneGate.deliver).toBe(true);
    expect(noneGate.decision).toBe(false);
  });
});

describe('v7 section 2 - a decision_v1 source never reaches claim or deliver here', () => {
  test('ANY legacy journal match is a protocol conflict HOLD', () => {
    for (const files of [
      { attempts: '{"updateId":999000010,"state":"attempted"}\n' },
      { attempts: '{"updateId":999000010,"state":"retryable"}\n' },
      { dispositions: '{"updateId":999000010,"disposition":"empty_body","evidence":"e"}\n' },
    ]) {
      const { result } = snapshotOf(files);
      const gate = evaluateLegacySourceGate({ record: decisionRecord(), snapshot: result });
      expect(gate.action).toBe(GATE_ACTIONS.PROTOCOL_CONFLICT);
      expect(gate.hold).toBe(true);
      expect(gate.deliver).toBe(false);
      expect(gate.decision).toBe(false);
    }
  });

  test('no journal match still HOLDs, because the stable fence is Step 3', () => {
    const { result } = snapshotOf({});
    const gate = evaluateLegacySourceGate({ record: decisionRecord(), snapshot: result });
    expect(gate.action).toBe(GATE_ACTIONS.REQUIRES_FENCE);
    expect(gate.hold).toBe(true);
    expect(gate.deliver).toBe(false);
    expect(gate.decision).toBe(false);
  });
});

describe('v7 section 2 - anything the parser cannot fully trust is snapshot failure', () => {
  const refuses = (files, reason) => {
    const { result } = snapshotOf(files);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(reason);
    // A failed snapshot can never be answered from.
    const gate = evaluateLegacySourceGate({ record: legacyRecord(), snapshot: result });
    expect(gate.ok).toBe(false);
    expect(gate.action).toBeNull();
  };

  test('a torn tail is a torn write, not a last record', () => {
    refuses({ attempts: `{"updateId":${LIVE_UPDATE},"state":"attempted"}` }, 'attempt_torn_tail');
    refuses({ dispositions: '{"updateId":1,"disposition":"empty_body","evidence":"e"}' }, 'disposition_torn_tail');
  });

  test('an interior blank line is a gap where a write went wrong', () => {
    refuses({ attempts: '{"updateId":1,"state":"attempted"}\n\n{"updateId":2,"state":"attempted"}\n' }, 'attempt_blank_record');
  });

  test('unparseable, or not an object at all', () => {
    refuses({ attempts: 'not json\n' }, 'attempt_unparseable_record');
    refuses({ attempts: '[1,2,3]\n' }, 'attempt_record_not_an_object');
    refuses({ attempts: 'null\n' }, 'attempt_record_not_an_object');
  });

  test('unknown keys mean another writer; missing keys mean an incomplete record', () => {
    refuses({ attempts: '{"updateId":1,"state":"attempted","surprise":1}\n' }, 'attempt_schema_mismatch');
    refuses({ attempts: '{"updateId":1}\n' }, 'attempt_schema_mismatch');
    refuses({ dispositions: '{"updateId":1,"disposition":"empty_body"}\n' }, 'disposition_schema_mismatch');
  });

  test('the updateId must be a positive safe integer, not something that looks like one', () => {
    for (const bad of ['"1"', '0', '-1', '1.5', 'null', 'true', '9007199254740993']) {
      refuses({ attempts: `{"updateId":${bad},"state":"attempted"}\n` }, 'attempt_invalid_update_id');
    }
  });

  test('unrecognized states and dispositions are refused, not tolerated as future values', () => {
    refuses({ attempts: '{"updateId":1,"state":"delivered"}\n' }, 'attempt_unknown_state');
    refuses({ attempts: '{"updateId":1,"state":""}\n' }, 'attempt_unknown_state');
    refuses({ dispositions: '{"updateId":1,"disposition":"consumed_verified_out_of_bandd","evidence":"e"}\n' }, 'disposition_unrecognized');
    // Every recognized one is accepted, so the set is a gate and not a wall.
    for (const disposition of TERMINAL_DISPOSITION_VALUES) {
      const { result } = snapshotOf({
        dispositions: `{"updateId":1,"disposition":"${disposition}","evidence":"e"}\n`,
      });
      expect(result.ok).toBe(true);
    }
  });

  test('a disposition without evidence is the hand-edited disappearance this file forbids', () => {
    refuses({ dispositions: '{"updateId":1,"disposition":"empty_body","evidence":""}\n' }, 'disposition_missing_evidence');
    refuses({ dispositions: '{"updateId":1,"disposition":"empty_body","evidence":"   "}\n' }, 'disposition_missing_evidence');
  });

  test('present-but-malformed provenance is not the same as absent', () => {
    refuses({ attempts: '{"updateId":1,"state":"attempted","atMs":0}\n' }, 'attempt_invalid_at_ms');
    refuses({ attempts: '{"updateId":1,"state":"attempted","atMs":"yesterday"}\n' }, 'attempt_invalid_at_ms');
    refuses({ attempts: '{"updateId":1,"state":"attempted","generation":""}\n' }, 'attempt_invalid_generation');
  });

  test('A DUPLICATE UPDATE ID IS REFUSED EVEN WHEN BYTE-IDENTICAL', () => {
    // The old reader did records.set() and silently kept the last one. A
    // repeated id is a fact about the WRITER, and picking one is choosing which
    // disagreement to believe.
    const identical = '{"updateId":1,"state":"attempted"}\n{"updateId":1,"state":"attempted"}\n';
    refuses({ attempts: identical }, 'attempt_duplicate_update_id');
    const conflicting = '{"updateId":1,"state":"attempted"}\n{"updateId":1,"state":"retryable"}\n';
    refuses({ attempts: conflicting }, 'attempt_duplicate_update_id');
    refuses({
      dispositions: '{"updateId":1,"disposition":"empty_body","evidence":"a"}\n{"updateId":1,"disposition":"empty_body","evidence":"a"}\n',
    }, 'disposition_duplicate_update_id');
  });

  test('ARCH #116: BOTH sidecars are read once even when the first one throws', () => {
    // Returning early on an unreadable attempts file left dispositions read
    // zero times, so the pass's evidence went asymmetric on precisely the path
    // where we most need to say what we looked at.
    const reads = { attempts: 0, dispositions: 0 };
    const result = readLegacyJournalSnapshot('/spool/main', {
      readFile: (file) => {
        if (file.endsWith('delivery-attempts.jsonl')) {
          reads.attempts += 1;
          const err = new Error('EACCES');
          err.code = 'EACCES';
          throw err;
        }
        reads.dispositions += 1;
        return '';
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('journal_unreadable');
    expect(reads).toEqual({ attempts: 1, dispositions: 1 });
    expect(result.reads).toEqual({ attempts: 1, dispositions: 1 });
    // And nothing downstream may act on it.
    const gate = evaluateLegacySourceGate({ record: legacyRecord(), snapshot: result });
    expect(gate.ok).toBe(false);
    expect(gate.action).toBeNull();
  });

  test('an unreadable file is failure, and only ENOENT is the empty state', () => {
    const result = readLegacyJournalSnapshot('/spool/main', {
      readFile: () => { const err = new Error('EACCES'); err.code = 'EACCES'; throw err; },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('journal_unreadable');
  });

  test('a record with no usable updateId cannot be gated', () => {
    const { result } = snapshotOf({});
    for (const bad of [{}, { updateId: 0 }, { updateId: '1' }, null]) {
      const gate = evaluateLegacySourceGate({ record: bad, snapshot: result });
      expect(gate.ok).toBe(false);
      expect(gate.reason).toBe('record_invalid_update_id');
    }
  });
});
