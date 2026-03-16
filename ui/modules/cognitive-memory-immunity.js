const fs = require('fs');
const path = require('path');
const { getDatabaseSync } = require('./sqlite-compat');
const { CognitiveMemoryApi } = require('./cognitive-memory-api');
const { CognitiveMemoryStore } = require('./cognitive-memory-store');
const { normalizeDomain, deriveTaskScopes } = require('./team-memory/daily-integration');
const { resolveCoordPath } = require('../config');

const DatabaseSync = getDatabaseSync();
const IMMUNE_PROMOTION_CONFIDENCE = 0.85;
const IMMUNE_SESSION_WINDOW = 3;
const DEFAULT_SUPERVISOR_SCAN_LIMIT = 200;

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function tokenize(value) {
  return normalizeWhitespace(value).toLowerCase().match(/[a-z0-9_]+/g) || [];
}

function normalizeObjectiveKey(value) {
  const tokens = tokenize(value).filter((token) => ![
    'task',
    'work',
    'done',
    'complete',
    'completed',
    'finished',
    'ready',
    'review',
    'handoff',
    'handing',
    'triggered',
    'triggering',
  ].includes(token));
  return tokens.join(' ');
}

function parseJson(value, fallback = {}) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseSessionNumber(value) {
  if (value == null || value === '') return null;
  const numeric = Number.parseInt(String(value), 10);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const match = String(value).match(/(\d+)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function collectFileTargets(...sources) {
  const targets = new Set();
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const candidates = [];
    if (Array.isArray(source.files)) candidates.push(...source.files);
    if (Array.isArray(source.scopes)) candidates.push(...source.scopes);
    if (Array.isArray(source.fileTargets)) candidates.push(...source.fileTargets);
    for (const candidate of candidates) {
      const normalized = normalizeWhitespace(candidate).replace(/\\/g, '/');
      if (!normalized || normalized.startsWith('domain:') || normalized.startsWith('task:')) continue;
      targets.add(normalized);
    }
  }
  return Array.from(targets).sort((left, right) => left.localeCompare(right));
}

function summarizeFiles(files = []) {
  if (!Array.isArray(files) || files.length === 0) return '';
  if (files.length === 1) return `Primary file target: ${files[0]}.`;
  return `Primary file targets: ${files.slice(0, 3).join(', ')}.`;
}

function summarizeTaskText(task = {}, metadata = {}, fallback = '') {
  const pieces = [
    task.subject,
    task.description,
    task.objective,
    metadata.summary,
    metadata.result,
    metadata.resultSummary,
    metadata.notes,
    fallback,
  ].map((value) => normalizeWhitespace(value)).filter(Boolean);
  return pieces[0] || '';
}

function resolveTaskDomain(task = {}, metadata = {}, explicit = '') {
  return normalizeDomain(explicit || task?.metadata?.domain || metadata?.domain || '');
}

function deriveStatus(status, fallbackText = '') {
  const normalized = normalizeWhitespace(status).toLowerCase();
  if (normalized) return normalized;
  const text = normalizeWhitespace(fallbackText).toLowerCase();
  if (/handoff|handing off|ready for handoff/.test(text)) return 'handoff';
  if (/needs[_\s-]?input/.test(text)) return 'needs_input';
  if (/fail|failed|error/.test(text)) return 'failed';
  if (/complete|completed|done|finished|ready for review/.test(text)) return 'completed';
  return '';
}

function buildImmediateTaskCandidate(input = {}) {
  const task = input.task && typeof input.task === 'object' ? input.task : {};
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const status = deriveStatus(input.status, input.text || summarizeTaskText(task, metadata));
  if (!['completed', 'handoff', 'needs_input'].includes(status)) {
    return null;
  }

  const objective = normalizeWhitespace(
    input.objective
    || task.objective
    || summarizeTaskText(task, metadata, input.text)
    || input.text
  );
  if (!objective) return null;

  const fileTargets = collectFileTargets(task, metadata, input.contextSnapshot);
  const summary = summarizeTaskText(task, metadata, input.text) || objective;
  const taskId = normalizeWhitespace(input.taskId || task.id);
  const domain = resolveTaskDomain(task, metadata, input.domain);
  const session = parseSessionNumber(
    input.session
    || metadata.session
    || task?.metadata?.session
    || input.contextSnapshot?.session
  );

  const prefix = status === 'handoff' || status === 'needs_input'
    ? `Handoff pattern for "${objective}":`
    : `What worked for "${objective}":`;
  const action = status === 'handoff' || status === 'needs_input'
    ? 'Preserve the next-step context in one concise paragraph so another agent can continue without re-discovery.'
    : 'Reuse the same approach when the objective or file targets match.';
  const statement = normalizeWhitespace(`${prefix} ${summary}. ${summarizeFiles(fileTargets)} ${action}`);

  return {
    category: 'workflow',
    statement,
    confidence_score: status === 'completed' ? 0.72 : 0.7,
    review_count: 0,
    domain: domain || 'task_immunity',
    proposed_by: 'task-immunity',
    source_trace: taskId ? `task:${taskId}` : `completion:${normalizeObjectiveKey(objective)}`,
    source_payload: {
      type: 'POST_TASK_EXTRACTION',
      status,
      objective,
      taskId: taskId || null,
      domain: domain || null,
      files: fileTargets,
      session,
    },
  };
}

async function stageImmediateTaskExtraction(input = {}, options = {}) {
  const candidate = buildImmediateTaskCandidate(input);
  if (!candidate) {
    return { ok: true, staged: [], merged: [], pendingCount: 0, skipped: true, reason: 'status_not_extractable' };
  }
  const store = options.store || new CognitiveMemoryStore(options.storeOptions || {});
  const ownsStore = !options.store;
  try {
    return store.stageMemoryPRs([candidate], options.stageOptions || {});
  } finally {
    if (ownsStore) {
      try { store.close(); } catch {}
    }
  }
}

function resolveSupervisorDbPath(value = null) {
  if (value) return path.resolve(String(value));
  return resolveCoordPath(path.join('runtime', 'supervisor.sqlite'), { forWrite: true });
}

function normalizeSupervisorTaskRow(row) {
  const contextSnapshot = parseJson(row.context_snapshot_json, {});
  const resultPayload = parseJson(row.result_payload_json, null);
  const errorPayload = parseJson(row.error_payload_json, null);
  const metadata = (contextSnapshot && typeof contextSnapshot.metadata === 'object' && !Array.isArray(contextSnapshot.metadata))
    ? contextSnapshot.metadata
    : {};
  const files = collectFileTargets(contextSnapshot, metadata);
  const objective = normalizeWhitespace(row.objective);
  return {
    taskId: String(row.task_id || ''),
    objective,
    objectiveKey: normalizeObjectiveKey(objective),
    status: normalizeWhitespace(row.status).toLowerCase(),
    ownerPane: normalizeWhitespace(row.owner_pane),
    files,
    fileKey: files.join('|'),
    contextSnapshot,
    metadata,
    resultPayload,
    errorPayload,
    completedAtMs: Number(row.completed_at_ms || 0),
    updatedAtMs: Number(row.updated_at_ms || 0),
    createdAtMs: Number(row.created_at_ms || 0),
    session: parseSessionNumber(
      contextSnapshot.session
      || metadata.session
      || contextSnapshot.sessionId
      || metadata.sessionId
    ),
    summary: normalizeWhitespace(
      resultPayload?.resultSummary
      || resultPayload?.summary
      || resultPayload?.stdoutTail
      || metadata.resultSummary
      || metadata.summary
      || ''
    ),
    errorMessage: normalizeWhitespace(
      errorPayload?.message
      || errorPayload?.stderrTail
      || metadata?.error?.message
      || metadata?.errorMessage
      || ''
    ),
  };
}

function loadSupervisorResolvedTasks(options = {}) {
  const dbPath = resolveSupervisorDbPath(options.supervisorDbPath);
  if (!fs.existsSync(dbPath)) return [];
  const limit = Math.max(1, Math.min(1000, Number.parseInt(options.limit || `${DEFAULT_SUPERVISOR_SCAN_LIMIT}`, 10) || DEFAULT_SUPERVISOR_SCAN_LIMIT));
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`
      SELECT *
      FROM supervisor_tasks
      WHERE status IN ('complete', 'failed')
      ORDER BY completed_at_ms DESC, updated_at_ms DESC
      LIMIT ?
    `).all(limit).map(normalizeSupervisorTaskRow);
  } finally {
    try { db.close(); } catch {}
  }
}

