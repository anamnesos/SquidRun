const {
  buildSpineOverlaySnapshot,
  fetchHyperliquidReadOnlySnapshot,
  extractAttributionPositions,
  supportedScorerSignals,
  TRADING_PARKED_REASON,
} = require('../modules/main/spine-overlay-snapshot');
const {
  createSpineOverlayWindow,
  FORCED_WEB_PREFERENCES,
} = require('../modules/main/spine-overlay-window');
const { isAllowedInvokeChannel } = require('../modules/bridge/channel-policy');
const {
  normalizeAction,
  executeAppControlAction,
} = require('../modules/main/app-control-service');

describe('spine overlay v0', () => {
  test('parks trading even when a live Hyperliquid position is supplied', () => {
    const nowMs = Date.parse('2026-06-22T09:40:00.000Z');
    const snapshot = buildSpineOverlaySnapshot({
      nowMs,
      glanceAtMs: nowMs - 30 * 60 * 1000,
      supervisorRead: {
        ok: true,
        filePath: 'runtime/crypto-trading-supervisor-state.json',
        data: {},
      },
      attributionRead: {
        ok: true,
        filePath: 'runtime/agent-position-attribution.json',
        data: { positions: {} },
      },
      nativeRead: { ok: true, filePath: 'runtime/hyperliquid-native-state.json', data: {} },
      liveRead: {
        ok: true,
        checkedAt: new Date(nowMs).toISOString(),
        source: 'https://api.hyperliquid.xyz/info',
        data: {
          clearinghouseState: {
            marginSummary: { accountValue: '410.403915' },
            assetPositions: [{
              position: {
                coin: 'ETH',
                szi: '-0.21',
                entryPx: '2105.2',
                liquidationPx: '2600',
                positionValue: '504',
              },
            }],
          },
          allMids: { ETH: '2400' },
          openOrders: [],
        },
      },
      trustQuoteRead: {
        ok: true,
        source: 'live',
        checkedAt: new Date(nowMs).toISOString(),
        root: 'D:\\projects\\TrustQuote',
        data: { parkedCount: 0, signals: [] },
      },
    });

    expect(snapshot).toEqual(expect.objectContaining({
      regretScore: 0,
      context: 'work-life:none',
      speak: false,
      source: 'live',
      claim: 'No interrupt earned.',
      whyNow: expect.stringContaining('Trading is parked'),
      proposedAction: expect.objectContaining({
        reversible: true,
        executionMode: 'dry-run',
      }),
      swallowed: expect.any(Array),
      safety: expect.objectContaining({
        readOnly: true,
        executionChannels: [],
      }),
    }));
    expect(snapshot.live).toEqual(expect.objectContaining({
      ok: true,
      positionCount: 0,
      tradingParked: true,
    }));
    expect(snapshot.swallowed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        signal: 'trading:hyperliquid',
        reason: TRADING_PARKED_REASON,
      }),
    ]));
    expect(snapshot.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'trading_hyperliquid',
        reason: TRADING_PARKED_REASON,
        speakEligible: false,
      }),
    ]));
    expect(snapshot.sources.some((source) => source.label === 'hl_live_read')).toBe(false);
  });

  test('keeps quiet and ignores stale attribution while trading is parked', () => {
    const nowMs = Date.parse('2026-06-22T09:40:00.000Z');
    const snapshot = buildSpineOverlaySnapshot({
      nowMs,
      supervisorRead: {
        ok: true,
        filePath: 'runtime/crypto-trading-supervisor-state.json',
        data: {},
      },
      attributionRead: {
        ok: true,
        filePath: 'runtime/agent-position-attribution.json',
        data: {
          positions: {
            'XYZ:HOOD/USD': {
              ticker: 'XYZ:HOOD/USD',
              direction: 'SHORT',
              currentSize: 62.9,
              entryPrice: 73.028,
              lastLiveSeenAt: '2026-05-01T08:09:47.868Z',
            },
          },
        },
      },
      nativeRead: { ok: true, filePath: 'runtime/hyperliquid-native-state.json', data: {} },
      liveRead: {
        ok: true,
        checkedAt: new Date(nowMs).toISOString(),
        source: 'https://api.hyperliquid.xyz/info',
        data: {
          clearinghouseState: { marginSummary: { accountValue: '0.0' }, assetPositions: [] },
          allMids: {},
          openOrders: [],
        },
      },
    });

    expect(snapshot.speak).toBe(false);
    expect(snapshot.regretScore).toBe(0);
    expect(snapshot.context).toBe('work-life:none');
    expect(snapshot.live).toEqual(expect.objectContaining({ tradingParked: true, positionCount: 0 }));
    expect(snapshot.swallowed).toEqual(expect.arrayContaining([
      expect.objectContaining({ signal: 'trading:hyperliquid', reason: TRADING_PARKED_REASON }),
    ]));
    expect(snapshot.swallowed.some((entry) => String(entry.signal || '').startsWith('attribution:'))).toBe(false);
  });

  test('marks work/life scorer output unverified unless the signal explicitly earns live source', () => {
    const nowMs = Date.parse('2026-06-22T09:40:00.000Z');
    const snapshot = buildSpineOverlaySnapshot({
      nowMs,
      glanceAtMs: nowMs - 30 * 60 * 1000,
      supervisorRead: { ok: true, filePath: 'runtime/crypto-trading-supervisor-state.json', data: {} },
      attributionRead: { ok: true, filePath: 'runtime/agent-position-attribution.json', data: { positions: {} } },
      nativeRead: { ok: true, filePath: 'runtime/hyperliquid-native-state.json', data: {} },
      trustQuoteRead: {
        ok: true,
        source: 'live',
        checkedAt: new Date(nowMs).toISOString(),
        root: 'D:\\projects\\TrustQuote',
        data: {
          parkedCount: 0,
          signals: [{
            type: 'trustquote:invoice-aging',
            id: 'quotes:aging-quote:invoice-aging',
            source: '',
            observedAtMs: nowMs,
            rawRefs: { system: 'trustquote', collection: 'quotes', docId: 'aging-quote' },
            facts: {
              invoiceAmount: 36500,
              balanceDue: 36500,
              dueMs: nowMs - 66 * 86400000,
              documentType: 'job',
              isProposal: false,
              isPendingJob: true,
              status: 'unpaid',
              paymentReceivedMs: null,
              lastChasedMs: null,
              customerReachable: true,
            },
          }],
        },
      },
    });

    expect(snapshot.context).toBe('trustquote:invoice-aging');
    expect(snapshot.source).toBe('unverified');
  });

  test('renders widened MIND output from live TrustQuote facts without BODY judgment', () => {
    const nowMs = Date.parse('2026-06-22T16:55:00.000Z');
    const signals = [
      {
        type: 'trustquote:invoice-aging',
        id: 'quotes:aging-quote:invoice-aging',
        source: 'live',
        observedAtMs: nowMs,
        rawRefs: {
          system: 'trustquote',
          collection: 'quotes',
          docId: 'aging-quote',
          businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
          customerId: 'non-parked-customer',
          customerIdentityKey: 'trustquote:customer:non-parked-customer',
        },
            facts: {
              invoiceAmount: 36500,
              balanceDue: 36500,
              dueMs: nowMs - 66 * 86400000,
              documentType: 'job',
              isProposal: false,
              isPendingJob: true,
              status: 'unpaid',
              paymentReceivedMs: null,
              lastChasedMs: null,
          customerReachable: true,
        },
      },
      {
        type: 'trustquote:unknown-signal',
        id: 'quotes:aging-quote:unknown-signal',
        source: 'live',
        observedAtMs: nowMs,
        rawRefs: { docId: 'aging-quote' },
        facts: { jobValue: 36500 },
      },
    ];
    const snapshot = buildSpineOverlaySnapshot({
      nowMs,
      supervisorRead: { ok: true, filePath: 'runtime/crypto-trading-supervisor-state.json', data: {} },
      attributionRead: { ok: true, filePath: 'runtime/agent-position-attribution.json', data: { positions: {} } },
      nativeRead: { ok: true, filePath: 'runtime/hyperliquid-native-state.json', data: {} },
      liveRead: {
        ok: true,
        checkedAt: new Date(nowMs).toISOString(),
        source: 'https://api.hyperliquid.xyz/info',
        data: {
          clearinghouseState: { marginSummary: { accountValue: '0.0' }, assetPositions: [] },
          allMids: {},
          openOrders: [],
        },
      },
      trustQuoteRead: {
        ok: true,
        source: 'live',
        checkedAt: new Date(nowMs).toISOString(),
        root: 'D:\\projects\\TrustQuote',
        data: { parkedCount: 0, signals },
      },
    });

    expect(supportedScorerSignals(signals).map((signal) => signal.type)).toEqual(['trustquote:invoice-aging']);
    expect(snapshot).toEqual(expect.objectContaining({
      source: 'live',
      context: 'trustquote:invoice-aging',
      speak: true,
      claim: expect.stringContaining('Invoice for $36500'),
      proposedAction: expect.objectContaining({
        executionMode: 'dry-run',
        dryRunLabel: expect.stringContaining("don't send on my own"),
      }),
    }));
    expect(snapshot.live).toEqual(expect.objectContaining({
      trustQuoteOk: true,
      trustQuoteSignalCount: 1,
    }));
    expect(snapshot.swallowed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        signal: 'trustquote:unknown-signal',
        reason: expect.stringContaining('does not support'),
      }),
    ]));
  });

  test('passes job task completion signals through to the widened MIND', () => {
    const nowMs = Date.parse('2026-06-22T16:55:00.000Z');
    const signals = [{
      type: 'trustquote:job-tasks-incomplete',
      id: 'jobs:tasks-open:job-tasks-incomplete',
      source: 'live',
      observedAtMs: nowMs,
      rawRefs: {
        system: 'trustquote',
        collection: 'jobs',
        docId: 'tasks-open',
        businessId: 'zDPMRRIlMiVJBOMhBbqrMk2iMI72',
      },
      facts: {
        isProposal: false,
        tasksTotal: 2,
        tasksIncomplete: 1,
        jobValue: 800,
        jobStatus: 'billable',
        customerReachable: true,
      },
    }];

    expect(supportedScorerSignals(signals).map((signal) => signal.type)).toEqual(['trustquote:job-tasks-incomplete']);

    const snapshot = buildSpineOverlaySnapshot({
      nowMs,
      supervisorRead: { ok: true, filePath: 'runtime/crypto-trading-supervisor-state.json', data: {} },
      attributionRead: { ok: true, filePath: 'runtime/agent-position-attribution.json', data: { positions: {} } },
      nativeRead: { ok: true, filePath: 'runtime/hyperliquid-native-state.json', data: {} },
      trustQuoteRead: {
        ok: true,
        source: 'live',
        checkedAt: new Date(nowMs).toISOString(),
        root: 'D:\\projects\\TrustQuote',
        data: { parkedCount: 0, signals },
      },
    });

    expect(snapshot).toEqual(expect.objectContaining({
      source: 'live',
      context: 'trustquote:job-tasks-incomplete',
      speak: true,
      claim: expect.stringContaining("isn't finished"),
    }));
    expect(snapshot.live.trustQuoteSignalCount).toBe(1);
  });

  test('does not treat closed or zero-size attribution positions as open', () => {
    const positions = extractAttributionPositions({
      positions: {
        closed: { ticker: 'BTC/USD', currentSize: 1, closedAt: '2026-06-01T00:00:00Z' },
        flat: { ticker: 'ETH/USD', currentSize: 0 },
        open: { ticker: 'SOL/USD', currentSize: 2 },
      },
    });

    expect(positions).toEqual([expect.objectContaining({ ticker: 'SOL/USD' })]);
  });

  test('window factory is isolated, transparent, always-on-top, and keeps preload hardening', () => {
    const browserWindowCtor = jest.fn(function FakeBrowserWindow(options) {
      this.options = options;
      this.loadFile = jest.fn();
      this.setAlwaysOnTop = jest.fn();
      return this;
    });

    const { window: win, htmlPath, preloadPath, options } = createSpineOverlayWindow({
      BrowserWindow: browserWindowCtor,
      windowOptions: {
        webPreferences: { contextIsolation: false, nodeIntegration: true },
      },
    });

    expect(browserWindowCtor).toHaveBeenCalledTimes(1);
    expect(htmlPath).toMatch(/spine-overlay\.html$/);
    expect(preloadPath).toMatch(/preload\.js$/);
    expect(options).toEqual(expect.objectContaining({
      frame: false,
      transparent: true,
      alwaysOnTop: true,
    }));
    expect(options.webPreferences).toEqual(expect.objectContaining({
      ...FORCED_WEB_PREFERENCES,
      preload: preloadPath,
    }));
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
    expect(win.loadFile).toHaveBeenCalledWith(htmlPath);
  });

  test('control surfaces expose only the read snapshot/open-window path', async () => {
    expect(isAllowedInvokeChannel('spine-overlay:snapshot')).toBe(true);
    expect(isAllowedInvokeChannel('spine-overlay:execute')).toBe(false);
    expect(normalizeAction('alive-os')).toBe('open-spine-overlay');

    const openAppWindow = jest.fn(() => Promise.resolve({ ok: true, windowKey: 'spine-overlay' }));
    const result = await executeAppControlAction({ openAppWindow }, 'open-spine-overlay', {});

    expect(openAppWindow).toHaveBeenCalledWith('spine-overlay', {});
    expect(result).toEqual(expect.objectContaining({
      success: true,
      action: 'open-spine-overlay',
      windowKey: 'spine-overlay',
    }));
  });

  test('live Hyperliquid reader is read-only public info calls only', async () => {
    const calls = [];
    const fetchImpl = jest.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const body = calls.length === 1
        ? { marginSummary: { accountValue: '0.0' }, assetPositions: [] }
        : (calls.length === 2 ? {} : []);
      return {
        ok: true,
        text: async () => JSON.stringify(body),
      };
    });

    const live = await fetchHyperliquidReadOnlySnapshot({
      walletAddress: '0xabc',
      fetchImpl,
    });

    expect(live.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(calls.map((call) => call.body.type)).toEqual([
      'clearinghouseState',
      'allMids',
      'openOrders',
    ]);
  });
});
