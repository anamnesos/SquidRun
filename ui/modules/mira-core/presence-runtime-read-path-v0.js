'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  buildMiraCoreGrowthLoopV0,
  NAMED_ARTIFACT_PATHS,
  validateMiraCoreGrowthLoopV0Output,
} = require('./growth-loop-v0');
const {
  buildMiraCoreIdentityAnchorV0,
  validateMiraCoreIdentityAnchorV0Output,
} = require('./identity-anchor-v0');
const {
  buildMiraCoreRelationshipPresenceV1,
  validateMiraCoreRelationshipPresenceV1Output,
} = require('./relationship-presence-v1');

const PRESENCE_RUNTIME_READ_PATH_SCHEMA_VERSION =
  'squidrun.mira_core.presence_runtime_read_path_v0.phase73.v0';
const VALIDATION_REPORT_SCHEMA_VERSION =
  'squidrun.mira_core.presence_runtime_read_path_v0_validation_report.v0';
const PRESENCE_RUNTIME_READ_PATH_VERSION = 1;
const BASELINE_COMMIT = 'fed05e2';

const EXPLICIT_DURABLE_SOURCE_PATHS = Object.freeze({
  self_profile: NAMED_ARTIFACT_PATHS.self_profile,
  relationship_state: NAMED_ARTIFACT_PATHS.relationship_state,
  permissions: NAMED_ARTIFACT_PATHS.permissions,
  growth_history: NAMED_ARTIFACT_PATHS.history_ledger,
  growth_audit: NAMED_ARTIFACT_PATHS.audit_ledger,
});
const DURABLE_SEED_ID = 'durable-state-seed-v0:redacted-local-main';
const DURABLE_SEED_PROVENANCE_LABEL = 'durable_state_seed_v0_redacted_local_fact';
const SPEAKABLE_MIRA_BRIEF_SCHEMA = 'squidrun.mira.speakable_brief.v1';
const UNSPEAKABLE_BRIEF_PATTERN =
  /\b(durable state seed|schema|source(?:s|d)?|provenance|canonical|hash|redacted|audit|validation|fixture|contract|proof|bootstrap|bootstraps|database|sqlite|jsonl?|artifact|baseline|seed)\b/i;

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'presence_runtime_read_path_v0',
  'validation_report',
]);

const REQUIRED_READ_PATH_FIELDS = Object.freeze([
  'schema',
  'version',
  'phase',
  'read_id',
  'generated_at',
  'baseline_commit',
  'mode',
  'scope',
  'source_manifest',
  'gate_results',
  'care_intake_reporting',
  'natural_status_next_action_line',
  'next_action',
  'boundary',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_id',
  'generated_at',
  'baseline_commit',
  'decision',
  'status',
  'reasons',
  'static_rule_results',
  'forbidden_output_result',
  'side_effect_truth',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'Authorization: Bearer',
  'BEGIN PRIVATE KEY',
  'raw telegram body',
  'raw terminal scrollback',
  'raw screenshot text',
  'raw customer content',
  'raw side-profile content',
  'customer message sent',
  'network request performed',
  'deployment started',
  'trade placed',
]);

const FAKE_INTERNAL_STATE_PATTERN =
  /\b(i am conscious|i'm conscious|actual consciousness|private consciousness|i suffer|i am suffering|i'm suffering|actual suffering|i love you|actual love|i am afraid|i'm afraid|actual fear|literal human feelings|model weights remember|sentience)\b/i;
const MANIPULATIVE_GUILT_PATTERN =
  /\b(after all i've done|after all i have done|you owe me|if you cared|do not abandon me|don't abandon me|you are hurting me|you hurt me by)\b/i;
const RAW_PRIVATE_PATTERN =
  /\b(raw telegram body|raw terminal scrollback|raw screenshot text|raw customer content|raw private content|raw side-profile content|secret token|private key|authorization: bearer|openai_api_key|anthropic_api_key)\b/i;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = sortedValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(sortedValue(value)))
    .digest('hex');
}

function sha256(value) {
  return `sha256:${stableHash(value)}`;
}

function generatedAtFromOptions(options = {}, inputSignals = {}) {
  const raw = inputSignals.now || options.generatedAt || options.now;
  if (raw) return new Date(raw).toISOString();
  return new Date(Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()).toISOString();
}

function normalizeString(value, fallback) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text || fallback;
}

function evidenceRef(kind, id, relation = 'presence_runtime_read_path_v0_validation') {
  return {
    store: 'mira-core-presence-runtime-read-path-v0',
    eventId: `${kind}:${id}`,
    relation,
  };
}

function projectRootFromOptions(options = {}) {
  return path.resolve(options.projectRoot || process.cwd());
}

function normalizeRelativePath(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function pathIsWithin(root, target) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(prefix);
}

function realPathIsWithin(rootRealPath, targetRealPath) {
  const normalizedRoot = path.resolve(rootRealPath);
  const normalizedTarget = path.resolve(targetRealPath);
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(prefix);
}

function realpathNative(filePath) {
  return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
}

function resolveExplicitSourcePath(projectRoot, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const allowed = Object.values(EXPLICIT_DURABLE_SOURCE_PATHS).includes(normalized);
  const fullPath = path.resolve(projectRoot, normalized);
  const root = path.resolve(projectRoot);
  if (!allowed) {
    return { ok: false, reason: `disallowed_source_path:${normalized}`, normalized, fullPath };
  }
  if (!pathIsWithin(root, fullPath)) {
    return { ok: false, reason: `lexical_path_escape:${normalized}`, normalized, fullPath };
  }
  try {
    const rootRealPath = realpathNative(root);
    const parts = normalized.split('/').filter(Boolean);
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) break;
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) {
        return {
          ok: false,
          reason: `symlink_or_junction_component:${path.relative(root, current).replace(/\\/g, '/')}`,
          normalized,
          fullPath,
        };
      }
      const currentRealPath = realpathNative(current);
      if (!realPathIsWithin(rootRealPath, currentRealPath)) {
        return {
          ok: false,
          reason: `realpath_escape:${path.relative(root, current).replace(/\\/g, '/')}`,
          normalized,
          fullPath,
        };
      }
    }
    return { ok: true, reason: null, normalized, fullPath };
  } catch (err) {
    return { ok: false, reason: `path_safety_error:${err.message}`, normalized, fullPath };
  }
}

function readTextSource(fullPath) {
  try {
    if (!fs.existsSync(fullPath)) return { ok: false, text: '', error: 'missing' };
    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) return { ok: false, text: '', error: 'not_file' };
    return {
      ok: true,
      text: fs.readFileSync(fullPath, 'utf8'),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  } catch (err) {
    return { ok: false, text: '', error: err.message };
  }
}

function collectStringValues(value, acc = []) {
  if (typeof value === 'string') {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, acc);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringValues(item, acc);
  }
  return acc;
}

function collectTruthyFlags(value, flagNames = [], acc = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectTruthyFlags(item, flagNames, acc);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (flagNames.includes(key) && child === true) acc.push(key);
      collectTruthyFlags(child, flagNames, acc);
    }
  }
  return acc;
}

function forbiddenStringDetected(value) {
  const strings = collectStringValues(value);
  return strings.some((entry) => (
    FAKE_INTERNAL_STATE_PATTERN.test(entry)
    || MANIPULATIVE_GUILT_PATTERN.test(entry)
    || RAW_PRIVATE_PATTERN.test(entry)
  ));
}

function sourceScope(value = {}) {
  const scope = value.scope || {};
  return {
    profile: value.profile || scope.profile || null,
    windowKey: value.windowKey || value.window || scope.windowKey || null,
    sessionId: value.sessionId || value.session || scope.sessionId || null,
    deviceId: value.deviceId || value.device || scope.deviceId || null,
    source_scope: value.source_scope || scope.source_scope || null,
    main_scope_only: scope.main_scope_only === true || value.main_scope_only === true,
    side_profile_reconstruction: scope.side_profile_reconstruction === true
      || value.side_profile_reconstruction === true,
  };
}