function recordsMatchByObjectiveOrFiles(failedRecord, successRecord) {
  if (!failedRecord || !successRecord) return false;
  if (failedRecord.taskId === successRecord.taskId) return false;
  if (failedRecord.completedAtMs > successRecord.completedAtMs) return false;

  const objectiveMatch = Boolean(
    failedRecord.objectiveKey
    && successRecord.objectiveKey
    && failedRecord.objectiveKey === successRecord.objectiveKey
  );
  if (objectiveMatch) return true;

  if (!failedRecord.files.length || !successRecord.files.length) return false;
  const successFiles = new Set(successRecord.files);
  return failedRecord.files.some((file) => successFiles.has(file));
}

function isWithinSessionWindow(failedRecord, successRecord, maxWindow = IMMUNE_SESSION_WINDOW) {
  const failedSession = Number(failedRecord?.session || 0);
  const successSession = Number(successRecord?.session || 0);
  if (failedSession > 0 && successSession > 0) {
    return successSession >= failedSession && (successSession - failedSession) <= maxWindow;
  }
  return true;
}

function buildFailureDrivenAntibody(failedRecord, successRecord) {
  if (!recordsMatchByObjectiveOrFiles(failedRecord, successRecord)) return null;
  if (!isWithinSessionWindow(failedRecord, successRecord)) return null;

  const objective = successRecord.objective || failedRecord.objective;
  const failureReason = failedRecord.errorMessage || 'the previous attempt did not hold';
  const correction = successRecord.summary
    || `repeat the successful implementation path for ${objective}`;
  const files = collectFileTargets(failedRecord, successRecord);
  const domain = resolveTaskDomain(
    { metadata: failedRecord.metadata || {} },
    successRecord.metadata || {},
    failedRecord.metadata?.domain || successRecord.metadata?.domain || ''
  );

  return {
    category: 'workflow',
    statement: normalizeWhitespace(
      `When "${objective}" failed, the failure mode was ${failureReason}. `
      + `The correction that worked was ${correction}. `
      + `${summarizeFiles(files)} Reuse this exact fix pattern before trying a novel path.`
    ),
    confidence_score: IMMUNE_PROMOTION_CONFIDENCE,
    review_count: 1,
    domain: domain || 'task_immunity',
    proposed_by: 'sleep-antibody',
    correction_of: failedRecord.taskId || null,
    source_trace: [failedRecord.taskId, successRecord.taskId].filter(Boolean).join('->'),
    source_payload: {
      type: 'FAILURE_DRIVEN_ANTIBODY',
      objective,
      failedTaskId: failedRecord.taskId || null,
      successTaskId: successRecord.taskId || null,
      failedSession: failedRecord.session || null,
      successSession: successRecord.session || null,
      files,
      failureReason,
      correction,
    },
  };
}

