const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SCHEMA,
  captureBinding,
  clearPaneBinding,
  loadStore,
  loadValidatedBinding,
} = require('../modules/codex-pane-session-store');
const {
  _internals: { appendResumeFlagsToAgentCommand },
} = require('../modules/ipc/pty-handlers');
const {
  decideCodexMissingResumeRecovery,
  decideCodexResumeFailureAuthority,
} = require('../modules/cli-resume-invocation');

const IDS = {
  builder: '11111111-1111-4111-8111-111111111111',
  oracle: '22222222-2222-4222-8222-222222222222',
};

describe('codex-pane-session-store', () => {
  let root;
  let home;
  let sessionRoot;
  let storePath;
  let receiptsPath;
  const cwd = path.resolve('D:/projects/squidrun');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pane-session-'));
    home = path.join(root, 'home');
    sessionRoot = path.join(home, '.codex', 'sessions');
    storePath = path.join(root, 'runtime', 'codex-pane-sessions.json');
    receiptsPath = path.join(root, 'runtime', 'receipts.jsonl');
    fs.mkdirSync(sessionRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function transcript(sessionId, transcriptCwd = cwd, directory = sessionRoot) {
    const dir = path.join(directory, '2026', '08', '20');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `rollout-test-${sessionId}.jsonl`);
    fs.writeFileSync(target, `${JSON.stringify({
      type: 'session_meta',
      payload: { session_id: sessionId, id: sessionId, cwd: transcriptCwd },
    })}\n`, 'utf8');
    return target;
  }

  function inputFor(paneId, role, sessionId, overrides = {}) {
    return {
      paneId,
      role,
      profile: 'main',
      sessionId,
      threadId: sessionId,
      envSessionId: sessionId,
      envThreadId: sessionId,
      cwd,
      projectRoot: cwd,
      expectedCwd: cwd,
      transcriptPath: transcript(sessionId),
      paneLaunchId: `pl_${paneId.repeat(32)}`,
      appGeneration: 'app-session-518',
      ...overrides,
    };
  }

  test('matching runtime facts atomically preserve two same-cwd seat bindings', () => {
    expect(captureBinding(storePath, inputFor('2', 'builder', IDS.builder), { homeDir: home }).ok).toBe(true);
    expect(captureBinding(storePath, inputFor('3', 'oracle', IDS.oracle), { homeDir: home }).ok).toBe(true);

    const loaded = loadStore(storePath);
    expect(loaded.ok).toBe(true);
    expect(loaded.store.schema).toBe(SCHEMA);
    expect(loaded.store.panes['2'].sessionId).toBe(IDS.builder);
    expect(loaded.store.panes['3'].sessionId).toBe(IDS.oracle);
    expect(fs.existsSync(`${storePath}.lock`)).toBe(false);
    expect(fs.readdirSync(path.dirname(storePath)).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  test.each([
    ['session env', { envSessionId: IDS.oracle }, 'env_session_id_mismatch'],
    ['thread env', { envThreadId: IDS.oracle }, 'env_thread_id_mismatch'],
    ['role', { role: 'oracle' }, 'pane_role_mismatch'],
    ['profile', { profile: 'case' }, 'profile_not_main'],
    ['cwd', { cwd: 'D:/projects/other' }, 'cwd_identity_mismatch'],
    ['project root', { projectRoot: 'D:/projects/other' }, 'cwd_identity_mismatch'],
    ['launch', { paneLaunchId: 'bad' }, 'pane_launch_id_invalid'],
    ['generation', { appGeneration: 'session-518' }, 'app_generation_invalid'],
  ])('refuses %s mismatch without creating a store', (_label, patch, reason) => {
    const result = captureBinding(storePath, inputFor('2', 'builder', IDS.builder, patch), { homeDir: home });
    expect(result).toMatchObject({ ok: false, reason });
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test('capture accepts absent Codex env IDs while retaining trusted hook/transcript identity', () => {
    const result = captureBinding(storePath, inputFor('2', 'builder', IDS.builder, {
      envSessionId: '',
      envThreadId: '',
    }), { homeDir: home });
    expect(result.ok).toBe(true);
    expect(result.binding).toEqual(expect.objectContaining({
      sessionId: IDS.builder,
      threadId: IDS.builder,
    }));
  });

  test.each([
    ['session env', { envSessionId: 'invalid' }, 'env_session_id_missing_or_invalid'],
    ['thread env', { envThreadId: 'invalid' }, 'env_thread_id_missing_or_invalid'],
  ])('capture rejects a present malformed %s id', (_label, patch, reason) => {
    const result = captureBinding(storePath, inputFor('2', 'builder', IDS.builder, patch), { homeDir: home });
    expect(result).toMatchObject({ ok: false, reason });
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test('refuses transcript session/cwd mismatch, escape, and directory paths', () => {
    const wrongSession = inputFor('2', 'builder', IDS.builder, {
      transcriptPath: transcript(IDS.oracle),
    });
    expect(captureBinding(storePath, wrongSession, { homeDir: home }).reason)
      .toBe('transcript_session_id_mismatch');

    const wrongCwd = inputFor('2', 'builder', IDS.builder);
    wrongCwd.transcriptPath = transcript(IDS.builder, 'D:/projects/other');
    expect(captureBinding(storePath, wrongCwd, { homeDir: home }).reason)
      .toBe('transcript_cwd_mismatch');

    const outsideRoot = path.join(root, 'outside');
    const escaped = inputFor('2', 'builder', IDS.builder, {
      transcriptPath: transcript(IDS.builder, cwd, outsideRoot),
    });
    expect(captureBinding(storePath, escaped, { homeDir: home }).reason)
      .toBe('transcript_outside_codex_session_store');

    const directory = inputFor('2', 'builder', IDS.builder, { transcriptPath: sessionRoot });
    expect(captureBinding(storePath, directory, { homeDir: home }).reason)
      .toBe('transcript_not_regular_file');
  });

  test('refuses a junction that resolves outside the Codex session store', () => {
    const outsideRoot = path.join(root, 'outside-junction');
    const outsideTranscript = transcript(IDS.builder, cwd, outsideRoot);
    const link = path.join(sessionRoot, 'linked-outside');
    fs.symlinkSync(path.dirname(outsideTranscript), link, 'junction');
    const throughLink = path.join(link, path.basename(outsideTranscript));
    const result = captureBinding(
      storePath,
      inputFor('2', 'builder', IDS.builder, { transcriptPath: throughLink }),
      { homeDir: home }
    );
    expect(result).toMatchObject({ ok: false, reason: 'transcript_symlink_refused' });
  });

  test('refuses a symlink or junction even when it resolves back inside the session store', () => {
    const realDirectory = path.join(sessionRoot, 'real-inside');
    const insideTranscript = transcript(IDS.builder, cwd, realDirectory);
    const link = path.join(sessionRoot, 'linked-inside');
    fs.symlinkSync(path.dirname(insideTranscript), link, 'junction');
    const throughLink = path.join(link, path.basename(insideTranscript));

    const result = captureBinding(
      storePath,
      inputFor('2', 'builder', IDS.builder, { transcriptPath: throughLink }),
      { homeDir: home }
    );

    expect(result).toMatchObject({ ok: false, reason: 'transcript_symlink_refused' });
  });

  test('malformed store fails closed and is not replaced', () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '{ definitely not json', 'utf8');
    const before = fs.readFileSync(storePath, 'utf8');
    const result = captureBinding(storePath, inputFor('2', 'builder', IDS.builder), { homeDir: home });
    expect(result).toMatchObject({ ok: false, reason: 'binding_store_malformed' });
    expect(fs.readFileSync(storePath, 'utf8')).toBe(before);
  });

  test('one exact session id cannot be claimed by a sibling pane', () => {
    expect(captureBinding(storePath, inputFor('2', 'builder', IDS.builder), { homeDir: home }).ok).toBe(true);
    const result = captureBinding(storePath, inputFor('3', 'oracle', IDS.builder), { homeDir: home });
    expect(result).toMatchObject({
      ok: false,
      reason: 'session_id_claimed_by_other_pane',
      otherPaneId: '2',
    });
  });

  test('load rejects a stored binding whose mandatory thread id was blanked', () => {
    expect(captureBinding(storePath, inputFor('2', 'builder', IDS.builder), { homeDir: home }).ok).toBe(true);
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    stored.panes['2'].threadId = '';
    fs.writeFileSync(storePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

    expect(loadValidatedBinding(storePath, '2', { expectedCwd: cwd, homeDir: home }))
      .toMatchObject({ ok: false, reason: 'thread_id_mismatch' });
  });

  test('revalidation rejects a moved transcript and fresh clear touches one pane only', () => {
    const builderInput = inputFor('2', 'builder', IDS.builder);
    const oracleInput = inputFor('3', 'oracle', IDS.oracle);
    expect(captureBinding(storePath, builderInput, { homeDir: home }).ok).toBe(true);
    expect(captureBinding(storePath, oracleInput, { homeDir: home }).ok).toBe(true);

    fs.renameSync(builderInput.transcriptPath, `${builderInput.transcriptPath}.moved`);
    expect(loadValidatedBinding(storePath, '2', { expectedCwd: cwd, homeDir: home }).reason)
      .toBe('transcript_missing');

    const cleared = clearPaneBinding(storePath, '2');
    expect(cleared).toMatchObject({ ok: true, cleared: true, paneId: '2' });
    const after = loadStore(storePath);
    expect(after.store.panes['2']).toBeUndefined();
    expect(after.store.panes['3'].sessionId).toBe(IDS.oracle);
    expect(fs.existsSync(oracleInput.transcriptPath)).toBe(true);
  });

  test('Fresh compare-and-delete clears the old id but preserves a hook-rotated new id', () => {
    expect(captureBinding(storePath, inputFor('2', 'builder', IDS.builder), { homeDir: home }).ok).toBe(true);

    const oldCleared = clearPaneBinding(storePath, '2', { expectedSessionId: IDS.builder });
    expect(oldCleared).toMatchObject({ ok: true, cleared: true, paneId: '2' });

    expect(captureBinding(storePath, inputFor('2', 'builder', IDS.oracle), { homeDir: home }).ok).toBe(true);
    const rotatedPreserved = clearPaneBinding(storePath, '2', { expectedSessionId: IDS.builder });
    expect(rotatedPreserved).toMatchObject({
      ok: true,
      cleared: false,
      rotated: true,
      currentSessionId: IDS.oracle,
    });
    expect(loadStore(storePath).store.panes['2'].sessionId).toBe(IDS.oracle);
  });

  test('same-id new-launch SessionStart refresh is preserved by full provenance compare', () => {
    const first = inputFor('2', 'builder', IDS.builder, {
      paneLaunchId: `pl_${'a'.repeat(32)}`,
      boundAt: '2026-08-21T06:00:00.000Z',
    });
    expect(captureBinding(storePath, first, { homeDir: home }).ok).toBe(true);
    const expectedBinding = {
      sessionId: IDS.builder,
      paneLaunchId: first.paneLaunchId,
      boundAt: first.boundAt,
    };

    const refreshed = inputFor('2', 'builder', IDS.builder, {
      paneLaunchId: `pl_${'b'.repeat(32)}`,
      boundAt: '2026-08-21T06:25:00.000Z',
    });
    expect(captureBinding(storePath, refreshed, { homeDir: home }).ok).toBe(true);

    const result = clearPaneBinding(storePath, '2', { expectedBinding });

    expect(result).toMatchObject({
      ok: true,
      cleared: false,
      rotated: true,
      currentSessionId: IDS.builder,
      currentPaneLaunchId: refreshed.paneLaunchId,
      currentBoundAt: refreshed.boundAt,
    });
    expect(loadStore(storePath).store.panes['2']).toMatchObject({
      sessionId: IDS.builder,
      paneLaunchId: refreshed.paneLaunchId,
      boundAt: refreshed.boundAt,
    });
  });

  test('confirmed nonzero missing-resume exit clears unchanged old binding for one cold retry', () => {
    const source = inputFor('2', 'builder', IDS.builder, {
      paneLaunchId: `pl_${'c'.repeat(32)}`,
      boundAt: '2026-08-21T06:10:00.000Z',
    });
    expect(captureBinding(storePath, source, { homeDir: home }).ok).toBe(true);
    const expectedBinding = {
      sessionId: source.sessionId,
      paneLaunchId: source.paneLaunchId,
      boundAt: source.boundAt,
    };
    const authority = decideCodexResumeFailureAuthority({
      candidate: 'missing_or_corrupt',
      processExited: true,
      exitCode: 1,
      recoveryAttempted: false,
    });

    expect(authority.action).toBe('inspect_binding');
    const cleared = clearPaneBinding(storePath, '2', { expectedBinding });
    expect(cleared).toMatchObject({ ok: true, cleared: true, paneId: '2' });
    expect(decideCodexMissingResumeRecovery(cleared)).toEqual({
      action: 'retry_cold',
      reason: 'rejected_binding_cleared',
    });
    expect(loadStore(storePath).store.panes['2']).toBeUndefined();
  });

  test('Fresh expected-absent snapshot preserves a binding captured before post-spawn clear', () => {
    expect(captureBinding(storePath, inputFor('2', 'builder', IDS.builder), { homeDir: home }).ok).toBe(true);

    const result = clearPaneBinding(storePath, '2', { expectedSessionId: null });

    expect(result).toMatchObject({ ok: true, cleared: false, rotated: true });
    expect(loadStore(storePath).store.panes['2'].sessionId).toBe(IDS.builder);
  });

  test('bindings store routing metadata only, never transcript prose', () => {
    const source = inputFor('2', 'builder', IDS.builder);
    fs.appendFileSync(source.transcriptPath, `${JSON.stringify({ secret: 'private prose sentinel' })}\n`);
    expect(captureBinding(storePath, source, { homeDir: home }).ok).toBe(true);
    const stored = fs.readFileSync(storePath, 'utf8');
    expect(stored).not.toContain('private prose sentinel');
    expect(stored).toContain(IDS.builder);
  });

  test('valid binding builds exact Codex resume while absent and fresh stay cold', () => {
    expect(captureBinding(storePath, inputFor('2', 'builder', IDS.builder), { homeDir: home }).ok).toBe(true);
    const resumed = appendResumeFlagsToAgentCommand({
      paneId: '2', command: 'codex --yolo', cwd, codexStorePath: storePath, homeDir: home,
    });
    expect(resumed).toMatchObject({
      command: `codex --yolo resume ${IDS.builder}`,
      decision: { cli: 'codex', mode: 'resume', sessionId: IDS.builder },
    });
    expect(resumed.command).not.toContain('--last');

    const absent = appendResumeFlagsToAgentCommand({
      paneId: '3', command: 'codex --yolo', cwd, codexStorePath: storePath, homeDir: home,
    });
    expect(absent.command).toBe('codex --yolo');
    expect(absent.decision).toMatchObject({ mode: 'cold', bindingReason: 'binding_absent' });

    const fresh = appendResumeFlagsToAgentCommand({
      paneId: '2', command: 'codex --yolo', cwd, codexStorePath: storePath,
      homeDir: home, freshSessionRequested: true,
    });
    expect(fresh.command).toBe('codex --yolo');
    expect(fresh.decision).toMatchObject({ mode: 'fresh', clearBindingOnAccepted: true });
    expect(loadStore(storePath).store.panes['2'].sessionId).toBe(IDS.builder);
  });

  test('explicit Codex resume is preserved without consulting another CLI store', () => {
    const command = `codex --yolo resume ${IDS.builder}`;
    const result = appendResumeFlagsToAgentCommand({
      paneId: '2', command, cwd, codexStorePath: path.join(root, 'missing.json'), homeDir: home,
    });
    expect(result.command).toBe(command);
    expect(result.decision).toMatchObject({ mode: 'already-pinned', sessionId: IDS.builder });
  });

  test('production resume code contains no --last or newest/content selector', () => {
    const sources = [
      path.join(__dirname, '..', 'modules', 'cli-resume-invocation.js'),
      path.join(__dirname, '..', 'modules', 'codex-pane-session-store.js'),
      path.join(__dirname, '..', 'modules', 'ipc', 'pty-handlers.js'),
      path.join(__dirname, '..', 'terminal-daemon.js'),
    ].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(sources).not.toMatch(/resume\s+--last/i);
    expect(sources).not.toMatch(/codex[^\n]*(newest|mtime|conversation text)/i);
  });
});
