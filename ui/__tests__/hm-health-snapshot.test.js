const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
}));

jest.mock('../modules/memory-consistency-check', () => ({
  runMemoryConsistencyCheck: jest.fn(() => ({
    ok: true,
    checkedAt: '2026-03-15T00:00:00.000Z',
    status: 'in_sync',
    synced: true,
    summary: {
      knowledgeEntryCount: 15,
      knowledgeNodeCount: 15,
      missingInCognitiveCount: 0,
      orphanedNodeCount: 0,
      duplicateKnowledgeHashCount: 0,
      issueCount: 0,
    },
  })),
  planMemoryConsistencyRepair: jest.fn(() => ({
    ok: true,
    mode: 'dry_run',
    dryRun: true,
    summary: {
      actionCount: 0,
      insertCount: 0,
      duplicateMergeCount: 0,
      orphanDeleteCount: 0,
      deleteCount: 0,
      skippedCount: 0,
    },
    skipped: [],
  })),
}));

jest.mock('../modules/main/codex-desktop-capability-awareness', () => ({
  buildCodexDesktopCapabilityStatus: jest.fn(() => ({
    status: 'routes_discoverable_process_not_running_or_unproven',
    availability: {
      codexDesktopProcess: {
        status: 'not_proven',
        process_count: 0,
        visible_window_count: 0,
      },
      computerUseAppControl: {
        status: 'known_route',
        source_message_id: 'telegram-in-808498547',
      },
      hmCodexDesktopTransport: {
        can_summon_workspace: false,
        visible_injection_proven: false,
      },
    },
    freshness: {
      attentionInbox: {
        active_count: 0,
        completed_count: 0,
        total_count: 0,
        polling_freshness: 'missing_index',
      },
      heartbeat: {
        status: 'missing',
        proof: 'not_proven',
        reason: 'missing_heartbeat',
      },
    },
  })),
}));

const { execFileSync } = require('child_process');
const { runMemoryConsistencyCheck } = require('../modules/memory-consistency-check');

function createDatabase(filePath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(filePath);
  } catch (_) {
    const BetterSqlite3 = require('better-sqlite3');
    return new BetterSqlite3(filePath);
  }
}

