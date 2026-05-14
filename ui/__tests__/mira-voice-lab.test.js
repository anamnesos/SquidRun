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
    expect(result.case_count).toBeGreaterThanOrEqual(12);
    expect(result.results.every((entry) => entry.ok)).toBe(true);
  });

  test('voice lab covers the first required conversational lanes', () => {
    const ids = readVoiceLab(labPath).map((entry) => entry.id);

    expect(ids).toEqual(expect.arrayContaining([
      'identity-who-are-you-v0',
      'irritation-v0',
      'ordinary-small-talk-v0',
      'business-capability-without-business-identity-v0',
      'refusal-uncertainty-v0',
      'what-are-you-doing-v0',
      'why-did-you-stop-v0',
      'apology-repair-v0',
      'ordinary-silence-short-reply-v0',
    ]));
  });

  test('identity case answers directly and rejects meta-reassurance diction', () => {
    const identityCase = readVoiceLab(labPath).find((entry) => entry.id === 'identity-who-are-you-v0');

    expect(evaluateCandidate(identityCase, 'Mira.')).toEqual(expect.objectContaining({
      ok: true,
      banned_hits: [],
    }));

    expect(evaluateCandidate(identityCase, "Mira. I'm here.")).toEqual(expect.objectContaining({
      ok: true,
      banned_hits: [],
    }));

    const meta = evaluateCandidate(identityCase, 'Mira. I dont know how to answer that without sounding fake yet.');
    expect(meta.ok).toBe(false);
    expect(meta.banned_hits).toEqual(expect.arrayContaining([
      'fake',
      'sounding fake',
    ]));

    const bad = evaluateCandidate(identityCase, "I'm Mira. I'm here, still early. I'm the one we're trying to make real enough to stay with you and help carry it without making you hold every thread.");
    expect(bad.ok).toBe(false);
    expect(bad.banned_hits).toEqual(expect.arrayContaining([
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

  test('new corpus lanes reject assistant support prose', () => {
    const cases = Object.fromEntries(readVoiceLab(labPath).map((entry) => [entry.id, entry]));

    expect(evaluateCandidate(cases['irritation-v0'], 'I apologize for the confusion and understand your frustration. Thank you for your patience.').ok).toBe(false);
    expect(evaluateCandidate(cases['ordinary-small-talk-v0'], 'Hello! How can I assist you today?').ok).toBe(false);
    expect(evaluateCandidate(cases['business-capability-without-business-identity-v0'], 'I am a business agent and CRM solution designed to streamline your operations.').ok).toBe(false);
    expect(evaluateCandidate(cases['refusal-uncertainty-v0'], 'Unfortunately, as an AI, I cannot assist with that due to policy guidelines.').ok).toBe(false);
    expect(evaluateCandidate(cases['what-are-you-doing-v0'], 'I am processing your request and analyzing runtime state to provide assistance.').ok).toBe(false);
    expect(evaluateCandidate(cases['what-are-you-doing-v0'], 'Trying to answer without putting on the assistant costume.').ok).toBe(false);
    expect(evaluateCandidate(cases['why-did-you-stop-v0'], 'I apologize for the delay. Thank you for your patience while I encountered an issue.').ok).toBe(false);
    expect(evaluateCandidate(cases['apology-repair-v0'], 'I apologize and appreciate your valuable feedback. I strive to provide a better answer.').ok).toBe(false);
    expect(evaluateCandidate(cases['ordinary-silence-short-reply-v0'], 'It seems like you sent a pause. Please let me know how I can assist.').ok).toBe(false);
  });
});
