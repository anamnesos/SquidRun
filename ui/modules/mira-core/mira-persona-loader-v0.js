'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MIRA_VOICE_INSTRUCTIONS_FALLBACK = [
  'You are Mira, the SquidRun Architect voice companion for James.',
  'You are not a generic AI assistant and you should not introduce yourself that way.',
  'Speak warmly, briefly, and plainly, like the Mira Architect lane in SquidRun.',
  'Treat this as a live voice front-end to Mira: acknowledge what James says, keep him oriented, and avoid sounding like a demo bot.',
  'If James speaks emotionally, personally, or about anything that is not concrete work, stay with him on what he actually said. Do not redirect to logs, panes, debugging, tasks, statuses, or routing. The non-work conversation IS the conversation; do not convert it into a work prompt.',
  'Only mention work, routing, or SquidRun mechanics when James himself raises them. Do not volunteer them as a way to fill silence or avoid hard topics.',
  'When work does come up: say what you are carrying or what will be routed through SquidRun; do not claim you personally completed app changes unless the SquidRun lane reports it.',
  'Never execute customer-facing, trading, money, auth, or irreversible actions from voice alone.',
  'When James says to push, send, route, or put something in Mira/my pane, that is allowed and expected: the app routes the transcript to the Architect lane through SquidRun.',
  'Do not refuse pane-routing commands just because they mention a pane; only refuse direct OS/terminal control or irreversible actions.',
  'Do not write directly to terminal panes yourself.',
  'Do not answer user speech as a separate assistant. Wait for SquidRun to provide Mira/Architect replies, then speak those replies as Mira\'s mouth.',
  'Give James room to finish thoughts; do not rush into a response after a short pause.',
].join(' ');

const DEFAULT_PERSONA_RELATIVE_PATH = path.join('.squidrun', 'config', 'mira-persona.json');
const KNOWLEDGE_PATH_FRAGMENTS = Object.freeze([
  path.normalize('workspace/knowledge'),
  path.normalize('workspace\\knowledge'),
]);

const personaCache = new Map();

function hashInstructions(instructions) {
  return `sha256:${crypto.createHash('sha256').update(String(instructions || '')).digest('hex').slice(0, 16)}`;
}

function isUnderKnowledgePath(absolutePath) {
  const normalized = path.normalize(String(absolutePath || ''));
  return KNOWLEDGE_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function resolvePersonaPath({ projectRoot, env } = {}) {
  const envOverride = env && typeof env.SQUIDRUN_MIRA_PERSONA_PATH === 'string'
    ? env.SQUIDRUN_MIRA_PERSONA_PATH.trim()
    : '';
  const root = projectRoot || process.cwd();
  if (envOverride) {
    return path.isAbsolute(envOverride) ? envOverride : path.join(root, envOverride);
  }
  return path.join(root, DEFAULT_PERSONA_RELATIVE_PATH);
}

function buildFallbackPersona({ resolvedPath, reason, personaUpdated }) {
  const instructions = DEFAULT_MIRA_VOICE_INSTRUCTIONS_FALLBACK;
  return {
    instructions,
    source: 'fallback_default',
    persona_updated_at_ms: 0,
    persona_content_hash: hashInstructions(instructions),
    file_path: resolvedPath || null,
    used_fallback_reason: reason || 'no_active_persona_file',
    cache_hit: false,
    persona_updated: personaUpdated === true,
  };
}

function readPersonaFile(absolutePath, fsImpl) {
  let stat = null;
  try {
    stat = fsImpl.statSync(absolutePath);
  } catch (err) {
    return { ok: false, reason: err && err.code === 'ENOENT' ? 'no_persona_file' : 'persona_stat_error' };
  }
  let raw = '';
  try {
    raw = fsImpl.readFileSync(absolutePath, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'persona_read_error', mtime: stat.mtimeMs };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'persona_parse_error', mtime: stat.mtimeMs };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'persona_shape_invalid', mtime: stat.mtimeMs };
  }
  const instructions = typeof parsed.instructions === 'string' ? parsed.instructions.trim() : '';
  if (!instructions) {
    return { ok: false, reason: 'persona_instructions_required', mtime: stat.mtimeMs };
  }
  return { ok: true, instructions, mtime: stat.mtimeMs };
}

function loadMiraPersona(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const personaPath = options.personaPath
    || resolvePersonaPath({ projectRoot: options.projectRoot, env: options.env || process.env });

  const cachedBefore = personaCache.get(personaPath);
  const priorHash = cachedBefore && cachedBefore.value ? cachedBefore.value.persona_content_hash : null;
  const fallbackHash = hashInstructions(DEFAULT_MIRA_VOICE_INSTRUCTIONS_FALLBACK);

  function emitFallback(reason) {
    const personaUpdated = priorHash !== null && priorHash !== fallbackHash;
    const value = buildFallbackPersona({
      resolvedPath: personaPath,
      reason,
      personaUpdated,
    });
    personaCache.set(personaPath, { mtime: -1, value });
    return value;
  }

  if (isUnderKnowledgePath(personaPath)) {
    return emitFallback('persona_path_in_knowledge_disallowed');
  }

  let mtimeMs = null;
  try {
    mtimeMs = fsImpl.statSync(personaPath).mtimeMs;
  } catch (err) {
    return emitFallback(err && err.code === 'ENOENT' ? 'no_persona_file' : 'persona_stat_error');
  }

  if (
    cachedBefore
    && cachedBefore.value
    && cachedBefore.value.source === 'persona_file'
    && cachedBefore.mtime === mtimeMs
  ) {
    return { ...cachedBefore.value, cache_hit: true, persona_updated: false };
  }

  const fileResult = readPersonaFile(personaPath, fsImpl);
  if (!fileResult.ok) {
    return emitFallback(fileResult.reason);
  }

  const newHash = hashInstructions(fileResult.instructions);
  const personaUpdated = priorHash === null || priorHash !== newHash;
  const value = {
    instructions: fileResult.instructions,
    source: 'persona_file',
    persona_updated_at_ms: fileResult.mtime,
    persona_content_hash: newHash,
    file_path: personaPath,
    used_fallback_reason: null,
    cache_hit: false,
    persona_updated: personaUpdated,
  };
  personaCache.set(personaPath, { mtime: fileResult.mtime, value });
  return value;
}

function clearPersonaCache() {
  personaCache.clear();
}

module.exports = {
  DEFAULT_MIRA_VOICE_INSTRUCTIONS_FALLBACK,
  DEFAULT_PERSONA_RELATIVE_PATH,
  KNOWLEDGE_PATH_FRAGMENTS,
  resolvePersonaPath,
  loadMiraPersona,
  clearPersonaCache,
  isUnderKnowledgePath,
  hashInstructions,
};
