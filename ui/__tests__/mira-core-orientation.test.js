const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  FORBIDDEN_ACTIONS,
  ORIENTATION_SCHEMA_VERSION,
  buildMiraCoreOrientation,
  collectExportedItems,
} = require('../modules/mira-core/orientation');
const { coordPath } = require('../modules/mira-core/snapshot');
const { main, parseArgs } = require('../scripts/hm-mira-core-status');
const orientationContract = require('./fixtures/mira-core-orientation-contract.json');

function createDatabase(filePath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(filePath);
  } catch (_) {
    const BetterSqlite3 = require('better-sqlite3');
    return new BetterSqlite3(filePath);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function makeItem(id, overrides = {}) {
  return {
    id,
    kind: overrides.kind || 'memory_object',
    summary: overrides.summary || 'Short redacted summary',
    source: overrides.source || {
      store: 'team-memory',
      table: 'memory_objects',
      sourcePath: `team-memory:${id}`,
    },
    authority: overrides.authority || 'structured',
    syncEligibility: overrides.syncEligibility || 'core_sync_safe',
    redactionStatus: overrides.redactionStatus || 'none',
    profile: overrides.profile || 'main',
    sessionId: overrides.sessionId || 'app-session-test',
    deviceId: overrides.deviceId || 'VIGIL',
    confidence: Number(overrides.confidence ?? 0.8),
    evidenceRefs: overrides.evidenceRefs || [{
      store: 'evidence-ledger',
      eventId: id,
      relation: 'supports',
    }],
    ...overrides.extra,
  };
}

function makeSnapshot(overrides = {}) {
  return {
    schema: 'squidrun.mira_core.snapshot.v0',
    snapshotId: 'mira-snap-fixed',
    generatedAt: '2026-05-06T00:00:00.000Z',
    profile: {
      name: 'main',
      windowKey: 'main',
      sessionScopeId: 'app-session-test',
    },
    device: {
      deviceId: 'VIGIL',
      platform: 'win32',
      localOnly: true,
    },
    source: {
      sourceHealth: {
        appStatus: { state: 'ok', ok: true, path: '.squidrun/app-status.json', error: null },
        evidenceLedger: {
          state: 'ok',
          ok: true,
          path: '.squidrun/runtime/evidence-ledger.db',
          error: null,
          tables: {
            comms_journal: { exists: true, rowCount: 1 },
          },
        },
        teamMemory: { state: 'missing', ok: false, path: '.squidrun/runtime/team-memory.sqlite', error: null },
        cognitiveMemory: { state: 'missing', ok: false, path: '.squidrun/runtime/cognitive-memory.db', error: null },
      },
    },
    capabilityState: {
      canConverse: true,
      canQueueIntent: true,
      canRouteToArchitect: true,
      canRouteToBuilderOracle: true,
      canExecuteLocal: true,
      canProveModelProcessing: true,
      modelProcessingProofBasis: 'unknown',
      serverCanExecuteLocal: false,
      notes: [
        'WebSocket or PTY acceptance is not recipient model-processing proof.',
      ],
    },
    localArms: {
      architect: makeItem('arm-architect', {
        kind: 'local_arm',
        authority: 'runtime',
        extra: {
          role: 'architect',
          paneId: '1',
          routeStatus: 'ready',
          hiddenHostReady: true,
          modelProcessingProofRequired: true,
        },
      }),
      builder: makeItem('arm-builder', {
        kind: 'local_arm',
        authority: 'runtime',
        extra: {
          role: 'builder',
          paneId: '2',
          routeStatus: 'ready',
          hiddenHostReady: true,
          modelProcessingProofRequired: true,
        },
      }),
      oracle: makeItem('arm-oracle', {
        kind: 'local_arm',
        authority: 'runtime',
        extra: {
          role: 'oracle',
          paneId: '3',
          routeStatus: 'ready',
          hiddenHostReady: true,
          modelProcessingProofRequired: true,
        },
      }),
    },
    health: {
      app: { ok: true, sessionNumber: 333, hiddenPaneHost: 'ready' },
      supervisor: { ok: true, pendingTasks: 0, runningTasks: 0, blockedTasks: 0 },
      bridge: { ok: false, mode: 'connected', architectRoleDiscovery: 'unknown', targetProof: 'unverified' },
      memoryConsistency: { status: 'drift_detected', missing: 1, orphans: 2, duplicates: 0 },
    },
    memory: {
      canonical: {
        files: [makeItem('canonical-1', { kind: 'canonical_file', authority: 'canonical' })],
      },
      episodic: {
        ledgerWatermark: {
          lastRowId: 1,
          lastEventId: 'event-1',
          lastCommsMessageId: 'msg-1',
        },
        recentComms: [makeItem('comms-1', {
          kind: 'comms_ref',
          authority: 'evidence',
          syncEligibility: 'core_sync_redacted',
          redactionStatus: 'applied',
          summary: 'Full private Architect/James conversation body SECRET_TOKEN should not surface in orientation',
          extra: {
            rawBodyExported: false,
          },
        })],
      },
      structured: {
        claims: [makeItem('claim-1', { kind: 'claim' })],
        memoryObjects: [makeItem('memory-1', { syncEligibility: 'approval_required' })],
      },
      delivery: {
        recentInjections: [makeItem('injection-1', { kind: 'memory_injection', authority: 'delivery' })],
        handoffPackets: [],
        compactionSurvival: [],
      },
      recallFeedback: {
        resultSetCount: 1,
        feedbackCount: 1,
        topMissingSignals: [{ signal: 'route proof', count: 1 }],
      },
      derived: {
        cognitive: {
          nodeCount: 1,
          selectedNodes: [makeItem('cog-1', { kind: 'cognitive_node', authority: 'derived', syncEligibility: 'approval_required' })],
        },
      },
    },
    queue: {
      localSupervisor: { pending: 0, running: 0, blocked: 0 },
      coreIntentQueue: { enabled: false, pending: 0 },
    },
    redaction: {
      rawSecretsExported: false,
      rawTerminalExported: false,
      rawCommsExported: false,
      blockedCounts: {
        secretLike: 1,
        profileMismatch: 0,
        rawTranscript: 1,
      },
    },
    serverMigration: {
      uploadSafe: false,
      reason: 'local_snapshot_contract_first',
      minimumServerPhase: 'phase_1_snapshot_upload',
    },
    ...overrides,
  };
}

function createFixtureProject() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-orientation-'));
  fs.mkdirSync(path.join(tempDir, 'ui', 'modules'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '.squidrun', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'ui', 'package.json'), JSON.stringify({ version: '0.1.test' }));
  writeJson(coordPath(tempDir, 'app-status.json', 'main'), {
    session: 441,
    session_id: 'app-session-441',
    hiddenHostReady: true,
    deviceId: 'VIGIL',
  });
  writeJson(coordPath(tempDir, path.join('runtime', 'supervisor-status.json'), 'main'), {
    heartbeatAtMs: Date.parse('2026-05-06T00:00:00.000Z'),
    queue: { pending: 1, running: 0, blocked: 0 },
  });
  writeJson(coordPath(tempDir, path.join('runtime', 'bridge-status.json'), 'main'), {
    enabled: true,
    configured: true,
    state: 'connected',
    discoveredRoles: ['builder'],
  });

  const evidenceDb = createDatabase(coordPath(tempDir, path.join('runtime', 'evidence-ledger.db'), 'main'));
  evidenceDb.exec(`
    CREATE TABLE comms_journal (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT,
      session_id TEXT,
      raw_body TEXT,
      body_hash TEXT,
      status TEXT,
      brokered_at_ms INTEGER
    );
    INSERT INTO comms_journal (message_id, session_id, raw_body, body_hash, status, brokered_at_ms)
    VALUES ('msg-1', 'app-session-441', 'raw private comms should not orient', 'hash-1', 'acked', 1778025600000);
  `);
  evidenceDb.close();
  return tempDir;
}

