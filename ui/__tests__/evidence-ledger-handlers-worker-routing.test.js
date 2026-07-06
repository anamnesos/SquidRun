jest.mock('../modules/ipc/evidence-ledger-worker-client', () => ({
  initializeRuntime: jest.fn(async () => ({ ok: true, status: { driver: 'worker' } })),
  executeOperation: jest.fn(async () => ({ ok: true, source: 'worker' })),
  closeRuntime: jest.fn(async () => undefined),
}));

jest.mock('../modules/ipc/evidence-ledger-runtime', () => ({
  createEvidenceLedgerRuntime: jest.fn(),
  initializeEvidenceLedgerRuntime: jest.fn(() => ({ ok: true, status: { driver: 'in-process' } })),
  executeEvidenceLedgerOperation: jest.fn(() => ({ ok: true, source: 'in-process' })),
  closeSharedRuntime: jest.fn(),
}));

const workerClient = require('../modules/ipc/evidence-ledger-worker-client');
const runtime = require('../modules/ipc/evidence-ledger-runtime');
const {
  registerEvidenceLedgerHandlers,
  initializeEvidenceLedgerRuntime,
  executeEvidenceLedgerOperation,
  closeSharedRuntime,
  unregisterEvidenceLedgerHandlers,
} = require('../modules/ipc/evidence-ledger-handlers');

describe('evidence-ledger handlers worker routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses worker broker by default', async () => {
    const result = await executeEvidenceLedgerOperation('get-context', {}, {});

    expect(result).toEqual({ ok: true, source: 'worker' });
    expect(workerClient.executeOperation).toHaveBeenCalledWith(
      'get-context',
      {},
      expect.objectContaining({
        source: {},
      }),
    );
    expect(runtime.executeEvidenceLedgerOperation).not.toHaveBeenCalled();
  });

  test('routes prune through the worker broker by default', async () => {
    const result = await executeEvidenceLedgerOperation('prune', { maxRows: 10 }, {
      source: { via: 'evidence-ledger-housekeeping', role: 'system' },
    });

    expect(result).toEqual({ ok: true, source: 'worker' });
    expect(workerClient.executeOperation).toHaveBeenCalledWith(
      'prune',
      { maxRows: 10 },
      expect.objectContaining({
        source: { via: 'evidence-ledger-housekeeping', role: 'system' },
      }),
    );
    expect(runtime.executeEvidenceLedgerOperation).not.toHaveBeenCalled();
  });

  test('uses in-process runtime when deps inject createEvidenceLedgerRuntime', async () => {
    const injectedFactory = jest.fn();
    const result = await executeEvidenceLedgerOperation('get-context', {}, {
      deps: { createEvidenceLedgerRuntime: injectedFactory },
      source: { via: 'ipc', role: 'system' },
    });

    expect(result).toEqual({ ok: true, source: 'in-process' });
    expect(runtime.executeEvidenceLedgerOperation).toHaveBeenCalledWith(
      'get-context',
      {},
      expect.objectContaining({
        deps: expect.objectContaining({ createEvidenceLedgerRuntime: injectedFactory }),
      }),
    );
    expect(workerClient.executeOperation).not.toHaveBeenCalled();
  });

  test('returns degraded init status when worker init throws', async () => {
    workerClient.initializeRuntime.mockRejectedValueOnce(new Error('worker init failed'));

    const result = await initializeEvidenceLedgerRuntime({});

    expect(result.ok).toBe(false);
    expect(result.initResult.reason).toBe('worker_error');
    expect(result.status.driver).toBe('worker');
  });

  test('closeSharedRuntime closes local runtime and worker', async () => {
    closeSharedRuntime();

    expect(runtime.closeSharedRuntime).toHaveBeenCalled();
    expect(workerClient.closeRuntime).toHaveBeenCalled();
  });

  test('unregister skips runtime close during handler re-register', () => {
    const ctx = {
      ipcMain: {
        removeHandler: jest.fn(),
      },
    };

    unregisterEvidenceLedgerHandlers(ctx, { __squidrunHandlerReregister: true });

    expect(ctx.ipcMain.removeHandler).toHaveBeenCalled();
    expect(runtime.closeSharedRuntime).not.toHaveBeenCalled();
    expect(workerClient.closeRuntime).not.toHaveBeenCalled();
  });

  test('registers prune ipc channel', () => {
    const ctx = {
      ipcMain: {
        handle: jest.fn(),
      },
    };

    registerEvidenceLedgerHandlers(ctx);

    expect(ctx.ipcMain.handle).toHaveBeenCalledWith('evidence-ledger:prune', expect.any(Function));
  });
});
