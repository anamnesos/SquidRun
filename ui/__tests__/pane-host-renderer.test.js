const { _internals } = require('../pane-host-renderer');

describe('pane-host-renderer internals', () => {
  // SYSTEM INVARIANT: agent-message injection paths must NEVER prepend
  // terminal-control sequences (\x1b[H cursor-home, etc). These tests guard
  // the invariant — any future regression that re-adds Home will fail here.
  // See workspace/knowledge/workflows.md "Inject Path Invariant".

  test('hm-send hidden-host writes go through chunked PTY path with NO Home prefix', () => {
    expect(
      _internals.buildPtyWriteDispatchPlan({
        text: 'small hm-send payload',
        payloadBytes: Buffer.byteLength('small hm-send payload', 'utf8'),
        hmSendTrace: true,
        hasChunkedWriter: true,
        chunkThresholdBytes: 1024,
        chunkSizeBytes: 256,
        hmSendChunkThresholdBytes: 256,
        hmSendChunkYieldEveryChunks: 1,
      })
    ).toEqual(expect.objectContaining({
      method: 'chunked',
      forceChunkedWrite: true,
      writeText: 'small hm-send payload',
      chunkOptions: expect.objectContaining({
        chunkSize: 256,
        yieldEveryChunks: 1,
      }),
    }));
  });

  test('reassembled IPC payloads stay chunked without Home prefix', () => {
    expect(
      _internals.buildPtyWriteDispatchPlan({
        text: 'reassembled hidden host payload',
        payloadBytes: Buffer.byteLength('reassembled hidden host payload', 'utf8'),
        hmSendTrace: false,
        ipcReassembled: true,
        hasChunkedWriter: true,
        chunkThresholdBytes: 1024,
        chunkSizeBytes: 256,
        hmSendChunkThresholdBytes: 256,
        hmSendChunkYieldEveryChunks: 1,
      })
    ).toEqual(expect.objectContaining({
      method: 'chunked',
      forceChunkedWrite: true,
      writeText: 'reassembled hidden host payload',
      chunkOptions: expect.objectContaining({
        chunkSize: 256,
        yieldEveryChunks: 1,
      }),
    }));
  });

  test('REGRESSION: preserves user message head after IPC reassembly', () => {
    const userMessage = 'its kinda hard to look at a 24 hour graph and be like oh loook its gona dump big big in 24 hours.. lets get agead.. while that shit fluctuates 5-10 percent in between.. how many stop losses can we survive int aht time span? whats a more realistic number this thing will pump to and should we wait and watch? i havent been watching YGG at all. but from history this thing dumps then pumps higher .. dumps pumps higher over the last couple days.. the peak at around 0.452 around there is that the top ? or will this thing keep pumping.. sure maybe it is.. maybe it keeps dumping. but yall entered at 0.0431 after it came down from 0.0452 and now its climbed back up toe 0.0444 .. the previous patterns say sadly that when we have bad entries in this specific coin yall are in, i see dumps that have longer red candles for a 5 minute candle.. so we have to watch and wait and see how far these candles if they do come do dump before showing signs of it turning around.. i jsut think the entry was kinda weird tbh and the 33 hour thing confused me even more.. yall were trupping out on my ape coin last night but placed a bet on something that needs to hold up for 33 hours is fine but are you guys just placing hte  bets all sloppy and going off what should happen in such a big time frame is confusing to me';
    const plan = _internals.buildPtyWriteDispatchPlan({
      text: userMessage,
      payloadBytes: Buffer.byteLength(userMessage, 'utf8'),
      hmSendTrace: false,
      ipcReassembled: true,
      hasChunkedWriter: true,
      chunkThresholdBytes: 1024,
      chunkSizeBytes: 256,
      hmSendChunkThresholdBytes: 256,
      hmSendChunkYieldEveryChunks: 1,
    });

    expect(userMessage.length).toBeGreaterThan(1024);
    expect(userMessage.slice(1041)).toMatch(/^me even more/);
    expect(plan.method).toBe('chunked');
    expect(plan.writeText).toBe(userMessage);
    expect(plan.writeText).not.toMatch(/^\x1b\[H/);
    expect(plan.writeText.startsWith('its kinda hard to look at')).toBe(true);
    expect(plan.writeText).toContain('confusing to me');
  });

  test('REGRESSION: long routed hm-send payload preserves head AND has NO Home prefix', () => {
    const rawPayload = '[AGENT MSG - reply via hm-send.js] (ORACLE #11): '
      + `${'X'.repeat(5000)}`
      + '\n[CURRENT PROJECT] name=squidrun | path=D:\\projects\\squidrun';
    const strippedPayload = _internals.stripInternalRoutingWrappers(rawPayload);
    const plan = _internals.buildPtyWriteDispatchPlan({
      text: strippedPayload,
      payloadBytes: Buffer.byteLength(strippedPayload, 'utf8'),
      hmSendTrace: true,
      hasChunkedWriter: true,
      chunkThresholdBytes: 1024,
      chunkSizeBytes: 256,
      hmSendChunkThresholdBytes: 256,
      hmSendChunkYieldEveryChunks: 1,
    });

    expect(strippedPayload.startsWith('(ORACLE #11): ')).toBe(true);
    expect(plan).toEqual(expect.objectContaining({
      method: 'chunked',
      forceChunkedWrite: true,
      forceChunkForHmSend: true,
      writeText: strippedPayload,
      chunkOptions: expect.objectContaining({
        chunkSize: 256,
        yieldEveryChunks: 1,
      }),
    }));
    expect(plan.writeText).not.toMatch(/^\x1b\[H/);
    expect(plan.writeText.startsWith('(ORACLE #11): ')).toBe(true);
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
