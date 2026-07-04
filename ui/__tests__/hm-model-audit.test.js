'use strict';

/** hm-model-audit contracts: the router-blindness antidote stays honest. */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { tallyModelsByDay, mergeTallies, auditDir } = require('../scripts/hm-model-audit');

const line = (ts, model) => JSON.stringify({ timestamp: ts, message: { model } });

describe('hm-model-audit', () => {
  test('tallies serving model per day, skips junk and pre-since days', () => {
    const lines = [
      line('2026-07-02T01:00:00Z', 'claude-fable-5'),
      line('2026-07-02T02:00:00Z', 'claude-fable-5'),
      line('2026-07-02T03:00:00Z', 'claude-opus-4-8'),
      line('2026-06-30T03:00:00Z', 'claude-opus-4-8'), // pre-since, dropped
      JSON.stringify({ timestamp: '2026-07-02T04:00:00Z', message: {} }), // no model
      'not json with "model" in it',
      '',
    ];
    expect(tallyModelsByDay(lines, { since: '2026-07-01' })).toEqual({
      '2026-07-02': { 'claude-fable-5': 2, 'claude-opus-4-8': 1 },
    });
  });

  test('mergeTallies sums across files', () => {
    const a = { '2026-07-02': { 'claude-fable-5': 2 } };
    mergeTallies(a, { '2026-07-02': { 'claude-fable-5': 3, 'claude-opus-4-8': 1 } });
    expect(a['2026-07-02']).toEqual({ 'claude-fable-5': 5, 'claude-opus-4-8': 1 });
  });

  test('auditDir scans a directory of transcripts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-audit-'));
    fs.writeFileSync(path.join(dir, 'a.jsonl'), [
      line('2026-07-02T01:00:00Z', 'claude-fable-5'),
      line('2026-07-03T01:00:00Z', 'claude-fable-5'),
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'b.jsonl'), line('2026-07-03T02:00:00Z', 'claude-opus-4-8'));
    fs.writeFileSync(path.join(dir, 'ignored.txt'), line('2026-07-03T02:00:00Z', 'x'));

    const result = auditDir(dir, { perFile: true });
    expect(result.filesScanned).toBe(2);
    expect(result.byDay).toEqual({
      '2026-07-02': { 'claude-fable-5': 1 },
      '2026-07-03': { 'claude-fable-5': 1, 'claude-opus-4-8': 1 },
    });
    expect(Object.keys(result.byFile).sort()).toEqual(['a.jsonl', 'b.jsonl']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
