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
});
