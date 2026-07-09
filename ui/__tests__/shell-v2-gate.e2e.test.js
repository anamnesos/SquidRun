'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scanPhase5Residue } = require('../scripts/shell-v2-gate');

const runGate = process.env.SHELL_V2_GATE === '1';
const testFn = runGate ? test : test.skip;

describe('shell-v2 Phase 5 residue scan', () => {
  let tempRoot;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  test('finds tracked Markdown residue outside the ui directory', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-v2-residue-'));
    fs.mkdirSync(path.join(tempRoot, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'README.md'), 'legacy-widget root note\n', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'docs', 'cleanup.md'), 'legacy-widget docs note\n', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'ui', 'active.js'), 'module.exports = true;\n', 'utf8');

    const gitEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
    );
    const git = (...args) => spawnSync('git', args, {
      cwd: tempRoot,
      encoding: 'utf8',
      env: gitEnv,
      windowsHide: true,
    });
    expect(git('init', '--quiet').status).toBe(0);
    expect(git('config', 'user.email', 'shell-v2-gate@example.invalid').status).toBe(0);
    expect(git('config', 'user.name', 'Shell V2 Gate Test').status).toBe(0);
    expect(git('add', '.').status).toBe(0);
    expect(git('commit', '--quiet', '-m', 'fixture').status).toBe(0);

    const hits = scanPhase5Residue({
      deletedFiles: [],
      residuePatterns: ['legacy-widget'],
    }, tempRoot);

    expect(hits).toEqual([
      expect.objectContaining({ filePath: 'README.md', line: 1 }),
      expect.objectContaining({ filePath: 'docs/cleanup.md', line: 1 }),
    ]);
  });
});

describe('shell-v2 committed gate', () => {
  testFn('runs the Shell V2 gate runner and preserves the criterion list', () => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'shell-v2-gate.js');
    const cdpPort = process.env.SHELL_V2_GATE_CDP_PORT || '9557';
    const result = spawnSync(process.execPath, [scriptPath, '--cdp-port', cdpPort], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      timeout: 140000,
      env: {
        ...process.env,
        SHELL_V2_GATE: '1',
      },
    });

    expect(result.status).toBe(0);
    const criterionIds = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z]\d[a-z]?):\s+(PASS|FAIL)\b/)?.[1])
      .filter(Boolean);

expect(criterionIds).toMatchInlineSnapshot(`
[
  "K2",
  "S4",
  "K5b",
  "N2",
  "K6b",
  "E1",
  "E2",
  "C2",
  "C4",
  "C1",
  "C3",
  "C5",
  "E4",
  "E3",
  "E5",
  "E6a",
  "E6b",
  "K1",
  "S1",
  "S2",
  "K3",
  "K4",
  "K5",
  "K6",
  "T1",
  "T2",
  "T3",
  "T4",
  "T4b",
  "S3",
  "T5",
  "T6",
  "V1",
]
`);
  }, 150000);
});
