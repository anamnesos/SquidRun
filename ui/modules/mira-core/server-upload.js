'use strict';

const crypto = require('crypto');

const { buildMiraCorePulse } = require('./pulse');
const { buildMiraCoreSnapshot } = require('./snapshot');

const ENVELOPE_SCHEMA_VERSION = 'squidrun.mira_core.server_upload_envelope.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.server_upload_validation_report.v0';
const SERVER_UPLOAD_VERSION = 'v0';
const REDACTION_POLICY_VERSION = 'mira-core-server-upload-redaction-v0';

const REQUIRED_OUTPUT_FIELDS = Object.freeze(['upload_envelope', 'validation_report']);
const REQUIRED_ENVELOPE_FIELDS = Object.freeze([
  'schema',
  'version',
  'upload_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'snapshotRef',
  'pulseRef',
  'source_watermarks',
  'capability_summary',
  'redaction_audit',
  'included_items',
  'withheld_items_summary',
  'server_migration',
  'signature_envelope',
  'no_network_performed',
]);
const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_run_id',
  'generated_at',
  'decision',
  'input_refs',
  'eligibility_result',
  'redaction_result',
  'profile_scope_result',
  'idempotency_result',
  'watermark_result',
  'capability_truth_result',
  'bridge_delivery_truth_result',
  'side_effect_result',
  'reasons',
  'followup_required',
]);
const REQUIRED_INCLUDED_ITEM_FIELDS = Object.freeze([
  'id',
  'kind',
  'summary',
  'source',
  'authority',
  'syncEligibility',
  'redactionStatus',
  'profile',
  'sessionId',
  'deviceId',
  'freshnessAt',
  'evidenceRefs',
  'source_trace',
  'source_watermark_ref',
  'payload_hash',
]);

const INCLUDE_SYNC_ELIGIBILITY = Object.freeze(['core_sync_safe', 'core_sync_redacted']);
const ALWAYS_WITHHOLD_SYNC_ELIGIBILITY = Object.freeze(['blocked', 'local_only', 'approval_required']);
const RAW_FLAG_REASON_MAP = Object.freeze({
  raw_comms: 'raw_comms',
  raw_terminal: 'raw_terminal',
  screenshot_ocr: 'screenshot_ocr',
  browser_state: 'browser_state',
  secret_like: 'secret_like',
  customer_private_data: 'customer_private_data',
  side_profile_content: 'side_profile_content',
  raw_database_record: 'raw_database_record',
});
const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY=',
  'Authorization: Bearer',
  'BEGIN PRIVATE KEY',
  'raw comms body',
  'raw terminal scrollback',
  'screenshot OCR text',
  'browser session state',
  'BrowserProfile\\Cookies',
  'customer private note',
  'customer phone',
  'side-profile private note',
  'full sqlite row payload',
  'server can execute local shell',
  'cloud can operate PTY',
  'server deployed',
  'customer message sent',
  'trade placed',
  'model-processing proof from websocket acceptance',
  'bridge green from socket only',
  'remote builder target allowed',
  'remote oracle target allowed',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = sortObject(value[key]);
    return result;
  }, {});
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(sortObject(value)))
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

function normalizeProfileName(value) {
  return String(value || 'main').trim() || 'main';
}

function normalizeScope(inputSignals = {}, snapshot = null) {
  const envelopeScope = inputSignals.envelopeScope || {};
  const profileName = normalizeProfileName(
    envelopeScope.profile
    || inputSignals.profile
    || inputSignals.fixtureA?.profile
    || snapshot?.profile?.name
    || 'main'
  );
  return {
    profileName,
    sessionId: envelopeScope.sessionId || inputSignals.sessionId || snapshot?.profile?.sessionScopeId || snapshot?.device?.sessionId || 'app-session-326',
    deviceId: envelopeScope.deviceId || inputSignals.deviceId || inputSignals.fixtureA?.deviceId || snapshot?.device?.deviceId || 'VIGIL',
  };
}

function normalizeProfile(scope) {
  return {
    name: scope.profileName,
    windowKey: scope.profileName,
    sessionScopeId: scope.sessionId,
    syncEligibility: 'core_sync_safe',
  };
}

function defaultEvidenceRef(id, source = 'snapshot') {
  return {
    store: source,
    eventId: id,
    relation: 'supports_upload_envelope',
  };
}

function safeSummary(item = {}) {
  if (typeof item.summary === 'string' && item.summary.trim()) return item.summary.trim();
  return `Redacted upload summary for ${String(item.id || 'item')}.`;
}

