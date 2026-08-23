const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const UI_ROOT = path.join(__dirname, '..');
const ADAPTER = path.join(UI_ROOT, 'scripts', 'model-prompt-receipt-adapter.js');
const tempRoots = [];

function freshRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `model-prompt-adapter-${label}-`));
  tempRoots.push(root);
  return root;
}

function runAdapter(args, payload = {}, env = {}) {
  const run = spawnSync(process.execPath, [ADAPTER, ...args], {
    cwd: UI_ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return {
    status: run.status,
    stdout: String(run.stdout || ''),
    stderr: String(run.stderr || ''),
  };
}

function parseOnlyStdoutJson(run) {
  const output = run.stdout.trim();
  expect(output).not.toBe('');
  expect(output.split(/\r?\n/)).toHaveLength(1);
  return JSON.parse(output);
}

function parseLastStdoutJson(run) {
  const lines = run.stdout.trim().split(/\r?\n/).filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]);
}

afterAll(() => {
  for (const root of tempRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('model prompt receipt adapter hook output contracts', () => {
  test('Codex Stop emits only the accepted continue acknowledgement', () => {
    const root = freshRoot('codex-stop');
    const run = runAdapter(
      ['--runtime', 'codex', '--event', 'Stop'],
      {
        session_id: 'codex-stop-success',
        turn_id: 'codex-stop-turn-success',
        cwd: root,
      },
      {
        SQUIDRUN_PROJECT_ROOT: root,
        SQUIDRUN_PANE_LAUNCH_ID: 'codex-stop-launch-success',
      }
    );

    expect(run.status).toBe(0);
    // The turn/launch pair forces produceTerminalReceipt through the real
    // TelegramAdmissionWriter/EvidenceLedger open. Before the logger guard,
    // that open prepended "SQLite driver selected" to stdout and made the
    // following JSON invalid as a Codex hook response.
    expect(fs.existsSync(path.join(root, '.squidrun', 'runtime', 'evidence-ledger.db'))).toBe(true);
    const response = parseOnlyStdoutJson(run);
    expect(response).toEqual({ continue: true });
    expect(Object.keys(response)).toEqual(['continue']);
  });

  test('Codex Stop error path still emits only the accepted acknowledgement', () => {
    const root = freshRoot('codex-stop-error');
    const notADirectory = path.join(root, 'not-a-directory');
    fs.writeFileSync(notADirectory, 'force install failure', 'utf8');

    const run = runAdapter([
      'install',
      '--runtime', 'codex',
      '--event', 'Stop',
      '--project-root', notADirectory,
    ]);

    expect(run.status).toBe(0);
    expect(run.stderr).toContain('[model-prompt-receipt-adapter]');
    const response = parseOnlyStdoutJson(run);
    expect(response).toEqual({ continue: true });
    expect(Object.keys(response)).toEqual(['continue']);
  });

  test.each([
    ['codex', 'UserPromptSubmit', false],
    ['codex', 'SessionStart', true],
    ['claude', 'Stop', false],
    ['gemini', 'BeforeAgent', false],
  ])('%s %s preserves the existing hook-specific response', (runtime, event, trustCheckOnly) => {
    const root = freshRoot(`${runtime}-${event}`);
    const args = ['--runtime', runtime, '--event', event];
    if (trustCheckOnly) args.push('--trust-check-only');
    const run = runAdapter(
      args,
      { session_id: `${runtime}-${event}`, cwd: root, prompt: 'ordinary prompt' },
      { SQUIDRUN_PROJECT_ROOT: root }
    );

    expect(run.status).toBe(0);
    expect(parseLastStdoutJson(run)).toEqual({
      hookSpecificOutput: { hookEventName: event },
    });
  });
});
