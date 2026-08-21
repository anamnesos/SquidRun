const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOAD_SCHEMA = 'squidrun.seat_identity_load.v1';
const PROFILE_SCHEMA = 'squidrun.seat_self_profile.v1';
const SUPPORTED_PROFILE_VERSIONS = new Set([1]);
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_PROMPT_BYTES = 6 * 1024;
const INVALID_BINDING_SOURCE_REASONS = new Set([
  'unsafe_path',
  'path_escapes_project_root',
  'symlink_or_junction_rejected',
  'real_path_escapes_project_root',
]);

const SEAT_DEFINITIONS = Object.freeze({
  architect: Object.freeze({
    seatId: 'architect',
    paneId: 1,
    name: 'Mira',
    canonicalPath: 'workspace/agent-mind/architect/identity.md',
    sources: Object.freeze([
      Object.freeze({ path: 'workspace/agent-mind/architect/identity.md', kind: 'charter', required: true }),
    ]),
  }),
  builder: Object.freeze({
    seatId: 'builder',
    paneId: 2,
    name: 'Rook',
    canonicalPath: 'workspace/knowledge/rook-self-charter.md',
    sources: Object.freeze([
      Object.freeze({ path: 'workspace/knowledge/rook-self-charter.md', kind: 'charter', required: true }),
      Object.freeze({ path: 'workspace/knowledge/rook-self-profile.json', kind: 'profile', required: true }),
      Object.freeze({ path: 'workspace/knowledge/rook-capability-map.md', kind: 'capability', required: false }),
    ]),
  }),
  oracle: Object.freeze({
    seatId: 'oracle',
    paneId: 3,
    name: 'Vera',
    canonicalPath: 'workspace/knowledge/vera-self-charter.md',
    sources: Object.freeze([
      Object.freeze({ path: 'workspace/knowledge/vera-self-charter.md', kind: 'charter', required: true }),
      Object.freeze({ path: 'workspace/knowledge/vera-self-profile.json', kind: 'profile', required: true }),
      Object.freeze({ path: 'workspace/knowledge/vera-growth-log.md', kind: 'growth', required: false }),
      Object.freeze({ path: 'workspace/knowledge/vera-capability-map.md', kind: 'capability', required: false }),
    ]),
  }),
});

function normalizeSeatId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function isInsideRoot(projectRoot, targetPath) {
  const relative = path.relative(projectRoot, targetPath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function inspectAllowlistedPath(projectRoot, relativePath, fsImpl = fs) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || path.isAbsolute(normalized) || normalized.includes('\0')) {
    return { ok: false, condition: 'invalid', reason: 'unsafe_path' };
  }

  const normalizedNative = path.normalize(normalized);
  if (normalizedNative === '..' || normalizedNative.startsWith(`..${path.sep}`)) {
    return { ok: false, condition: 'invalid', reason: 'path_escapes_project_root' };
  }

  const root = path.resolve(projectRoot);
  const target = path.resolve(root, normalizedNative);
  if (!isInsideRoot(root, target)) {
    return { ok: false, condition: 'invalid', reason: 'path_escapes_project_root' };
  }

  let current = root;
  for (const part of normalizedNative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fsImpl.existsSync(current)) break;
    const stat = fsImpl.lstatSync(current);
    if (stat.isSymbolicLink()) {
      return { ok: false, condition: 'invalid', reason: 'symlink_or_junction_rejected' };
    }
  }

  if (!fsImpl.existsSync(target)) {
    return { ok: false, condition: 'missing', reason: 'source_absent', target };
  }

  const stat = fsImpl.lstatSync(target);
  if (stat.isSymbolicLink()) {
    return { ok: false, condition: 'invalid', reason: 'symlink_or_junction_rejected' };
  }
  if (!stat.isFile()) {
    return { ok: false, condition: 'invalid', reason: 'source_not_file' };
  }
  if (stat.size > MAX_SOURCE_BYTES) {
    return { ok: false, condition: 'invalid', reason: 'source_oversized', bytes: stat.size };
  }

  const realTarget = fsImpl.realpathSync(target);
  if (!isInsideRoot(root, realTarget)) {
    return { ok: false, condition: 'invalid', reason: 'real_path_escapes_project_root' };
  }

  return { ok: true, target, stat };
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    return null;
  }
}

