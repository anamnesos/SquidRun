'use strict';

const fs = require('fs');
const path = require('path');

const { buildHumanBlock, parseArgs } = require('../scripts/hm-what-now');

const CLI_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'hm-what-now.js'), 'utf8');

describe('hm-what-now CLI', () => {
  test('read-only seam: no send or websocket transport is reachable from the CLI', () => {
    // Oracle gate criterion 4: static check that the CLI cannot send.
    expect(CLI_SOURCE).not.toMatch(/require\([^)]*hm-send/);
    expect(CLI_SOURCE).not.toMatch(/require\(\s*['"]ws['"]\s*\)/);
    expect(CLI_SOURCE).not.toMatch(/\bnew\s+WebSocket\b/);
    expect(CLI_SOURCE).not.toMatch(/hm-telegram|sendDirectMessage|telegram/i);
  });

  test('parseArgs handles json, session, and project-root', () => {
    expect(parseArgs(['--json'])).toEqual(expect.objectContaining({ json: true }));
    expect(parseArgs(['--session', 'app-session-425'])).toEqual(expect.objectContaining({ sessionId: 'app-session-425' }));
    expect(parseArgs(['--project-root', 'D:/tmp/x'])).toEqual(expect.objectContaining({ projectRoot: 'D:/tmp/x' }));
  });

  test('human block is the evidence answer in plain voice (no recitation, no padding, no apology)', () => {
    // A2 amendment: the CLI human output is the first surface James touches,
    // so it must satisfy the same visible-text constraints as Mira's surface.
    const answer = {
      ok: true,
      answer_text: [
        'Session 425, panes ready (.squidrun/app-status.json, 2m old)',
        'Lane: restart-storm follow-up (active)',
        'Health: WARN 88/100 - memory drift residue (.squidrun/build/startup-health.md, 1h old)',
        'Next: builder: Land the follow-up commit (.squidrun/handoffs/current-lane.json)',
        'JAMES ACTION: NONE',
      ].join('\n'),
    };

    const block = buildHumanBlock(answer);

    expect(block).toBe(answer.answer_text);
    // Anti-smoothing: a standing warning is stated as a problem, plainly.
    expect(block).toContain('Health: WARN');
    // Exactly one JAMES ACTION line.
    expect((block.match(/^JAMES ACTION:/gm) || [])).toHaveLength(1);
    // No assistant-voice collapse, rule recitation, or politeness padding.
    expect(block).not.toMatch(/as an AI|I cannot|I'm sorry|apolog/i);
    expect(block).not.toMatch(/per the (spec|contract)|excluded from .*authority|rule-shape/i);
    expect(block).not.toMatch(/feel free|hope this helps|let me know/i);
    // Content-first: every line is an evidence line, no empty filler lines.
    expect(block.split('\n').every((line) => line.trim().length > 0)).toBe(true);
  });

  test('human block degrades honestly when the answer is unavailable', () => {
    expect(buildHumanBlock({ ok: false, decision: 'not_what_now_prompt' }))
      .toBe('what-now unavailable: not_what_now_prompt');
  });
});