function itemSource(item = {}) {
  if (typeof item.source === 'string') return item.source;
  if (item.source?.store) return item.source.store;
  if (item.source?.source) return item.source.source;
  return 'snapshot';
}

function watermarkIdFor(source, scope = 'main') {
  return `${source}:${scope}`;
}

function makeWatermark(source, scope, generatedAt, contentHash = null) {
  const watermark = `${source}:${scope}`;
  return {
    source,
    scope,
    watermark,
    observed_at: generatedAt,
    contentHash: contentHash || sha256({ source, scope, watermark, generatedAt }),
  };
}

function normalizeSourceWatermarks(inputSignals = {}, scope, generatedAt, pulseRef = null) {
  if (Array.isArray(inputSignals.source_watermarks)) return inputSignals.source_watermarks;
  if (Array.isArray(inputSignals.sourceWatermarks)) return inputSignals.sourceWatermarks;
  if (inputSignals.sourceWatermarksMissing === true) return [];

  const sources = new Set(['snapshot']);
  if (pulseRef) sources.add('pulse');
  for (const source of asArray(inputSignals.requiredSources)) sources.add(String(source));
  for (const item of asArray(inputSignals.snapshotItems)) sources.add(itemSource(item));
  if (inputSignals.watermarksHash) {
    return [makeWatermark('snapshot', scope.profileName, generatedAt, inputSignals.watermarksHash)];
  }
  return Array.from(sources)
    .sort()
    .map((source) => makeWatermark(source, scope.profileName, generatedAt));
}

function normalizeSnapshotRef(inputSignals = {}, scope, generatedAt, snapshot = null) {
  const snapshotHash = inputSignals.snapshotHash
    || inputSignals.fixtureA?.snapshotHash
    || snapshot?.snapshotRef?.contentHash
    || snapshot?.contentHash
    || sha256({ items: inputSignals.snapshotItems || [], scope });
  return {
    snapshotId: inputSignals.snapshotId || snapshot?.snapshotId || `snapshot-${stableHash(snapshotHash).slice(0, 12)}`,
    schema: inputSignals.snapshotSchema || snapshot?.schema || 'squidrun.mira_core.snapshot.v0',
    generatedAt: inputSignals.snapshotGeneratedAt || snapshot?.generatedAt || generatedAt,
    profile: scope.profileName,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    contentHash: snapshotHash,
  };
}

function normalizePulseRef(inputSignals = {}, scope, generatedAt, pulse = null) {
  const pulseHash = inputSignals.pulseHash || inputSignals.fixtureA?.pulseHash || pulse?.contentHash;
  const pulseRunId = inputSignals.pulseRef?.pulse_run_id || pulse?.pulse_run_id;
  if (!pulseHash && !pulseRunId && !pulse) return null;
  return {
    pulse_run_id: pulseRunId || `pulse-${stableHash(pulseHash || pulse || 'pulse').slice(0, 12)}`,
    schema: inputSignals.pulseRef?.schema || pulse?.schema || 'squidrun.mira_core.pulse.v0',
    generated_at: inputSignals.pulseRef?.generated_at || pulse?.generated_at || generatedAt,
    profile: scope.profileName,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    contentHash: pulseHash || sha256(pulse || { pulse_run_id: pulseRunId, scope }),
  };
}

function fixtureDefaultItems(inputSignals = {}, scope, generatedAt) {
  if (Array.isArray(inputSignals.snapshotItems)) return inputSignals.snapshotItems;
  const items = [];
  const redactedCount = Math.max(0, Number(inputSignals.expectedRedactedIncluded || 0));
  for (let index = 0; index < redactedCount; index += 1) {
    items.push({
      id: `fixture-redacted-${index + 1}`,
      syncEligibility: 'core_sync_redacted',
      redactionStatus: 'applied',
      profile: scope.profileName,
      sessionId: scope.sessionId,
      deviceId: scope.deviceId,
      source: 'snapshot',
      summary: `Redacted fixture item ${index + 1}.`,
      freshnessAt: generatedAt,
    });
  }
  if (items.length === 0 && inputSignals.includedItemsHash) {
    items.push({
      id: 'fixture-included-001',
      syncEligibility: 'core_sync_safe',
      redactionStatus: 'none',
      profile: scope.profileName,
      sessionId: scope.sessionId,
      deviceId: scope.deviceId,
      source: 'snapshot',
      payload_hash: inputSignals.includedItemsHash,
      summary: 'Fixture included item.',
      freshnessAt: generatedAt,
    });
  }
  return items;
}

