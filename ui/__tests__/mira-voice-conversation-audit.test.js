'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  evaluateTranscript,
} = require('../../mira/tools/audit-voice-conversation');

describe('Mira conversation voice audit', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const auditScript = path.join(repoRoot, 'mira', 'tools', 'audit-voice-conversation.js');
  const runtimeTsconfig = path.join(repoRoot, 'mira', 'runtime', 'tsconfig.json');
  const tscBin = path.join(repoRoot, 'ui', 'node_modules', 'typescript', 'bin', 'tsc');
  let tempDir;

  beforeAll(() => {
    execFileSync(process.execPath, [
      tscBin,
      '-p',
      runtimeTsconfig,
    ], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-voice-audit-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

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
      'no repeated templates',
      'repair uses the correction directly',
      'business context stays context, not identity',
    ]));
    expect(report.evaluation.failures).toEqual([]);
    expect(report.turns.find((turn) => turn.correction)?.response.content).toMatch(/Pressure|surface/i);
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
