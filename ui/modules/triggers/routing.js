/**
 * Triggers - Routing and Handoff Logic
 * Extracted from triggers.js
 */

const { WORKSPACE_PATH, PANE_IDS } = require('../../config');
const log = require('../logger');
const smartRouting = require('../smart-routing');

const ANSI = {
  RESET: '\x1b[0m',
  BLUE: '\x1b[34m',
  YELLOW: '\x1b[33m',
  MAGENTA: '\x1b[35m',
};

const AGENT_ROLES = {
  '1': { name: 'Architect', type: 'coordinator', skills: ['planning', 'coordination', 'architecture'] },
  '2': { name: 'Infra', type: 'coordinator', skills: ['routing', 'ci-cd', 'deployment', 'infrastructure'] },
  '3': { name: 'Frontend', type: 'worker', skills: ['ui', 'frontend', 'renderer', 'css'] },
  '4': { name: 'Backend', type: 'worker', skills: ['backend', 'daemon', 'ipc', 'processes'] },
  '5': { name: 'Analyst', type: 'analyst', skills: ['debugging', 'profiling', 'analysis', 'investigation'] },
  '6': { name: 'Reviewer', type: 'reviewer', skills: ['review', 'testing', 'verification'] },
};

const HANDOFF_CHAIN = {
  '1': ['2'],
  '2': ['3', '4', '5'],
  '3': ['6'],
  '4': ['6'],
  '5': ['6'],
  '6': ['1'],
};

// Shared state from triggers.js
let sharedState = {
  mainWindow: null,
  agentRunning: null,
  watcher: null,
  logTriggerActivity: null,
  recordSelfHealingMessage: null,
  formatTriggerMessage: null,
  emitOrganicMessageRoute: null,
};

function setSharedState(state) {
  Object.assign(sharedState, state);
}

function normalizeDetail(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateDetail(text, maxLen = 160) {
  const clean = collapseWhitespace(text);
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 3)}...`;
}

function formatTaggedLine(tag, detail, color = ANSI.RESET) {
  const clean = truncateDetail(normalizeDetail(detail));
  if (!clean) return null;
  return `
