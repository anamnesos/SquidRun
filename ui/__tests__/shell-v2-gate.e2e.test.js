'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const runGate = process.env.SHELL_V2_GATE === '1';
const testFn = runGate ? test : test.skip;

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
      .map((line) => line.match(/^([A-Z]\d|E\d):\s+(PASS|FAIL)\b/)?.[1])
      .filter(Boolean);

    expect(criterionIds).toMatchInlineSnapshot(`
[
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
]
`);
  }, 150000);
});