function buildFailureDrivenAntibodies(records = []) {
  const failures = records
    .filter((record) => record.status === 'failed')
    .sort((left, right) => left.completedAtMs - right.completedAtMs);
  const successes = records
    .filter((record) => record.status === 'complete')
    .sort((left, right) => left.completedAtMs - right.completedAtMs);
  const candidates = [];
  const seen = new Set();

  for (const successRecord of successes) {
    for (const failedRecord of failures) {
      const candidate = buildFailureDrivenAntibody(failedRecord, successRecord);
      if (!candidate) continue;
      const key = `${candidate.category}:${candidate.statement.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
      break;
    }
  }

  return candidates;
}

async function promoteImmuneCandidates(candidates = [], options = {}) {
  const promotable = (Array.isArray(candidates) ? candidates : []).filter((candidate) => (
    Number(candidate?.confidence_score || 0) >= IMMUNE_PROMOTION_CONFIDENCE
  ));
  if (promotable.length === 0) {
    return { ok: true, promoted: [], skipped: true, reason: 'no_candidates' };
  }

  const api = options.api || new CognitiveMemoryApi({
    cognitiveStore: options.store,
    memorySearchIndex: options.memorySearchIndex,
  });
  const ownsApi = !options.api;
  const promoted = [];

  try {
    for (const candidate of promotable) {
      const ingestResult = await api.ingest({
        content: candidate.statement,
        category: candidate.category || 'workflow',
        agentId: options.agentId || 'sleep-cycle',
        sourceType: 'immune-behavior',
        sourcePath: `immune:${candidate.domain || 'task_immunity'}`,
        title: 'Immune heuristic',
        heading: candidate.domain || 'task_immunity',
        metadata: {
          ...(candidate.source_payload || {}),
          correctionOf: candidate.correction_of || null,
          promotedBy: options.promotedBy || 'sleep-cycle',
          immuneThreshold: IMMUNE_PROMOTION_CONFIDENCE,
        },
        confidence: candidate.confidence_score,
        isImmune: true,
        command: 'immunity-promotion',
        ingestedVia: 'behavioral-layer',
      });
      if (!ingestResult?.ok || !ingestResult?.node?.nodeId) continue;
      const immuneResult = await api.setImmune(ingestResult.node.nodeId, true, {
        agentId: options.agentId || 'sleep-cycle',
        reason: 'behavioral_auto_promotion',
      });
      promoted.push({
        nodeId: immuneResult?.node?.nodeId || ingestResult.node.nodeId,
        statement: candidate.statement,
        confidenceScore: candidate.confidence_score,
      });
    }
    return { ok: true, promoted };
  } finally {
    if (ownsApi) {
      try { api.close(); } catch {}
    }
  }
}

async function runBehavioralSleepPromotion(options = {}) {
  const records = loadSupervisorResolvedTasks({
    supervisorDbPath: options.supervisorDbPath,
    limit: options.limit,
  });
  const candidates = buildFailureDrivenAntibodies(records);
  if (candidates.length === 0) {
    return {
      ok: true,
      scannedRecords: records.length,
      candidateCount: 0,
      staged: 0,
      merged: 0,
      promoted: 0,
      skipped: true,
      reason: 'no_failure_success_matches',
    };
  }

  const store = options.store || new CognitiveMemoryStore(options.storeOptions || {});
  const ownsStore = !options.store;
  try {
    const staged = store.stageMemoryPRs(candidates);
    const promoted = await promoteImmuneCandidates(candidates, {
      api: options.api,
      store,
      memorySearchIndex: options.memorySearchIndex,
      agentId: options.agentId || 'sleep-cycle',
      promotedBy: options.promotedBy || 'sleep-cycle',
    });
    return {
      ok: true,
      scannedRecords: records.length,
      candidateCount: candidates.length,
      staged: Number(staged?.staged?.length || 0),
      merged: Number(staged?.merged?.length || 0),
      promoted: Number(promoted?.promoted?.length || 0),
      candidates,
    };
  } finally {
    if (ownsStore) {
      try { store.close(); } catch {}
    }
  }
}

module.exports = {
  IMMUNE_PROMOTION_CONFIDENCE,
  IMMUNE_SESSION_WINDOW,
  buildFailureDrivenAntibodies,
  buildImmediateTaskCandidate,
  loadSupervisorResolvedTasks,
  promoteImmuneCandidates,
  runBehavioralSleepPromotion,
  stageImmediateTaskExtraction,
};
