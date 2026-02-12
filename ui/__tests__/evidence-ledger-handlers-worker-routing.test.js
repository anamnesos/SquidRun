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
  initializeEvidenceLedgerRuntime,
  executeEvidenceLedgerOperation,
  closeSharedRuntime,
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
});