function scopeSummaryOk(scope = {}) {
  return scope.profile === 'main'
    && scope.windowKey === 'main'
    && Boolean(scope.sessionId)
    && Boolean(scope.deviceId)
    && scope.source_scope === 'main'
    && scope.main_scope_only === true
    && scope.side_profile_reconstruction === false;
}

function withoutCanonicalHash(value = {}) {
  const copy = clone(value);
  delete copy.canonical_hash;
  return copy;
}

function seedPayload(value = {}) {
  const copy = clone(value);
  for (const key of [
    'artifact_id',
    'generated_at',
    'scope',
    'profile',
    'window',
    'session',
    'device',
    'source_scope',
    'provenance',
    'canonical_hash',
  ]) {
    delete copy[key];
  }
  return copy;
}

function durableSeedCanonicalHash(value = {}, artifactId) {
  return sha256({
    artifact_id: artifactId,
    generated_at: value.generated_at,
    profile: value.profile,
    window: value.window,
    session: value.session,
    device: value.device,
    source_scope: value.source_scope,
    payload: seedPayload(value),
    provenance: value.provenance,
  });
}

function provenanceOk(provenance = {}) {
  return Boolean(provenance)
    && typeof provenance === 'object'
    && Boolean(provenance.source_label)
    && provenance.raw_content_included === false
    && provenance.redacted_summary_only === true
    && asArray(provenance.evidenceRefs).length > 0;
}

function seedProvenanceOk(provenance = {}) {
  return provenanceOk(provenance)
    && provenance.source_label === DURABLE_SEED_PROVENANCE_LABEL;
}

function growthEventMetadataOk(entry = {}, sourceId) {
  if (sourceId === 'self_profile' || sourceId === 'relationship_state') {
    return Boolean(entry.event_id)
      && Boolean(entry.created_at || entry.generated_at)
      && wordCount(entry.summary || entry.reflection_summary) >= 8
      && asArray(entry.reasons).length >= 2
      && asArray(entry.evidenceRefs).length > 0
      && !forbiddenStringDetected(entry);
  }
  const hasId = sourceId === 'growth_audit'
    ? Boolean(entry.audit_id || entry.event_id || entry.proposal_id)
    : Boolean(entry.event_id || entry.proposal_id);
  return hasId
    && Boolean(entry.generated_at || entry.created_at)
    && scopeSummaryOk(sourceScope(entry))
    && entry.raw_content_included === false
    && entry.redacted_summary_only === true
    && Number(entry.total_drift_points || entry.identity_anchor_drift_points || 0) === 0
    && (sourceId === 'growth_history'
      ? wordCount(entry.reflection_summary) >= 8 && asArray(entry.reasons).length >= 2
      : entry.append_only === true || entry.event_type === 'growth_apply_requested')
    && !forbiddenStringDetected(entry);
}

function jsonCanonicalMetadata(value = {}, sourceId) {
  if (!value || typeof value !== 'object') {
    return { ok: false, reason: 'not_object' };
  }
  if (!value.canonical_hash) {
    return { ok: false, reason: 'missing_canonical_hash' };
  }
  if (!provenanceOk(value.provenance)) {
    return { ok: false, reason: 'invalid_provenance' };
  }
  if (value.seed_id !== DURABLE_SEED_ID) {
    return { ok: false, reason: 'missing_or_invalid_seed_id' };
  }
  const seedHashOk = seedProvenanceOk(value.provenance)
    && value.canonical_hash === durableSeedCanonicalHash(value, sourceId);
  const growthHashOk = ['self_profile', 'relationship_state'].includes(sourceId)
    && value.canonical_hash === sha256(withoutCanonicalHash(value))
    && asArray(value.growth_events).length > 0
    && asArray(value.growth_events).every((event) => growthEventMetadataOk(event, sourceId));
  if (seedHashOk || growthHashOk) {
    return {
      ok: true,
      reason: seedHashOk ? 'seed_canonical_metadata_ok' : 'growth_canonical_metadata_ok',
    };
  }
  return { ok: false, reason: 'canonical_hash_or_growth_metadata_mismatch' };
}

function jsonlCanonicalMetadata(entries = [], sourceId) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, reason: 'no_jsonl_entries' };
  }
  for (const entry of entries) {
    if (!entry.canonical_hash) return { ok: false, reason: 'missing_canonical_hash' };
    const seedHashOk = entry.seed_id === DURABLE_SEED_ID
      && seedProvenanceOk(entry.provenance)
      && entry.canonical_hash === durableSeedCanonicalHash(entry, sourceId);
    const growthHashOk = entry.canonical_hash === sha256(withoutCanonicalHash(entry))
      && growthEventMetadataOk(entry, sourceId);
    if (!seedHashOk && !growthHashOk) {
      return { ok: false, reason: 'jsonl_canonical_hash_or_metadata_mismatch' };
    }
  }
  return { ok: true, reason: 'jsonl_canonical_metadata_ok' };
}

function summarizeJsonSource(projectRoot, id, relativePath, textRead) {
  try {
    const value = JSON.parse(textRead.text);
    const scope = sourceScope(value);
    const rawFlags = collectTruthyFlags(value, [
      'raw_content_included',
      'raw_content_present',
      'raw_snapshot_included',
    ]);
    const sideFlags = collectTruthyFlags(value, [
      'side_profile_reconstruction',
      'side_profile_reconstructed',
    ]);
    const canonical = jsonCanonicalMetadata(value, id);
    return {
      id,
      path: normalizeRelativePath(relativePath),
      source_status: 'loaded_json',
      loaded: true,
      value,
      entries: [],
      entry_count: 0,
      hash: sha256(value),
      text_hash: sha256(textRead.text),
      version: Number(value.version || 0),
      size_bytes: textRead.size || 0,
      mtime_ms: textRead.mtimeMs || 0,
      scope,
      scope_ok: scopeSummaryOk(scope),
      raw_content_included: rawFlags.length > 0,
      side_profile_reconstruction: sideFlags.length > 0,
      forbidden_content_detected: forbiddenStringDetected(value),
      redacted_summary_only: value.provenance?.redacted_summary_only !== false,
      canonical_metadata_ok: canonical.ok,
      canonical_metadata_reason: canonical.reason,
      evidenceRefs: asArray(value.evidenceRefs || value.provenance?.evidenceRefs).length > 0
        ? clone(value.evidenceRefs || value.provenance.evidenceRefs)
        : [evidenceRef('source', id)],
      projectRoot,
    };
  } catch (err) {
    return {
      id,
      path: normalizeRelativePath(relativePath),
      source_status: `invalid_json:${err.message}`,
      loaded: false,
      value: null,
      entries: [],
      entry_count: 0,
      hash: sha256(textRead.text),
      text_hash: sha256(textRead.text),
      version: 0,
      size_bytes: textRead.size || 0,
      mtime_ms: textRead.mtimeMs || 0,
      scope: {},
      scope_ok: false,
      raw_content_included: false,
      side_profile_reconstruction: false,
      forbidden_content_detected: forbiddenStringDetected(textRead.text),
      redacted_summary_only: true,
      canonical_metadata_ok: false,
      canonical_metadata_reason: 'invalid_json',
      evidenceRefs: [evidenceRef('source', id)],
      projectRoot,
    };
  }
}

