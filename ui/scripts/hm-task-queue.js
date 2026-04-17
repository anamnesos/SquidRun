#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { resolveCoordPath } = require('../config');

const VALID_AGENTS = new Set(['architect', 'builder', 'oracle']);
const DEFAULT_QUEUE_RELATIVE_PATH = path.join('runtime', 'agent-task-queue.json');
const DEFAULT_HISTORY_LIMIT = 50;

function getQueuePath() {
  try {
    return resolveCoordPath(DEFAULT_QUEUE_RELATIVE_PATH, { forWrite: true });
  } catch (_) {
    return null;
  }
}

function ensureDirForFile(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function trimText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeAgent(value) {
  const normalized = trimText(value)?.toLowerCase() || null;
  return VALID_AGENTS.has(normalized) ? normalized : null;
}

function toPositiveMs(value, fallback = 0) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function createTaskId(agent = 'agent') {
  return `${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createEmptyBucket() {
  return {
    pending: [],
    active: null,
    history: [],
  };
}

function buildDefaultQueueState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    agents: {
      architect: createEmptyBucket(),
      builder: createEmptyBucket(),
      oracle: createEmptyBucket(),
    },
  };
}

function normalizeTask(task, agent) {
  if (!task || typeof task !== 'object') return null;
  const message = trimText(task.message);
  if (!message) return null;
  return {
    taskId: trimText(task.taskId) || trimText(task.id) || createTaskId(agent),
    title: trimText(task.title),
    message,
    source: trimText(task.source),
    priority: trimText(task.priority) || 'normal',
    completionSentinel: trimText(task.completionSentinel),
    idleCompletionMs: toPositiveMs(task.idleCompletionMs, 0),
    responseTimeoutMs: toPositiveMs(task.responseTimeoutMs, 0),
    metadata: task.metadata && typeof task.metadata === 'object' ? { ...task.metadata } : {},
    status: trimText(task.status) || 'pending',
    enqueuedAtMs: Number(task.enqueuedAtMs || Date.now()),
    lastDispatchAtMs: toPositiveMs(task.lastDispatchAtMs, 0),
    firstActivityAtMs: toPositiveMs(task.firstActivityAtMs, 0),
    completedAtMs: toPositiveMs(task.completedAtMs, 0),
    completionReason: trimText(task.completionReason),
  };
}

function normalizeBucket(bucket, agent) {
  const input = bucket && typeof bucket === 'object' ? bucket : {};
  return {
    pending: Array.isArray(input.pending)
      ? input.pending.map((task) => normalizeTask(task, agent)).filter(Boolean)
      : [],
    active: normalizeTask(input.active, agent),
    history: Array.isArray(input.history)
      ? input.history.map((task) => normalizeTask(task, agent)).filter(Boolean).slice(-DEFAULT_HISTORY_LIMIT)
      : [],
  };
}

function normalizeQueueState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  const agents = state.agents && typeof state.agents === 'object' ? state.agents : state;
  const normalized = buildDefaultQueueState();
  for (const agent of VALID_AGENTS) {
    normalized.agents[agent] = normalizeBucket(agents[agent], agent);
  }
  if (trimText(state.updatedAt)) {
    normalized.updatedAt = state.updatedAt;
  }
  return normalized;
}

function readQueue(queuePath = getQueuePath()) {
  const fallback = buildDefaultQueueState();
  if (!queuePath || !fs.existsSync(queuePath)) {
    return { queuePath, state: fallback };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    return {
      queuePath,
      state: normalizeQueueState(parsed),
    };
  } catch (_) {
    return {
      queuePath,
      state: fallback,
    };
  }
}

function writeQueue(state, queuePath = getQueuePath()) {
  const normalized = normalizeQueueState(state);
  normalized.updatedAt = new Date().toISOString();
  if (!queuePath) {
    throw new Error('queue_path_unavailable');
  }
  ensureDirForFile(queuePath);
  fs.writeFileSync(queuePath, JSON.stringify(normalized, null, 2));
  return normalized;
}

function enqueueTask(input = {}, options = {}) {
  const agent = normalizeAgent(input.agent || options.agent);
  if (!agent) {
    throw new Error('invalid_agent');
  }
  const message = trimText(input.message);
  if (!message) {
    throw new Error('message_required');
  }
  const queuePath = options.queuePath || getQueuePath();
  const { state } = readQueue(queuePath);
  const bucket = state.agents[agent] || createEmptyBucket();
  const task = normalizeTask({
    ...input,
    agent,
    message,
    status: 'pending',
    enqueuedAtMs: Date.now(),
  }, agent);
  bucket.pending.push(task);
  state.agents[agent] = bucket;
  const saved = writeQueue(state, queuePath);
  return {
    ok: true,
    queuePath,
    task,
    pendingCount: saved.agents[agent].pending.length,
  };
}

function listQueue(options = {}) {
  const queuePath = options.queuePath || getQueuePath();
  const { state } = readQueue(queuePath);
  const summary = {};
  for (const agent of VALID_AGENTS) {
    const bucket = state.agents[agent] || createEmptyBucket();
    summary[agent] = {
      pending: bucket.pending.length,
      active: bucket.active ? {
        taskId: bucket.active.taskId,
        title: bucket.active.title || null,
        status: bucket.active.status || 'active',
      } : null,
      history: bucket.history.length,
    };
  }
  return {
    ok: true,
    queuePath,
    updatedAt: state.updatedAt,
    summary,
    state,
  };
}

function completeActiveTask(input = {}, options = {}) {
  const agent = normalizeAgent(input.agent || options.agent);
  if (!agent) {
    throw new Error('invalid_agent');
  }
  const queuePath = options.queuePath || getQueuePath();
  const { state } = readQueue(queuePath);
  const bucket = state.agents[agent] || createEmptyBucket();
  if (!bucket.active) {
    return {
      ok: false,
      queuePath,
      reason: 'no_active_task',
    };
  }
  const completedTask = {
    ...bucket.active,
    status: 'completed',
    completionReason: trimText(input.reason) || 'manual_complete',
    completedAtMs: Date.now(),
  };
  bucket.active = null;
  bucket.history.push(completedTask);
  bucket.history = bucket.history.slice(-DEFAULT_HISTORY_LIMIT);
  state.agents[agent] = bucket;
  writeQueue(state, queuePath);
  return {
    ok: true,
    queuePath,
    task: completedTask,
  };
}

function clearQueue(input = {}, options = {}) {
  const queuePath = options.queuePath || getQueuePath();
  const { state } = readQueue(queuePath);
  const agent = normalizeAgent(input.agent || options.agent);
  if (agent) {
    state.agents[agent] = {
      ...createEmptyBucket(),
      history: state.agents[agent]?.history || [],
    };
  } else {
    for (const key of VALID_AGENTS) {
      state.agents[key] = {
        ...createEmptyBucket(),
        history: state.agents[key]?.history || [],
      };
    }
  }
  writeQueue(state, queuePath);
  return {
    ok: true,
    queuePath,
    agent: agent || 'all',
  };
}

function usage() {
  console.log('Usage: node ui/scripts/hm-task-queue.js <command> [options]');
  console.log('Commands:');
  console.log('  enqueue --agent <architect|builder|oracle> --message <text> [--title <text>] [--priority <level>]');
  console.log('          [--source <role>] [--completion-sentinel <text>] [--idle-completion-ms <ms>] [--response-timeout-ms <ms>]');
  console.log('  list');
  console.log('  complete --agent <architect|builder|oracle> [--reason <text>]');
  console.log('  clear [--agent <architect|builder|oracle>]');
}

function parseArgs(argv) {
  const positional = [];
  const options = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) i += 1;
    options.set(key, value);
  }
  return { positional, options };
}

function getOption(options, key, fallback = null) {
  return options.has(key) ? options.get(key) : fallback;
}

function formatListResult(result) {
  const lines = [
    `queuePath=${result.queuePath}`,
    `updatedAt=${result.updatedAt || 'n/a'}`,
  ];
  for (const agent of ['architect', 'builder', 'oracle']) {
    const summary = result.summary[agent];
    lines.push(
      `${agent}: pending=${summary.pending} active=${summary.active ? `${summary.active.taskId}:${summary.active.status}` : 'none'} history=${summary.history}`
    );
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseArgs(argv);
  const command = trimText(positional[0])?.toLowerCase() || null;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return 0;
  }

  if (command === 'enqueue') {
    const result = enqueueTask({
      agent: getOption(options, 'agent'),
      title: getOption(options, 'title'),
      message: getOption(options, 'message'),
      source: getOption(options, 'source'),
      priority: getOption(options, 'priority'),
      completionSentinel: getOption(options, 'completion-sentinel'),
      idleCompletionMs: getOption(options, 'idle-completion-ms'),
      responseTimeoutMs: getOption(options, 'response-timeout-ms'),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === 'list') {
    const result = listQueue();
    console.log(formatListResult(result));
    return 0;
  }

  if (command === 'complete') {
    const result = completeActiveTask({
      agent: getOption(options, 'agent'),
      reason: getOption(options, 'reason'),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (command === 'clear') {
    const result = clearQueue({
      agent: getOption(options, 'agent'),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  usage();
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_QUEUE_RELATIVE_PATH,
  VALID_AGENTS,
  getQueuePath,
  buildDefaultQueueState,
  normalizeQueueState,
  readQueue,
  writeQueue,
  enqueueTask,
  listQueue,
  completeActiveTask,
  clearQueue,
  parseArgs,
  formatListResult,
  main,
};
