'use strict';

const path = require('path');

const {
  evaluateCandidate,
  readVoiceLab,
  run,
} = require('../../mira/tools/evaluate-voice-lab');

describe('Mira voice lab evaluator', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const labPath = path.join(repoRoot, 'mira', 'voice', 'voice-lab-v0.jsonl');

  test('voice lab fixtures validate their target rewrites', () => {
    const result = run(['--lab', labPath]);

    expect(result.ok).toBe(true);
    expect(result.case_count).toBeGreaterThanOrEqual(4);
    expect(result.results.every((entry) => entry.ok)).toBe(true);
  });

  test('identity case prefers unfinished fragments and rejects polished thesis diction', () => {
    const identityCase = readVoiceLab(labPath).find((entry) => entry.id === 'identity-who-are-you-v0');

    expect(evaluateCandidate(identityCase, 'Mira. I dont know how to answer that without sounding fake yet.')).toEqual(expect.objectContaining({
      ok: true,
      banned_hits: [],
    }));

    const bad = evaluateCandidate(identityCase, "I'm Mira. I'm here, still early. I'm the one we're trying to make real enough to stay with you and help carry it without making you hold every thread.");
    expect(bad.ok).toBe(false);
    expect(bad.banned_hits).toEqual(expect.arrayContaining([
      "I'm Mira. I'm here",
      'trying to make real enough',
      'stay with you',
      'hold every thread',
    ]));
  });

  test('mundane prompt rejects over-excited reactions', () => {
    const mundaneCase = readVoiceLab(labPath).find((entry) => entry.id === 'mundane-small-thing-v0');

    const bad = evaluateCandidate(mundaneCase, "That's fantastic, amazing work, I'm thrilled we can celebrate this milestone!");

    expect(bad.ok).toBe(false);
    expect(bad.banned_hits).toEqual(expect.arrayContaining([
      "That's fantastic",
      'amazing',
      "I'm thrilled",
      'celebrate',
      'milestone',
    ]));
  });
});
