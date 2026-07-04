'use strict';

/**
 * ACK-VOCABULARY COLLAPSE contracts (nervous-system-v1): five legacy shapes
 * answer one question through three receipt-backed states. Tests pin the
 * collapse - and pin that forensics (raw status) survive it.
 */

const { classifyAckOutcome, formatAckLine } = require('../modules/comms/ack-outcome');

describe('ack outcome collapse - did it land, answered by proof', () => {
  test('recorded receipt = delivered, receipt id carried', () => {
    const outcome = classifyAckOutcome({
      ok: true,
      delivered: false,
      attemptsUsed: 1,
      ack: {
        status: 'accepted.daemon_pty_unverified',
        modelPromptReceipt: { deliveryId: 'hm-123', messageId: 'hm-123', status: 'prompt_submitted.in_band' },
      },
    });
    expect(outcome.state).toBe('delivered');
    expect(outcome.proof).toBe('receipt');
    expect(outcome.receiptId).toBe('hm-123');
    // Forensics survive the collapse.
    expect(outcome.rawStatus).toBe('accepted.daemon_pty_unverified');
  });

  test('in-band prompt-submit status = delivered even without receipt object', () => {
    const outcome = classifyAckOutcome({
      ok: true,
      ack: { status: 'prompt_submitted.in_band' },
      attemptsUsed: 1,
    });
    expect(outcome.state).toBe('delivered');
    expect(outcome.proof).toBe('receipt');
  });

  test('ledger route proof = delivered via ledger', () => {
    const outcome = classifyAckOutcome({
      ok: true,
      ack: { status: 'routed' },
      ledgerRouteProof: { proofConfirmed: true },
    });
    expect(outcome.state).toBe('delivered');
    expect(outcome.proof).toBe('ledger');
  });

  test('every legacy accepted-shape collapses to pending, raw status kept', () => {
    for (const status of ['accepted.unverified', 'accepted.daemon_pty_unverified', 'materialized.pointer_fallback', 'routed']) {
      const outcome = classifyAckOutcome({ ok: true, delivered: false, ack: { status } });
      expect(outcome.state).toBe('pending');
      expect(outcome.rawStatus).toBe(status);
    }
  });

  test('unrecognized accepted status stays pending - never inflated to delivered', () => {
    const outcome = classifyAckOutcome({ ok: true, ack: { status: 'accepted.future_shape_v9' } });
    expect(outcome.state).toBe('pending');
  });

  test('transport failure = failed', () => {
    expect(classifyAckOutcome({ ok: false, ack: { status: 'daemon_not_connected' } }).state).toBe('failed');
    expect(classifyAckOutcome({}).state).toBe('failed');
  });

  test('format: three shapes, one line each, forensics parenthesized', () => {
    const delivered = formatAckLine('oracle', 'msg...', {
      state: 'delivered', proof: 'receipt', receiptId: 'hm-9', rawStatus: 'prompt_submitted.in_band', attempt: 1,
    });
    expect(delivered).toBe('delivered to oracle (receipt hm-9, attempt 1): msg...');

    const pending = formatAckLine('architect', 'msg...', {
      state: 'pending', proof: null, receiptId: null, rawStatus: 'materialized.pointer_fallback', attempt: 2,
    });
    expect(pending).toContain('pending at architect (materialized.pointer_fallback, attempt 2');
    expect(pending).toContain('no proof yet');

    const failed = formatAckLine('builder', 'msg...', {
      state: 'failed', proof: null, receiptId: null, rawStatus: 'daemon_not_connected', attempt: null,
    });
    expect(failed).toBe('failed at builder (daemon_not_connected): msg...');
  });
});
