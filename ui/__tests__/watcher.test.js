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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-watcher-'));
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

  const watcherInstance = { on: jest.fn().mockReturnThis(), close: jest.fn() };
  const chokidarMock = { watch: jest.fn(() => watcherInstance) };

  jest.resetModules();
  jest.doMock('../config', () => configMock);
  jest.doMock('../modules/logger', () => logMock);
  jest.doMock('chokidar', () => chokidarMock);

  const watcher = require('../modules/watcher');

  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: jest.fn() },
  };

  const triggers = {
    notifyAgents: jest.fn(),
    notifyAllAgentsSync: jest.fn(),
    handleTriggerFile: jest.fn(),
  };

  const settingsGetter = options.settingsGetter || (() => ({ autoSync: true }));
  watcher.init(mainWindow, triggers, settingsGetter);

  return {
    tempDir,
    watcher,
    logMock,
    chokidarMock,
    watcherInstance,
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
      '### Implementer A',
      '- `ui/modules/foo.js`',
      '',
      '### Implementer B',
      '- `ui/modules/foo.js`',
    ].join('\n'));

    const conflicts = watcher.checkFileConflicts();

    expect(conflicts.length).toBe(1);
    expect(conflicts[0].file).toBe('ui/modules/foo.js');
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('file-conflicts-detected', conflicts);

    cleanupDir(tempDir);
  });

  test('conflict queue grants locks and releases to next', () => {
    const { watcher, tempDir, mainWindow } = setupWatcher();
    mainWindow.webContents.send.mockClear();

    const first = watcher.requestFileAccess('ui/app.js', '1', 'write');
    const second = watcher.requestFileAccess('ui/app.js', '2', 'write');

    expect(first.granted).toBe(true);
    expect(second.granted).toBe(false);
    expect(second.position).toBe(1);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'conflict-queued',
      expect.objectContaining({ filePath: 'ui/app.js', paneId: '2', position: 1 }),
    );

    const release = watcher.releaseFileAccess('ui/app.js', '1');
    expect(release.released).toBe(true);
    expect(release.nextInQueue.paneId).toBe('2');
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'conflict-resolved',
      expect.objectContaining({ filePath: 'ui/app.js', paneId: '2' }),
    );

    cleanupDir(tempDir);
  });

  test('message queue lifecycle works', () => {
    const { watcher, tempDir, mainWindow } = setupWatcher();

    const initResult = watcher.initMessageQueue();
    expect(initResult.success).toBe(true);

    const queueFile = path.join(watcher.MESSAGE_QUEUE_DIR, 'queue-1.json');
    expect(fs.existsSync(queueFile)).toBe(true);

    const sendResult = watcher.sendMessage('1', '2', 'Hello');
    expect(sendResult.success).toBe(true);

    const messages = watcher.getMessages('2');
    expect(messages.length).toBe(1);

    const deliver = watcher.markMessageDelivered('2', messages[0].id);
    expect(deliver.success).toBe(true);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'message-delivered',
      expect.objectContaining({ paneId: '2', messageId: messages[0].id }),
    );

    const undelivered = watcher.getMessages('2', true);
    expect(undelivered.length).toBe(0);

    const cleared = watcher.clearMessages('2');
    expect(cleared.success).toBe(true);

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

  test('requestFileAccess allows reads while locked and rejects non-holder releases', () => {
    const { watcher, tempDir } = setupWatcher();
    watcher.requestFileAccess('ui/readme.md', '1', 'write');

    const readAccess = watcher.requestFileAccess('ui/readme.md', '2', 'read');
    expect(readAccess.granted).toBe(true);
    expect(readAccess.warning).toMatch(/locked by pane/i);

    const wrongRelease = watcher.releaseFileAccess('ui/readme.md', '2');
    expect(wrongRelease.released).toBe(false);
    expect(wrongRelease.error).toBe('Not lock holder');

    cleanupDir(tempDir);
  });

  test('clearAllLocks empties queues and notifies renderer', () => {
    const { watcher, tempDir, mainWindow } = setupWatcher();
    watcher.requestFileAccess('ui/test.js', '1', 'write');
    watcher.requestFileAccess('ui/test.js', '2', 'edit');

    const result = watcher.clearAllLocks();
    expect(result.success).toBe(true);
    expect(result.cleared).toBeGreaterThan(0);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('conflicts-cleared');

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

  test('startWatcher registers chokidar watcher and stopWatcher closes it', () => {
    const { watcher, chokidarMock, watcherInstance, tempDir } = setupWatcher();

    watcher.startWatcher();
    expect(chokidarMock.watch).toHaveBeenCalled();

    watcher.stopWatcher();
    expect(watcherInstance.close).toHaveBeenCalled();

    cleanupDir(tempDir);
  });
});
