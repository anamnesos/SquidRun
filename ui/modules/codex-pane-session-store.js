const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  canonicalPathContains,
  canonicalPathsEqual,
  canonicalizePathIdentity,
  comparablePathIdentity,
} = require('./canonical-path');

const SCHEMA = 'squidrun.codex_pane_sessions.v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PANE_LAUNCH_RE = /^pl_[0-9a-f]{32}$/i;
const APP_GENERATION_RE = /^app-session-[1-9][0-9]*$/i;
const CORE_PANE_ROLES = Object.freeze({
  '1': 'architect',
  '2': 'builder',
  '3': 'oracle',
});

function normalizePath(value) {
  return comparablePathIdentity(value, { allowMissing: true }) || '';
}

function ok(value = {}) {
  return { ok: true, ...value };
}

function fail(reason, detail = {}) {
  return { ok: false, reason, ...detail };
}

function normalizePaneId(value) {
  return String(value ?? '').trim();
}

function normalizeRole(value) {
  return String(value ?? '').trim().toLowerCase();
}

function defaultCodexSessionRoot(options = {}) {
  return path.join(options.homeDir || os.homedir(), '.codex', 'sessions');
}

function parseFirstSessionMeta(transcriptPath) {
  let handle;
  try {
    handle = fs.openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(256 * 1024);
    const count = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, count).toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return fail('transcript_first_record_malformed');
      }
      if (parsed?.type !== 'session_meta' || !parsed.payload || typeof parsed.payload !== 'object') {
        return fail('transcript_first_record_not_session_meta');
      }
      const sessionId = String(parsed.payload.session_id || parsed.payload.id || '').trim();
      const cwd = String(parsed.payload.cwd || '').trim();
      return ok({ sessionId, cwd });
    }
    return fail('transcript_empty');
  } catch (err) {
    return fail('transcript_unreadable', { message: err.message });
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* best effort */ }
    }
  }
}

function validateTranscript(input = {}, options = {}) {
  const transcriptPath = String(input.transcriptPath || '').trim();
  if (!transcriptPath) return fail('transcript_path_missing');

  const configuredRoot = options.codexSessionRoot || defaultCodexSessionRoot(options);
  const transcriptLexical = path.resolve(transcriptPath);
  const parsedTranscript = path.parse(transcriptLexical);
  const lexicalParts = transcriptLexical.slice(parsedTranscript.root.length)
    .split(path.sep)
    .filter(Boolean);
  let lexicalCursor = parsedTranscript.root;
  let lexicalMissing = false;
  for (const part of lexicalParts) {
    lexicalCursor = path.join(lexicalCursor, part);
    try {
      if (fs.lstatSync(lexicalCursor).isSymbolicLink()) {
        return fail('transcript_symlink_refused');
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        lexicalMissing = true;
        break;
      }
      return fail('transcript_unreadable', { message: err.message });
    }
  }

  const rootResolved = canonicalizePathIdentity(configuredRoot, { allowMissing: false });
  const transcriptResolved = canonicalizePathIdentity(transcriptPath, { allowMissing: true });
  if (!rootResolved) return fail('codex_session_root_missing');
  if (!transcriptResolved || !canonicalPathContains(rootResolved, transcriptResolved, {
    allowEqual: true,
    allowMissing: true,
  })) {
    return fail('transcript_outside_codex_session_store');
  }
  if (lexicalMissing) return fail('transcript_missing');

  const rootReal = rootResolved;
  const transcriptReal = canonicalizePathIdentity(transcriptPath, { allowMissing: false });
  if (!rootReal) return fail('codex_session_root_missing');
  if (!transcriptReal) return fail('transcript_missing');
  if (!canonicalPathContains(rootReal, transcriptReal, { allowEqual: true, allowMissing: false })) {
    return fail('transcript_outside_codex_session_store');
  }

  let stat;
  try {
    stat = fs.statSync(transcriptReal);
  } catch (err) {
    return fail('transcript_unreadable', { message: err.message });
  }
  if (!stat.isFile()) return fail('transcript_not_regular_file');

  const meta = parseFirstSessionMeta(transcriptReal);
  if (!meta.ok) return meta;
  if (!UUID_RE.test(meta.sessionId) || meta.sessionId.toLowerCase() !== String(input.sessionId || '').toLowerCase()) {
    return fail('transcript_session_id_mismatch');
  }
  if (!meta.cwd || !canonicalPathsEqual(meta.cwd, input.cwd, { allowMissing: true })) {
    return fail('transcript_cwd_mismatch');
  }
  return ok({ transcriptPath: transcriptReal, sessionMeta: meta });
}

