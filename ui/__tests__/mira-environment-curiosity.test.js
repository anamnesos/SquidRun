'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MIRA_ENVIRONMENT_CURIOSITY_SCHEMA,
  parseStartupHealthMarkdown,
  readMiraEnvironmentCuriosity,
} = require('../modules/mira-environment-curiosity');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mira-environment-curiosity-'));
}

function writeStartupHealth(projectRoot, content, profileName = 'main') {
  const fileName = profileName === 'main' ? 'startup-health.md' : `startup-health-${profileName}.md`;
  const healthPath = path.join(projectRoot, '.squidrun', 'build', fileName);
  fs.mkdirSync(path.dirname(healthPath), { recursive: true });
  fs.writeFileSync(healthPath, content, 'utf8');
  return healthPath;
}

describe('Mira environment curiosity read adapter', () => {
  test('parses compact startup health fields without broad raw output', () => {
    const parsed = parseStartupHealthMarkdown([
      'STARTUP HEALTH',
      '- Overall: WARN (score=88/100)',
      '- Generated: 2026-05-12T07:11:11.317Z',
      '- App Session: session 368',
      '',
      'MEMORY CONSISTENCY',
      '- Sync Status: drift_detected (attention needed)',
      '- Counts: entries=162, nodes=218, missing=9, orphans=65, duplicates=0',
      '',
      'BRIDGE HEALTH',
      '- Connection: disconnected',
      '- Runtime: mode=connecting, enabled=yes, configured=yes, required=no',
    ].join('\n'));

    expect(parsed).toEqual(expect.objectContaining({
      overall_label: 'WARN',
      overall_score: 88,
      generated_at: '2026-05-12T07:11:11.317Z',
      app_session: 'session 368',
      memory_sync_status: 'drift_detected (attention needed)',
      bridge_connection: 'disconnected',
    }));
  });

  test('reads startup health as an environment curiosity source without writes', () => {
    const projectRoot = tempProject();
    writeStartupHealth(projectRoot, [
      'STARTUP HEALTH',
      '- Overall: WARN (score=88/100)',
      '- Generated: 2026-05-12T07:11:11.317Z',
      '- Profile: main',
      '- App Session: session 368',
      '- Tests: 341 files, 341 Jest-discoverable suites',
      '- Modules: 347 JS modules under ui/modules',
      '',
      'MEMORY CONSISTENCY',
      '- Sync Status: drift_detected (attention needed)',
      '- Counts: entries=162, nodes=218, missing=9, orphans=65, duplicates=0',
      '',
      'BRIDGE HEALTH',
      '- Connection: disconnected',
      '- Runtime: mode=connecting, enabled=yes, configured=yes, required=no',
      '- Warnings: memory_consistency_drift:missing=9',
      '',
      'LOCAL MODELS',
      '- Feature Enabled: no',
    ].join('\n'));

    const result = readMiraEnvironmentCuriosity({}, {
      projectRoot,
      nowMs: Date.parse('2026-05-12T08:00:00.000Z'),
    });

    expect(result.schema).toBe(MIRA_ENVIRONMENT_CURIOSITY_SCHEMA);
    expect(result.decision).toBe('environment_health_read_only');
    expect(result.no_mutation_performed).toBe(true);
    expect(result.snapshot_stale).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      overall_label: 'WARN',
      overall_score: 88,
      memory_sync_status: 'drift_detected (attention needed)',
      bridge_connection: 'disconnected',
      local_models_enabled: 'no',
    }));
    expect(result.consequence_controls).toEqual(expect.objectContaining({
      read_only: true,
      file_write_performed: false,
      external_send_performed: false,
    }));
    expect(JSON.stringify(result)).not.toMatch(/relay-production|api_key|secret/i);
  });

  test('reports missing startup health without creating a file', () => {
    const projectRoot = tempProject();
    const result = readMiraEnvironmentCuriosity({}, { projectRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('startup_health_missing');
    expect(fs.existsSync(path.join(projectRoot, '.squidrun', 'build', 'startup-health.md'))).toBe(false);
  });
});
