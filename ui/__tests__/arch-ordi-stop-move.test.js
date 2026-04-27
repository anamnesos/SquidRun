'use strict';

const archOrdiStopMove = require('../scripts/arch-ordi-stop-move');

describe('arch-ordi-stop-move', () => {
  test('resolveStopOrderIdsToCancel prefers the audited stop oid when present', () => {
    expect(archOrdiStopMove.resolveStopOrderIdsToCancel({
      auditStopOrderId: 393948579664,
      liveStopOrders: [
        { oid: 393943072354, price: 4.3361 },
        { oid: 393948579664, price: 4.35 },
      ],
    })).toEqual([393948579664]);
  });

  test('findLiveStopOrders classifies short-side reduce-only stops without relying on orderType', () => {
    expect(archOrdiStopMove.findLiveStopOrders(
      { coin: 'ORDI', szi: '-86.99', entryPx: '4.3084' },
      [
        { coin: 'ORDI', oid: 1, reduceOnly: true, triggerPx: '4.3361' },
        { coin: 'ORDI', oid: 2, reduceOnly: true, triggerPx: '4.009' },
        { coin: 'ORDI', oid: 3, reduceOnly: false, limitPx: '4.4' },
      ]
    )).toEqual([
      expect.objectContaining({ oid: 1, price: 4.3361 }),
    ]);
  });
});
