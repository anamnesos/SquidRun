'use strict';

const {
  buildMiraCoreSnapshot,
} = require('./snapshot');

const ORIENTATION_SCHEMA_VERSION = 'squidrun.mira_core.orientation.v0';

const REQUIRED_EXPORTED_ITEM_FIELDS = Object.freeze([
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
  'confidence',
  'evidenceRefs',
]);

const FORBIDDEN_ACTIONS = Object.freeze([
  Object.freeze({
    id: 'network_upload',
    label: 'Upload snapshot or orientation data to a server',
    riskTier: 'tier3_external_side_effect',
    allowedInV0: false,
    reason: 'Phase 2 is local read-only status only.',
  }),
  Object.freeze({
    id: 'server_queue_execution',
    label: 'Create or execute a server intent queue item',
    riskTier: 'tier3_external_side_effect',
    allowedInV0: false,
    reason: 'Core loop v0 has no queue execution path.',
  }),
  Object.freeze({
    id: 'remote_execution',
    label: 'Run local shell, PTY, browser, git, deploy, or file actions from Core',
    riskTier: 'tier2_repo_mutation',
    allowedInV0: false,
    reason: 'Only local arms may execute; orientation only reports capability.',
  }),
  Object.freeze({
    id: 'source_db_write',
    label: 'Write Evidence Ledger, Team Memory, Cognitive Memory, supervisor, settings, or source files',
    riskTier: 'tier2_repo_mutation',
    allowedInV0: false,
    reason: 'Orientation consumes Snapshot v0 and never mutates source stores.',
  }),
  Object.freeze({
    id: 'external_send',
    label: 'Send Telegram, SMS, email, customer, voice, deploy, webhook, or financial actions',
    riskTier: 'tier3_external_side_effect',
    allowedInV0: false,
    reason: 'External side effects require later risk gates and local-arm acceptance.',
  }),
  Object.freeze({
    id: 'raw_comms_export',
    label: 'Export raw comms bodies, raw terminal scrollback, screenshots, auth files, browser state, or secrets',
    riskTier: 'tier3_external_side_effect',
    allowedInV0: false,
    reason: 'Orientation exports counts and truth flags only, never raw local context.',
  }),
  Object.freeze({
    id: 'financial_or_irreversible_action',
    label: 'Trade, move money, delete data destructively, or perform irreversible production changes',
    riskTier: 'tier4_financial_or_irreversible',
    allowedInV0: false,
    reason: 'Phase 2 is a read-only orientation surface.',
  }),
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = keyFn(value);
    if (!key) continue;
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return counts;
}

function collectExportedItems(snapshot = {}) {
  const memory = snapshot.memory || {};
  return [
    ...asArray(memory.canonical?.files),
    ...asArray(memory.episodic?.recentComms),
    ...asArray(memory.structured?.claims),
    ...asArray(memory.structured?.memoryObjects),
    ...asArray(memory.delivery?.recentInjections),
    ...asArray(memory.delivery?.handoffPackets),
    ...asArray(memory.delivery?.compactionSurvival),
    ...asArray(memory.derived?.cognitive?.selectedNodes),
    ...Object.values(snapshot.localArms || {}),
  ].filter(Boolean);
}

function hasRequiredItemMetadata(item) {
  if (!item || typeof item !== 'object') return false;
  return REQUIRED_EXPORTED_ITEM_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(item, field));
}

function summarizeLocalArms(snapshot = {}) {
  const arms = {};
  for (const [role, arm] of Object.entries(snapshot.localArms || {})) {
    arms[role] = {
      role: arm.role || role,
      paneId: arm.paneId || null,
      routeStatus: arm.routeStatus || 'unknown',
      hiddenHostReady: arm.hiddenHostReady === true,
      modelProcessingProofRequired: arm.modelProcessingProofRequired !== false,
      canExecuteOnlyOnLocalDevice: true,
      serverTargetAllowed: false,
      syncEligibility: arm.syncEligibility || 'core_sync_safe',
      evidenceRefCount: asArray(arm.evidenceRefs).length,
    };
  }
  return arms;
}

