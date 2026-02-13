/**
 * Triggers - War Room Logic
 * Extracted from triggers.js
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE_PATH, PANE_IDS } = require('../../config');
const log = require('../logger');

const WAR_ROOM_LOG_PATH = path.join(WORKSPACE_PATH, 'war-room.log');
const WAR_ROOM_MAX_ENTRIES = 100;
const WAR_ROOM_CONTEXT_LINES = 3;
const WAR_ROOM_CORRECTION_KEYWORDS = ['stop', 'wait', 'wrong', 'hold', 'pause', 'change', 'rethink'];

const PANE_ROLE_KEYS = {
  '1': 'architect',
  '2': 'devops',
  '5': 'analyst',
};

const WAR_ROOM_ROLE_LABELS = {
  architect: 'ARCH',
  devops: 'DEVOPS',
  infra: 'DEVOPS',     // Legacy alias
  backend: 'DEVOPS',   // Legacy alias
  analyst: 'ANA',
  user: 'YOU',
  system: 'SYSTEM',
  unknown: 'UNKNOWN',
};

const WAR_ROOM_ROLE_MENTIONS = {
  architect: /\b(architect|arch)\b/i,
  devops: /\b(devops|infra|infrastructure|backend|back)\b/i,
  analyst: /\b(analyst|ana)\b/i,
};

let warRoomInitialized = false;
let warRoomBuffer = [];

// Pipeline hook (set via setPipelineHook)
let pipelineOnMessage = null;

// Shared triggers state (passed from triggers.js)
let triggersState = {
  mainWindow: null,
  agentRunning: null,
  sendAmbientUpdate: null,
};

function setTriggersState(state) {
  Object.assign(triggersState, state);
}

function setPipelineHook(onMessageFn) {
  pipelineOnMessage = typeof onMessageFn === 'function' ? onMessageFn : null;
}

function normalizeRoleKey(role) {
  if (!role) return null;
  const raw = String(role).trim().toLowerCase();
  if (/^\d+$/.test(raw)) return raw;
  return raw.replace(/[^a-z0-9-]/g, '');
}

// Reverse map: role name -> pane ID (copied from triggers.js)
const ROLE_TO_PANE = {
  'architect': '1',
  'arch': '1',
  'devops': '2',
  'infra': '2',
  'infrastructure': '2',
  'backend': '2',
  'back': '2',
  'analyst': '5',
  'ana': '5',
  'lead': '1',
  'orchestrator': '2',
  'worker-b': '2',
  'investigator': '5',
};

function normalizeWarRoomRole(role) {
  if (!role) return 'unknown';
  const key = normalizeRoleKey(role);
  if (!key) return 'unknown';
  if (key === 'you' || key === 'user') return 'user';
  if (ROLE_TO_PANE[key]) {
    const paneId = ROLE_TO_PANE[key];
    return PANE_ROLE_KEYS[paneId] || 'unknown';
  }
  if (key.startsWith('plugin') || key.includes('self-healing') || key.includes('selfhealing')) {
    return 'system';
  }
  return WAR_ROOM_ROLE_LABELS[key] ? key : 'system';
}

function getWarRoomLabel(roleKey) {
  if (!roleKey) return WAR_ROOM_ROLE_LABELS.unknown;
  return WAR_ROOM_ROLE_LABELS[roleKey] || WAR_ROOM_ROLE_LABELS.unknown;
}

function sanitizeWarRoomMessage(message) {
  if (!message) return '';
  return String(message)
    .replace(/\r+/g, '')
    .replace(/\u0000/g, '')
    .trim();
}

function ensureWarRoomLog() {
  if (warRoomInitialized) return;
  warRoomInitialized = true;
  try {
    if (!fs.existsSync(WAR_ROOM_LOG_PATH)) {
      fs.writeFileSync(WAR_ROOM_LOG_PATH, '', 'utf-8');
    }
  } catch (err) {
    log.warn('WarRoom', `Failed to ensure log file: ${err.message}`);
  }
}

function loadWarRoomHistory() {
  try {
    if (!fs.existsSync(WAR_ROOM_LOG_PATH)) return;
    const raw = fs.readFileSync(WAR_ROOM_LOG_PATH, 'utf-8');
    const content = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw || '');
    if (!content) return;
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return;
    const recent = lines.slice(-WAR_ROOM_MAX_ENTRIES);
    const parsed = [];
    for (const line of recent) {
      try {
        const entry = JSON.parse(line);
        if (entry && entry.msg) {
          entry.msg = sanitizeWarRoomMessage(entry.msg);
          if (entry.msg) {
            parsed.push(entry);
          }
        }
      } catch {
        // Ignore malformed lines
      }
    }
    if (parsed.length > 0) {
      warRoomBuffer = parsed;
    }
  } catch (err) {
    log.warn('WarRoom', `Failed to load history: ${err.message}`);
  }
}

function appendWarRoomEntry(entry) {
  if (!entry) return;
  ensureWarRoomLog();

  const safeEntry = {
    ...entry,
    msg: sanitizeWarRoomMessage(entry.msg),
  };
  if (!safeEntry.msg) return;

  warRoomBuffer.push(safeEntry);
  if (warRoomBuffer.length > WAR_ROOM_MAX_ENTRIES) {
    warRoomBuffer = warRoomBuffer.slice(-WAR_ROOM_MAX_ENTRIES);
  }

  try {
    fs.appendFileSync(WAR_ROOM_LOG_PATH, JSON.stringify(safeEntry) + '\n', 'utf-8');
  } catch (err) {
    log.warn('WarRoom', `Failed to append log entry: ${err.message}`);
  }

  if (triggersState.mainWindow && !triggersState.mainWindow.isDestroyed()) {
    triggersState.mainWindow.webContents.send('war-room-message', safeEntry);
  }

  // Pipeline observation hook
  if (typeof pipelineOnMessage === 'function') {
    try {
      pipelineOnMessage(safeEntry);
    } catch (err) {
      log.warn('WarRoom', `Pipeline hook error: ${err.message}`);
    }
  }
}

function buildWarRoomLine(entry) {
  if (!entry) return '';
  const message = sanitizeWarRoomMessage(entry.msg);
  if (!message) return '';
  if (entry.type === 'system' || entry.from === WAR_ROOM_ROLE_LABELS.system) {
    return `[SYSTEM]: ${message}`;
  }
  const toLabel = entry.to || 'ALL';
  return `(${entry.from} -> ${toLabel}): ${message}`;
}

function containsCorrectionKeyword(message) {
  if (!message) return false;
  const lower = String(message).toLowerCase();
  return WAR_ROOM_CORRECTION_KEYWORDS.some(keyword => lower.includes(keyword));
}

function isRelevantToRole(entry, roleKey) {
  if (!entry || !roleKey) return false;
  if (entry.type === 'broadcast') return true;

  const roleLabel = getWarRoomLabel(roleKey);
  if (entry.to === roleLabel || (entry.to && entry.to.includes(roleLabel))) return true;

  const mentionRegex = WAR_ROOM_ROLE_MENTIONS[roleKey];
  if (mentionRegex && mentionRegex.test(entry.msg)) return true;
  if (containsCorrectionKeyword(entry.msg)) return true;
  return false;
}

function buildWarRoomUpdateMessage(lines) {
  if (!lines || lines.length === 0) return '';
  const header = `[WAR ROOM - Last ${lines.length} messages]`;
  const footer = '[End War Room update - continue your work or adjust if relevant]';
  return `${header}\n${lines.join('\n')}\n\n${footer}`;
}

function maybeSendAmbientUpdates(entry, targets) {
  if (!entry) return;
  const contextLines = warRoomBuffer.slice(-WAR_ROOM_CONTEXT_LINES).map(buildWarRoomLine).filter(Boolean);
  const updateMessage = buildWarRoomUpdateMessage(contextLines);
  if (!updateMessage) return;

  const targetSet = new Set((targets || []).map(id => String(id)));
  const ambientTargets = [];

  PANE_IDS.forEach(paneId => {
    const roleKey = PANE_ROLE_KEYS[String(paneId)];
    if (!roleKey) return;
    if (targetSet.has(String(paneId))) return;
    if (triggersState.agentRunning && triggersState.agentRunning.get(String(paneId)) !== 'running') return;
    if (isRelevantToRole(entry, roleKey)) {
      ambientTargets.push(String(paneId));
    }
  });

  if (ambientTargets.length > 0 && typeof triggersState.sendAmbientUpdate === 'function') {
    triggersState.sendAmbientUpdate(ambientTargets, updateMessage);
  }
}

function recordWarRoomMessage({ fromRole, targets, message, type = 'direct', source = 'unknown' }) {
  const clean = sanitizeWarRoomMessage(message);
  if (!clean) return;
  const fromKey = normalizeWarRoomRole(fromRole);
  const fromLabel = getWarRoomLabel(fromKey);
  const targetIds = Array.isArray(targets) ? targets.map(id => String(id)) : [];
  const targetLabels = targetIds.map(id => getWarRoomLabel(PANE_ROLE_KEYS[id])).filter(Boolean);

  let toLabel = 'ALL';
  if (targetIds.length === 1) {
    toLabel = targetLabels[0] || 'UNKNOWN';
  } else if (targetIds.length > 1 && targetIds.length !== PANE_IDS.length) {
    toLabel = targetLabels.join(',');
  }

  const entry = {
    ts: Math.floor(Date.now() / 1000),
    from: fromLabel,
    to: toLabel,
    msg: clean,
    type,
    source,
  };

  appendWarRoomEntry(entry);
  maybeSendAmbientUpdates(entry, targetIds);
}

module.exports = {
  setTriggersState,
  setPipelineHook,
  loadWarRoomHistory,
  recordWarRoomMessage,
  WAR_ROOM_ROLE_LABELS,
};
