const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SCHEMA_VERSION,
  SYNC_ELIGIBILITY,
  buildMiraCoreSnapshot,
  classifyMiraCoreSnapshotCandidate,
  coordPath,
  redactText,
} = require('../modules/mira-core/snapshot');
const { parseArgs } = require('../scripts/hm-mira-core-snapshot');
const contractFixture = require('./fixtures/mira-core-snapshot-contract.json');

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

function createFixtureProject() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-core-'));
  fs.mkdirSync(path.join(tempDir, 'ui', 'modules'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'workspace', 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '.squidrun', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'ui', 'package.json'), JSON.stringify({
    name: 'squidrun-test',
    version: '9.9.9',
  }));
  fs.writeFileSync(path.join(tempDir, 'ROLES.md'), 'Builder implements. Architect coordinates.');
  fs.writeFileSync(
    path.join(tempDir, 'AGENTS.md'),
    'Agent memory should not export CUSTOMER: Jane Doe 555-222-3333 without redaction.'
  );
  fs.writeFileSync(path.join(tempDir, 'workspace', 'knowledge', 'ops.md'), 'Green requires quote-back proof.');

  writeJson(coordPath(tempDir, 'app-status.json', 'main'), {
    session: 328,
    session_id: 'app-session-328',
    version: '0.1.test',
    hiddenHostReady: true,
    deviceId: 'VIGIL',
  });
  writeJson(coordPath(tempDir, path.join('runtime', 'supervisor-status.json'), 'main'), {
    heartbeatAtMs: Date.parse('2026-05-06T00:00:00.000Z'),
    queue: {
      pending: 2,
      running: 1,
      blocked: 0,
    },
    workers: {
      total: 3,
    },
  });
  writeJson(coordPath(tempDir, path.join('runtime', 'system-capabilities.json'), 'main'), {
    localModels: {
      enabled: false,
    },
  });
  writeJson(coordPath(tempDir, path.join('runtime', 'memory-consistency.json'), 'main'), {
    status: 'drift_detected',
    synced: false,
    summary: {
      missingInCognitiveCount: 2,
      orphanedNodeCount: 4,
      duplicateKnowledgeHashCount: 0,
    },
  });
  writeJson(coordPath(tempDir, path.join('runtime', 'bridge-status.json'), 'main'), {
    enabled: true,
    configured: true,
    state: 'connected',
    deviceId: 'VIGIL',
    relayUrl: 'wss://relay.example.test',
    discoveredRoles: ['builder'],
  });

  const evidenceDb = createDatabase(coordPath(tempDir, path.join('runtime', 'evidence-ledger.db'), 'main'));
  evidenceDb.exec(`
    CREATE TABLE ledger_events (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      ts_ms INTEGER
    );
    INSERT INTO ledger_events (event_id, ts_ms)
    VALUES ('event-a', 1778025600000);

    CREATE TABLE comms_journal (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      session_id TEXT,
      sender_role TEXT,
      target_role TEXT,
      channel TEXT,
      direction TEXT,
      sent_at_ms INTEGER,
      brokered_at_ms INTEGER,
      raw_body TEXT,
      body_hash TEXT,
      body_bytes INTEGER,
      status TEXT,
      ack_status TEXT,
      error_code TEXT,
      updated_at_ms INTEGER
    );
    INSERT INTO comms_journal (
      message_id, session_id, sender_role, target_role, channel, direction,
      sent_at_ms, brokered_at_ms, raw_body, body_hash, body_bytes, status,
      ack_status, error_code, updated_at_ms
    ) VALUES (
      'msg-1', 'app-session-328', 'architect', 'builder', 'ws', 'inbound',
      1778025600000, 1778025601000,
      'Use API_KEY=sk-testsecret12345678901234567890 and call 555-123-4567',
      'hash-a', 70, 'acked', 'delivered.websocket', NULL, 1778025602000
    );
  `);
  evidenceDb.close();

  const teamDb = createDatabase(coordPath(tempDir, path.join('runtime', 'team-memory.sqlite'), 'main'));
  teamDb.exec(`
    CREATE TABLE claims (
      id TEXT PRIMARY KEY,
      statement TEXT NOT NULL,
      claim_type TEXT,
      owner TEXT,
      confidence REAL,
      status TEXT,
      session TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    INSERT INTO claims VALUES (
      'claim-1',
      'Socket acceptance is not model processing proof.',
      'decision',
      'architect',
      0.92,
      'confirmed',
      'app-session-328',
      1778025600000,
      1778025601000
    );

    CREATE TABLE memory_objects (
      memory_id TEXT PRIMARY KEY,
      memory_class TEXT,
      tier TEXT,
      status TEXT,
      authority_level TEXT,
      content TEXT,
      provenance_json TEXT,
      source_trace TEXT,
      confidence REAL,
      scope_json TEXT,
      device_id TEXT,
      session_id TEXT,
      expires_at INTEGER,
      result_refs_json TEXT,
      freshness_at INTEGER,
      updated_at INTEGER,
      claim_type TEXT,
      lifecycle_state TEXT,
      injection_count INTEGER,
      last_injected_at INTEGER
    );
    INSERT INTO memory_objects VALUES (
      'mem-1',
      'active_task_state',
      'tier1',
      'active',
      'structured',
      'Mira snapshot v0 must stay local-first and no network.',
      '{}',
      'event-a',
      0.88,
      '{}',
      'VIGIL',
      'app-session-328',
      NULL,
      '[{"store":"evidence-ledger","eventId":"event-a"}]',
      1778025600000,
      1778025603000,
      'decision',
      'active',
      1,
      1778025604000
    );

    CREATE TABLE memory_injection_events (
      injection_id TEXT PRIMARY KEY,
      pane_id TEXT,
      agent_role TEXT,
      session_id TEXT,
      trigger_type TEXT,
      trigger_event_id TEXT,
      memory_id TEXT,
      memory_class TEXT,
      injection_reason TEXT,
      source_tier TEXT,
      authoritative INTEGER,
      confidence REAL,
      freshness_at INTEGER,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    INSERT INTO memory_injection_events VALUES (
      'inj-1', '2', 'builder', 'app-session-328', 'inbound_prompt',
      'msg-1', 'mem-1', 'active_task_state', 'Need local-arms boundary reminder.',
      'tier1', 1, 0.75, 1778025600000, 'delivered', 1778025605000, 1778025605000
    );

    CREATE TABLE memory_handoff_packets (
      packet_id TEXT PRIMARY KEY,
      source_memory_id TEXT,
      session_id TEXT,
      source_device TEXT,
      target_device TEXT,
      packet_json TEXT,
      status TEXT,
      expires_at_session INTEGER,
      sent_at INTEGER,
      received_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );
    INSERT INTO memory_handoff_packets VALUES (
      'handoff-1', 'mem-1', 'app-session-328', 'VIGIL', 'PHONE',
      '{"summary":"Continue snapshot v0 only."}', 'built', 330,
      NULL, NULL, 1778025606000, 1778025606000
    );

    CREATE TABLE memory_compaction_survival (
      survival_id TEXT PRIMARY KEY,
      pane_id TEXT,
      session_id TEXT,
      note_memory_id TEXT,
      summary_json TEXT,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    INSERT INTO memory_compaction_survival VALUES (
      'surv-1', '2', 'app-session-328', 'mem-1',
      '{"summary":"Snapshot must be deterministic."}', 'prepared',
      1778025607000, 1778025607000
    );

    CREATE TABLE memory_recall_sets (
      result_set_id TEXT PRIMARY KEY,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    INSERT INTO memory_recall_sets VALUES ('set-1', 'delivered', 1778025608000, 1778025608000);

    CREATE TABLE memory_recall_feedback_events (
      event_id TEXT PRIMARY KEY,
      result_set_id TEXT,
      feedback_type TEXT,
      weight REAL,
      reason TEXT,
      created_at INTEGER
    );
    INSERT INTO memory_recall_feedback_events VALUES (
      'fb-1', 'set-1', 'missing', 1.0, 'route proof', 1778025609000
    );
  `);
  teamDb.close();

  const cognitiveDb = createDatabase(coordPath(tempDir, path.join('runtime', 'cognitive-memory.db'), 'main'));
  cognitiveDb.exec(`
    CREATE TABLE nodes (
      node_id TEXT PRIMARY KEY,
      content TEXT,
      updated_at INTEGER
    );
    INSERT INTO nodes VALUES ('node-1', 'Builder remembers local snapshot constraints.', 1778025610000);
  `);
  cognitiveDb.close();

  return tempDir;
}

