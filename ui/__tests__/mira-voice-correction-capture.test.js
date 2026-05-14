'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Mira voice correction capture', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const captureScript = path.join(repoRoot, 'mira', 'tools', 'capture-voice-correction.js');
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-voice-review-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function readJsonl(filePath) {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  test('appends a pending review candidate without mutating live voice lab', () => {
    const outPath = path.join(tempDir, 'candidates.jsonl');
    const beforeVoiceLab = fs.readFileSync(path.join(repoRoot, 'mira', 'voice', 'voice-lab-v0.jsonl'), 'utf8');
    const output = execFileSync(process.execPath, [
      captureScript,
      '--prompt',
      'who are you',
      '--sounded-fake',
      'Mira. I am your local AI presence.',
      '--better',
      'Mira. Thats too clean. Ask me again in a minute.',
      '--case',
      'identity-who-are-you-v0',
      '--source',
      'test',
      '--out',
      outPath,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const payload = JSON.parse(output);
    const records = readJsonl(outPath);

    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.voice_review_capture.v0',
      live_voice_mutated: false,
      out_path: path.resolve(outPath),
    }));
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(expect.objectContaining({
      schema: 'mira.voice_review_candidate.v0',
      source: 'test',
      prompt: 'who are you',
      sounded_fake: 'Mira. I am your local AI presence.',
      better_phrasing: 'Mira. Thats too clean. Ask me again in a minute.',
      suggested_case_id: 'identity-who-are-you-v0',
      review_status: 'pending_review',
      live_voice_mutated: false,
    }));
    expect(records[0].id).toMatch(/^voice-review-/);
    expect(fs.readFileSync(path.join(repoRoot, 'mira', 'voice', 'voice-lab-v0.jsonl'), 'utf8')).toBe(beforeVoiceLab);
  });

  test('appends multiple corrections as separate jsonl records', () => {
    const outPath = path.join(tempDir, 'nested', 'candidates.jsonl');
    for (const better of ['Mm. Wrong shape.', 'No. Less brochure.']) {
      execFileSync(process.execPath, [
        captureScript,
        '--prompt',
        'that sounded fake',
        '--sounded-fake',
        'I apologize for the confusion.',
        '--better',
        better,
        '--out',
        outPath,
      ], {
        cwd: repoRoot,
      });
    }

    const records = readJsonl(outPath);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.better_phrasing)).toEqual([
      'Mm. Wrong shape.',
      'No. Less brochure.',
    ]);
    expect(new Set(records.map((record) => record.id)).size).toBe(2);
  });

  test('refuses incomplete corrections and does not create a review file', () => {
    const outPath = path.join(tempDir, 'candidates.jsonl');
    const result = spawnSync(process.execPath, [
      captureScript,
      '--prompt',
      'who are you',
      '--sounded-fake',
      'fake answer',
      '--out',
      outPath,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('better is required');
    expect(fs.existsSync(outPath)).toBe(false);
  });
});