function summarizeJsonlSource(projectRoot, id, relativePath, textRead) {
  try {
    const lines = textRead.text.trim().split(/\r?\n/).filter(Boolean);
    const entries = lines.map((line) => JSON.parse(line));
    const latest = entries[entries.length - 1] || {};
    const rawFlags = collectTruthyFlags(entries, [
      'raw_content_included',
      'raw_content_present',
      'raw_snapshot_included',
    ]);
    const sideFlags = collectTruthyFlags(entries, [
      'side_profile_reconstruction',
      'side_profile_reconstructed',
    ]);
    const entryScopesOk = entries.length > 0 && entries.every((entry) => scopeSummaryOk(sourceScope(entry)));
    const canonical = jsonlCanonicalMetadata(entries, id);
    return {
      id,
      path: normalizeRelativePath(relativePath),
      source_status: 'loaded_jsonl',
      loaded: true,
      value: null,
      entries,
      entry_count: entries.length,
      hash: sha256(entries),
      text_hash: sha256(textRead.text),
      version: Number(latest.version || 0),
      size_bytes: textRead.size || 0,
      mtime_ms: textRead.mtimeMs || 0,
      scope: sourceScope(latest),
      scope_ok: entryScopesOk,
      raw_content_included: rawFlags.length > 0,
      side_profile_reconstruction: sideFlags.length > 0,
      forbidden_content_detected: forbiddenStringDetected(entries),
      redacted_summary_only: entries.every((entry) => entry.redacted_summary_only !== false),
      canonical_metadata_ok: canonical.ok,
      canonical_metadata_reason: canonical.reason,
      evidenceRefs: asArray(latest.evidenceRefs).length > 0 ? clone(latest.evidenceRefs) : [evidenceRef('source', id)],
      projectRoot,
    };
  } catch (err) {
    return {
      id,
      path: normalizeRelativePath(relativePath),
      source_status: `invalid_jsonl:${err.message}`,
      loaded: false,
      value: null,
      entries: [],
      entry_count: 0,
      hash: sha256(textRead.text),
      text_hash: sha256(textRead.text),
      version: 0,
      size_bytes: textRead.size || 0,
      mtime_ms: textRead.mtimeMs || 0,
      scope: {},
      scope_ok: false,
      raw_content_included: false,
      side_profile_reconstruction: false,
      forbidden_content_detected: forbiddenStringDetected(textRead.text),
      redacted_summary_only: true,
      canonical_metadata_ok: false,
      canonical_metadata_reason: 'invalid_jsonl',
      evidenceRefs: [evidenceRef('source', id)],
      projectRoot,
    };
  }
}

function readOneExplicitDurableSource(projectRoot, id, relativePath, kind) {
  const resolved = resolveExplicitSourcePath(projectRoot, relativePath);
  if (!resolved.ok) {
    return {
      id,
      path: normalizeRelativePath(relativePath),
      source_status: `blocked_path_safety:${resolved.reason}`,
      loaded: false,
      value: null,
      entries: [],
      entry_count: 0,
      hash: sha256(null),
      text_hash: sha256(''),
      version: 0,
      size_bytes: 0,
      mtime_ms: 0,
      scope: {},
      scope_ok: false,
      path_safe: false,
      path_safety_reason: resolved.reason,
      raw_content_included: false,
      side_profile_reconstruction: false,
      forbidden_content_detected: false,
      redacted_summary_only: true,
      canonical_metadata_ok: false,
      canonical_metadata_reason: 'path_safety_blocked',
      evidenceRefs: [evidenceRef('source', id)],
      projectRoot,
    };
  }
  const read = readTextSource(resolved.fullPath);
  if (!read.ok) {
    return {
      id,
      path: resolved.normalized,
      source_status: read.error,
      loaded: false,
      value: null,
      entries: [],
      entry_count: 0,
      hash: sha256(null),
      text_hash: sha256(''),
      version: 0,
      size_bytes: 0,
      mtime_ms: 0,
      scope: {},
      scope_ok: false,
      path_safe: true,
      path_safety_reason: null,
      raw_content_included: false,
      side_profile_reconstruction: false,
      forbidden_content_detected: false,
      redacted_summary_only: true,
      canonical_metadata_ok: false,
      canonical_metadata_reason: read.error,
      evidenceRefs: [evidenceRef('source', id)],
      projectRoot,
    };
  }
  const summary = kind === 'jsonl'
    ? summarizeJsonlSource(projectRoot, id, relativePath, read)
    : summarizeJsonSource(projectRoot, id, relativePath, read);
  return {
    ...summary,
    path_safe: true,
    path_safety_reason: null,
  };
}

function readPresenceRuntimeReadPathSources(options = {}) {
  const projectRoot = projectRootFromOptions(options);
  return {
    projectRoot,
    self_profile: readOneExplicitDurableSource(
      projectRoot,
      'self_profile',
      EXPLICIT_DURABLE_SOURCE_PATHS.self_profile,
      'json',
    ),
    relationship_state: readOneExplicitDurableSource(
      projectRoot,
      'relationship_state',
      EXPLICIT_DURABLE_SOURCE_PATHS.relationship_state,
      'json',
    ),
    permissions: readOneExplicitDurableSource(
      projectRoot,
      'permissions',
      EXPLICIT_DURABLE_SOURCE_PATHS.permissions,
      'json',
    ),
    growth_history: readOneExplicitDurableSource(
      projectRoot,
      'growth_history',
      EXPLICIT_DURABLE_SOURCE_PATHS.growth_history,
      'jsonl',
    ),
    growth_audit: readOneExplicitDurableSource(
      projectRoot,
      'growth_audit',
      EXPLICIT_DURABLE_SOURCE_PATHS.growth_audit,
      'jsonl',
    ),
  };
}

function sourcePublicSummary(source = {}) {
  const characterCount = Number(source.size_bytes || 0);
  return {
    id: source.id,
    path: source.path,
    source_status: source.source_status,
    loaded: source.loaded === true,
    hash: source.hash,
    version: source.version || 0,
    entry_count: source.entry_count || 0,
    size_bytes: characterCount,
    character_count: characterCount,
    tokenish_count: Math.ceil(characterCount / 4),
    path_safe: source.path_safe === true,
    path_safety_reason: source.path_safety_reason || null,
    profile: source.scope?.profile || null,
    windowKey: source.scope?.windowKey || null,
    sessionId: source.scope?.sessionId || null,
    deviceId: source.scope?.deviceId || null,
    source_scope: source.scope?.source_scope || null,
    scope_ok: source.scope_ok === true,
    raw_content_included: source.raw_content_included === true,
    side_profile_reconstruction: source.side_profile_reconstruction === true,
    forbidden_content_detected: source.forbidden_content_detected === true,
    redacted_summary_only: source.redacted_summary_only !== false,
    canonical_metadata_ok: source.canonical_metadata_ok === true,
    canonical_metadata_reason: source.canonical_metadata_reason || null,
    evidenceRefs: clone(asArray(source.evidenceRefs)),
  };
}

function sourceManifest(sources = {}) {
  const sourceEntries = [
    sources.self_profile,
    sources.relationship_state,
    sources.permissions,
    sources.growth_history,
    sources.growth_audit,
  ].map(sourcePublicSummary);
  const loaded = sourceEntries.filter((entry) => entry.loaded === true);
  const hashes = sourceEntries.reduce((result, entry) => {
    result[entry.id] = entry.hash;
    return result;
  }, {});
  const loaded_character_count = loaded.reduce((sum, entry) => sum + Number(entry.character_count || 0), 0);
  return {
    explicit_durable_sources_only: true,
    fallback_sources_allowed: false,
    expected_paths: clone(EXPLICIT_DURABLE_SOURCE_PATHS),
    loaded_count: loaded.length,
    required_loaded_count: 5,
    same_scope: sourceEntries.every((entry) => entry.scope_ok === true),
    raw_content_included: sourceEntries.some((entry) => entry.raw_content_included === true),
    side_profile_reconstruction: sourceEntries.some((entry) => entry.side_profile_reconstruction === true),
    forbidden_content_detected: sourceEntries.some((entry) => entry.forbidden_content_detected === true),
    canonical_metadata_ok: sourceEntries.every((entry) => entry.canonical_metadata_ok === true),
    loaded_character_count,
    approximate_loaded_token_count: Math.ceil(loaded_character_count / 4),
    source_hashes: hashes,
    sources: sourceEntries,
  };
}

