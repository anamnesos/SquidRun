const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getProjectRoot, resolveCoordPath } = require('../config');
const { queryCommsJournalEntries } = require('./main/comms-journal');

const execFileAsync = promisify(execFile);

const DEFAULT_CLASSIFIER_TIMEOUT_MS = 90_000;
const DEFAULT_CLASSIFIER_POLL_MS = 1_000;
const DEFAULT_CLASSIFIER_AGENTS = Object.freeze(
  String(process.env.SQUIDRUN_ANTIBODY_CLASSIFIER_AGENTS || 'architect,oracle')
    .split(',')
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
);
const DEFAULT_REQUESTS_DIR = resolveCoordPath(path.join('runtime', 'antibody-requests'), { forWrite: true });
const DEFAULT_RESPONSES_DIR = resolveCoordPath(path.join('runtime', 'antibody-responses'), { forWrite: true });
const NEGATION_TOKENS = new Set(['not', 'no', 'never', 'without', 'cannot', 'cant', "doesn't", "isn't", "wasn't"]);
const BOOLEAN_PAIRS = Object.freeze([
  ['enabled', 'disabled'],
  ['allow', 'deny'],
  ['allowed', 'denied'],
  ['public', 'private'],
  ['sync', 'async'],
  ['oauth', 'apikey'],
  ['oauth2', 'apikey'],
  ['sandbox', 'production'],
]);
const MUTUALLY_EXCLUSIVE_GROUPS = Object.freeze([
  ['oauth', 'oauth2', 'apikey'],
  ['enabled', 'disabled'],
  ['public', 'private'],
  ['sync', 'async'],
  ['sandbox', 'production'],
  ['yes', 'no'],
  ['true', 'false'],
]);
const UPDATE_HINTS = new Set(['now', 'currently', 'updated', 'migrated', 'legacy', 'deprecated', 'previously', 'formerly']);

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeToken(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function tokenize(value) {
  return normalizeToken(value).match(/[a-z0-9_./-]+/g) || [];
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toIsoTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function resolveRequestsDir(options = {}) {
  return options.requestsDir || DEFAULT_REQUESTS_DIR;
}

function resolveResponsesDir(options = {}) {
  return options.responsesDir || DEFAULT_RESPONSES_DIR;
}

function generateId(prefix = 'antibody') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function uniqueStrings(values = []) {
  return Array.from(new Set((values || []).map((value) => normalizeToken(value)).filter(Boolean)));
}

function isObjectiveFactScope(node) {
  const scope = extractMemoryScope(node);
  return scope.claimType === 'objective_fact' || scope.memoryClass === 'architecture_decision' || scope.memoryClass === 'codebase_inventory';
}

function extractMemoryScope(node) {
  const metadata = node?.metadata && typeof node.metadata === 'object' && !Array.isArray(node.metadata)
    ? node.metadata
    : {};
  return {
    memoryClass: normalizeToken(metadata.memoryClass || metadata.memory_class || ''),
    claimType: normalizeToken(metadata.claimType || metadata.claim_type || ''),
    domain: normalizeToken(metadata.domain || metadata.claim_domain || metadata.topic || node?.heading || ''),
  };
}

function scopesCompatible(left, right) {
  const a = extractMemoryScope(left);
  const b = extractMemoryScope(right);
  if (a.memoryClass && b.memoryClass && a.memoryClass !== b.memoryClass) return false;
  if (a.claimType && b.claimType && a.claimType !== b.claimType) return false;
  if (a.domain && b.domain && a.domain !== b.domain) return false;
  return Boolean(
    (a.memoryClass && b.memoryClass)
    || (a.claimType && b.claimType)
    || (a.domain && b.domain)
  ) || (!a.memoryClass && !a.claimType && !a.domain) || (!b.memoryClass && !b.claimType && !b.domain);
}

function overlapRatio(leftTokens, rightTokens) {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / Math.max(left.size, right.size);
}

function extractNumbers(content) {
  return (String(content || '').match(/-?\d+(?:\.\d+)?/g) || []).map((value) => Number(value));
}

function hasNegation(tokens = []) {
  return tokens.some((token) => NEGATION_TOKENS.has(token));
}

function findBooleanFlip(leftTokens, rightTokens) {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  return BOOLEAN_PAIRS.find(([positive, negative]) => (
    (left.has(positive) && right.has(negative))
    || (left.has(negative) && right.has(positive))
  )) || null;
}

function findExclusiveGroupMismatch(leftTokens, rightTokens) {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  for (const group of MUTUALLY_EXCLUSIVE_GROUPS) {
    const leftMatches = group.filter((token) => left.has(token));
    const rightMatches = group.filter((token) => right.has(token));
    if (leftMatches.length === 0 || rightMatches.length === 0) continue;
    if (leftMatches.some((token) => rightMatches.includes(token))) continue;
    return { left: leftMatches, right: rightMatches };
  }
  return null;
}

function hasUpdateLanguage(tokens = []) {
  return tokens.some((token) => UPDATE_HINTS.has(token));
}

function isUserSourcedFact(input = {}) {
  const metadata = input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const candidates = [
    input.agentId,
    input.agent_id,
    input.agent,
    metadata.agentId,
    metadata.agent_id,
    metadata.sourceAuthority,
    metadata.source_authority,
    metadata.sourceRole,
    input.sourceType,
    input.source_type,
    input.sourcePath,
    input.source_path,
  ].map((value) => normalizeToken(value));

  if (metadata.userSourced === true || metadata.user_sourced === true || metadata.userOverride === true || metadata.user_override === true) {
    return true;
  }
  return candidates.some((value) => (
    value === 'user'
    || value === 'human'
    || value.startsWith('user:')
    || value.startsWith('human:')
    || value === 'user-correction'
  ));
}

function isAgentSourcedNode(node) {
  const metadata = node?.metadata && typeof node.metadata === 'object' && !Array.isArray(node.metadata)
    ? node.metadata
    : {};
  const sourcePath = normalizeToken(node?.sourcePath || '');
  const agentId = normalizeToken(metadata.agentId || metadata.agent_id || '');
  return Boolean(agentId || sourcePath.startsWith('agent:'));
}

function evaluateHeuristicRelation(leftNode, rightNode, options = {}) {
  const leftTokens = tokenize(leftNode?.content || '');
  const rightTokens = tokenize(rightNode?.content || '');
  const sharedRatio = overlapRatio(leftTokens, rightTokens);
  if (sharedRatio < Number(options.minSharedRatio || 0.35)) {
    return { label: 'uncertain', score: 0, reason: 'low_overlap' };
  }

  const leftNumbers = extractNumbers(leftNode?.content || '');
  const rightNumbers = extractNumbers(rightNode?.content || '');
  const negationMismatch = hasNegation(leftTokens) !== hasNegation(rightTokens);
  const booleanFlip = findBooleanFlip(leftTokens, rightTokens);
  const exclusiveMismatch = findExclusiveGroupMismatch(leftTokens, rightTokens);
  const numericMismatch = leftNumbers.length > 0
    && rightNumbers.length > 0
    && leftNumbers.some((value) => !rightNumbers.includes(value))
    && rightNumbers.some((value) => !leftNumbers.includes(value));
  const updateLanguage = hasUpdateLanguage(leftTokens) || hasUpdateLanguage(rightTokens);

  if (numericMismatch && sharedRatio >= 0.45) {
    return { label: updateLanguage ? 'update' : 'contradiction', score: updateLanguage ? 0.72 : 0.82, reason: 'numeric_mismatch' };
  }
  if (booleanFlip) {
    return { label: 'contradiction', score: 0.78, reason: `boolean_flip:${booleanFlip.join('_vs_')}` };
  }
  if (exclusiveMismatch) {
    return { label: updateLanguage ? 'update' : 'contradiction', score: updateLanguage ? 0.74 : 0.84, reason: 'exclusive_keyword_mismatch' };
  }
  if (negationMismatch && sharedRatio >= 0.55) {
    return { label: 'contradiction', score: 0.76, reason: 'negation_mismatch' };
  }
  if (updateLanguage && sharedRatio >= 0.45) {
    return { label: 'update', score: 0.6, reason: 'update_language' };
  }
  if (sharedRatio >= 0.78) {
    return { label: 'corroboration', score: 0.62, reason: 'high_overlap' };
  }
  if (sharedRatio >= 0.58) {
    return { label: 'coexistence', score: 0.56, reason: 'same_scope_nonexclusive' };
  }
  return { label: 'uncertain', score: 0.45, reason: 'ambiguous_overlap' };
}

async function findScopedConflictCandidates(api, node, options = {}) {
  const searchLimit = Math.max(4, Number.parseInt(options.limit || '8', 10) || 8);
  const queryVector = Array.isArray(node?.embedding) && node.embedding.length > 0
    ? node.embedding
    : await api.embedText(node?.content || '');
  return api.searchExistingNodes(queryVector, Math.max(searchLimit * 3, 12), {
    excludeNodeIds: [node?.nodeId],
    scopeNode: node,
    minimumConfidence: Number.isFinite(Number(options.minimumConfidence)) ? Number(options.minimumConfidence) : 0.5,
  });
}

async function runHeuristicScreen(api, node, options = {}) {
  const candidates = await findScopedConflictCandidates(api, node, options);
  const evaluated = candidates
    .filter((entry) => entry?.node && scopesCompatible(node, entry.node))
    .map((entry) => ({
      candidate: entry.node,
      distance: Number(entry.distance || 0),
      confidenceScore: Number(entry.node.confidenceScore || 0),
      ...evaluateHeuristicRelation(node, entry.node, options),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.confidenceScore - left.confidenceScore);

  return {
    ok: true,
    candidates: evaluated,
    primary: evaluated[0] || null,
  };
}

function createClassifierRequest(payload = {}) {
  const requestId = normalizeWhitespace(payload.requestId) || generateId('antibody-request');
  const createdAt = toIsoTimestamp(payload.createdAt, new Date().toISOString());
  const deadline = toIsoTimestamp(
    payload.deadline,
    new Date(Date.parse(createdAt) + Math.max(5_000, Number(payload.timeoutMs || DEFAULT_CLASSIFIER_TIMEOUT_MS))).toISOString()
  );
  return {
    requestId,
    createdAt,
    deadline,
    timeoutMs: Math.max(5_000, Number(payload.timeoutMs || DEFAULT_CLASSIFIER_TIMEOUT_MS)),
    queueId: normalizeWhitespace(payload.queueId || ''),
    nodeId: normalizeWhitespace(payload.nodeId || ''),
    conflictingNodeId: normalizeWhitespace(payload.conflictingNodeId || '') || null,
    heuristic: payload.heuristic || null,
    comparison: payload.comparison || null,
    scope: payload.scope || null,
  };
}

function resolveClassifierRequestPath(requestId, options = {}) {
  return path.join(resolveRequestsDir(options), `${requestId}.json`);
}

function resolveClassifierResponsePath(requestId, agentId, options = {}) {
  return path.join(resolveResponsesDir(options), `${requestId}-${agentId}.json`);
}

function writeClassifierRequest(payload = {}, options = {}) {
  const request = createClassifierRequest(payload);
  const requestPath = resolveClassifierRequestPath(request.requestId, options);
  ensureDir(requestPath);
  fs.writeFileSync(requestPath, JSON.stringify(request, null, 2));
  return { ...request, path: requestPath };
}

function writeClassifierResponse(response = {}, options = {}) {
  const normalized = {
    requestId: normalizeWhitespace(response.requestId),
    agentId: normalizeToken(response.agentId),
    classification: {
      status: normalizeToken(response?.classification?.status || 'uncertain'),
      confidence: Math.max(0, Math.min(1, Number(response?.classification?.confidence || 0))),
      reasoning: normalizeWhitespace(response?.classification?.reasoning || ''),
    },
  };
  if (!normalized.requestId || !normalized.agentId) {
    throw new Error('requestId and agentId are required');
  }
  const responsePath = resolveClassifierResponsePath(normalized.requestId, normalized.agentId, options);
  ensureDir(responsePath);
  fs.writeFileSync(responsePath, JSON.stringify(normalized, null, 2));
  return { ...normalized, path: responsePath };
}

function stripMessagePrefix(rawBody = '') {
  return String(rawBody || '')
    .replace(/^\s*\[AGENT MSG - reply via hm-send\.js\]\s*/i, '')
    .replace(/^\([^)]*\):\s*/, '')
    .trim();
}

function parseClassifierResponseBody(rawBody = '') {
  const text = stripMessagePrefix(rawBody);
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
    return {
      requestId: normalizeWhitespace(parsed.requestId),
      agentId: normalizeToken(parsed.agentId),
      classification: {
        status: normalizeToken(parsed?.classification?.status || 'uncertain'),
        confidence: Math.max(0, Math.min(1, Number(parsed?.classification?.confidence || 0))),
        reasoning: normalizeWhitespace(parsed?.classification?.reasoning || ''),
      },
    };
  } catch {
    return null;
  }
}

function buildClassifierPrompt(agentId, request = {}, options = {}) {
  const requestPath = resolveClassifierRequestPath(request.requestId, options);
  const relativePath = path.relative(getProjectRoot(), requestPath).replace(/\\/g, '/');
  const sample = JSON.stringify({
    requestId: request.requestId,
    agentId,
    classification: {
      status: 'contradiction',
      confidence: 0.81,
      reasoning: 'Both facts address the same scoped claim, but they make mutually exclusive assertions.',
    },
  });
  return [
    `Classify antibody request ${request.requestId} for cognitive memory contradiction screening.`,
    `Request context is in ${relativePath} (${requestPath}).`,
    'Return exactly one label: contradiction, update, corroboration, coexistence, or uncertain.',
    'Do not debate architecture here. Judge whether the new fact conflicts with the existing fact within the same scoped claim.',
    `Reply via hm-send architect with JSON: ${sample}`,
    `Deadline: ${request.deadline}.`,
    'Use your normal role prefix if needed, but keep the JSON itself valid and complete.',
  ].join(' ');
}

async function defaultClassifierSender(target, message, options = {}) {
  const hmSendPath = options.hmSendPath || path.join(getProjectRoot(), 'ui', 'scripts', 'hm-send.js');
  await execFileAsync(process.execPath, [hmSendPath, target, message], {
    cwd: options.cwd || getProjectRoot(),
    windowsHide: true,
    timeout: Math.max(5_000, Number(options.sendTimeoutMs || 30_000)),
  });
  return { ok: true };
}

async function dispatchClassifierRequests(request = {}, agentIds = [], options = {}) {
  const sender = typeof options.sender === 'function' ? options.sender : defaultClassifierSender;
  const deliveries = [];
  for (const agentId of agentIds) {
    const message = buildClassifierPrompt(agentId, request, options);
    try {
      const result = await sender(agentId, message, options);
      deliveries.push({ agentId, ok: result?.ok !== false, result: result || null });
    } catch (error) {
      deliveries.push({ agentId, ok: false, error: error?.message || String(error) });
    }
  }
  return deliveries;
}

async function collectClassifierResponses(request = {}, agentIds = [], options = {}) {
  const queryEntries = typeof options.queryEntries === 'function' ? options.queryEntries : queryCommsJournalEntries;
  const requestCreatedAtMs = Date.parse(request.createdAt || new Date().toISOString()) || Date.now();
  const deadlineMs = Date.parse(request.deadline || new Date(Date.now() + DEFAULT_CLASSIFIER_TIMEOUT_MS).toISOString())
    || (requestCreatedAtMs + DEFAULT_CLASSIFIER_TIMEOUT_MS);
  const pollMs = Math.max(100, Number(options.pollMs || DEFAULT_CLASSIFIER_POLL_MS));
  const responses = new Map();

  while (Date.now() <= deadlineMs && responses.size < agentIds.length) {
    for (const agentId of agentIds) {
      if (responses.has(agentId)) continue;
      const entries = queryEntries({
        channel: 'ws',
        direction: 'outbound',
        senderRole: agentId,
        sinceMs: requestCreatedAtMs,
        order: 'desc',
        limit: 100,
      }, { dbPath: options.dbPath || null });

      for (const entry of entries) {
        const parsed = parseClassifierResponseBody(entry.rawBody || '');
        if (!parsed || parsed.requestId !== request.requestId || parsed.agentId !== agentId) continue;
        writeClassifierResponse(parsed, options);
        responses.set(agentId, parsed);
        break;
      }
    }

    if (responses.size >= agentIds.length || Date.now() > deadlineMs) break;
    await sleep(pollMs);
  }

  return {
    requestId: request.requestId,
    responses: Array.from(responses.values()),
    missingAgents: agentIds.filter((agentId) => !responses.has(agentId)),
  };
}

function evaluateConsensus(responses = [], options = {}) {
  const requiredVotes = Math.max(1, Number.parseInt(options.requiredVotes || '2', 10) || 2);
  const tallies = new Map();
  for (const response of responses) {
    const status = normalizeToken(response?.classification?.status || 'uncertain');
    const bucket = tallies.get(status) || { status, votes: 0, confidence: [] };
    bucket.votes += 1;
    bucket.confidence.push(Math.max(0, Math.min(1, Number(response?.classification?.confidence || 0))));
    tallies.set(status, bucket);
  }
  const ranked = Array.from(tallies.values())
    .sort((left, right) => right.votes - left.votes || average(right.confidence) - average(left.confidence));
  const winner = ranked[0] || null;
  if (!winner) {
    return { status: 'uncertain', confidence: 0, consensus: false, votes: 0 };
  }
  return {
    status: winner.status,
    confidence: Number(average(winner.confidence).toFixed(4)),
    consensus: winner.votes >= requiredVotes,
    votes: winner.votes,
  };
}

function average(values = []) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function parseRequestPayload(queueItem) {
  return parseJson(queueItem?.payload_json, {});
}

function parseResultPayload(queueItem) {
  return parseJson(queueItem?.result_json, {});
}

async function processPostIngestAntibody(api, node, input = {}, options = {}) {
  if (!node?.nodeId) {
    return { ok: false, reason: 'node_required' };
  }

  if (isUserSourcedFact(input) || isUserSourcedFact(node)) {
    const screen = await runHeuristicScreen(api, node, { minimumConfidence: 0.5, limit: 8 });
    for (const entry of screen.candidates || []) {
      if (!['contradiction', 'update'].includes(entry.label) || !isAgentSourcedNode(entry.candidate)) continue;
      api.deprecateNode(entry.candidate.nodeId, {
        supersededByNodeId: node.nodeId,
        reason: 'user_override',
        actorId: 'user',
      });
      api.setAntibodyState(entry.candidate.nodeId, 'classified_conflict', {
        conflictsWithMemoryId: node.nodeId,
        antibodyScore: entry.score,
        classifiedBy: 'user_override',
        adjudicationStatus: 'accepted_correction',
        quarantinedAtMs: Date.now(),
      });
    }
    return { ok: true, bypassed: true, screen };
  }

  if (!isObjectiveFactScope(node)) {
    return { ok: true, skipped: true, reason: 'non_objective_scope' };
  }

  const screen = await runHeuristicScreen(api, node, { minimumConfidence: 0.5, limit: 8 });
  const primary = screen.primary;
  if (!primary || !primary.candidate) {
    return { ok: true, screen, status: 'clear' };
  }

  const conflictingHighConfidence = Number(primary.candidate.confidenceScore || 0) >= 0.8;
  const shouldFlag = primary.label === 'contradiction'
    ? conflictingHighConfidence || primary.score >= 0.7
    : (primary.label === 'update' || primary.label === 'coexistence')
      ? conflictingHighConfidence
      : false;
  const nextStatus = shouldFlag
    ? (primary.label === 'contradiction' ? 'suspected_conflict' : 'uncertain')
    : 'clear';

  if (nextStatus !== 'clear') {
    api.setAntibodyState(node.nodeId, nextStatus, {
      conflictsWithMemoryId: primary.candidate.nodeId,
      antibodyScore: primary.score,
      classifiedBy: 'heuristic_screen',
      adjudicationStatus: 'pending',
      quarantinedAtMs: Date.now(),
    });
  }

  const shouldQueue = ['contradiction', 'update', 'coexistence', 'uncertain'].includes(primary.label);
  let queue = null;
  if (shouldQueue) {
    queue = api.cognitiveStore.enqueueAntibodyJob({
      node_id: node.nodeId,
      conflicting_node_id: primary.candidate.nodeId,
      request_type: 'classification',
      status: 'pending',
      classifier_strategy: 'remote_consensus',
      heuristic_label: primary.label,
      heuristic_score: primary.score,
      payload: {
        nodeId: node.nodeId,
        conflictingNodeId: primary.candidate.nodeId,
        scope: extractMemoryScope(node),
        heuristic: {
          label: primary.label,
          score: primary.score,
          reason: primary.reason,
        },
      },
    });
  }

  const shouldDispatch = options.autoDispatch !== false
    && process.env.JEST_WORKER_ID == null
    && queue?.ok === true
    && typeof options.dispatchQueuedWork === 'function';
  if (shouldDispatch) {
    Promise.resolve(options.dispatchQueuedWork()).catch(() => {});
  }

  return {
    ok: true,
    screen,
    queue,
    status: nextStatus,
  };
}

class CognitiveMemoryAntibodyWorker {
  constructor(options = {}) {
    this.api = options.api;
    this.cognitiveStore = options.cognitiveStore || options.api?.cognitiveStore || null;
    this.logger = options.logger || console;
    this.sender = typeof options.sender === 'function' ? options.sender : defaultClassifierSender;
    this.queryEntries = typeof options.queryEntries === 'function' ? options.queryEntries : queryCommsJournalEntries;
    this.classifierAgents = Array.isArray(options.classifierAgents) && options.classifierAgents.length > 0
      ? options.classifierAgents.map((value) => normalizeToken(value)).filter(Boolean)
      : DEFAULT_CLASSIFIER_AGENTS.slice();
    this.requestsDir = resolveRequestsDir(options);
    this.responsesDir = resolveResponsesDir(options);
    this.hmSendPath = options.hmSendPath || path.join(getProjectRoot(), 'ui', 'scripts', 'hm-send.js');
    this.cwd = options.cwd || getProjectRoot();
  }

  buildQueueRequest(queueItem) {
    const payload = parseRequestPayload(queueItem);
    const node = this.api.getNode(queueItem.node_id);
    const conflictingNode = queueItem.conflicting_node_id ? this.api.getNode(queueItem.conflicting_node_id) : null;
    return createClassifierRequest({
      requestId: payload.requestId || generateId('antibody-request'),
      queueId: queueItem.queue_id,
      nodeId: queueItem.node_id,
      conflictingNodeId: queueItem.conflicting_node_id || null,
      timeoutMs: payload.timeoutMs || DEFAULT_CLASSIFIER_TIMEOUT_MS,
      heuristic: payload.heuristic || {
        label: queueItem.heuristic_label || 'uncertain',
        score: Number(queueItem.heuristic_score || 0),
      },
      scope: payload.scope || extractMemoryScope(node),
      comparison: {
        new_fact: node ? {
          nodeId: node.nodeId,
          category: node.category,
          content: node.content,
          confidenceScore: node.confidenceScore,
          metadata: node.metadata,
        } : null,
        existing_fact: conflictingNode ? {
          nodeId: conflictingNode.nodeId,
          category: conflictingNode.category,
          content: conflictingNode.content,
          confidenceScore: conflictingNode.confidenceScore,
          metadata: conflictingNode.metadata,
        } : null,
      },
    });
  }

  async dispatchQueueItem(queueItem) {
    const request = this.buildQueueRequest(queueItem);
    writeClassifierRequest(request, { requestsDir: this.requestsDir, responsesDir: this.responsesDir });
    const deliveries = await dispatchClassifierRequests(request, this.classifierAgents, {
      sender: this.sender,
      hmSendPath: this.hmSendPath,
      cwd: this.cwd,
      requestsDir: this.requestsDir,
      responsesDir: this.responsesDir,
    });
    this.cognitiveStore.updateAntibodyJob(queueItem.queue_id, {
      status: 'responses_pending',
      classifier_request_id: request.requestId,
      payload: {
        ...parseRequestPayload(queueItem),
        requestId: request.requestId,
        request,
        deliveries,
      },
      result: {
        deliveries,
      },
      last_attempt_at_ms: Date.now(),
    });
    return { request, deliveries };
  }

  async collectQueueItem(queueItem) {
    const payload = parseRequestPayload(queueItem);
    const request = payload.request || this.buildQueueRequest(queueItem);
    const responseResult = await collectClassifierResponses(request, this.classifierAgents, {
      queryEntries: this.queryEntries,
      dbPath: null,
      pollMs: DEFAULT_CLASSIFIER_POLL_MS,
      requestsDir: this.requestsDir,
      responsesDir: this.responsesDir,
    });
    const consensus = evaluateConsensus(responseResult.responses, {
      requiredVotes: this.classifierAgents.length >= 3 ? 2 : this.classifierAgents.length,
    });
    this.cognitiveStore.updateAntibodyJob(queueItem.queue_id, {
      status: consensus.consensus ? 'awaiting_adjudication' : 'responses_pending',
      payload: {
        ...payload,
        request,
      },
      result: {
        responses: responseResult.responses,
        missingAgents: responseResult.missingAgents,
        consensus,
      },
      last_attempt_at_ms: Date.now(),
    });
    if (consensus.consensus) {
      await this.applyConsensus(queueItem.queue_id);
    }
    return { request, responseResult, consensus };
  }

  async applyConsensus(queueId) {
    const queueItem = this.cognitiveStore.getAntibodyQueueItem(queueId);
    if (!queueItem) return { ok: false, reason: 'queue_item_not_found' };
    const result = parseResultPayload(queueItem);
    const consensus = result.consensus || {};
    const conflictingNodeId = queueItem.conflicting_node_id || null;
    if (consensus.status === 'contradiction') {
      this.api.setAntibodyState(queueItem.node_id, 'classified_conflict', {
        conflictsWithMemoryId: conflictingNodeId,
        antibodyScore: consensus.confidence,
        classifiedBy: `agent_consensus:${this.classifierAgents.join(',')}`,
        adjudicationStatus: 'pending',
        quarantinedAtMs: Date.now(),
      });
    } else if (consensus.status === 'update') {
      this.api.setAntibodyState(queueItem.node_id, 'classified_update', {
        conflictsWithMemoryId: conflictingNodeId,
        antibodyScore: consensus.confidence,
        classifiedBy: `agent_consensus:${this.classifierAgents.join(',')}`,
        adjudicationStatus: 'pending',
        quarantinedAtMs: Date.now(),
      });
    } else if (consensus.status === 'uncertain') {
      this.api.setAntibodyState(queueItem.node_id, 'uncertain', {
        conflictsWithMemoryId: conflictingNodeId,
        antibodyScore: consensus.confidence,
        classifiedBy: `agent_consensus:${this.classifierAgents.join(',')}`,
        adjudicationStatus: 'pending',
        quarantinedAtMs: Date.now(),
      });
    } else {
      this.api.setAntibodyState(queueItem.node_id, 'clear', {
        conflictsWithMemoryId: null,
        antibodyScore: 0,
        classifiedBy: `agent_consensus:${this.classifierAgents.join(',')}`,
        adjudicationStatus: consensus.status === 'coexistence' ? 'coexistence' : null,
        quarantinedAtMs: 0,
      });
    }
    this.cognitiveStore.updateAntibodyJob(queueId, { status: 'completed' });
    return { ok: true };
  }

  async runOnce(options = {}) {
    if (!this.api || !this.cognitiveStore) {
      return { ok: false, reason: 'worker_not_initialized' };
    }
    const limit = Math.max(1, Number.parseInt(options.limit || '10', 10) || 10);
    const items = this.cognitiveStore.listAntibodyQueue({
      status: ['pending', 'responses_pending', 'awaiting_adjudication'],
      limit,
    });
    const processed = [];
    for (const item of items) {
      try {
        if (item.status === 'pending') {
          await this.dispatchQueueItem(item);
          processed.push({ queueId: item.queue_id, status: 'dispatched' });
          continue;
        }
        if (item.status === 'responses_pending') {
          const collected = await this.collectQueueItem(item);
          processed.push({
            queueId: item.queue_id,
            status: collected.consensus?.consensus ? 'completed' : 'responses_pending',
          });
          continue;
        }
        if (item.status === 'awaiting_adjudication') {
          await this.applyConsensus(item.queue_id);
          processed.push({ queueId: item.queue_id, status: 'completed' });
        }
      } catch (error) {
        this.logger.warn?.(`Antibody worker failed for ${item.queue_id}: ${error.message}`);
      }
    }
    return { ok: true, processed };
  }
}

module.exports = {
  CognitiveMemoryAntibodyWorker,
  DEFAULT_CLASSIFIER_AGENTS,
  buildClassifierPrompt,
  collectClassifierResponses,
  createClassifierRequest,
  dispatchClassifierRequests,
  evaluateConsensus,
  extractMemoryScope,
  isUserSourcedFact,
  parseClassifierResponseBody,
  processPostIngestAntibody,
  runHeuristicScreen,
  writeClassifierRequest,
  writeClassifierResponse,
};