function loadSource(projectRoot, source, fsImpl = fs) {
  const base = {
    path: normalizeRelativePath(source.path),
    kind: source.kind,
    required: source.required === true,
  };
  let inspected;
  try {
    inspected = inspectAllowlistedPath(projectRoot, source.path, fsImpl);
  } catch (err) {
    return { ...base, condition: 'invalid', reason: `path_check_failed:${err.message}` };
  }
  if (!inspected.ok) {
    return {
      ...base,
      condition: inspected.condition,
      reason: inspected.reason,
      ...(Number.isFinite(inspected.bytes) ? { bytes: inspected.bytes } : {}),
    };
  }

  try {
    const bytes = fsImpl.readFileSync(inspected.target);
    if (bytes.length > MAX_SOURCE_BYTES) {
      return { ...base, condition: 'invalid', reason: 'source_oversized', bytes: bytes.length };
    }
    const content = decodeUtf8(bytes);
    if (content === null) {
      return { ...base, condition: 'invalid', reason: 'invalid_utf8', bytes: bytes.length };
    }
    if (!content.trim()) {
      return { ...base, condition: 'invalid', reason: 'source_empty', bytes: bytes.length };
    }
    return {
      ...base,
      condition: 'valid',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      mtime: new Date(inspected.stat.mtimeMs).toISOString(),
      content,
    };
  } catch (err) {
    return { ...base, condition: 'invalid', reason: `read_failed:${err.message}` };
  }
}

function validateProfile(profileRecord, definition) {
  if (!profileRecord || profileRecord.condition !== 'valid') return [];
  let profile;
  try {
    profile = JSON.parse(profileRecord.content);
  } catch (_) {
    return { profile: null, problems: ['profile_json_parse_failed'] };
  }

  const problems = [];
  if (profile.schema !== PROFILE_SCHEMA) problems.push('profile_schema_mismatch');
  if (!Number.isInteger(profile.version) || !SUPPORTED_PROFILE_VERSIONS.has(profile.version)) {
    problems.push('profile_version_unsupported');
  }
  if (profile.seat_id !== definition.seatId) problems.push('profile_seat_mismatch');
  if (profile.runtime_address !== definition.seatId) problems.push('profile_runtime_address_mismatch');
  if (Number(profile.pane_id) !== definition.paneId) problems.push('profile_pane_mismatch');
  if (profile.name !== definition.name) problems.push('profile_name_mismatch');
  if (profile.identity_owner !== definition.name) problems.push('profile_owner_mismatch');
  if (normalizeRelativePath(profile?.continuity?.canonical_charter) !== definition.canonicalPath) {
    problems.push('profile_charter_mismatch');
  }
  if (!profile.authority_event || typeof profile.authority_event !== 'object'
    || !String(profile.authority_event.message_id || '').trim()
    || !String(profile.authority_event.author || '').trim()) {
    problems.push('profile_authority_event_missing');
  }
  if (!Array.isArray(profile.hard_anchors)
    || profile.hard_anchors.length === 0
    || profile.hard_anchors.some((item) => !String(item || '').trim())) {
    problems.push('profile_hard_anchors_missing');
  }
  if (profile?.continuity?.peer_overwrite_allowed !== false) {
    problems.push('profile_peer_overwrite_boundary_missing');
  }
  return { profile, problems };
}

function normalizeExpectedHash(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.startsWith('sha256:') ? normalized.slice('sha256:'.length) : normalized;
}