${color}[${tag}]${ANSI.RESET} ${clean}
`;
}

function deriveFileAction(eventType, payload) {
  const raw = normalizeDetail(payload?.action || payload?.event || eventType).toLowerCase();
  if (raw.includes('delete') || raw.includes('remove')) return 'deleted';
  if (raw.includes('create') || raw.includes('new')) return 'created';
  if (raw.includes('write') || raw.includes('update') || raw.includes('edit') || raw.includes('patch') || raw.includes('modify')) {
    return 'edited';
  }
  return 'updated';
}

function extractFileSummary(eventType, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const files = payload.files || payload.paths || payload.file_paths || payload.filePaths;
  if (Array.isArray(files) && files.length > 0) {
    const action = deriveFileAction(eventType, payload);
    if (files.length === 1) {
      return { action, target: files[0] };
    }
    return { action, target: `${files.length} files` };
  }
  const file = payload.file || payload.path || payload.filename || payload.file_path || payload.filePath;
  if (typeof file === 'string' && file) {
    const action = deriveFileAction(eventType, payload);
    return { action, target: file };
  }
  const count = payload.count || payload.fileCount || payload.filesCount;
  if (typeof count === 'number') {
    const action = deriveFileAction(eventType, payload);
    return { action, target: `${count} files` };
  }
  return null;
}

function extractCommand(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.command === 'string') return payload.command;
  if (Array.isArray(payload.command)) return payload.command.join(' ');
  if (payload.command && typeof payload.command === 'object') {
    if (typeof payload.command.command === 'string') return payload.command.command;
    if (Array.isArray(payload.command.args)) return payload.command.args.join(' ');
  }
  if (typeof payload.command_line === 'string') return payload.command_line;
  if (typeof payload.commandLine === 'string') return payload.commandLine;
  if (typeof payload.cmd === 'string') return payload.cmd;
  if (Array.isArray(payload.args)) return payload.args.join(' ');
  if (Array.isArray(payload.argv)) return payload.argv.join(' ');
  return '';
}

function extractToolName(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.tool_name === 'string') return payload.tool_name;
  if (typeof payload.toolName === 'string') return payload.toolName;
  if (typeof payload.name === 'string') return payload.name;
  if (typeof payload.tool === 'string') return payload.tool;
  if (payload.tool && typeof payload.tool.name === 'string') return payload.tool.name;
  if (payload.tool_call && typeof payload.tool_call.name === 'string') return payload.tool_call.name;
  if (payload.tool_call && payload.tool_call.function && typeof payload.tool_call.function.name === 'string') {
    return payload.tool_call.function.name;
  }
  if (payload.function && typeof payload.function.name === 'string') return payload.function.name;
  return '';
}

function extractToolDetail(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const input = payload.input || payload.arguments || payload.args || payload.params || payload.parameters;
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const query = input.query || input.q || input.search || input.text;
    if (typeof query === 'string') return query;
    return normalizeDetail(input);
  }
  return '';
}

function isStartLikeEvent(eventType) {
  return eventType.endsWith('started')
    || eventType.endsWith('.started')
    || eventType.endsWith('_started')
    || eventType === 'tool_use'
    || eventType === 'tool_call'
    || eventType === 'command';
}

function isCompleteLikeEvent(eventType) {
  return eventType.endsWith('completed')
    || eventType.endsWith('.completed')
    || eventType.endsWith('_completed')
    || eventType.endsWith('stopped')
    || eventType.endsWith('.stopped');
}

function formatAuxEvent(event) {
  const eventType = String(event.type || '').toLowerCase();
  const payload = event.payload || event;

  const fileSummary = extractFileSummary(eventType, payload);
  if (fileSummary) {
    return formatTaggedLine('FILE', `${fileSummary.action} ${fileSummary.target}`, ANSI.BLUE);
  }

  const isCommandEvent = eventType.includes('command');
  if (isCommandEvent) {
    if (isCompleteLikeEvent(eventType) && !isStartLikeEvent(eventType)) {
      return '';
    }
    const command = extractCommand(payload);
    if (command) {
      return formatTaggedLine('CMD', command, ANSI.YELLOW);
    }
  }

  const isToolEvent = eventType.includes('tool');
  if (isToolEvent) {
    if (isCompleteLikeEvent(eventType) && !isStartLikeEvent(eventType)) {
      return '';
    }
    const toolName = extractToolName(payload);
    const toolDetail = extractToolDetail(payload);
    if (toolName) {
      const detail = toolDetail ? `${toolName} ${toolDetail}` : toolName;
      return formatTaggedLine('TOOL', detail, ANSI.MAGENTA);
    }
  }

  return null;
}

function getBestAgent(taskType, performance, message = '') {
  const runningMap = (sharedState.watcher && typeof sharedState.watcher.getAgentRunning === 'function')
    ? sharedState.watcher.getAgentRunning()
    : (sharedState.agentRunning || new Map());

  return smartRouting.getBestAgent({
    taskType,
    message,
    roles: AGENT_ROLES,
    runningMap: runningMap || new Map(),
    performance,
    workspacePath: WORKSPACE_PATH,
  });
}

function routeTask(taskType, message, performance) {
  const decision = getBestAgent(taskType, performance, message);
  const { paneId, reason, confidence } = decision;

  if (!paneId) {
    log.info('SmartRoute', `No agent available for ${taskType}`);
    return { success: false, reason: 'no_agent_available' };
  }

  const confidencePct = confidence != null ? Math.round(confidence * 100) : null;
  const confidenceNote = confidencePct !== null ? `, ${confidencePct}% confidence` : '';
  log.info('SmartRoute', `Routing ${taskType} task to pane ${paneId} (${reason}${confidenceNote})`);

  const routeMessage = `[ROUTED: ${taskType}] ${message}`;
  if (sharedState.mainWindow && !sharedState.mainWindow.isDestroyed()) {
    const triggerMessage = sharedState.formatTriggerMessage(routeMessage);
    sharedState.mainWindow.webContents.send('inject-message', {
      panes: [paneId],
      message: triggerMessage + '\r'
    });
    sharedState.mainWindow.webContents.send('task-routed', {
      taskType,
      paneId,
      reason,
      confidence,
      scores: decision.scores ? decision.scores.slice(0, 3) : null,
      message: message.substring(0, 50)
    });
  }

  if (typeof sharedState.logTriggerActivity === 'function') {
    sharedState.logTriggerActivity('Routed task', [paneId], routeMessage, { taskType, reason, confidence });
  }
  if (typeof sharedState.recordSelfHealingMessage === 'function') {
    sharedState.recordSelfHealingMessage(paneId, message, { source: 'route', taskType, confidence });
  }
  return { success: true, paneId, reason, confidence };
}

function triggerAutoHandoff(completedPaneId, completionMessage) {
  const nextPanes = HANDOFF_CHAIN[completedPaneId];

  if (!nextPanes || nextPanes.length === 0) {
    log.info('AutoHandoff', `No handoff chain for pane ${completedPaneId}`);
    return { success: false, reason: 'no_chain' };
  }

  const runningNext = nextPanes.find(paneId =>
    sharedState.agentRunning && sharedState.agentRunning.get(paneId) === 'running'
  );

  if (!runningNext) {
    log.info('AutoHandoff', `No running agents in handoff chain for pane ${completedPaneId}`);
    return { success: false, reason: 'no_running_next' };
  }

  const fromRole = AGENT_ROLES[completedPaneId]?.name || `Pane ${completedPaneId}`;
  const toRole = AGENT_ROLES[runningNext]?.name || `Pane ${runningNext}`;

  const handoffMessage = `[HANDOFF from ${fromRole}] ${completionMessage}`;

  log.info('AutoHandoff', `${fromRole} → ${toRole}: ${completionMessage.substring(0, 50)}...`);
  if (typeof sharedState.emitOrganicMessageRoute === 'function') {
    sharedState.emitOrganicMessageRoute(fromRole, [runningNext]);
  }

  if (sharedState.mainWindow && !sharedState.mainWindow.isDestroyed()) {
    const triggerMessage = sharedState.formatTriggerMessage(handoffMessage);
    sharedState.mainWindow.webContents.send('inject-message', {
      panes: [runningNext],
      message: triggerMessage + '\r'
    });
    sharedState.mainWindow.webContents.send('auto-handoff', {
      from: completedPaneId,
      to: runningNext,
      fromPaneId: completedPaneId,
      toPaneId: runningNext,
      fromRole,
      toRole,
      message: completionMessage.substring(0, 100)
    });
  }

  if (typeof sharedState.logTriggerActivity === 'function') {
    sharedState.logTriggerActivity('Auto-handoff', [runningNext], handoffMessage, { from: fromRole, to: toRole });
  }
  return { success: true, from: completedPaneId, to: runningNext, fromRole, toRole };
}

module.exports = {
  setSharedState,
  routeTask,
  triggerAutoHandoff,
  formatAuxEvent,
  AGENT_ROLES,
};
