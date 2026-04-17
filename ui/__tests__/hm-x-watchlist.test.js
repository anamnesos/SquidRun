jest.mock('../scripts/hm-telegram', () => ({
  sendTelegram: jest.fn().mockResolvedValue({ ok: true, chatId: '5613428850', messageId: 123 }),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sendTelegram } = require('../scripts/hm-telegram');

const {
  buildAlertMessage,
  buildArchitectAlertMessage,
  parseArgs,
  parseTimelineEntries,
  runWatcher,
} = require('../scripts/hm-x-watchlist');

describe('hm-x-watchlist', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('parses X syndication payload into account-scoped tweet entries', () => {
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

    expect(parseTimelineEntries(html, 'saylor')).toEqual([
      expect.objectContaining({
        id: 'tweet:saylor:2040438683380146574',
        account: 'saylor',
        text: 'Bitcoin has won.',
        source: 'X @saylor',
        url: 'https://x.com/saylor/status/2040438683380146574',
      }),
    ]);
  });

  test('baseline run records latest tweet per account without alerting, second run alerts on new tweet', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-x-watchlist-'));
    const statePath = path.join(tempDir, 'x-watchlist-state.json');
    const agentMessageSender = jest.fn(() => ({ ok: true }));
    const nowIso = '2026-04-15T12:00:00.000Z';
    const buildTimeline = (account, tweets) => [
      '<script id="__NEXT_DATA__" type="application/json">',
      JSON.stringify({
        props: {
          pageProps: {
            timeline: {
              entries: tweets.map(([id, text, createdAt]) => ({
                type: 'tweet',
                content: {
                  tweet: {
                    id_str: id,
                    created_at: createdAt,
                    full_text: text,
                    permalink: `/${account}/status/${id}`,
                  },
                },
              })),
            },
          },
        },
      }),
      '</script>',
    ].join('');

    const firstFetch = jest.fn(async (url) => {
      if (String(url).includes('/saylor')) {
        return {
          ok: true,
          text: async () => buildTimeline('saylor', [
            ['1', 'First Saylor post', 'Wed Apr 15 10:30:00 +0000 2026'],
          ]),
        };
      }
      return {
        ok: true,
        text: async () => buildTimeline('coinbase', [
          ['9', 'Coinbase listing notice', 'Wed Apr 15 11:30:00 +0000 2026'],
        ]),
      };
    });
    const first = await runWatcher({
      accounts: ['saylor', 'coinbase'],
      fetch: firstFetch,
      nowIso,
      sendTelegram: false,
      statePath,
    });

    expect(first.initialized).toBe(false);
    expect(first.alertCount).toBe(0);

    const secondFetch = jest.fn(async (url) => {
      if (String(url).includes('/saylor')) {
        return {
          ok: true,
          text: async () => buildTimeline('saylor', [
            ['2', 'Second Saylor post', 'Wed Apr 15 11:45:00 +0000 2026'],
            ['1', 'First Saylor post', 'Wed Apr 15 10:30:00 +0000 2026'],
          ]),
        };
      }
      return {
        ok: true,
        text: async () => buildTimeline('coinbase', [
          ['9', 'Coinbase listing notice', 'Wed Apr 15 11:30:00 +0000 2026'],
        ]),
      };
    });
    const second = await runWatcher({
      accounts: ['saylor', 'coinbase'],
      agentMessageSender,
      fetch: secondFetch,
      nowIso,
      sendTelegram: false,
      statePath,
    });

    expect(second.initialized).toBe(true);
    expect(second.alertCount).toBe(1);
    expect(second.newTweets[0]).toEqual(expect.objectContaining({
      account: 'saylor',
      tweetId: '2',
      source: 'X @saylor',
    }));
    expect(second.architect).toEqual(expect.objectContaining({
      ok: true,
    }));
    expect(agentMessageSender).toHaveBeenCalledTimes(1);
    expect(second.recentItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'X @saylor',
      }),
      expect.objectContaining({
        source: 'X @coinbase',
      }),
    ]));
  });

  test('ignores old pinned tweets, seeds silently, and only alerts on truly new recent posts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-x-watchlist-'));
    const statePath = path.join(tempDir, 'x-watchlist-state.json');
    const agentMessageSender = jest.fn(() => ({ ok: true }));
    const nowIso = '2026-04-15T12:00:00.000Z';
    const buildTimeline = (account, tweets) => [
      '<script id="__NEXT_DATA__" type="application/json">',
      JSON.stringify({
        props: {
          pageProps: {
            timeline: {
              entries: tweets.map(([id, text, createdAt]) => ({
                type: 'tweet',
                content: {
                  tweet: {
                    id_str: id,
                    created_at: createdAt,
                    full_text: text,
                    permalink: `/${account}/status/${id}`,
                  },
                },
              })),
            },
          },
        },
      }),
      '</script>',
    ].join('');

    const first = await runWatcher({
      accounts: ['whale_alert'],
      fetch: jest.fn(async () => ({
        ok: true,
        text: async () => buildTimeline('whale_alert', [
          ['999', 'Pinned 2023 post', 'Sat Jan 14 06:31:58 +0000 2023'],
          ['100', 'Fresh market post', 'Wed Apr 15 11:20:00 +0000 2026'],
        ]),
      })),
      nowIso,
      sendTelegram: false,
      statePath,
    });

    expect(first.alertCount).toBe(0);
    expect(first.latestByAccount.whale_alert).toEqual(expect.objectContaining({
      tweetId: '100',
      text: 'Fresh market post',
    }));

    const second = await runWatcher({
      accounts: ['whale_alert'],
      agentMessageSender,
      fetch: jest.fn(async () => ({
        ok: true,
        text: async () => buildTimeline('whale_alert', [
          ['999', 'Pinned 2023 post', 'Sat Jan 14 06:31:58 +0000 2023'],
          ['101', 'Actually new post', 'Wed Apr 15 11:50:00 +0000 2026'],
          ['100', 'Fresh market post', 'Wed Apr 15 11:20:00 +0000 2026'],
        ]),
      })),
      nowIso,
      sendTelegram: false,
      statePath,
    });

    expect(second.alertCount).toBe(1);
    expect(second.newTweets).toEqual([
      expect.objectContaining({
        tweetId: '101',
        text: 'Actually new post',
      }),
    ]);
    expect(agentMessageSender).toHaveBeenCalledTimes(1);
  });

  test('stale legacy state reseeds without backfilling a flood and does not send telegram by default', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-x-watchlist-'));
    const statePath = path.join(tempDir, 'x-watchlist-state.json');
    const nowIso = '2026-04-15T12:00:00.000Z';
    const buildTimeline = (account, tweets) => [
      '<script id="__NEXT_DATA__" type="application/json">',
      JSON.stringify({
        props: {
          pageProps: {
            timeline: {
              entries: tweets.map(([id, text, createdAt]) => ({
                type: 'tweet',
                content: {
                  tweet: {
                    id_str: id,
                    created_at: createdAt,
                    full_text: text,
                    permalink: `/${account}/status/${id}`,
                  },
                },
              })),
            },
          },
        },
      }),
      '</script>',
    ].join('');

    fs.writeFileSync(statePath, JSON.stringify({
      initialized: true,
      accounts: {
        whale_alert: {
          lastTweetId: 'tweet:whale_alert:old-anchor',
          updatedAt: '2026-04-15T08:00:00.000Z',
          latestTweet: {
            id: 'tweet:whale_alert:old-anchor',
            tweetId: 'old-anchor',
            account: 'whale_alert',
            createdAt: 'Sat Jan 14 06:31:58 +0000 2023',
            text: 'Pinned 2023 post',
            url: 'https://x.com/whale_alert/status/old-anchor',
            source: 'X @whale_alert',
            symbols: [],
          },
          lastError: null,
        },
      },
      nextArchitectSequence: 1,
      updatedAt: '2026-04-15T08:00:00.000Z',
      recentItems: [],
    }, null, 2));

    const summary = await runWatcher({
      accounts: ['whale_alert'],
      chatId: '5613428850',
      fetch: jest.fn(async () => ({
        ok: true,
        text: async () => buildTimeline('whale_alert', [
          ['999', 'Pinned 2023 post', 'Sat Jan 14 06:31:58 +0000 2023'],
          ['200', 'Fresh whale update', 'Wed Apr 15 11:55:00 +0000 2026'],
          ['199', 'Earlier fresh whale update', 'Wed Apr 15 10:30:00 +0000 2026'],
        ]),
      })),
      nowIso,
      statePath,
    });

    expect(summary.alertCount).toBe(0);
    expect(sendTelegram).not.toHaveBeenCalled();

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(saved.accounts.whale_alert.lastTweetId).toBe('tweet:whale_alert:200');
    expect(saved.accounts.whale_alert.latestTweet).toEqual(expect.objectContaining({
      tweetId: '200',
    }));
  });

  test('formats plain-English alert copy with position context and architect wrapper', () => {
    const summary = {
      newTweets: [
        {
          account: 'saylor',
          text: 'Strategy acquires 1,000 more BTC.',
          url: 'https://x.com/saylor/status/2',
        },
      ],
    };

    const message = buildAlertMessage(summary, {
      positionProvider: () => [{ coin: 'kPEPE', size: -10 }],
    });
    expect(message).toContain('[X ALERT] @saylor just tweeted');
    expect(message).toContain('Why it matters: This could move BTC and broad crypto sentiment short-term.');
    expect(message).toContain('You have an open KPEPE short.');

    const architectMessage = buildArchitectAlertMessage(summary, {
      positionProvider: () => [],
      sequence: 7,
    });
    expect(architectMessage).toContain('(SUPERVISOR #7): X watchlist alert for review.');
    expect(architectMessage).toContain('Action: decide whether this matters to James');
  });

  test('parseArgs keeps telegram off by default even when chat-id is present', () => {
    const options = parseArgs(['--json', '--chat-id', '5613428850']);
    expect(options.chatId).toBe('5613428850');
    expect(options.sendTelegram).toBe(false);
    expect(options.sendArchitect).toBe(true);
  });
});