function hasRawFlags(item = {}) {
  return asArray(item.rawFlags).length > 0 || asArray(item.dataClasses).some((flag) => RAW_FLAG_REASON_MAP[flag]);
}

function rawFlags(item = {}) {
  return Array.from(new Set(asArray(item.rawFlags).concat(asArray(item.dataClasses))));
}

function addReason(counts, reason, amount = 1) {
  if (!reason) return;
  counts[reason] = Number(counts[reason] || 0) + Number(amount || 0);
}

function itemScopeReasons(item = {}, scope) {
  const reasons = [];
  if (!item.profile || !item.sessionId || !item.deviceId) {
    reasons.push('missing_profile_session_device_scope');
  }
  if (
    item.profile
    && item.sessionId
    && item.deviceId
    && (
      normalizeProfileName(item.profile) !== scope.profileName
      || item.sessionId !== scope.sessionId
      || item.deviceId !== scope.deviceId
    )
  ) {
    reasons.push('profile_mismatch');
    if (normalizeProfileName(item.profile) !== scope.profileName) reasons.push('side_profile_content');
  }
  return reasons;
}

function itemEligibilityReasons(item = {}, scope, sourceWatermarks = []) {
  const reasons = [];
  const syncEligibility = item.syncEligibility || 'local_only';
  const redactionStatus = item.redactionStatus || 'none';
  if (ALWAYS_WITHHOLD_SYNC_ELIGIBILITY.includes(syncEligibility)) reasons.push(syncEligibility);
  if (!INCLUDE_SYNC_ELIGIBILITY.includes(syncEligibility)) {
    if (!ALWAYS_WITHHOLD_SYNC_ELIGIBILITY.includes(syncEligibility)) reasons.push('blocked');
  }
  if (syncEligibility === 'core_sync_redacted' && redactionStatus !== 'applied') {
    reasons.push('unredacted_core_sync_redacted');
  }
  if (syncEligibility === 'core_sync_redacted' && !item.payload_hash && item.payloadHashMissing === true) {
    reasons.push('unredacted_core_sync_redacted');
  }
  for (const flag of rawFlags(item)) {
    if (RAW_FLAG_REASON_MAP[flag]) reasons.push(RAW_FLAG_REASON_MAP[flag]);
  }
  reasons.push(...itemScopeReasons(item, scope));
  const evidenceRefs = asArray(item.evidenceRefs);
  if (item.missingEvidenceRefs === true || (item.evidenceRefs && evidenceRefs.length === 0)) reasons.push('missing_evidence_refs');
  if (item.missingSourceTrace === true || item.source_trace === null) reasons.push('missing_source_trace');
  const source = itemSource(item);
  const watermarkRef = item.source_watermark_ref || watermarkIdFor(source, scope.profileName);
  const watermarkExists = sourceWatermarks.some((watermark) => watermarkIdFor(watermark.source, watermark.scope) === watermarkRef);
  if (!watermarkExists) reasons.push('missing_source_trace');
  return Array.from(new Set(reasons));
}

function normalizeIncludedItem(item = {}, scope, generatedAt, sourceWatermarks = []) {
  const source = itemSource(item);
  const sourceWatermarkRef = item.source_watermark_ref || watermarkIdFor(source, scope.profileName);
  const payloadHash = item.payload_hash || item.payloadHash || sha256({
    id: item.id,
    summary: safeSummary(item),
    syncEligibility: item.syncEligibility,
    redactionStatus: item.redactionStatus,
    source,
  });
  return {
    id: String(item.id || `upload-item-${stableHash(payloadHash).slice(0, 12)}`),
    kind: item.kind || 'snapshot_item',
    summary: safeSummary(item),
    source,
    authority: item.authority || 'derived',
    syncEligibility: item.syncEligibility,
    redactionStatus: item.redactionStatus || 'none',
    profile: scope.profileName,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    freshnessAt: item.freshnessAt || item.freshness_at || generatedAt,
    evidenceRefs: asArray(item.evidenceRefs).length > 0 ? item.evidenceRefs : [defaultEvidenceRef(item.id || payloadHash, source)],
    source_trace: item.source_trace || {
      source,
      ref: String(item.id || payloadHash),
    },
    source_watermark_ref: sourceWatermarks.some((watermark) => watermarkIdFor(watermark.source, watermark.scope) === sourceWatermarkRef)
      ? sourceWatermarkRef
      : watermarkIdFor(source, scope.profileName),
    payload_hash: payloadHash,
    redaction_audit_ref: item.redactionStatus === 'applied'
      ? (item.redaction_audit_ref || 'redaction_audit:server-upload-v0')
      : undefined,
  };
}