function validateBindingFacts(input = {}, options = {}) {
  const paneId = normalizePaneId(input.paneId);
  const role = normalizeRole(input.role);
  const profile = String(input.profile || '').trim().toLowerCase();
  const sessionId = String(input.sessionId || '').trim();
  const threadId = String(input.threadId || '').trim();
  const cwd = String(input.cwd || '').trim();
  const projectRoot = String(input.projectRoot || '').trim();
  const expectedCwd = String(options.expectedCwd || input.expectedCwd || projectRoot || '').trim();

  if (!Object.hasOwn(CORE_PANE_ROLES, paneId)) return fail('pane_not_core');
  if (role !== CORE_PANE_ROLES[paneId]) return fail('pane_role_mismatch');
  if (profile !== 'main') return fail('profile_not_main');
  if (!UUID_RE.test(sessionId)) return fail('session_id_invalid');
  if (!UUID_RE.test(threadId) || threadId.toLowerCase() !== sessionId.toLowerCase()) {
    return fail('thread_id_mismatch');
  }
  if (options.requireRuntimeEnvIds === true) {
    const envSessionId = String(input.envSessionId || '').trim();
    const envThreadId = String(input.envThreadId || '').trim();
    if (envSessionId && !UUID_RE.test(envSessionId)) {
      return fail('env_session_id_missing_or_invalid');
    }
    if (envThreadId && !UUID_RE.test(envThreadId)) {
      return fail('env_thread_id_missing_or_invalid');
    }
    if (envSessionId && envSessionId.toLowerCase() !== sessionId.toLowerCase()) {
      return fail('env_session_id_mismatch');
    }
    if (envThreadId && envThreadId.toLowerCase() !== sessionId.toLowerCase()) {
      return fail('env_thread_id_mismatch');
    }
  }
  if (!cwd || !projectRoot || !expectedCwd) return fail('cwd_identity_missing');
  if (!canonicalPathsEqual(cwd, projectRoot, { allowMissing: true })
      || !canonicalPathsEqual(cwd, expectedCwd, { allowMissing: true })) {
    return fail('cwd_identity_mismatch');
  }
  if (!PANE_LAUNCH_RE.test(String(input.paneLaunchId || '').trim())) {
    return fail('pane_launch_id_invalid');
  }
  if (!APP_GENERATION_RE.test(String(input.appGeneration || '').trim())) {
    return fail('app_generation_invalid');
  }

  const transcript = validateTranscript({
    transcriptPath: input.transcriptPath,
    sessionId,
    cwd,
  }, options);
  if (!transcript.ok) return transcript;

  return ok({
    binding: {
      cli: 'codex',
      sessionId,
      threadId,
      paneId,
      role,
      profile,
      cwd: path.resolve(cwd),
      projectRoot: path.resolve(projectRoot),
      transcriptPath: transcript.transcriptPath,
      paneLaunchId: String(input.paneLaunchId).trim(),
      appGeneration: String(input.appGeneration).trim(),
      boundAt: input.boundAt || new Date().toISOString(),
      source: 'codex_session_start_hook',
    },
  });
}

function emptyStore() {
  return { schema: SCHEMA, panes: {} };
}

function loadStore(storePath) {
  try {
    if (!fs.existsSync(storePath)) return ok({ store: emptyStore(), exists: false });
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!parsed || parsed.schema !== SCHEMA || !parsed.panes || typeof parsed.panes !== 'object' || Array.isArray(parsed.panes)) {
      return fail('binding_store_malformed');
    }
    return ok({ store: { schema: SCHEMA, panes: { ...parsed.panes } }, exists: true });
  } catch (err) {
    return fail('binding_store_malformed', { message: err.message });
  }
}

function sleepSync(ms) {
  const array = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(array, 0, 0, ms);
}

function withStoreLock(storePath, fn, options = {}) {
  const lockPath = `${storePath}.lock`;
  const retries = Number.isInteger(options.lockRetries) ? options.lockRetries : 80;
  const delayMs = Number.isInteger(options.lockDelayMs) ? options.lockDelayMs : 25;
  const staleMs = Number.isInteger(options.lockStaleMs) ? options.lockStaleMs : 30_000;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });

  let lockHandle;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      lockHandle = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(lockHandle, `${process.pid}\n`, 'utf8');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') return fail('binding_store_lock_failed', { message: err.message });
      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (ageMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* another writer may have released it */ }
      if (attempt === retries) return fail('binding_store_lock_timeout');
      sleepSync(delayMs);
    }
  }

  try {
    return fn();
  } finally {
    try { if (lockHandle !== undefined) fs.closeSync(lockHandle); } catch { /* best effort */ }
    try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
  }
}

