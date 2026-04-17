const {
  createPtyOutputFilter,
  INTERNAL_SENTINEL,
  getUtf8ByteLength,
} = require('../modules/main/pty-output-filter');

describe('pty-output-filter', () => {
  test('releases visible PTY data after a matching kernel event budget arrives', () => {
    const filter = createPtyOutputFilter({ holdMs: 1000 });

    filter.ingest('1', 'hello', 0);
    expect(filter.releaseReady('1', { now: 10 })).toEqual([]);

    filter.applyKernelEvent({
      type: 'pty.data.received',
      paneId: '1',
      payload: { byteLen: getUtf8ByteLength('hello') },
      kernelMeta: null,
    });

    expect(filter.releaseReady('1', { now: 20 })).toEqual([
      { paneId: '1', text: 'hello' },
    ]);
  });

  test('suppresses internal PTY data when kernel visibility is internal', () => {
    const filter = createPtyOutputFilter({ holdMs: 1000 });

    filter.ingest('1', 'secret', 0);
    filter.applyKernelEvent({
      type: 'pty.data.received',
      paneId: '1',
      payload: { byteLen: getUtf8ByteLength('secret') },
      kernelMeta: { meta: { visibility: 'internal' } },
    });

    expect(filter.releaseReady('1', { now: 20 })).toEqual([]);
  });

  test('falls back to releasing unmatched PTY data after the hold window expires', () => {
    const filter = createPtyOutputFilter({ holdMs: 50 });

    filter.ingest('1', 'tail', 0);
    expect(filter.releaseReady('1', { now: 25 })).toEqual([]);
    expect(filter.releaseReady('1', { now: 75 })).toEqual([
      { paneId: '1', text: 'tail' },
    ]);
  });

  test('suppresses sentinel-prefixed internal lines across chunk boundaries', () => {
    const filter = createPtyOutputFilter({ holdMs: 1000 });
    const hiddenLine = `${INTERNAL_SENTINEL} hidden coordination\n`;
    const visibleLine = 'visible output';

    filter.ingest('1', hiddenLine.slice(0, 9), 0);
    filter.ingest('1', hiddenLine.slice(9) + visibleLine, 1);
    filter.applyKernelEvent({
      type: 'pty.data.received',
      paneId: '1',
      payload: { byteLen: getUtf8ByteLength(hiddenLine + visibleLine) },
      kernelMeta: null,
    });

    expect(filter.releaseReady('1', { now: 10 })).toEqual([
      { paneId: '1', text: visibleLine },
    ]);
  });

  test('classifies multibyte UTF-8 byte budgets without corrupting later visible text', () => {
    const filter = createPtyOutputFilter({ holdMs: 1000 });

    filter.ingest('1', '🙂abc', 0);
    filter.applyKernelEvent({
      type: 'pty.data.received',
      paneId: '1',
      payload: { byteLen: getUtf8ByteLength('🙂') },
      kernelMeta: { meta: { visibility: 'internal' } },
    });
    filter.applyKernelEvent({
      type: 'pty.data.received',
      paneId: '1',
      payload: { byteLen: getUtf8ByteLength('abc') },
      kernelMeta: null,
    });

    expect(filter.releaseReady('1', { now: 10 })).toEqual([
      { paneId: '1', text: 'abc' },
    ]);
  });
});
