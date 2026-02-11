const path = require('path');

describe('evidence-ledger-store config gate', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock('../config');
    jest.dontMock('../modules/logger');
    jest.dontMock('node:sqlite');
  });

  test('degrades when evidenceLedgerEnabled config flag is false', () => {
    const warn = jest.fn();
    const error = jest.fn();
    const info = jest.fn();

    const realConfig = jest.requireActual('../config');
    jest.doMock('../config', () => ({
      ...realConfig,
      evidenceLedgerEnabled: false,
    }));
    jest.doMock('../modules/logger', () => ({ warn, error, info }));

    // eslint-disable-next-line global-require
    const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
    const store = new EvidenceLedgerStore({
      dbPath: path.join(__dirname, '..', '..', 'workspace', 'runtime', 'ledger-disabled-test.db'),
    });

    const first = store.init();
    const second = store.init();

    expect(first.ok).toBe(false);
    expect(first.reason).toBe('disabled');
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('disabled');
    expect(store.isAvailable()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  test('logs open failure only once and stays degraded', () => {
    const warn = jest.fn();
    const error = jest.fn();
    const info = jest.fn();

    const realConfig = jest.requireActual('../config');
    jest.doMock('../config', () => ({
      ...realConfig,
      evidenceLedgerEnabled: true,
    }));
    jest.doMock('../modules/logger', () => ({ warn, error, info }));
    jest.doMock('node:sqlite', () => ({
      DatabaseSync: jest.fn(() => {
        throw new Error('simulated db open failure');
      }),
    }));
    // eslint-disable-next-line global-require
    const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
    const store = new EvidenceLedgerStore({
      dbPath: path.join(__dirname, '..', '..', 'workspace', 'runtime', 'ledger-open-fail-test.db'),
    });

    const first = store.init();
    const second = store.init();

    expect(first.ok).toBe(false);
    expect(first.reason).toMatch(/^open_failed:/);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/^open_failed:/);
    expect(store.isAvailable()).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