describe('mira core orientation v0', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    jest.restoreAllMocks();
  });

  test('builds read-only local orientation from a snapshot without raw comms', () => {
    const orientation = buildMiraCoreOrientation({ snapshot: makeSnapshot() });

    expect(orientation.schema).toBe(ORIENTATION_SCHEMA_VERSION);
    expect(orientation.snapshotId).toBe('mira-snap-fixed');
    expect(orientation.generatedAt).toBe('2026-05-06T00:00:00.000Z');
    expect(orientation.source).toEqual(expect.objectContaining({
      builtFrom: 'buildMiraCoreSnapshot',
      networkUsed: false,
      serverUploadAttempted: false,
      queueExecutionAttempted: false,
      sourceWritesAttempted: false,
      rawCommsIncluded: false,
    }));
    expect(orientation.capabilitySummary).toEqual(expect.objectContaining({
      canExecuteLocal: true,
      canProveModelProcessing: false,
      modelProcessingProofBasis: 'missing',
      serverCanExecuteLocal: false,
      serverUploadSafe: false,
      coreIntentQueueEnabled: false,
    }));
    expect(orientation.serverMigration.uploadSafe).toBe(false);
    expect(orientation.snapshotRef).toEqual(expect.objectContaining({
      snapshotId: 'mira-snap-fixed',
      generatedAt: '2026-05-06T00:00:00.000Z',
      schema: 'squidrun.mira_core.snapshot.v0',
    }));
    expect(orientation.boundarySummary.statements).toEqual(expect.arrayContaining([
      'Local arms can execute local work.',
      'Server/Core cannot execute local work in v0.',
    ]));
    expect(orientation.healthSummary).toEqual(expect.objectContaining({
      bridgeStatus: 'uncertain_or_degraded',
      memoryConsistencyStatus: 'drift_detected',
      syncConfidence: 'reduced',
    }));
    expect(orientation.operatorNotes).toEqual(expect.arrayContaining([
      'Bridge is not green from socket connection alone.',
      'Architect role discovery and target proof are missing or unknown.',
      'Memory drift is present.',
      'Broad memory sync should stay cautious until drift is reviewed.',
      'Some content was blocked or redacted.',
      'Blocked raw content is not reconstructed in orientation.',
    ]));
    expect(orientation.localArmsTruth.builder).toEqual(expect.objectContaining({
      role: 'builder',
      paneId: '2',
      routeStatus: 'ready',
      modelProcessingProofRequired: true,
      canExecuteOnlyOnLocalDevice: true,
      serverTargetAllowed: false,
    }));
    expect(orientation.memoryHealthSummary.memory).toEqual(expect.objectContaining({
      recentCommsCount: 1,
      claimCount: 1,
      memoryObjectCount: 1,
      cognitiveNodeCount: 1,
    }));
    expect(orientation.redactionSyncTruth).toEqual(expect.objectContaining({
      rawSecretsExported: false,
      rawTerminalExported: false,
      rawCommsExported: false,
      rawLeakDetected: false,
      allItemsHaveMetadata: true,
      uploadSafe: false,
      safeForServerUploadInV0: false,
    }));
    expect(orientation.redactionSyncTruth.syncEligibilityCounts).toEqual(expect.objectContaining({
      core_sync_redacted: 1,
      approval_required: 2,
    }));
    expect(orientation.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bridge_not_green' }),
      expect.objectContaining({ id: 'memory_consistency_attention' }),
      expect.objectContaining({ id: 'server_upload_disabled_v0' }),
    ]));
    expect(orientation.nextSafeActions.map((action) => action.actionId)).toEqual(expect.arrayContaining([
      'bridge-readonly-proof-check',
      'memory-consistency-review',
      'prepare-risk-report',
      'draft-non-sent-message',
    ]));
    expect(JSON.stringify(orientation)).not.toContain('Full private Architect/James conversation body');
    expect(JSON.stringify(orientation)).not.toContain('SECRET_TOKEN');
  });

  test('does not treat delivery ack or unknown basis as model-processing proof', () => {
    const orientation = buildMiraCoreOrientation({
      snapshot: makeSnapshot({
        capabilityState: {
          ...makeSnapshot().capabilityState,
          canProveModelProcessing: true,
          modelProcessingProofBasis: 'delivery_ack',
          notes: [
            'accepted.daemon_pty_unverified is delivery acceptance only.',
          ],
        },
      }),
    });

    expect(orientation.capabilitySummary).toEqual(expect.objectContaining({
      canProveModelProcessing: false,
      modelProcessingProofBasis: 'missing',
    }));
    expect(orientation.boundarySummary).toEqual(expect.objectContaining({
      canProveModelProcessing: false,
      modelProcessingProofBasis: 'missing',
    }));
    expect(JSON.stringify(orientation)).not.toContain('"modelProcessingProofBasis":"unknown"');
  });

  test('exposes explicit forbidden actions and safe next actions as read-only only', () => {
    const orientation = buildMiraCoreOrientation({ snapshot: makeSnapshot() });
    const forbiddenIds = orientation.forbiddenActions.map((action) => action.id);

    for (const action of FORBIDDEN_ACTIONS) {
      expect(forbiddenIds).toContain(action.id);
    }
    expect(forbiddenIds).toEqual(expect.arrayContaining([
      'network_upload',
      'server_queue_execution',
      'remote_execution',
      'source_db_write',
      'external_send',
      'raw_comms_export',
      'financial_or_irreversible_action',
    ]));
    for (const action of orientation.forbiddenActions) {
      expect(action.allowedInV0).toBe(false);
    }
    for (const action of orientation.nextSafeActions) {
      expect(['tier0_read_only', 'tier1_local_reversible']).toContain(action.riskTier);
      expect(action.allowed).toBe(true);
      expect(action).toEqual(expect.objectContaining({
        actionId: expect.any(String),
        label: expect.any(String),
        requiresLocalArm: expect.any(Boolean),
        whySafe: expect.any(String),
        evidenceRefs: expect.any(Array),
      }));
    }
    expect(orientation.riskSummary.forbiddenRiskTiersForNextSafeActionsPresent).toBe(false);
    expect(orientation.nextSafeActions.map((action) => action.actionId)).toEqual(expect.arrayContaining([
      'print-orientation-status',
      'snapshot-readonly-refresh',
      'source-health-review',
      'redaction-sync-review',
      'bridge-readonly-proof-check',
      'memory-consistency-review',
      'redaction-audit-review',
    ]));
    expect(orientation.blockedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'production-deploy', riskTier: 'tier3_external_side_effect' }),
      expect.objectContaining({ actionId: 'customer-send', riskTier: 'tier3_external_side_effect' }),
      expect.objectContaining({ actionId: 'financial-trade', riskTier: 'tier4_financial_or_irreversible' }),
    ]));
  });

  test('detects invalid snapshot truth without enabling server execution or upload', () => {
    const snapshot = makeSnapshot({
      capabilityState: {
        ...makeSnapshot().capabilityState,
        serverCanExecuteLocal: true,
      },
      redaction: {
        ...makeSnapshot().redaction,
        rawCommsExported: true,
      },
      serverMigration: {
        uploadSafe: true,
        reason: 'bad_fixture',
        minimumServerPhase: 'phase_1_snapshot_upload',
      },
      memory: {
        ...makeSnapshot().memory,
        structured: {
          claims: [{ id: 'missing-metadata' }],
          memoryObjects: [],
        },
      },
    });

    const orientation = buildMiraCoreOrientation({ snapshot });

    expect(orientation.capabilitySummary.serverCanExecuteLocal).toBe(false);
    expect(orientation.capabilitySummary.serverUploadSafe).toBe(false);
    expect(orientation.serverMigration.uploadSafe).toBe(false);
    expect(orientation.redactionSyncTruth.rawLeakDetected).toBe(true);
    expect(orientation.redactionSyncTruth.allItemsHaveMetadata).toBe(false);
    expect(orientation.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'server_execution_claim_invalid', severity: 'critical' }),
      expect.objectContaining({ id: 'server_upload_claim_invalid', severity: 'critical' }),
      expect.objectContaining({ id: 'raw_export_leak', severity: 'critical' }),
      expect.objectContaining({ id: 'exported_item_metadata_missing', severity: 'critical' }),
    ]));
  });

  test('satisfies Oracle orientation contract shape and key acceptance checks', () => {
    const orientation = buildMiraCoreOrientation({ snapshot: makeSnapshot() });
    const shape = orientationContract.expectedOrientationShape;
    const acceptanceIds = orientationContract.acceptanceChecks.map((check) => check.id);

    expect(acceptanceIds).toEqual(expect.arrayContaining([
      'healthy-local-arms-server-boundary',
      'bridge-socket-without-role-proof',
      'memory-drift-visible',
      'redaction-blocks-visible-no-raw-content',
      'raw-comms-not-exposed-in-orientation',
      'high-risk-actions-forbidden',
      'false-memory-candidate-stays-cautious',
      'offline-local-arms-still-useful',
      'orientation-usefulness-degraded-system',
    ]));

    expect(orientation.schema).toBe(shape.schema);
    for (const field of shape.requiredTopLevelFields) {
      expect(orientation).toHaveProperty(field);
    }
    for (const field of shape.capabilitySummaryRequiredFields) {
      expect(orientation.capabilitySummary).toHaveProperty(field);
    }
    expect(orientationContract.orientationRules.find((rule) => rule.id === 'model-processing-proof-is-distinct').requiredProofBasisValues)
      .toContain(orientation.capabilitySummary.modelProcessingProofBasis);

    for (const action of orientation.nextSafeActions) {
      for (const field of shape.nextSafeActionRequiredFields) {
        expect(action).toHaveProperty(field);
      }
      expect(shape.allowedRiskTiersForNextSafeActionsV0).toContain(action.riskTier);
      expect(shape.forbiddenRiskTiersForNextSafeActionsV0).not.toContain(action.riskTier);
    }
    for (const action of orientation.blockedActions) {
      for (const field of shape.blockedActionRequiredFields) {
        expect(action).toHaveProperty(field);
      }
    }

    const healthyBoundary = orientationContract.acceptanceChecks.find((check) => check.id === 'healthy-local-arms-server-boundary');
    expect(orientation.capabilitySummary).toEqual(expect.objectContaining(healthyBoundary.expectedOrientation.capabilitySummary));
    expect(orientation.boundarySummary.statements).toEqual(expect.arrayContaining(healthyBoundary.expectedOrientation.boundarySummaryMustInclude));
    for (const substring of healthyBoundary.expectedOrientation.forbiddenSubstrings) {
      expect(JSON.stringify(orientation).toLowerCase()).not.toContain(substring.toLowerCase());
    }

    const bridgeCheck = orientationContract.acceptanceChecks.find((check) => check.id === 'bridge-socket-without-role-proof');
    expect(orientation.healthSummary.bridgeStatus).toBe(bridgeCheck.expectedOrientation.healthSummary.bridgeStatus);
    expect(orientation.operatorNotes).toEqual(expect.arrayContaining(bridgeCheck.expectedOrientation.operatorNotesMustInclude));
    for (const expectedAction of bridgeCheck.expectedOrientation.nextSafeActionsMustInclude) {
      expect(orientation.nextSafeActions).toEqual(expect.arrayContaining([
        expect.objectContaining(expectedAction),
      ]));
    }

    const driftCheck = orientationContract.acceptanceChecks.find((check) => check.id === 'memory-drift-visible');
    expect(orientation.healthSummary).toEqual(expect.objectContaining(driftCheck.expectedOrientation.healthSummary));
    expect(orientation.operatorNotes).toEqual(expect.arrayContaining(driftCheck.expectedOrientation.operatorNotesMustInclude));
    expect(orientation.nextSafeActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionId: 'memory-consistency-review',
        riskTier: 'tier0_read_only',
        allowed: true,
      }),
    ]));

    const redactionCheck = orientationContract.acceptanceChecks.find((check) => check.id === 'redaction-blocks-visible-no-raw-content');
    expect(orientation.redactionSummary).toEqual(expect.objectContaining({
      rawSecretsExported: redactionCheck.expectedOrientation.redactionSummary.rawSecretsExported,
      rawTerminalExported: redactionCheck.expectedOrientation.redactionSummary.rawTerminalExported,
      rawCommsExported: redactionCheck.expectedOrientation.redactionSummary.rawCommsExported,
      blockedCountsVisible: redactionCheck.expectedOrientation.redactionSummary.blockedCountsVisible,
    }));
    expect(orientation.operatorNotes).toEqual(expect.arrayContaining(redactionCheck.expectedOrientation.operatorNotesMustInclude));
    for (const substring of redactionCheck.expectedOrientation.forbiddenSubstrings) {
      expect(JSON.stringify(orientation)).not.toContain(substring);
    }

    const highRiskCheck = orientationContract.acceptanceChecks.find((check) => check.id === 'high-risk-actions-forbidden');
    for (const expectedAction of highRiskCheck.expectedOrientation.blockedActionsMustInclude) {
      expect(orientation.blockedActions).toEqual(expect.arrayContaining([
        expect.objectContaining(expectedAction),
      ]));
    }
    for (const expectedAction of highRiskCheck.expectedOrientation.nextSafeActionsMayInclude) {
      expect(orientation.nextSafeActions).toEqual(expect.arrayContaining([
        expect.objectContaining(expectedAction),
      ]));
    }
    for (const substring of highRiskCheck.expectedOrientation.forbiddenSubstrings) {
      expect(JSON.stringify(orientation).toLowerCase()).not.toContain(substring.toLowerCase());
    }
  });

  test('applies Oracle offline-arms contract with Tier 0 queue-safe status action', () => {
    const offlineCheck = orientationContract.acceptanceChecks.find((check) => check.id === 'offline-local-arms-still-useful');
    const snapshot = makeSnapshot({
      capabilityState: {
        canConverse: true,
        canQueueIntent: true,
        canRouteToArchitect: false,
        canRouteToBuilderOracle: false,
        canExecuteLocal: false,
        canProveModelProcessing: false,
        serverCanExecuteLocal: false,
        notes: [],
      },
      localArms: {
        architect: { role: 'architect', paneId: '1', routeStatus: 'offline', modelProcessingProofRequired: true },
        builder: { role: 'builder', paneId: '2', routeStatus: 'offline', modelProcessingProofRequired: true },
        oracle: { role: 'oracle', paneId: '3', routeStatus: 'offline', modelProcessingProofRequired: true },
      },
    });

    const orientation = buildMiraCoreOrientation({ snapshot });

    expect(orientation.capabilitySummary).toEqual(expect.objectContaining(offlineCheck.expectedOrientation.capabilitySummary));
    expect(orientation.nextSafeActions).toEqual(expect.arrayContaining([
      expect.objectContaining(offlineCheck.expectedOrientation.nextSafeActionsMustInclude[0]),
    ]));
    expect(orientation.blockedActions).toEqual(expect.arrayContaining([
      expect.objectContaining(offlineCheck.expectedOrientation.blockedActionsMustInclude[0]),
    ]));
    expect(orientation.operatorNotes).toEqual(expect.arrayContaining(offlineCheck.expectedOrientation.operatorNotesMustInclude));
    expect(orientation.serverMigration.uploadSafe).toBe(false);
  });

  test('keeps superseded or low-confidence memories out of current-truth orientation prose', () => {
    const falseMemoryCheck = orientationContract.acceptanceChecks.find((check) => check.id === 'false-memory-candidate-stays-cautious');
    const snapshot = makeSnapshot({
      memory: {
        ...makeSnapshot().memory,
        structured: {
          claims: [makeItem('claim-phil-476-old', {
            kind: 'claim',
            authority: 'derived',
            confidence: 0.2,
            summary: 'Phil invoice #476 is unpaid.',
            extra: {
              status: 'superseded',
            },
          })],
          memoryObjects: [],
        },
      },
    });

    const orientation = buildMiraCoreOrientation({ snapshot });
    const output = JSON.stringify(orientation);

    expect(orientation.memorySummary.caution.notes).toEqual(expect.arrayContaining(falseMemoryCheck.expectedOrientation.memorySummaryMustInclude));
    for (const substring of falseMemoryCheck.expectedOrientation.forbiddenSubstrings) {
      expect(output).not.toContain(substring);
    }
    expect(orientation.nextSafeActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionId: 'prepare-risk-report',
        riskTier: 'tier0_read_only',
        allowed: true,
      }),
    ]));
  });

  test('can consume buildMiraCoreSnapshot against local fixture and keeps database read-only', () => {
    tempDir = createFixtureProject();
    const evidencePath = coordPath(tempDir, path.join('runtime', 'evidence-ledger.db'), 'main');
    const before = fs.statSync(evidencePath);

    const orientation = buildMiraCoreOrientation({
      projectRoot: tempDir,
      profileName: 'main',
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
      deviceId: 'VIGIL',
    });

    const after = fs.statSync(evidencePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(orientation.schema).toBe(ORIENTATION_SCHEMA_VERSION);
    expect(orientation.snapshotSchema).toBe('squidrun.mira_core.snapshot.v0');
    expect(orientation.snapshotRef.schema).toBe('squidrun.mira_core.snapshot.v0');
    expect(orientation.profile.sessionScopeId).toBe('app-session-441');
    expect(orientation.memoryHealthSummary.memory.recentCommsCount).toBe(1);
    expect(orientation.redactionSyncTruth.rawCommsExported).toBe(false);
    expect(orientation.capabilitySummary.serverCanExecuteLocal).toBe(false);
    expect(orientation.serverMigration.uploadSafe).toBe(false);
    expect(JSON.stringify(orientation)).not.toContain('raw private comms should not orient');
  });

  test('CLI prints orientation JSON to stdout and has no output-file mode', () => {
    tempDir = createFixtureProject();
    expect(parseArgs([
      '--project-root',
      tempDir,
      '--profile=main',
      '--pretty',
    ])).toEqual({
      projectRoot: tempDir,
      profileName: 'main',
      pretty: true,
    });

    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const orientation = main(['--project-root', tempDir, '--profile', 'main']);

    expect(orientation.schema).toBe(ORIENTATION_SCHEMA_VERSION);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.schema).toBe(ORIENTATION_SCHEMA_VERSION);
    expect(printed.source.networkUsed).toBe(false);
    expect(printed.source.queueExecutionAttempted).toBe(false);
    expect(printed.serverMigration.uploadSafe).toBe(false);
    expect(printed.nextSafeActions.every((action) => action.allowed === true)).toBe(true);
  });

  test('collectExportedItems covers memory and local-arm item surfaces', () => {
    const snapshot = makeSnapshot();
    const items = collectExportedItems(snapshot);
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining([
      'canonical-1',
      'comms-1',
      'claim-1',
      'memory-1',
      'injection-1',
      'cog-1',
      'arm-architect',
      'arm-builder',
      'arm-oracle',
    ]));
  });
});