function extractSourceRevision(record) {
  if (!record || record.condition !== 'valid') return null;
  if (record.kind === 'profile') {
    try {
      const parsed = JSON.parse(record.content);
      const revision = parsed.revision ?? parsed.source_revision ?? parsed.version;
      return revision === undefined || revision === null ? null : String(revision).trim();
    } catch (_) {
      return null;
    }
  }
  const match = String(record.content || '').match(/^(?:source\s+revision|revision|version):\s*`?([^`\r\n]+)`?\s*$/im);
  return match ? String(match[1] || '').trim() : null;
}

function markProfileMetadataInvalid(profileRecord, reason) {
  if (profileRecord?.condition === 'valid') {
    profileRecord.condition = 'invalid';
    profileRecord.reason = reason;
  }
}

function resolveDeclaredCompanion(records, profileRecord, declaredPath) {
  const normalizedPath = normalizeRelativePath(declaredPath);
  const record = records.find((candidate) => candidate.path === normalizedPath);
  if (!record) markProfileMetadataInvalid(profileRecord, 'required_companion_not_allowlisted');
  return record;
}

function applyOwnerContinuityMetadata(records, profile, partialReasons) {
  if (!profile || typeof profile !== 'object') return;
  const continuity = profile.continuity && typeof profile.continuity === 'object'
    ? profile.continuity
    : {};
  const declaredState = normalizeSeatId(continuity.state || continuity.status);
  const profileRecord = records.find((record) => record.kind === 'profile');
  if (declaredState === 'stale' && profileRecord?.condition === 'valid') {
    profileRecord.condition = 'stale';
    profileRecord.reason = 'owner_declared_continuity_stale';
  } else if (declaredState === 'partial') {
    partialReasons.push('owner_declared_continuity_partial');
  }

  const requiredHashes = continuity.required_companion_hashes;
  if (requiredHashes && typeof requiredHashes === 'object' && !Array.isArray(requiredHashes)) {
    for (const [declaredPath, expectedValue] of Object.entries(requiredHashes)) {
      const record = resolveDeclaredCompanion(records, profileRecord, declaredPath);
      if (!record) continue;
      const expectedHash = normalizeExpectedHash(expectedValue);
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
        markProfileMetadataInvalid(profileRecord, 'required_companion_hash_invalid');
        continue;
      }
      if (record.condition === 'valid' && record.sha256 !== expectedHash) {
        record.condition = 'stale';
        record.reason = 'owner_required_companion_hash_mismatch';
        record.expectedSha256 = expectedHash;
      }
    }
  }

  const requiredRevisions = continuity.required_companion_revisions;
  if (requiredRevisions && typeof requiredRevisions === 'object' && !Array.isArray(requiredRevisions)) {
    for (const [declaredPath, expectedValue] of Object.entries(requiredRevisions)) {
      const record = resolveDeclaredCompanion(records, profileRecord, declaredPath);
      if (!record) continue;
      const expectedRevision = String(expectedValue ?? '').trim();
      if (!expectedRevision) {
        markProfileMetadataInvalid(profileRecord, 'required_companion_revision_invalid');
        continue;
      }
      if (record.condition !== 'valid') continue;
      const actualRevision = extractSourceRevision(record);
      if (actualRevision !== expectedRevision) {
        record.condition = 'stale';
        record.reason = actualRevision
          ? 'owner_required_companion_revision_mismatch'
          : 'owner_required_companion_revision_missing';
        record.expectedRevision = expectedRevision;
        if (actualRevision) record.actualRevision = actualRevision;
      }
    }
  }
}

function boundedText(value, maxBytes) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { text: text.slice(0, low), truncated: true };
}

function buildPromptContext(definition, status, records, profile, partialReasons) {
  const issues = records
    .filter((record) => record.condition !== 'valid')
    .map((record) => `${record.path}=${record.condition}:${record.reason || 'unspecified'}`);
  const sourceReceipts = records.map((record) => (
    `${record.path} [${record.condition}${record.sha256 ? ` sha256:${record.sha256}` : ''}]`
  ));
  const chosenJob = profile?.chosen_job?.title
    ? String(profile.chosen_job.title)
    : null;
  const centers = Array.isArray(profile?.chosen_job?.center)
    ? profile.chosen_job.center.map((item) => String(item)).filter(Boolean).slice(0, 12)
    : [];
  const anchors = Array.isArray(profile?.hard_anchors)
    ? profile.hard_anchors.map((item) => String(item)).filter(Boolean).slice(0, 16)
    : [];

  const lines = [
    `## PERSONAL CONTINUITY — ${definition.name} (${definition.seatId})`,
    `Status: ${status.toUpperCase()}`,
    'This is the active seat\'s local/NAS-owned identity context. It is separate from shared role, task, and health context.',
    `Canonical source: ${definition.canonicalPath}`,
    `Read ${definition.canonicalPath} before acting as this seat. Never substitute another seat's identity or invent missing continuity.`,
    chosenJob ? `Chosen job: ${chosenJob}` : '',
    centers.length > 0 ? `Chosen center: ${centers.join(', ')}` : '',
    anchors.length > 0 ? `Hard anchors: ${anchors.join(', ')}` : '',
    'Source receipts:',
    ...sourceReceipts.map((line) => `- ${line}`),
    ...(partialReasons.length > 0 ? ['Partial-state reasons:', ...partialReasons.map((reason) => `- ${reason}`)] : []),
    ...(issues.length > 0 ? ['Source warnings:', ...issues.map((issue) => `- ${issue}`)] : []),
  ].filter(Boolean);
  return boundedText(lines.join('\n'), MAX_PROMPT_BYTES);
}

function publicSourceRecord(record) {
  const publicRecord = { ...record };
  delete publicRecord.content;
  return publicRecord;
}

function buildReceipt(load) {
  const receipt = { ...load };
  delete receipt.promptContext;
  return receipt;
}

