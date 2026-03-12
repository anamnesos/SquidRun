describe('pane-host-window-manager query defaults', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.SQUIDRUN_PANE_HOST_HM_SEND_CHUNK_THRESHOLD_BYTES;
    delete process.env.SQUIDRUN_PANE_HOST_CHUNK_THRESHOLD_BYTES;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('defaults hm-send chunk threshold to 1024 bytes', () => {
    const { _internals } = require('../modules/main/pane-host-window-manager');

    const query = _internals.buildPaneHostQueryFromEnv('1');

    expect(query).toEqual(expect.objectContaining({
      paneId: '1',
      chunkThresholdBytes: '4096',
      hmSendChunkThresholdBytes: '1024',
    }));
  });

  test('honors explicit hm-send chunk threshold override', () => {
    process.env.SQUIDRUN_PANE_HOST_HM_SEND_CHUNK_THRESHOLD_BYTES = '1536';
    const { _internals } = require('../modules/main/pane-host-window-manager');

    const query = _internals.buildPaneHostQueryFromEnv('3');

    expect(query.hmSendChunkThresholdBytes).toBe('1536');
  });
});
