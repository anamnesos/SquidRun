const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CLI_RESUME_STRATEGY,
  FORBIDDEN_CLAUDE_FLAGS,
  detectCli,
  resumeStrategyForCommand,
  encodeClaudeProjectDir,
  claudeSessionStorePath,
  claudeSessionExists,
  resolveResumeAppendFlags,
} = require('../modules/cli-resume-invocation');
const {
  ensurePaneSessionId,
  getPaneSessionId,
  loadPaneSessionIds,
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
  });
});