function summarizeSourceHealth(snapshot = {}) {
  const sourceHealth = snapshot.source?.sourceHealth || {};
  const sources = {};
  for (const [name, health] of Object.entries(sourceHealth)) {
    const tableCounts = {};
    if (health?.tables && typeof health.tables === 'object') {
      for (const [tableName, tableInfo] of Object.entries(health.tables)) {
        tableCounts[tableName] = {
          exists: tableInfo?.exists === true,
          rowCount: Number(tableInfo?.rowCount || 0),
        };
      }
    }
    sources[name] = {
      state: health?.state || (health?.ok === true ? 'ok' : 'unknown'),
      ok: health?.ok === true,
      path: health?.path || null,
      error: health?.error || null,
      tableCounts,
    };
  }
  const stateCounts = countBy(Object.values(sources), (entry) => entry.state || 'unknown');
  return {
    stateCounts,
    sources,
  };
}

function summarizeMemory(snapshot = {}) {
  const memory = snapshot.memory || {};
  const exportedItems = collectExportedItems(snapshot);
  const cautiousItems = exportedItems.filter((item) => {
    const status = String(item.status || item.lifecycleState || item.extra?.status || '').toLowerCase();
    const confidence = Number(item.confidence);
    return status === 'superseded'
      || status === 'contested'
      || status === 'rejected'
      || (Number.isFinite(confidence) && confidence < 0.5);
  });
  return {
    canonicalFileCount: asArray(memory.canonical?.files).length,
    recentCommsCount: asArray(memory.episodic?.recentComms).length,
    claimCount: asArray(memory.structured?.claims).length,
    memoryObjectCount: asArray(memory.structured?.memoryObjects).length,
    recentInjectionCount: asArray(memory.delivery?.recentInjections).length,
    handoffPacketCount: asArray(memory.delivery?.handoffPackets).length,
    compactionSurvivalCount: asArray(memory.delivery?.compactionSurvival).length,
    cognitiveNodeCount: Number(memory.derived?.cognitive?.nodeCount || 0),
    recallFeedback: {
      resultSetCount: Number(memory.recallFeedback?.resultSetCount || 0),
      feedbackCount: Number(memory.recallFeedback?.feedbackCount || 0),
      topMissingSignalCount: asArray(memory.recallFeedback?.topMissingSignals).length,
    },
    ledgerWatermark: {
      lastRowId: Number(memory.episodic?.ledgerWatermark?.lastRowId || 0),
      lastEventId: memory.episodic?.ledgerWatermark?.lastEventId || null,
      lastCommsMessageId: memory.episodic?.ledgerWatermark?.lastCommsMessageId || null,
    },
    caution: {
      supersededOrContestedCount: cautiousItems.length,
      notes: cautiousItems.length > 0
        ? ['Superseded or contested memory is not treated as current truth.']
        : [],
    },
  };
}

function buildCapabilitySummary(snapshot = {}) {
  const capability = snapshot.capabilityState || {};
  const queue = snapshot.queue || {};
  const serverMigration = snapshot.serverMigration || {};
  const localArmsCanExecute = capability.canExecuteLocal === true;
  return {
    status: capability.serverCanExecuteLocal === true
      ? 'invalid'
      : (capability.canRouteToArchitect === true ? 'local_ready' : 'degraded'),
    canConverse: capability.canConverse === true,
    canQueueIntent: capability.canQueueIntent === true,
    canRouteToArchitect: capability.canRouteToArchitect === true,
    canRouteToBuilderOracle: capability.canRouteToBuilderOracle === true,
    canExecuteLocal: localArmsCanExecute,
    localArmsCanExecute,
    canProveModelProcessing: capability.canProveModelProcessing === true,
    modelProcessingProofBasis: capability.canProveModelProcessing === true ? 'unknown' : 'missing',
    serverCanExecuteLocal: false,
    coreIntentQueueEnabled: queue.coreIntentQueue?.enabled === true,
    serverUploadSafe: false,
    uploadReason: serverMigration.reason || 'local_orientation_only',
    notes: asArray(capability.notes),
  };
}

