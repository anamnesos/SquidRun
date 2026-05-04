'use strict';

const DEFAULT_CONTEXT_MAX_AGE_MS = 10 * 60 * 1000;

function toNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizePath(value) {
  return toNonEmptyString(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function toTimestampMs(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function getScopeValue(input = {}, key, aliases = []) {
  if (!input || typeof input !== 'object') return '';
  const scope = input.scope && typeof input.scope === 'object' ? input.scope : {};
  const keys = [key, ...aliases];
  for (const candidate of keys) {
    const value = toNonEmptyString(scope[candidate]) || toNonEmptyString(input[candidate]);
    if (value) return value;
  }
  return '';
}

function normalizeExpectedScope(expected = {}) {
  return {
    profileName: toNonEmptyString(expected.profileName) || toNonEmptyString(expected.profile) || 'main',
    windowKey: toNonEmptyString(expected.windowKey) || toNonEmptyString(expected.window) || 'main',
    sessionId: toNonEmptyString(expected.sessionId) || toNonEmptyString(expected.session) || '',
    projectPath: normalizePath(expected.projectPath || expected.workspace || ''),
    nowMs: toTimestampMs(expected.nowMs, Date.now()),
    maxAgeMs: toTimestampMs(expected.maxAgeMs, DEFAULT_CONTEXT_MAX_AGE_MS),
  };
}

function validateScopedContext(input = {}, expected = {}) {
  const scope = normalizeExpectedScope(expected);
  const actualProfile = getScopeValue(input, 'profileName', ['profile']) || 'main';
  const actualWindow = getScopeValue(input, 'windowKey', ['window']) || actualProfile;
  const actualSession = getScopeValue(input, 'sessionId', ['session']);
  const actualProjectPath = normalizePath(getScopeValue(input, 'projectPath', ['workspace']));
  const generatedAtMs = toTimestampMs(
    input.generatedAtMs || input.timestampMs || input.receivedAtMs || input.createdAtMs,
    0
  );
  const failures = [];

  if (actualProfile !== scope.profileName) {
    failures.push({
      code: 'profile_mismatch',
      expected: scope.profileName,
      actual: actualProfile,
    });
  }

  if (actualWindow !== scope.windowKey) {
    failures.push({
      code: 'window_mismatch',
      expected: scope.windowKey,
      actual: actualWindow,
    });
  }

  if (scope.sessionId && actualSession && actualSession !== scope.sessionId) {
    failures.push({
      code: 'session_mismatch',
      expected: scope.sessionId,
      actual: actualSession,
    });
  }

  if (scope.projectPath && actualProjectPath && actualProjectPath !== scope.projectPath) {
    failures.push({
      code: 'project_path_mismatch',
      expected: scope.projectPath,
      actual: actualProjectPath,
    });
  }

  if (generatedAtMs && scope.nowMs - generatedAtMs > scope.maxAgeMs) {
    failures.push({
      code: 'stale_context',
      expected: `<=${scope.maxAgeMs}ms`,
      actual: `${scope.nowMs - generatedAtMs}ms`,
    });
  }

  return {
    ok: failures.length === 0,
    failures,
    actual: {
      profileName: actualProfile,
      windowKey: actualWindow,
      sessionId: actualSession,
      projectPath: actualProjectPath,
      generatedAtMs,
    },
    expected: scope,
  };
}

function buildScopedReadinessChecklist(results = {}) {
  const checks = [
    {
      id: 'profile_identity',
      ok: Boolean(results.profileIdentity),
      label: 'Profile identity matches launch context',
    },
    {
      id: 'same_profile_routes',
      ok: Boolean(results.sameProfileRoutes),
      label: 'Canonical targets resolve inside the same profile',
    },
    {
      id: 'diagnostic_channel',
      ok: Boolean(results.diagnosticChannel),
      label: 'Architect diagnostic channel is scoped',
    },
    {
      id: 'no_replay_leak',
      ok: Boolean(results.noReplayLeak),
      label: 'No replay or duplicate startup injection leak',
    },
    {
      id: 'scoped_artifacts',
      ok: Boolean(results.scopedArtifacts),
      label: 'Startup health and runtime artifacts are profile-scoped',
    },
  ];
  return {
    ok: checks.every((check) => check.ok),
    checks,
    failed: checks.filter((check) => !check.ok).map((check) => check.id),
  };
}

function formatScopedContextResult(result = {}) {
  if (result.ok) return 'Scoped context accepted';
  const failures = Array.isArray(result.failures) ? result.failures : [];
  return `Scoped context rejected: ${failures.map((failure) => failure.code).join(', ') || 'unknown'}`;
}

module.exports = {
  DEFAULT_CONTEXT_MAX_AGE_MS,
  buildScopedReadinessChecklist,
  formatScopedContextResult,
  normalizeExpectedScope,
  validateScopedContext,
};
