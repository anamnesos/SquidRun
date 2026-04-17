jest.mock('../scripts/hm-telegram', () => ({
  sendTelegram: jest.fn().mockResolvedValue({ ok: true, chatId: '5613428850', messageId: 123 }),
}));

jest.mock('../scripts/hm-agent-alert', () => ({
  DEFAULT_AGENT_TARGETS: ['architect', 'oracle'],
  normalizeTargets: jest.fn((value) => Array.isArray(value) ? value : String(value || '').split(',').map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)),
  sendAgentAlert: jest.fn(() => ({ ok: true, targets: ['architect', 'oracle'], results: [{ target: 'architect', ok: true }, { target: 'oracle', ok: true }] })),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { sendAgentAlert } = require('../scripts/hm-agent-alert');
const {
  parseStrategyPressEntries,
  parseSaylorTimelineEntries,
  parseStrategySec8KEntries,
  runWatcher,
} = require('../scripts/hm-saylor-watcher');

describe('hm-saylor-watcher', () => {
  test('parses Strategy press links into unique entries', () => {
    const html = [
      '<a href="/press/strategy-acquires-4871-btc-and-now-holds-766970-btc_04-06-2026">One</a>',
      '<a href="/press/strategy-acquires-4871-btc-and-now-holds-766970-btc_04-06-2026">Dup</a>',
      '<a href="/press/strategy-announces-fourth-quarter-2025-financial-results_02-05-2026">Two</a>',
    ].join('\n');

    expect(parseStrategyPressEntries(html)).toEqual([
      expect.objectContaining({
        id: 'press:strategy-acquires-4871-btc-and-now-holds-766970-btc_04-06-2026',
        url: 'https://www.strategy.com/press/strategy-acquires-4871-btc-and-now-holds-766970-btc_04-06-2026',
      }),
      expect.objectContaining({
        id: 'press:strategy-announces-fourth-quarter-2025-financial-results_02-05-2026',
      }),
    ]);
  });

  test('parses Saylor X syndication payload into tweet entries', () => {
    const html = [
      '<html><body>',
      '<script id="__NEXT_DATA__" type="application/json">',
      JSON.stringify({
        props: {
          pageProps: {
            timeline: {
              entries: [
                {
                  type: 'tweet',
                  content: {
                    tweet: {
                      id_str: '2040438683380146574',
                      created_at: 'Sat Apr 04 14:37:46 +0000 2026',
                      full_text: 'Bitcoin has won.',
                      permalink: '/saylor/status/2040438683380146574',
                    },
                  },
                },
              ],
            },
          },
        },
      }),
      '</script>',
      '</body></html>',
    ].join('');

    expect(parseSaylorTimelineEntries(html)).toEqual([
      expect.objectContaining({
        id: 'tweet:2040438683380146574',
        text: 'Bitcoin has won.',
        url: 'https://x.com/saylor/status/2040438683380146574',
      }),
    ]);
  });

  test('parses Strategy 8-K filings from EDGAR submissions JSON', () => {
    const payload = {
      cik: '0001050446',
      filings: {
        recent: {
          form: ['8-K', '10-Q'],
          accessionNumber: ['0001193125-26-123456', '0001193125-26-999999'],
          filingDate: ['2026-04-06', '2026-04-05'],
          primaryDocument: ['d123456d8k.htm', 'd999999d10q.htm'],
          primaryDocDescription: ['Current report', 'Quarterly report'],
        },
      },
    };

    expect(parseStrategySec8KEntries(payload)).toEqual([
      expect.objectContaining({
        id: 'sec:0001193125-26-123456',
        accessionNumber: '0001193125-26-123456',
        filingDate: '2026-04-06',
        primaryDocument: 'd123456d8k.htm',
      }),
    ]);
  });

  test('baseline run records latest items without alerting, second run alerts on new Strategy press item', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-saylor-watcher-'));
    const statePath = path.join(tempDir, 'saylor-watcher-state.json');
    const pressA = '<a href="/press/strategy-acquires-4871-btc-and-now-holds-766970-btc_04-06-2026">One</a>';
    const pressB = '<a href="/press/strategy-adds-1000-btc-and-now-holds-767970-btc_04-13-2026">Two</a>' + pressA;
    const xHtml = [
      '<script id="__NEXT_DATA__" type="application/json">',
      JSON.stringify({
        props: {
          pageProps: {
            timeline: {
              entries: [
                {
                  type: 'tweet',
                  content: {
                    tweet: {
                      id_str: '1',
                      created_at: 'Mon Apr 13 00:00:00 +0000 2026',
                      full_text: 'BTC',
                      permalink: '/saylor/status/1',
                    },
                  },
                },
              ],
            },
          },
        },
      }),
      '</script>',
    ].join('');
    const secPayload = {
      cik: '0001050446',
      filings: {
        recent: {
          form: ['8-K'],
          accessionNumber: ['0001193125-26-123456'],
          filingDate: ['2026-04-06'],
          primaryDocument: ['d123456d8k.htm'],
          primaryDocDescription: ['Current report'],
        },
      },
    };

    const firstFetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => pressA })
      .mockResolvedValueOnce({ ok: true, text: async () => xHtml })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(secPayload) });
    const first = await runWatcher({
      fetch: firstFetch,
      statePath,
      sendAgents: false,
      sendTelegram: false,
    });

    expect(first.alertCount).toBe(0);
    expect(first.initialized).toBe(false);

    const secondFetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => pressB })
      .mockResolvedValueOnce({ ok: true, text: async () => xHtml })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(secPayload) });
    const second = await runWatcher({
      fetch: secondFetch,
      statePath,
      sendAgents: false,
      sendTelegram: false,
    });

    expect(second.initialized).toBe(true);
    expect(second.alertCount).toBe(1);
    expect(second.newStrategyPress[0]).toEqual(expect.objectContaining({
      id: 'press:strategy-adds-1000-btc-and-now-holds-767970-btc_04-13-2026',
    }));
  });

  test('routes new Saylor / Strategy items to architect and oracle instead of Telegram by default', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-saylor-watcher-alert-'));
    const statePath = path.join(tempDir, 'saylor-watcher-state.json');
    const pressA = '<a href="/press/strategy-acquires-4871-btc-and-now-holds-766970-btc_04-06-2026">One</a>';
    const pressB = '<a href="/press/strategy-adds-1000-btc-and-now-holds-767970-btc_04-13-2026">Two</a>' + pressA;
    const xHtml = [
      '<script id="__NEXT_DATA__" type="application/json">',
      JSON.stringify({
        props: {
          pageProps: {
            timeline: {
              entries: [
                {
                  type: 'tweet',
                  content: {
                    tweet: {
                      id_str: '1',
                      created_at: 'Mon Apr 13 00:00:00 +0000 2026',
                      full_text: 'BTC',
                      permalink: '/saylor/status/1',
                    },
                  },
                },
              ],
            },
          },
        },
      }),
      '</script>',
    ].join('');
    const secPayload = {
      cik: '0001050446',
      filings: {
        recent: {
          form: ['8-K'],
          accessionNumber: ['0001193125-26-123456'],
          filingDate: ['2026-04-06'],
          primaryDocument: ['d123456d8k.htm'],
          primaryDocDescription: ['Current report'],
        },
      },
    };

    const firstFetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => pressA })
      .mockResolvedValueOnce({ ok: true, text: async () => xHtml })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(secPayload) });
    await runWatcher({
      fetch: firstFetch,
      statePath,
      sendTelegram: false,
    });

    const secondFetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => pressB })
      .mockResolvedValueOnce({ ok: true, text: async () => xHtml })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(secPayload) });
    const second = await runWatcher({
      fetch: secondFetch,
      statePath,
      sendTelegram: false,
    });

    expect(second.alerted).toBe(true);
    expect(second.agentAlerts).toEqual(expect.objectContaining({
      ok: true,
      targets: ['architect', 'oracle'],
    }));
    expect(sendAgentAlert).toHaveBeenCalledWith(
      expect.stringContaining('Do not dump this to James'),
      expect.objectContaining({
        targets: ['architect', 'oracle'],
      })
    );
  });
});
