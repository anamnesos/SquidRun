const mockListTransitions = jest.fn();
const mockGetTransition = jest.fn();
const mockGetByCorrelation = jest.fn();
const mockGetStats = jest.fn();

jest.mock('../modules/transition-ledger', () => ({
  listTransitions: (...args) => mockListTransitions(...args),
  getTransition: (...args) => mockGetTransition(...args),
  getByCorrelation: (...args) => mockGetByCorrelation(...args),
  getStats: (...args) => mockGetStats(...args),
}));

const {
  TRANSITION_LEDGER_CHANNEL_ACTIONS,
  executeTransitionLedgerOperation,
  registerTransitionLedgerHandlers,
  unregisterTransitionLedgerHandlers,
} = require('../modules/ipc/transition-ledger-handlers');

describe('transition-ledger IPC handlers', () => {
  let ipcMain;
  let ctx;

  beforeEach(() => {
    mockListTransitions.mockReset();
    mockGetTransition.mockReset();
    mockGetByCorrelation.mockReset();
    mockGetStats.mockReset();

    mockListTransitions.mockReturnValue([]);
    mockGetTransition.mockReturnValue(null);
    mockGetByCorrelation.mockReturnValue(null);
    mockGetStats.mockReturnValue({ created: 3, active: 1, totalStored: 3 });

    ipcMain = {
      handle: jest.fn(),
      removeHandler: jest.fn(),
    };
    ctx = { ipcMain };
  });

  test('registers all transition-ledger channels', () => {
    registerTransitionLedgerHandlers(ctx);

    expect(ipcMain.handle).toHaveBeenCalledTimes(TRANSITION_LEDGER_CHANNEL_ACTIONS.size);
    for (const [channel] of TRANSITION_LEDGER_CHANNEL_ACTIONS.entries()) {
      expect(ipcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function));
    }
  });

  test('list channel forwards filters and returns list payload', async () => {
    mockListTransitions.mockReturnValue([{ transitionId: 'tr-1' }]);
    registerTransitionLedgerHandlers(ctx);
    const listHandler = ipcMain.handle.mock.calls.find(([channel]) => channel === 'transition-ledger:list')[1];

    const result = await listHandler({}, {
      paneId: '2',
      includeClosed: false,
      phase: 'verifying',
      limit: 5,
    });

    expect(mockListTransitions).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: '2',
        includeClosed: false,
        phase: 'verifying',
        limit: 5,
      })
    );
    expect(result).toEqual({
      ok: true,
      action: 'list',
      count: 1,
      items: [{ transitionId: 'tr-1' }],
    });
  });

  test('get-by-id returns missing_transition_id when id is absent', async () => {
    registerTransitionLedgerHandlers(ctx);
    const getHandler = ipcMain.handle.mock.calls.find(([channel]) => channel === 'transition-ledger:get-by-id')[1];
    const result = await getHandler({}, {});

    expect(result).toEqual({
      ok: false,
      action: 'getById',
      reason: 'missing_transition_id',
    });
    expect(mockGetTransition).not.toHaveBeenCalled();
  });

  test('get-by-id returns transition when found', async () => {
    mockGetTransition.mockReturnValue({ transitionId: 'tr-xyz', phase: 'verified' });
    registerTransitionLedgerHandlers(ctx);
    const getHandler = ipcMain.handle.mock.calls.find(([channel]) => channel === 'transition-ledger:get-by-id')[1];
    const result = await getHandler({}, { id: 'tr-xyz' });

    expect(mockGetTransition).toHaveBeenCalledWith('tr-xyz');
    expect(result).toEqual({
      ok: true,
      action: 'getById',
      transitionId: 'tr-xyz',
      transition: { transitionId: 'tr-xyz', phase: 'verified' },
    });
  });

  test('get-by-correlation includes pane and includeClosed options', async () => {
    mockGetByCorrelation.mockReturnValue({ transitionId: 'tr-corr', correlationId: 'corr-1' });
    registerTransitionLedgerHandlers(ctx);
    const getHandler = ipcMain.handle.mock.calls.find(([channel]) => channel === 'transition-ledger:get-by-correlation')[1];

    const result = await getHandler({}, {
      correlationId: 'corr-1',
      paneId: '5',
      includeClosed: false,
    });

    expect(mockGetByCorrelation).toHaveBeenCalledWith('corr-1', '5', { includeClosed: false });
    expect(result).toEqual({
      ok: true,
      action: 'getByCorrelation',
      correlationId: 'corr-1',
      paneId: '5',
      transition: { transitionId: 'tr-corr', correlationId: 'corr-1' },
    });
  });

  test('get-stats returns current transition-ledger stats', async () => {
    registerTransitionLedgerHandlers(ctx);
    const statsHandler = ipcMain.handle.mock.calls.find(([channel]) => channel === 'transition-ledger:get-stats')[1];
    const result = await statsHandler({}, {});

    expect(mockGetStats).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      action: 'getStats',
      stats: { created: 3, active: 1, totalStored: 3 },
    });
  });

  test('executeTransitionLedgerOperation returns unknown_action for invalid action', () => {
    const result = executeTransitionLedgerOperation('invalid-action', {});
    expect(result).toEqual({
      ok: false,
      reason: 'unknown_action',
      action: 'invalid-action',
    });
  });

  test('unregister removes all transition-ledger channels', () => {
    unregisterTransitionLedgerHandlers(ctx);
    for (const [channel] of TRANSITION_LEDGER_CHANNEL_ACTIONS.entries()) {
      expect(ipcMain.removeHandler).toHaveBeenCalledWith(channel);
    }
  });
});
