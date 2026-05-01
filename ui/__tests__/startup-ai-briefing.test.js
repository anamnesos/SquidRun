'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  generateStartupBriefing,
  readStartupBriefing,
  readStartupBriefingForInjection,
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
      fs.mkdirSync(path.join(tempRoot, 'workspace', 'knowledge'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'workspace', 'knowledge', 'case-operations.md'), [
        '## Hard Error Rules',
        '- registration must happen **before 2026-06-03** (the eligibility 기준시점), not after.',
      ].join('\n'));
      const transcriptPath = path.join(tempRoot, 'session-1.jsonl');
      fs.writeFileSync(transcriptPath, [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-04-04T00:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'The user wants a hard cap of three active tasks.' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-04T00:01:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Builder shipped the cap and restarted the supervisor.' }] },
        }),
      ].join('\n'));

      const result = await generateStartupBriefing({
        projectsDir: tempRoot,
        projectRoot: tempRoot,
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
        liveSnapshotOk: false,
        canonicalSourceCount: 1,
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('marks injected briefing stale when status age is unknown', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-unknown-age-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      fs.writeFileSync(outputPath, '# AI Startup Briefing\n\n## What Happened\n- Keep the non-live briefing content.\n');

      const guarded = readStartupBriefingForInjection({
        outputPath,
        statusPath,
        nowMs: Date.parse('2026-04-26T19:00:00.000Z'),
      });

      expect(guarded).toMatch(/^STALE SNAPSHOT generated at unknown time, account values may have moved\./);
      expect(guarded).toContain('## What Happened');
      expect(guarded).toContain('Keep the non-live briefing content.');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('prepends warning when injected briefing is older than fifteen minutes', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-16m-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      fs.writeFileSync(outputPath, '# AI Startup Briefing\n\n- Scheduler status is the current priority.\n');
      fs.writeFileSync(statusPath, JSON.stringify({
        generatedAt: '2026-04-26T18:44:00.000Z',
      }));

      const guarded = readStartupBriefingForInjection({
        outputPath,
        statusPath,
        nowMs: Date.parse('2026-04-26T19:00:00.000Z'),
      });

      expect(guarded).toMatch(/^STALE SNAPSHOT generated 16 minutes ago, account values may have moved\./);
      expect(guarded).toContain('Scheduler status is the current priority.');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('strips live account blocks when injected briefing is older than sixty minutes', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-61m-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      fs.writeFileSync(outputPath, [
        '# AI Startup Briefing',
        '',
        '## Live Account Status',
        '- Account value: $616.93',
        '- SAMPLE/USD short size=-7683',
        '',
        '## What Happened',
        '- Curator cleanup landed and non-live context remains useful.',
        '',
        '## Verified Live Account Snapshot',
        '- Withdrawable: $0.04',
        '',
        '## Next Work',
        '- Keep removing disabled lanes.',
        '',
      ].join('\n'));
      fs.writeFileSync(statusPath, JSON.stringify({
        generatedAt: '2026-04-26T17:59:00.000Z',
      }));

      const guarded = readStartupBriefingForInjection({
        outputPath,
        statusPath,
        nowMs: Date.parse('2026-04-26T19:00:00.000Z'),
      });

      expect(guarded).toMatch(/^STALE SNAPSHOT generated 61 minutes ago; live-account block omitted, account values may have moved\./);
      expect(guarded).not.toContain('Account value: $616.93');
      expect(guarded).not.toContain('SAMPLE/USD short');
      expect(guarded).not.toContain('Verified Live Account Snapshot');
      expect(guarded).not.toContain('Withdrawable: $0.04');
      expect(guarded).toContain('Curator cleanup landed and non-live context remains useful.');
      expect(guarded).toContain('Keep removing disabled lanes.');
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

    expect(prompt).toContain('Verified live account snapshot:');
    expect(prompt).toContain('SOL/USD short size=-111.46');
    expect(prompt).toContain('Use the verified live snapshot');
  });

  test('uses canonical case files to override stale Scoped transcript summaries', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-canonical-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      fs.mkdirSync(path.join(tempRoot, 'workspace', 'knowledge'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'workspace', 'knowledge', 'case-operations.md'), [
        '## Hard Error Rules',
        '- registration must happen **before 2026-06-03** (the eligibility 기준시점), not after.',
        '',
        '| Startup Program 2026 1기 | **Submitted 2026-04-29** (Scoped confirmed via Telegram). | Selection result. |',
      ].join('\n'));
      fs.writeFileSync(path.join(tempRoot, 'workspace', 'knowledge', 'handoff-corrections.md'), [
        '## Fast Use',
        '- If an agent is about to say stale facts, re-check this file first.',
      ].join('\n'));

      const transcriptPath = path.join(tempRoot, 'session-1.jsonl');
      fs.writeFileSync(transcriptPath, JSON.stringify({
        type: 'user',
        timestamp: '2026-04-29T20:58:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'registration timing Must be after 6/3. Startup Program status uncertain.',
            },
          ],
        },
      }));

      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [
            {
              type: 'text',
              text: [
                '## Key Dates & Numbers',
                '| registration timing | Must be **after 6/3** to preserve eligibility benefit eligibility |',
                '',
                '## Immediate Priorities',
                '1. Confirm Startup Program submission status — did she finish and submit, or is it still in progress?',
              ].join('\n'),
            },
          ],
        }),
      });

      const result = await generateStartupBriefing({
        projectsDir: tempRoot,
        projectRoot: tempRoot,
        outputPath,
        statusPath,
        apiKey: 'sk-ant-test-fake-key-do-not-use',
        fetchImpl,
      });

      const prompt = JSON.parse(fetchImpl.mock.calls[0][1].body).messages[0].content;
      const briefing = readStartupBriefing({ outputPath });

      expect(result.ok).toBe(true);
      expect(prompt).toContain('Canonical source-of-truth (highest priority):');
      expect(prompt).toContain('registration must happen **before 2026-06-03**');
      expect(briefing).toContain('Canonical Source-Of-Truth Overrides');
      expect(briefing).toContain('Must be **on or before 2026-06-03**');
      expect(briefing).toContain('Monitor Startup Program Stage 1 announcement');
      expect(briefing).not.toContain('Must be **after 6/3**');
      expect(briefing).not.toContain('Confirm Startup Program submission status');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
