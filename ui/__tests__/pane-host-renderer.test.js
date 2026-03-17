const { _internals } = require('../pane-host-renderer');

describe('pane-host-renderer internals', () => {
  test('keeps hm-send deliveries unverified when Enter succeeds without output', () => {
    expect(
      _internals.resolvePostEnterDeliveryResult({
        outputObserved: false,
        enterSucceeded: true,
      })
    ).toEqual({
      ack: false,
      outcome: {
        accepted: true,
        verified: false,
        status: 'accepted.unverified',
        reason: 'post_enter_output_timeout',
      },
    });
  });

  test('acks delivery only when post-enter output is observed', () => {
    expect(
      _internals.resolvePostEnterDeliveryResult({
        outputObserved: true,
        enterSucceeded: true,
      })
    ).toEqual({ ack: true });
  });

  test('reports delivery failure when Enter dispatch is rejected', () => {
    expect(
      _internals.resolvePostEnterDeliveryResult({
        outputObserved: false,
        enterSucceeded: false,
      })
    ).toEqual({
      ack: false,
      outcome: {
        accepted: false,
        verified: false,
        status: 'delivery_failed',
        reason: 'enter_dispatch_failed',
      },
    });
  });
});
