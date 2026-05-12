'use strict';

const fs = require('fs');
const path = require('path');

const MIRA_ENVIRONMENT_CURIOSITY_SCHEMA = 'squidrun.mira.environment_curiosity_read_v0';
const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function oneLine(value, max = 220) {
  const text = trimText(value).replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

function parseKeyValueLine(line) {
  const match = /^-\s*([^:]+):\s*(.*)$/.exec(trimText(line));
  if (!match) return null;
  return {
    key: trimText(match[1]).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
    label: trimText(match[1]),
    value: trimText(match[2]),
  };
}

function parseOverall(value) {
  const match = /^([A-Z]+)(?:\s*\(score=(\d+)\/100\))?/i.exec(trimText(value));
  return {
    label: match ? match[1].toUpperCase() : null,
    score: match && match[2] ? Number(match[2]) : null,
  };
}

function readStartupHealthText(projectRoot, profileName = 'main') {
  const normalizedProfile = trimText(profileName || 'main').toLowerCase() || 'main';
  const fileName = normalizedProfile === 'main'
    ? 'startup-health.md'
    : `startup-health-${normalizedProfile}.md`;
  const healthPath = path.join(projectRoot, '.squidrun', 'build', fileName);
  if (!fs.existsSync(healthPath)) {
    return { ok: false, reason: 'startup_health_missing', healthPath };
  }
  return {
    ok: true,
    healthPath,
    text: fs.readFileSync(healthPath, 'utf8'),
    stat: fs.statSync(healthPath),
  };
}

function defaultLiveHealthSnapshotReader({ projectRoot, profileName, nowMs, jestTimeoutMs }) {
  try {
    const {
      createHealthSnapshot,
      renderStartupHealthMarkdown,
    } = require('../scripts/hm-health-snapshot');
    if (
      typeof createHealthSnapshot !== 'function'
      || typeof renderStartupHealthMarkdown !== 'function'
    ) {
      return { ok: false, reason: 'live_health_snapshot_unavailable' };
    }
    const snapshot = createHealthSnapshot({
      projectRoot,
      profileName,
      nowMs,
      jestTimeoutMs,
    });
    return {
      ok: true,
      text: renderStartupHealthMarkdown(snapshot),
      generated_at: snapshot.generatedAt || null,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'live_health_snapshot_failed',
      error: oneLine(err && err.message ? err.message : String(err || 'unknown error'), 180),
    };
  }
}

function normalizeLiveHealthRead(value) {
  if (!value) return { ok: false, reason: 'live_health_snapshot_empty' };
  if (typeof value === 'string') {
    return { ok: true, text: value };
  }
  if (value.ok === false) {
    return {
      ok: false,
      reason: trimText(value.reason) || 'live_health_snapshot_failed',
      error: trimText(value.error || value.message) || null,
    };
  }
  const text = typeof value.text === 'string'
    ? value.text
    : (typeof value.markdown === 'string' ? value.markdown : '');
  if (!text.trim()) {
    return { ok: false, reason: 'live_health_snapshot_empty' };
  }
  return {
    ok: true,
    text,
    generated_at: trimText(value.generated_at || value.generatedAt) || null,
  };
}

function parseStartupHealthMarkdown(text) {
  const values = {};
  const sections = [];
  let currentSection = 'startup_health';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = trimText(rawLine);
    if (!line) continue;
    if (/^[A-Z][A-Z0-9 ]+$/.test(line)) {
      currentSection = line.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      sections.push(currentSection);
      continue;
    }
    const parsed = parseKeyValueLine(line);
    if (parsed) {
      values[`${currentSection}.${parsed.key}`] = parsed.value;
    }
  }
  const overall = parseOverall(values['startup_health.overall']);
  return {
    sections,
    overall_label: overall.label,
    overall_score: overall.score,
    generated_at: values['startup_health.generated'] || null,
    profile: values['startup_health.profile'] || null,
    app_session: values['startup_health.app_session'] || null,
    tests: values['startup_health.tests'] || null,
    modules: values['startup_health.modules'] || null,
    memory_sync_status: values['memory_consistency.sync_status'] || null,
    memory_counts: values['memory_consistency.counts'] || null,
    bridge_connection: values['bridge_health.connection'] || null,
    bridge_runtime: values['bridge_health.runtime'] || null,
    bridge_warnings: values['bridge_health.warnings'] || null,
    local_models_enabled: values['local_models.feature_enabled'] || null,
  };
}

