'use strict';

const {
  buildScopedReadinessChecklist,
  formatScopedContextResult,
  validateScopedContext,
} = require('../modules/scoped-context-firewall');

describe('scoped-context-firewall', () => {
  test('accepts fresh context matching the active profile and project', () => {
    const result = validateScopedContext({
      profileName: 'main',
      windowKey: 'main',
      sessionId: '312',
      projectPath: 'D:\\projects\\squidrun',
      generatedAtMs: 10_000,
    }, {
      profileName: 'main',
      windowKey: 'main',
      sessionId: '312',
      projectPath: 'D:/projects/squidrun',
      nowMs: 20_000,
      maxAgeMs: 60_000,
    });

    expect(result.ok).toBe(true);
    expect(formatScopedContextResult(result)).toBe('Scoped context accepted');
  });

  test('rejects stale side-profile context before pane routing', () => {
    const result = validateScopedContext({
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionId: '186',
      projectPath: 'D:\\projects\\squidrun\\.squidrun\\profiles\\eunbyeol\\workspace',
      generatedAtMs: 1_000,
    }, {
      profileName: 'main',
      windowKey: 'main',
      sessionId: '312',
      projectPath: 'D:/projects/squidrun',
      nowMs: 700_000,
      maxAgeMs: 60_000,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toEqual(expect.arrayContaining([
      'profile_mismatch',
      'window_mismatch',
      'session_mismatch',
      'project_path_mismatch',
      'stale_context',
    ]));
    expect(formatScopedContextResult(result)).toContain('Scoped context rejected');
  });

  test('builds a readiness checklist for side-profile launches', () => {
    const checklist = buildScopedReadinessChecklist({
      profileIdentity: true,
      sameProfileRoutes: true,
      diagnosticChannel: false,
      noReplayLeak: true,
      scopedArtifacts: true,
    });

    expect(checklist.ok).toBe(false);
    expect(checklist.failed).toEqual(['diagnostic_channel']);
  });
});
