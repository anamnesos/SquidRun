'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../modules/trading/hyperliquid-client', () => ({
  resolveWalletAddress: jest.fn(() => '0xtest-wallet'),
  getAccountSnapshot: jest.fn(async () => ({ equity: 508.55, cash: 0 })),
  getOpenPositions: jest.fn(async () => []),
}));

const {
  generateStartupBriefing,
  readStartupBriefing,
  _internals,
} = require('../modules/startup-ai-briefing');

describe('startup-ai-briefing', () => {
  test('selects newest transcript files first', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-files-'));
    try {
      const older = path.join(tempRoot, 'older.jsonl');
      const newer = path.join(tempRoot, 'newer.jsonl');
      fs.writeFileSync(older, '');
      fs.writeFileSync(newer, '');
      const oldTime = new Date('2026-04-01T00:00:00.000Z');
      const newTime = new Date('2026-04-02T00:00:00.000Z');
      fs.utimesSync(older, oldTime, oldTime);
      fs.utimesSync(newer, newTime, newTime);

      const files = _internals.listRecentTranscriptFiles({
        projectsDir: tempRoot,
        maxTranscripts: 2,
      });

      expect(files.map((entry) => entry.name)).toEqual(['newer.jsonl', 'older.jsonl']);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('generates and saves a startup briefing from recent transcripts', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-gen-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      const transcriptPath = path.join(tempRoot, 'session-1.jsonl');
      fs.writeFileSync(transcriptPath, [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-04-04T00:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'James wants a hard cap of $200 notional.' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-04T00:01:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Builder shipped the cap and restarted the supervisor.' }] },
        }),
      ].join('\n'));

      const result = await generateStartupBriefing({
        projectsDir: tempRoot,
        outputPath,
        statusPath,
        apiKey: 'sk-ant-test-fake-key-do-not-use',
        fetchImpl: jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            content: [
              {
                type: 'text',
                text: '## What Happened\n- Automation was turned on with a $200 cap.\n',
              },
            ],
          }),
        }),
      });

      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expect(readStartupBriefing({ outputPath })).toContain('# AI Startup Briefing');
      expect(readStartupBriefing({ outputPath })).toContain('Automation was turned on with a $200 cap.');
      expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toEqual(expect.objectContaining({
        ok: true,
        transcriptCount: 1,
        liveSnapshotOk: true,
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('builds a prompt with the verified live snapshot', () => {
    const prompt = _internals.buildBriefingPrompt(
      [{ name: 'session-1.jsonl', modifiedAt: '2026-04-17T01:30:22.795Z' }],
      'USER: Briefing says SOL was closed.\n\nASSISTANT: Need to verify live state.',
      {
        liveSnapshot: {
          ok: true,
          checkedAt: '2026-04-17T01:31:03.643Z',
          accountValue: 508.55,
          withdrawable: 0,
          positions: [
            {
              ticker: 'SOL/USD',
              side: 'short',
              size: -111.46,
              entryPx: 88.451,
              unrealizedPnl: 20.17,
              liquidationPx: 90.55,
            },
          ],
        },
      }
    );

    expect(prompt).toContain('Verified live Hyperliquid snapshot:');
    expect(prompt).toContain('SOL/USD short size=-111.46');
    expect(prompt).toContain('Use the verified live snapshot');
  });
});
