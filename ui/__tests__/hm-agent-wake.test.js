'use strict';

const { parseDeliveryProof } = require('../scripts/hm-agent-wake');

describe('hm-agent-wake delivery proof', () => {
  test('accepts the legacy routed-ledger output', () => {
    expect(parseDeliveryProof('routed to builder, row: 83503', 'builder')).toEqual({
      proof: 'ledger',
      ledgerRow: 83503,
    });
  });

  test('accepts the current target-bound routed-ledger output', () => {
    expect(parseDeliveryProof(
      'Route proof confirmed for builder: wake (ack: routed_unverified, route: routed, row: 83504, attempt 1). Visible delivery is not claimed.',
      'builder',
    )).toEqual({
      proof: 'ledger',
      ledgerRow: 83504,
    });
  });

  test('accepts a receipt-backed delivered line with no exposed receipt id', () => {
    expect(parseDeliveryProof(
      'delivered to builder (receipt recorded, attempt 1): [PERSONAL WAKE — builder]',
      'builder',
    )).toEqual({ proof: 'prompt_receipt' });
  });

  test('retains a receipt id when hm-send exposes one', () => {
    expect(parseDeliveryProof(
      'delivered to oracle (receipt hm-1787649421766-k82fem, attempt 1): wake',
      'oracle',
    )).toEqual({
      proof: 'prompt_receipt',
      receiptId: 'hm-1787649421766-k82fem',
    });
  });

  test('accepts the formatted ledger proof line', () => {
    expect(parseDeliveryProof(
      'delivered to architect (ledger row 86872, attempt 1): wake',
      'architect',
    )).toEqual({
      proof: 'ledger',
      ledgerRow: 86872,
    });
  });

  test('rejects a delivery for another agent', () => {
    expect(parseDeliveryProof(
      'delivered to oracle (receipt recorded, attempt 1): wake',
      'builder',
    )).toBeNull();
    expect(parseDeliveryProof(
      'routed to oracle, row: 83503',
      'builder',
    )).toBeNull();
    expect(parseDeliveryProof(
      'Route proof confirmed for oracle: wake (ack: routed_unverified, route: routed, row: 83504, attempt 1). Visible delivery is not claimed.',
      'builder',
    )).toBeNull();
  });

  test('rejects pending and failed output even when it contains a row', () => {
    expect(parseDeliveryProof(
      'pending at builder (accepted.unverified, row: 83505, attempt 1; no proof yet - the ledger holds it): wake',
      'builder',
    )).toBeNull();
    expect(parseDeliveryProof(
      'failed at builder (connection_refused, row: 83506, attempt 1): wake',
      'builder',
    )).toBeNull();
    expect(parseDeliveryProof(
      'Route proof confirmed for builder: wake (ack: missing_ack, route: failed, row: 83507, attempt 1). Visible delivery is not claimed.',
      'builder',
    )).toBeNull();
  });
});