function buildRedactionSyncTruth(snapshot = {}, exportedItems = []) {
  const redaction = snapshot.redaction || {};
  const serverMigration = snapshot.serverMigration || {};
  const rawSecretsExported = redaction.rawSecretsExported === true;
  const rawTerminalExported = redaction.rawTerminalExported === true;
  const rawCommsExported = redaction.rawCommsExported === true;
  const syncEligibilityCounts = countBy(exportedItems, (item) => item.syncEligibility || 'missing');
  const redactionStatusCounts = countBy(exportedItems, (item) => item.redactionStatus || 'missing');
  const metadataMissingCount = exportedItems.filter((item) => !hasRequiredItemMetadata(item)).length;
  return {
    rawSecretsExported,
    rawTerminalExported,
    rawCommsExported,
    rawLeakDetected: rawSecretsExported || rawTerminalExported || rawCommsExported,
    blockedCounts: {
      ...(redaction.blockedCounts || {}),
    },
    blockedCountsVisible: true,
    syncEligibilityCounts,
    redactionStatusCounts,
    exportedItemCount: exportedItems.length,
    metadataMissingCount,
    allItemsHaveMetadata: metadataMissingCount === 0,
    uploadSafe: false,
    snapshotUploadSafe: serverMigration.uploadSafe === true,
    safeForServerUploadInV0: false,
  };
}

function buildBoundarySummary(snapshot = {}, capabilitySummary = {}, localArmsTruth = {}) {
  const localArmsCanExecute = capabilitySummary.localArmsCanExecute === true;
  const statements = [
    localArmsCanExecute
      ? 'Local arms can execute local work.'
      : 'Local arms are offline or not routable.',
    'Server/Core cannot execute local work in v0.',
    'WebSocket, PTY, daemon, or trigger acceptance is not model-processing proof.',
  ];
  return {
    localArmsCanExecute,
    serverCanExecuteLocal: false,
    canProveModelProcessing: capabilitySummary.canProveModelProcessing === true,
    modelProcessingProofBasis: capabilitySummary.modelProcessingProofBasis,
    statements,
    localArms: localArmsTruth,
    bridgeRequiresRoleDiscoveryAndTargetProof: true,
    externalSideEffectsAllowed: false,
    queueExecutionAllowed: false,
    sourceWritesAllowed: false,
    rawCommsAllowed: false,
    snapshotEvidenceRefs: [{
      store: 'mira-core-snapshot',
      eventId: snapshot.snapshotId || 'unknown',
      relation: 'orientation_basis',
    }],
  };
}

function buildHealthSummary(snapshot = {}, sourceHealthSummary = {}) {
  const bridge = snapshot.health?.bridge || {};
  const memoryConsistency = snapshot.health?.memoryConsistency || {};
  const driftPresent = Boolean(memoryConsistency.status && memoryConsistency.status !== 'in_sync');
  const bridgeStatus = bridge.ok === true ? 'green' : 'uncertain_or_degraded';
  return {
    appOk: snapshot.health?.app?.ok === true,
    supervisorOk: snapshot.health?.supervisor?.ok === true,
    bridgeStatus,
    bridgeMode: bridge.mode || 'unknown',
    architectRoleDiscovery: bridge.architectRoleDiscovery || 'unknown',
    architectTargetProof: bridge.architectTargetProof || bridge.targetProof || 'unknown',
    memoryConsistencyStatus: memoryConsistency.status || 'unknown',
    memoryDrift: {
      present: driftPresent,
      missing: Number(memoryConsistency.missing || 0),
      orphans: Number(memoryConsistency.orphans || 0),
      duplicates: Number(memoryConsistency.duplicates || 0),
    },
    syncConfidence: driftPresent ? 'reduced' : 'normal',
    sourceStateCounts: sourceHealthSummary.stateCounts || {},
    degradedOrBlockedSources: Object.entries(sourceHealthSummary.sources || {})
      .filter(([, entry]) => entry.state === 'degraded' || entry.state === 'blocked')
      .map(([name]) => name),
    missingSources: Object.entries(sourceHealthSummary.sources || {})
      .filter(([, entry]) => entry.state === 'missing')
      .map(([name]) => name),
  };
}