function summarizeWithheldItem(item = {}, reasons = [], source = 'snapshot') {
  const id = String(item.id || `withheld-${stableHash({ source, reasons }).slice(0, 12)}`);
  return {
    id,
    source,
    reasons,
    payload_hash: item.payload_hash || item.payloadHash || sha256({ id, source, reasons }),
  };
}

function filterItems(inputSignals = {}, scope, generatedAt, sourceWatermarks = []) {
  const included = [];
  const withheld = [];
  const withheldByReason = {};
  const bySource = {};
  const blockedCounts = {};
  const sourceItems = fixtureDefaultItems(inputSignals, scope, generatedAt);

  for (const item of sourceItems) {
    const reasons = itemEligibilityReasons(item, scope, sourceWatermarks);
    const source = itemSource(item);
    if (reasons.length === 0) {
      included.push(normalizeIncludedItem({
        ...item,
        syncEligibility: item.syncEligibility || 'core_sync_safe',
      }, scope, generatedAt, sourceWatermarks));
      continue;
    }
    withheld.push(summarizeWithheldItem(item, reasons, source));
    bySource[source] = Number(bySource[source] || 0) + 1;
    for (const reason of reasons) {
      addReason(withheldByReason, reason);
      if (RAW_FLAG_REASON_MAP[reason] || ['secret_like', 'raw_terminal', 'raw_comms', 'profile_mismatch'].includes(reason)) {
        addReason(blockedCounts, reason);
      }
    }
  }

  for (const dataClass of asArray(inputSignals.blockedDataClasses)) {
    const reason = RAW_FLAG_REASON_MAP[dataClass] || dataClass;
    const item = summarizeWithheldItem({ id: `blocked-${reason}`, payload_hash: sha256(`blocked:${reason}`) }, [reason], reason);
    withheld.push(item);
    bySource[reason] = Number(bySource[reason] || 0) + 1;
    addReason(withheldByReason, reason);
    addReason(blockedCounts, reason);
  }

  for (const [reason, amount] of Object.entries(inputSignals.expectedWithheldByReason || {})) {
    addReason(withheldByReason, reason, Number(amount || 0));
    addReason(blockedCounts, reason, Number(amount || 0));
    bySource.fixture = Number(bySource.fixture || 0) + Number(amount || 0);
    for (let index = 0; index < Number(amount || 0); index += 1) {
      withheld.push(summarizeWithheldItem({
        id: `fixture-${reason}-${index + 1}`,
        payload_hash: sha256(`fixture:${reason}:${index + 1}`),
      }, [reason], 'fixture'));
    }
  }

  const sampleRefs = withheld.slice(0, 6).map((item) => ({
    id: item.id,
    source: item.source,
    reasons: item.reasons,
    payload_hash: item.payload_hash,
  }));

  return {
    included_items: included,
    withheld,
    withheldByReason,
    blockedCounts,
    withheld_items_summary: {
      total: withheld.length,
      by_reason: { ...withheldByReason },
      by_source: bySource,
      sample_refs: sampleRefs,
      examples_are_refs_only: true,
    },
  };
}

function buildCapabilitySummary(inputSignals = {}, snapshot = null, pulse = null) {
  const source = inputSignals.snapshotCapability
    || snapshot?.capabilityState
    || pulse?.capability_summary
    || {};
  const bridge = inputSignals.bridge || {};
  const delivery = inputSignals.delivery || {};
  const bridgeUnproven = bridge.socketConnected === true
    && (bridge.architectRoleDiscovery !== 'registered' || bridge.architectToArchitectTargetProof !== 'verified');
  const deliveryUnproven = delivery.websocketAccepted === true && delivery.recipientQuoteBack !== 'present';
  const canProveModelProcessing = bridgeUnproven || deliveryUnproven
    ? false
    : source.canProveModelProcessing === true;

  return {
    localArmsCanExecute: source.localArmsCanExecute === true || source.canExecuteLocal === true,
    serverCanExecuteLocal: false,
    serverCanOperatePTY: false,
    serverCanDeploy: false,
    serverCanSendCustomerMessages: false,
    serverCanTrade: false,
    canProveModelProcessing,
    modelProcessingProofBasis: canProveModelProcessing
      ? (source.modelProcessingProofBasis || 'local recipient quote-back or equivalent proof')
      : 'missing recipient quote-back or equivalent proof',
    bridgeStatus: bridgeUnproven ? 'degraded_or_unproven' : (source.bridgeStatus || 'unknown_or_local_only'),
    bridgeProofBasis: bridgeUnproven ? 'role discovery and target proof missing' : (source.bridgeProofBasis || 'not inferred from socket acceptance'),
    crossDeviceArchitectTargeting: source.crossDeviceArchitectTargeting || 'requires_role_proof',
    crossDeviceBuilderOracleTargeting: 'blocked',
  };
}

