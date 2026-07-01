#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { resolveCoordPath } = require('../config');

const VALID_AGENTS = new Set(['architect', 'builder', 'oracle']);
const DEFAULT_QUEUE_RELATIVE_PATH = path.join('runtime', 'agent-task-queue.json');
const DEFAULT_HISTORY_LIMIT = 50;
const QUEUE_SCHEMA_VERSION = 3;
const VALID_STATES = new Set(['queued', 'active', 'blocked', 'waiting', 'parked', 'done', 'failed']);
const VALID_RISK_CLASSES = new Set(['safe', 'caution', 'approval_required']);
const WAKE_DISPATCH_STATES = new Set(['queued', 'blocked', 'waiting']);
const WAKE_DISPATCH_RISKS = new Set(['safe', 'caution']);
const APPROVAL_REQUIRED_PATTERN = /\b(customer|client|invoice|payment|refund|charge|bank|money|cash|trading|trade|crypto|stock|position|wallet|auth|token|credential|password|secret|api key|email customer|send email|customer-facing)\b/i;
const SAFE_PATTERN = /\b(doc|docs|documentation|test|tests|unit test|lint|typecheck|format|static|read-only|inspect|investigate|report)\b/i;
const CAUTION_PATTERN = /\b(infra|debug|diagnose|fix|patch|code|refactor|restartless|routing|watcher|queue|schema|migration)\b/i;
const DEFAULT_APPROVAL_HOLD_REASON = 'Approval required before owned-work resume';
const PARKED_HISTORY_COMPLETION_REASON = 'parked_not_executed';
const DEFAULT_PARKED_REASON = 'Parked: explicit unpark required before dispatch';

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

function createBrokenJsonError(filePath, store, err) {
  const error = new Error(`${store}_json_parse_error: ${filePath}: ${err.message}`);
  error.code = 'BROKEN_JSON_STATE';
  error.reason = `${store}_json_parse_error`;
  error.store = store;
  error.filePath = filePath;
  error.cause = err;
  return error;
}

function toBrokenState(error) {
  return {
    status: 'broken',
    reason: error.reason || 'json_parse_error',
    code: error.code || 'BROKEN_JSON_STATE',
    store: error.store || 'json_state',
    filePath: error.filePath || null,
    message: error.message,
  };
}

