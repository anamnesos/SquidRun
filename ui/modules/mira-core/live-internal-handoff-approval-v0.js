'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  buildMiraProgressReport,
} = require('./mira-progress-v0');

const SCHEMA = 'squidrun.mira_core.live_internal_handoff_approval_v0';
const PROOF_SCHEMA = 'squidrun.mira_core.live_internal_handoff_send_proof_v0';
const VERSION = 1;
const APPROVAL_ACTION = 'mira_internal_handoff_send_v0';
const APPROVAL_SEND_CHANNEL = 'mira:internal-handoff-approval-send';
const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RECORD_RELATIVE_DIR = path.join(
  '.squidrun',
  'runtime',
  'mira-internal-handoff-sends-v0'
);
const ALLOWED_INTERNAL_TARGETS = new Set(['builder', 'oracle']);

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    sorted[key] = canonicalize(value[key]);
  }
  return sorted;
}

function stableHash(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function sha256Text(value = '') {
  return `sha256:${crypto.createHash('sha256').update(String(value || '')).digest('hex')}`;
}

function trimText(value, limit = 260) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeTargetAgent(value = '') {
  const target = String(value || '').trim().toLowerCase();
  return ALLOWED_INTERNAL_TARGETS.has(target) ? target : null;
}

function normalizeSessionBinding(input = {}, options = {}) {
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const optionMetadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
  return {
    session_id: trimText(
      metadata.sessionId
      || metadata.session_id
      || input.sessionId
      || input.session_id
      || optionMetadata.sessionId
      || optionMetadata.session_id
      || options.sessionId
      || options.session_id,
      120
    ) || null,
    profile_name: trimText(
      metadata.profileName
      || metadata.profile_name
      || input.profileName
      || input.profile_name
      || optionMetadata.profileName
      || optionMetadata.profile_name
      || options.profileName
      || options.profile_name
      || 'main',
      80
    ) || 'main',
    window_key: trimText(
      metadata.windowKey
      || metadata.window_key
      || input.windowKey
      || input.window_key
      || optionMetadata.windowKey
      || optionMetadata.window_key
      || options.windowKey
      || options.window_key
      || 'main',
      80
    ) || 'main',
    source_scope: trimText(
      metadata.sourceScope
      || metadata.source_scope
      || input.sourceScope
      || input.source_scope
      || optionMetadata.sourceScope
      || optionMetadata.source_scope
      || options.sourceScope
      || options.source_scope
      || 'main',
      80
    ) || 'main',
  };
}

function resolveProjectRoot(options = {}) {
  return path.resolve(String(options.projectRoot || process.cwd()));
}

function resolveMaybeProjectPath(projectRoot, filePath) {
  const text = String(filePath || '').trim();
  if (!text) return null;
  return path.isAbsolute(text) ? text : path.join(projectRoot, text);
}

function readProgressProofCanonicalHash(projectRoot, sourceRef) {
  const proofPath = resolveMaybeProjectPath(projectRoot, sourceRef);
  if (!proofPath) return null;
  try {
    if (!fs.existsSync(proofPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    return trimText(parsed?.canonical_hash, 120) || stableHash(parsed);
  } catch {
    return null;
  }
}

function normalizeProgressBinding(progressReport = {}, options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const head = progressReport.source_refs?.head || {};
  const proof = progressReport.source_refs?.progress_proof_inputs || {};
  const proofSourceRef = trimText(
    progressReport.proof_source_ref
    || proof.source_ref
    || options.progressProofSourceRef,
    180
  ) || null;
  const proofCanonicalHash = trimText(
    progressReport.proof_canonical_hash
    || proof.canonical_hash
    || options.progressProofArtifactHash,
    120
  ) || readProgressProofCanonicalHash(projectRoot, proofSourceRef);
  return {
    percent: Number(progressReport.computed_total_percent ?? progressReport.percent ?? 0),
    status: trimText(progressReport.status, 40) || 'UNKNOWN',
    warnings: Array.isArray(progressReport.warnings)
      ? progressReport.warnings.map((item) => trimText(item, 120)).filter(Boolean)
      : [],
    head_short_sha: trimText(
      progressReport.head_short_sha
      || head.short_sha
      || options.head?.short_sha
      || options.head?.shortSha,
      40
    ) || null,
    head_committed_at: progressReport.head_committed_at || head.committed_at || options.head?.committed_at || null,
    proof_source_ref: proofSourceRef,
    proof_status: trimText(progressReport.proof_status || proof.status, 40) || null,
    proof_canonical_hash: proofCanonicalHash || null,
    progress_canonical_hash: trimText(progressReport.canonical_hash || options.progressCanonicalHash, 120) || null,
  };
}

function sourceRefsFromPreview(preview = {}, progress = {}) {
  const refs = [];
  if (preview.current_lane?.source_ref) refs.push(preview.current_lane.source_ref);
  if (Array.isArray(preview.source_evidence)) {
    for (const item of preview.source_evidence) {
      if (item?.source_ref) refs.push(item.source_ref);
    }
  }
  if (progress.head_short_sha) refs.push(`HEAD:${progress.head_short_sha}`);
  if (progress.proof_source_ref) refs.push(progress.proof_source_ref);
  return Array.from(new Set(refs.map((item) => trimText(item, 180)).filter(Boolean))).slice(0, 12);
}

function isoFromMs(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function buildMiraInternalHandoffApprovalEnvelope(preview = {}, options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const targetAgent = normalizeTargetAgent(preview.target_agent);
  const draftBody = String(preview.draft_body || '');
  const session = normalizeSessionBinding(options.metadata || {}, {
    ...options,
    metadata: options.metadata || preview.approval_gate?.binding?.session || {},
  });
  const generatedAtMs = Date.parse(String(preview.generated_at || preview.approval_gate?.generated_at || ''));
  const fallbackGeneratedAtMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const effectiveGeneratedAtMs = Number.isFinite(generatedAtMs) ? generatedAtMs : fallbackGeneratedAtMs;
  const existingExpiresAtMs = Date.parse(String(preview.approval_gate?.expires_at || options.expiresAt || ''));
  const expiresAtMs = Number.isFinite(existingExpiresAtMs)
    ? existingExpiresAtMs
    : effectiveGeneratedAtMs + (Number(options.approvalTtlMs) || DEFAULT_APPROVAL_TTL_MS);
  const progress = normalizeProgressBinding(preview.progress || options.progressReport || {}, {
    ...options,
    projectRoot,
  });
  const bodyHash = sha256Text(draftBody);
  const source_refs = sourceRefsFromPreview(preview, progress);
  const previewCore = {
    schema: preview.schema || 'squidrun.mira_core.live_internal_handoff_preview_v0',
    version: preview.version || 1,
    target_agent: targetAgent,
    body_hash: bodyHash,
    body_char_count: draftBody.length,
    current_lane: {
      source_ref: preview.current_lane?.source_ref || null,
      source_message_id: preview.current_lane?.source_message_id || null,
      objective: trimText(preview.current_lane?.objective, 260) || null,
    },
    progress,
    source_refs,
    session,
    generated_at: isoFromMs(effectiveGeneratedAtMs),
    expires_at: isoFromMs(expiresAtMs),
  };
  const previewHash = stableHash(previewCore);
  const previewId = `mira-internal-handoff-preview-${previewHash.slice(7, 23)}`;
  const approvalCore = {
    action: APPROVAL_ACTION,
    channel: APPROVAL_SEND_CHANNEL,
    preview_id: previewId,
    preview_hash: previewHash,
    target_agent: targetAgent,
    body_hash: bodyHash,
    session,
    progress,
    source_refs,
    expires_at: isoFromMs(expiresAtMs),
  };
  const approvalHash = stableHash(approvalCore);
  const approvalId = `mira-internal-handoff-approval-${approvalHash.slice(7, 23)}`;
  return {
    schema: SCHEMA,
    version: VERSION,
    action: APPROVAL_ACTION,
    channel: APPROVAL_SEND_CHANNEL,
    preview_id: previewId,
    preview_hash: previewHash,
    approval_id: approvalId,
    approval_token: `${approvalId}.${approvalHash.slice(7, 31)}`,
    approval_token_hash: sha256Text(`${approvalId}.${approvalHash.slice(7, 31)}`),
    generated_at: isoFromMs(effectiveGeneratedAtMs),
    expires_at: isoFromMs(expiresAtMs),
    binding: {
      target_agent: targetAgent,
      body_hash: bodyHash,
      body_char_count: draftBody.length,
      session,
      progress,
      source_refs,
    },
    dispatch_payload_preview: {
      channel: APPROVAL_SEND_CHANNEL,
      action: APPROVAL_ACTION,
      approval_id: approvalId,
      approval_token_hash: sha256Text(`${approvalId}.${approvalHash.slice(7, 31)}`),
      preview_id: previewId,
      preview_hash: previewHash,
      target_agent: targetAgent,
      body_hash: bodyHash,
      session,
      requires_explicit_approval_action: true,
      preview_only_until_invoked: true,
    },
  };
}

function resolveRecordDir(projectRoot, options = {}) {
  return path.resolve(options.recordDir || path.join(projectRoot, DEFAULT_RECORD_RELATIVE_DIR));
}

function approvalRecordPath(projectRoot, approvalId, options = {}) {
  const safeId = String(approvalId || '').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(resolveRecordDir(projectRoot, options), `${safeId}.json`);
}

function reject(decision, reason, extra = {}) {
  return {
    schema: SCHEMA,
    version: VERSION,
    ok: false,
    decision,
    reason,
    sent: false,
    send_result: null,
    side_effect_counters: {
      hm_send_count: 0,
      internal_send_count: 0,
      external_send_count: 0,
      runtime_post_count: 0,
      model_call_count: 0,
      network_count: 0,
      write_count: 0,
      approval_record_write_count: 0,
    },
    ...extra,
  };
}

function validateSuppliedSession(expected = {}, supplied = {}) {
  const mismatches = [];
  for (const key of ['session_id', 'profile_name', 'window_key', 'source_scope']) {
    if ((expected[key] || null) !== (supplied[key] || null)) mismatches.push(key);
  }
  return mismatches;
}

function trustedSessionFromOptions(options = {}) {
  const trusted = options.trustedMetadata || options.trusted_metadata || null;
  if (!trusted || typeof trusted !== 'object' || Array.isArray(trusted)) return null;
  const session = normalizeSessionBinding({ metadata: trusted }, {});
  const complete = Boolean(
    session.session_id
    && session.profile_name
    && session.window_key
    && session.source_scope
  );
  return complete ? session : null;
}

function buildCurrentProgressBinding(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const report = options.currentProgressReport || options.progressReport || buildMiraProgressReport({
    projectRoot,
    progressProofPath: options.progressProofPath,
    head: options.head,
    worktreeState: options.worktreeState,
  });
  return normalizeProgressBinding(report, { ...options, projectRoot });
}

function staleProgressReasons(expected = {}, current = {}) {
  const reasons = [];
  if (expected.head_short_sha && current.head_short_sha !== expected.head_short_sha) {
    reasons.push('head_mismatch');
  }
  if (expected.proof_source_ref && current.proof_source_ref !== expected.proof_source_ref) {
    reasons.push('proof_source_mismatch');
  }
  if (expected.proof_status && current.proof_status !== expected.proof_status) {
    reasons.push('proof_status_mismatch');
  }
  if (expected.proof_canonical_hash && current.proof_canonical_hash && current.proof_canonical_hash !== expected.proof_canonical_hash) {
    reasons.push('proof_hash_mismatch');
  }
  if (expected.progress_canonical_hash && current.progress_canonical_hash && current.progress_canonical_hash !== expected.progress_canonical_hash) {
    reasons.push('progress_hash_mismatch');
  }
  if (Array.isArray(current.warnings) && current.warnings.length > 0) {
    reasons.push('current_progress_has_warnings');
  }
  return reasons;
}

function defaultHmSend(targetAgent, body, metadata = {}, options = {}) {
  if (options.allowRealHmSend !== true) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'real_hm_send_requires_allowRealHmSend',
    };
  }
  const projectRoot = resolveProjectRoot(options);
  const hmSendPath = path.resolve(options.hmSendPath || path.join(projectRoot, 'ui', 'scripts', 'hm-send.js'));
  const stdout = execFileSync(process.execPath, [
    hmSendPath,
    targetAgent,
    '--stdin',
    '--role',
    metadata.role || 'mira',
  ], {
    cwd: projectRoot,
    input: body,
    encoding: 'utf8',
    timeout: Number(options.hmSendTimeoutMs) || 30000,
  });
  return {
    ok: true,
    status: 'sent',
    transport: 'hm-send',
    stdout_excerpt: trimText(stdout, 600),
  };
}

function buildProofRecord({
  approvalEnvelope,
  targetAgent,
  body,
  sendResult,
  generatedAt,
}) {
  return {
    schema: PROOF_SCHEMA,
    version: VERSION,
    generated_at: generatedAt,
    approval_id: approvalEnvelope.approval_id,
    approval_token_hash: approvalEnvelope.approval_token_hash,
    preview_id: approvalEnvelope.preview_id,
    preview_hash: approvalEnvelope.preview_hash,
    target_agent: targetAgent,
    body_hash: sha256Text(body),
    body_char_count: String(body || '').length,
    source_refs: approvalEnvelope.binding.source_refs,
    approval_binding: approvalEnvelope.binding,
    send_result: sendResult,
    side_effect_counters: {
      hm_send_count: sendResult?.ok === true ? 1 : 0,
      internal_send_count: sendResult?.ok === true ? 1 : 0,
      external_send_count: 0,
      runtime_post_count: 0,
      model_call_count: 0,
      network_count: Number(sendResult?.network_count || 0),
      write_count: 1,
      approval_record_write_count: 1,
    },
    blockers_preserved: {
      telegram: true,
      voice: true,
      a4_external_action: true,
    },
  };
}

async function executeMiraInternalHandoffApprovalSendV0(input = {}, options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const preview = input.preview || input.internalHandoffPreview || input.internal_handoff_preview || null;
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    return reject('rejected_missing_preview', 'approval action requires the exact preview object');
  }
  const gate = preview.approval_gate && typeof preview.approval_gate === 'object' ? preview.approval_gate : {};
  const approvalEnvelope = buildMiraInternalHandoffApprovalEnvelope(preview, {
    ...options,
    projectRoot,
    metadata: gate.binding?.session || gate.session || options.previewMetadata || options.metadata,
    progressProofArtifactHash: gate.binding?.progress?.proof_canonical_hash || options.progressProofArtifactHash,
    expiresAt: gate.expires_at,
  });
  if (gate.approval_token && gate.approval_token !== approvalEnvelope.approval_token) {
    return reject('rejected_preview_binding_mismatch', 'preview approval token does not match its bound fields', {
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
    });
  }
  if (gate.preview_hash && gate.preview_hash !== approvalEnvelope.preview_hash) {
    return reject('rejected_preview_hash_mismatch', 'preview hash does not match approval binding', {
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
    });
  }
  const suppliedToken = trimText(input.approvalToken || input.approval_token, 260);
  if (!suppliedToken || suppliedToken !== approvalEnvelope.approval_token) {
    return reject('rejected_approval_token_mismatch', 'approval token is missing or does not match preview binding', {
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
    });
  }
  const suppliedApprovalId = trimText(input.approvalId || input.approval_id, 120);
  if (suppliedApprovalId && suppliedApprovalId !== approvalEnvelope.approval_id) {
    return reject('rejected_approval_id_mismatch', 'approval id does not match preview binding', {
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
    });
  }
  const targetAgent = normalizeTargetAgent(input.targetAgent || input.target_agent);
  if (!targetAgent || targetAgent !== approvalEnvelope.binding.target_agent) {
    return reject('rejected_target_mismatch', 'approval target is not the bound internal Builder/Oracle target', {
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
      bound_target: approvalEnvelope.binding.target_agent,
    });
  }
  const draftBody = String(input.draftBody || input.draft_body || '');
  if (!draftBody || sha256Text(draftBody) !== approvalEnvelope.binding.body_hash) {
    return reject('rejected_body_hash_mismatch', 'approval body was edited or omitted', {
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
      bound_body_hash: approvalEnvelope.binding.body_hash,
    });
  }
  const trustedSession = options.requireTrustedMetadata === true
    ? trustedSessionFromOptions(options)
    : null;
  if (options.requireTrustedMetadata === true && !trustedSession) {
    return reject('rejected_untrusted_approval_context', 'trusted IPC session/profile/window/source metadata is required for approval sends', {
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
    });
  }
  const suppliedSession = trustedSession || normalizeSessionBinding(input, options);
  const sessionMismatches = validateSuppliedSession(approvalEnvelope.binding.session, suppliedSession);
  if (sessionMismatches.length > 0) {
    return reject('rejected_session_binding_mismatch', 'approval session/profile/window/source binding does not match preview', {
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
      mismatches: sessionMismatches,
    });
  }
  const nowMs = Number.isFinite(Number(options.nowMs || input.nowMs))
    ? Number(options.nowMs || input.nowMs)
    : Date.now();
  const expiresAtMs = Date.parse(String(approvalEnvelope.expires_at || ''));
  if (Number.isFinite(expiresAtMs) && nowMs > expiresAtMs) {
    return reject('rejected_stale_preview', 'approval preview expired before send', {
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
      expires_at: approvalEnvelope.expires_at,
    });
  }
  const currentProgress = buildCurrentProgressBinding({ ...options, projectRoot });
  const staleReasons = staleProgressReasons(approvalEnvelope.binding.progress, currentProgress);
  if (staleReasons.length > 0) {
    return reject('rejected_stale_preview', 'current HEAD/proof state no longer matches preview binding', {
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
      stale_reasons: staleReasons,
      bound_progress: approvalEnvelope.binding.progress,
      current_progress: currentProgress,
    });
  }

  const recordPath = approvalRecordPath(projectRoot, approvalEnvelope.approval_id, options);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  let reserved = false;
  try {
    const fd = fs.openSync(recordPath, 'wx');
    fs.closeSync(fd);
    reserved = true;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return reject('rejected_replayed_approval', 'approval id already has a send proof record', {
        approval_id: approvalEnvelope.approval_id,
        preview_id: approvalEnvelope.preview_id,
        record_path: recordPath,
      });
    }
    return reject('rejected_record_reservation_failed', error && error.message ? error.message : String(error), {
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
    });
  }

  const generatedAt = isoFromMs(nowMs);
  const sender = typeof options.sendInternalMessage === 'function'
    ? options.sendInternalMessage
    : defaultHmSend;
  let sendResult;
  try {
    sendResult = await sender(targetAgent, draftBody, {
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
      preview_hash: approvalEnvelope.preview_hash,
      body_hash: approvalEnvelope.binding.body_hash,
      source_refs: approvalEnvelope.binding.source_refs,
      role: 'mira',
      internal_only: true,
    }, {
      ...options,
      projectRoot,
    });
  } catch (error) {
    sendResult = {
      ok: false,
      status: 'send_exception',
      error: error && error.message ? error.message : String(error),
    };
  }
  const normalizedSendResult = sendResult && typeof sendResult === 'object'
    ? sendResult
    : { ok: Boolean(sendResult), status: sendResult ? 'sent' : 'send_failed' };
  const proofRecord = buildProofRecord({
    approvalEnvelope,
    targetAgent,
    body: draftBody,
    sendResult: normalizedSendResult,
    generatedAt,
  });
  fs.writeFileSync(recordPath, `${JSON.stringify(proofRecord, null, 2)}\n`, 'utf8');

  if (normalizedSendResult.ok !== true) {
    return {
      schema: SCHEMA,
      version: VERSION,
      ok: false,
      decision: 'send_failed_recorded',
      reason: normalizedSendResult.reason || normalizedSendResult.error || normalizedSendResult.status || 'send_failed',
      sent: false,
      approval_id: approvalEnvelope.approval_id,
      preview_id: approvalEnvelope.preview_id,
      target_agent: targetAgent,
      body_hash: approvalEnvelope.binding.body_hash,
      source_refs: approvalEnvelope.binding.source_refs,
      proof_record_path: recordPath,
      proof_record: proofRecord,
      send_result: normalizedSendResult,
      side_effect_counters: proofRecord.side_effect_counters,
      record_reserved: reserved,
    };
  }

  return {
    schema: SCHEMA,
    version: VERSION,
    ok: true,
    decision: 'sent_internal_handoff_once',
    sent: true,
    approval_id: approvalEnvelope.approval_id,
    approval_token_hash: approvalEnvelope.approval_token_hash,
    preview_id: approvalEnvelope.preview_id,
    preview_hash: approvalEnvelope.preview_hash,
    target_agent: targetAgent,
    body_hash: approvalEnvelope.binding.body_hash,
    source_refs: approvalEnvelope.binding.source_refs,
    proof_record_path: recordPath,
    proof_record: proofRecord,
    send_result: normalizedSendResult,
    side_effect_counters: proofRecord.side_effect_counters,
    blockers_preserved: proofRecord.blockers_preserved,
  };
}

module.exports = {
  APPROVAL_ACTION,
  APPROVAL_SEND_CHANNEL,
  DEFAULT_APPROVAL_TTL_MS,
  DEFAULT_RECORD_RELATIVE_DIR,
  PROOF_SCHEMA,
  SCHEMA,
  VERSION,
  approvalRecordPath,
  buildMiraInternalHandoffApprovalEnvelope,
  executeMiraInternalHandoffApprovalSendV0,
  normalizeProgressBinding,
  sha256Text,
  stableHash,
};