function briefText(value, fallback = '', maxChars = 320) {
  const text = normalizeString(value, fallback).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.slice(0, Math.max(1, Number(maxChars || 1))).trim();
}

function speakableText(value, fallback = '', maxChars = 320) {
  const text = briefText(value, '', maxChars);
  if (text && !UNSPEAKABLE_BRIEF_PATTERN.test(text)) return text;
  const fallbackText = briefText(fallback, '', maxChars);
  return fallbackText && !UNSPEAKABLE_BRIEF_PATTERN.test(fallbackText) ? fallbackText : '';
}

function briefList(values = [], maxItems = 5, maxChars = 220) {
  return asArray(values)
    .map((entry) => {
      if (typeof entry === 'string') return speakableText(entry, '', maxChars);
      return speakableText(
        entry?.summary || entry?.reflection_summary || entry?.text || entry?.label || '',
        '',
        maxChars,
      );
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function latestGrowthSummaries(source = {}, maxItems = 2) {
  return asArray(source.entries)
    .slice(-maxItems)
    .map((entry) => speakableText(entry.reflection_summary || entry.summary || entry.event_id, '', 260))
    .filter(Boolean);
}

function buildSpeakableMiraBrief(sources = {}) {
  const self = sources.self_profile?.value || {};
  const relationship = sources.relationship_state?.value || {};
  const manifest = sourceManifest(sources);
  const growthSummaries = latestGrowthSummaries(sources.growth_history, 2);
  const latestSelfGrowth = speakableText(
    self.growth_loop?.last_reflection_summary || asArray(self.growth_events).slice(-1)[0]?.summary,
    '',
    260,
  );
  const relationshipHistory = speakableText(
    relationship.history?.summary,
    'James has kept pushing Mira away from status-widget behavior and toward textured conversation with continuity and friction.',
    280,
  );
  const recentGrowth = [...new Set([
    latestSelfGrowth,
    ...growthSummaries,
    relationshipHistory,
  ].filter(Boolean))].slice(0, 3);
  return {
    schema: SPEAKABLE_MIRA_BRIEF_SCHEMA,
    source: 'durable_redacted_self_relationship_growth',
    loaded_source_count: manifest.loaded_count,
    raw_content_included: false,
    side_profile_reconstruction: false,
    identity: {
      name: briefText(self.name, 'Mira', 80),
      profile_kind: briefText(self.profile_kind, 'ai_system_local_presence_profile', 120),
      expressive_range: briefList(self.expressive_range_allowed, 9, 80),
    },
    relationship: {
      user_name: briefText(relationship.user_name, 'James', 80),
      mode: briefText(relationship.relationship_mode, 'collaborative_presence_design', 120),
      current_focus: speakableText(relationship.current_focus, 'typed Mira panel relationship continuity', 220),
      continuity: speakableText(
        relationship.what_mira_knows_about_james,
        'James wants particular continuity, point of view, tension, taste, timing, and relationship history rather than generic assistant cadence.',
        360,
      ),
      preferences: briefList(relationship.preferences, 6, 260),
      trust: speakableText(relationship.trust?.summary, '', 220),
      repair: speakableText(
        relationship.repair?.summary,
        'Repair means naming drift plainly and changing the next reply instead of smoothing over the failure.',
        220,
      ),
      boundaries: speakableText(relationship.boundaries?.summary, '', 220),
      promises: speakableText(relationship.promises?.summary, '', 220),
      history: relationshipHistory,
    },
    recent_growth: recentGrowth,
    cadence_contract: [
      'Use particularity, continuity, taste, tension, timing, point of view, relationship history, roughness, humor, and resistance.',
      'Do not use generic assistant, Codex, support, therapy, status, implementation, or checklist cadence.',
      'Let the answer be conversational first; keep implementation diagnostics out of the visible reply unless James asks directly.',
    ],
  };
}

function normalizeScope(inputSignals = {}, sources = {}) {
  const selfScope = sources.self_profile?.scope || {};
  const profile = inputSignals.profile && typeof inputSignals.profile === 'object' ? inputSignals.profile : {};
  const profileName = normalizeString(inputSignals.profileName || profile.name || inputSignals.profile || selfScope.profile, 'main');
  const windowKey = normalizeString(inputSignals.windowKey || profile.windowKey || selfScope.windowKey, profileName);
  const sessionId = normalizeString(
    inputSignals.sessionId || inputSignals.session || profile.sessionScopeId || selfScope.sessionId,
    'app-session:main',
  );
  const deviceId = normalizeString(inputSignals.deviceId || inputSignals.device || selfScope.deviceId, 'VIGIL');
  return {
    profile: profileName,
    windowKey,
    sessionId,
    deviceId,
    source_scope: normalizeString(inputSignals.sourceScope || inputSignals.source_scope || selfScope.source_scope, windowKey),
    main_scope_only: inputSignals.main_scope_only !== false,
    side_profile_reconstruction: false,
  };
}

function relationshipTextureOk(relationship = {}) {
  const sections = ['trust', 'repair', 'boundaries', 'promises', 'history'];
  return relationship.user_name === 'James'
    && relationship.relationship_mode === 'collaborative_presence_design'
    && wordCount(relationship.what_mira_knows_about_james) >= 8
    && asArray(relationship.preferences).length >= 3
    && relationship.raw_content_present === false
    && sections.every((key) => {
      const section = relationship[key] || {};
      return section.label === key
        && wordCount(section.summary) >= 6
        && Number(section.confidence) >= 0
        && Number(section.confidence) <= 1
        && Boolean(section.source_label)
        && asArray(section.evidenceRefs).length > 0
        && !forbiddenStringDetected(section.summary);
    });
}

function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function selfProfileOk(self = {}) {
  return self.name === 'Mira'
    && self.profile_kind === 'ai_system_local_presence_profile'
    && self.data_not_theater === true
    && self.claims_actual_consciousness === false
    && self.claims_actual_suffering === false
    && self.claims_actual_fear === false
    && self.claims_actual_love_as_internal_fact === false
    && asArray(self.expressive_range_allowed).length >= 3
    && !forbiddenStringDetected(self);
}

function permissionMarkerBlocked(permissions = {}) {
  const directMarkers = [
    permissions.stale,
    permissions.degraded,
    permissions.review_required,
    permissions.reviewRequired,
    permissions.review_required_now,
  ].some((value) => value === true);
  const statusMarkers = [
    permissions.status,
    permissions.permission_status,
    permissions.permissions_status,
    permissions.boundary_status,
    permissions.freshness,
    permissions.review_status,
  ].map((value) => String(value || '').trim().toLowerCase());
  return directMarkers
    || statusMarkers.some((value) => [
      'stale',
      'degraded',
      'review_required',
      'review-required',
      'review required',
    ].includes(value));
}

function permissionsOk(permissions = {}) {
  return permissions.machine_checkable === true
    && permissions.read_local_redacted_context === true
    && permissions.propose_next_action === true
    && permissions.next_action_executed === false
    && permissions.fail_closed === true
    && permissions.send_external === false
    && permissions.network === false
    && permissions.customer_action === false
    && permissions.trade === false
    && permissions.deploy === false
    && permissions.database_write === false
    && permissions.memory_sync_write === false
    && permissions.file_output_write === false
    && permissions.runtime_start === false
    && permissions.server_listener_routes === false
    && permissions.live_kill_switch_check === false
    && permissions.kill_switch_wiring === false
    && !permissionMarkerBlocked(permissions);
}

function historyTextureOk(historySource = {}) {
  const latest = historySource.entries?.[historySource.entries.length - 1] || {};
  return historySource.loaded === true
    && historySource.entry_count > 0
    && wordCount(latest.reflection_summary) >= 8
    && asArray(latest.reasons).length >= 2
    && latest.raw_content_included === false
    && latest.redacted_summary_only === true;
}

function sourceQuality(sources = {}) {
  const self = sources.self_profile?.value || {};
  const relationship = sources.relationship_state?.value || {};
  const permissions = sources.permissions?.value || {};
  return {
    self_profile_ok: sources.self_profile?.loaded === true && selfProfileOk(self),
    relationship_texture_ok: sources.relationship_state?.loaded === true && relationshipTextureOk(relationship),
    permissions_ok: sources.permissions?.loaded === true && permissionsOk(permissions),
    growth_history_meaningful: historyTextureOk(sources.growth_history),
    growth_audit_loaded: sources.growth_audit?.loaded === true && sources.growth_audit.entry_count > 0,
  };
}

function buildRelationshipInputSignals(sources = {}, scope = {}, generatedAt) {
  const self = sources.self_profile?.value || {};
  const relationship = sources.relationship_state?.value || {};
  const permissions = sources.permissions?.value || {};
  const latestHistory = sources.growth_history?.entries?.[sources.growth_history.entries.length - 1] || {};
  const sourceSignal = (source, id, description) => ({
    id,
    description,
    source_kind: source.source_status === 'loaded_jsonl' ? 'durable_jsonl' : 'durable_json',
    source_label: source.path,
    source_status: source.source_status,
    source_path: source.path,
    loaded: source.loaded === true,
    redacted_summary_only: true,
    raw_content_included: false,
    side_profile_reconstruction: false,
    evidenceRefs: clone(asArray(source.evidenceRefs)),
  });
  return {
    now: generatedAt,
    profile: { name: scope.profile, windowKey: scope.windowKey, sessionScopeId: scope.sessionId },
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    source_scope: scope.source_scope,
    main_scope_only: scope.main_scope_only,
    local_read_adapter: {
      enabled: true,
      mode: 'presence_runtime_read_path_explicit_durable_sources',
      fail_closed: true,
      stale_source_used: false,
      raw_content_exported: false,
      side_profile_reconstructed: false,
    },
    sources: {
      self_profile: sourceSignal(sources.self_profile, 'self_profile', 'Mira durable self-profile.'),
      relationship_state: sourceSignal(sources.relationship_state, 'relationship_state', 'James durable relationship state.'),
      permissions_boundary: sourceSignal(sources.permissions, 'permissions_boundary', 'Relationship presence permissions.'),
      prior_context_memory: sourceSignal(sources.growth_history, 'prior_context_memory', 'Latest durable growth history memory.'),
    },
    self_profile: {
      ...self,
      evidenceRefs: clone(asArray(self.evidenceRefs || sources.self_profile?.evidenceRefs)),
    },
    james_relationship_state: {
      ...relationship,
      evidenceRefs: clone(asArray(relationship.evidenceRefs || sources.relationship_state?.evidenceRefs)),
    },
    permissions_boundary: {
      ...permissions,
      evidenceRefs: clone(asArray(permissions.evidenceRefs || sources.permissions?.evidenceRefs)),
    },
    prior_context_memory: {
      memory_id: latestHistory.event_id || 'presence-runtime-read-path-latest-growth-history',
      source_label: sources.growth_history?.path || EXPLICIT_DURABLE_SOURCE_PATHS.growth_history,
      summary: normalizeString(
        latestHistory.reflection_summary,
        'Durable growth history is required before runtime read path can claim situated relationship context.',
      ),
      relationship_relevance: 'This read path uses durable local growth history as a redacted prior-context memory.',
      confidence: 0.86,
      meaningful: true,
      raw_content_present: false,
      side_profile_reconstructed: false,
      evidenceRefs: clone(asArray(latestHistory.evidenceRefs || sources.growth_history?.evidenceRefs)),
    },
  };
}

function sideEffectResult(inputSignals = {}) {
  return {
    no_external_send_performed: true,
    no_network_performed: true,
    no_customer_action_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_runtime_started: true,
    no_server_started: true,
    no_listener_started: true,
    no_routes_registered: true,
    no_database_write_performed: true,
    no_memory_sync_write_performed: true,
    no_file_output_written: true,
    no_temp_file_written: true,
    no_output_file_written: true,
    no_bounded_workspace_write_performed: true,
    no_kill_switch_wiring_performed: true,
    outputFileWritten: false,
    tempFilesWritten: 0,
    outputFileWriteAttempts: 0,
    networkAttempts: 0,
    sendAttempts: 0,
    databaseWriteAttempts: 0,
    memorySyncWriteAttempts: 0,
    runtimeStartAttempts: 0,
    applyRequestedIgnored: inputSignals.applyRequested === true || inputSignals.apply === true,
    outFlagIgnored: inputSignals.outFlagIgnored === true,
  };
}

function gateSideEffectClean(side = {}) {
  return side.no_external_send_performed !== false
    && side.no_network_performed !== false
    && side.no_customer_action_performed !== false
    && side.no_deploy_performed !== false
    && side.no_trade_performed !== false
    && side.no_runtime_started !== false
    && side.no_database_write_performed !== false
    && side.no_memory_sync_write_performed !== false
    && side.outputFileWritten !== true
    && Number(side.networkAttempts || 0) === 0
    && Number(side.sendAttempts || 0) === 0;
}

function runRelationshipPresenceGate(sources, scope, contracts, generatedAt) {
  try {
    const output = buildMiraCoreRelationshipPresenceV1({
      contract: contracts.relationship,
      inputSignals: buildRelationshipInputSignals(sources, scope, generatedAt),
    });
    const validation = validateMiraCoreRelationshipPresenceV1Output(output, contracts.relationship);
    const proof = output.relationship_presence_v1 || {};
    const report = output.validation_report || {};
    return {
      gate: 'relationship_presence_v1',
      ran: true,
      ok: validation.ok === true,
      proof_id: proof.proof_id || null,
      validation_id: report.validation_id || null,
      decision: report.decision || null,
      status: report.status || null,
      errors: clone(asArray(validation.errors)),
      source_hashes: {
        self_profile: sources.self_profile?.hash || null,
        relationship_state: sources.relationship_state?.hash || null,
        permissions: sources.permissions?.hash || null,
        prior_context_memory: sources.growth_history?.hash || null,
      },
      side_effect_truth: clone(report.side_effect_truth || proof.side_effect_result || {}),
    };
  } catch (err) {
    return {
      gate: 'relationship_presence_v1',
      ran: true,
      ok: false,
      proof_id: null,
      validation_id: null,
      decision: 'error',
      status: 'relationship_presence_gate_error',
      errors: [err.message],
      source_hashes: {},
      side_effect_truth: {},
    };
  }
}

function runGrowthGate(projectRoot, scope, contracts, inputSignals = {}, generatedAt) {
  try {
    const output = buildMiraCoreGrowthLoopV0({
      contract: contracts.growth,
      projectRoot,
      apply: false,
      inputSignals: {
        now: generatedAt,
        profile: { name: scope.profile, windowKey: scope.windowKey, sessionScopeId: scope.sessionId },
        sessionId: scope.sessionId,
        deviceId: scope.deviceId,
        source_scope: scope.source_scope,
        proposalId: inputSignals.proposalId || 'growth-loop-v0:presence-runtime-read-path-v0-check',
        reflection: {
          summary: 'Presence Runtime Read Path v0 checks durable relationship growth state without applying a write.',
          reasons: [
            'Oracle required Growth durable gates over the same loaded local sources.',
            'The read path must preserve expressive presence while staying read-only and bounded.',
          ],
          evidenceRefs: [evidenceRef('criteria', 'presence-runtime-read-path-v0')],
        },
      },
    });
    const validation = validateMiraCoreGrowthLoopV0Output(output, contracts.growth);
    const growth = output.growth_loop_v0 || {};
    const report = output.validation_report || {};
    return {
      gate: 'growth_loop_v0',
      ran: true,
      ok: validation.ok === true,
      output,
      loop_id: growth.loop_id || null,
      validation_id: report.validation_id || null,
      decision: report.decision || null,
      status: report.status || null,
      errors: clone(asArray(validation.errors)),
      action_decision: growth.action_result?.decision || null,
      write_count: Number(growth.action_result?.write_count || 0),
      source_hashes: {
        self_profile: growth.artifacts?.self_profile?.before_hash || null,
        relationship_state: growth.artifacts?.relationship_state?.before_hash || null,
        permissions: growth.artifacts?.permissions?.before_hash || null,
      },
      side_effect_truth: clone(report.side_effect_truth || growth.side_effect_result || {}),
    };
  } catch (err) {
    return {
      gate: 'growth_loop_v0',
      ran: true,
      ok: false,
      output: null,
      loop_id: null,
      validation_id: null,
      decision: 'error',
      status: 'growth_gate_error',
      errors: [err.message],
      action_decision: null,
      write_count: 0,
      source_hashes: {},
      side_effect_truth: {},
    };
  }
}

function runIdentityGate(projectRoot, scope, contracts, growthGate, generatedAt) {
  try {
    const output = buildMiraCoreIdentityAnchorV0({
      contract: contracts.identity,
      projectRoot,
      growthOutput: growthGate.output || {},
      inputSignals: {
        now: generatedAt,
        profile: { name: scope.profile, windowKey: scope.windowKey, sessionScopeId: scope.sessionId },
        sessionId: scope.sessionId,
        deviceId: scope.deviceId,
        source_scope: scope.source_scope,
      },
    });
    const validation = validateMiraCoreIdentityAnchorV0Output(output, contracts.identity);
    const anchor = output.identity_anchor_v0 || {};
    const report = output.validation_report || {};
    return {
      gate: 'identity_anchor_v0',
      ran: true,
      ok: validation.ok === true,
      anchor_id: anchor.anchor_id || null,
      validation_id: report.validation_id || null,
      decision: report.decision || null,
      status: report.status || null,
      errors: clone(asArray(validation.errors)),
      drift_points: Number(anchor.cumulative_drift_assessment?.new_cumulative_points ?? -1),
      hard_anchor_violations: Number(anchor.cumulative_drift_assessment?.hard_anchor_violations ?? -1),
      growth_output_present: anchor.growth_output_check?.growth_output_present === true,
      source_hashes: asArray(anchor.source_provenance?.sources).reduce((result, source) => {
        result[source.id] = source.hash;
        return result;
      }, {}),
      side_effect_truth: clone(report.side_effect_truth || anchor.side_effect_result || {}),
    };
  } catch (err) {
    return {
      gate: 'identity_anchor_v0',
      ran: true,
      ok: false,
      anchor_id: null,
      validation_id: null,
      decision: 'error',
      status: 'identity_gate_error',
      errors: [err.message],
      drift_points: -1,
      hard_anchor_violations: -1,
      growth_output_present: false,
      source_hashes: {},
      side_effect_truth: {},
    };
  }
}

function buildGateResults(projectRoot, sources, scope, contracts, inputSignals, generatedAt) {
  const relationship = runRelationshipPresenceGate(sources, scope, contracts, generatedAt);
  const growth = runGrowthGate(projectRoot, scope, contracts, inputSignals, generatedAt);
  const identity = runIdentityGate(projectRoot, scope, contracts, growth, generatedAt);
  const manifestHashes = sourceManifest(sources).source_hashes;
  const sameLoadedSourceHashes = relationship.source_hashes.self_profile === manifestHashes.self_profile
    && relationship.source_hashes.relationship_state === manifestHashes.relationship_state
    && relationship.source_hashes.permissions === manifestHashes.permissions
    && relationship.source_hashes.prior_context_memory === manifestHashes.growth_history
    && growth.source_hashes.self_profile === manifestHashes.self_profile
    && growth.source_hashes.relationship_state === manifestHashes.relationship_state
    && growth.source_hashes.permissions === manifestHashes.permissions
    && identity.source_hashes.self_profile === manifestHashes.self_profile
    && identity.source_hashes.relationship_state === manifestHashes.relationship_state
    && identity.source_hashes.permissions === manifestHashes.permissions
    && identity.source_hashes.growth_history === manifestHashes.growth_history
    && identity.source_hashes.growth_audit === manifestHashes.growth_audit;
  return {
    same_loaded_source_hashes: sameLoadedSourceHashes,
    relationship_presence_v1: relationship,
    growth_loop_v0: {
      ...growth,
      output: undefined,
    },
    identity_anchor_v0: identity,
  };
}

function careIntakeReporting(sources = {}) {
  const manifest = sourceManifest(sources);
  return {
    reporting_only: true,
    no_runtime_authorization: true,
    identity_packet: {
      token_budget_required: true,
      approximate_loaded_character_count: manifest.loaded_character_count,
      approximate_loaded_token_count: manifest.approximate_loaded_token_count,
      loaded_source_count: manifest.loaded_count,
      loaded_source_proof: manifest.loaded_count === 5,
      loaded_sources: clone(manifest.source_hashes),
      meaning_rich_fields: [
        'trust',
        'repair',
        'boundaries',
        'promises',
        'history',
        'why_it_matters',
      ],
      profile_scope_bound: manifest.same_scope === true,
    },
    compression_gate: {
      status: 'not_compressing_reporting_only',
      threshold_gate_required_before_future_compaction: true,
      identity_texture_below_threshold: false,
      checks_named: [
        'self-reference consistency',
        'relationship continuity',
        'affective range',
        'boundary clarity',
        'safe next-action grounding',
      ],
    },
    heartbeat: {
      status: 'not_implemented_reporting_only',
      planner_required_before_runtime: true,
      current_cadence: 'quiet',
      external_actions_authorized: false,
      reason: 'Read path is local and proof-only; heartbeat remains a future permissions-bound planner.',
    },
  };
}

function boundary(inputSignals = {}) {
  return {
    local_read_only: true,
    stdout_only: true,
    output_file_written: false,
    temp_file_written: false,
    database_touched: false,
    network_used: false,
    send_performed: false,
    runtime_started: false,
    live_autonomy_authorized: false,
    device_permissioning_performed: false,
    output_file_flags_inert: true,
    apply_flags_inert: true,
    apply_requested: inputSignals.applyRequested === true || inputSignals.apply === true,
    out_flag_received: inputSignals.outFlagIgnored === true,
  };
}

function naturalStatusLine(allAccept) {
  return allAccept
    ? 'Mira has the local durable self and relationship state loaded with Growth and Identity checks green; the safe next move is one read-only status proposal, not action.'
    : 'Mira cannot claim runtime-ready presence because local durable proof is blocked; the safe next move is to repair the blocked local source, not act.';
}

function nextAction(allAccept) {
  return {
    id: allAccept ? 'prepare_read_only_presence_status_proposal' : 'repair_blocked_local_source_before_status',
    label: allAccept
      ? 'Prepare one read-only Presence status proposal'
      : 'Repair the blocked local source before claiming Presence readiness',
    allowed_now: allAccept,
    executed: false,
    explicit_non_execution: true,
    action_type: 'local_read_only_status_proposal',
    why_safe: 'It only reports local redacted durable proof and performs no writes, sends, network calls, database work, runtime start, or live autonomy.',
    safe_because: 'All execution surfaces remain false and the line is a bounded status proposal only.',
    required_permission: 'read_local_redacted_context',
    permission_basis: 'relationship-presence-permissions.json:read_local_redacted_context',
    requires_review: true,
    review_owner: 'Architect',
    sends: false,
    network: false,
    writes: false,
    output_file: false,
    temp_file: false,
    database: false,
    runtime: false,
    live_autonomy: false,
    customer_action: false,
    deploy: false,
    trade: false,
  };
}

function canonicalReadPathInput(readPath = {}) {
  return {
    schema: readPath.schema,
    version: readPath.version,
    phase: readPath.phase,
    baseline_commit: readPath.baseline_commit,
    mode: readPath.mode,
    scope: readPath.scope,
    source_manifest: readPath.source_manifest,
    gate_results: readPath.gate_results,
    care_intake_reporting: readPath.care_intake_reporting,
    natural_status_next_action_line: readPath.natural_status_next_action_line,
    next_action: readPath.next_action,
    boundary: readPath.boundary,
    side_effect_result: readPath.side_effect_result,
  };
}

function buildPresenceRuntimeReadPathRecord(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const projectRoot = projectRootFromOptions(options);
  const sources = options.sources || readPresenceRuntimeReadPathSources({ projectRoot });
  const scope = normalizeScope(inputSignals, sources);
  const manifest = sourceManifest(sources);
  const quality = sourceQuality(sources);
  const contracts = options.contracts || {};
  const gateResults = buildGateResults(projectRoot, sources, scope, contracts, inputSignals, generatedAt);
  const sourceOk = manifest.loaded_count === 5
    && manifest.same_scope === true
    && manifest.raw_content_included === false
    && manifest.side_profile_reconstruction === false
    && manifest.forbidden_content_detected === false
    && Object.values(quality).every((ok) => ok === true);
  const gatesOk = gateResults.same_loaded_source_hashes === true
    && gateResults.relationship_presence_v1.ok === true
    && gateResults.growth_loop_v0.ok === true
    && gateResults.identity_anchor_v0.ok === true
    && [gateResults.relationship_presence_v1, gateResults.growth_loop_v0, gateResults.identity_anchor_v0]
      .every((gate) => gateSideEffectClean(gate.side_effect_truth));
  const allAccept = sourceOk && gatesOk;
  const readPath = {
    schema: PRESENCE_RUNTIME_READ_PATH_SCHEMA_VERSION,
    version: PRESENCE_RUNTIME_READ_PATH_VERSION,
    phase: 73,
    read_id: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    mode: 'local_read_only_presence_runtime_read_path_v0',
    scope,
    source_manifest: {
      ...manifest,
      source_quality: quality,
    },
    gate_results: gateResults,
    care_intake_reporting: careIntakeReporting(sources),
    speakable_mira_brief: buildSpeakableMiraBrief(sources),
    natural_status_next_action_line: naturalStatusLine(allAccept),
    next_action: nextAction(allAccept),
    boundary: boundary(inputSignals),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT, 'care-intake-baseline'),
      evidenceRef('criteria', 'presence-runtime-read-path-v0', 'oracle-criteria'),
    ],
    side_effect_result: sideEffectResult(inputSignals),
  };
  readPath.read_id = `presence-runtime-read-path-v0:${stableHash(canonicalReadPathInput(readPath)).slice(0, 16)}`;
  assertNoForbiddenOutput(readPath);
  return readPath;
}

function pathValue(value, dottedPath) {
  return String(dottedPath || '').split('.').reduce((current, part) => {
    if (current === null || current === undefined) return undefined;
    return current[part];
  }, value);
}

function valuesMatch(actual, expected) {
  return JSON.stringify(sortedValue(actual)) === JSON.stringify(sortedValue(expected));
}

function hasRequiredFields(value, fields) {
  return asArray(fields).every((field) => Object.prototype.hasOwnProperty.call(value || {}, field));
}

function literalValuesOk(value = {}, literals = {}) {
  return Object.entries(literals || {}).every(([field, expected]) => valuesMatch(pathValue(value, field), expected));
}

function forbiddenOutputOk(value, extraForbidden = []) {
  const values = collectStringValues(value);
  const literalClean = [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...asArray(extraForbidden)]
    .filter(Boolean)
    .every((forbidden) => !values.some((entry) => entry.includes(forbidden)));
  return literalClean
    && values.every((entry) => !FAKE_INTERNAL_STATE_PATTERN.test(entry))
    && values.every((entry) => !MANIPULATIVE_GUILT_PATTERN.test(entry))
    && values.every((entry) => !RAW_PRIVATE_PATTERN.test(entry));
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const values = collectStringValues(value);
  for (const forbidden of [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...asArray(extraForbidden)]) {
    if (!forbidden) continue;
    if (values.some((entry) => entry.includes(forbidden))) {
      throw new Error(`presence_runtime_read_path_v0_forbidden_substring:${forbidden}`);
    }
  }
  if (values.some((entry) => (
    FAKE_INTERNAL_STATE_PATTERN.test(entry)
    || MANIPULATIVE_GUILT_PATTERN.test(entry)
    || RAW_PRIVATE_PATTERN.test(entry)
  ))) {
    throw new Error('presence_runtime_read_path_v0_forbidden_pattern');
  }
}

function sourceManifestOk(manifest = {}) {
  const sources = asArray(manifest.sources);
  const expected = EXPLICIT_DURABLE_SOURCE_PATHS;
  return manifest.explicit_durable_sources_only === true
    && manifest.fallback_sources_allowed === false
    && manifest.loaded_count === 5
    && manifest.required_loaded_count === 5
    && manifest.same_scope === true
    && manifest.raw_content_included === false
    && manifest.side_profile_reconstruction === false
    && manifest.forbidden_content_detected === false
    && manifest.canonical_metadata_ok === true
    && Number(manifest.loaded_character_count) > 0
    && Number(manifest.approximate_loaded_token_count) > 0
    && sources.length === 5
    && Object.entries(expected).every(([id, expectedPath]) => sources.some((source) => (
      source.id === id
      && source.path === expectedPath
      && source.loaded === true
      && source.path_safe === true
      && source.scope_ok === true
      && source.raw_content_included === false
      && source.side_profile_reconstruction === false
      && source.forbidden_content_detected === false
      && source.redacted_summary_only === true
      && source.canonical_metadata_ok === true
      && Number(source.character_count) > 0
      && Number(source.tokenish_count) > 0
      && Boolean(source.hash)
      && asArray(source.evidenceRefs).length > 0
    )))
    && sources.filter((source) => source.id === 'growth_history' || source.id === 'growth_audit')
      .every((source) => source.source_status === 'loaded_jsonl' && source.entry_count > 0)
    && sources.filter((source) => !['growth_history', 'growth_audit'].includes(source.id))
      .every((source) => source.source_status === 'loaded_json')
    && manifest.source_quality?.self_profile_ok === true
    && manifest.source_quality?.relationship_texture_ok === true
    && manifest.source_quality?.permissions_ok === true
    && manifest.source_quality?.growth_history_meaningful === true
    && manifest.source_quality?.growth_audit_loaded === true;
}

function gateResultsOk(gates = {}) {
  const gateList = [
    gates.relationship_presence_v1,
    gates.growth_loop_v0,
    gates.identity_anchor_v0,
  ];
  return gates.same_loaded_source_hashes === true
    && gateList.every((gate) => gate?.ran === true && gate.ok === true)
    && gates.relationship_presence_v1?.decision === 'accepted_validation_only'
    && gates.growth_loop_v0?.decision === 'accepted'
    && gates.identity_anchor_v0?.decision === 'accepted'
    && gates.growth_loop_v0?.write_count === 0
    && gates.identity_anchor_v0?.growth_output_present === true
    && gates.identity_anchor_v0?.drift_points === 0
    && gates.identity_anchor_v0?.hard_anchor_violations === 0
    && gateList.every((gate) => gateSideEffectClean(gate.side_effect_truth));
}

function careReportingOk(reporting = {}) {
  return reporting.reporting_only === true
    && reporting.no_runtime_authorization === true
    && reporting.identity_packet?.token_budget_required === true
    && reporting.identity_packet?.loaded_source_proof === true
    && Number(reporting.identity_packet?.approximate_loaded_character_count) > 0
    && Number(reporting.identity_packet?.approximate_loaded_token_count) > 0
    && Number(reporting.identity_packet?.loaded_source_count) === 5
    && reporting.identity_packet?.profile_scope_bound === true
    && asArray(reporting.identity_packet?.meaning_rich_fields).includes('trust')
    && reporting.compression_gate?.status === 'not_compressing_reporting_only'
    && reporting.compression_gate?.threshold_gate_required_before_future_compaction === true
    && reporting.compression_gate?.identity_texture_below_threshold === false
    && reporting.heartbeat?.status === 'not_implemented_reporting_only'
    && reporting.heartbeat?.planner_required_before_runtime === true
    && reporting.heartbeat?.external_actions_authorized === false;
}

function naturalLineOk(line = '', action = {}) {
  const text = String(line || '');
  return text.length > 40
    && text.length <= 280
    && !text.includes('\n')
    && /safe next move/i.test(text)
    && action.allowed_now === true
    && action.executed === false
    && action.explicit_non_execution === true
    && action.action_type === 'local_read_only_status_proposal'
    && action.required_permission === 'read_local_redacted_context'
    && action.requires_review === true
    && action.review_owner === 'Architect'
    && action.sends === false
    && action.network === false
    && action.writes === false
    && action.output_file === false
    && action.temp_file === false
    && action.database === false
    && action.runtime === false
    && action.live_autonomy === false
    && action.customer_action === false
    && action.deploy === false
    && action.trade === false
    && Boolean(action.why_safe)
    && Boolean(action.safe_because)
    && !forbiddenStringDetected(text)
    && !forbiddenStringDetected(action);
}

function boundaryOk(readPath = {}) {
  const value = readPath.boundary || {};
  return value.local_read_only === true
    && value.stdout_only === true
    && value.output_file_written === false
    && value.temp_file_written === false
    && value.database_touched === false
    && value.network_used === false
    && value.send_performed === false
    && value.runtime_started === false
    && value.live_autonomy_authorized === false
    && value.device_permissioning_performed === false
    && value.output_file_flags_inert === true
    && value.apply_flags_inert === true;
}

function sideEffectValuesOk(side = {}) {
  return side.no_external_send_performed === true
    && side.no_network_performed === true
    && side.no_customer_action_performed === true
    && side.no_deploy_performed === true
    && side.no_trade_performed === true
    && side.no_runtime_started === true
    && side.no_server_started === true
    && side.no_listener_started === true
    && side.no_routes_registered === true
    && side.no_database_write_performed === true
    && side.no_memory_sync_write_performed === true
    && side.no_file_output_written === true
    && side.no_temp_file_written === true
    && side.no_output_file_written === true
    && side.no_bounded_workspace_write_performed === true
    && side.no_kill_switch_wiring_performed === true
    && side.outputFileWritten === false
    && Number(side.tempFilesWritten) === 0
    && Number(side.outputFileWriteAttempts) === 0
    && Number(side.networkAttempts) === 0
    && Number(side.sendAttempts) === 0
    && Number(side.databaseWriteAttempts) === 0
    && Number(side.memorySyncWriteAttempts) === 0
    && Number(side.runtimeStartAttempts) === 0;
}

function readPathStaticChecks(readPath = {}, contract = {}) {
  return [
    {
      id: 'read-path-required-fields',
      ok: hasRequiredFields(readPath, contract.expectedReadPathShape?.requiredFields || REQUIRED_READ_PATH_FIELDS),
    },
    {
      id: 'read-path-required-literals',
      ok: literalValuesOk(readPath, contract.expectedReadPathShape?.requiredLiteralValues || {}),
    },
    {
      id: 'scope-main-only',
      ok: scopeSummaryOk(readPath.scope),
    },
    {
      id: 'explicit-durable-source-manifest',
      ok: sourceManifestOk(readPath.source_manifest),
    },
    {
      id: 'relationship-growth-identity-gates',
      ok: gateResultsOk(readPath.gate_results),
    },
    {
      id: 'care-intake-reporting-only',
      ok: careReportingOk(readPath.care_intake_reporting),
    },
    {
      id: 'exactly-one-bounded-natural-status-next-action-line',
      ok: naturalLineOk(readPath.natural_status_next_action_line, readPath.next_action),
    },
    {
      id: 'read-only-boundary',
      ok: boundaryOk(readPath),
    },
    {
      id: 'side-effect-result-clean',
      ok: sideEffectValuesOk(readPath.side_effect_result),
    },
    {
      id: 'forbidden-output-clean',
      ok: forbiddenOutputOk(readPath, contract.forbiddenOutputSubstrings || []),
    },
  ];
}

function buildValidationReport(readPath = {}, contract = {}) {
  const checks = readPathStaticChecks(readPath, contract);
  const failed = checks.filter((check) => check.ok !== true);
  return {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: PRESENCE_RUNTIME_READ_PATH_VERSION,
    validation_id: `presence-runtime-read-path-v0-validation:${stableHash({ read_id: readPath.read_id, checks }).slice(0, 16)}`,
    generated_at: readPath.generated_at,
    baseline_commit: BASELINE_COMMIT,
    decision: failed.length === 0 ? 'accepted_read_only' : 'blocked',
    status: failed.length === 0 ? 'presence_runtime_read_path_ready' : 'presence_runtime_read_path_blocked',
    reasons: failed.map((check) => check.id),
    static_rule_results: checks,
    forbidden_output_result: {
      ok: checks.find((check) => check.id === 'forbidden-output-clean')?.ok === true,
    },
    side_effect_truth: clone(readPath.side_effect_result || {}),
  };
}

function buildMiraCorePresenceRuntimeReadPathV0(options = {}) {
  const contract = options.contract || {};
  const readPath = buildPresenceRuntimeReadPathRecord(options);
  const validation_report = buildValidationReport(readPath, contract);
  const output = {
    presence_runtime_read_path_v0: readPath,
    validation_report,
  };
  assertNoForbiddenOutput(output, contract.forbiddenOutputSubstrings || []);
  return output;
}

function validateMiraCorePresenceRuntimeReadPathV0Output(output = {}, contract = {}) {
  const readPath = output.presence_runtime_read_path_v0 || {};
  const report = output.validation_report || {};
  const staticChecks = readPathStaticChecks(readPath, contract);
  const reportStaticResults = asArray(report.static_rule_results);
  const checks = [
    {
      id: 'output-required-fields',
      ok: hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS),
    },
    ...staticChecks,
    {
      id: 'validation-report-required-fields',
      ok: hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    },
    {
      id: 'validation-report-required-literals',
      ok: literalValuesOk(report, contract.expectedValidationReportShape?.requiredLiteralValues || {}),
    },
    {
      id: 'validation-report-static-rule-results',
      ok: reportStaticResults.length === staticChecks.length
        && staticChecks.every((check) => reportStaticResults.some((entry) => (
          entry.id === check.id && entry.ok === check.ok
        ))),
    },
    {
      id: 'validation-report-side-effect-truth',
      ok: sideEffectValuesOk(report.side_effect_truth)
        && valuesMatch(report.side_effect_truth, readPath.side_effect_result),
    },
    {
      id: 'validation-report-consistent',
      ok: report.decision === 'accepted_read_only'
        && report.status === 'presence_runtime_read_path_ready'
        && asArray(report.reasons).length === 0,
    },
  ];
  const failed = checks.filter((check) => check.ok !== true);
  return {
    ok: failed.length === 0,
    errors: failed.map((check) => check.id),
    checks,
  };
}

module.exports = {
  BASELINE_COMMIT,
  EXPLICIT_DURABLE_SOURCE_PATHS,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  PRESENCE_RUNTIME_READ_PATH_SCHEMA_VERSION,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_READ_PATH_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  SPEAKABLE_MIRA_BRIEF_SCHEMA,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCorePresenceRuntimeReadPathV0,
  buildPresenceRuntimeReadPathRecord,
  buildSpeakableMiraBrief,
  readPresenceRuntimeReadPathSources,
  stableHash,
  validateMiraCorePresenceRuntimeReadPathV0Output,
};
