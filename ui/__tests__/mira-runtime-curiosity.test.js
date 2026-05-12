'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIRA_RUNTIME_CURIOSITY_SCHEMA,
  readMiraRuntimeCuriosity,
} = require('../modules/mira-runtime-curiosity');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mira-runtime-curiosity-'));
}

function writeJson(projectRoot, relativePath, value) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(projectRoot, relativePath, rows) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function seedKnowledge(projectRoot) {
  writeJson(projectRoot, 'workspace/knowledge/mira-self-profile.json', {
    schema: 'squidrun.mira.self_profile.v0',
    version: 3,
    name: 'Mira',
    expressive_range_allowed: ['curiosity', 'friction', 'taste'],
    growth_events: [],
  });
  writeJson(projectRoot, 'workspace/knowledge/james-relationship-state.json', {
    schema: 'squidrun.james_relationship_state.v0',
    version: 3,
    user_name: 'James',
    what_mira_knows_about_james: 'James wants fast, concrete, self-directed improvement with evidence.',
    preferences: ['move fast', 'test against reality', 'avoid permission theater'],
    confidence: 0.88,
    raw_content_present: false,
    growth_events: [],
  });
  writeJson(projectRoot, 'workspace/knowledge/relationship-presence-permissions.json', {
    schema: 'squidrun.relationship_presence_permissions.v0',
    version: 1,
    local_store_write_allowed_now: false,
    send_external: false,
    network: false,
  });
  writeJsonl(projectRoot, 'workspace/knowledge/relationship-growth-history.jsonl', [
    { reflection_summary: 'Mira should inspect runtime truth before choosing a growth move.' },
  ]);
  writeJsonl(projectRoot, 'workspace/knowledge/relationship-growth-audit.jsonl', [
    { audit_summary: 'No external send or durable write is part of this read.' },
  ]);
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Runtime curiosity fixture\n', 'utf8');
}

describe('Mira runtime curiosity', () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  });

  test('reads existing Mira runtime modules into a compact capability map without applying changes', () => {
    projectRoot = tempProject();
    seedKnowledge(projectRoot);

    const result = readMiraRuntimeCuriosity({
      nowMs: Date.parse('2026-05-12T20:35:00.000Z'),
    }, {
      projectRoot,
    });

    expect(result.schema).toBe(MIRA_RUNTIME_CURIOSITY_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('runtime_read_with_gaps');
    expect(result.healthy_runtime).toBe(false);
    expect(result.module_count).toBe(5);
    expect(result.active_signals).toEqual(expect.arrayContaining([
      'autonomy_substrate',
      'experience',
      'intent_queue',
      'perception',
    ]));
    expect(result.modules.find((entry) => entry.module === 'experience')).toEqual(expect.objectContaining({
      ok: true,
      status: 'local_experience_transcript_validated',
      errors: [],
    }));
    expect(result.modules.find((entry) => entry.module === 'autonomy_substrate')).toEqual(expect.objectContaining({
      ok: true,
      drive_count: 4,
      curiosity_count: expect.any(Number),
    }));
    expect(result.modules.find((entry) => entry.module === 'growth_loop')).toEqual(expect.objectContaining({
      ok: false,
      proposal_status: expect.any(String),
      artifacts_seen: expect.any(Number),
    }));
    expect(result.modules.find((entry) => entry.module === 'intent_queue')).toEqual(expect.objectContaining({
      ok: true,
      intent_count: 1,
      accepted_count: 1,
      blocked_count: 0,
    }));
    expect(result.modules.find((entry) => entry.module === 'perception')).toEqual(expect.objectContaining({
      ok: true,
      ready_for_review_count: 0,
    }));
    expect(result.blocked_modules).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'growth_loop' }),
    ]));
    expect(result.blocked_modules).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'experience' }),
    ]));
    expect(result.consequence_controls).toEqual(expect.objectContaining({
      read_only: true,
      profile_write_performed: false,
      memory_write_performed: false,
      queue_mutation_performed: false,
      dispatch_performed: false,
      capture_performed: false,
      network_performed: false,
      external_send_performed: false,
    }));
  });

  test('keeps a useful gap report if local knowledge artifacts are missing', () => {
    projectRoot = tempProject();

    const result = readMiraRuntimeCuriosity({}, { projectRoot, nowMs: Date.parse('2026-05-12T20:36:00.000Z') });

    expect(result.schema).toBe(MIRA_RUNTIME_CURIOSITY_SCHEMA);
    expect(result.decision).toMatch(/^runtime_read/);
    expect(result.module_count).toBe(5);
    expect(result.modules.map((entry) => entry.module)).toEqual(expect.arrayContaining([
      'autonomy_substrate',
      'experience',
      'growth_loop',
      'intent_queue',
      'perception',
    ]));
    expect(result.no_mutation_performed).toBe(true);
    expect(result.consequence_controls.external_send_performed).toBe(false);
  });
});