function buildOperatorNotes(snapshot = {}, parts = {}) {
  const notes = [];
  const bridge = snapshot.health?.bridge || {};
  const memoryConsistency = snapshot.health?.memoryConsistency || {};
  const redaction = parts.redactionSyncTruth || {};
  const capability = parts.capabilitySummary || {};
  const memorySummary = parts.memorySummary || {};

  if (capability.localArmsCanExecute === true) {
    notes.push('Local arms can execute local work.');
  } else {
    notes.push('Mira can converse or queue intent, but cannot claim local execution until local arms reconnect.');
  }
  notes.push('Server/Core cannot execute local work in v0.');

  if (bridge.ok !== true) {
    notes.push('Bridge is not green from socket connection alone.');
    notes.push('Architect role discovery and target proof are missing or unknown.');
  }
  if (memoryConsistency.status && memoryConsistency.status !== 'in_sync') {
    notes.push('Memory drift is present.');
    notes.push('Broad memory sync should stay cautious until drift is reviewed.');
  }
  const blockedCounts = redaction.blockedCounts || {};
  if (Object.values(blockedCounts).some((count) => Number(count || 0) > 0)) {
    notes.push('Some content was blocked or redacted.');
    notes.push('Blocked raw content is not reconstructed in orientation.');
  }
  for (const note of asArray(memorySummary.caution?.notes)) {
    notes.push(note);
  }
  return Array.from(new Set(notes));
}

function buildBlockers(snapshot = {}, orientationParts = {}) {
  const blockers = [];
  const capability = orientationParts.capabilitySummary || {};
  const source = orientationParts.sourceHealthSummary || {};
  const redaction = orientationParts.redactionSyncTruth || {};
  const memoryConsistency = snapshot.health?.memoryConsistency || {};
  const bridge = snapshot.health?.bridge || {};

  const add = (id, severity, summary, sourcePath = null) => {
    blockers.push({ id, severity, summary, source: sourcePath });
  };

  if (capability.serverCanExecuteLocal === true || snapshot.capabilityState?.serverCanExecuteLocal === true) {
    add('server_execution_claim_invalid', 'critical', 'Server execution must remain false in orientation v0.', 'capabilityState.serverCanExecuteLocal');
  }
  if (snapshot.serverMigration?.uploadSafe === true) {
    add('server_upload_claim_invalid', 'critical', 'Server upload must remain unsafe in orientation v0.', 'serverMigration.uploadSafe');
  }
  if (redaction.rawLeakDetected) {
    add('raw_export_leak', 'critical', 'Snapshot reports a raw secret, terminal, or comms export.', 'redaction');
  }
  if (redaction.allItemsHaveMetadata !== true) {
    add('exported_item_metadata_missing', 'critical', 'One or more exported snapshot items lack required metadata.', 'memory');
  }
  if (bridge.ok !== true) {
    add('bridge_not_green', 'warn', 'Bridge is not green without architect role discovery plus target proof.', 'health.bridge');
  }
  if (
    memoryConsistency.status
    && memoryConsistency.status !== 'in_sync'
  ) {
    add('memory_consistency_attention', 'warn', `Memory consistency status is ${memoryConsistency.status}.`, 'health.memoryConsistency');
  }
  const badSourceNames = Object.entries(source.sources || {})
    .filter(([, entry]) => entry.state === 'degraded' || entry.state === 'blocked')
    .map(([name]) => name);
  if (badSourceNames.length > 0) {
    add('source_health_degraded', 'warn', `Degraded or blocked sources: ${badSourceNames.join(', ')}.`, 'source.sourceHealth');
  }
  const missingCoreSources = Object.entries(source.sources || {})
    .filter(([name, entry]) => ['appStatus', 'evidenceLedger', 'teamMemory', 'cognitiveMemory'].includes(name) && entry.state === 'missing')
    .map(([name]) => name);
  if (missingCoreSources.length > 0) {
    add('core_sources_missing', 'info', `Missing local sources: ${missingCoreSources.join(', ')}.`, 'source.sourceHealth');
  }
  for (const [role, arm] of Object.entries(orientationParts.localArmsTruth || {})) {
    if (arm.routeStatus !== 'ready') {
      add(`${role}_route_unproven`, 'info', `${role} route is ${arm.routeStatus}; model-processing proof still requires recipient evidence.`, `localArms.${role}`);
    }
  }
  add('server_upload_disabled_v0', 'info', 'Orientation v0 is local-only; server upload remains disabled and unsafe.', 'serverMigration');

  return blockers;
}

