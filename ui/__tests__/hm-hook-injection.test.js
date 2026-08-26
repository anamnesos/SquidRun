const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-hook-injection.js');

describe('hm-hook-injection startup brief', () => {
  test('emits a bounded role-aware brief without the full reflection wall', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--startup-brief'], {
      cwd: path.join(__dirname, '..', '..'),
      env: {
        ...process.env,
        SQUIDRUN_ROLE: 'builder',
        SQUIDRUN_PANE_ID: '2',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('AGENCY BRIEF — BUILDER');
    expect(result.stdout).not.toContain('REFLECTION PROMPTS');
    expect(result.stdout.trim().split(/\r?\n/).length).toBeLessThanOrEqual(5);
  });

  test('compacts long prose deterministically', () => {
    const { compactSentence } = require('../scripts/hm-hook-injection');
    expect(compactSentence('  one   two   three  ', 9)).toBe('one two…');
  });
});
