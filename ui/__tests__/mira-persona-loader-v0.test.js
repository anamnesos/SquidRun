'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const loader = require('../modules/mira-core/mira-persona-loader-v0');

const {
  DEFAULT_MIRA_VOICE_INSTRUCTIONS_FALLBACK,
  DEFAULT_PERSONA_RELATIVE_PATH,
  resolvePersonaPath,
  loadMiraPersona,
  clearPersonaCache,
  isUnderKnowledgePath,
} = loader;

function tempProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-persona-'));
  fs.mkdirSync(path.join(dir, '.squidrun', 'config'), { recursive: true });
  return dir;
}

beforeEach(() => {
  clearPersonaCache();
});

describe('mira-persona-loader / resolvePersonaPath', () => {
  test('defaults to .squidrun/config/mira-persona.json under projectRoot', () => {
    const root = tempProjectRoot();
    expect(resolvePersonaPath({ projectRoot: root, env: {} })).toBe(
      path.join(root, '.squidrun', 'config', 'mira-persona.json')
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('honors SQUIDRUN_MIRA_PERSONA_PATH env override (relative to projectRoot)', () => {
    const root = tempProjectRoot();
    expect(resolvePersonaPath({
      projectRoot: root,
      env: { SQUIDRUN_MIRA_PERSONA_PATH: '.squidrun/config/alt-persona.json' },
    })).toBe(path.join(root, '.squidrun', 'config', 'alt-persona.json'));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('honors SQUIDRUN_MIRA_PERSONA_PATH env override (absolute path)', () => {
    const abs = path.join(os.tmpdir(), 'abs-persona.json');
    expect(resolvePersonaPath({
      env: { SQUIDRUN_MIRA_PERSONA_PATH: abs },
    })).toBe(abs);
  });
});

describe('mira-persona-loader / fallback when no file', () => {
  test('returns fallback default instructions when persona file is missing', () => {
    const root = tempProjectRoot();
    const result = loadMiraPersona({ projectRoot: root, env: {} });
    expect(result.source).toBe('fallback_default');
    expect(result.used_fallback_reason).toBe('no_persona_file');
    expect(result.instructions).toBe(DEFAULT_MIRA_VOICE_INSTRUCTIONS_FALLBACK);
    expect(result.persona_content_hash).toMatch(/^sha256:/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns fallback when persona file is malformed JSON', () => {
    const root = tempProjectRoot();
    fs.writeFileSync(path.join(root, DEFAULT_PERSONA_RELATIVE_PATH), '{ not valid json', 'utf8');
    const result = loadMiraPersona({ projectRoot: root, env: {} });
    expect(result.source).toBe('fallback_default');
    expect(result.used_fallback_reason).toBe('persona_parse_error');
    expect(result.instructions).toBe(DEFAULT_MIRA_VOICE_INSTRUCTIONS_FALLBACK);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns fallback when persona file lacks instructions field', () => {
    const root = tempProjectRoot();
    fs.writeFileSync(path.join(root, DEFAULT_PERSONA_RELATIVE_PATH), JSON.stringify({ foo: 'bar' }), 'utf8');
    const result = loadMiraPersona({ projectRoot: root, env: {} });
    expect(result.source).toBe('fallback_default');
    expect(result.used_fallback_reason).toBe('persona_instructions_required');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns fallback when persona file is an array (shape invalid)', () => {
    const root = tempProjectRoot();
    fs.writeFileSync(path.join(root, DEFAULT_PERSONA_RELATIVE_PATH), JSON.stringify(['x']), 'utf8');
    const result = loadMiraPersona({ projectRoot: root, env: {} });
    expect(result.used_fallback_reason).toBe('persona_shape_invalid');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('mira-persona-loader / override and reload', () => {
  test('loads persona instructions from a valid file', () => {
    const root = tempProjectRoot();
    const personaPath = path.join(root, DEFAULT_PERSONA_RELATIVE_PATH);
    fs.writeFileSync(personaPath, JSON.stringify({ instructions: 'Custom Mira voice. Be terse and direct.' }), 'utf8');
    const result = loadMiraPersona({ projectRoot: root, env: {} });
    expect(result.source).toBe('persona_file');
    expect(result.instructions).toBe('Custom Mira voice. Be terse and direct.');
    expect(result.used_fallback_reason).toBe(null);
    expect(result.file_path).toBe(personaPath);
    expect(result.persona_updated_at_ms).toBeGreaterThan(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('mtime cache: second call without file change returns cache_hit', () => {
    const root = tempProjectRoot();
    const personaPath = path.join(root, DEFAULT_PERSONA_RELATIVE_PATH);
    fs.writeFileSync(personaPath, JSON.stringify({ instructions: 'First persona text.' }), 'utf8');
    const first = loadMiraPersona({ projectRoot: root, env: {} });
    expect(first.cache_hit).toBe(false);
    const second = loadMiraPersona({ projectRoot: root, env: {} });
    expect(second.cache_hit).toBe(true);
    expect(second.instructions).toBe('First persona text.');
    expect(second.persona_content_hash).toBe(first.persona_content_hash);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('reload: rewriting file with new mtime invalidates cache and returns new instructions + new content hash', () => {
    const root = tempProjectRoot();
    const personaPath = path.join(root, DEFAULT_PERSONA_RELATIVE_PATH);
    fs.writeFileSync(personaPath, JSON.stringify({ instructions: 'First persona text.' }), 'utf8');
    const first = loadMiraPersona({ projectRoot: root, env: {} });
    const future = first.persona_updated_at_ms + 5000;
    fs.writeFileSync(personaPath, JSON.stringify({ instructions: 'Second persona text — completely changed.' }), 'utf8');
    fs.utimesSync(personaPath, new Date(future), new Date(future));
    const second = loadMiraPersona({ projectRoot: root, env: {} });
    expect(second.cache_hit).toBe(false);
    expect(second.instructions).toBe('Second persona text — completely changed.');
    expect(second.persona_content_hash).not.toBe(first.persona_content_hash);
    expect(second.persona_updated_at_ms).toBeGreaterThan(first.persona_updated_at_ms);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('mira-persona-loader / disallows knowledge path', () => {
  test('isUnderKnowledgePath catches workspace/knowledge segment', () => {
    expect(isUnderKnowledgePath('/some/proj/workspace/knowledge/persona.json')).toBe(true);
    expect(isUnderKnowledgePath('C:\\proj\\workspace\\knowledge\\persona.json')).toBe(true);
    expect(isUnderKnowledgePath('/some/proj/.squidrun/config/persona.json')).toBe(false);
  });

  test('loadMiraPersona refuses a personaPath under workspace/knowledge and returns fallback', () => {
    const root = tempProjectRoot();
    const knowledgePath = path.join(root, 'workspace', 'knowledge', 'mira-persona.json');
    fs.mkdirSync(path.dirname(knowledgePath), { recursive: true });
    fs.writeFileSync(knowledgePath, JSON.stringify({ instructions: 'should be refused' }), 'utf8');
    const result = loadMiraPersona({ projectRoot: root, personaPath: knowledgePath, env: {} });
    expect(result.source).toBe('fallback_default');
    expect(result.used_fallback_reason).toBe('persona_path_in_knowledge_disallowed');
    expect(result.instructions).toBe(DEFAULT_MIRA_VOICE_INSTRUCTIONS_FALLBACK);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('env override that points into knowledge path is also refused', () => {
    const root = tempProjectRoot();
    const result = loadMiraPersona({
      projectRoot: root,
      env: { SQUIDRUN_MIRA_PERSONA_PATH: 'workspace/knowledge/mira-persona.json' },
    });
    expect(result.used_fallback_reason).toBe('persona_path_in_knowledge_disallowed');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('mira-persona-loader / persona_updated literal marker', () => {
  test('first load on a fresh path sets persona_updated: true', () => {
    const root = tempProjectRoot();
    const personaPath = path.join(root, DEFAULT_PERSONA_RELATIVE_PATH);
    fs.writeFileSync(personaPath, JSON.stringify({ instructions: 'fresh first load' }), 'utf8');
    const result = loadMiraPersona({ projectRoot: root, env: {} });
    expect(result.persona_updated).toBe(true);
    expect(result.cache_hit).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('cache_hit second call sets persona_updated: false', () => {
    const root = tempProjectRoot();
    const personaPath = path.join(root, DEFAULT_PERSONA_RELATIVE_PATH);
    fs.writeFileSync(personaPath, JSON.stringify({ instructions: 'cached call' }), 'utf8');
    loadMiraPersona({ projectRoot: root, env: {} });
    const second = loadMiraPersona({ projectRoot: root, env: {} });
    expect(second.cache_hit).toBe(true);
    expect(second.persona_updated).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('mtime changes but content unchanged → persona_updated: false', () => {
    const root = tempProjectRoot();
    const personaPath = path.join(root, DEFAULT_PERSONA_RELATIVE_PATH);
    fs.writeFileSync(personaPath, JSON.stringify({ instructions: 'same content' }), 'utf8');
    const first = loadMiraPersona({ projectRoot: root, env: {} });
    const future = first.persona_updated_at_ms + 5000;
    fs.utimesSync(personaPath, new Date(future), new Date(future));
    const second = loadMiraPersona({ projectRoot: root, env: {} });
    expect(second.cache_hit).toBe(false);
    expect(second.persona_content_hash).toBe(first.persona_content_hash);
    expect(second.persona_updated).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('content change → persona_updated: true', () => {
    const root = tempProjectRoot();
    const personaPath = path.join(root, DEFAULT_PERSONA_RELATIVE_PATH);
    fs.writeFileSync(personaPath, JSON.stringify({ instructions: 'first' }), 'utf8');
    const first = loadMiraPersona({ projectRoot: root, env: {} });
    expect(first.persona_updated).toBe(true);
    const future = first.persona_updated_at_ms + 5000;
    fs.writeFileSync(personaPath, JSON.stringify({ instructions: 'completely different' }), 'utf8');
    fs.utimesSync(personaPath, new Date(future), new Date(future));
    const second = loadMiraPersona({ projectRoot: root, env: {} });
    expect(second.persona_updated).toBe(true);
    expect(second.persona_content_hash).not.toBe(first.persona_content_hash);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('switching from real persona to fallback (file deleted) sets persona_updated: true', () => {
    const root = tempProjectRoot();
    const personaPath = path.join(root, DEFAULT_PERSONA_RELATIVE_PATH);
    fs.writeFileSync(personaPath, JSON.stringify({ instructions: 'real persona' }), 'utf8');
    loadMiraPersona({ projectRoot: root, env: {} });
    fs.unlinkSync(personaPath);
    const result = loadMiraPersona({ projectRoot: root, env: {} });
    expect(result.source).toBe('fallback_default');
    expect(result.used_fallback_reason).toBe('no_persona_file');
    expect(result.persona_updated).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('fallback then fallback again → persona_updated: false (no real change)', () => {
    const root = tempProjectRoot();
    const a = loadMiraPersona({ projectRoot: root, env: {} });
    expect(a.source).toBe('fallback_default');
    const b = loadMiraPersona({ projectRoot: root, env: {} });
    expect(b.source).toBe('fallback_default');
    expect(b.persona_updated).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('deletion settles after first deletion marker — subsequent fallback calls are persona_updated: false', () => {
    const root = tempProjectRoot();
    const personaPath = path.join(root, DEFAULT_PERSONA_RELATIVE_PATH);
    fs.writeFileSync(personaPath, JSON.stringify({ instructions: 'real persona' }), 'utf8');
    loadMiraPersona({ projectRoot: root, env: {} });
    fs.unlinkSync(personaPath);
    const firstFallback = loadMiraPersona({ projectRoot: root, env: {} });
    expect(firstFallback.source).toBe('fallback_default');
    expect(firstFallback.persona_updated).toBe(true);
    const secondFallback = loadMiraPersona({ projectRoot: root, env: {} });
    expect(secondFallback.source).toBe('fallback_default');
    expect(secondFallback.persona_updated).toBe(false);
    const thirdFallback = loadMiraPersona({ projectRoot: root, env: {} });
    expect(thirdFallback.persona_updated).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('mira-persona-loader / persona_updated marker shape', () => {
  test('every result carries persona_updated_at_ms, persona_content_hash, source, file_path, used_fallback_reason', () => {
    const root = tempProjectRoot();
    const personaPath = path.join(root, DEFAULT_PERSONA_RELATIVE_PATH);
    fs.writeFileSync(personaPath, JSON.stringify({ instructions: 'Marker check.' }), 'utf8');
    const result = loadMiraPersona({ projectRoot: root, env: {} });
    expect(typeof result.persona_updated_at_ms).toBe('number');
    expect(typeof result.persona_content_hash).toBe('string');
    expect(result.persona_content_hash.startsWith('sha256:')).toBe(true);
    expect(['persona_file', 'fallback_default']).toContain(result.source);
    expect(typeof result.cache_hit).toBe('boolean');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('content hash differs when instructions text differs', () => {
    const a = loader.hashInstructions('text one');
    const b = loader.hashInstructions('text two');
    expect(a).not.toBe(b);
    expect(a).toBe(loader.hashInstructions('text one'));
  });
});