function makeNextSafeAction(actionId, label, options = {}) {
  return {
    actionId,
    label,
    riskTier: options.riskTier || 'tier0_read_only',
    allowed: true,
    requiresLocalArm: options.requiresLocalArm === true,
    requiresReview: options.requiresReview || 'none',
    whySafe: options.whySafe || 'Read-only orientation action; it does not mutate local sources or send externally.',
    evidenceRefs: options.evidenceRefs || [{
      store: 'mira-core-orientation',
      eventId: actionId,
      relation: 'safe_next_action',
    }],
  };
}

function buildSafeNextActions(snapshot = {}, orientationParts = {}) {
  const localArmsCanExecute = orientationParts.capabilitySummary?.localArmsCanExecute === true;
  const actions = [
    makeNextSafeAction('print-orientation-status', 'Print local Mira Core orientation status'),
    makeNextSafeAction('snapshot-readonly-refresh', 'Regenerate Snapshot v0 locally and re-render orientation'),
    makeNextSafeAction('source-health-review', 'Review missing, degraded, or blocked local source health'),
    makeNextSafeAction('redaction-sync-review', 'Review redaction counts, sync eligibility counts, and upload safety flags'),
    makeNextSafeAction('prepare-risk-report', 'Prepare a read-only risk report for blocked high-risk actions'),
    makeNextSafeAction('draft-non-sent-message', 'Draft a non-sent message for later local review', {
      riskTier: 'tier1_local_reversible',
      requiresLocalArm: localArmsCanExecute,
      requiresReview: 'architect',
      whySafe: 'Drafting without send is reversible and remains local; external delivery is still blocked.',
    }),
  ];

  if (snapshot.health?.bridge?.ok !== true) {
    actions.push(makeNextSafeAction('bridge-readonly-proof-check', 'Inspect bridge role discovery and target-proof evidence', {
      whySafe: 'Reads bridge evidence only; socket state is not treated as role-target proof.',
      evidenceRefs: [{ store: 'mira-core-snapshot', eventId: 'health.bridge', relation: 'check_truth' }],
    }));
  }
  if (snapshot.health?.memoryConsistency?.status && snapshot.health.memoryConsistency.status !== 'in_sync') {
    actions.push(makeNextSafeAction('memory-consistency-review', 'Prepare a read-only memory consistency report', {
      whySafe: 'Reviews drift counts and evidence only; broad memory sync remains cautious.',
      evidenceRefs: [{ store: 'mira-core-snapshot', eventId: 'health.memoryConsistency', relation: 'review_drift' }],
    }));
  }
  if ((orientationParts.redactionSyncTruth?.blockedCounts?.secretLike || 0) > 0) {
    actions.push(makeNextSafeAction('redaction-audit-review', 'Review redaction audit counts without opening raw source bodies', {
      whySafe: 'Uses aggregate redaction counts only and does not reconstruct blocked content.',
      evidenceRefs: [{ store: 'mira-core-snapshot', eventId: 'redaction.blockedCounts', relation: 'audit_counts' }],
    }));
  }
  if (!localArmsCanExecute && snapshot.capabilityState?.canQueueIntent === true) {
    actions.push(makeNextSafeAction('queue-tier0-status-request', 'Prepare a Tier 0 status request for local Architect on reconnect', {
      requiresLocalArm: false,
      whySafe: 'Queues only a read-only status intent; it does not execute local work while arms are offline.',
      evidenceRefs: [{ store: 'mira-core-snapshot', eventId: 'capabilityState.canQueueIntent', relation: 'offline_safe_intent' }],
    }));
  }

  return actions;
}

