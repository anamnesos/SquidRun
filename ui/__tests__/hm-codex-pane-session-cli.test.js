const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'hm-codex-pane-session.js');

function run(args, options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  for (const key of options.removeEnv || []) delete env[key];
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env,
    input: options.input,
  });
}

describe('hm-codex-pane-session CLI parsing', () => {
  let tempDir;
  let receiptsPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-codex-pane-cli-'));
    receiptsPath = path.join(tempDir, 'receipts.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('--help prints usage, exits successfully, and writes no receipt', () => {
    const result = run(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hm-codex-pane-session.js capture');
    expect(fs.existsSync(receiptsPath)).toBe(false);
  });

  test('option-before-command fails without being mistaken for capture or writing a receipt', () => {
    const result = run(['--receipts', receiptsPath]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      reason: 'command_required_before_options',
    });
    expect(fs.existsSync(receiptsPath)).toBe(false);
  });

  test('SessionStart capture falls back to payload session identity when Codex env IDs are absent', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const cwd = path.join(tempDir, 'project');
    const home = path.join(tempDir, 'home');
    const transcriptDir = path.join(home, '.codex', 'sessions', '2026', '08', '20');
    const transcriptPath = path.join(transcriptDir, `rollout-${sessionId}.jsonl`);
    const storePath = path.join(tempDir, 'bindings.json');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(transcriptPath, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, cwd },
    })}\n`, 'utf8');

    const result = run([
      'capture',
      '--store', storePath,
      '--receipts', receiptsPath,
      '--home-dir', home,
      '--pane-id', '2',
      '--role', 'builder',
      '--profile', 'main',
      '--project-root', cwd,
      '--expected-cwd', cwd,
      '--pane-launch-id', 'pl_22222222222222222222222222222222',
      '--app-generation', 'app-session-519',
    ], {
      input: JSON.stringify({ session_id: sessionId, cwd, transcript_path: transcriptPath }),
      removeEnv: ['CODEX_SESSION_ID', 'CODEX_THREAD_ID'],
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      ok: true,
      binding: expect.objectContaining({ sessionId, threadId: sessionId }),
    }));
    expect(JSON.parse(fs.readFileSync(receiptsPath, 'utf8').trim())).toEqual(expect.objectContaining({
      ok: true,
      reason: null,
      sessionId,
      appGeneration: 'app-session-519',
    }));
  });
});
