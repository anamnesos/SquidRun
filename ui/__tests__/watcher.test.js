/**
 * Tests for modules/watcher.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function makeState(overrides = {}) {
  return {
    state: 'idle',
    previous_state: null,
    active_agents: [],
    timestamp: new Date().toISOString(),
    project: null,
    current_checkpoint: 0,
    total_checkpoints: 0,
    friction_count: 0,
    error: null,
    claims: {},
    ...overrides,
  };
}

function setupWatcher(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-watcher-'));
  const configMock = {
    WORKSPACE_PATH: tempDir,
    TRIGGER_TARGETS: { 'lead.txt': ['1'] },
    PANE_IDS: ['1', '2'],
    PANE_ROLES: {
      '1': 'Architect',
      '2': 'Orchestrator',
    },
    ...options.configOverrides,
  };

  const logMock = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const workerInstances = [];
  const createWorkerInstance = () => {
    const handlers = new Map();
    const instance = {
      on: jest.fn((eventName, handler) => {
        handlers.set(eventName, handler);
        return instance;
      }),
      kill: jest.fn(),
      emit: (eventName, ...args) => {
        const handler = handlers.get(eventName);
        if (typeof handler === 'function') {
          handler(...args);
        }
      },
    };
    return instance;
  };
  const childProcessMock = {
    fork: jest.fn(() => {
      const instance = createWorkerInstance();
      workerInstances.push(instance);
      return instance;
    }),
  };

  jest.resetModules();
  jest.doMock('../config', () => configMock);
  jest.doMock('../modules/logger', () => logMock);
  jest.doMock('child_process', () => childProcessMock);

  const watcher = require('../modules/watcher');

  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: jest.fn() },
  };

  const triggers = {
    notifyAgents: jest.fn(),
    notifyAllAgentsSync: jest.fn(),
    handleTriggerFile: jest.fn(),
    onDeliveryAck: jest.fn(),
  };
  let deliveryAckListener = null;
  triggers.onDeliveryAck.mockImplementation((listener) => {
    deliveryAckListener = listener;
    return () => {
      if (deliveryAckListener === listener) {
        deliveryAckListener = null;
      }
    };
  });

  const settingsGetter = options.settingsGetter || (() => ({ autoSync: true }));
  watcher.init(mainWindow, triggers, settingsGetter);

  return {
    tempDir,
    watcher,
    logMock,
    childProcessMock,
    workerInstances,
    getWorker: (index = 0) => workerInstances[index],
    emitDeliveryAck: (deliveryId, paneId) => {
      if (typeof deliveryAckListener === 'function') {
        deliveryAckListener(deliveryId, paneId);
      }
    },
    mainWindow,
    triggers,
    configMock,
  };
}

function cleanupDir(tempDir) {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

describe('watcher module', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('readState returns defaults when state file missing', () => {
    const { watcher, tempDir } = setupWatcher();

    const state = watcher.readState();

    expect(state.state).toBe(watcher.States.IDLE);
    expect(state.project).toBeNull();

    cleanupDir(tempDir);
  });

  test('writeState writes file and readState returns it', () => {
    const { watcher, tempDir } = setupWatcher();
    const state = makeState({ state: watcher.States.PLANNING });

    watcher.writeState(state);
    const readBack = watcher.readState();

    expect(readBack.state).toBe(watcher.States.PLANNING);

    cleanupDir(tempDir);
  });

  test('transition updates state and notifies renderer and agents', () => {
    const { watcher, tempDir, mainWindow, triggers } = setupWatcher();
    watcher.writeState(makeState({ state: watcher.States.PLANNING }));

    watcher.transition(watcher.States.PLAN_REVIEW);
    const updated = watcher.readState();

    expect(updated.state).toBe(watcher.States.PLAN_REVIEW);
    expect(updated.previous_state).toBe(watcher.States.PLANNING);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('state-changed', expect.any(Object));
    expect(triggers.notifyAgents).toHaveBeenCalledWith(
      watcher.ACTIVE_AGENTS[watcher.States.PLAN_REVIEW],
      watcher.CONTEXT_MESSAGES[watcher.States.PLAN_REVIEW],
    );

    cleanupDir(tempDir);
  });

  test('checkFileConflicts detects overlapping assignments', () => {
    const { watcher, tempDir, mainWindow } = setupWatcher();
    const sharedContextPath = path.join(tempDir, 'shared_context.md');

    fs.writeFileSync(sharedContextPath, [
      '### Frontend',
      '- `ui/modules/foo.js`',
      '',
      '### Backend',
      '- `ui/modules/foo.js`',
    ].join('\n'));

    const conflicts = watcher.checkFileConflicts();

    expect(conflicts.length).toBe(1);
    expect(conflicts[0].file).toBe('ui/modules/foo.js');
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('file-conflict', conflicts);

    cleanupDir(tempDir);
  });

  test('message queue lifecycle works', async () => {
    const { watcher, tempDir, mainWindow } = setupWatcher();

    const initResult = await watcher.initMessageQueue();
    expect(initResult.success).toBe(true);

    const queueFile = path.join(watcher.MESSAGE_QUEUE_DIR, 'queue-1.json');
    expect(fs.existsSync(queueFile)).toBe(true);

    const sendResult = await watcher.sendMessage('1', '2', 'Hello');
    expect(sendResult.success).toBe(true);

    const messages = await watcher.getMessages('2');
    expect(messages.length).toBe(1);

    const deliver = await watcher.markMessageDelivered('2', messages[0].id);
    expect(deliver.success).toBe(true);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'message-delivered',
      expect.objectContaining({ paneId: '2', messageId: messages[0].id }),
    );

    const undelivered = await watcher.getMessages('2', true);
    expect(undelivered.length).toBe(0);

    const cleared = await watcher.clearMessages('2');
    expect(cleared.success).toBe(true);

    cleanupDir(tempDir);
  });

  test('getMessages recovers from corrupted queue JSON and resets queue file', async () => {
    const { watcher, tempDir, logMock } = setupWatcher();
    await watcher.initMessageQueue();
    const queueFile = path.join(watcher.MESSAGE_QUEUE_DIR, 'queue-1.json');
    fs.writeFileSync(queueFile, '{invalid-json', 'utf-8');

    const messages = await watcher.getMessages('1');

    expect(messages).toEqual([]);
    expect(logMock.error).toHaveBeenCalledWith(
      'MessageQueue',
      expect.stringContaining(`Corrupted queue file ${queueFile}; resetting queue`),
      expect.any(Error)
    );
    expect(fs.readFileSync(queueFile, 'utf-8').trim()).toBe('[]');

    const sendResult = await watcher.sendMessage('1', '1', 'Recovered queue');
    expect(sendResult.success).toBe(true);

    cleanupDir(tempDir);
  });

  test('handleFileChangeDebounced triggers transitions and auto-sync', () => {
    jest.useFakeTimers();
    const { watcher, tempDir, triggers } = setupWatcher();

    watcher.writeState(makeState({ state: watcher.States.PLANNING }));
    watcher.handleFileChange(path.join(tempDir, 'plan.md'));

    jest.advanceTimersByTime(250);

    const updated = watcher.readState();
    expect(updated.state).toBe(watcher.States.PLAN_REVIEW);

    watcher.handleFileChange(path.join(tempDir, 'improvements.md'));
    jest.advanceTimersByTime(250);
    expect(triggers.notifyAllAgentsSync).toHaveBeenCalledWith('improvements.md');

    cleanupDir(tempDir);
  });

  test('trigger files route to triggers module', () => {
    jest.useFakeTimers();
    const { watcher, tempDir, triggers } = setupWatcher();
    const triggerPath = path.join(tempDir, 'triggers');
    fs.mkdirSync(triggerPath, { recursive: true });
    const triggerFile = path.join(triggerPath, 'lead.txt');
    fs.writeFileSync(triggerFile, 'Ping', 'utf-8');

    watcher.handleFileChange(triggerFile);
    jest.advanceTimersByTime(250);

    expect(triggers.handleTriggerFile).toHaveBeenCalledWith(triggerFile, 'lead.txt');

    cleanupDir(tempDir);
  });

  test('trigger files wait for stable size before routing', () => {
    jest.useFakeTimers();
    const { watcher, tempDir, triggers } = setupWatcher();
    const triggerPath = path.join(tempDir, 'triggers');
    fs.mkdirSync(triggerPath, { recursive: true });
    const triggerFile = path.join(triggerPath, 'lead.txt');
    fs.writeFileSync(triggerFile, 'Ping', 'utf-8');

    const realStatSync = fs.statSync.bind(fs);
    const resolvedTriggerFile = path.resolve(triggerFile);
    let observedCount = 0;
    const statSpy = jest.spyOn(fs, 'statSync').mockImplementation((filePath) => {
      if (path.resolve(filePath) === resolvedTriggerFile) {
        observedCount += 1;
        if (observedCount === 1) return { size: 2 };
        if (observedCount === 2) return { size: 4 };
        return { size: 4 };
      }
      return realStatSync(filePath);
    });

    watcher.handleFileChange(triggerFile);
    jest.advanceTimersByTime(350); // 200ms debounce + 2x trigger retry (50ms each)

    expect(triggers.handleTriggerFile).toHaveBeenCalledWith(triggerFile, 'lead.txt');
    expect(observedCount).toBeGreaterThanOrEqual(3);

    statSpy.mockRestore();
    cleanupDir(tempDir);
  });

  test('claimAgent prevents duplicate claims and clearClaims resets', () => {
    const { watcher, tempDir, mainWindow } = setupWatcher();

    const first = watcher.claimAgent('1', 'task-alpha');
    expect(first.success).toBe(true);

    const duplicate = watcher.claimAgent('2', 'task-alpha');
    expect(duplicate.success).toBe(false);
    expect(duplicate.error).toMatch(/already claimed/i);

    const cleared = watcher.clearClaims();
    expect(cleared.success).toBe(true);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('claims-changed', {});

    cleanupDir(tempDir);
  });

  test('releaseAgent succeeds even when no claim exists', () => {
    const { watcher, tempDir } = setupWatcher();

    const result = watcher.releaseAgent('2');
    expect(result.success).toBe(true);

    cleanupDir(tempDir);
  });

  test('handleFileChange branches for plan-approved and plan-feedback', () => {
    jest.useFakeTimers();
    const { watcher, tempDir } = setupWatcher();

    watcher.writeState(makeState({ state: watcher.States.PLAN_REVIEW }));
    const planApprovedPath = path.join(tempDir, 'plan-approved.md');
    fs.writeFileSync(planApprovedPath, 'Approved', 'utf-8');
    watcher.handleFileChange(planApprovedPath);
    jest.advanceTimersByTime(250);
    expect(watcher.readState().state).toBe(watcher.States.EXECUTING);

    watcher.writeState(makeState({ state: watcher.States.PLAN_REVIEW }));
    const planFeedbackPath = path.join(tempDir, 'plan-feedback.md');
    fs.writeFileSync(planFeedbackPath, 'Needs revisions', 'utf-8');
    watcher.handleFileChange(planFeedbackPath);
    jest.advanceTimersByTime(250);
    expect(watcher.readState().state).toBe(watcher.States.PLAN_REVISION);

    cleanupDir(tempDir);
  });

  test('checkpoint-approved content drives completion', () => {
    jest.useFakeTimers();
    const { watcher, tempDir } = setupWatcher();

    watcher.writeState(makeState({ state: watcher.States.CHECKPOINT_REVIEW }));
    const approvedPath = path.join(tempDir, 'checkpoint-approved.md');
    fs.writeFileSync(approvedPath, 'Complete ✅', 'utf-8');
    watcher.handleFileChange(approvedPath);
    jest.advanceTimersByTime(250);
    expect(watcher.readState().state).toBe(watcher.States.COMPLETE);

    cleanupDir(tempDir);
  });

  test('friction file triggers logged/sync states', () => {
    jest.useFakeTimers();
    const { watcher, tempDir } = setupWatcher();

    watcher.writeState(makeState({ state: watcher.States.EXECUTING }));
    const frictionPath = path.join(tempDir, 'friction', 'issue.md');
    fs.mkdirSync(path.dirname(frictionPath), { recursive: true });
    fs.writeFileSync(frictionPath, 'Issue', 'utf-8');

    watcher.handleFileChange(frictionPath);
    jest.advanceTimersByTime(250);
    expect(watcher.readState().state).toBe(watcher.States.FRICTION_LOGGED);

    jest.advanceTimersByTime(600);
    expect(watcher.readState().state).toBe(watcher.States.FRICTION_SYNC);

    cleanupDir(tempDir);
  });

  test('auto-sync disabled skips notifyAllAgentsSync', () => {
    jest.useFakeTimers();
    const { watcher, tempDir, triggers } = setupWatcher({
      settingsGetter: () => ({ autoSync: false }),
    });

    watcher.handleFileChange(path.join(tempDir, 'shared_context.md'));
    jest.advanceTimersByTime(250);
    expect(triggers.notifyAllAgentsSync).not.toHaveBeenCalled();

    cleanupDir(tempDir);
  });

  test('startWatcher forks worker process and stopWatcher kills it', () => {
    const { watcher, childProcessMock, getWorker, tempDir } = setupWatcher();

    watcher.startWatcher();
    const workerInstance = getWorker(0);
    expect(childProcessMock.fork).toHaveBeenCalledWith(
      expect.stringContaining('watcher-worker.js'),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          SQUIDRUN_WATCHER_NAME: 'workspace',
        }),
      })
    );

    watcher.stopWatcher();
    expect(workerInstance.kill).toHaveBeenCalled();

    cleanupDir(tempDir);
  });

  test('startWatcher restarts existing workspace worker on repeated start', () => {
    const { watcher, childProcessMock, getWorker, tempDir } = setupWatcher();

    watcher.startWatcher();
    const firstWorker = getWorker(0);
    watcher.startWatcher();
    expect(firstWorker.kill).toHaveBeenCalledTimes(1);
    expect(childProcessMock.fork).toHaveBeenCalledTimes(2);

    cleanupDir(tempDir);
  });

  test('getLastConflicts returns cached conflicts', () => {
    const { watcher, tempDir } = setupWatcher();
    const sharedContextPath = path.join(tempDir, 'shared_context.md');

    fs.writeFileSync(sharedContextPath, [
      '### Frontend',
      '- `ui/modules/bar.js`',
      '',
      '### Backend',
      '- `ui/modules/bar.js`',
    ].join('\n'));

    watcher.checkFileConflicts();
    const conflicts = watcher.getLastConflicts();

    expect(conflicts.length).toBe(1);
    expect(conflicts[0].file).toBe('ui/modules/bar.js');

    cleanupDir(tempDir);
  });

  test('getClaims returns claims from state', () => {
    const { watcher, tempDir } = setupWatcher();

    watcher.claimAgent('1', 'task-1');
    const claims = watcher.getClaims();

    expect(claims['1']).toBeDefined();
    expect(claims['1'].taskId).toBe('task-1');

    cleanupDir(tempDir);
  });

  test('getMessageQueueStatus returns queue summary', async () => {
    const { watcher, tempDir } = setupWatcher();
    await watcher.initMessageQueue();
    await watcher.sendMessage('1', '2', 'Hello');

    const status = await watcher.getMessageQueueStatus();

    expect(status.totalMessages).toBeGreaterThanOrEqual(1);
    expect(status.queues['2']).toBeDefined();
    expect(status.queues['2'].total).toBeGreaterThanOrEqual(1);

    cleanupDir(tempDir);
  });

  test('startTriggerWatcher and stopTriggerWatcher work', () => {
    const { watcher, tempDir, childProcessMock, getWorker } = setupWatcher();

    watcher.startTriggerWatcher();
    const workerInstance = getWorker(0);
    expect(childProcessMock.fork).toHaveBeenCalledWith(
      expect.stringContaining('watcher-worker.js'),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          SQUIDRUN_WATCHER_NAME: 'trigger',
        }),
      })
    );

    watcher.stopTriggerWatcher();
    expect(workerInstance.kill).toHaveBeenCalled();

    cleanupDir(tempDir);
  });

  test('startMessageWatcher and stopMessageWatcher work', async () => {
    const { watcher, tempDir, childProcessMock, getWorker } = setupWatcher();

    await watcher.startMessageWatcher();
    const workerInstance = getWorker(0);
    expect(childProcessMock.fork).toHaveBeenCalledWith(
      expect.stringContaining('watcher-worker.js'),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          SQUIDRUN_WATCHER_NAME: 'message',
        }),
      })
    );

    watcher.stopMessageWatcher();
    expect(workerInstance.kill).toHaveBeenCalled();

    cleanupDir(tempDir);
  });

  test('message queue waits for delivery ack before marking delivered', async () => {
    const { watcher, tempDir, triggers, getWorker, emitDeliveryAck } = setupWatcher();
    await watcher.initMessageQueue();
    await watcher.sendMessage('1', '2', 'Deliver after ack');
    triggers.notifyAgents.mockReturnValue(['2']);

    await watcher.startMessageWatcher();
    const worker = getWorker(0);
    const queuePath = path.join(watcher.MESSAGE_QUEUE_DIR, 'queue-2.json');

    worker.emit('message', { watcherName: 'message', type: 'change', path: queuePath });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(triggers.notifyAgents).toHaveBeenCalledWith(
      ['2'],
      '[MSG from Architect]: Deliver after ack',
      expect.objectContaining({ deliveryId: expect.any(String) })
    );
    expect(await watcher.getMessages('2', true)).toHaveLength(1);

    const deliveryId = triggers.notifyAgents.mock.calls[0][2].deliveryId;
    emitDeliveryAck(deliveryId, '2');

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await watcher.getMessages('2', true)).toHaveLength(0);
    watcher.stopMessageWatcher();
    cleanupDir(tempDir);
  });

  test('message queue retries when delivery cannot be routed', async () => {
    const { watcher, tempDir, triggers, getWorker } = setupWatcher();
    await watcher.initMessageQueue();
    await watcher.sendMessage('1', '2', 'Retry route');
    triggers.notifyAgents.mockReturnValue([]);

    await watcher.startMessageWatcher();
    const worker = getWorker(0);
    const queuePath = path.join(watcher.MESSAGE_QUEUE_DIR, 'queue-2.json');
    worker.emit('message', { watcherName: 'message', type: 'change', path: queuePath });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(triggers.notifyAgents).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(triggers.notifyAgents).toHaveBeenCalledTimes(2);
    expect(await watcher.getMessages('2', true)).toHaveLength(1);

    watcher.stopMessageWatcher();
    cleanupDir(tempDir);
  });

  test('message queue drops pending delivery after max retry attempts', async () => {
    const realSetTimeout = global.setTimeout;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn, delay, ...args) => (
      realSetTimeout(fn, Math.min(Number(delay) || 0, 1), ...args)
    ));

    try {
      const { watcher, tempDir, triggers, getWorker, logMock } = setupWatcher();
      await watcher.initMessageQueue();
      await watcher.sendMessage('1', '2', 'Retry exhaustion');
      triggers.notifyAgents.mockReturnValue([]);

      await watcher.startMessageWatcher();
      const worker = getWorker(0);
      const queuePath = path.join(watcher.MESSAGE_QUEUE_DIR, 'queue-2.json');
      worker.emit('message', { watcherName: 'message', type: 'change', path: queuePath });

      await new Promise((resolve) => realSetTimeout(resolve, 300));
      expect(triggers.notifyAgents).toHaveBeenCalledTimes(10);
      expect(await watcher.getMessages('2', true)).toHaveLength(1);

      const dropLogs = logMock.warn.mock.calls.filter(
        ([scope, message]) =>
          scope === 'MessageQueue' && String(message).includes('Dropping pending delivery')
      );
      expect(dropLogs.length).toBeGreaterThan(0);

      await new Promise((resolve) => realSetTimeout(resolve, 50));
      expect(triggers.notifyAgents).toHaveBeenCalledTimes(10);

      watcher.stopMessageWatcher();
      cleanupDir(tempDir);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test('markMessageDelivered returns error for missing queue', async () => {
    const { watcher, tempDir } = setupWatcher();

    const result = await watcher.markMessageDelivered('99', 'msg-123');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);

    cleanupDir(tempDir);
  });

  test('markMessageDelivered returns error for missing message', async () => {
    const { watcher, tempDir } = setupWatcher();
    await watcher.initMessageQueue();

    const result = await watcher.markMessageDelivered('1', 'nonexistent-msg');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);

    cleanupDir(tempDir);
  });

  test('clearMessages with deliveredOnly preserves undelivered', async () => {
    const { watcher, tempDir } = setupWatcher();
    await watcher.initMessageQueue();

    await watcher.sendMessage('1', '2', 'Message 1');
    await watcher.sendMessage('1', '2', 'Message 2');
    const messages = await watcher.getMessages('2');
    await watcher.markMessageDelivered('2', messages[0].id);

    await watcher.clearMessages('2', true);

    const remaining = await watcher.getMessages('2');
    expect(remaining.length).toBe(1);
    expect(remaining[0].content).toBe('Message 2');

    cleanupDir(tempDir);
  });

  test('clearMessages with all clears all panes', async () => {
    const { watcher, tempDir } = setupWatcher();
    await watcher.initMessageQueue();

    await watcher.sendMessage('1', '1', 'Pane 1');
    await watcher.sendMessage('2', '2', 'Pane 2');

    await watcher.clearMessages('all');

    expect((await watcher.getMessages('1')).length).toBe(0);
    expect((await watcher.getMessages('2')).length).toBe(0);

    cleanupDir(tempDir);
  });

  test('transition to same state is ignored', () => {
    const { watcher, tempDir, mainWindow } = setupWatcher();
    watcher.writeState(makeState({ state: watcher.States.IDLE }));
    mainWindow.webContents.send.mockClear();

    watcher.transition(watcher.States.IDLE);

    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('state-changed', expect.any(Object));

    cleanupDir(tempDir);
  });

  test('checkFileConflicts returns empty when no shared context', () => {
    const { watcher, tempDir } = setupWatcher();

    const conflicts = watcher.checkFileConflicts();

    expect(conflicts).toEqual([]);

    cleanupDir(tempDir);
  });

  test('checkpoint.md during EXECUTING triggers CHECKPOINT and CHECKPOINT_REVIEW', () => {
    jest.useFakeTimers();
    const { watcher, tempDir } = setupWatcher();
    watcher.writeState(makeState({ state: watcher.States.EXECUTING }));

    const checkpointPath = path.join(tempDir, 'checkpoint.md');
    fs.writeFileSync(checkpointPath, 'Checkpoint reached', 'utf-8');

    watcher.handleFileChange(checkpointPath);
    jest.advanceTimersByTime(250);

    expect(watcher.readState().state).toBe(watcher.States.CHECKPOINT);

    jest.advanceTimersByTime(600);
    expect(watcher.readState().state).toBe(watcher.States.CHECKPOINT_REVIEW);

    cleanupDir(tempDir);
  });

  test('checkpoint-issues triggers CHECKPOINT_FIX', () => {
    jest.useFakeTimers();
    const { watcher, tempDir } = setupWatcher();
    watcher.writeState(makeState({ state: watcher.States.CHECKPOINT_REVIEW }));

    const issuesPath = path.join(tempDir, 'checkpoint-issues.md');
    fs.writeFileSync(issuesPath, 'Issues found', 'utf-8');

    watcher.handleFileChange(issuesPath);
    jest.advanceTimersByTime(250);

    expect(watcher.readState().state).toBe(watcher.States.CHECKPOINT_FIX);

    cleanupDir(tempDir);
  });

  test('plan.md during PLAN_REVISION triggers PLAN_REVIEW', () => {
    jest.useFakeTimers();
    const { watcher, tempDir } = setupWatcher();
    watcher.writeState(makeState({ state: watcher.States.PLAN_REVISION }));

    const planPath = path.join(tempDir, 'plan.md');
    fs.writeFileSync(planPath, 'Revised plan', 'utf-8');

    watcher.handleFileChange(planPath);
    jest.advanceTimersByTime(250);

    expect(watcher.readState().state).toBe(watcher.States.PLAN_REVIEW);

    cleanupDir(tempDir);
  });

  // NOTE: This test validates the FIX in watcher.js (specific check before general)
  // The friction-resolution.md -> PLAN_REVIEW transition is now reachable.
  test('friction-resolution.md during FRICTION_RESOLUTION transitions to PLAN_REVIEW (FIX)', () => {
    jest.useFakeTimers();
    const { watcher, tempDir } = setupWatcher();
    watcher.writeState(makeState({ state: watcher.States.FRICTION_RESOLUTION }));

    const resolutionPath = path.join(tempDir, 'friction-resolution.md');
    fs.writeFileSync(resolutionPath, 'Resolution', 'utf-8');

    watcher.handleFileChange(resolutionPath);
    jest.advanceTimersByTime(250);

    // FIX: Correctly transitions to PLAN_REVIEW after condition reordering
    expect(watcher.readState().state).toBe(watcher.States.PLAN_REVIEW);

    cleanupDir(tempDir);
  });

  test('addWatch and removeWatch manage custom file callbacks', () => {
    jest.useFakeTimers();
    const { watcher, tempDir } = setupWatcher();
    const testFile = path.join(tempDir, 'custom.txt');
    const callback = jest.fn();

    // Add watch
    const added = watcher.addWatch(testFile, callback);
    expect(added).toBe(true);

    // Trigger change
    watcher.handleFileChange(testFile);
    jest.advanceTimersByTime(250);

    expect(callback).toHaveBeenCalledWith(testFile);

    // Remove watch
    const removed = watcher.removeWatch(testFile);
    expect(removed).toBe(true);

    // Trigger change again
    callback.mockClear();
    watcher.handleFileChange(testFile);
    jest.advanceTimersByTime(250);

    expect(callback).not.toHaveBeenCalled();

    cleanupDir(tempDir);
  });

  test('setExternalNotifier registers notification callback', () => {
    const { watcher, tempDir } = setupWatcher();
    const notifier = jest.fn();

    watcher.setExternalNotifier(notifier);

    // Trigger a transition that calls notifier (e.g. to COMPLETE)
    watcher.transition(watcher.States.COMPLETE);

    expect(notifier).toHaveBeenCalledWith(expect.objectContaining({
      category: 'completion',
      meta: { state: watcher.States.COMPLETE }
    }));

    cleanupDir(tempDir);
  });
});
