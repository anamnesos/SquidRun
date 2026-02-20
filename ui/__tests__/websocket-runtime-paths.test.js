const fs = require('fs');
const os = require('os');
const path = require('path');

const { setProjectRoot, resetProjectRoot } = require('../config');
const websocketRuntime = require('../modules/websocket-runtime');

function queuePathForProject(projectRoot) {
  return path.join(path.resolve(projectRoot), '.squidrun', 'state', 'comms-outbound-queue.json');
}

function readQueueEntries(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.entries)) return parsed.entries;
  return [];
}

describe('websocket runtime queue path resolution', () => {
  let projectA;
  let projectB;
  let previousQueueEnvPath;

  beforeEach(() => {
    projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-ws-path-a-'));
    projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-ws-path-b-'));
    previousQueueEnvPath = process.env.HIVEMIND_COMMS_QUEUE_FILE;
    delete process.env.HIVEMIND_COMMS_QUEUE_FILE;
  });

  afterEach(async () => {
    await websocketRuntime.stop();
    resetProjectRoot();
    if (typeof previousQueueEnvPath === 'string') {
      process.env.HIVEMIND_COMMS_QUEUE_FILE = previousQueueEnvPath;
    } else {
      delete process.env.HIVEMIND_COMMS_QUEUE_FILE;
    }
    if (projectA) fs.rmSync(projectA, { recursive: true, force: true });
    if (projectB) fs.rmSync(projectB, { recursive: true, force: true });
  });

  test('updates outbound queue file path after project root changes', () => {
    setProjectRoot(projectA);
    const queuePathA = queuePathForProject(projectA);
    const queuePathB = queuePathForProject(projectB);

    const queuedA = websocketRuntime.sendToTarget('builder', 'queued-a', { from: 'architect' });
    expect(queuedA).toBe(false);
    expect(fs.existsSync(queuePathA)).toBe(true);
    expect(readQueueEntries(queuePathA).map((entry) => entry.content)).toEqual(['queued-a']);

    setProjectRoot(projectB);
    const queuedB = websocketRuntime.sendToTarget('builder', 'queued-b', { from: 'architect' });
    expect(queuedB).toBe(false);
    expect(fs.existsSync(queuePathB)).toBe(true);
    expect(readQueueEntries(queuePathB).map((entry) => entry.content)).toEqual(['queued-a', 'queued-b']);
    expect(readQueueEntries(queuePathA).map((entry) => entry.content)).toEqual(['queued-a']);
  });
});
