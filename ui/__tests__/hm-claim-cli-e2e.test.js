const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

process.env.HIVEMIND_COMMS_QUEUE_FILE = process.env.HIVEMIND_COMMS_QUEUE_FILE
  || path.join(os.tmpdir(), `hivemind-comms-queue-${process.pid}-${Date.now()}.json`);

const websocketRuntime = require('../modules/websocket-runtime');
const teamMemory = require('../modules/team-memory');
const { loadSqliteDriver } = require('../modules/team-memory/store');
const execFileAsync = promisify(execFile);

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

async function runHmClaimCli(port, args = []) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-claim.js');
  const result = await execFileAsync(process.execPath, [
    scriptPath,
    ...args,
    '--port',
    String(port),
    '--timeout',
    '5000',
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });

  return JSON.parse(String(result.stdout || '{}').trim() || '{}');
}

maybeDescribe('hm-claim CLI e2e', () => {
  let port;
  let tempDir;
  let dbPath;

  beforeAll(async () => {
    await websocketRuntime.start({
      port: 0,
      onMessage: async (data = {}) => {
        const message = data.message || {};
        if (message.type !== 'team-memory') {
          return { ok: true, status: 'ignored' };
        }
        return teamMemory.executeTeamMemoryOperation(
          message.action,
          message.payload || {},
          {
            useWorker: false,
            source: {
              via: 'test',
              role: data.role || 'test',
            },
          }
        );
      },
    });
    port = websocketRuntime.getPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await websocketRuntime.stop();
    await teamMemory.closeTeamMemoryRuntime({ useWorker: false });
  });

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-hm-claim-e2e-'));
    dbPath = path.join(tempDir, 'team-memory.sqlite');
    const init = await teamMemory.initializeTeamMemoryRuntime({
      useWorker: false,
      forceRuntimeRecreate: true,
      recreateUnavailable: true,
      runtimeOptions: {
        storeOptions: {
          dbPath,
        },
      },
    });
    expect(init.ok).toBe(true);
  });

  afterEach(async () => {
    await teamMemory.closeTeamMemoryRuntime({ useWorker: false });
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('query with --limit returns claims when since/until flags are omitted', async () => {
    const createResult = await runHmClaimCli(port, [
      'create',
      '--statement',
      'hm-claim CLI regression sentinel',
      '--owner',
      'builder',
      '--scope',
      'ui/modules/team-memory/claims.js',
    ]);

    expect(createResult.ok).toBe(true);
    expect(createResult.claim).toBeTruthy();

    const queryResult = await runHmClaimCli(port, [
      'query',
      '--limit',
      '5',
    ]);

    expect(queryResult.ok).toBe(true);
    expect(queryResult.total).toBeGreaterThan(0);
    expect(Array.isArray(queryResult.claims)).toBe(true);
    expect(
      queryResult.claims.some((claim) => claim.statement === 'hm-claim CLI regression sentinel')
    ).toBe(true);
  });

  test('contradictions soft-hide resolved rows by default and can include history with --active-only false', async () => {
    const session = 's_cli_contradictions';
    const scope = 'team-memory.pattern-hook';

    const fact = await teamMemory.executeTeamMemoryOperation('create-claim', {
      statement: 'delivery verified',
      owner: 'oracle',
      claimType: 'fact',
      session,
      scopes: [scope],
    }, { useWorker: false });
    expect(fact.ok).toBe(true);

    const negative = await teamMemory.executeTeamMemoryOperation('create-claim', {
      statement: 'delivery timed out',
      owner: 'oracle',
      claimType: 'negative',
      session,
      scopes: [scope],
    }, { useWorker: false });
    expect(negative.ok).toBe(true);

    const snapshot = await teamMemory.executeTeamMemoryOperation('create-belief-snapshot', {
      agent: 'oracle',
      session,
    }, { useWorker: false });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.contradictions.count).toBeGreaterThanOrEqual(1);

    const deprecated = await teamMemory.executeTeamMemoryOperation('deprecate-claim', {
      claimId: negative.claim.id,
      changedBy: 'architect',
      reason: 'superseded',
    }, { useWorker: false });
    expect(deprecated.ok).toBe(true);

    const activeOnly = await runHmClaimCli(port, [
      'contradictions',
      '--agent',
      'oracle',
      '--session',
      session,
    ]);
    expect(activeOnly.ok).toBe(true);
    expect(activeOnly.total).toBe(0);

    const includeResolved = await runHmClaimCli(port, [
      'contradictions',
      '--agent',
      'oracle',
      '--session',
      session,
      '--active-only',
      'false',
    ]);
    expect(includeResolved.ok).toBe(true);
    expect(includeResolved.total).toBeGreaterThanOrEqual(1);
    expect(includeResolved.contradictions.every((entry) => Number.isFinite(entry.resolvedAt))).toBe(true);
  });
});
