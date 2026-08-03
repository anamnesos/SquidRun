/* global describe, expect, it */

const {
  mayBypassHeadOfLine,
  HEAD_OF_LINE_GRACE_MS,
} = require('../modules/main/telegram-ingress-drain');

// The exact record that wedged the channel in S491: James's first message,
// attempted once, never proven, blocking five later messages behind it.
const INCIDENT_RECORD = { updateId: 808499316, receivedAtMs: 1785748000000 };
const AWAITING = { stop: true, reason: 'unresolved_delivery_attempt', failureClass: 'awaiting_proof' };

describe('head-of-line escape (S491 incident)', () => {
  it('THE S491 WEDGE IS RELEASED: an hours-old unresolved attempt stops muting the channel', () => {
    // 8.6 hours after receipt, still awaiting proof that can never arrive,
    // because production pane delivery only ever returns
    // accepted.daemon_pty_unverified and that is correctly not proof.
    const nowMs = INCIDENT_RECORD.receivedAtMs + (8.6 * 60 * 60 * 1000);
    expect(mayBypassHeadOfLine(INCIDENT_RECORD, AWAITING, nowMs)).toBe(true);
  });

  it('AN IN-FLIGHT DELIVERY GETS ITS FULL MOMENT — no bypass inside the grace window', () => {
    const nowMs = INCIDENT_RECORD.receivedAtMs + (HEAD_OF_LINE_GRACE_MS - 1000);
    expect(mayBypassHeadOfLine(INCIDENT_RECORD, AWAITING, nowMs)).toBe(false);
  });

  it('ONLY THE AMBIGUITY CLASS MAY BYPASS — integrity failures still stop the queue', () => {
    const old = INCIDENT_RECORD.receivedAtMs + (24 * 60 * 60 * 1000);
    for (const failureClass of ['definite', 'indefinite']) {
      expect(mayBypassHeadOfLine(
        INCIDENT_RECORD,
        { stop: true, reason: 'route_changed', failureClass },
        old
      )).toBe(false);
    }
  });

  it('A NON-STOP OUTCOME IS NEVER A BYPASS', () => {
    const old = INCIDENT_RECORD.receivedAtMs + (24 * 60 * 60 * 1000);
    expect(mayBypassHeadOfLine(INCIDENT_RECORD, { retire: true }, old)).toBe(false);
    expect(mayBypassHeadOfLine(INCIDENT_RECORD, null, old)).toBe(false);
  });

  it('A RECORD WITH NO USABLE TIMESTAMP IS NEVER BYPASSED — fail closed', () => {
    // Without an age we cannot say the grace elapsed, so it keeps its block.
    const old = Date.now();
    for (const bad of [{}, { receivedAtMs: 0 }, { receivedAtMs: -1 }, { receivedAtMs: 'x' }]) {
      expect(mayBypassHeadOfLine(bad, AWAITING, old)).toBe(false);
    }
  });

  it('THE GRACE IS GENEROUS — ten minutes, not a retry timeout', () => {
    // Short enough that a user is not left silent for hours; long enough that a
    // real in-flight delivery is never raced.
    expect(HEAD_OF_LINE_GRACE_MS).toBe(10 * 60 * 1000);
  });
});
