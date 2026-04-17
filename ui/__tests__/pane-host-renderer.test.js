const { _internals } = require('../pane-host-renderer');

describe('pane-host-renderer internals', () => {
  test('forces hm-send hidden-host writes onto the chunked PTY path', () => {
    expect(
      _internals.buildPtyWriteDispatchPlan({
        text: 'small hm-send payload',
        payloadBytes: Buffer.byteLength('small hm-send payload', 'utf8'),
        hmSendTrace: true,
        hasChunkedWriter: true,
        homeResetBeforeWrite: true,
        chunkThresholdBytes: 1024,
        chunkSizeBytes: 4096,
        hmSendChunkThresholdBytes: 256,
        hmSendChunkYieldEveryChunks: 0,
      })
    ).toEqual(expect.objectContaining({
      method: 'chunked',
      forceChunkedWrite: true,
      writeText: '\x1b[Hsmall hm-send payload',
      chunkOptions: expect.objectContaining({
        chunkSize: 4096,
        yieldEveryChunks: 0,
      }),
    }));
  });

  test('forces reassembled IPC payloads onto the chunked PTY path', () => {
    expect(
      _internals.buildPtyWriteDispatchPlan({
        text: 'reassembled hidden host payload',
        payloadBytes: Buffer.byteLength('reassembled hidden host payload', 'utf8'),
        hmSendTrace: false,
        ipcReassembled: true,
        hasChunkedWriter: true,
        homeResetBeforeWrite: true,
        chunkThresholdBytes: 1024,
        chunkSizeBytes: 4096,
        hmSendChunkThresholdBytes: 256,
        hmSendChunkYieldEveryChunks: 0,
      })
    ).toEqual(expect.objectContaining({
      method: 'chunked',
      forceChunkedWrite: true,
      writeText: '\x1b[Hreassembled hidden host payload',
      chunkOptions: expect.objectContaining({
        chunkSize: 4096,
        yieldEveryChunks: 0,
      }),
    }));
  });

  test('keeps full routed hm-send payload intact for long chunked writes', () => {
    const rawPayload = '[AGENT MSG - reply via hm-send.js] (ORACLE #11): '
      + `${'X'.repeat(5000)}`
      + '\n[CURRENT PROJECT] name=squidrun | path=D:\\projects\\squidrun';
    const strippedPayload = _internals.stripInternalRoutingWrappers(rawPayload);
    const plan = _internals.buildPtyWriteDispatchPlan({
      text: strippedPayload,
      payloadBytes: Buffer.byteLength(strippedPayload, 'utf8'),
      hmSendTrace: true,
      hasChunkedWriter: true,
      homeResetBeforeWrite: true,
      chunkThresholdBytes: 1024,
      chunkSizeBytes: 4096,
      hmSendChunkThresholdBytes: 256,
      hmSendChunkYieldEveryChunks: 0,
    });

    expect(strippedPayload.startsWith('(ORACLE #11): ')).toBe(true);
    expect(plan).toEqual(expect.objectContaining({
      method: 'chunked',
      forceChunkedWrite: true,
      forceChunkForHmSend: true,
      writeText: '\x1b[H' + strippedPayload,
      chunkOptions: expect.objectContaining({
        chunkSize: 4096,
        yieldEveryChunks: 0,
      }),
    }));
    expect(plan.writeText).toContain('\n[CURRENT PROJECT] name=squidrun | path=D:\\projects\\squidrun');
  });

  test('keeps direct PTY writes only for non-hm-send small payloads', () => {
    expect(
      _internals.buildPtyWriteDispatchPlan({
        text: 'plain short payload',
        payloadBytes: Buffer.byteLength('plain short payload', 'utf8'),
        hmSendTrace: false,
        ipcReassembled: false,
        hasChunkedWriter: true,
        chunkThresholdBytes: 1024,
        chunkSizeBytes: 4096,
        hmSendChunkThresholdBytes: 256,
        hmSendChunkYieldEveryChunks: 0,
      })
    ).toEqual(expect.objectContaining({
      method: 'direct',
      forceChunkedWrite: false,
      chunkOptions: null,
    }));
  });

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