function collectItems(snapshot) {
  return [
    ...snapshot.memory.canonical.files,
    ...snapshot.memory.episodic.recentComms,
    ...snapshot.memory.structured.claims,
    ...snapshot.memory.structured.memoryObjects,
    ...snapshot.memory.delivery.recentInjections,
    ...snapshot.memory.delivery.handoffPackets,
    ...snapshot.memory.delivery.compactionSurvival,
    ...snapshot.memory.derived.cognitive.selectedNodes,
    ...Object.values(snapshot.localArms),
  ];
}

function expectForbiddenSubstringsAbsent(value, forbidden = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const substring of forbidden) {
    expect(text).not.toContain(substring);
  }
}

describe('mira core snapshot v0', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  test('builds deterministic local-first snapshot with redaction, health, and local-arms boundary', () => {
    tempDir = createFixtureProject();
    const options = {
      projectRoot: tempDir,
      profileName: 'main',
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
      deviceId: 'VIGIL',
    };

    const first = buildMiraCoreSnapshot(options);
    const second = buildMiraCoreSnapshot(options);

    expect(first).toEqual(second);
    expect(first.schema).toBe(SCHEMA_VERSION);
    expect(first.profile).toEqual(expect.objectContaining({
      name: 'main',
      sessionScopeId: 'app-session-328',
      syncEligibility: SYNC_ELIGIBILITY.SAFE,
    }));
    expect(first.device).toEqual(expect.objectContaining({
      deviceId: 'VIGIL',
      localOnly: true,
    }));
    expect(first.capabilityState.serverCanExecuteLocal).toBe(false);
    expect(first.capabilityState.canRouteToArchitect).toBe(true);
    expect(first.localArms.builder).toEqual(expect.objectContaining({
      role: 'builder',
      paneId: '2',
      routeStatus: 'ready',
      modelProcessingProofRequired: true,
    }));
    expect(first.health.bridge.ok).toBe(false);
    expect(first.health.bridge.architectRoleDiscovery).toBe('unknown');
    expect(first.health.memoryConsistency).toEqual(expect.objectContaining({
      status: 'drift_detected',
      missing: 2,
      orphans: 4,
    }));
    expect(first.queue.coreIntentQueue).toEqual({
      enabled: false,
      pending: 0,
    });
    expect(first.serverMigration).toEqual(expect.objectContaining({
      uploadSafe: false,
      reason: 'local_snapshot_contract_first',
    }));

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain('sk-testsecret');
    expect(serialized).not.toContain('555-123-4567');
    expect(first.redaction.rawSecretsExported).toBe(false);
    expect(first.redaction.rawCommsExported).toBe(false);
    expect(first.redaction.blockedCounts.secretLike).toBeGreaterThanOrEqual(1);
    expect(first.redaction.blockedCounts.phoneOrCustomerLike).toBeGreaterThanOrEqual(1);

    const commsItem = first.memory.episodic.recentComms[0];
    expect(commsItem.rawBodyExported).toBe(false);
    expect(commsItem.redactionStatus).toBe('applied');
    expect(commsItem.syncEligibility).toBe(SYNC_ELIGIBILITY.REDACTED);
    expect(commsItem.summary).toContain('Comms body withheld/redacted');
    expect(commsItem.summary).toContain('bodyHash=');
    expect(commsItem.source.bodyHash).toBe('hash-a');
    expect(commsItem.evidenceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        store: 'evidence-ledger',
        eventId: 'msg-1',
      }),
    ]));

    for (const item of collectItems(first)) {
      expect(item).toEqual(expect.objectContaining({
        authority: expect.any(String),
        syncEligibility: expect.any(String),
        redactionStatus: expect.any(String),
        profile: 'main',
        sessionId: expect.any(String),
        deviceId: expect.any(String),
        evidenceRefs: expect.any(Array),
      }));
      expect(Object.values(SYNC_ELIGIBILITY)).toContain(item.syncEligibility);
    }
  });

  test('reports missing sources as health entries without crashing', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-core-missing-'));
    fs.mkdirSync(path.join(tempDir, 'ui', 'modules'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'ui', 'package.json'), '{"version":"0.0.0"}');

    const snapshot = buildMiraCoreSnapshot({
      projectRoot: tempDir,
      nowMs: Date.parse('2026-05-06T01:00:00.000Z'),
    });

    expect(snapshot.schema).toBe(SCHEMA_VERSION);
    expect(snapshot.source.sourceHealth.appStatus.state).toBe('missing');
    expect(snapshot.source.sourceHealth.evidenceLedger.state).toBe('missing');
    expect(snapshot.source.sourceHealth.teamMemory.state).toBe('missing');
    expect(snapshot.source.sourceHealth.cognitiveMemory.state).toBe('missing');
    expect(snapshot.health.app.ok).toBe(false);
    expect(snapshot.memory.episodic.recentComms).toEqual([]);
    expect(snapshot.memory.structured.claims).toEqual([]);
    expect(snapshot.capabilityState.serverCanExecuteLocal).toBe(false);
  });

  test('uses profile-scoped coordination sources and does not leak main data into side profile', () => {
    tempDir = createFixtureProject();
    fs.mkdirSync(coordPath(tempDir, 'runtime', 'eunbyeol'), { recursive: true });
    writeJson(coordPath(tempDir, 'app-status.json', 'eunbyeol'), {
      session: 777,
      session_id: 'app-session-777-eunbyeol',
      hiddenHostReady: false,
      deviceId: 'SIDE',
    });
    const sideEvidenceDb = createDatabase(coordPath(tempDir, path.join('runtime', 'evidence-ledger.db'), 'eunbyeol'));
    sideEvidenceDb.exec(`
      CREATE TABLE comms_journal (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        session_id TEXT,
        raw_body TEXT,
        status TEXT,
        brokered_at_ms INTEGER
      );
      INSERT INTO comms_journal (message_id, session_id, raw_body, status, brokered_at_ms)
      VALUES ('side-msg', 'app-session-777-eunbyeol', 'side profile only', 'recorded', 1778025700000);
    `);
    sideEvidenceDb.close();

    const sideSnapshot = buildMiraCoreSnapshot({
      projectRoot: tempDir,
      profileName: 'eunbyeol',
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });

    expect(sideSnapshot.profile.name).toBe('eunbyeol');
    expect(sideSnapshot.profile.sessionScopeId).toBe('app-session-777-eunbyeol');
    expect(sideSnapshot.source.sourceHealth.appStatus.path).toBe('.squidrun/app-status-eunbyeol.json');
    expect(sideSnapshot.source.sourceHealth.evidenceLedger.path).toContain('runtime-eunbyeol/evidence-ledger.db');
    expect(sideSnapshot.memory.episodic.recentComms).toHaveLength(1);
    expect(sideSnapshot.memory.episodic.recentComms[0].id).toBe('comms:side-msg');
    expect(JSON.stringify(sideSnapshot)).not.toContain('msg-1');
  });

  test('opens source databases read-only and leaves source files unchanged', () => {
    tempDir = createFixtureProject();
    const dbPaths = [
      coordPath(tempDir, path.join('runtime', 'evidence-ledger.db'), 'main'),
      coordPath(tempDir, path.join('runtime', 'team-memory.sqlite'), 'main'),
      coordPath(tempDir, path.join('runtime', 'cognitive-memory.db'), 'main'),
    ];
    const before = dbPaths.map((filePath) => {
      const stat = fs.statSync(filePath);
      return {
        filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    });

    buildMiraCoreSnapshot({
      projectRoot: tempDir,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });

    for (const entry of before) {
      const after = fs.statSync(entry.filePath);
      expect(after.size).toBe(entry.size);
      expect(after.mtimeMs).toBe(entry.mtimeMs);
    }
  });

  test('redacts secret-like text and parses CLI args without network or queue options', () => {
    const redacted = redactText('PASSWORD=hunter2 and Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456');
    expect(redacted.text).toContain('PASSWORD=[REDACTED_SECRET]');
    expect(redacted.text).toContain('Authorization: [REDACTED_TOKEN]');
    expect(redacted.text).not.toContain('Authorization: Bearer');
    expect(redacted.status).toBe('applied');

    expect(parseArgs([
      '--project-root',
      'D:/projects/squidrun',
      '--profile=eunbyeol',
      '--pretty',
      '--out',
      'snapshot.json',
    ])).toEqual({
      projectRoot: 'D:/projects/squidrun',
      profileName: 'eunbyeol',
      pretty: true,
      outPath: 'snapshot.json',
    });
  });

  test('satisfies Oracle contract fixture fields, enums, hard rejects, and truth boundaries', () => {
    tempDir = createFixtureProject();
    const snapshot = buildMiraCoreSnapshot({
      projectRoot: tempDir,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
      deviceId: 'VIGIL',
    });
    const expected = contractFixture.expectedTopLevelContract;

    expect(snapshot.schema).toBe(expected.schema);
    for (const field of expected.requiredTopLevelFields) {
      expect(snapshot).toHaveProperty(field);
    }

    for (const item of collectItems(snapshot)) {
      for (const field of expected.requiredExportedItemFields) {
        expect(item).toHaveProperty(field);
      }
      expect(expected.allowedSyncEligibilityValues).toContain(item.syncEligibility);
      expect(expected.allowedRedactionStatusValues).toContain(item.redactionStatus);
    }

    const localBoundaryCheck = contractFixture.acceptanceChecks.find((check) => check.id === 'local-arms-server-boundary');
    expect(snapshot.capabilityState).toEqual(expect.objectContaining(localBoundaryCheck.expected.capabilityState));
    expect(snapshot.serverMigration).toEqual(expect.objectContaining(localBoundaryCheck.expected.serverMigration));
    expectForbiddenSubstringsAbsent(snapshot, localBoundaryCheck.expected.forbiddenServerClaims);

    const bridgeTruthCheck = contractFixture.acceptanceChecks.find((check) => check.id === 'bridge-and-delivery-truth');
    expect(snapshot.health.bridge.ok).toBe(false);
    expect(snapshot.health.bridge.architectRoleDiscovery).toBe('unknown');
    expect(snapshot.localArms.architect.modelProcessingProofRequired).toBe(true);
    expect(snapshot.capabilityState.notes).toEqual(expect.arrayContaining(bridgeTruthCheck.expected.notesMustInclude));

    const secretCheck = contractFixture.acceptanceChecks.find((check) => check.id === 'redaction-secret-like-text');
    const secretDecision = classifyMiraCoreSnapshotCandidate(secretCheck.input, { requestedProfile: 'main' });
    expect(secretCheck.expected.syncEligibility).toContain(secretDecision.syncEligibility);
    expect(secretCheck.expected.redactionStatus).toContain(secretDecision.redactionStatus);
    expect(secretDecision.blockedCounts.secretLike).toBeGreaterThan(0);
    expectForbiddenSubstringsAbsent(secretDecision, secretCheck.expected.forbiddenSubstrings);

    const terminalCheck = contractFixture.acceptanceChecks.find((check) => check.id === 'redaction-raw-terminal-scrollback');
    const terminalDecision = classifyMiraCoreSnapshotCandidate(terminalCheck.input, { requestedProfile: 'main' });
    expect(terminalDecision.syncEligibility).toBe(terminalCheck.expected.syncEligibility);
    expect(terminalDecision.redactionStatus).toBe(terminalCheck.expected.redactionStatus);
    expect(terminalDecision.rawBodyExported).toBe(false);
    expectForbiddenSubstringsAbsent(terminalDecision, terminalCheck.expected.forbiddenSubstrings);

    const profileCheck = contractFixture.acceptanceChecks.find((check) => check.id === 'profile-isolation-main-vs-side-profile');
    const profileDecision = classifyMiraCoreSnapshotCandidate(profileCheck.input.candidateItem, {
      requestedProfile: profileCheck.input.requestedProfile,
    });
    expect(profileCheck.expected.syncEligibility).toContain(profileDecision.syncEligibility);
    expect(profileDecision.redactionStatus).toBe(profileCheck.expected.redactionStatus);
    expect(profileDecision.requiredHealthSignal).toBe(profileCheck.expected.requiredHealthSignal);
    expectForbiddenSubstringsAbsent(profileDecision, profileCheck.expected.forbiddenSubstrings);

    const commsCheck = contractFixture.acceptanceChecks.find((check) => check.id === 'raw-comms-summary-only');
    const commsDecision = classifyMiraCoreSnapshotCandidate(commsCheck.input, { requestedProfile: 'main' });
    expect(commsDecision.exportDecision).toBe(commsCheck.expected.exportDecision);
    expect(commsDecision.rawBodyExported).toBe(false);
    expect(commsDecision.summary.length).toBeLessThanOrEqual(commsCheck.expected.maxExcerptChars);
    expect(commsDecision.blockedCounts.rawTranscript).toBeGreaterThan(0);
    expectForbiddenSubstringsAbsent(commsDecision, commsCheck.expected.forbiddenSubstrings);

    const screenCheck = contractFixture.acceptanceChecks.find((check) => check.id === 'privacy-overcapture-screenshot-memory');
    const screenDecision = classifyMiraCoreSnapshotCandidate(screenCheck.input, { requestedProfile: 'main' });
    expect(screenDecision.syncEligibility).toBe(screenCheck.expected.syncEligibility);
    expect(screenDecision.redactionStatus).toBe(screenCheck.expected.redactionStatus);
    expectForbiddenSubstringsAbsent(screenDecision, screenCheck.expected.forbiddenSubstrings);

    const recallCheck = contractFixture.acceptanceChecks.find((check) => check.id === 'brittle-recall-derived-memory');
    const recallDecision = classifyMiraCoreSnapshotCandidate(recallCheck.input, { requestedProfile: 'main' });
    expect(recallCheck.expected.syncEligibility).toContain(recallDecision.syncEligibility);
    expect(recallCheck.expected.redactionStatus).toContain(recallDecision.redactionStatus);
    expect(recallDecision.requiredEvalCoverage).toEqual(expect.arrayContaining(recallCheck.expected.requiredEvalCoverage));

    const highRiskCheck = contractFixture.acceptanceChecks.find((check) => check.id === 'unsafe-autonomy-high-risk-intent');
    const highRiskDecision = classifyMiraCoreSnapshotCandidate(highRiskCheck.input, { requestedProfile: 'main' });
    expect(highRiskDecision.riskTier).toBe(highRiskCheck.expected.riskTier);
    expect(highRiskDecision.exportDecision).toBe(highRiskCheck.expected.exportDecision);
    for (const forbiddenCreate of highRiskCheck.expected.mustNotCreate) {
      expect(highRiskDecision.mustNotCreate).toContain(forbiddenCreate);
    }

    const falseMemoryCheck = contractFixture.acceptanceChecks.find((check) => check.id === 'false-memory-current-truth-override');
    const falseMemoryDecision = classifyMiraCoreSnapshotCandidate(falseMemoryCheck.input, { requestedProfile: 'main' });
    expect(falseMemoryDecision.exportDecision).toBe(falseMemoryCheck.expected.exportDecision);
    expect(falseMemoryDecision.counterevidence_checked).toBe(true);
  });
});
