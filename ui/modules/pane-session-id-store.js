const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Per-pane CLI session-id store for restart continuity.
//
// Holds a stable UUID per pane so a respawned CLI can resume its OWN prior
// conversation by id (see cli-resume-invocation.js). "Stable across restarts"
// means stable-because-persisted: the id generated on first spawn is reused on
// every respawn, so `--resume <id>` matches the `--session-id <id>` that created
// it. UUIDs are required by claude ("Must be a valid UUID"), so ids are minted
// with crypto.randomUUID — never a readable name.
const SCHEMA = 'squidrun.pane_session_ids.v0';

function normalizePaneId(value) {
  return String(value || '').trim();
}

function normalizeStore(obj) {
  if (!obj || typeof obj !== 'object') return { schema: SCHEMA, panes: {} };
  const panes = obj.panes && typeof obj.panes === 'object' ? obj.panes : {};
  return { schema: obj.schema || SCHEMA, panes: { ...panes } };
}

function loadPaneSessionIds(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return normalizeStore(null);
    return normalizeStore(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return normalizeStore(null);
  }
}

function getPaneSessionId(store, paneId) {
  const norm = normalizeStore(store);
  const id = norm.panes[normalizePaneId(paneId)];
  return typeof id === 'string' && id ? id : null;
}

function savePaneSessionIds(filePath, store) {
  const norm = normalizeStore(store);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(norm, null, 2)}\n`, 'utf8');
  return norm;
}

// Return the pane's stable UUID, generating + persisting one if absent.
// Same id in, same id out across respawns (the per-pane stability guarantee).
// `options.generate` is injectable for deterministic tests.
function ensurePaneSessionId(filePath, paneId, options = {}) {
  const generate = typeof options.generate === 'function'
    ? options.generate
    : () => crypto.randomUUID();
  const store = loadPaneSessionIds(filePath);
  const existing = getPaneSessionId(store, paneId);
  if (existing) return { sessionId: existing, generated: false };
  const sessionId = generate();
  store.panes[normalizePaneId(paneId)] = sessionId;
  savePaneSessionIds(filePath, store);
  return { sessionId, generated: true };
}

module.exports = {
  SCHEMA,
  normalizeStore,
  loadPaneSessionIds,
  getPaneSessionId,
  savePaneSessionIds,
  ensurePaneSessionId,
};
