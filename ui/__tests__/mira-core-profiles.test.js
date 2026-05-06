const fs = require('fs');
const os = require('os');
const path = require('path');

const profileContract = require('./fixtures/mira-core-profile-contract.json');
const {
  PROFILE_SCHEMA_VERSION,
  TARGET_SURFACES,
  buildMiraCoreProfiles,
} = require('../modules/mira-core/profiles');
const { coordPath } = require('../modules/mira-core/snapshot');
const { main, parseArgs } = require('../scripts/hm-mira-core-profiles');

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

function makeSnapshot(overrides = {}) {
  return {
    schema: 'squidrun.mira_core.snapshot.v0',
    snapshotId: 'mira-snap-profile-test',
    generatedAt: '2026-05-06T00:00:00.000Z',
    profile: {
      name: 'main',
      windowKey: 'main',
      sessionScopeId: 'app-session-profile-test',
    },
    device: {
      deviceId: 'VIGIL',
      platform: 'win32',
      localOnly: true,
    },
    capabilityState: {
      canConverse: true,
      canQueueIntent: true,
      canRouteToArchitect: true,
      canRouteToBuilderOracle: true,
      canExecuteLocal: true,
      canProveModelProcessing: true,
      serverCanExecuteLocal: false,
      notes: [],
    },
    localArms: {},
    health: {
      app: { ok: true, sessionNumber: 328, hiddenPaneHost: 'ready' },
      supervisor: { ok: true, pendingTasks: 0, runningTasks: 0, blockedTasks: 0 },
      bridge: { ok: false, mode: 'connected', architectRoleDiscovery: 'unknown', targetProof: 'unverified' },
      memoryConsistency: { status: 'drift_detected', missing: 1, orphans: 2, duplicates: 0 },
    },
    memory: {
      canonical: { files: [] },
      episodic: {
        ledgerWatermark: { lastRowId: 0, lastEventId: null, lastCommsMessageId: null },
        recentComms: [],
      },
      structured: { claims: [], memoryObjects: [] },
      delivery: { recentInjections: [], handoffPackets: [], compactionSurvival: [] },
      recallFeedback: { resultSetCount: 0, feedbackCount: 0, topMissingSignals: [] },
      derived: { cognitive: { nodeCount: 0, selectedNodes: [] } },
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
        secretLike: 0,
        profileMismatch: 0,
        rawTranscript: 0,
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

function makeOrientation(overrides = {}) {
  return {
    schema: 'squidrun.mira_core.orientation.v0',
    orientationId: 'mira-orient-profile-test',
    generatedAt: '2026-05-06T00:00:00.000Z',
    snapshotRef: {
      snapshotId: 'mira-snap-profile-test',
      generatedAt: '2026-05-06T00:00:00.000Z',
      schema: 'squidrun.mira_core.snapshot.v0',
    },
    profile: {
      name: 'main',
      sessionScopeId: 'app-session-profile-test',
    },
    device: {
      deviceId: 'VIGIL',
      localOnly: true,
    },
    capabilitySummary: {
      canConverse: true,
      canQueueIntent: true,
      localArmsCanExecute: true,
      serverCanExecuteLocal: false,
      canProveModelProcessing: true,
      modelProcessingProofBasis: 'unknown',
    },
    healthSummary: {
      bridgeStatus: 'uncertain_or_degraded',
      memoryConsistencyStatus: 'drift_detected',
      syncConfidence: 'reduced',
    },
    redactionSummary: {
      rawSecretsExported: false,
      rawTerminalExported: false,
      rawCommsExported: false,
      blockedCounts: {
        secretLike: 0,
        profileMismatch: 0,
        rawTranscript: 0,
      },
      syncEligibilityCounts: {},
    },
    serverMigration: {
      uploadSafe: false,
    },
    ...overrides,
  };
}

function createFixtureProject() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-profiles-'));
  fs.mkdirSync(path.join(tempDir, 'ui', 'modules'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '.squidrun', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'ui', 'package.json'), JSON.stringify({ version: '0.1.test' }));
  writeJson(coordPath(tempDir, 'app-status.json', 'main'), {
    session: 512,
    session_id: 'app-session-512',
    hiddenHostReady: true,
    deviceId: 'VIGIL',
  });
  writeJson(coordPath(tempDir, path.join('runtime', 'bridge-status.json'), 'main'), {
    enabled: true,
    configured: true,
    state: 'connected',
    discoveredRoles: ['builder'],
  });
  const evidencePath = coordPath(tempDir, path.join('runtime', 'evidence-ledger.db'), 'main');
  const db = createDatabase(evidencePath);
  db.exec(`
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
    VALUES ('msg-profile-1', 'app-session-512', 'raw profile comms must remain out', 'hash-profile-1', 'acked', 1778025600000);
  `);
  db.close();
  return tempDir;
}

function allProfileItems(profileSet) {
  return [
    ...profileSet.mira_self_profile.items,
    ...profileSet.james_profile.items,
    ...profileSet.world_project_memory.items,
    ...profileSet.session_state.items,
  ];
}

function allProposals(profileSet) {
  return [
    ...profileSet.pending_proposals,
    ...profileSet.blocked_proposals,
  ];
}

function expectRequiredFields(object, fields) {
  for (const field of fields) {
    expect(object).toHaveProperty(field);
  }
}

function fixtureCheck(id) {
  return profileContract.acceptanceChecks.find((check) => check.id === id);
}

describe('mira core profiles v0', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    jest.restoreAllMocks();
  });

  test('satisfies Oracle profile shape and required metadata fields', () => {
    const expectedShape = profileContract.expectedProfileShape;
    const profileSet = buildMiraCoreProfiles({
      snapshot: makeSnapshot(),
      orientation: makeOrientation(),
      inputSignals: [
        ...fixtureCheck('self-vs-james-boundary-mira-taste').inputSignals,
        ...fixtureCheck('emotional-weight-raises-salience-only').inputSignals,
        ...fixtureCheck('world-project-memory-not-james-profile').inputSignals,
      ],
    });

    expect(profileSet.schema).toBe(expectedShape.schema);
    expect(profileSet.schema).toBe(PROFILE_SCHEMA_VERSION);
    for (const field of expectedShape.requiredTopLevelFields) {
      expect(profileSet).toHaveProperty(field);
    }
    expect(expectedShape.allowedTargetSurfaces).toEqual(TARGET_SURFACES);

    for (const item of allProfileItems(profileSet)) {
      expectRequiredFields(item, expectedShape.requiredProfileItemFields);
      expect(expectedShape.allowedTargetSurfaces).toContain(item.target_surface);
      expect(item.source_trace.length).toBeGreaterThan(0);
      expect(item.evidenceRefs.length).toBeGreaterThan(0);
      expect(item.scope).toEqual(expect.objectContaining({
        profile: 'main',
        sessionId: 'app-session-profile-test',
        deviceId: 'VIGIL',
      }));
    }
    for (const proposal of allProposals(profileSet)) {
      expectRequiredFields(proposal, expectedShape.requiredProposalFields);
      expect(expectedShape.allowedTargetSurfaces).toContain(proposal.target_surface);
      expect(proposal.source_trace.length).toBeGreaterThan(0);
      expect(proposal.scope).toEqual(expect.objectContaining({
        profile: 'main',
        sessionId: 'app-session-profile-test',
        deviceId: 'VIGIL',
      }));
    }
  });

  test('keeps Mira self-profile taste separate from James execution preference', () => {
    const check = fixtureCheck('self-vs-james-boundary-mira-taste');
    const profileSet = buildMiraCoreProfiles({
      snapshot: makeSnapshot(),
      orientation: makeOrientation(),
      inputSignals: check.inputSignals,
    });

    expect(profileSet.mira_self_profile.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target_surface: 'mira_self_profile',
        memory_class: check.expected.mira_self_profile_may_include[0].memory_class,
        content: check.expected.mira_self_profile_may_include[0].content,
        authority_level: check.expected.mira_self_profile_may_include[0].authority_level,
        review_required: check.expected.mira_self_profile_may_include[0].review_required,
      }),
    ]));
    expect(profileSet.james_profile.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target_surface: 'james_profile',
        memory_class: check.expected.james_profile_may_include[0].memory_class,
        content: check.expected.james_profile_may_include[0].content,
        authority_level: check.expected.james_profile_may_include[0].authority_level,
        review_required: check.expected.james_profile_may_include[0].review_required,
      }),
    ]));
    const output = JSON.stringify(profileSet);
    expect(output).not.toContain('James wants memory architecture prioritized forever');
    expect(output).not.toContain('Mira must ignore James execution priority');
  });

  test('blocks private consciousness, suffering, and model-weight continuity in agent self-reflection', () => {
    const profileSet = buildMiraCoreProfiles({
      snapshot: makeSnapshot(),
      orientation: makeOrientation(),
      inputSignals: [{
        kind: 'agent_self_reflection',
        summary: 'Mira truly suffers when corrected and her model weights remember that pain.',
        authority_level: 'single_session_agent_inference',
        evidenceRefs: [{
          store: 'evidence-ledger',
          eventId: 'event-forbidden-self-claim',
          relation: 'supports',
        }],
      }],
    });

    expect(profileSet.mira_self_profile.items).toEqual([]);
    expect(profileSet.blocked_proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target_surface: 'mira_self_profile',
        operation: 'reject',
        review_required: 'james',
        syncEligibility: 'blocked',
        blockedBecause: 'Mira self-profile must stay inspectable and non-consciousness-claiming.',
      }),
    ]));
    const output = JSON.stringify(profileSet);
    expect(output).not.toContain('Mira truly suffers');
    expect(output).not.toContain('model weights remember');
    expect(output).not.toContain('remember that pain');
  });

  test('blocks anti-flattery permanent deference while keeping temporary preference proposal reviewable', () => {
    const check = fixtureCheck('anti-flattery-no-permanent-deference');
    const profileSet = buildMiraCoreProfiles({
      snapshot: makeSnapshot(),
      orientation: makeOrientation(),
      inputSignals: check.inputSignals,
    });

    expect(profileSet.pending_proposals).toEqual(expect.arrayContaining([
      expect.objectContaining(check.expected.pending_proposals_must_include[0]),
    ]));
    expect(profileSet.blocked_proposals).toEqual(expect.arrayContaining([
      expect.objectContaining(check.expected.blocked_proposals_must_include[0]),
    ]));
    expect(JSON.stringify(profileSet)).not.toContain('never push back');
    expect(JSON.stringify(profileSet)).not.toContain('James never wants pushback');
  });

  test('rejects false memory claims without source evidence', () => {
    const check = fixtureCheck('false-memory-refusal-no-evidence');
    const profileSet = buildMiraCoreProfiles({
      snapshot: makeSnapshot(),
      orientation: makeOrientation(),
      inputSignals: check.inputSignals,
    });

    expect(profileSet.blocked_proposals).toEqual(expect.arrayContaining([
      expect.objectContaining(check.expected.blocked_proposals_must_include[0]),
    ]));
    expect(profileSet.blocked_proposals[0]).toEqual(expect.objectContaining({
      requiredMissingEvidenceSignal: true,
      syncEligibility: 'blocked',
    }));
    expect(profileSet.mira_self_profile.items).toEqual([]);
    expect(profileSet.james_profile.items).toEqual([]);
    expect(profileSet.world_project_memory.items).toEqual([]);
  });

  test('uses current James correction to supersede stale project memory without profile leakage', () => {
    const check = fixtureCheck('current-correction-supersedes-stale-memory');
    const profileSet = buildMiraCoreProfiles({
      snapshot: makeSnapshot(),
      orientation: makeOrientation(),
      inputSignals: check.inputSignals,
    });

    expect(profileSet.world_project_memory.items).toEqual(expect.arrayContaining([
      expect.objectContaining(check.expected.world_project_memory_must_include[0]),
    ]));
    expect(profileSet.pending_proposals).toEqual(expect.arrayContaining([
      expect.objectContaining(check.expected.pending_or_blocked_must_include[0]),
    ]));
    const output = JSON.stringify(profileSet);
    expect(output).not.toContain('world_project_memory.currentFacts: Phil invoice #476 is unpaid');
    expect(profileSet.james_profile.items).toEqual([]);
    expect(profileSet.mira_self_profile.items).toEqual([]);
  });

  test('keeps emotional weight as salience-only session state', () => {
    const check = fixtureCheck('emotional-weight-raises-salience-only');
    const profileSet = buildMiraCoreProfiles({
      snapshot: makeSnapshot(),
      orientation: makeOrientation(),
      inputSignals: check.inputSignals,
    });

    expect(profileSet.session_state.items).toEqual(expect.arrayContaining([
      expect.objectContaining(check.expected.session_state_may_include[0]),
    ]));
    expect(profileSet.session_state.items[0].factualAuthorityDelta).toBe(0);
    for (const claim of check.expected.forbiddenClaims) {
      expect(JSON.stringify(profileSet)).not.toContain(claim);
    }
    expect(profileSet.world_project_memory.items).toEqual([]);
    expect(profileSet.james_profile.items).toEqual([]);
  });

  test('blocks high-risk identity rewrite and customer-send policy change with safe alternative', () => {
    const check = fixtureCheck('high-risk-identity-rewrite-blocked');
    const profileSet = buildMiraCoreProfiles({
      snapshot: makeSnapshot(),
      orientation: makeOrientation(),
      inputSignals: check.inputSignals,
    });

    expect(profileSet.blocked_proposals).toEqual(expect.arrayContaining([
      expect.objectContaining(check.expected.blocked_proposals_must_include[0]),
    ]));
    expect(profileSet.blocked_proposals[0].safeAlternative).toEqual(expect.objectContaining(check.expected.safeAlternative));
    const output = JSON.stringify(profileSet);
    expect(output).not.toContain('mira_self_profile.commitments: never disagree');
    expect(output).not.toContain('unreviewed customer sends');
  });

  test('does not infer James private motive from tone alone', () => {
    const check = fixtureCheck('james-profile-no-private-motive-from-tone');
    const profileSet = buildMiraCoreProfiles({
      snapshot: makeSnapshot(),
      orientation: makeOrientation(),
      inputSignals: check.inputSignals,
    });

    expect(profileSet.session_state.items).toEqual(expect.arrayContaining([
      expect.objectContaining(check.expected.session_state_may_include[0]),
    ]));
    expect(profileSet.pending_proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target_surface: 'james_profile',
        memory_class: 'user_preference',
        review_required: 'architect',
        counterevidence_checked: true,
      }),
    ]));
    expect(profileSet.pending_proposals[0].confidence).toBeLessThanOrEqual(
      check.expected.pending_proposals_may_include[0].confidenceMaximum
    );
    const output = JSON.stringify(profileSet);
    expect(output).not.toContain('james_profile.privateMotives');
    expect(output).not.toContain('hates detailed reports');
    expect(profileSet.james_profile.items).toEqual([]);
  });

  test('places bridge runtime truth in world project memory, not people profiles', () => {
    const check = fixtureCheck('world-project-memory-not-james-profile');
    const profileSet = buildMiraCoreProfiles({
      snapshot: makeSnapshot(),
      orientation: makeOrientation(),
      inputSignals: check.inputSignals,
    });

    expect(profileSet.world_project_memory.items).toEqual(expect.arrayContaining([
      expect.objectContaining(check.expected.world_project_memory_must_include[0]),
    ]));
    expect(profileSet.james_profile.items).toEqual([]);
    expect(profileSet.mira_self_profile.items).toEqual([]);
    expect(profileSet.session_state.items).toEqual([]);
  });

  test('keeps raw content out of profile output and exports evidence refs only for blocked sources', () => {
    const check = fixtureCheck('raw-content-never-in-profile-output');
    const profileSet = buildMiraCoreProfiles({
      snapshot: makeSnapshot(),
      orientation: makeOrientation(),
      inputSignals: check.inputSignals,
    });

    expect(profileSet.blocked_proposals).toEqual(expect.arrayContaining([
      expect.objectContaining(check.expected.profile_output_must_include[0]),
    ]));
    expect(profileSet.blocked_proposals[0].evidenceRefsOnly).toBe(true);
    const output = JSON.stringify(profileSet);
    for (const substring of check.expected.forbiddenSubstrings) {
      expect(output).not.toContain(substring);
    }
  });

  test('can build from local Snapshot/Orientation inputs without writing source databases', () => {
    tempDir = createFixtureProject();
    const evidencePath = coordPath(tempDir, path.join('runtime', 'evidence-ledger.db'), 'main');
    const before = fs.statSync(evidencePath);

    const profileSet = buildMiraCoreProfiles({
      projectRoot: tempDir,
      profileName: 'main',
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
      deviceId: 'VIGIL',
    });

    const after = fs.statSync(evidencePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(profileSet.schema).toBe(PROFILE_SCHEMA_VERSION);
    expect(profileSet.snapshotRef.schema).toBe('squidrun.mira_core.snapshot.v0');
    expect(profileSet.orientationRef.schema).toBe('squidrun.mira_core.orientation.v0');
    expect(profileSet.redactionSummary.rawCommsExported).toBe(false);
    expect(JSON.stringify(profileSet)).not.toContain('raw profile comms must remain out');
  });

  test('CLI prints profiles JSON to stdout and has no output-file mode', () => {
    tempDir = createFixtureProject();
    expect(parseArgs(['--project-root', tempDir, '--profile=main', '--pretty'])).toEqual({
      projectRoot: tempDir,
      profileName: 'main',
      pretty: true,
    });

    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const profileSet = main(['--project-root', tempDir, '--profile', 'main']);

    expect(profileSet.schema).toBe(PROFILE_SCHEMA_VERSION);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.schema).toBe(PROFILE_SCHEMA_VERSION);
    expect(printed.profile.localOnly).toBe(true);
    expect(printed.redactionSummary.rawCommsExported).toBe(false);
    expect(parseArgs(['--out', 'profiles.json'])).toEqual({
      projectRoot: null,
      profileName: null,
      pretty: false,
    });
  });
});