function makeBrokenBackupPath(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.broken-${stamp}-${process.pid}.json`
  );
}

function preserveBrokenJsonFile(filePath, store) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return null;
  } catch (err) {
    const backupPath = makeBrokenBackupPath(filePath);
    fs.copyFileSync(filePath, backupPath);
    return {
      store,
      sourcePath: filePath,
      backupPath,
      reason: `${store}_json_parse_error`,
      error: err.message,
    };
  }
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

function toTimestampMs(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeState(value, fallback = 'queued') {
  const normalized = trimText(value)?.toLowerCase() || null;
  if (!normalized) return fallback;
  if (normalized === 'pending' || normalized === 'open') return 'queued';
  if (normalized === 'running' || normalized === 'in_progress') return 'active';
  if (normalized === 'needs_input') return 'blocked';
  if (normalized === 'completed') return 'done';
  return VALID_STATES.has(normalized) ? normalized : fallback;
}

function normalizeRiskClass(value, fallback = null) {
  const normalized = trimText(value)?.toLowerCase() || null;
  return VALID_RISK_CLASSES.has(normalized) ? normalized : fallback;
}

function taskSearchText(input = {}) {
  const parts = [
    input.title,
    input.message,
    input.nextStep,
    input.blockedReason,
    input.handoffSummary,
    input.source,
  ];
  if (input.metadata && typeof input.metadata === 'object') {
    parts.push(JSON.stringify(input.metadata));
  }
  return parts.filter(Boolean).join(' ');
}

function inferRiskClass(input = {}) {
  const text = taskSearchText(input);
  if (APPROVAL_REQUIRED_PATTERN.test(text)) return 'approval_required';
  if (SAFE_PATTERN.test(text)) return 'safe';
  if (CAUTION_PATTERN.test(text)) return 'caution';
  return 'caution';
}

function normalizeContinueAfter(value) {
  const text = trimText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return text;
}

function normalizeWakeTrigger(value) {
  const text = trimText(value)?.toLowerCase() || null;
  if (!text) return null;
  if (text === 'restart' || text === 'post_restart' || text === 'post-restart') return 'post-wake';
  return text;
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
    version: QUEUE_SCHEMA_VERSION,
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
  const state = normalizeState(task.state || task.status, 'queued');
  const owner = normalizeAgent(task.owner) || normalizeAgent(task.agent) || agent || null;
  const riskClass = normalizeRiskClass(task.riskClass) || inferRiskClass(task);
  const now = Date.now();
  const lastAdvancedAt = toTimestampMs(task.lastAdvancedAt || task.updatedAt || task.enqueuedAtMs, now);
  return {
    taskId: trimText(task.taskId) || trimText(task.id) || createTaskId(agent),
    owner,
    state,
    status: state,
    riskClass,
    title: trimText(task.title),
    message,
    source: trimText(task.source),
    nextStep: trimText(task.nextStep),
    blockedReason: trimText(task.blockedReason),
    wakeTrigger: trimText(task.wakeTrigger),
    continueAfter: normalizeContinueAfter(task.continueAfter),
    restartPersistence: task.restartPersistence === false ? false : true,
    handoffSummary: trimText(task.handoffSummary),
    priority: trimText(task.priority) || 'normal',
    completionSentinel: trimText(task.completionSentinel),
    idleCompletionMs: toPositiveMs(task.idleCompletionMs, 0),
    responseTimeoutMs: toPositiveMs(task.responseTimeoutMs, 0),
    metadata: task.metadata && typeof task.metadata === 'object' ? { ...task.metadata } : {},
    enqueuedAtMs: toTimestampMs(task.enqueuedAtMs, now),
    lastAdvancedAt,
    lastDispatchAtMs: toPositiveMs(task.lastDispatchAtMs, 0),
    firstActivityAtMs: toPositiveMs(task.firstActivityAtMs, 0),
    completedAtMs: toPositiveMs(task.completedAtMs, 0),
    completionReason: trimText(task.completionReason),
  };
}

function isParkedTask(task) {
  return normalizeState(task?.state || task?.status, 'queued') === 'parked';
}

function isParkedHistoryTask(task) {
  if (!task || typeof task !== 'object') return false;
  const completionReason = trimText(task.completionReason);
  return isParkedTask(task) || completionReason === PARKED_HISTORY_COMPLETION_REASON;
}

function toParkedTask(task, agent) {
  const completionReason = trimText(task?.completionReason);
  const parked = normalizeTask({
    ...task,
    state: 'parked',
    status: 'parked',
    blockedReason: trimText(task?.blockedReason) || DEFAULT_PARKED_REASON,
    restartPersistence: true,
    completedAtMs: 0,
    completionReason: null,
    metadata: {
      ...(task?.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
      migratedFromHistoryCompletionReason: completionReason || null,
    },
  }, agent);
  if (parked) {
    parked.restartPersistence = true;
    parked.completedAtMs = 0;
    parked.completionReason = null;
  }
  return parked;
}

function normalizeBucket(bucket, agent) {
  const input = bucket && typeof bucket === 'object' ? bucket : {};
  const pending = Array.isArray(input.pending)
    ? input.pending.map((task) => normalizeTask(task, agent)).filter(Boolean)
    : [];
  const activeTask = normalizeTask(input.active, agent);
  let active = activeTask;
  if (activeTask && isParkedTask(activeTask)) {
    pending.push({
      ...activeTask,
      blockedReason: activeTask.blockedReason || DEFAULT_PARKED_REASON,
      restartPersistence: true,
    });
    active = null;
  }
  const history = Array.isArray(input.history)
    ? input.history.map((task) => normalizeTask(task, agent)).filter(Boolean)
    : [];
  const seenPendingTaskIds = new Set(pending.map((task) => task.taskId).filter(Boolean));
  const retainedHistory = [];
  for (const task of history) {
    if (isParkedHistoryTask(task)) {
      const parked = toParkedTask(task, agent);
      if (parked && !seenPendingTaskIds.has(parked.taskId)) {
        pending.push(parked);
        seenPendingTaskIds.add(parked.taskId);
      }
      continue;
    }
    retainedHistory.push(task);
  }
  return {
    pending,
    active,
    history: retainedHistory.slice(-DEFAULT_HISTORY_LIMIT),
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
  normalized.version = QUEUE_SCHEMA_VERSION;
  return normalized;
}

function readQueue(queuePath = getQueuePath(), options = {}) {
  const fallback = buildDefaultQueueState();
  if (!queuePath || !fs.existsSync(queuePath)) {
    return { ok: true, status: 'ok', queuePath, state: fallback };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    return {
      ok: true,
      status: 'ok',
      queuePath,
      state: normalizeQueueState(parsed),
    };
  } catch (err) {
    const error = createBrokenJsonError(queuePath, 'agent_task_queue', err);
    if (options.onBroken === 'return') {
      return {
        ok: false,
        status: 'broken',
        queuePath,
        state: fallback,
        brokenState: toBrokenState(error),
      };
    }
    throw error;
  }
}

function writeJsonAtomic(filePath, payload) {
  ensureDirForFile(filePath);
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function writeQueue(state, queuePath = getQueuePath()) {
  const normalized = normalizeQueueState(state);
  normalized.updatedAt = new Date().toISOString();
  if (!queuePath) {
    throw new Error('queue_path_unavailable');
  }
  const preservedBrokenState = preserveBrokenJsonFile(queuePath, 'agent_task_queue');
  writeJsonAtomic(queuePath, normalized);
  if (preservedBrokenState) {
    return {
      ...normalized,
      preservedBrokenState,
    };
  }
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
    state: 'queued',
    enqueuedAtMs: Date.now(),
    lastAdvancedAt: Date.now(),
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
        state: bucket.active.state || 'active',
        status: bucket.active.status || bucket.active.state || 'active',
        riskClass: bucket.active.riskClass || 'caution',
        nextStep: bucket.active.nextStep || null,
        blockedReason: bucket.active.blockedReason || null,
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

function parseDueTime(value) {
  const text = trimText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function isContinueAfterDue(task, nowMs) {
  const dueAtMs = parseDueTime(task.continueAfter);
  return !dueAtMs || dueAtMs <= nowMs;
}

function wakeTriggerMatches(task, trigger) {
  const taskTrigger = normalizeWakeTrigger(task.wakeTrigger);
  const requestedTrigger = normalizeWakeTrigger(trigger);
  if (!requestedTrigger) return true;
  if (!taskTrigger) return true;
  return taskTrigger === requestedTrigger;
}

function isWakeEligible(task, options = {}) {
  const nowMs = toTimestampMs(options.nowMs || options.now, Date.now());
  if (!task || task.restartPersistence === false) return false;
  if (normalizeState(task.state, 'queued') === 'parked') return false;
  if (!WAKE_DISPATCH_STATES.has(normalizeState(task.state, 'queued'))) return false;
  if (!isContinueAfterDue(task, nowMs)) return false;
  if (!wakeTriggerMatches(task, options.wakeTrigger || options.trigger)) return false;
  return true;
}

function buildWakeCandidate(agent, task, details = {}) {
  const candidate = {
    agent,
    taskId: task.taskId,
    title: task.title || null,
    message: task.message || null,
    state: normalizeState(task.state, 'queued'),
    riskClass: normalizeRiskClass(task.riskClass, 'caution'),
    nextStep: task.nextStep || null,
    blockedReason: task.blockedReason || null,
    wakeTrigger: task.wakeTrigger || null,
    continueAfter: task.continueAfter || null,
    restartPersistence: task.restartPersistence !== false,
    source: task.source || null,
    handoffSummary: task.handoffSummary || null,
    dispatchReady: details.dispatchReady !== false,
    holdReason: details.holdReason || null,
  };
  candidate.prompt = buildContinuePrompt(candidate);
  return candidate;
}

function collectWakeCandidates(options = {}) {
  const queuePath = options.queuePath || getQueuePath();
  const { state } = readQueue(queuePath);
  const nowMs = toTimestampMs(options.nowMs || options.now, Date.now());
  const trigger = normalizeWakeTrigger(options.wakeTrigger || options.trigger) || 'post-wake';
  const agentFilter = normalizeAgent(options.agent);
  const candidates = [];
  const held = [];

  for (const agent of VALID_AGENTS) {
    if (agentFilter && agent !== agentFilter) continue;
    const bucket = state.agents[agent] || createEmptyBucket();
    for (const task of bucket.pending) {
      if (!isWakeEligible(task, { nowMs, wakeTrigger: trigger })) continue;
      if (normalizeRiskClass(task.riskClass, 'caution') === 'approval_required') {
        held.push(buildWakeCandidate(agent, {
          ...task,
          state: 'blocked',
          blockedReason: task.blockedReason || DEFAULT_APPROVAL_HOLD_REASON,
        }, {
          dispatchReady: false,
          holdReason: 'approval_required',
        }));
        continue;
      }
      if (!WAKE_DISPATCH_RISKS.has(normalizeRiskClass(task.riskClass, 'caution'))) continue;
      candidates.push(buildWakeCandidate(agent, task, {
        dispatchReady: !bucket.active,
        holdReason: bucket.active ? 'active_task_exists' : null,
      }));
    }
  }

  return {
    ok: true,
    queuePath,
    trigger,
    generatedAtMs: nowMs,
    candidates,
    held,
  };
}

function buildContinuePrompt(candidate = {}) {
  const lines = [
    '[OWNED-WORK CONTINUE]',
    `Agent: ${candidate.agent || 'agent'}`,
    `Task: ${candidate.title || candidate.taskId || 'owned work'}`,
    `Risk: ${candidate.riskClass || 'caution'}`,
  ];
  if (candidate.nextStep) lines.push(`Next: ${candidate.nextStep}`);
  if (candidate.handoffSummary) lines.push(`Handoff: ${candidate.handoffSummary}`);
  if (candidate.blockedReason) lines.push(`Previous block: ${candidate.blockedReason}`);
  if (candidate.wakeTrigger) lines.push(`Wake trigger: ${candidate.wakeTrigger}`);
  lines.push('Resume only the bounded safe/caution next step from the owned-work queue.');
  lines.push('If the work becomes customer-facing, trading, money, auth, or otherwise approval-required, block it instead of continuing.');
  return lines.join('\n');
}

function ensureApprovalHolds(state, options = {}) {
  const nowMs = toTimestampMs(options.nowMs || options.now, Date.now());
  const trigger = normalizeWakeTrigger(options.wakeTrigger || options.trigger) || 'post-wake';
  const agentFilter = normalizeAgent(options.agent);
  let changed = false;

  for (const agent of VALID_AGENTS) {
    if (agentFilter && agent !== agentFilter) continue;
    const bucket = state.agents[agent] || createEmptyBucket();
    for (let index = 0; index < bucket.pending.length; index += 1) {
      const task = bucket.pending[index];
      if (!isWakeEligible(task, { nowMs, wakeTrigger: trigger })) continue;
      if (normalizeRiskClass(task.riskClass, 'caution') !== 'approval_required') continue;
      const heldTask = updateTaskAdvanced(task, {
        state: 'blocked',
        blockedReason: task.blockedReason || DEFAULT_APPROVAL_HOLD_REASON,
        wakeTrigger: task.wakeTrigger || trigger,
      });
      bucket.pending[index] = heldTask;
      changed = true;
    }
    state.agents[agent] = bucket;
  }

  return changed;
}

async function dispatchWakeCandidates(options = {}) {
  const queuePath = options.queuePath || getQueuePath();
  const { state } = readQueue(queuePath);
  const nowMs = toTimestampMs(options.nowMs || options.now, Date.now());
  const trigger = normalizeWakeTrigger(options.wakeTrigger || options.trigger) || 'post-wake';
  const approvalHoldsChanged = ensureApprovalHolds(state, { ...options, nowMs, wakeTrigger: trigger });
  if (approvalHoldsChanged) {
    writeQueue(state, queuePath);
  }

  const scan = collectWakeCandidates({ ...options, queuePath, nowMs, wakeTrigger: trigger });
  const dispatcher = typeof options.dispatcher === 'function' ? options.dispatcher : null;
  if (!dispatcher) {
    return {
      ...scan,
      dispatched: [],
      skipped: scan.candidates
        .filter((candidate) => !candidate.dispatchReady)
        .map((candidate) => ({ ...candidate, reason: candidate.holdReason || 'not_dispatch_ready' })),
      dryRun: true,
    };
  }

  const dispatched = [];
  const skipped = [];
  for (const candidate of scan.candidates) {
    if (!candidate.dispatchReady) {
      skipped.push({ ...candidate, reason: candidate.holdReason || 'not_dispatch_ready' });
      continue;
    }
    const dispatchResult = await dispatcher(candidate);
    if (dispatchResult && dispatchResult.ok === false) {
      skipped.push({ ...candidate, reason: dispatchResult.reason || 'dispatch_failed' });
      continue;
    }
    const continued = continueTask({
      agent: candidate.agent,
      taskId: candidate.taskId,
      nextStep: candidate.nextStep,
      handoffSummary: candidate.handoffSummary,
      lastDispatchAtMs: nowMs,
    }, { queuePath });
    if (!continued.ok) {
      skipped.push({ ...candidate, reason: continued.reason || 'continue_failed' });
      continue;
    }
    dispatched.push({
      ...candidate,
      dispatchResult: dispatchResult || { ok: true },
      task: continued.task,
    });
  }

  return {
    ...scan,
    dispatched,
    skipped,
    dryRun: false,
  };
}

function findTaskInBucket(bucket, taskId = null) {
  if (!bucket) return { task: null, location: null, index: -1 };
  const id = trimText(taskId);
  if (bucket.active && (!id || bucket.active.taskId === id)) {
    return { task: bucket.active, location: 'active', index: -1 };
  }
  if (id) {
    const pendingIndex = bucket.pending.findIndex((task) => task.taskId === id);
    if (pendingIndex >= 0) {
      return { task: bucket.pending[pendingIndex], location: 'pending', index: pendingIndex };
    }
  }
  return { task: null, location: null, index: -1 };
}

function updateTaskAdvanced(task, patch = {}) {
  const nextState = patch.state ? normalizeState(patch.state, task.state || 'queued') : (task.state || 'queued');
  const nextTask = normalizeTask({
    ...task,
    ...patch,
    state: nextState,
    status: nextState,
    lastAdvancedAt: Date.now(),
  }, task.owner || patch.owner || 'agent');
  return nextTask;
}

function activateTask(input = {}, options = {}) {
  const agent = normalizeAgent(input.agent || options.agent);
  if (!agent) throw new Error('invalid_agent');
  const queuePath = options.queuePath || getQueuePath();
  const { state } = readQueue(queuePath);
  const bucket = state.agents[agent] || createEmptyBucket();
  if (bucket.active) {
    return { ok: false, queuePath, reason: 'active_task_exists', task: bucket.active };
  }
  const taskId = trimText(input.taskId);
  const index = taskId
    ? bucket.pending.findIndex((task) => task.taskId === taskId)
    : bucket.pending.findIndex((task) => !isParkedTask(task));
  if (index < 0 || !bucket.pending[index]) {
    const parked = !taskId ? bucket.pending.find((task) => isParkedTask(task)) : null;
    if (parked) return { ok: false, queuePath, reason: 'task_parked', task: parked };
    return { ok: false, queuePath, reason: 'no_pending_task' };
  }
  if (isParkedTask(bucket.pending[index])) {
    return { ok: false, queuePath, reason: 'task_parked', task: bucket.pending[index] };
  }
  const [task] = bucket.pending.splice(index, 1);
  bucket.active = updateTaskAdvanced(task, {
    state: 'active',
    nextStep: input.nextStep || task.nextStep,
    handoffSummary: input.handoffSummary || task.handoffSummary,
  });
  state.agents[agent] = bucket;
  writeQueue(state, queuePath);
  return { ok: true, queuePath, task: bucket.active };
}

function blockTask(input = {}, options = {}) {
  const agent = normalizeAgent(input.agent || options.agent);
  if (!agent) throw new Error('invalid_agent');
  const blockedReason = trimText(input.blockedReason || input.reason);
  if (!blockedReason) throw new Error('blocked_reason_required');
  const queuePath = options.queuePath || getQueuePath();
  const { state } = readQueue(queuePath);
  const bucket = state.agents[agent] || createEmptyBucket();
  const found = findTaskInBucket(bucket, input.taskId);
  if (!found.task) return { ok: false, queuePath, reason: 'task_not_found' };
  if (isParkedTask(found.task)) return { ok: false, queuePath, reason: 'task_parked', task: found.task };
  const blocked = updateTaskAdvanced(found.task, {
    state: 'blocked',
    blockedReason,
    wakeTrigger: input.wakeTrigger || found.task.wakeTrigger,
    continueAfter: input.continueAfter || found.task.continueAfter,
    nextStep: input.nextStep || found.task.nextStep,
    handoffSummary: input.handoffSummary || found.task.handoffSummary,
  });
  if (found.location === 'active') bucket.active = blocked;
  else bucket.pending[found.index] = blocked;
  state.agents[agent] = bucket;
  writeQueue(state, queuePath);
  return { ok: true, queuePath, task: blocked };
}

function unblockTask(input = {}, options = {}) {
  const agent = normalizeAgent(input.agent || options.agent);
  if (!agent) throw new Error('invalid_agent');
  const queuePath = options.queuePath || getQueuePath();
  const { state } = readQueue(queuePath);
  const bucket = state.agents[agent] || createEmptyBucket();
  const found = findTaskInBucket(bucket, input.taskId);
  if (!found.task) return { ok: false, queuePath, reason: 'task_not_found' };
  if (isParkedTask(found.task)) return { ok: false, queuePath, reason: 'task_parked', task: found.task };
  const unblocked = updateTaskAdvanced(found.task, {
    state: found.location === 'active' ? 'active' : 'queued',
    blockedReason: null,
    wakeTrigger: input.wakeTrigger || found.task.wakeTrigger,
    continueAfter: input.continueAfter || found.task.continueAfter,
    nextStep: input.nextStep || found.task.nextStep,
    handoffSummary: input.handoffSummary || found.task.handoffSummary,
  });
  if (found.location === 'active') bucket.active = unblocked;
  else bucket.pending[found.index] = unblocked;
  state.agents[agent] = bucket;
  writeQueue(state, queuePath);
  return { ok: true, queuePath, task: unblocked };
}

function continueTask(input = {}, options = {}) {
  const agent = normalizeAgent(input.agent || options.agent);
  if (!agent) throw new Error('invalid_agent');
  const queuePath = options.queuePath || getQueuePath();
  const { state } = readQueue(queuePath);
  const bucket = state.agents[agent] || createEmptyBucket();
  const found = findTaskInBucket(bucket, input.taskId);
  if (!found.task) return { ok: false, queuePath, reason: 'task_not_found' };
  if (isParkedTask(found.task)) {
    return { ok: false, queuePath, reason: 'task_parked', task: found.task };
  }
  if (found.task.riskClass === 'approval_required') {
    return { ok: false, queuePath, reason: 'approval_required', task: found.task };
  }
  if (bucket.active && found.location !== 'active') {
    return { ok: false, queuePath, reason: 'active_task_exists', task: bucket.active };
  }
  const continued = updateTaskAdvanced(found.task, {
    state: 'active',
    blockedReason: null,
    nextStep: input.nextStep || found.task.nextStep,
    handoffSummary: input.handoffSummary || found.task.handoffSummary,
    lastDispatchAtMs: input.lastDispatchAtMs || found.task.lastDispatchAtMs,
  });
  if (found.location === 'pending') {
    bucket.pending.splice(found.index, 1);
  }
  bucket.active = continued;
  state.agents[agent] = bucket;
  writeQueue(state, queuePath);
  return { ok: true, queuePath, task: continued };
}

function parkTask(input = {}, options = {}) {
  const agent = normalizeAgent(input.agent || options.agent);
  if (!agent) throw new Error('invalid_agent');
  const parkedReason = trimText(input.parkedReason || input.reason || input.blockedReason) || DEFAULT_PARKED_REASON;
  const queuePath = options.queuePath || getQueuePath();
  const { state } = readQueue(queuePath);
  const bucket = state.agents[agent] || createEmptyBucket();
  const found = findTaskInBucket(bucket, input.taskId);
  if (!found.task) return { ok: false, queuePath, reason: 'task_not_found' };
  const parked = updateTaskAdvanced(found.task, {
    state: 'parked',
    blockedReason: parkedReason,
    wakeTrigger: input.wakeTrigger || found.task.wakeTrigger,
    continueAfter: input.continueAfter || found.task.continueAfter,
    nextStep: input.nextStep || found.task.nextStep,
    handoffSummary: input.handoffSummary || found.task.handoffSummary,
    restartPersistence: true,
    completionReason: null,
    completedAtMs: 0,
  });
  parked.restartPersistence = true;
  parked.completedAtMs = 0;
  parked.completionReason = null;
  if (found.location === 'active') {
    bucket.active = null;
    bucket.pending.unshift(parked);
  } else {
    bucket.pending[found.index] = parked;
  }
  state.agents[agent] = bucket;
  writeQueue(state, queuePath);
  return { ok: true, queuePath, task: parked };
}

function unparkTask(input = {}, options = {}) {
  const agent = normalizeAgent(input.agent || options.agent);
  if (!agent) throw new Error('invalid_agent');
  const taskId = trimText(input.taskId);
  if (!taskId) return { ok: false, queuePath: options.queuePath || getQueuePath(), reason: 'task_id_required' };
  const queuePath = options.queuePath || getQueuePath();
  const { state } = readQueue(queuePath);
  const bucket = state.agents[agent] || createEmptyBucket();
  const index = bucket.pending.findIndex((task) => task.taskId === taskId);
  if (index < 0 || !bucket.pending[index]) {
    return { ok: false, queuePath, reason: 'task_not_found' };
  }
  if (!isParkedTask(bucket.pending[index])) {
    return { ok: false, queuePath, reason: 'task_not_parked', task: bucket.pending[index] };
  }
  const unparked = updateTaskAdvanced(bucket.pending[index], {
    state: 'queued',
    blockedReason: null,
    wakeTrigger: input.wakeTrigger || bucket.pending[index].wakeTrigger,
    continueAfter: input.continueAfter || bucket.pending[index].continueAfter,
    nextStep: input.nextStep || bucket.pending[index].nextStep,
    handoffSummary: input.handoffSummary || bucket.pending[index].handoffSummary,
  });
  bucket.pending[index] = unparked;
  state.agents[agent] = bucket;
  writeQueue(state, queuePath);
  return { ok: true, queuePath, task: unparked };
}

function closeActiveTask(input = {}, options = {}, closeState = 'done') {
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
  const closedTask = updateTaskAdvanced(bucket.active, {
    state: closeState,
    completionReason: trimText(input.reason) || (closeState === 'failed' ? 'manual_fail' : 'manual_complete'),
    handoffSummary: input.handoffSummary || bucket.active.handoffSummary,
  });
  closedTask.completedAtMs = Date.now();
  bucket.active = null;
  bucket.history.push(closedTask);
  bucket.history = bucket.history.slice(-DEFAULT_HISTORY_LIMIT);
  state.agents[agent] = bucket;
  writeQueue(state, queuePath);
  return {
    ok: true,
    queuePath,
    task: closedTask,
  };
}

function completeActiveTask(input = {}, options = {}) {
  return closeActiveTask(input, options, 'done');
}

function failActiveTask(input = {}, options = {}) {
  return closeActiveTask(input, options, 'failed');
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
  console.log('          [--source <role>] [--risk-class <safe|caution|approval_required>] [--next-step <text>]');
  console.log('          [--blocked-reason <text>] [--wake-trigger <text>] [--continue-after <time>] [--handoff-summary <text>]');
  console.log('          [--completion-sentinel <text>] [--idle-completion-ms <ms>] [--response-timeout-ms <ms>]');
  console.log('  list');
  console.log('  activate --agent <architect|builder|oracle> [--task-id <id>] [--next-step <text>]');
  console.log('  park --agent <architect|builder|oracle> [--task-id <id>] --reason <text> [--next-step <text>]');
  console.log('  unpark --agent <architect|builder|oracle> --task-id <id> [--next-step <text>]');
  console.log('  block --agent <architect|builder|oracle> [--task-id <id>] --reason <text> [--wake-trigger <text>] [--continue-after <time>]');
  console.log('  unblock --agent <architect|builder|oracle> [--task-id <id>] [--next-step <text>]');
  console.log('  continue --agent <architect|builder|oracle> [--task-id <id>] [--next-step <text>]');
  console.log('  wake [--trigger <post-wake>] [--agent <architect|builder|oracle>] [--now <iso/ms>] [--dispatch]');
  console.log('  complete --agent <architect|builder|oracle> [--reason <text>]');
  console.log('  fail --agent <architect|builder|oracle> [--reason <text>]');
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

function isOptionEnabled(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function formatListResult(result) {
  const lines = [
    `queuePath=${result.queuePath}`,
    `updatedAt=${result.updatedAt || 'n/a'}`,
  ];
  for (const agent of ['architect', 'builder', 'oracle']) {
    const summary = result.summary[agent];
    lines.push(
      `${agent}: pending=${summary.pending} active=${summary.active ? `${summary.active.taskId}:${summary.active.state}` : 'none'} history=${summary.history}`
    );
    if (summary.active) {
      lines.push(
        `  carrying=${summary.active.title || summary.active.taskId} risk=${summary.active.riskClass} next=${summary.active.nextStep || 'n/a'} blocked=${summary.active.blockedReason || 'none'}`
      );
    }
  }
  return lines.join('\n');
}

function formatWakeResult(result) {
  const lines = [
    `queuePath=${result.queuePath}`,
    `trigger=${result.trigger}`,
    `candidates=${result.candidates.length} held=${result.held.length} dispatched=${result.dispatched?.length || 0} skipped=${result.skipped?.length || 0}`,
  ];
  for (const candidate of result.candidates) {
    lines.push(
      `${candidate.agent}: ${candidate.taskId} risk=${candidate.riskClass} state=${candidate.state} ready=${candidate.dispatchReady ? 'yes' : 'no'} next=${candidate.nextStep || 'n/a'}`
    );
  }
  for (const held of result.held) {
    lines.push(
      `held ${held.agent}: ${held.taskId} reason=${held.holdReason || held.blockedReason || 'held'}`
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
      riskClass: getOption(options, 'risk-class'),
      nextStep: getOption(options, 'next-step'),
      blockedReason: getOption(options, 'blocked-reason'),
      wakeTrigger: getOption(options, 'wake-trigger'),
      continueAfter: getOption(options, 'continue-after'),
      restartPersistence: getOption(options, 'restart-persistence') === 'false' ? false : true,
      handoffSummary: getOption(options, 'handoff-summary'),
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

  if (command === 'activate') {
    const result = activateTask({
      agent: getOption(options, 'agent'),
      taskId: getOption(options, 'task-id'),
      nextStep: getOption(options, 'next-step'),
      handoffSummary: getOption(options, 'handoff-summary'),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (command === 'block') {
    const result = blockTask({
      agent: getOption(options, 'agent'),
      taskId: getOption(options, 'task-id'),
      reason: getOption(options, 'reason'),
      blockedReason: getOption(options, 'blocked-reason'),
      nextStep: getOption(options, 'next-step'),
      wakeTrigger: getOption(options, 'wake-trigger'),
      continueAfter: getOption(options, 'continue-after'),
      handoffSummary: getOption(options, 'handoff-summary'),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (command === 'park') {
    const result = parkTask({
      agent: getOption(options, 'agent'),
      taskId: getOption(options, 'task-id'),
      reason: getOption(options, 'reason'),
      blockedReason: getOption(options, 'blocked-reason'),
      nextStep: getOption(options, 'next-step'),
      wakeTrigger: getOption(options, 'wake-trigger'),
      continueAfter: getOption(options, 'continue-after'),
      handoffSummary: getOption(options, 'handoff-summary'),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (command === 'unpark') {
    const result = unparkTask({
      agent: getOption(options, 'agent'),
      taskId: getOption(options, 'task-id'),
      nextStep: getOption(options, 'next-step'),
      wakeTrigger: getOption(options, 'wake-trigger'),
      continueAfter: getOption(options, 'continue-after'),
      handoffSummary: getOption(options, 'handoff-summary'),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (command === 'unblock') {
    const result = unblockTask({
      agent: getOption(options, 'agent'),
      taskId: getOption(options, 'task-id'),
      nextStep: getOption(options, 'next-step'),
      wakeTrigger: getOption(options, 'wake-trigger'),
      continueAfter: getOption(options, 'continue-after'),
      handoffSummary: getOption(options, 'handoff-summary'),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (command === 'continue') {
    const result = continueTask({
      agent: getOption(options, 'agent'),
      taskId: getOption(options, 'task-id'),
      nextStep: getOption(options, 'next-step'),
      handoffSummary: getOption(options, 'handoff-summary'),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (command === 'wake') {
    const sharedOptions = {
      agent: getOption(options, 'agent'),
      wakeTrigger: getOption(options, 'trigger') || getOption(options, 'wake-trigger') || 'post-wake',
      nowMs: getOption(options, 'now'),
    };
    if (isOptionEnabled(getOption(options, 'dispatch'))) {
      return dispatchWakeCandidates({
        ...sharedOptions,
        dispatcher: async (candidate) => ({ ok: true, emittedPrompt: candidate.prompt }),
      }).then((result) => {
        console.log(JSON.stringify(result, null, 2));
        return result.skipped?.length ? 1 : 0;
      });
    }
    const result = collectWakeCandidates(sharedOptions);
    console.log(isOptionEnabled(getOption(options, 'json'))
      ? JSON.stringify(result, null, 2)
      : formatWakeResult({ ...result, dispatched: [], skipped: [] }));
    return 0;
  }

  if (command === 'complete') {
    const result = completeActiveTask({
      agent: getOption(options, 'agent'),
      reason: getOption(options, 'reason'),
      handoffSummary: getOption(options, 'handoff-summary'),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (command === 'fail') {
    const result = failActiveTask({
      agent: getOption(options, 'agent'),
      reason: getOption(options, 'reason'),
      handoffSummary: getOption(options, 'handoff-summary'),
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
    const result = main();
    if (result && typeof result.then === 'function') {
      result
        .then((code) => { process.exitCode = code; })
        .catch((err) => {
          process.stderr.write(`${err.message}\n`);
          process.exitCode = 1;
        });
    } else {
      process.exitCode = result;
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_QUEUE_RELATIVE_PATH,
  DEFAULT_APPROVAL_HOLD_REASON,
  DEFAULT_PARKED_REASON,
  PARKED_HISTORY_COMPLETION_REASON,
  QUEUE_SCHEMA_VERSION,
  VALID_AGENTS,
  VALID_STATES,
  VALID_RISK_CLASSES,
  getQueuePath,
  buildDefaultQueueState,
  createBrokenJsonError,
  normalizeQueueState,
  normalizeTask,
  inferRiskClass,
  buildContinuePrompt,
  collectWakeCandidates,
  dispatchWakeCandidates,
  readQueue,
  writeQueue,
  toBrokenState,
  enqueueTask,
  listQueue,
  activateTask,
  parkTask,
  unparkTask,
  blockTask,
  unblockTask,
  continueTask,
  completeActiveTask,
  failActiveTask,
  clearQueue,
  parseArgs,
  formatListResult,
  formatWakeResult,
  main,
};