function atomicWriteStore(storePath, store) {
  const tempPath = `${storePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tempPath, storePath);
    return ok();
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    return fail('binding_store_write_failed', { message: err.message });
  }
}

function captureBinding(storePath, input = {}, options = {}) {
  const validated = validateBindingFacts(input, { ...options, requireRuntimeEnvIds: true });
  if (!validated.ok) return validated;
  const binding = validated.binding;

  return withStoreLock(storePath, () => {
    const loaded = loadStore(storePath);
    if (!loaded.ok) return loaded;
    for (const [otherPaneId, other] of Object.entries(loaded.store.panes)) {
      if (otherPaneId !== binding.paneId
          && String(other?.sessionId || '').toLowerCase() === binding.sessionId.toLowerCase()) {
        return fail('session_id_claimed_by_other_pane', { otherPaneId });
      }
    }
    loaded.store.panes[binding.paneId] = binding;
    const written = atomicWriteStore(storePath, loaded.store);
    return written.ok ? ok({ binding, created: !loaded.exists }) : written;
  }, options);
}

function loadValidatedBinding(storePath, paneId, options = {}) {
  const id = normalizePaneId(paneId);
  const loaded = loadStore(storePath);
  if (!loaded.ok) return loaded;
  const raw = loaded.store.panes[id];
  if (!raw) return fail('binding_absent');

  const validated = validateBindingFacts({
    ...raw,
    paneId: id,
    envSessionId: null,
    envThreadId: null,
    expectedCwd: options.expectedCwd,
  }, options);
  if (!validated.ok) return validated;
  for (const [otherPaneId, other] of Object.entries(loaded.store.panes)) {
    if (otherPaneId !== id
        && String(other?.sessionId || '').toLowerCase() === validated.binding.sessionId.toLowerCase()) {
      return fail('session_id_claimed_by_other_pane', { otherPaneId });
    }
  }
  return ok({ binding: validated.binding });
}

function snapshotPaneBinding(storePath, paneId) {
  const id = normalizePaneId(paneId);
  if (!Object.hasOwn(CORE_PANE_ROLES, id)) return fail('pane_not_core');
  const loaded = loadStore(storePath);
  if (!loaded.ok) return loaded;
  const raw = loaded.store.panes[id];
  if (!raw) return ok({ paneId: id, exists: false, sessionId: null });
  const sessionId = String(raw.sessionId || '').trim();
  if (!UUID_RE.test(sessionId)) return fail('stored_session_id_invalid');
  const paneLaunchId = String(raw.paneLaunchId || '').trim();
  const boundAt = String(raw.boundAt || '').trim();
  if (!paneLaunchId || !boundAt) return fail('stored_binding_provenance_invalid');
  return ok({
    paneId: id,
    exists: true,
    sessionId,
    bindingSnapshot: { sessionId, paneLaunchId, boundAt },
  });
}

function clearPaneBinding(storePath, paneId, options = {}) {
  const id = normalizePaneId(paneId);
  if (!Object.hasOwn(CORE_PANE_ROLES, id)) return fail('pane_not_core');
  return withStoreLock(storePath, () => {
    const loaded = loadStore(storePath);
    if (!loaded.ok) return loaded;
    const current = loaded.store.panes[id];
    if (!current) return ok({ cleared: false, paneId: id });
    const hasExpectedBinding = options.expectedBinding
      && typeof options.expectedBinding === 'object'
      && !Array.isArray(options.expectedBinding);
    if (hasExpectedBinding || Object.hasOwn(options, 'expectedSessionId')) {
      const expected = hasExpectedBinding ? options.expectedBinding : options;
      const expectedSessionId = expected.sessionId === null || options.expectedSessionId === null
        ? null
        : String(expected.sessionId || options.expectedSessionId || '').trim().toLowerCase();
      const currentSessionId = String(current.sessionId || '').trim().toLowerCase();
      const expectedPaneLaunchId = hasExpectedBinding
        ? String(expected.paneLaunchId || '').trim()
        : '';
      const expectedBoundAt = hasExpectedBinding
        ? String(expected.boundAt || '').trim()
        : '';
      const provenanceMismatch = hasExpectedBinding && (
        !expectedPaneLaunchId
        || !expectedBoundAt
        || String(current.paneLaunchId || '').trim() !== expectedPaneLaunchId
        || String(current.boundAt || '').trim() !== expectedBoundAt
      );
      if (expectedSessionId === null
          || currentSessionId !== expectedSessionId
          || provenanceMismatch) {
        return ok({
          cleared: false,
          rotated: true,
          paneId: id,
          currentSessionId: current.sessionId || null,
          currentPaneLaunchId: current.paneLaunchId || null,
          currentBoundAt: current.boundAt || null,
        });
      }
    }
    const previous = current;
    delete loaded.store.panes[id];
    const written = atomicWriteStore(storePath, loaded.store);
    return written.ok ? ok({ cleared: true, paneId: id, previous }) : written;
  }, options);
}

module.exports = {
  SCHEMA,
  UUID_RE,
  CORE_PANE_ROLES,
  normalizePath,
  defaultCodexSessionRoot,
  parseFirstSessionMeta,
  validateTranscript,
  validateBindingFacts,
  emptyStore,
  loadStore,
  captureBinding,
  loadValidatedBinding,
  snapshotPaneBinding,
  clearPaneBinding,
};
