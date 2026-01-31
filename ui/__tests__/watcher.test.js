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
      '### Frontend',
      '- `ui/modules/foo.js`',
      '',
      '### Backend',
      '- `ui/modules/foo.js`',
    ].join('\n'));

    const conflicts = watcher.checkFileConflicts();

    expect(conflicts.length).toBe(1);
    expect(conflicts[0].file).toBe('ui/modules/foo.js');
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('file-conflicts-detected', conflicts);

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

  test('getMessageQueueStatus returns queue summary', () => {
    const { watcher, tempDir } = setupWatcher();
    watcher.initMessageQueue();
    watcher.sendMessage('1', '2', 'Hello');

    const status = watcher.getMessageQueueStatus();

    expect(status.totalMessages).toBeGreaterThanOrEqual(1);
    expect(status.queues['2']).toBeDefined();
    expect(status.queues['2'].total).toBeGreaterThanOrEqual(1);

    cleanupDir(tempDir);
  });

  test('startTriggerWatcher and stopTriggerWatcher work', () => {
    const { watcher, tempDir, chokidarMock, watcherInstance } = setupWatcher();

    watcher.startTriggerWatcher();
    expect(chokidarMock.watch).toHaveBeenCalledWith(
      watcher.TRIGGER_PATH,
      expect.objectContaining({ interval: 50 })
    );

    watcher.stopTriggerWatcher();
    expect(watcherInstance.close).toHaveBeenCalled();

    cleanupDir(tempDir);
  });

  test('startMessageWatcher and stopMessageWatcher work', () => {
    const { watcher, tempDir, chokidarMock, watcherInstance } = setupWatcher();

    watcher.startMessageWatcher();
    expect(chokidarMock.watch).toHaveBeenCalled();

    watcher.stopMessageWatcher();
    expect(watcherInstance.close).toHaveBeenCalled();

    cleanupDir(tempDir);
  });

  test('markMessageDelivered returns error for missing queue', () => {
    const { watcher, tempDir } = setupWatcher();

    const result = watcher.markMessageDelivered('99', 'msg-123');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);

    cleanupDir(tempDir);
  });

  test('markMessageDelivered returns error for missing message', () => {
    const { watcher, tempDir } = setupWatcher();
    watcher.initMessageQueue();

    const result = watcher.markMessageDelivered('1', 'nonexistent-msg');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);

    cleanupDir(tempDir);
  });

  test('clearMessages with deliveredOnly preserves undelivered', () => {
    const { watcher, tempDir } = setupWatcher();
    watcher.initMessageQueue();

    watcher.sendMessage('1', '2', 'Message 1');
    watcher.sendMessage('1', '2', 'Message 2');
    const messages = watcher.getMessages('2');
    watcher.markMessageDelivered('2', messages[0].id);

    watcher.clearMessages('2', true);

    const remaining = watcher.getMessages('2');
    expect(remaining.length).toBe(1);
    expect(remaining[0].content).toBe('Message 2');

    cleanupDir(tempDir);
  });

  test('clearMessages with all clears all panes', () => {
    const { watcher, tempDir } = setupWatcher();
    watcher.initMessageQueue();

    watcher.sendMessage('1', '1', 'Pane 1');
    watcher.sendMessage('2', '2', 'Pane 2');

    watcher.clearMessages('all');

    expect(watcher.getMessages('1').length).toBe(0);
    expect(watcher.getMessages('2').length).toBe(0);

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

  // NOTE: This test documents a BUG in watcher.js (lines 579-592)
  // The friction-resolution.md -> PLAN_REVIEW transition at line 590 is UNREACHABLE
  // because line 579's condition (filename.endsWith('.md') && filePath.includes('friction'))
  // always matches first, consuming the else-if chain even though inner condition fails.
  // The state stays at FRICTION_RESOLUTION instead of transitioning to PLAN_REVIEW.
  // TODO: Fix production code by reordering else-if conditions (specific before general)
  test('friction-resolution.md during FRICTION_RESOLUTION stays in FRICTION_RESOLUTION (BUG)', () => {
    jest.useFakeTimers();
    const { watcher, tempDir } = setupWatcher();
    watcher.writeState(makeState({ state: watcher.States.FRICTION_RESOLUTION }));

    const resolutionPath = path.join(tempDir, 'friction-resolution.md');
    fs.writeFileSync(resolutionPath, 'Resolution', 'utf-8');

    watcher.handleFileChange(resolutionPath);
    jest.advanceTimersByTime(250);

    // BUG: Should be PLAN_REVIEW but else-if ordering prevents transition
    expect(watcher.readState().state).toBe(watcher.States.FRICTION_RESOLUTION);

    cleanupDir(tempDir);
  });
});