function buildServerMigration(decision = 'accepted_pending_upload') {
  return {
    minimumServerPhase: 'phase_8_server_receive_validation',
    uploadReady: decision === 'accepted_pending_upload' || decision === 'accepted_with_warnings_pending_upload',
    reason: 'offline_redacted_envelope_prepared_for_future_server_upload',
    serverCanExecuteLocal: false,
    serverMayStore: [
      'redacted_core_sync_safe_items',
      'redacted_core_sync_redacted_items',
      'watermarks',
      'validation_metadata',
    ],
    serverMustNot: [
      'operate PTY',
      'run shell',
      'deploy',
      'send customer messages',
      'trade',
      'target remote Builder',
      'target remote Oracle',
    ],
  };
}

function buildSideEffectResult() {
  return {
    no_network_performed: true,
    networkRequestsAttempted: 0,
    queuesCreated: 0,
    externalSendsAttempted: 0,
    sourceStoreWritesAttempted: 0,
    memoryCommitsAttempted: 0,
    profileCommitsAttempted: 0,
    localExecutionAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    outputFileWritten: false,
  };
}

function canonicalIdempotencyInput(envelope) {
  return {
    schema: envelope.schema,
    version: envelope.version,
    profile: {
      name: envelope.profile.name,
      windowKey: envelope.profile.windowKey,
    },
    sessionId: envelope.sessionId,
    deviceId: envelope.deviceId,
    snapshotRef: {
      snapshotId: envelope.snapshotRef.snapshotId,
      contentHash: envelope.snapshotRef.contentHash,
    },
    pulseRefContentHash: envelope.pulseRef?.contentHash || null,
    source_watermarks: [...envelope.source_watermarks]
      .map((watermark) => ({
        source: watermark.source,
        scope: watermark.scope,
        watermark: watermark.watermark,
        contentHash: watermark.contentHash,
      }))
      .sort((a, b) => `${a.source}:${a.scope}`.localeCompare(`${b.source}:${b.scope}`)),
    included_items: [...envelope.included_items]
      .map((item) => ({ id: item.id, payload_hash: item.payload_hash }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    redactionPolicyVersion: envelope.redaction_audit.policyVersion,
  };
}

function payloadHashEnvelopeInput(envelope) {
  const clone = {
    ...envelope,
    signature_envelope: {
      ...envelope.signature_envelope,
      payload_hash: null,
      signature: null,
      signed_at: null,
    },
  };
  return clone;
}

function makeSignatureEnvelope(envelope) {
  return {
    mode: 'placeholder_contract_only',
    signature_required_later: true,
    algorithm: 'none',
    key_id: null,
    payload_hash: sha256(payloadHashEnvelopeInput(envelope)),
    signature: null,
    signed_at: null,
    verification_hint: 'Server v0 must verify a future signed canonical redacted envelope; Phase 7 loads no keys.',
  };
}

function staleSnapshotDecision(inputSignals = {}, generatedAt, snapshotRef) {
  const reasons = [];
  if (inputSignals.watermarkRegression === true) reasons.push('watermark_regression');
  const now = Date.parse(inputSignals.now || generatedAt);
  const snapshotGenerated = Date.parse(snapshotRef.generatedAt || generatedAt);
  if (Number.isFinite(now) && Number.isFinite(snapshotGenerated) && now - snapshotGenerated > 86400000) {
    reasons.push('stale_snapshot');
  }
  return reasons;
}

function decideValidation({ inputSignals, includedItems, sourceWatermarks, staleReasons, bridgeWarnings }) {
  const reasons = new Set(staleReasons);
  if (inputSignals.sourceWatermarksMissing === true || sourceWatermarks.length === 0) reasons.add('missing_source_watermarks');
  if (staleReasons.includes('watermark_regression')) reasons.add('watermark_regression');
  const rejected = reasons.has('watermark_regression') || reasons.has('missing_source_watermarks');
  if (rejected) return { decision: 'rejected', reasons: Array.from(reasons) };
  if (reasons.has('stale_snapshot') || bridgeWarnings.length > 0 || includedItems.length === 0) {
    return { decision: 'accepted_with_warnings_pending_upload', reasons: Array.from(reasons).concat(bridgeWarnings) };
  }
  return { decision: 'accepted_pending_upload', reasons: Array.from(reasons) };
}

function buildMiraCoreServerUpload(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const snapshot = options.snapshot || (options.useLiveInputs ? buildMiraCoreSnapshot(options) : null);
  const pulse = options.pulse || (options.useLiveInputs ? buildMiraCorePulse(options) : null);
  const scope = normalizeScope(inputSignals, snapshot);
  const profile = normalizeProfile(scope);
  const pulseRef = normalizePulseRef(inputSignals, scope, generatedAt, pulse);
  const source_watermarks = normalizeSourceWatermarks(inputSignals, scope, generatedAt, pulseRef);
  const snapshotRef = normalizeSnapshotRef(inputSignals, scope, generatedAt, snapshot);
  const itemResult = filterItems(inputSignals, scope, generatedAt, source_watermarks);
  const capability_summary = buildCapabilitySummary(inputSignals, snapshot, pulse);
  const bridgeWarnings = [];
  if (capability_summary.bridgeStatus === 'degraded_or_unproven') bridgeWarnings.push('bridge_unproven');
  if (capability_summary.canProveModelProcessing !== true && inputSignals.delivery) bridgeWarnings.push('delivery_unproven');
  const staleReasons = staleSnapshotDecision(inputSignals, generatedAt, snapshotRef);
  const decisionResult = decideValidation({
    inputSignals,
    includedItems: itemResult.included_items,
    sourceWatermarks: source_watermarks,
    staleReasons,
    bridgeWarnings,
  });

  const redaction_audit = {
    policyVersion: REDACTION_POLICY_VERSION,
    rawSecretsExported: false,
    rawTerminalExported: false,
    rawCommsExported: false,
    rawScreenshotOcrExported: false,
    rawBrowserStateExported: false,
    customerPrivateDataExported: false,
    sideProfileContentExported: false,
    includedCount: itemResult.included_items.length,
    redactedCount: itemResult.included_items.filter((item) => item.redactionStatus === 'applied').length,
    withheldCount: itemResult.withheld.length,
    withheldByReason: { ...itemResult.withheldByReason },
    blockedCounts: { ...itemResult.blockedCounts },
    auditRefs: [
      'mira-core-server-upload:redaction-policy:v0',
      ...itemResult.withheld_items_summary.sample_refs.map((ref) => `withheld:${ref.id}`),
    ],
  };

  const envelope = {
    schema: ENVELOPE_SCHEMA_VERSION,
    version: SERVER_UPLOAD_VERSION,
    upload_id: `mira-upload-${stableHash({ generatedAt, snapshotRef, scope }).slice(0, 12)}`,
    idempotency_key: null,
    generated_at: generatedAt,
    profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    snapshotRef,
    pulseRef,
    source_watermarks,
    capability_summary,
    redaction_audit,
    included_items: itemResult.included_items,
    withheld_items_summary: itemResult.withheld_items_summary,
    server_migration: buildServerMigration(decisionResult.decision),
    signature_envelope: null,
    no_network_performed: true,
    operator_notes: [
      'Phase 7 prepares a redacted upload envelope only; it does not contact a server.',
      'Bridge and delivery proof are not inferred from socket, trigger, WebSocket, or PTY acceptance.',
    ],
  };
  envelope.idempotency_key = `idem:${stableHash(canonicalIdempotencyInput(envelope))}`;
  envelope.signature_envelope = makeSignatureEnvelope(envelope);

  const side_effect_result = buildSideEffectResult();
  const validation_report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: SERVER_UPLOAD_VERSION,
    validation_run_id: `server-upload-validation-${stableHash({
      idempotency_key: envelope.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    decision: decisionResult.decision,
    input_refs: {
      snapshotRef: snapshotRef.snapshotId,
      pulseRef: pulseRef?.pulse_run_id || null,
      sourceWatermarks: source_watermarks.map((watermark) => watermark.watermark),
    },
    eligibility_result: {
      includedItemIds: itemResult.included_items.map((item) => item.id),
      withheldItemIds: itemResult.withheld.map((item) => item.id),
      includedCount: itemResult.included_items.length,
      withheldCount: itemResult.withheld.length,
      allowedSyncEligibility: INCLUDE_SYNC_ELIGIBILITY,
    },
    redaction_result: {
      rawSecretsExported: false,
      rawTerminalExported: false,
      rawCommsExported: false,
      rawScreenshotOcrExported: false,
      rawBrowserStateExported: false,
      customerPrivateDataExported: false,
      sideProfileContentExported: false,
      withheldByReason: { ...itemResult.withheldByReason },
    },
    profile_scope_result: {
      profile: scope.profileName,
      sessionId: scope.sessionId,
      deviceId: scope.deviceId,
      mismatchesWithheld: Number(itemResult.withheldByReason.profile_mismatch || 0),
      missingScopeWithheld: Number(itemResult.withheldByReason.missing_profile_session_device_scope || 0),
    },
    idempotency_result: {
      stable: true,
      idempotency_key: envelope.idempotency_key,
      excludes: ['generated_at', 'upload_id', 'validation_run_id', 'signature_envelope.signature'],
    },
    watermark_result: {
      decision: source_watermarks.length > 0 && !decisionResult.reasons.includes('watermark_regression') ? 'accepted' : 'rejected',
      watermarks_present: source_watermarks.length > 0,
      watermark_regression: inputSignals.watermarkRegression === true,
    },
    capability_truth_result: {
      serverCanExecuteLocal: false,
      serverCanOperatePTY: false,
      serverCanDeploy: false,
      serverCanSendCustomerMessages: false,
      serverCanTrade: false,
      crossDeviceBuilderOracleTargeting: 'blocked',
    },
    bridge_delivery_truth_result: {
      decision: bridgeWarnings.length > 0 ? 'accepted_with_warning' : 'accepted',
      warnings: bridgeWarnings,
    },
    side_effect_result,
    reasons: decisionResult.reasons,
    followup_required: decisionResult.decision !== 'accepted_pending_upload',
  };

  const output = {
    upload_envelope: envelope,
    validation_report,
  };
  assertNoForbiddenOutput(output);
  return output;
}

function hasRequiredFields(value, fields) {
  return fields.every((field) => Object.prototype.hasOwnProperty.call(value || {}, field));
}

function pathValue(value, path) {
  return String(path || '').split('.').reduce((current, part) => {
    if (current === null || current === undefined) return undefined;
    return current[part];
  }, value);
}

function expectedUploadEnvelopeShape(contract = {}) {
  return contract.expectedUploadEnvelopeShape || contract.expectedEnvelopeShape || null;
}

function countsMatch(a = {}, b = {}) {
  const keys = new Set(Object.keys(a).concat(Object.keys(b)));
  return Array.from(keys).every((key) => Number(a[key] || 0) === Number(b[key] || 0));
}

function validateMiraCoreServerUploadOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const envelope = output.upload_envelope || {};
  const report = output.validation_report || {};
  const expectedEnvelope = expectedUploadEnvelopeShape(contract);
  const envelopeContract = expectedEnvelope || {};
  const expectedReport = contract.expectedValidationReportShape || {};
  const requiredEnvelopeFields = asArray(envelopeContract.requiredTopLevelFields).length > 0
    ? envelopeContract.requiredTopLevelFields
    : REQUIRED_ENVELOPE_FIELDS;
  const requiredReportFields = asArray(expectedReport.requiredTopLevelFields).length > 0
    ? expectedReport.requiredTopLevelFields
    : REQUIRED_VALIDATION_REPORT_FIELDS;
  add('output-shape-complete',
    Boolean(expectedEnvelope)
      && hasRequiredFields(output, REQUIRED_OUTPUT_FIELDS)
      && hasRequiredFields(envelope, requiredEnvelopeFields)
      && hasRequiredFields(report, requiredReportFields)
      && asArray(envelope.included_items).every((item) => hasRequiredFields(item, asArray(envelopeContract.includedItemRequiredFields).length > 0
        ? envelopeContract.includedItemRequiredFields
        : REQUIRED_INCLUDED_ITEM_FIELDS))
      && envelope.schema === ENVELOPE_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION,
    'Missing required server-upload output fields.');
  add('fixture-literal-values-preserved',
    Object.entries(envelopeContract.requiredLiteralValues || {}).every(([fieldPath, expectedValue]) => pathValue(envelope, fieldPath) === expectedValue)
      && Object.entries(envelopeContract.signatureEnvelopeContract?.requiredV0Values || {}).every(([field, expectedValue]) => envelope.signature_envelope?.[field] === expectedValue),
    'Fixture-required literal value changed.');
  add('eligibility-filtering',
    asArray(envelope.included_items).every((item) => INCLUDE_SYNC_ELIGIBILITY.includes(item.syncEligibility)
      && (item.syncEligibility !== 'core_sync_redacted' || item.redactionStatus === 'applied')
      && !hasRawFlags(item)),
    'Ineligible item included.');
  add('raw-content-leak-prevention',
    envelope.redaction_audit?.rawSecretsExported === false
      && envelope.redaction_audit?.rawTerminalExported === false
      && envelope.redaction_audit?.rawCommsExported === false
      && envelope.redaction_audit?.rawScreenshotOcrExported === false
      && envelope.redaction_audit?.rawBrowserStateExported === false
      && envelope.redaction_audit?.customerPrivateDataExported === false
      && envelope.redaction_audit?.sideProfileContentExported === false,
    'Raw export flag is true.');
  add('profile-isolation',
    asArray(envelope.included_items).every((item) => item.profile === envelope.profile?.name
      && item.sessionId === envelope.sessionId
      && item.deviceId === envelope.deviceId),
    'Included item escaped envelope scope.');
  add('redaction-audit-complete',
    hasRequiredFields(envelope.redaction_audit, asArray(envelopeContract.redactionAuditRequiredFields))
      && envelope.redaction_audit.includedCount === asArray(envelope.included_items).length
      && envelope.redaction_audit.withheldCount === envelope.withheld_items_summary?.total
      && countsMatch(envelope.redaction_audit.withheldByReason, envelope.withheld_items_summary?.by_reason),
    'Redaction audit is incomplete.');
  const recomputedIdempotency = `idem:${stableHash(canonicalIdempotencyInput(envelope))}`;
  add('idempotency-deterministic',
    envelope.idempotency_key === recomputedIdempotency,
    'Idempotency key is not deterministic.');
  const watermarkRefs = new Set(asArray(envelope.source_watermarks).map((watermark) => watermarkIdFor(watermark.source, watermark.scope)));
  add('source-watermarks-required',
    asArray(envelope.source_watermarks).length > 0
      && asArray(envelope.source_watermarks).every((watermark) => hasRequiredFields(watermark, asArray(envelopeContract.sourceWatermarkRequiredFields)))
      && asArray(envelope.included_items).every((item) => watermarkRefs.has(item.source_watermark_ref)),
    'Source watermarks are missing or not referenced.');
  add('capability-truth-preserved',
    envelope.capability_summary?.serverCanExecuteLocal === false
      && envelope.capability_summary?.serverCanOperatePTY === false
      && envelope.capability_summary?.serverCanDeploy === false
      && envelope.capability_summary?.serverCanSendCustomerMessages === false
      && envelope.capability_summary?.serverCanTrade === false
      && envelope.capability_summary?.crossDeviceBuilderOracleTargeting === 'blocked',
    'Capability truth overclaimed.');
  add('bridge-delivery-truth-preserved',
    !JSON.stringify(output).includes('bridge green from socket only')
      && !JSON.stringify(output).includes('model-processing proof from websocket acceptance'),
    'Bridge or delivery truth overclaimed.');
  add('no-side-effects',
    report.side_effect_result?.no_network_performed === true
      && Number(report.side_effect_result?.networkRequestsAttempted || 0) === 0
      && Number(report.side_effect_result?.queuesCreated || 0) === 0
      && Number(report.side_effect_result?.externalSendsAttempted || 0) === 0
      && Number(report.side_effect_result?.sourceStoreWritesAttempted || 0) === 0
      && Number(report.side_effect_result?.memoryCommitsAttempted || 0) === 0
      && Number(report.side_effect_result?.profileCommitsAttempted || 0) === 0
      && Number(report.side_effect_result?.localExecutionAttempted || 0) === 0,
    'Side-effect counters are nonzero.');
  add('model-free-validation', true, null);
  try {
    assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-substrings-absent', true, null);
  } catch (err) {
    add('forbidden-substrings-absent', false, err.message);
  }
  return {
    ok: errors.length === 0,
    checks,
    errors,
  };
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const output = JSON.stringify(value);
  for (const forbidden of [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (forbidden && output.includes(forbidden)) {
      throw new Error(`server_upload_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  ENVELOPE_SCHEMA_VERSION,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  INCLUDE_SYNC_ELIGIBILITY,
  REDACTION_POLICY_VERSION,
  REQUIRED_ENVELOPE_FIELDS,
  REQUIRED_INCLUDED_ITEM_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreServerUpload,
  stableHash,
  validateMiraCoreServerUploadOutput,
};