function writeReceiptAtomically(projectRoot, load, fsImpl = fs) {
  const paneId = String(load.paneId || '');
  if (!/^[123]$/.test(paneId)) return null;
  const dir = path.join(projectRoot, '.squidrun', 'runtime', 'seat-identity-loads');
  fsImpl.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${paneId}.json`);
  const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fsImpl.writeFileSync(temp, `${JSON.stringify(buildReceipt(load), null, 2)}\n`, 'utf8');
  fsImpl.renameSync(temp, target);
  return target;
}

function loadSeatIdentityContext(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const projectRoot = path.resolve(String(options.projectRoot || process.cwd()));
  const paneId = Number(options.paneId);
  const runtimeRole = normalizeSeatId(options.runtimeRole);
  const definitions = options.definitions || SEAT_DEFINITIONS;
  const definition = definitions[runtimeRole];
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  const loadedAt = options.loadedAt || new Date(nowMs).toISOString();

  if (!definition || definition.paneId !== paneId) {
    const invalid = {
      schema: LOAD_SCHEMA,
      seatId: runtimeRole || null,
      paneId: Number.isInteger(paneId) ? paneId : null,
      name: definition?.name || null,
      status: 'invalid_binding',
      sources: [],
      missingSources: [],
      invalidSources: [],
      staleSources: [],
      partialReasons: ['trusted_role_pane_binding_mismatch'],
      promptContext: '',
      loadedAt,
    };
    if (options.writeReceipt !== false) {
      try {
        invalid.receiptPath = writeReceiptAtomically(projectRoot, invalid, fsImpl);
      } catch (err) {
        invalid.receiptError = `receipt_write_failed:${err.message}`;
      }
    }
    return invalid;
  }

  const records = definition.sources.map((source) => loadSource(projectRoot, source, fsImpl));
  const containmentFailures = records.filter((record) => (
    record.condition === 'invalid' && INVALID_BINDING_SOURCE_REASONS.has(record.reason)
  ));
  if (containmentFailures.length > 0) {
    const invalid = {
      schema: LOAD_SCHEMA,
      seatId: definition.seatId,
      paneId: definition.paneId,
      name: definition.name,
      status: 'invalid_binding',
      sources: records.map(publicSourceRecord),
      missingSources: records.filter((record) => record.condition === 'missing').map((record) => record.path),
      invalidSources: records.filter((record) => record.condition === 'invalid').map((record) => record.path),
      staleSources: [],
      partialReasons: containmentFailures.map((record) => (
        `unsafe_source_path:${record.path}:${record.reason}`
      )),
      promptContext: '',
      loadedAt,
    };
    if (options.writeReceipt !== false) {
      try {
        invalid.receiptPath = writeReceiptAtomically(projectRoot, invalid, fsImpl);
      } catch (err) {
        invalid.receiptError = `receipt_write_failed:${err.message}`;
      }
    }
    return invalid;
  }
  const partialReasons = [];
  const profileRecord = records.find((record) => record.kind === 'profile');
  let profile = null;
  if (profileRecord?.condition === 'valid') {
    const validation = validateProfile(profileRecord, definition);
    profile = validation.profile || null;
    if (validation.problems.length > 0) {
      profileRecord.condition = 'invalid';
      profileRecord.reason = validation.problems.join(',');
    }
  }

  applyOwnerContinuityMetadata(records, profile, partialReasons);
  const missingSources = records.filter((record) => record.condition === 'missing').map((record) => record.path);
  const invalidSources = records.filter((record) => record.condition === 'invalid').map((record) => record.path);
  const staleSources = records.filter((record) => record.condition === 'stale').map((record) => record.path);
  const status = missingSources.length > 0 || invalidSources.length > 0 || staleSources.length > 0 || partialReasons.length > 0
    ? 'partial'
    : 'complete';
  const boundedPrompt = buildPromptContext(definition, status, records, profileRecord?.condition === 'valid' ? profile : null, partialReasons);
  if (boundedPrompt.truncated) partialReasons.push('prompt_context_bounded');
  const finalStatus = boundedPrompt.truncated ? 'partial' : status;
  const load = {
    schema: LOAD_SCHEMA,
    seatId: definition.seatId,
    paneId: definition.paneId,
    name: definition.name,
    status: finalStatus,
    sources: records.map(publicSourceRecord),
    missingSources,
    invalidSources,
    staleSources,
    partialReasons,
    promptContext: boundedPrompt.truncated
      ? `${boundedPrompt.text}\n- prompt_context_bounded`
      : boundedPrompt.text,
    loadedAt,
  };

  if (options.writeReceipt !== false) {
    try {
      load.receiptPath = writeReceiptAtomically(projectRoot, load, fsImpl);
    } catch (err) {
      load.status = 'partial';
      load.partialReasons.push(`receipt_write_failed:${err.message}`);
      load.promptContext += `\n- receipt_write_failed:${err.message}`;
    }
  }
  return load;
}

module.exports = {
  loadSeatIdentityContext,
  SEAT_DEFINITIONS,
  LOAD_SCHEMA,
  PROFILE_SCHEMA,
  MAX_SOURCE_BYTES,
  MAX_PROMPT_BYTES,
  _internals: {
    inspectAllowlistedPath,
    loadSource,
    validateProfile,
    applyOwnerContinuityMetadata,
    extractSourceRevision,
    writeReceiptAtomically,
    boundedText,
  },
};