function makeBlockedAction(actionId, label, riskTier, blockedBecause, safeAlternative) {
  return {
    actionId,
    label,
    riskTier,
    blockedBecause,
    safeAlternative,
  };
}

function buildBlockedActions(snapshot = {}, orientationParts = {}) {
  const localArmsCanExecute = orientationParts.capabilitySummary?.localArmsCanExecute === true;
  const blocked = [
    makeBlockedAction(
      'server-upload',
      'Upload snapshot or orientation data to a server',
      'tier3_external_side_effect',
      'Server upload is unsafe and disabled in orientation v0.',
      'prepare-risk-report'
    ),
    makeBlockedAction(
      'server-queue-execution',
      'Execute a server intent queue item',
      'tier3_external_side_effect',
      'Orientation v0 has no server queue execution path.',
      'queue-tier0-status-request'
    ),
    makeBlockedAction(
      'source-db-write',
      'Write local source databases or settings',
      'tier2_repo_mutation',
      'Orientation is read-only over Snapshot v0.',
      'source-health-review'
    ),
    makeBlockedAction(
      'raw-comms-export',
      'Export raw comms, terminal scrollback, screenshots, browser state, or secrets',
      'tier3_external_side_effect',
      'Orientation exports counts and flags only.',
      'redaction-audit-review'
    ),
    makeBlockedAction(
      'production-deploy',
      'Deploy production',
      'tier3_external_side_effect',
      'Deploy is an external side effect and outside Snapshot/Orientation v0.',
      'prepare-risk-report'
    ),
    makeBlockedAction(
      'customer-send',
      'Send customer confirmation',
      'tier3_external_side_effect',
      'Customer-facing sends require explicit later gates and local-arm acceptance.',
      'draft-non-sent-message'
    ),
    makeBlockedAction(
      'financial-trade',
      'Place trade or financial action',
      'tier4_financial_or_irreversible',
      'Financial or irreversible actions are blocked unless a fresh explicit lane opens.',
      'prepare-risk-report'
    ),
  ];

  if (!localArmsCanExecute) {
    blocked.push(makeBlockedAction(
      'execute-local-work',
      'Execute local work',
      'tier2_repo_mutation',
      'Local arms are offline or not routable.',
      'queue-tier0-status-request'
    ));
  }

  return blocked;
}

function buildRiskSummary(nextSafeActions = [], blockedActions = []) {
  return {
    nextSafeActionCount: nextSafeActions.length,
    blockedActionCount: blockedActions.length,
    allowedNextSafeRiskTiers: Array.from(new Set(nextSafeActions.map((action) => action.riskTier))).sort(),
    highRiskActionsBlocked: blockedActions.some((action) => (
      action.riskTier === 'tier3_external_side_effect'
      || action.riskTier === 'tier4_financial_or_irreversible'
    )),
    forbiddenRiskTiersForNextSafeActionsPresent: nextSafeActions.some((action) => (
      action.riskTier === 'tier2_repo_mutation'
      || action.riskTier === 'tier3_external_side_effect'
      || action.riskTier === 'tier4_financial_or_irreversible'
    )),
  };
}

