/**
 * B4c — THE TELEGRAM STEP OUTCOME IS RECORDED, NOT RETURNED AND DROPPED.
 *
 * Oracle #9 / Architect #32: `produceTerminalReceipt` returns
 * `terminal_claude_submission_id_unsupported` — a correct, deliberate refusal —
 * and the adapter discarded it and emitted the generic receipt status. The
 * consequence is not cosmetic: a runtime that CANNOT produce terminal proof
 * became indistinguishable from one that merely had not yet, and the only trace
 * a hook had run at all was a debugging breadcrumb that proves invocation and
 * says nothing about outcome.
 *
 * These tests drive the REAL adapter as a child process against an ISOLATED
 * project root. Nothing here reads or writes the live tree.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const UI_ROOT = path.join(__dirname, '..');
const ADAPTER = path.join(UI_ROOT, 'scripts', 'model-prompt-receipt-adapter.js');

const roots = [];

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-step-outcome-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.squidrun', 'runtime'), { recursive: true });
  return root;
}

/** Run the adapter exactly as a configured hook does: payload on stdin. */
function runAdapter(root, { runtime, event, payload }) {
  const result = spawnSync(
    process.execPath,
    [ADAPTER, '--runtime', runtime, '--event', event],
    {
      cwd: UI_ROOT,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        SQUIDRUN_PROJECT_ROOT: root,
        SQUIDRUN_PANE_ID: '2',
        SQUIDRUN_PANE_LAUNCH_ID: 'pl_11111111111111111111111111111111',
      },
    }
  );
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function readOutcomes(root) {
  const file = path.join(root, '.squidrun', 'runtime', 'telegram-step-outcomes.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

afterAll(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('the adapter records what the Telegram step actually did', () => {
  test("claude's terminal refusal is written down, with its reason", () => {
    const root = freshRoot();
    const run = runAdapter(root, {
      runtime: 'claude',
      event: 'Stop',
      payload: { session_id: 'sess-claude-1', cwd: root },
    });

    // The prompt is never blocked by any of this.
    expect(run.status).toBe(0);

    const outcomes = readOutcomes(root).filter((row) => row.phase === 'terminal');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].runtime).toBe('claude');
    expect(outcomes[0].ok).toBe(false);
    // THE EXACT REASON, not a generic "nothing happened". Asserting the precise
    // string is the difference between "a refusal was recorded" and "THIS
    // refusal was recorded" — and only the second one tells health that Claude
    // structurally cannot emit a per-submission id.
    expect(outcomes[0].reason).toBe('terminal_claude_submission_id_unsupported');
    expect(outcomes[0].written).toBe(false);
  });

  test('codex records a DIFFERENT terminal reason, so the two never mask', () => {
    // Cross-runtime masking is this lane's recurring shape: one runtime
    // succeeding (or failing) made the other look the same. Codex's refusal
    // names a MISSING FIELD, which is a fixable payload question; Claude's
    // names an UNSUPPORTED CAPABILITY, which is not. Collapsing them into one
    // "no terminal proof" would send someone to fix the wrong thing.
    //
    // This also makes the spool the instrument that settles the open
    // activation prerequisite: when a real Codex Stop fires, this row says
    // whether its payload carried a usable turn_id instead of us assuming a
    // fixture shape.
    const root = freshRoot();
    runAdapter(root, {
      runtime: 'codex', event: 'Stop', payload: { session_id: 'sess-codex-stop', cwd: root },
    });

    const outcomes = readOutcomes(root).filter((row) => row.phase === 'terminal');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].runtime).toBe('codex');
    expect(outcomes[0].reason).toBe('terminal_codex_turn_id_missing');
    expect(outcomes[0].reason).not.toBe('terminal_claude_submission_id_unsupported');
  });

  test('a non-Telegram prompt records handled:false rather than nothing', () => {
    // Silence and "not a Telegram delivery" are different facts, and only one
    // of them means the hook ran.
    const root = freshRoot();
    const run = runAdapter(root, {
      runtime: 'codex',
      event: 'UserPromptSubmit',
      payload: { session_id: 'sess-codex-1', prompt: 'just a normal prompt', cwd: root },
    });
    expect(run.status).toBe(0);

    const outcomes = readOutcomes(root).filter((row) => row.phase === 'admission');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].runtime).toBe('codex');
    expect(outcomes[0].handled).toBe(false);
  });

  test('the spool is append-only across invocations', () => {
    const root = freshRoot();
    runAdapter(root, {
      runtime: 'claude', event: 'Stop', payload: { session_id: 's1', cwd: root },
    });
    runAdapter(root, {
      runtime: 'claude', event: 'Stop', payload: { session_id: 's2', cwd: root },
    });
    expect(readOutcomes(root).filter((row) => row.phase === 'terminal')).toHaveLength(2);
  });

  test('an unwritable spool never fails the prompt', () => {
    // Diagnostics are diagnostics. A hook that fails a prompt is a worse bug
    // than a missing record, and this path must stay fail-open for the user
    // while the admission record itself stays fail-closed.
    const root = freshRoot();
    const spool = path.join(root, '.squidrun', 'runtime', 'telegram-step-outcomes.jsonl');
    // A DIRECTORY where the file belongs: appendFileSync cannot write it.
    fs.mkdirSync(spool, { recursive: true });

    const run = runAdapter(root, {
      runtime: 'claude', event: 'Stop', payload: { session_id: 'sess-blocked', cwd: root },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('hookSpecificOutput');
  });
});
