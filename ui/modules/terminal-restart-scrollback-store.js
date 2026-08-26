const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = 'squidrun.terminal.restart_scrollback.v0';
const DEFAULT_MAX_SCROLLBACK_CHARS = 50000;

function normalizePaneId(value) {
  return String(value || '').trim();
}

function normalizeScrollback(value) {
  if (Array.isArray(value)) return value.join('');
  return typeof value === 'string' ? value : String(value || '');
}

function normalizeMaxChars(value, fallback = DEFAULT_MAX_SCROLLBACK_CHARS) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimScrollback(value, maxChars = DEFAULT_MAX_SCROLLBACK_CHARS) {
  const text = normalizeScrollback(value);
  const limit = normalizeMaxChars(maxChars);
  return text.length > limit ? text.slice(-limit) : text;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeTerminalList(terminals) {
  if (terminals instanceof Map) {
    return Array.from(terminals.entries()).map(([paneId, terminal]) => ({
      paneId,
      ...terminal,
    }));
  }
  if (Array.isArray(terminals)) return terminals;
  if (Array.isArray(terminals?.terminals)) return terminals.terminals;
  return [];
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { schema: SCHEMA, savedAt: null, panes: {} };
  }
  const panes = snapshot.panes && typeof snapshot.panes === 'object' ? snapshot.panes : {};
  return {
    schema: snapshot.schema || SCHEMA,
    savedAt: snapshot.savedAt || null,
    maxScrollbackChars: snapshot.maxScrollbackChars || DEFAULT_MAX_SCROLLBACK_CHARS,
    panes,
  };
}

function paneSnapshotFromTerminal(terminal, options = {}) {
  const paneId = normalizePaneId(terminal?.paneId);
  if (!paneId) return null;
  const maxChars = normalizeMaxChars(
    terminal?.scrollbackMaxSize || options.maxScrollbackChars,
    DEFAULT_MAX_SCROLLBACK_CHARS
  );
  const scrollback = trimScrollback(terminal?.scrollback || '', maxChars);
  if (!scrollback) return null;
  return {
    paneId,
    cwd: terminal?.cwd || null,
    alive: terminal?.alive !== false,
    mode: terminal?.mode || null,
    pid: terminal?.pid || null,
    createdAt: terminal?.createdAt || null,
    lastActivity: terminal?.lastActivity || null,
    lastInputTime: terminal?.lastInputTime || null,
    scrollback,
    scrollbackChars: scrollback.length,
    scrollbackSha256: sha256(scrollback),
    savedAt: options.savedAt || new Date().toISOString(),
  };
}

function buildRestartScrollbackSnapshot(terminals, options = {}) {
  const previous = normalizeSnapshot(options.previousSnapshot);
  const maxChars = normalizeMaxChars(options.maxScrollbackChars, previous.maxScrollbackChars);
  const savedAt = options.savedAt || new Date().toISOString();
  const panes = { ...previous.panes };

  for (const terminal of normalizeTerminalList(terminals)) {
    const paneSnapshot = paneSnapshotFromTerminal(terminal, {
      maxScrollbackChars: maxChars,
      savedAt,
    });
    if (paneSnapshot) {
      panes[paneSnapshot.paneId] = paneSnapshot;
    }
  }

  return {
    schema: SCHEMA,
    savedAt,
    maxScrollbackChars: maxChars,
    panes,
  };
}

function loadRestartScrollbackSnapshot(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return normalizeSnapshot(null);
    return normalizeSnapshot(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return normalizeSnapshot(null);
  }
}

function saveRestartScrollbackSnapshot(filePath, terminals, options = {}) {
  const previous = options.previousSnapshot || loadRestartScrollbackSnapshot(filePath);
  const snapshot = buildRestartScrollbackSnapshot(terminals, {
    ...options,
    previousSnapshot: previous,
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot;
}

function getPaneSnapshot(snapshot, paneId) {
  const normalized = normalizeSnapshot(snapshot);
  return normalized.panes[normalizePaneId(paneId)] || null;
}

function mergeScrollbackWithRestartSnapshot(currentScrollback, paneSnapshot, options = {}) {
  const preserved = trimScrollback(paneSnapshot?.scrollback || '', options.maxScrollbackChars);
  const current = normalizeScrollback(currentScrollback);
  if (!preserved) return current;
  if (!current) return preserved;
  if (current.includes(preserved)) return current;

  const preservedTail = preserved.slice(-Math.min(1000, preserved.length));
  if (preservedTail && current.includes(preservedTail)) return current;

  return trimScrollback(`${preserved}${current}`, options.maxScrollbackChars);
}

function hydrateTerminalFromRestartSnapshot(terminal, snapshot, options = {}) {
  if (!terminal || typeof terminal !== 'object') return terminal;
  const paneSnapshot = getPaneSnapshot(snapshot, terminal.paneId);
  if (!paneSnapshot) return terminal;
  const merged = mergeScrollbackWithRestartSnapshot(terminal.scrollback || '', paneSnapshot, {
    maxScrollbackChars: terminal.scrollbackMaxSize || options.maxScrollbackChars,
  });
  if (merged !== (terminal.scrollback || '')) {
    terminal.scrollback = merged;
    terminal.restartScrollbackHydrated = true;
    terminal.restartScrollbackHydratedAt = Date.now();
  }
  return terminal;
}

module.exports = {
  SCHEMA,
  DEFAULT_MAX_SCROLLBACK_CHARS,
  buildRestartScrollbackSnapshot,
  getPaneSnapshot,
  hydrateTerminalFromRestartSnapshot,
  loadRestartScrollbackSnapshot,
  mergeScrollbackWithRestartSnapshot,
  normalizeSnapshot,
  saveRestartScrollbackSnapshot,
  trimScrollback,
};
