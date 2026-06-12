const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CLI_RESUME_STRATEGY,
  FORBIDDEN_CLAUDE_FLAGS,
  detectCli,
  resumeStrategyForCommand,
  extractClaudeSessionIdFromCommand,
  hasClaudeResumeFlag,
  stripClaudeResumeFlags,
  normalizeClaudeModelId,
  parseClaudeModelFromCommand,
  readClaudeDefaultModel,
  ensureClaudeModelFlag,
  isClaudeSessionInUseError,
  encodeClaudeProjectDir,
  claudeSessionStorePath,
  claudeSessionExists,
  resolveResumeAppendFlags,
} = require('../modules/cli-resume-invocation');
const {
  ensurePaneSessionId,
  getPaneSessionId,
  loadPaneSessionIds,
  remintPaneSessionId,
} = require('../modules/pane-session-id-store');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('cli-resume-invocation', () => {
  describe('detectCli / strategy', () => {
    test('keys claude and codex; does not default unknown to a CLI', () => {
      expect(detectCli('claude')).toBe('claude');
      expect(detectCli('codex --yolo')).toBe('codex');
      expect(detectCli('C:/bin/claude.cmd')).toBe('claude');
      expect(detectCli('weird-cli')).toBeNull();
      expect(detectCli('')).toBeNull();
    });

    test('strategy map: claude=session-id resume, codex=none (cold by design)', () => {
      expect(CLI_RESUME_STRATEGY.claude).toBe('session-id');
      expect(CLI_RESUME_STRATEGY.codex).toBe('none');
      expect(resumeStrategyForCommand('claude')).toBe('session-id');
      expect(resumeStrategyForCommand('codex --yolo')).toBe('none');
      expect(resumeStrategyForCommand('weird-cli')).toBe('none');
    });
  });

  describe('resolveResumeAppendFlags (existence-keyed create vs resume)', () => {
    test('claude WITH existing session -> --resume <id>', () => {
      const d = resolveResumeAppendFlags({ command: 'claude', sessionId: 'abc', sessionExists: true });
      expect(d.flags).toBe('--resume abc');
      expect(d.mode).toBe('resume');
    });

    test('recognizes existing claude pin flags without appending duplicates', () => {
      const d = resolveResumeAppendFlags({
        command: 'claude --dangerously-skip-permissions --session-id 11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        sessionExists: false,
      });
      expect(d.flags).toBe('');
      expect(d.mode).toBe('already-pinned');
      expect(d.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    });

    test('claude with NO existing session -> --session-id <id> (create)', () => {
      const d = resolveResumeAppendFlags({ command: 'claude', sessionId: 'abc', sessionExists: false });
      expect(d.flags).toBe('--session-id abc');
      expect(d.mode).toBe('create');
    });

    test('claude with no id available -> cold (no flags)', () => {
      const d = resolveResumeAppendFlags({ command: 'claude', sessionId: null, sessionExists: false });
      expect(d.flags).toBe('');
      expect(d.mode).toBe('cold');
    });

    test('built claude invocation NEVER contains --fork-session or bare --continue', () => {
      const resume = resolveResumeAppendFlags({ command: 'claude', sessionId: 'abc', sessionExists: true }).flags;
      const create = resolveResumeAppendFlags({ command: 'claude', sessionId: 'abc', sessionExists: false }).flags;
      for (const flags of [resume, create]) {
        for (const forbidden of FORBIDDEN_CLAUDE_FLAGS) {
          // word-boundary check so --resume is not flagged for containing -c style substrings
          const tokens = flags.split(/\s+/);
          expect(tokens).not.toContain(forbidden);
        }
        expect(flags).not.toMatch(/--fork-session/);
      }
      // and the resume/create flags ARE one of the two id-addressed forms
      expect(resume).toMatch(/^--resume /);
      expect(create).toMatch(/^--session-id /);
    });

    test('codex arm -> explicit cold-start, no resume, with logged reason', () => {
      const d = resolveResumeAppendFlags({ command: 'codex --yolo', sessionId: 'abc', sessionExists: true });
      expect(d.flags).toBe('');
      expect(d.mode).toBe('cold');
      expect(d.strategy).toBe('none');
      expect(d.reason).toMatch(/codex/i);
      expect(d.reason).toMatch(/cold-start by design/i);
      expect(d.flags).not.toMatch(/--last/);
      expect(d.flags).not.toMatch(/resume/);
    });

    test('unknown CLI -> bare command (no flags)', () => {
      expect(resolveResumeAppendFlags({ command: 'weird-cli', sessionId: 'abc', sessionExists: true }).flags).toBe('');
    });

    test('extracts and strips claude resume flags for remint recovery', () => {
      const command = 'claude --dangerously-skip-permissions --resume 11111111-1111-4111-8111-111111111111';
      expect(extractClaudeSessionIdFromCommand(command)).toBe('11111111-1111-4111-8111-111111111111');
      expect(hasClaudeResumeFlag(command)).toBe(true);
      expect(stripClaudeResumeFlags(command)).toBe('claude --dangerously-skip-permissions');
    });

    test('parses and preserves explicit claude model flags', () => {
      expect(parseClaudeModelFromCommand('claude --model opus')).toBe('opus');
      expect(parseClaudeModelFromCommand('claude --model=claude-fable-5')).toBe('claude-fable-5');
      expect(parseClaudeModelFromCommand('claude --model "claude-sonnet-4-6"')).toBe('claude-sonnet-4-6');
      expect(ensureClaudeModelFlag('claude --model opus', { preferredModel: 'fable' })).toBe('claude --model opus');
    });

    test('normalizes Claude settings model values before appending', () => {
      expect(normalizeClaudeModelId(' claude-fable-5[1m] ')).toBe('claude-fable-5');
      expect(normalizeClaudeModelId('\u001b[1mopus\u001b[0m')).toBe('opus');
      expect(normalizeClaudeModelId('bad model with spaces')).toBe('');
      expect(ensureClaudeModelFlag('claude', { preferredModel: 'claude-fable-5[1m]' }))
        .toBe('claude --model claude-fable-5');
    });

    test('reads Claude user default model from an injectable settings path', () => {
      const settingsPath = path.join(os.tmpdir(), `claude-settings-${Date.now()}-${Math.random()}.json`);
      fs.writeFileSync(settingsPath, JSON.stringify({ model: 'claude-fable-5[1m]' }), 'utf8');
      try {
        expect(readClaudeDefaultModel({ settingsPath })).toBe('claude-fable-5');
        expect(ensureClaudeModelFlag('claude --dangerously-skip-permissions', { settingsPath }))
          .toBe('claude --dangerously-skip-permissions --model claude-fable-5');
      } finally {
        fs.rmSync(settingsPath, { force: true });
      }
    });

    test('detects claude already-in-use collision output', () => {
      expect(isClaudeSessionInUseError('Error: session id 11111111-1111-4111-8111-111111111111 is already in use.')).toBe(true);
      expect(isClaudeSessionInUseError('regular startup output')).toBe(false);
    });
  });

  describe('claude session store path encoding', () => {
    test('encodes drive-colon and separators to dashes (D:\\projects\\squidrun -> D--projects-squidrun)', () => {
      expect(encodeClaudeProjectDir('D:\\projects\\squidrun')).toBe('D--projects-squidrun');
      expect(encodeClaudeProjectDir('D:/projects/TrustQuote')).toBe('D--projects-TrustQuote');
    });

    test('store path ends at <encodedCwd>/<sessionId>.jsonl', () => {
      const p = claudeSessionStorePath('D:\\projects\\squidrun', 'sid', { homeDir: 'C:\\home' });
      expect(p.replace(/\\/g, '/')).toMatch(/\.claude\/projects\/D--projects-squidrun\/sid\.jsonl$/);
    });
  });

  describe('end-to-end with the real fs probe + per-pane id store', () => {
    let tmp;
    let home;
    let idStorePath;
    const SHARED_CWD = 'D:\\projects\\squidrun'; // all 3 core panes share this cwd

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-test-'));
      home = path.join(tmp, 'home');
      idStorePath = path.join(tmp, 'pane-session-ids.json');
      fs.mkdirSync(home, { recursive: true });
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const writeClaudeSession = (cwd, sessionId) => {
      const dir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(cwd));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n');
    };

    // Mirror the daemon spawn decision for a claude pane.
    const claudeInvocationFor = (paneId, cwd) => {
      const { sessionId } = ensurePaneSessionId(idStorePath, paneId);
      const exists = claudeSessionExists(cwd, sessionId, { homeDir: home });
      return { sessionId, ...resolveResumeAppendFlags({ command: 'claude', sessionId, sessionExists: exists }) };
    };

    test('never-run pane -> --session-id (create), generated UUID is a valid UUID', () => {
      const inv = claudeInvocationFor('1', SHARED_CWD);
      expect(inv.mode).toBe('create');
      expect(inv.flags).toBe(`--session-id ${inv.sessionId}`);
      expect(inv.sessionId).toMatch(UUID_RE);
    });

    test('respawn after session exists -> --resume same id (per-pane UUID stable in/out)', () => {
      const first = claudeInvocationFor('1', SHARED_CWD);
      expect(first.mode).toBe('create');
      // simulate claude having created the session on first spawn
      writeClaudeSession(SHARED_CWD, first.sessionId);
      const second = claudeInvocationFor('1', SHARED_CWD);
      expect(second.sessionId).toBe(first.sessionId); // stable across respawn
      expect(second.mode).toBe('resume');
      expect(second.flags).toBe(`--resume ${first.sessionId}`);
    });

    test('two claude panes in the SAME cwd get DIFFERENT resume ids (no cross-wire)', () => {
      const p1 = claudeInvocationFor('1', SHARED_CWD);
      const p2 = claudeInvocationFor('2', SHARED_CWD);
      expect(p1.sessionId).not.toBe(p2.sessionId);
      // and the persisted store reflects two distinct ids
      const store = loadPaneSessionIds(idStorePath);
      expect(getPaneSessionId(store, '1')).not.toBe(getPaneSessionId(store, '2'));
    });

    test('ensurePaneSessionId is idempotent (does not regenerate)', () => {
      const a = ensurePaneSessionId(idStorePath, '3');
      const b = ensurePaneSessionId(idStorePath, '3');
      expect(a.generated).toBe(true);
      expect(b.generated).toBe(false);
      expect(a.sessionId).toBe(b.sessionId);
    });

    test('remintPaneSessionId replaces one pane id without touching siblings', () => {
      const p1 = ensurePaneSessionId(idStorePath, '1', { generate: () => '11111111-1111-4111-8111-111111111111' });
      ensurePaneSessionId(idStorePath, '2', { generate: () => '22222222-2222-4222-8222-222222222222' });

      const reminted = remintPaneSessionId(idStorePath, '1', { generate: () => '33333333-3333-4333-8333-333333333333' });
      const store = loadPaneSessionIds(idStorePath);

      expect(reminted.previousSessionId).toBe(p1.sessionId);
      expect(reminted.sessionId).toBe('33333333-3333-4333-8333-333333333333');
      expect(store.panes['1']).toBe('33333333-3333-4333-8333-333333333333');
      expect(store.panes['2']).toBe('22222222-2222-4222-8222-222222222222');
    });
  });
});
