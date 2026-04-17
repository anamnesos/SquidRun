'use strict';

const eventVeto = require('../event-veto');

describe('event-veto', () => {
  const originalFetch = global.fetch;
  const textResponse = (text, ok = true) => ({
    ok,
    text: async () => text,
    json: async () => JSON.parse(text),
  });
  const jsonResponse = (payload, ok = true) => ({
    ok,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  const emptyByUrl = (url) => {
    const value = String(url || '');
    if (value.includes('api.coingecko.com')) return jsonResponse({ data: [] });
    if (value.includes('api.gdeltproject.org')) return jsonResponse({ articles: [] });
    return textResponse('<?xml version="1.0" encoding="UTF-8"?><rss><channel></channel></rss>');
  };

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns VETO for fresh tier-1 geopolitical shock headlines', async () => {
    const result = await eventVeto.buildEventVeto({
      symbols: ['BTC/USD', 'ETH/USD'],
      now: '2026-03-29T12:00:00.000Z',
      newsItems: [
        {
          headline: 'Strait of Hormuz closed after military strike escalates tensions',
          summary: 'Oil and macro markets are reacting sharply.',
          source: 'Reuters',
          createdAt: '2026-03-29T11:30:00.000Z',
          symbols: ['BTC/USD', 'ETH/USD'],
        },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      decision: 'VETO',
      sizeMultiplier: 0.25,
      sourceTier: 'tier1',
      stale: false,
      affectedAssets: ['BTC/USD', 'ETH/USD'],
    }));
  });

  test('ignores non-breaking expiry headlines even when they are fresh', async () => {
    const result = await eventVeto.buildEventVeto({
      symbols: ['BTC/USD'],
      now: '2026-03-29T12:00:00.000Z',
      newsItems: [
        {
          headline: 'Reuters: BTC options expiry and max pain level draw trader focus',
          source: 'Reuters',
          createdAt: '2026-03-29T11:15:00.000Z',
          symbols: ['BTC/USD'],
        },
      ],
    });

    expect(result.decision).toBe('CLEAR');
    expect(result.sizeMultiplier).toBe(1);
  });

  test('downgrades to CLEAR when only stale tier-1 matches exist', async () => {
    global.fetch = jest.fn(async (url) => emptyByUrl(url));

    const result = await eventVeto.buildEventVeto({
      symbols: ['BTC/USD'],
      now: '2026-03-29T20:00:00.000Z',
      staleAfterMs: 60 * 60 * 1000,
      newsItems: [
        {
          headline: 'Reuters: military strike rattles markets',
          source: 'Reuters',
          createdAt: '2026-03-29T10:00:00.000Z',
          symbols: ['BTC/USD'],
        },
      ],
    });

    expect(result.decision).toBe('CLEAR');
    expect(result.sizeMultiplier).toBe(1);
    expect(result.stale).toBe(true);
  });

  test('stale tier-1 headlines do not suppress fresher supplemental feed coverage', async () => {
    global.fetch = jest.fn(async (url) => {
      const value = String(url || '');
      if (value.includes('reutersbest.com/feed/')) {
        return textResponse(`<?xml version="1.0" encoding="UTF-8"?>
          <rss><channel>
            <item>
              <title>Reuters Best: Strait of Hormuz closed after military strike</title>
              <link>https://reutersbest.com/hormuz-closed-fresh</link>
              <pubDate>Sat, 29 Mar 2026 19:30:00 +0000</pubDate>
              <description>Fresh headline from supplemental feed.</description>
            </item>
          </channel></rss>`);
      }
      return emptyByUrl(value);
    });

    const result = await eventVeto.buildEventVeto({
      symbols: ['BTC/USD'],
      now: '2026-03-29T20:00:00.000Z',
      staleAfterMs: 60 * 60 * 1000,
      newsItems: [
        {
          headline: 'Reuters: military strike rattles markets',
          source: 'Reuters',
          createdAt: '2026-03-29T10:00:00.000Z',
          symbols: ['BTC/USD'],
        },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      decision: 'VETO',
      sizeMultiplier: 0.25,
      sourceTier: 'tier1',
      stale: false,
      affectedAssets: ['BTC/USD'],
    }));
  });

  test('returns CLEAR when live tier-1 news is unavailable instead of blocking the whole book', async () => {
    global.fetch = jest.fn(async (url) => emptyByUrl(url));

    const result = await eventVeto.buildEventVeto({
      symbols: ['BTC/USD'],
      now: '2026-03-29T20:00:00.000Z',
      newsItems: [],
    });

    expect(result).toEqual(expect.objectContaining({
      decision: 'CLEAR',
      sourceTier: 'none',
      stale: true,
      sizeMultiplier: 1,
    }));
    expect(result.eventSummary).toContain('No market-breaking event');
  });

  test('uses live supplemental headlines when broker news is empty', async () => {
    global.fetch = jest.fn(async (url) => {
      const value = String(url || '');
      if (value.includes('www.coindesk.com/arc/outboundfeeds/rss/')) {
        return textResponse(`<?xml version="1.0" encoding="UTF-8"?>
          <rss><channel>
            <item>
              <title>CoinDesk reports Strait of Hormuz closed after military strike</title>
              <link>https://www.coindesk.com/markets/2026/03/29/hormuz-closed</link>
              <pubDate>Sat, 29 Mar 2026 10:30:00 +0000</pubDate>
              <description>Fresh crypto-market impact coverage.</description>
            </item>
          </channel></rss>`);
      }
      return emptyByUrl(value);
    });

    const result = await eventVeto.buildEventVeto({
      symbols: ['BTC/USD', 'ETH/USD'],
      now: '2026-03-29T12:00:00.000Z',
      newsItems: [],
    });

    expect(result).toEqual(expect.objectContaining({
      decision: 'CLEAR',
      sizeMultiplier: 1,
    }));
  });

  test('returns CLEAR when supplemental feeds are live and no event pattern is present', async () => {
    global.fetch = jest.fn(async (url) => {
      const value = String(url || '');
      if (value.includes('www.coindesk.com/arc/outboundfeeds/rss/')) {
        return textResponse(`<?xml version="1.0" encoding="UTF-8"?>
          <rss><channel>
            <item>
              <title>Institutional desks expand crypto custody offerings</title>
              <link>https://www.coindesk.com/markets/2026/03/29/crypto-custody-expands</link>
              <pubDate>Sat, 29 Mar 2026 11:30:00 +0000</pubDate>
              <description>No disruption language here.</description>
            </item>
          </channel></rss>`);
      }
      return emptyByUrl(value);
    });

    const result = await eventVeto.buildEventVeto({
      symbols: ['BTC/USD'],
      now: '2026-03-29T12:00:00.000Z',
      newsItems: [],
    });

    expect(result).toEqual(expect.objectContaining({
      decision: 'CLEAR',
      sizeMultiplier: 1,
      sourceTier: 'feeds_checked',
      stale: false,
      affectedAssets: [],
    }));
    expect(result.eventSummary).toContain('No market-breaking event');
  });

  test('ignores unrelated asset-specific maintenance for the requested symbols', async () => {
    global.fetch = jest.fn(async (url) => {
      const value = String(url || '');
      if (value.includes('status.kraken.com/history.atom')) {
        return textResponse(`<?xml version="1.0" encoding="UTF-8"?>
          <feed xmlns="http://www.w3.org/2005/Atom">
            <entry>
              <title>Cardano (ADA) Funding Maintenance</title>
              <updated>2026-03-29T11:30:00Z</updated>
              <link href="https://status.kraken.com/incidents/ada-maintenance" />
              <summary>Deposits and withdrawals for ADA are undergoing scheduled maintenance.</summary>
            </entry>
          </feed>`);
      }
      return emptyByUrl(value);
    });

    const result = await eventVeto.buildEventVeto({
      symbols: ['BTC/USD', 'ETH/USD'],
      now: '2026-03-29T12:00:00.000Z',
      newsItems: [],
    });

    expect(result.decision).toBe('CLEAR');
    expect(result.sourceTier).toBe('feeds_checked');
  });

  test('does not let blind macro fallback block trading by itself', async () => {
    global.fetch = jest.fn(async (url) => emptyByUrl(url));

    const result = await eventVeto.buildEventVeto({
      symbols: ['BTC/USD', 'ETH/USD'],
      now: '2026-03-29T12:00:00.000Z',
      newsItems: [],
      macroRisk: {
        intelligence: {
          geopolitics: {
            source: 'gdelt',
            riskScore: 78,
            articleCount: 5,
            activeKineticConflict: true,
            sampleHeadlines: [
              'Houthi entry into Iran war raises fears of global shipping disruption in Red Sea',
            ],
          },
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({
      decision: 'CLEAR',
      sizeMultiplier: 1,
    }));
  });

  test('broad crypto events affect the current consultation basket instead of the legacy six-coin set', async () => {
    const symbols = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD', 'LINK/USD', 'DOGE/USD', 'ARB/USD', 'ENA/USD'];
    const result = await eventVeto.buildEventVeto({
      symbols,
      now: '2026-03-29T12:00:00.000Z',
      newsItems: [
        {
          headline: 'Reuters: military strike triggers oil shock and markets reprice across crypto',
          source: 'Reuters',
          createdAt: '2026-03-29T11:30:00.000Z',
        },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      decision: 'VETO',
      sizeMultiplier: 0.25,
      sourceTier: 'tier1',
      affectedAssets: symbols,
    }));
  });

  test('exchange notices narrow to explicitly mentioned tracked assets when available', async () => {
    const result = await eventVeto.buildEventVeto({
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      now: '2026-03-29T12:00:00.000Z',
      newsItems: [
        {
          headline: 'Kraken maintenance notice: Ethereum (ETH) withdrawals paused for upgrade work',
          source: 'Kraken',
          createdAt: '2026-03-29T11:45:00.000Z',
        },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      decision: 'VETO',
      sizeMultiplier: 0.25,
      sourceTier: 'official',
      affectedAssets: ['ETH/USD'],
    }));
  });

  test('exchange notices do not spray across the whole basket unless the traded venue itself is affected', async () => {
    const result = await eventVeto.buildEventVeto({
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      now: '2026-03-29T12:00:00.000Z',
      newsItems: [
        {
          headline: 'Coinbase status notice: intermittent latency during routine maintenance',
          source: 'Coinbase',
          createdAt: '2026-03-29T11:45:00.000Z',
        },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      decision: 'CLEAR',
    }));
  });

  test('uses X watchlist items for treasury-purchase and listing catalysts', async () => {
    global.fetch = jest.fn(async (url) => emptyByUrl(url));

    const btcResult = await eventVeto.buildEventVeto({
      symbols: ['BTC/USD', 'ETH/USD'],
      now: '2026-03-29T12:00:00.000Z',
      newsItems: [],
      xWatchlistItems: [
        {
          id: 'tweet:saylor:1',
          text: 'Strategy will buy bitcoin again and expand the treasury reserve.',
          source: 'X @saylor',
          createdAt: '2026-03-29T11:50:00.000Z',
          url: 'https://x.com/saylor/status/1',
        },
      ],
    });

    expect(btcResult.decision).toBe('CLEAR');

    const listingResult = await eventVeto.buildEventVeto({
      symbols: ['AVAX/USD', 'SOL/USD'],
      now: '2026-03-29T12:00:00.000Z',
      newsItems: [],
      xWatchlistItems: [
        {
          id: 'tweet:coinbase:1',
          text: 'Coinbase listing notice: AVAX perpetual listing goes live tomorrow.',
          source: 'X @coinbase',
          createdAt: '2026-03-29T11:55:00.000Z',
          url: 'https://x.com/coinbase/status/1',
        },
      ],
    });

    expect(listingResult.decision).toBe('CLEAR');
  });
});
