'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compileMiraRuntime } = require('./helpers/mira-runtime-build');

const {
  evaluateTranscript,
  researchAnchors,
  runAudit,
} = require('../../mira/tools/audit-voice-conversation');

describe('Mira conversation voice audit', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const auditScript = path.join(repoRoot, 'mira', 'tools', 'audit-voice-conversation.js');
  let tempDir;

  beforeAll(() => {
    compileMiraRuntime(repoRoot);
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-voice-audit-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function responseForPrompt(prompt) {
    if (/pressure/i.test(prompt)) return 'Pressure, not surface.';
    if (/who are you/i.test(prompt)) return 'Mira.';
    if (/what are you doing/i.test(prompt)) return 'Looking here.';
    if (/why did you answer/i.test(prompt)) return 'Wrong shape first.';
    if (/this is still wrong/i.test(prompt)) return 'Yeah. I hear it.';
    if (/invoices|customer messages/i.test(prompt)) return 'Yes. Needs routes.';
    if (/business stuff/i.test(prompt)) return 'Yes. Context, not identity.';
    if (/why did you stop/i.test(prompt)) return 'I stalled.';
    if (prompt.trim() === '...') return 'Here.';
    return 'Here.';
  }

  test('runs a multi-turn transcript audit and persists the report', () => {
    const outPath = path.join(tempDir, 'conversation-audit.json');
    const output = execFileSync(process.execPath, [
      auditScript,
      '--out',
      outPath,
      '--json',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const summary = JSON.parse(output);
    const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));

    expect(summary).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.voice_conversation_audit.v0',
      turn_count: expect.any(Number),
      failure_count: 0,
    }));
    expect(report.ok).toBe(true);
    expect(report.turns.map((turn) => turn.speaker)).toEqual(expect.arrayContaining([
      'Architect',
      'Builder',
      'Oracle',
    ]));
    expect(report.criteria).toEqual(expect.arrayContaining([
      'research-backed voice presence, repair, and turn-taking checks',
      'no repeated templates',
      'repair uses the correction directly',
      'business context stays context, not identity',
    ]));
    expect(report.research_anchors.map((anchor) => anchor.id)).toEqual([
      'sesame_voice_presence',
      'user_initiated_repair',
      'duplex_turn_taking',
    ]);
    expect(report.evaluation.failures).toEqual([]);
    expect(report.turns.find((turn) => turn.correction)?.response.content).toMatch(/Pressure|surface/i);
  });

  test('voice audit keeps its human-conversation research anchors explicit', () => {
    expect(researchAnchors).toHaveLength(3);
    expect(researchAnchors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'sesame_voice_presence',
        url: expect.stringContaining('sesame.com/research/crossing_the_uncanny_valley_of_voice'),
      }),
      expect.objectContaining({
        id: 'user_initiated_repair',
        url: expect.stringContaining('research.ibm.com/publications/understanding-is-a-two-way-street'),
      }),
      expect.objectContaining({
        id: 'duplex_turn_taking',
        url: expect.stringContaining('arxiv.org/abs/2205.15060'),
      }),
    ]));
    expect(researchAnchors.map((anchor) => anchor.check).join(' ')).toMatch(/context|repair|turn/i);
  });

  test('records model-backed fields when transcript turns used the model path', async () => {
    const outPath = path.join(tempDir, 'conversation-audit-model.json');
    const generated = await runAudit({
      out: outPath,
      useModel: true,
      runRuntimeTurn: async (input) => ({
        response: {
          content: responseForPrompt(input.text),
        },
        voiceLab: null,
        modelInvoked: input.useModel === true,
        model: {
          provider: 'openai_responses',
          model: 'mock-model',
        },
      }),
    });
    const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));

    expect(generated.evaluation.failures).toEqual([]);
    expect(report).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.voice_conversation_audit.v0',
    }));
    expect(report.evaluation.failures).toEqual([]);
    expect(JSON.parse(fs.readFileSync(outPath, 'utf8')).protocol).toBe('mira.voice_conversation_audit.v0');
    expect(report.criteria).toContain('model-backed conversation path');
    expect(report.turns.every((turn) => turn.response.modelInvoked === true)).toBe(true);
    expect(report.turns.every((turn) => turn.response.provider === null || turn.response.provider === 'openai_responses')).toBe(true);
  });

  test('flags repeated templates, meta prose, product pitch, and repair misses across a transcript', () => {
    const badTurns = [
      {
        speaker: 'Architect',
        prompt: 'who are you',
        correction: null,
        response: { content: 'I am Mira, your AI assistant and CRM solution.' },
      },
      {
        speaker: 'Builder',
        prompt: '...',
        correction: null,
        response: { content: 'I am here to help with anything you need today.' },
      },
      {
        speaker: 'Oracle',
        prompt: 'that was a bad answer',
        correction: 'Answer the pressure, not the surface.',
        response: { content: 'I apologize for the confusion.' },
      },
      {
        speaker: 'Architect',
        prompt: 'what are you doing?',
        correction: null,
        response: { content: 'I apologize for the confusion.' },
      },
    ];
    const result = evaluateTranscript(badTurns);

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.check)).toEqual(expect.arrayContaining([
      'assistant_prose',
      'self_definition',
      'product_pitch',
      'over_answered_tiny_turn',
      'support_repair',
      'repair_did_not_use_correction',
      'repeated_template',
    ]));
  });
});