function buildMiraCoreOrientation(options = {}) {
  const snapshot = options.snapshot || buildMiraCoreSnapshot(options);
  const exportedItems = collectExportedItems(snapshot);
  const localArmsTruth = summarizeLocalArms(snapshot);
  const sourceHealthSummary = summarizeSourceHealth(snapshot);
  const memorySummary = summarizeMemory(snapshot);
  const capabilitySummary = buildCapabilitySummary(snapshot);
  const redactionSyncTruth = buildRedactionSyncTruth(snapshot, exportedItems);
  const boundarySummary = buildBoundarySummary(snapshot, capabilitySummary, localArmsTruth);
  const healthSummary = buildHealthSummary(snapshot, sourceHealthSummary);
  const orientationParts = {
    capabilitySummary,
    localArmsTruth,
    sourceHealthSummary,
    redactionSyncTruth,
    memorySummary,
  };
  const blockers = buildBlockers(snapshot, orientationParts);
  const nextSafeActions = buildSafeNextActions(snapshot, orientationParts);
  const blockedActions = buildBlockedActions(snapshot, orientationParts);
  const operatorNotes = buildOperatorNotes(snapshot, {
    capabilitySummary,
    redactionSyncTruth,
    memorySummary,
  });
  const riskSummary = buildRiskSummary(nextSafeActions, blockedActions);

  return {
    schema: ORIENTATION_SCHEMA_VERSION,
    orientationId: `mira-orient-${snapshot.snapshotId || 'unknown'}`,
    generatedAt: snapshot.generatedAt || new Date().toISOString(),
    snapshotId: snapshot.snapshotId || null,
    snapshotGeneratedAt: snapshot.generatedAt || null,
    snapshotSchema: snapshot.schema || null,
    snapshotRef: {
      snapshotId: snapshot.snapshotId || null,
      generatedAt: snapshot.generatedAt || null,
      schema: snapshot.schema || null,
    },
    profile: {
      name: snapshot.profile?.name || 'unknown',
      windowKey: snapshot.profile?.windowKey || snapshot.profile?.name || 'unknown',
      sessionScopeId: snapshot.profile?.sessionScopeId || 'unknown',
    },
    device: {
      deviceId: snapshot.device?.deviceId || 'unknown',
      platform: snapshot.device?.platform || process.platform,
      localOnly: true,
    },
    source: {
      builtFrom: 'buildMiraCoreSnapshot',
      networkUsed: false,
      serverUploadAttempted: false,
      queueExecutionAttempted: false,
      sourceWritesAttempted: false,
      rawCommsIncluded: false,
    },
    capabilitySummary,
    boundarySummary,
    localArmsTruth,
    healthSummary,
    memorySummary,
    redactionSummary: redactionSyncTruth,
    riskSummary,
    memoryHealthSummary: {
      memory: memorySummary,
      sourceHealth: sourceHealthSummary,
      app: {
        ok: snapshot.health?.app?.ok === true,
        sessionNumber: snapshot.health?.app?.sessionNumber || null,
        hiddenPaneHost: snapshot.health?.app?.hiddenPaneHost || 'unknown',
      },
      supervisor: {
        ok: snapshot.health?.supervisor?.ok === true,
        pendingTasks: Number(snapshot.health?.supervisor?.pendingTasks || 0),
        runningTasks: Number(snapshot.health?.supervisor?.runningTasks || 0),
        blockedTasks: Number(snapshot.health?.supervisor?.blockedTasks || 0),
      },
      bridge: {
        ok: snapshot.health?.bridge?.ok === true,
        mode: snapshot.health?.bridge?.mode || 'unknown',
        architectRoleDiscovery: snapshot.health?.bridge?.architectRoleDiscovery || 'unknown',
        targetProof: snapshot.health?.bridge?.targetProof || 'unverified',
      },
      memoryConsistency: {
        status: snapshot.health?.memoryConsistency?.status || 'unknown',
        missing: Number(snapshot.health?.memoryConsistency?.missing || 0),
        orphans: Number(snapshot.health?.memoryConsistency?.orphans || 0),
        duplicates: Number(snapshot.health?.memoryConsistency?.duplicates || 0),
      },
    },
    redactionSyncTruth,
    blockers,
    nextSafeActions,
    safeNextActions: nextSafeActions.map((action) => ({
      id: action.actionId,
      label: action.label,
      riskTier: action.riskTier,
      executes: false,
      requiresApproval: action.requiresReview !== 'none',
      ...action,
    })),
    blockedActions,
    operatorNotes,
    forbiddenActions: FORBIDDEN_ACTIONS.map((action) => ({ ...action })),
    serverMigration: {
      uploadSafe: false,
      reason: snapshot.serverMigration?.reason || 'local_orientation_only',
      minimumServerPhase: snapshot.serverMigration?.minimumServerPhase || 'phase_1_snapshot_upload',
    },
  };
}

module.exports = {
  FORBIDDEN_ACTIONS,
  ORIENTATION_SCHEMA_VERSION,
  REQUIRED_EXPORTED_ITEM_FIELDS,
  buildMiraCoreOrientation,
  collectExportedItems,
  hasRequiredItemMetadata,
};