function readMiraEnvironmentCuriosity(payload = {}, options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || payload.projectRoot || process.cwd()));
  const profileName = trimText(options.profileName || payload.profileName || 'main') || 'main';
  const nowMs = Number.isFinite(Number(options.nowMs ?? payload.nowMs))
    ? Number(options.nowMs ?? payload.nowMs)
    : Date.now();
  const staleAfterMs = Math.max(1000, Number(options.staleAfterMs ?? payload.staleAfterMs ?? DEFAULT_STALE_AFTER_MS) || DEFAULT_STALE_AFTER_MS);
  const allowLiveRefresh = options.allowLiveRefresh ?? payload.allowLiveRefresh ?? true;
  const jestTimeoutMs = Math.max(1000, Number(options.jestTimeoutMs ?? payload.jestTimeoutMs ?? 10000) || 10000);
  const health = readStartupHealthText(projectRoot, profileName);
  if (!health.ok) {
    return {
      schema: MIRA_ENVIRONMENT_CURIOSITY_SCHEMA,
      ok: false,
      decision: 'unavailable_in_this_runtime',
      reason: health.reason,
      health_path: health.healthPath,
      profile_name: profileName,
      no_mutation_performed: true,
      consequence_controls: {
        internal_only: true,
        read_only: true,
        external_send_performed: false,
      },
    };
  }

  let parsed = parseStartupHealthMarkdown(health.text);
  let generatedAtMs = Date.parse(parsed.generated_at || '');
  let ageMs = Number.isFinite(generatedAtMs) ? Math.max(0, nowMs - generatedAtMs) : null;
  let stale = ageMs === null ? true : ageMs > staleAfterMs;
  const startupSnapshot = {
    generated_at: parsed.generated_at,
    snapshot_age_ms: ageMs,
    snapshot_stale: stale,
  };
  let snapshotSource = 'startup_health_file';
  let refreshAttempted = false;
  let refreshOk = false;
  let refreshReason = null;
  let refreshError = null;

  if (stale && allowLiveRefresh !== false) {
    refreshAttempted = true;
    const liveReader = typeof options.liveHealthSnapshotReader === 'function'
      ? options.liveHealthSnapshotReader
      : defaultLiveHealthSnapshotReader;
    const liveRead = normalizeLiveHealthRead(liveReader({
      projectRoot,
      profileName,
      nowMs,
      staleAfterMs,
      jestTimeoutMs,
      stale_health_path: health.healthPath,
      startup_snapshot: startupSnapshot,
    }));
    if (liveRead.ok) {
      parsed = parseStartupHealthMarkdown(liveRead.text);
      generatedAtMs = Date.parse(parsed.generated_at || liveRead.generated_at || '');
      ageMs = Number.isFinite(generatedAtMs) ? Math.max(0, nowMs - generatedAtMs) : null;
      stale = ageMs === null ? true : ageMs > staleAfterMs;
      snapshotSource = 'live_health_snapshot';
      refreshOk = true;
    } else {
      refreshReason = liveRead.reason || 'live_health_snapshot_failed';
      refreshError = liveRead.error || null;
    }
  }

  return {
    schema: MIRA_ENVIRONMENT_CURIOSITY_SCHEMA,
    ok: true,
    decision: 'environment_health_read_only',
    health_path: health.healthPath,
    profile_name: profileName,
    snapshot_source: snapshotSource,
    generated_at: parsed.generated_at,
    snapshot_age_ms: ageMs,
    snapshot_stale: stale,
    startup_generated_at: startupSnapshot.generated_at,
    startup_snapshot_age_ms: startupSnapshot.snapshot_age_ms,
    startup_snapshot_stale: startupSnapshot.snapshot_stale,
    snapshot_refresh_attempted: refreshAttempted,
    snapshot_refresh_ok: refreshOk,
    snapshot_refresh_reason: refreshReason,
    snapshot_refresh_error: refreshError,
    overall_label: parsed.overall_label,
    overall_score: parsed.overall_score,
    app_session: parsed.app_session,
    tests: parsed.tests,
    modules: parsed.modules,
    memory_sync_status: parsed.memory_sync_status,
    memory_counts: parsed.memory_counts,
    bridge_connection: parsed.bridge_connection,
    bridge_runtime: parsed.bridge_runtime,
    bridge_warnings: parsed.bridge_warnings,
    local_models_enabled: parsed.local_models_enabled,
    observation_excerpt: oneLine([
      parsed.overall_label ? `health=${parsed.overall_label}${parsed.overall_score !== null ? `/${parsed.overall_score}` : ''}` : null,
      parsed.memory_sync_status ? `memory=${parsed.memory_sync_status}` : null,
      parsed.bridge_connection ? `bridge=${parsed.bridge_connection}` : null,
      snapshotSource === 'live_health_snapshot' ? 'snapshot=live_refresh' : (stale ? 'snapshot=stale' : 'snapshot=fresh'),
      refreshAttempted && !refreshOk ? `refresh=${refreshReason || 'failed'}` : null,
    ].filter(Boolean).join('; '), 220),
    no_mutation_performed: true,
    consequence_controls: {
      internal_only: true,
      read_only: true,
      file_write_performed: false,
      external_send_performed: false,
    },
  };
}

module.exports = {
  MIRA_ENVIRONMENT_CURIOSITY_SCHEMA,
  defaultLiveHealthSnapshotReader,
  normalizeLiveHealthRead,
  parseStartupHealthMarkdown,
  readMiraEnvironmentCuriosity,
};
