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

  test('identity case rejects assistant and business-bot diction', () => {
    const identityCase = readVoiceLab(labPath).find((entry) => entry.id === 'identity-who-are-you-v0');

    expect(evaluateCandidate(identityCase, "I'm Mira. I'm here, still early, but I'm not supposed to be a dashboard or a business bot. I'm the one we're trying to make real enough to stay with you, understand the work, and help carry it without making you hold every thread.")).toEqual(expect.objectContaining({
      ok: true,
      banned_hits: [],
    }));

    const bad = evaluateCandidate(identityCase, "I'm Mira, your local AI presence and business bot. I'm not a generic chatbot or your yes machine; I'm designed to become your CRM operator layer.");
    expect(bad.ok).toBe(false);
    expect(bad.banned_hits).toEqual(expect.arrayContaining([
      'local AI presence',
      'generic chatbot',
      'not a generic chatbot',
      'yes machine',
      'business bot',
      'operator layer',
      'CRM',
      'designed to',
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