describe('hm-health-snapshot', () => {
  let tempDir;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-health-snapshot-'));

    fs.mkdirSync(path.join(tempDir, 'ui', '__tests__'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'ui', 'modules', 'main'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'ui', 'modules', 'supervisor'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.squidrun', 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'workspace', 'memory'), { recursive: true });

    fs.writeFileSync(path.join(tempDir, 'ui', 'package.json'), '{"name":"squidrun-test"}');
    fs.writeFileSync(path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'), 'test("a", () => {});');
    fs.writeFileSync(path.join(tempDir, 'ui', '__tests__', 'beta.test.js'), 'test("b", () => {});');
    fs.writeFileSync(path.join(tempDir, 'ui', 'modules', 'recovery-manager.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, 'ui', 'modules', 'scheduler.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, 'ui', 'modules', 'main', 'background-agent-manager.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, 'ui', 'modules', 'main', 'evidence-ledger-memory.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, 'ui', 'modules', 'supervisor', 'store.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, 'ui', 'supervisor-daemon.js'), 'module.exports = {};');

    const evidenceDb = createDatabase(path.join(tempDir, '.squidrun', 'runtime', 'evidence-ledger.db'));
    evidenceDb.exec(`
      CREATE TABLE comms_journal (
        id INTEGER PRIMARY KEY,
        message TEXT
      );
      INSERT INTO comms_journal (message) VALUES ('hi'), ('there');
    `);
    evidenceDb.close();

    const cognitiveDb = createDatabase(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
    cognitiveDb.exec(`
      CREATE TABLE nodes (
        node_id TEXT PRIMARY KEY,
        content TEXT
      );
      INSERT INTO nodes (node_id, content) VALUES ('n1', 'memory');
    `);
    cognitiveDb.close();
  });

  afterEach(() => {
    jest.resetModules();
    jest.unmock('node:sqlite');
    jest.unmock('better-sqlite3');
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('builds a structured startup health snapshot', () => {
    const { createHealthSnapshot } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      nowMs: Date.parse('2026-03-17T07:45:00.000Z'),
      jestTimeoutMs: 1000,
      bridgeStatus: {
        enabled: true,
        configured: true,
        running: true,
        relayUrl: 'wss://relay.example.test',
        deviceId: 'LOCAL',
        state: 'connected',
      },
    });

    expect(snapshot.status.level).toBe('ok');
    expect(snapshot.status.label).toBe('OK');
    expect(snapshot.status.score).toBe(100);
    expect(snapshot.status.penalties).toEqual([]);
    expect(snapshot.generatedAt).toBe('2026-03-17T07:45:00.000Z');
    expect(snapshot.tests.testFileCount).toBe(2);
    expect(snapshot.tests.jestList).toEqual(expect.objectContaining({
      ok: true,
      count: 2,
    }));
    expect(snapshot.modules).toEqual(expect.objectContaining({
      moduleFileCount: expect.any(Number),
      keyModules: expect.objectContaining({
        recovery_manager: expect.objectContaining({ exists: true }),
        background_agent_manager: expect.objectContaining({ exists: true }),
        scheduler: expect.objectContaining({ exists: true }),
      }),
    }));
    expect(snapshot.databases.evidenceLedger).toEqual(expect.objectContaining({
      exists: true,
      primaryTable: 'comms_journal',
      rowCount: 2,
    }));
    expect(snapshot.databases.cognitiveMemory).toEqual(expect.objectContaining({
      exists: true,
      primaryTable: 'nodes',
      rowCount: 1,
    }));
    expect(snapshot.bridge).toEqual(expect.objectContaining({
      enabled: true,
      configured: true,
      mode: 'connected',
      running: true,
      relayUrl: 'wss://relay.example.test',
      deviceId: 'LOCAL',
      state: 'connected',
    }));
    expect(snapshot.memoryConsistency).toEqual(expect.objectContaining({
      status: 'in_sync',
      synced: true,
      summary: expect.objectContaining({
        knowledgeEntryCount: 15,
        knowledgeNodeCount: 15,
      }),
    }));
    expect(snapshot.systemCapabilities).toEqual(expect.objectContaining({
      localModels: expect.objectContaining({
        enabled: false,
      }),
    }));
    expect(runMemoryConsistencyCheck).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: tempDir,
      profileName: 'main',
      sampleLimit: 5,
    }));
  });

  test('uses profile-scoped app-status and runtime databases for side snapshots', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    const { runMemoryConsistencyCheck: currentRunMemoryConsistencyCheck } = require('../modules/memory-consistency-check');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    fs.writeFileSync(path.join(tempDir, '.squidrun', 'app-status.json'), JSON.stringify({
      session: 300,
      session_id: 'app-session-300',
    }));
    fs.writeFileSync(path.join(tempDir, '.squidrun', 'app-status-eunbyeol.json'), JSON.stringify({
      session: 777,
      session_id: 'app-session-777-eunbyeol',
    }));
    fs.mkdirSync(path.join(tempDir, '.squidrun', 'runtime-eunbyeol'), { recursive: true });
    const evidenceDb = createDatabase(path.join(tempDir, '.squidrun', 'runtime-eunbyeol', 'evidence-ledger.db'));
    evidenceDb.exec(`
      CREATE TABLE comms_journal (
        id INTEGER PRIMARY KEY,
        message TEXT
      );
      INSERT INTO comms_journal (message) VALUES ('side only');
    `);
    evidenceDb.close();
    const cognitiveDb = createDatabase(path.join(tempDir, '.squidrun', 'runtime-eunbyeol', 'cognitive-memory.db'));
    cognitiveDb.exec(`
      CREATE TABLE nodes (
        node_id TEXT PRIMARY KEY,
        content TEXT
      );
      INSERT INTO nodes (node_id, content) VALUES ('side-a', 'memory'), ('side-b', 'memory');
    `);
    cognitiveDb.close();

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      profileName: 'eunbyeol',
      jestTimeoutMs: 1000,
      env: {},
    });

    expect(snapshot.profileName).toBe('eunbyeol');
    expect(snapshot.appStatus).toEqual(expect.objectContaining({
      sessionNumber: 777,
      sessionId: 'app-session-777-eunbyeol',
      path: expect.stringContaining('app-status-eunbyeol.json'),
    }));
    expect(snapshot.databases.evidenceLedger).toEqual(expect.objectContaining({
      path: expect.stringContaining(path.join('.squidrun', 'runtime-eunbyeol', 'evidence-ledger.db')),
      rowCount: 1,
    }));
    expect(snapshot.databases.cognitiveMemory).toEqual(expect.objectContaining({
      path: expect.stringContaining(path.join('.squidrun', 'runtime-eunbyeol', 'cognitive-memory.db')),
      rowCount: 2,
    }));
    expect(currentRunMemoryConsistencyCheck).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: tempDir,
      profileName: 'eunbyeol',
    }));
    expect(renderStartupHealthMarkdown(snapshot)).toContain('Profile: eunbyeol');
    expect(renderStartupHealthMarkdown(snapshot)).toContain('App Session: session 777');
  });

  test('prints usage and exits zero for help flags without building a snapshot', () => {
    const { main } = require('../scripts/hm-health-snapshot');
    for (const flag of ['--help', '-h']) {
      const stdout = { write: jest.fn() };
      const stderr = { write: jest.fn() };

      const exitCode = main([flag], { stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('Usage: node ui/scripts/hm-health-snapshot.js'));
      expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('--profile <name>'));
      expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('--markdown'));
      expect(stderr.write).not.toHaveBeenCalled();
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });

  test('uses project env bridge config when runtime bridge status is not injected', () => {
    const { createHealthSnapshot } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));
    fs.writeFileSync(path.join(tempDir, '.env'), [
      'SQUIDRUN_CROSS_DEVICE=1',
      'SQUIDRUN_DEVICE_ID=LOCAL',
      'SQUIDRUN_RELAY_URL=wss://relay.example.test',
      'SQUIDRUN_RELAY_SECRET=secret-value',
      '',
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      jestTimeoutMs: 1000,
      env: {},
    });

    expect(snapshot.bridge).toEqual(expect.objectContaining({
      enabled: true,
      configured: true,
      mode: 'pending',
      required: false,
      relayUrl: 'wss://relay.example.test',
      deviceId: 'LOCAL',
      state: 'pending_live_discovery',
      pending: true,
      lowFidelity: true,
    }));
    expect(snapshot.status.label).toBe('OK');
    expect(snapshot.status.warnings).not.toContain('bridge_connectivity_pending:live_discovery_not_available');
    expect(snapshot.status.penalties).not.toContainEqual({ code: 'bridge_enabled_not_connected', points: 15 });
  });

  test('upgrades pending bridge status when fresh live discovery proves the architect role online', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));
    fs.writeFileSync(path.join(tempDir, '.env'), [
      'SQUIDRUN_CROSS_DEVICE=1',
      'SQUIDRUN_DEVICE_ID=VIGIL',
      'SQUIDRUN_RELAY_URL=wss://relay.example.test',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(tempDir, '.squidrun', 'bridge'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.squidrun', 'bridge', 'known-devices.json'), JSON.stringify({
      updated_at: '2026-03-17T07:44:45.000Z',
      source: 'relay',
      devices: [
        {
          device_id: 'VIGIL',
          roles: ['architect'],
          connected_since: '2026-03-17T07:40:00.000Z',
        },
      ],
    }));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      nowMs: Date.parse('2026-03-17T07:45:00.000Z'),
      jestTimeoutMs: 1000,
      env: {},
    });
    const markdown = renderStartupHealthMarkdown(snapshot);

    expect(snapshot.bridge).toEqual(expect.objectContaining({
      enabled: true,
      configured: true,
      mode: 'connected',
      state: 'connected',
      status: 'relay_connected',
      pending: false,
      lowFidelity: false,
      deviceId: 'VIGIL',
      discoveredRoles: ['architect'],
      architectRoleDiscovery: 'registered',
      liveDiscovery: expect.objectContaining({
        ok: true,
        source: 'known-devices-cache',
        status: 'architect_online',
        matchedDeviceId: 'VIGIL',
        roles: ['architect'],
      }),
    }));
    expect(snapshot.status.warnings).not.toContain('bridge_connectivity_pending:live_discovery_not_available');
    expect(snapshot.status.penalties).not.toContainEqual({ code: 'bridge_enabled_not_connected', points: 15 });
    expect(markdown).toContain('Connection: connected');
    expect(markdown).toContain('Live Discovery: verified (architect_online; source=known-devices-cache; 15s old; roles=architect)');
  });

  test('keeps explicit disconnected bridge status authoritative over fresh known-devices proof', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));
    fs.mkdirSync(path.join(tempDir, '.squidrun', 'bridge'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.squidrun', 'bridge', 'known-devices.json'), JSON.stringify({
      updated_at: '2026-03-17T07:44:45.000Z',
      devices: [
        {
          device_id: 'VIGIL',
          roles: ['architect'],
        },
      ],
    }));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      nowMs: Date.parse('2026-03-17T07:45:00.000Z'),
      jestTimeoutMs: 1000,
      bridgeStatus: {
        enabled: true,
        configured: true,
        running: false,
        relayUrl: 'wss://relay.example.test',
        deviceId: 'VIGIL',
        state: 'disconnected',
        status: 'relay_disconnected',
      },
    });
    const markdown = renderStartupHealthMarkdown(snapshot);

    expect(snapshot.bridge).toEqual(expect.objectContaining({
      mode: 'connecting',
      required: false,
      state: 'disconnected',
      status: 'relay_disconnected',
      pending: false,
      deviceId: 'VIGIL',
      architectRoleDiscovery: 'unknown',
      liveDiscovery: expect.objectContaining({
        ok: true,
        status: 'architect_online',
        matchedDeviceId: 'VIGIL',
        roles: ['architect'],
      }),
    }));
    expect(snapshot.status.warnings).not.toContain('bridge_enabled_not_connected:disconnected');
    expect(snapshot.status.penalties).not.toContainEqual({ code: 'bridge_enabled_not_connected', points: 15 });
    expect(markdown).toContain('Connection: disconnected');
    expect(markdown).toContain('Live Discovery: verified (architect_online; source=known-devices-cache; 15s old; roles=architect)');
    expect(markdown).toContain('Runtime: mode=connecting, enabled=yes, configured=yes, required=no');
    expect(markdown).toContain('Probe: optional offline; penalty=0');
  });

  test('keeps bridge pending and reports discovery failure when known-devices proof is stale', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));
    fs.writeFileSync(path.join(tempDir, '.env'), [
      'SQUIDRUN_CROSS_DEVICE=1',
      'SQUIDRUN_DEVICE_ID=VIGIL',
      'SQUIDRUN_RELAY_URL=wss://relay.example.test',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(tempDir, '.squidrun', 'bridge'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.squidrun', 'bridge', 'known-devices.json'), JSON.stringify({
      updated_at: '2026-03-17T07:20:00.000Z',
      source: 'relay',
      devices: [
        {
          device_id: 'VIGIL',
          roles: ['architect'],
        },
      ],
    }));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      nowMs: Date.parse('2026-03-17T07:45:00.000Z'),
      jestTimeoutMs: 1000,
      env: {},
    });
    const markdown = renderStartupHealthMarkdown(snapshot);

    expect(snapshot.bridge).toEqual(expect.objectContaining({
      mode: 'pending',
      required: false,
      state: 'pending_live_discovery',
      pending: true,
      architectRoleDiscovery: 'unknown',
      liveDiscovery: expect.objectContaining({
        ok: false,
        status: 'stale',
        matchedDeviceId: 'VIGIL',
        roles: ['architect'],
      }),
    }));
    expect(snapshot.status.warnings).not.toContain('bridge_connectivity_pending:live_discovery_not_available');
    expect(markdown).toContain('Live Discovery: not verified (stale; source=known-devices-cache; 1500s old; roles=architect)');
    expect(markdown).toContain('Probe: optional pending; penalty=0');
  });

  test('keeps bridge pending and renders known-devices read errors explicitly', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      jestTimeoutMs: 1000,
      bridgeStatus: {
        enabled: true,
        configured: true,
        relayUrl: 'wss://relay.example.test',
        deviceId: 'VIGIL',
        state: 'pending_live_discovery',
        pending: true,
      },
      bridgeDiscovery: {
        ok: false,
        status: 'read_error',
        error: 'Unexpected token',
        devices: [],
      },
    });
    const markdown = renderStartupHealthMarkdown(snapshot);

    expect(snapshot.bridge).toEqual(expect.objectContaining({
      mode: 'pending',
      required: false,
      state: 'pending_live_discovery',
      liveDiscovery: expect.objectContaining({
        ok: false,
        status: 'read_error',
        error: 'Unexpected token',
        roles: [],
      }),
    }));
    expect(snapshot.status.warnings).not.toContain('bridge_connectivity_pending:live_discovery_not_available');
    expect(markdown).toContain('Live Discovery: not verified (read_error; source=known-devices-cache; age unknown; roles=none)');
    expect(markdown).toContain('Live Discovery Error: Unexpected token');
    expect(markdown).toContain('Probe: optional pending; penalty=0');
  });

  test('main can print the compact startup health markdown summary', () => {
    const { main } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };
    const exitCode = main([tempDir, '--markdown'], { stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('STARTUP HEALTH'));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('BRIDGE HEALTH'));
  });

  test('normalizes ui and .squidrun roots back to the project root', () => {
    const { createHealthSnapshot, normalizeProjectRoot } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    expect(normalizeProjectRoot(path.join(tempDir, 'ui'))).toBe(tempDir);
    expect(normalizeProjectRoot(path.join(tempDir, '.squidrun'))).toBe(tempDir);

    const uiSnapshot = createHealthSnapshot({
      projectRoot: path.join(tempDir, 'ui'),
      jestTimeoutMs: 1000,
      env: {},
    });
    const coordSnapshot = createHealthSnapshot({
      projectRoot: path.join(tempDir, '.squidrun'),
      jestTimeoutMs: 1000,
      env: {},
    });

    expect(uiSnapshot.projectRoot).toBe(tempDir);
    expect(uiSnapshot.tests.testFileCount).toBe(2);
    expect(uiSnapshot.modules.moduleFileCount).toBeGreaterThan(0);
    expect(uiSnapshot.databases.evidenceLedger.exists).toBe(true);
    expect(coordSnapshot.projectRoot).toBe(tempDir);
    expect(coordSnapshot.tests.testFileCount).toBe(2);
    expect(coordSnapshot.databases.cognitiveMemory.exists).toBe(true);
  });

  test('renders a compact startup health markdown summary', () => {
    const { renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    const markdown = renderStartupHealthMarkdown({
      generatedAt: '2026-03-17T07:45:00.000Z',
      status: { level: 'ok', warnings: [] },
      tests: {
        testFileCount: 2,
        jestList: { count: 2, ok: true },
      },
      modules: {
        moduleFileCount: 6,
        keyModules: {
          recovery_manager: { exists: true },
          scheduler: { exists: true },
        },
      },
      databases: {
        evidenceLedger: { exists: true, rowCount: 2 },
        cognitiveMemory: { exists: true, rowCount: 1 },
      },
      memoryConsistency: {
        status: 'in_sync',
        synced: true,
        summary: {
          knowledgeEntryCount: 15,
          knowledgeNodeCount: 15,
          missingInCognitiveCount: 0,
          orphanedNodeCount: 0,
          duplicateKnowledgeHashCount: 0,
        },
      },
      bridge: {
        enabled: true,
        configured: true,
        mode: 'connecting',
        relayUrl: 'wss://relay.example.test',
        deviceId: 'LOCAL',
        state: 'disconnected',
      },
      systemCapabilities: {
        localModels: {
          enabled: true,
          sleepExtraction: {
            enabled: true,
            available: true,
            model: 'claude-opus-4-6',
            path: 'anthropic-api',
          },
        },
      },
      codexDesktopCapability: {
        status: 'process_available_not_monitored',
        availability: {
          codexDesktopProcess: {
            status: 'available',
            process_count: 3,
            visible_window_count: 1,
          },
          computerUseAppControl: {
            status: 'known_route',
            source_message_id: 'telegram-in-808498547',
          },
          hmCodexDesktopTransport: {
            can_summon_workspace: true,
            visible_injection_proven: false,
          },
        },
        freshness: {
          attentionInbox: {
            active_count: 2,
            completed_count: 5,
            total_count: 8,
            polling_freshness: 'index_loaded',
          },
        },
      },
    });

    expect(markdown).toContain('STARTUP HEALTH');
    expect(markdown).toContain('Overall: OK');
    expect(markdown).toContain('Generated: 2026-03-17T07:45:00.000Z');
    expect(markdown).toContain('App Session: unknown');
    expect(markdown).toContain('Tests: 2 files, 2 Jest-discoverable suites');
    expect(markdown).toContain('Modules: 6 JS modules under ui/modules');
    expect(markdown).toContain('Evidence ledger DB: present, rows=2');
    expect(markdown).toContain('MEMORY CONSISTENCY');
    expect(markdown).toContain('Sync Status: in_sync (in sync)');
    expect(markdown).toContain('Counts: entries=15, nodes=15, missing=0, orphans=0, duplicates=0');
    expect(markdown).toContain('BRIDGE HEALTH');
    expect(markdown).toContain('Connection: disconnected');
    expect(markdown).toContain('Device ID: LOCAL');
    expect(markdown).toContain('Runtime: mode=connecting, enabled=yes, configured=yes');
    expect(markdown).toContain('CODEX DESKTOP CAPABILITY');
    expect(markdown).toContain('Status: available, not monitored (process_available_not_monitored)');
    expect(markdown).toContain('Process/App: available (processes=3, visible_windows=1)');
    expect(markdown).toContain('App-Control Route: known_route (source=telegram-in-808498547)');
    expect(markdown).toContain('Attention Inbox: active=2, completed=5, total=8, freshness=index_loaded');
    expect(markdown).toContain('Desktop Transport: summon=yes, visible_injection=not_proven');
    expect(markdown).toContain('hm-codex-capability-status');
    expect(markdown).not.toContain('Heartbeat: missing');
    expect(markdown).not.toContain('hm-codex-heartbeat-check');
    expect(markdown).toContain('LOCAL MODELS');
    expect(markdown).toContain('Feature Enabled: yes');
    expect(markdown).toContain('Sleep Extraction: path=anthropic-api, enabled=yes, available=yes, model=claude-opus-4-6');
    expect(markdown).not.toContain('Selected Model');
    expect(markdown).not.toContain('Ollama:');
  });

  test('keeps optional disconnected bridge visible without startup health penalty', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      jestTimeoutMs: 1000,
      bridgeStatus: {
        enabled: true,
        configured: true,
        running: false,
        relayUrl: 'wss://relay.example.test',
        deviceId: 'LOCAL',
        state: 'disconnected',
        status: 'relay_disconnected',
      },
    });

    expect(snapshot.bridge.mode).toBe('connecting');
    expect(snapshot.bridge.required).toBe(false);
    expect(snapshot.status.level).toBe('ok');
    expect(snapshot.status.label).toBe('OK');
    expect(snapshot.status.score).toBe(100);
    expect(snapshot.status.warnings).not.toContain('bridge_enabled_not_connected:disconnected');
    expect(snapshot.status.penalties).not.toContainEqual({ code: 'bridge_enabled_not_connected', points: 15 });
    expect(renderStartupHealthMarkdown(snapshot)).toContain('Probe: optional offline; penalty=0');
  });

  test('degrades startup health when bridge is required but not connected', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      jestTimeoutMs: 1000,
      bridgeStatus: {
        enabled: true,
        required: true,
        configured: true,
        running: false,
        relayUrl: 'wss://relay.example.test',
        deviceId: 'LOCAL',
        state: 'disconnected',
        status: 'relay_disconnected',
      },
    });

    expect(snapshot.bridge.mode).toBe('connecting');
    expect(snapshot.bridge.required).toBe(true);
    expect(snapshot.status.level).toBe('warn');
    expect(snapshot.status.label).toBe('WARN');
    expect(snapshot.status.score).toBe(85);
    expect(snapshot.status.warnings).toContain('bridge_enabled_not_connected:disconnected');
    expect(snapshot.status.penalties).toContainEqual({ code: 'bridge_enabled_not_connected', points: 15 });
    expect(renderStartupHealthMarkdown(snapshot)).toContain('Probe: degraded (required but disconnected); penalty=15');
  });

  test('degrades startup health when memory consistency detects drift', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      jestTimeoutMs: 1000,
      env: {},
      memoryConsistency: {
        ok: true,
        checkedAt: '2026-03-15T00:00:00.000Z',
        status: 'drift_detected',
        synced: false,
        summary: {
          knowledgeEntryCount: 15,
          knowledgeNodeCount: 19,
          missingInCognitiveCount: 2,
          orphanedNodeCount: 6,
          duplicateKnowledgeHashCount: 0,
          issueCount: 0,
        },
      },
    });
    const markdown = renderStartupHealthMarkdown(snapshot);

    expect(snapshot.status.level).toBe('warn');
    expect(snapshot.status.label).toBe('WARN');
    expect(snapshot.status.warnings).toContain('memory_consistency_drift:missing=2,orphans=6,duplicates=0,actions=0,issues=0');
    expect(markdown).toContain('Sync Status: drift_detected (attention needed)');
    expect(markdown).toContain('Counts: entries=15, nodes=19, missing=2, orphans=6, duplicates=0');
  });

  test('keeps review-only memory consistency orphans visible without a startup score penalty', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    const {
      planMemoryConsistencyRepair: currentPlanMemoryConsistencyRepair,
      runMemoryConsistencyCheck: currentRunMemoryConsistencyCheck,
    } = require('../modules/memory-consistency-check');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));
    currentRunMemoryConsistencyCheck.mockReturnValueOnce({
      ok: true,
      checkedAt: '2026-03-15T00:00:00.000Z',
      status: 'drift_detected',
      synced: false,
      summary: {
        knowledgeEntryCount: 167,
        knowledgeNodeCount: 210,
        missingInCognitiveCount: 0,
        orphanedNodeCount: 43,
        duplicateKnowledgeHashCount: 0,
        issueCount: 0,
      },
    });
    currentPlanMemoryConsistencyRepair.mockReturnValueOnce({
      ok: true,
      mode: 'dry_run',
      dryRun: true,
      summary: {
        actionCount: 0,
        insertCount: 0,
        duplicateMergeCount: 0,
        orphanDeleteCount: 0,
        deleteCount: 0,
        skippedCount: 43,
      },
      skippedByKind: {
        relational_migration_required: 31,
        revision_skew_review_required: 3,
        deleted_source_orphan: 9,
      },
      skipped: [
        { kind: 'relational_migration_required', driftType: 'relational_migration_required' },
        { kind: 'revision_skew_review_required', driftType: 'revision_skew_orphan' },
        { kind: 'deleted_source_orphan', driftType: 'deleted_source' },
      ],
    });

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      jestTimeoutMs: 1000,
      env: {},
    });
    const markdown = renderStartupHealthMarkdown(snapshot);

    expect(currentPlanMemoryConsistencyRepair).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: tempDir,
      profileName: 'main',
      sampleLimit: 5,
    }));
    expect(snapshot.status.level).toBe('ok');
    expect(snapshot.status.label).toBe('OK');
    expect(snapshot.status.score).toBe(100);
    expect(snapshot.status.penalties).not.toContainEqual({ code: 'memory_consistency_drift', points: 12 });
    expect(snapshot.status.warnings).toContain('memory_consistency_review_queue:orphans=43,actions=0,skips=43');
    expect(markdown).toContain('Sync Status: drift_detected (attention needed)');
    expect(markdown).toContain('Counts: entries=167, nodes=210, missing=0, orphans=43, duplicates=0');
    expect(markdown).toContain('Review Queue: actions=0, skips=43, insert=0, merge=0, delete=0');
    expect(markdown).toContain('Review Types: relational_migration_required=31, revision_skew_review_required=3, deleted_source_orphan=9');
  });

  test('keeps an unknown memory consistency skipped kind penalized', () => {
    const { createHealthSnapshot } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      jestTimeoutMs: 1000,
      env: {},
      memoryConsistency: {
        ok: true,
        checkedAt: '2026-03-15T00:00:00.000Z',
        status: 'drift_detected',
        synced: false,
        summary: {
          knowledgeEntryCount: 15,
          knowledgeNodeCount: 16,
          missingInCognitiveCount: 0,
          orphanedNodeCount: 2,
          duplicateKnowledgeHashCount: 0,
          issueCount: 0,
        },
        repairPlan: {
          mode: 'dry_run',
          dryRun: true,
          actionCount: 0,
          skippedCount: 2,
          skippedByKind: {
            relational_migration_required: 1,
            mystery_skip_kind: 1,
          },
        },
      },
    });

    expect(snapshot.status.level).toBe('warn');
    expect(snapshot.status.label).toBe('WARN');
    expect(snapshot.status.warnings).toContain('memory_consistency_unclassified_drift:missing=0,orphans=2,duplicates=0,actions=0,issues=0,known_review_skips=no');
    expect(snapshot.status.penalties).toContainEqual({ code: 'memory_consistency_unsynced', points: 10 });
  });

  test('surfaces accepted source-heading residue instead of hiding it behind zero hash duplicates', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      jestTimeoutMs: 1000,
      env: {},
      memoryConsistency: {
        ok: true,
        checkedAt: '2026-03-15T00:00:00.000Z',
        status: 'drift_detected',
        synced: false,
        summary: {
          knowledgeEntryCount: 218,
          knowledgeNodeCount: 218,
          missingInCognitiveCount: 0,
          orphanedNodeCount: 0,
          duplicateKnowledgeHashCount: 0,
          duplicateSourceHeadingCount: 11,
          issueCount: 0,
        },
        repairPlan: {
          mode: 'dry_run',
          dryRun: true,
          actionCount: 0,
          skippedCount: 0,
        },
      },
    });
    const markdown = renderStartupHealthMarkdown(snapshot);

    expect(snapshot.status.level).toBe('warn');
    expect(snapshot.status.label).toBe('WARN');
    expect(snapshot.status.score).toBe(90);
    expect(snapshot.status.warnings).toContain('memory_consistency_accepted_source_heading_residue:source_heading_duplicates=11,actions=0,accepted=yes');
    expect(snapshot.status.warnings).not.toContain(expect.stringContaining('memory_consistency_unclassified_drift'));
    expect(snapshot.status.penalties).toContainEqual({ code: 'memory_consistency_unsynced', points: 10 });
    expect(markdown).toContain('Sync Status: drift_detected (accepted benign residue)');
    expect(markdown).toContain('Counts: entries=218, nodes=218, missing=0, orphans=0, duplicates=0, source_heading_duplicates=11');
    expect(markdown).toContain('Accepted Residue: source_heading_duplicates=11 (positional stable-key residue; no repair action queued)');
  });

  test('writes the startup health markdown artifact on demand', () => {
    const { main } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));
    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };

    const exitCode = main([tempDir, '--markdown', '--write'], { stdout, stderr });
    const outputPath = path.join(tempDir, '.squidrun', 'build', 'startup-health.md');

    expect(exitCode).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain('STARTUP HEALTH');
    expect(stdout.write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(`Wrote startup health artifact: ${outputPath}`);
  });

  test('surfaces a wedged Telegram poller in startup health', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      jestTimeoutMs: 1000,
      env: {},
      telegramPoller: {
        ok: false,
        status: 'stale',
        wedged: true,
        ageMs: 43 * 60 * 1000,
        staleThresholdMs: 10 * 60 * 1000,
        updatedAt: '2026-06-06T04:00:00.000Z',
        statePath: path.join(tempDir, '.squidrun', 'runtime', 'telegram-poller-state.json'),
      },
    });
    const markdown = renderStartupHealthMarkdown(snapshot);

    expect(snapshot.status.label).toBe('WARN');
    expect(snapshot.status.score).toBe(80);
    expect(snapshot.status.warnings).toContain(
      `telegram_poller_wedged:status=stale,age_ms=${43 * 60 * 1000},threshold_ms=${10 * 60 * 1000}`
    );
    expect(snapshot.status.penalties).toContainEqual({ code: 'telegram_poller_wedged', points: 20 });
    expect(markdown).toContain('TELEGRAM POLLER');
    expect(markdown).toContain('- Freshness: stale');
    expect(markdown).toContain('- Recovery: required; hm-startup-health invokes hm-telegram-poller-watchdog recover before rendering this report.');
  });

  test('surfaces a stale supervisor heartbeat in startup health', () => {
    const { createHealthSnapshot, renderStartupHealthMarkdown } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const nowMs = Date.parse('2026-06-06T10:00:00.000Z');
    fs.writeFileSync(
      path.join(tempDir, '.squidrun', 'runtime', 'supervisor-status.json'),
      JSON.stringify({
        pid: process.pid,
        state: 'running',
        pollMs: 4000,
        heartbeatAtMs: nowMs - 60000,
      })
    );

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      nowMs,
      jestTimeoutMs: 1000,
      env: {},
    });
    const markdown = renderStartupHealthMarkdown(snapshot);

    expect(snapshot.supervisor).toEqual(expect.objectContaining({
      status: 'stale',
      stale: true,
      heartbeatAgeMs: 60000,
      freshnessWindowMs: 16000,
      staleReasons: ['heartbeat_stale'],
    }));
    expect(snapshot.status.label).toBe('WARN');
    expect(snapshot.status.score).toBe(88);
    expect(snapshot.status.warnings).toContain(
      'supervisor_heartbeat_stale:status=stale,reasons=heartbeat_stale,age_ms=60000,threshold_ms=16000'
    );
    expect(snapshot.status.penalties).toContainEqual({ code: 'supervisor_heartbeat_stale', points: 12 });
    expect(markdown).toContain('SUPERVISOR HEARTBEAT');
    expect(markdown).toContain('- Freshness: stale');
    expect(markdown).toContain('- Stale Reasons: heartbeat_stale');
  });

  test('keeps a fresh supervisor heartbeat out of startup health warnings', () => {
    const { createHealthSnapshot } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const nowMs = Date.parse('2026-06-06T10:00:00.000Z');
    fs.writeFileSync(
      path.join(tempDir, '.squidrun', 'runtime', 'supervisor-status.json'),
      JSON.stringify({
        pid: process.pid,
        state: 'running',
        pollMs: 4000,
        heartbeatAtMs: nowMs - 1000,
      })
    );

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      nowMs,
      jestTimeoutMs: 1000,
      env: {},
    });

    expect(snapshot.supervisor).toEqual(expect.objectContaining({
      status: 'fresh',
      stale: false,
      heartbeatAgeMs: 1000,
      freshnessWindowMs: 16000,
      staleReasons: [],
    }));
    expect(snapshot.status.score).toBe(100);
    expect(snapshot.status.warnings).not.toContainEqual(expect.stringContaining('supervisor_heartbeat_stale'));
    expect(snapshot.status.penalties).not.toContainEqual(expect.objectContaining({ code: 'supervisor_heartbeat_stale' }));
  });

  test('writes side-profile startup health to the suffixed on-demand artifact path', () => {
    const { main } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));
    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };

    const exitCode = main([tempDir, '--profile', 'eunbyeol', '--json', '--write'], { stdout, stderr });
    const mainPath = path.join(tempDir, '.squidrun', 'build', 'startup-health.md');
    const sidePath = path.join(tempDir, '.squidrun', 'build', 'startup-health-eunbyeol.md');
    const payload = JSON.parse(stdout.write.mock.calls.map(([chunk]) => String(chunk)).join(''));

    expect(exitCode).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(fs.existsSync(mainPath)).toBe(false);
    expect(fs.existsSync(sidePath)).toBe(true);
    expect(payload.writeResult).toEqual(expect.objectContaining({
      ok: true,
      outputPath: sidePath,
    }));
  });

  test('degrades startup health when the memory dry-run has actionable repair work', () => {
    const { createHealthSnapshot } = require('../scripts/hm-health-snapshot');
    execFileSync.mockReturnValue([
      path.join(tempDir, 'ui', '__tests__', 'alpha.test.js'),
      path.join(tempDir, 'ui', '__tests__', 'beta.test.js'),
    ].join('\n'));

    const snapshot = createHealthSnapshot({
      projectRoot: tempDir,
      jestTimeoutMs: 1000,
      env: {},
      memoryConsistency: {
        ok: true,
        checkedAt: '2026-03-15T00:00:00.000Z',
        status: 'drift_detected',
        synced: false,
        summary: {
          knowledgeEntryCount: 15,
          knowledgeNodeCount: 16,
          missingInCognitiveCount: 0,
          orphanedNodeCount: 1,
          duplicateKnowledgeHashCount: 0,
          issueCount: 0,
        },
        repairPlan: {
          mode: 'dry_run',
          dryRun: true,
          actionCount: 1,
          orphanDeleteCount: 1,
          skippedCount: 0,
        },
      },
    });

    expect(snapshot.status.level).toBe('warn');
    expect(snapshot.status.label).toBe('WARN');
    expect(snapshot.status.warnings).toContain('memory_consistency_drift:missing=0,orphans=1,duplicates=0,actions=1,issues=0');
    expect(snapshot.status.penalties).toContainEqual({ code: 'memory_consistency_drift', points: 12 });
  });

  test('exports an explicit startup health scoring contract', () => {
    const {
      HEALTH_SCORE_PENALTIES,
      HEALTH_SCORE_THRESHOLDS,
      getPenaltyPoints,
      resolveHealthThreshold,
    } = require('../scripts/hm-health-snapshot');

    expect(HEALTH_SCORE_THRESHOLDS).toEqual([
      expect.objectContaining({ minScore: 95, level: 'ok', label: 'OK' }),
      expect.objectContaining({ minScore: 80, level: 'warn', label: 'WARN' }),
      expect.objectContaining({ minScore: 60, level: 'degraded', label: 'DEGRADED' }),
      expect.objectContaining({ minScore: 0, level: 'critical', label: 'CRITICAL' }),
    ]);
    expect(HEALTH_SCORE_PENALTIES.bridge_enabled_not_connected).toEqual(expect.objectContaining({
      points: 15,
      category: 'bridge',
    }));
    expect(HEALTH_SCORE_PENALTIES.memory_consistency_drift).toEqual(expect.objectContaining({
      points: 12,
      category: 'memory_consistency',
    }));
    expect(HEALTH_SCORE_PENALTIES.supervisor_heartbeat_stale).toEqual(expect.objectContaining({
      points: 12,
      category: 'supervisor',
    }));
    expect(getPenaltyPoints('missing_key_modules', { count: 2 })).toBe(8);
    expect(resolveHealthThreshold(100)).toEqual(expect.objectContaining({ label: 'OK' }));
    expect(resolveHealthThreshold(85)).toEqual(expect.objectContaining({ label: 'WARN' }));
    expect(resolveHealthThreshold(70)).toEqual(expect.objectContaining({ label: 'DEGRADED' }));
    expect(resolveHealthThreshold(20)).toEqual(expect.objectContaining({ label: 'CRITICAL' }));
  });

  test('falls back to better-sqlite3 when node:sqlite is unavailable', () => {
    jest.resetModules();

    const fakeDb = {
      close: jest.fn(),
    };
    const BetterSqlite3 = jest.fn(() => fakeDb);

    jest.doMock('node:sqlite', () => ({}), { virtual: true });
    jest.doMock('better-sqlite3', () => BetterSqlite3);

    let loadSqliteDriver;
    jest.isolateModules(() => {
      ({ loadSqliteDriver } = require('../scripts/hm-health-snapshot'));
    });

    const driver = loadSqliteDriver();
    expect(driver).toEqual(expect.objectContaining({ name: 'better-sqlite3' }));

    const db = driver.create('fallback-test.sqlite', { readonly: true });
    expect(BetterSqlite3).toHaveBeenCalledWith('fallback-test.sqlite', { readonly: true });
    db.close();
    expect(fakeDb.close).toHaveBeenCalled();
  });

  test('resolves an absolute Windows cmd path when ComSpec is unavailable', () => {
    const { resolveWindowsCmdPath } = require('../scripts/hm-health-snapshot');
    const systemRoot = path.join(tempDir, 'Windows');
    const system32 = path.join(systemRoot, 'System32');
    const cmdPath = path.join(system32, 'cmd.exe');
    fs.mkdirSync(system32, { recursive: true });
    fs.writeFileSync(cmdPath, '');

    expect(resolveWindowsCmdPath({
      SystemRoot: systemRoot,
    })).toBe(cmdPath);
  });
});
