const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getDatabaseSync } = require('./sqlite-compat');
const { resolveCoordPath } = require('../config');
const { CognitiveMemoryStore } = require('./cognitive-memory-store');
const { MemorySearchIndex } = require('./memory-search');
const { CognitiveMemoryApi } = require('./cognitive-memory-api');
const { CognitiveMemoryAntibodyWorker } = require('./cognitive-memory-antibody');
const { runBehavioralSleepPromotion } = require('./cognitive-memory-immunity');
const { TeamMemoryStore } = require('./team-memory/store');
const { TeamMemoryClaims } = require('./team-memory/claims');
const { extractCandidates } = require('../scripts/hm-memory-extract');

const DEFAULT_IDLE_THRESHOLD_MS = Math.max(
  60_000,
  Number.parseInt(process.env.SQUIDRUN_SLEEP_IDLE_MS || '300000', 10) || 300000
);
const DEFAULT_MIN_INTERVAL_MS = Math.max(
  30_000,
  Number.parseInt(process.env.SQUIDRUN_SLEEP_MIN_INTERVAL_MS || '300000', 10) || 300000
);
const DEFAULT_MAX_EPISODES = Math.max(
  10,
  Number.parseInt(process.env.SQUIDRUN_SLEEP_MAX_EPISODES || '500', 10) || 500
);
const DEFAULT_CLUSTER_EPSILON = Number.isFinite(Number(process.env.SQUIDRUN_SLEEP_CLUSTER_EPSILON))
  ? Number(process.env.SQUIDRUN_SLEEP_CLUSTER_EPSILON)
  : 0.15;
const DEFAULT_CLUSTER_MIN_POINTS = Math.max(
  2,
  Number.parseInt(process.env.SQUIDRUN_SLEEP_CLUSTER_MIN_POINTS || '2', 10) || 2
);
const DEFAULT_RELATED_DISTANCE = Number.isFinite(Number(process.env.SQUIDRUN_SLEEP_RELATED_DISTANCE))
  ? Number(process.env.SQUIDRUN_SLEEP_RELATED_DISTANCE)
  : 0.22;
const DEFAULT_TEAM_MEMORY_CONTRADICTION_LIMIT = Math.max(
  10,
  Number.parseInt(process.env.SQUIDRUN_SLEEP_TEAM_MEMORY_CONTRADICTION_LIMIT || '100', 10) || 100
);
const TEAM_MEMORY_NOISE_PATTERNS = [
  /^delivered\./i,
  /^routed[_.\-]/i,
  /^session started\b/i,
  /^session resumed\b/i,
  /^wake signal\b/i,
  /^heartbeat\b/i,
  /^bridge[_.\-]/i,
  /^monitor[_.\-]/i,
  /^hook[_.\-]/i,
  /^startup[_.\-]/i,
];

function resolveEvidenceLedgerPath() {
  return resolveCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true });
}

function resolveSessionStatePath() {
  return resolveCoordPath(path.join('runtime', 'session-state.json'), { forWrite: true });
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function dominantValue(items, key, fallback = null) {
  const counts = new Map();
  for (const item of items || []) {
    const value = normalizeWhitespace(item?.[key] || '').toLowerCase();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const ranked = Array.from(counts.entries()).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return ranked[0]?.[0] || fallback;
}

function vectorDistance(left, right) {
  const a = Array.isArray(left) ? left : Array.from(left || []);
  const b = Array.isArray(right) ? right : Array.from(right || []);
  if (a.length === 0 || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return Number.POSITIVE_INFINITY;
  return 1 - (dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

function regionQuery(points, pointIndex, epsilon) {
  const source = points[pointIndex];
  const neighbors = [];
  for (let i = 0; i < points.length; i += 1) {
    const candidate = points[i];
    const distance = vectorDistance(source.vector, candidate.vector);
    if (distance <= epsilon) {
      neighbors.push(i);
    }
  }
  return neighbors;
}

function runDbscan(points, options = {}) {
  const epsilon = Number.isFinite(Number(options.epsilon)) ? Number(options.epsilon) : DEFAULT_CLUSTER_EPSILON;
  const minPoints = Math.max(2, Number.parseInt(options.minPoints || DEFAULT_CLUSTER_MIN_POINTS, 10) || DEFAULT_CLUSTER_MIN_POINTS);
  const visited = new Set();
  const assigned = new Set();
  const clusters = [];
  const noise = [];

  for (let i = 0; i < points.length; i += 1) {
    if (visited.has(i)) continue;
    visited.add(i);
    const neighbors = regionQuery(points, i, epsilon);
    if (neighbors.length < minPoints) {
      noise.push(points[i]);
      continue;
    }

    const clusterIndexes = new Set(neighbors);
    assigned.add(i);
    const queue = neighbors.slice();

    while (queue.length > 0) {
      const neighborIndex = queue.shift();
      if (!visited.has(neighborIndex)) {
        visited.add(neighborIndex);
        const neighborNeighbors = regionQuery(points, neighborIndex, epsilon);
        if (neighborNeighbors.length >= minPoints) {
          for (const index of neighborNeighbors) {
            if (!clusterIndexes.has(index)) {
              clusterIndexes.add(index);
              queue.push(index);
            }
          }
        }
      }
      assigned.add(neighborIndex);
      clusterIndexes.add(neighborIndex);
    }

    clusters.push(Array.from(clusterIndexes).sort((left, right) => left - right).map((index) => points[index]));
  }

  const unassignedNoise = noise.filter((point) => !assigned.has(point.index));
  return { clusters, noise: unassignedNoise };
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function summarizeClusterStatements(items) {
  const statements = Array.from(new Set((items || []).map((item) => normalizeWhitespace(item.statement)).filter(Boolean)));
  if (statements.length === 0) return '';
  if (statements.length === 1) return statements[0];
  if (statements.length === 2) return `${statements[0]} ${statements[1]}`;
  return `${statements.slice(0, 2).join(' ')} ${statements.length - 2} more related signal(s).`;
}

function looksLikeOperationalNoiseStatement(statement = '') {
  const normalized = normalizeWhitespace(statement);
  if (!normalized) return true;
  if (TEAM_MEMORY_NOISE_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (/^[a-z0-9_.:-]+$/i.test(normalized) && !/\s/.test(normalized)) return true;
  return false;
}

function isSubstantiveTeamMemoryClaim(claim = null) {
  if (!claim || typeof claim !== 'object') return false;
  const owner = normalizeWhitespace(claim.owner).toLowerCase();
  if (!['user', 'architect', 'builder', 'oracle'].includes(owner)) return false;
  if (!['fact', 'negative'].includes(normalizeWhitespace(claim.claimType).toLowerCase())) return false;
  if (normalizeWhitespace(claim.status).toLowerCase() === 'deprecated') return false;

  const statement = normalizeWhitespace(claim.statement);
  if (!statement || looksLikeOperationalNoiseStatement(statement)) return false;

  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(statement) && statement.length >= 6) {
    return true;
  }

  const tokens = statement.match(/[A-Za-z0-9]+/g) || [];
  if (tokens.length >= 4) return true;
  if (statement.length >= 24 && /\s/.test(statement)) return true;
  return false;
}

function chooseContradictionOrientation(entry = {}) {
  const left = entry.claimADetails || null;
  const right = entry.claimBDetails || null;
  if (!left || !right) return null;

  if (left.supersedes && left.supersedes === right.id) {
    return {
      primary: left,
      conflicting: right,
      autoDecision: 'accepted_correction',
      deprecatedClaimId: right.id,
      resolutionReason: 'team_memory_supersedes',
    };
  }
  if (right.supersedes && right.supersedes === left.id) {
    return {
      primary: right,
      conflicting: left,
      autoDecision: 'accepted_correction',
      deprecatedClaimId: left.id,
      resolutionReason: 'team_memory_supersedes',
    };
  }

  const primary = Number(right.updatedAt || 0) > Number(left.updatedAt || 0) ? right : left;
  const conflicting = primary.id === left.id ? right : left;
  return {
    primary,
    conflicting,
    autoDecision: null,
    deprecatedClaimId: null,
    resolutionReason: null,
  };
}

function buildTeamMemoryClaimNodePayload(claim = {}, contradiction = {}, side = 'a') {
  return {
    category: 'team_memory_claim',
    content: normalizeWhitespace(claim.statement),
    confidence: Number.isFinite(Number(claim.confidence)) ? Number(claim.confidence) : 0.8,
    sourceType: 'team-memory-claim',
    sourcePath: `team-memory:claim:${claim.id}`,
    title: 'Team Memory Claim',
    heading: `claim:${normalizeWhitespace(claim.claimType).toLowerCase() || 'fact'}`,
    metadata: {
      claimId: claim.id,
      claimType: claim.claimType || null,
      claimOwner: claim.owner || null,
      claimSession: claim.session || contradiction.session || null,
      contradictionId: contradiction.id || null,
      contradictionReason: contradiction.reason || null,
      contradictionSide: side,
      source: 'team-memory-contradiction',
      userSourced: normalizeWhitespace(claim.owner).toLowerCase() === 'user',
    },
  };
}

function parseAntibodyQueueJson(value, fallback = {}) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

function normalizeExternalCandidates(items, options = {}) {
  const safeItems = Array.isArray(items) ? items : [];
  const proposedBy = String(options.proposedBy || 'sleep-cycle');
  const sessionId = String(options.sessionId || 'sleep-cycle');
  const sourceEpisodes = Array.isArray(options.episodes) ? options.episodes : [];
  const sourceRowIds = sourceEpisodes.map((episode) => Number(episode?.rowId || 0)).filter((value) => Number.isFinite(value) && value > 0);
  return safeItems
    .map((item, index) => {
      const statement = normalizeWhitespace(item?.statement || item?.fact || '');
      const category = normalizeWhitespace(item?.category || 'fact').toLowerCase();
      const confidenceScore = Number(item?.confidence_score ?? item?.confidence ?? 0.5);
      if (!statement) return null;
      return {
        category: category || 'fact',
        statement,
        confidence_score: Number.isFinite(confidenceScore) ? Math.max(0, Math.min(1, confidenceScore)) : 0.5,
        review_count: Number.isFinite(Number(item?.review_count)) ? Number(item.review_count) : 0,
        domain: normalizeWhitespace(item?.domain || category || 'external_extraction'),
        proposed_by: normalizeWhitespace(item?.proposed_by || proposedBy) || proposedBy,
        source_trace: normalizeWhitespace(item?.source_trace || `${sessionId}:ollama:${index}`) || `${sessionId}:ollama:${index}`,
        source_payload: {
          session_id: sessionId,
          row_ids: sourceRowIds,
          extractor: normalizeWhitespace(item?.source_payload?.extractor || 'external_command') || 'external_command',
          ...(item?.source_payload && typeof item.source_payload === 'object' ? item.source_payload : {}),
          raw_fact: item?.fact || null,
        },
      };
    })
    .filter(Boolean);
}

async function runExtractionCommand(command, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS || '1',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `extractor exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || '{}');
        resolve(parsed);
      } catch (error) {
        reject(new Error(`extractor returned invalid JSON: ${error.message}`));
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

async function syncTeamMemoryContradictionsToAntibody(options = {}) {
  const api = options.api;
  if (!api) return { ok: false, reason: 'api_required' };

  const teamStore = options.teamMemoryStore || new TeamMemoryStore({
    dbPath: options.teamMemoryDbPath,
  });
  const ownsTeamStore = !options.teamMemoryStore;

  try {
    const initResult = teamStore.init();
    if (!initResult?.ok) {
      return { ok: false, reason: initResult?.reason || 'team_memory_unavailable' };
    }
    const claims = options.teamMemoryClaims || new TeamMemoryClaims(teamStore.db);
    const limit = Math.max(1, Number.parseInt(options.limit || `${DEFAULT_TEAM_MEMORY_CONTRADICTION_LIMIT}`, 10) || DEFAULT_TEAM_MEMORY_CONTRADICTION_LIMIT);
    const contradictions = claims.getContradictions({
      activeOnly: true,
      limit,
      includeClaimDetails: true,
    });
    if (!contradictions?.ok) {
      return { ok: false, reason: contradictions?.reason || 'contradictions_unavailable' };
    }

    let scanned = 0;
    let filteredNoise = 0;
    let queued = 0;
    let merged = 0;
    const queueIds = [];

    for (const contradiction of contradictions.contradictions || []) {
      scanned += 1;
      if (!isSubstantiveTeamMemoryClaim(contradiction.claimADetails) || !isSubstantiveTeamMemoryClaim(contradiction.claimBDetails)) {
        filteredNoise += 1;
        continue;
      }

      const orientation = chooseContradictionOrientation(contradiction);
      if (!orientation?.primary || !orientation?.conflicting) {
        filteredNoise += 1;
        continue;
      }

      const primaryNode = await api.ensureNodeFromSearchResult(
        buildTeamMemoryClaimNodePayload(orientation.primary, contradiction, 'primary')
      );
      const conflictingNode = await api.ensureNodeFromSearchResult(
        buildTeamMemoryClaimNodePayload(orientation.conflicting, contradiction, 'conflicting')
      );
      if (!primaryNode?.nodeId || !conflictingNode?.nodeId || primaryNode.nodeId === conflictingNode.nodeId) {
        continue;
      }

      const queueResult = api.cognitiveStore.enqueueAntibodyJob({
        node_id: primaryNode.nodeId,
        conflicting_node_id: conflictingNode.nodeId,
        request_type: 'team_memory_contradiction',
        status: 'pending',
        classifier_strategy: 'team_memory_contradiction',
        heuristic_label: contradiction.reason === 'supersedes_conflict_same_scope' ? 'update' : 'contradiction',
        heuristic_score: contradiction.reason === 'supersedes_conflict_same_scope' ? 0.88 : 0.74,
        payload: {
          source: 'team-memory-contradiction',
          contradictionId: contradiction.id,
          claimAId: contradiction.claimA,
          claimBId: contradiction.claimB,
          reason: contradiction.reason,
          primaryClaimId: orientation.primary.id,
          conflictingClaimId: orientation.conflicting.id,
          autoDecision: orientation.autoDecision,
          deprecatedClaimId: orientation.deprecatedClaimId,
          resolutionReason: orientation.resolutionReason,
        },
      });
      if (queueResult?.ok) {
        queueIds.push(queueResult.queue_id);
        if (queueResult.status === 'merged') {
          merged += 1;
        } else {
          queued += 1;
        }
      }
    }

    return {
      ok: true,
      scanned,
      filteredNoise,
      queued,
      merged,
      queueIds,
    };
  } finally {
    if (ownsTeamStore) {
      try { teamStore.close(); } catch {}
    }
  }
}

function applyTeamMemoryAntibodyOutcomes(options = {}) {
  const api = options.api;
  const cognitiveStore = options.cognitiveStore || api?.cognitiveStore;
  if (!api || !cognitiveStore) return { ok: false, reason: 'api_required' };

  const teamStore = options.teamMemoryStore || new TeamMemoryStore({
    dbPath: options.teamMemoryDbPath,
  });
  const ownsTeamStore = !options.teamMemoryStore;

  try {
    const initResult = teamStore.init();
    if (!initResult?.ok) {
      return { ok: false, reason: initResult?.reason || 'team_memory_unavailable' };
    }
    const claims = options.teamMemoryClaims || new TeamMemoryClaims(teamStore.db);
    const queueIds = Array.from(new Set(
      (Array.isArray(options.queueIds) ? options.queueIds : [])
        .map((value) => normalizeWhitespace(value))
        .filter(Boolean)
    ));

    let resolved = 0;
    let deprecatedClaims = 0;
    let adjudicated = 0;

    for (const queueId of queueIds) {
      const item = cognitiveStore.getAntibodyQueueItem(queueId);
      if (!item || String(item.status || '').trim().toLowerCase() !== 'completed') continue;
      const payload = parseAntibodyQueueJson(item.payload_json, {});
      const result = parseAntibodyQueueJson(item.result_json, {});
      if (payload.source !== 'team-memory-contradiction') continue;
      if (result?.teamMemoryResolution?.appliedAt) continue;

      const consensusStatus = normalizeWhitespace(result?.consensus?.status || '').toLowerCase();
      const nowMs = Date.now();
      let resolution = { action: 'none', appliedAt: null };

      if (consensusStatus === 'coexistence' && payload.contradictionId) {
        const updated = claims.resolveContradictionsByIds([payload.contradictionId], nowMs);
        if (updated > 0) {
          resolved += updated;
          resolution = { action: 'coexistence', appliedAt: nowMs, resolvedCount: updated };
        }
      } else if (
        payload.autoDecision === 'accepted_correction'
        && ['update', 'contradiction'].includes(consensusStatus)
      ) {
        const adjudication = api.adjudicateAntibodyConflict({
          nodeId: item.node_id,
          conflictingNodeId: item.conflicting_node_id || null,
          decision: 'accepted_correction',
          actorId: 'sleep-antibody',
          reason: payload.resolutionReason || 'team_memory_supersedes',
        });
        if (adjudication?.ok) {
          adjudicated += 1;
        }
        if (payload.deprecatedClaimId) {
          const deprecation = claims.deprecateClaim(
            payload.deprecatedClaimId,
            'system',
            payload.resolutionReason || 'team_memory_supersedes',
            nowMs
          );
          if (deprecation?.ok) {
            deprecatedClaims += 1;
            resolved += Number(deprecation.resolvedContradictions || 0);
            resolution = {
              action: 'accepted_correction',
              appliedAt: nowMs,
              deprecatedClaimId: payload.deprecatedClaimId,
              resolvedCount: Number(deprecation.resolvedContradictions || 0),
            };
          }
        }
      }

      if (resolution.appliedAt) {
        cognitiveStore.updateAntibodyJob(queueId, {
          result: {
            ...result,
            teamMemoryResolution: resolution,
          },
        });
      }
    }

    return {
      ok: true,
      resolved,
      deprecatedClaims,
      adjudicated,
    };
  } finally {
    if (ownsTeamStore) {
      try { teamStore.close(); } catch {}
    }
  }
}

class SleepConsolidator {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.cognitiveStore = options.cognitiveStore || new CognitiveMemoryStore(options.cognitiveStoreOptions || {});
    this.memorySearchIndex = options.memorySearchIndex || new MemorySearchIndex(options.memorySearchOptions || {});
    this.evidenceDbPath = path.resolve(String(options.evidenceDbPath || resolveEvidenceLedgerPath()));
    this.teamMemoryDbPath = path.resolve(String(options.teamMemoryDbPath || resolveCoordPath(path.join('runtime', 'team-memory.sqlite'), { forWrite: true })));
    this.sessionStatePath = path.resolve(String(options.sessionStatePath || resolveSessionStatePath()));
    this.idleThresholdMs = Math.max(60_000, Number.parseInt(options.idleThresholdMs || DEFAULT_IDLE_THRESHOLD_MS, 10) || DEFAULT_IDLE_THRESHOLD_MS);
    this.minIntervalMs = Math.max(30_000, Number.parseInt(options.minIntervalMs || DEFAULT_MIN_INTERVAL_MS, 10) || DEFAULT_MIN_INTERVAL_MS);
    this.maxEpisodes = Math.max(10, Number.parseInt(options.maxEpisodes || DEFAULT_MAX_EPISODES, 10) || DEFAULT_MAX_EPISODES);
    this.clusterEpsilon = Number.isFinite(Number(options.clusterEpsilon)) ? Number(options.clusterEpsilon) : DEFAULT_CLUSTER_EPSILON;
    this.clusterMinPoints = Math.max(2, Number.parseInt(options.clusterMinPoints || DEFAULT_CLUSTER_MIN_POINTS, 10) || DEFAULT_CLUSTER_MIN_POINTS);
    this.relatedDistance = Number.isFinite(Number(options.relatedDistance)) ? Number(options.relatedDistance) : DEFAULT_RELATED_DISTANCE;
    this.teamMemoryContradictionLimit = Math.max(
      1,
      Number.parseInt(options.teamMemoryContradictionLimit || `${DEFAULT_TEAM_MEMORY_CONTRADICTION_LIMIT}`, 10) || DEFAULT_TEAM_MEMORY_CONTRADICTION_LIMIT
    );
    this.extractionCommand = normalizeWhitespace(options.extractionCommand || process.env.SQUIDRUN_SLEEP_EXTRACTION_COMMAND || '');
    this.extractor = typeof options.extractor === 'function' ? options.extractor : null;
    this.stateDb = null;
    this.lastExtractionInfo = null;
  }

  init() {
    if (this.stateDb) return this.stateDb;
    this.cognitiveStore.init();
    const DatabaseSync = getDatabaseSync();
    this.stateDb = new DatabaseSync(this.cognitiveStore.dbPath);
    this.stateDb.exec('PRAGMA journal_mode=WAL;');
    this.stateDb.exec('PRAGMA synchronous=NORMAL;');
    this.stateDb.exec('PRAGMA busy_timeout=5000;');
    this.stateDb.exec(`
      CREATE TABLE IF NOT EXISTS sleep_cycle_state (
        state_key TEXT PRIMARY KEY,
        state_value TEXT,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sleep_cycle_runs (
        run_id TEXT PRIMARY KEY,
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER,
        episode_count INTEGER NOT NULL DEFAULT 0,
        extracted_count INTEGER NOT NULL DEFAULT 0,
        generated_pr_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        summary_json TEXT NOT NULL DEFAULT '{}'
      );
    `);
    return this.stateDb;
  }

  close() {
    try {
      this.cognitiveStore.close();
    } catch {}
    try {
      this.memorySearchIndex.close();
    } catch {}
    if (this.stateDb) {
      try { this.stateDb.close(); } catch {}
      this.stateDb = null;
    }
  }

  getState(key, fallback = null) {
    const row = this.init().prepare('SELECT state_value FROM sleep_cycle_state WHERE state_key = ?').get(String(key || ''));
    return row ? row.state_value : fallback;
  }

  setState(key, value) {
    const nowMs = Date.now();
    this.init().prepare(`
      INSERT INTO sleep_cycle_state (state_key, state_value, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET
        state_value = excluded.state_value,
        updated_at_ms = excluded.updated_at_ms
    `).run(String(key || ''), value == null ? null : String(value), nowMs);
  }

  getLastProcessedRowId() {
    const value = Number.parseInt(this.getState('last_comms_row_id', '0'), 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  getLastRunAtMs() {
    const value = Number.parseInt(this.getState('last_run_at_ms', '0'), 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  readActivitySnapshot(nowMs = Date.now()) {
    const sessionState = readJsonFile(this.sessionStatePath);
    const terminalTimes = Array.isArray(sessionState?.terminals)
      ? sessionState.terminals
          .map((terminal) => Number(terminal?.lastInputTime || 0))
          .filter((value) => Number.isFinite(value) && value > 0)
      : [];
    const lastInputMs = Math.max(...terminalTimes, 0);
    const idleMs = lastInputMs > 0 ? Math.max(0, nowMs - lastInputMs) : Number.POSITIVE_INFINITY;
    return {
      source: this.sessionStatePath,
      lastActivityMs: lastInputMs,
      lastInputMs,
      idleMs,
      isIdle: idleMs >= this.idleThresholdMs,
    };
  }

  shouldRun(nowMs = Date.now()) {
    const activity = this.readActivitySnapshot(nowMs);
    const lastRunAtMs = this.getLastRunAtMs();
    const enoughGap = !lastRunAtMs || (nowMs - lastRunAtMs) >= this.minIntervalMs;
    return {
      ok: activity.isIdle && enoughGap,
      activity,
      lastRunAtMs,
      enoughGap,
    };
  }

  fetchEpisodes(options = {}) {
    if (!fs.existsSync(this.evidenceDbPath)) {
      return [];
    }
    const afterRowId = Math.max(0, Number.parseInt(options.afterRowId || this.getLastProcessedRowId(), 10) || 0);
    const limit = Math.max(1, Math.min(500, Number.parseInt(options.limit || this.maxEpisodes, 10) || this.maxEpisodes));
    const DatabaseSync2 = getDatabaseSync();
    const db = new DatabaseSync2(this.evidenceDbPath);
    try {
      return db.prepare(`
        SELECT
          row_id,
          message_id,
          session_id,
          sender_role,
          target_role,
          channel,
          direction,
          raw_body,
          sent_at_ms,
          brokered_at_ms,
          updated_at_ms,
          metadata_json
        FROM comms_journal
        WHERE row_id > ?
          AND raw_body IS NOT NULL
          AND TRIM(raw_body) <> ''
        ORDER BY row_id ASC
        LIMIT ?
      `).all(afterRowId, limit).map((row) => ({
        rowId: Number(row.row_id),
        messageId: row.message_id,
        sessionId: row.session_id,
        senderRole: row.sender_role,
        targetRole: row.target_role,
        channel: row.channel,
        direction: row.direction,
        rawBody: row.raw_body,
        sentAtMs: Number(row.sent_at_ms || 0),
        brokeredAtMs: Number(row.brokered_at_ms || 0),
        updatedAtMs: Number(row.updated_at_ms || 0),
        metadata: (() => {
          try {
            return JSON.parse(row.metadata_json || '{}');
          } catch {
            return {};
          }
        })(),
      }));
    } finally {
      db.close();
    }
  }

  async extractFacts(episodes) {
    const safeEpisodes = Array.isArray(episodes) ? episodes : [];
    if (safeEpisodes.length === 0) return [];
    const fallbackExtract = () => extractCandidates({
      session_id: safeEpisodes[safeEpisodes.length - 1]?.sessionId || 'sleep-cycle',
      hook_event: 'SleepCycle',
      transcript: safeEpisodes.map((episode) => episode.rawBody),
      messages: safeEpisodes.map((episode) => ({
        message: episode.rawBody,
        sender: episode.senderRole,
        target: episode.targetRole,
      })),
    }, {
      proposedBy: 'sleep-cycle',
      limit: 32,
    }).map((candidate) => ({
      ...candidate,
      proposed_by: 'sleep-cycle',
    }));

    if (this.extractor) {
      const result = await this.extractor(safeEpisodes);
      this.lastExtractionInfo = {
        mode: 'custom-extractor',
        ok: true,
        candidateCount: Array.isArray(result) ? result.length : 0,
      };
      return Array.isArray(result) ? result : [];
    }

    if (this.extractionCommand) {
      try {
        const result = await runExtractionCommand(this.extractionCommand, {
          episodes: safeEpisodes,
          prompt: 'Extract only durable system facts, user preferences, and established architectural rules as structured candidates.',
        });
        const normalized = normalizeExternalCandidates(
          Array.isArray(result) ? result : result?.candidates,
          {
            proposedBy: 'sleep-cycle',
            sessionId: safeEpisodes[safeEpisodes.length - 1]?.sessionId || 'sleep-cycle',
            episodes: safeEpisodes,
          }
        );
        this.lastExtractionInfo = {
          mode: 'external-command',
          ok: true,
          command: this.extractionCommand,
          candidateCount: normalized.length,
        };
        return normalized;
      } catch (err) {
        this.lastExtractionInfo = {
          mode: 'fallback',
          ok: false,
          command: this.extractionCommand,
          error: err.message,
        };
        this.logger.warn(`Sleep extractor command failed, falling back to built-in extractor: ${err.message}`);
        return fallbackExtract();
      }
    }

    this.lastExtractionInfo = {
      mode: 'built-in',
      ok: true,
      candidateCount: 0,
    };
    const fallbackCandidates = fallbackExtract();
    this.lastExtractionInfo.candidateCount = fallbackCandidates.length;
    return fallbackCandidates;
  }

  async ensureSearchIndexReady() {
    const status = this.memorySearchIndex.getStatus();
    if (Number(status.document_count || 0) > 0) {
      return status;
    }
    const result = await this.memorySearchIndex.indexAll({ force: true });
    return result.status || this.memorySearchIndex.getStatus();
  }

  async buildFactPoints(candidates) {
    const embedder = await this.memorySearchIndex.getEmbedder();
    const points = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const vector = await embedder.embed(candidate.statement);
      points.push({
        index: i,
        statement: candidate.statement,
        vector,
        category: candidate.category,
        domain: candidate.domain,
        confidence_score: Number(candidate.confidence_score || 0.5),
        source_trace: candidate.source_trace || null,
        source_payload: candidate.source_payload || {},
      });
    }
    return points;
  }

  findRelatedDocuments(point, limit = 3) {
    const semanticRows = this.memorySearchIndex.semanticSearch(point.vector, limit * 2);
    const nearRows = semanticRows.filter((row) => Number(row.distance) <= this.relatedDistance).slice(0, limit);
    if (nearRows.length === 0) return [];
    const docs = this.memorySearchIndex.getDocumentsByIds(nearRows.map((row) => Number(row.document_id)));
    const docsById = new Map(docs.map((doc) => [Number(doc.document_id), doc]));
    return nearRows.map((row) => ({
      documentId: Number(row.document_id),
      distance: Number(row.distance),
      document: docsById.get(Number(row.document_id)) || null,
    })).filter((entry) => entry.document);
  }

  buildClusterCandidates(cluster, relatedDocsByPoint) {
    const dominantCategory = dominantValue(cluster, 'category', 'observation');
    const dominantDomain = dominantValue(cluster, 'domain', 'sleep_cycle');
    const summary = summarizeClusterStatements(cluster);
    const relatedDocs = Array.from(new Map(
      cluster.flatMap((point) => relatedDocsByPoint.get(point.index) || []).map((entry) => [entry.documentId, entry])
    ).values());

    if (relatedDocs.length > 0) {
      const titles = Array.from(new Set(relatedDocs.map((entry) => normalizeWhitespace(entry.document.title || entry.document.heading || entry.document.source_path)).filter(Boolean))).slice(0, 3);
      return [{
        category: dominantCategory,
        domain: dominantDomain,
        statement: `Sleep consolidation linked new evidence to existing memory${titles.length ? ` in ${titles.join(', ')}` : ''}. ${summary}`,
        confidence_score: 0.8,
        review_count: 0,
        proposed_by: 'sleep-cycle',
        source_trace: cluster.map((point) => point.source_trace).filter(Boolean).join(','),
        source_payload: {
          type: 'MERGE_UPDATE',
          cluster_size: cluster.length,
          related_documents: relatedDocs.map((entry) => ({
            document_id: entry.documentId,
            distance: entry.distance,
            source_path: entry.document.source_path,
            title: entry.document.title,
            heading: entry.document.heading,
          })),
          statements: cluster.map((point) => point.statement),
        },
      }];
    }

    if (cluster.length >= Math.max(3, this.clusterMinPoints)) {
      return [{
        category: dominantCategory,
        domain: dominantDomain,
        statement: `Sleep consolidation insight: ${summary}`,
        confidence_score: 0.6,
        review_count: 0,
        proposed_by: 'sleep-cycle',
        source_trace: cluster.map((point) => point.source_trace).filter(Boolean).join(','),
        source_payload: {
          type: 'NEW_INSIGHT',
          cluster_size: cluster.length,
          statements: cluster.map((point) => point.statement),
        },
      }];
    }

    return [];
  }

  recordRun(summary) {
    const db = this.init();
    db.prepare(`
      INSERT INTO sleep_cycle_runs (
        run_id,
        started_at_ms,
        finished_at_ms,
        episode_count,
        extracted_count,
        generated_pr_count,
        status,
        summary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(summary.runId),
      Number(summary.startedAtMs || Date.now()),
      Number(summary.finishedAtMs || Date.now()),
      Number(summary.episodeCount || 0),
      Number(summary.extractedCount || 0),
      Number(summary.generatedPrCount || 0),
      String(summary.status || 'complete'),
      JSON.stringify(summary)
    );
  }

  async runOnce(options = {}) {
    const startedAtMs = Date.now();
    const runId = `sleep-${startedAtMs}`;
    this.init();
    await this.ensureSearchIndexReady();

    const episodes = this.fetchEpisodes({
      afterRowId: options.afterRowId,
      limit: options.limit,
    });
    if (episodes.length === 0) {
      const summary = {
        ok: true,
        runId,
        startedAtMs,
        finishedAtMs: Date.now(),
        episodeCount: 0,
        extractedCount: 0,
        generatedPrCount: 0,
        status: 'noop',
        reason: 'no_new_episodes',
      };
      this.setState('last_run_at_ms', String(summary.finishedAtMs));
      this.recordRun(summary);
      return summary;
    }

    const candidates = await this.extractFacts(episodes);
    const points = await this.buildFactPoints(candidates);
    const clustering = runDbscan(points, {
      epsilon: options.clusterEpsilon || this.clusterEpsilon,
      minPoints: options.clusterMinPoints || this.clusterMinPoints,
    });

    const generated = [];
    for (const cluster of clustering.clusters) {
      const relatedDocsByPoint = new Map();
      for (const point of cluster) {
        relatedDocsByPoint.set(point.index, this.findRelatedDocuments(point));
      }
      generated.push(...this.buildClusterCandidates(cluster, relatedDocsByPoint));
    }

    const staged = generated.length > 0
      ? this.cognitiveStore.stageMemoryPRs(generated)
      : { ok: true, staged: [], merged: [], pendingCount: this.cognitiveStore.listPendingPRs({ limit: 1000 }).length };

    const behavioralApi = new CognitiveMemoryApi({
      cognitiveStore: this.cognitiveStore,
      memorySearchIndex: this.memorySearchIndex,
    });
    const behavioralSummary = await runBehavioralSleepPromotion({
      store: this.cognitiveStore,
      api: behavioralApi,
      memorySearchIndex: this.memorySearchIndex,
      promotedBy: 'sleep-cycle',
    });
    const teamMemoryAntibodySummary = await syncTeamMemoryContradictionsToAntibody({
      api: behavioralApi,
      cognitiveStore: this.cognitiveStore,
      teamMemoryDbPath: this.teamMemoryDbPath,
      limit: this.teamMemoryContradictionLimit,
    });
    const antibodyWorker = new CognitiveMemoryAntibodyWorker({
      api: behavioralApi,
      cognitiveStore: this.cognitiveStore,
      memorySearchIndex: this.memorySearchIndex,
      logger: this.logger,
    });
    const antibodySummary = await antibodyWorker.runOnce({ limit: 10 });
    const teamMemoryResolutionSummary = applyTeamMemoryAntibodyOutcomes({
      api: behavioralApi,
      cognitiveStore: this.cognitiveStore,
      teamMemoryDbPath: this.teamMemoryDbPath,
      queueIds: teamMemoryAntibodySummary?.queueIds || [],
    });

    const lastRowId = episodes[episodes.length - 1]?.rowId || this.getLastProcessedRowId();
    this.setState('last_comms_row_id', String(lastRowId));
    this.setState('last_run_at_ms', String(Date.now()));

    const summary = {
      ok: true,
      runId,
      startedAtMs,
      finishedAtMs: Date.now(),
      episodeCount: episodes.length,
      extractedCount: candidates.length,
      generatedPrCount: generated.length,
      stagedCount: Number(staged.staged?.length || 0),
      mergedCount: Number(staged.merged?.length || 0),
      pendingCount: Number(staged.pendingCount || 0),
      behavioralCandidateCount: Number(behavioralSummary?.candidateCount || 0),
      behavioralPromotedCount: Number(behavioralSummary?.promoted || 0),
      teamMemoryContradictionScannedCount: Number(teamMemoryAntibodySummary?.scanned || 0),
      teamMemoryContradictionFilteredNoiseCount: Number(teamMemoryAntibodySummary?.filteredNoise || 0),
      teamMemoryContradictionQueuedCount: Number(teamMemoryAntibodySummary?.queued || 0),
      teamMemoryContradictionMergedCount: Number(teamMemoryAntibodySummary?.merged || 0),
      teamMemoryContradictionResolvedCount: Number(teamMemoryResolutionSummary?.resolved || 0),
      antibodyProcessedCount: Number(antibodySummary?.processed?.length || 0),
      lastProcessedRowId: lastRowId,
      clusterCount: clustering.clusters.length,
      noiseCount: clustering.noise.length,
      behavioralSummary,
      teamMemoryAntibodySummary,
      teamMemoryResolutionSummary,
      antibodySummary,
      extraction: this.lastExtractionInfo || {
        mode: this.extractionCommand ? 'external-command' : 'built-in',
        ok: true,
      },
      status: (generated.length > 0 || Number(behavioralSummary?.candidateCount || 0) > 0) ? 'complete' : 'no_patterns',
    };
    this.recordRun(summary);
    return summary;
  }
}

module.exports = {
  DEFAULT_CLUSTER_EPSILON,
  DEFAULT_CLUSTER_MIN_POINTS,
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_MAX_EPISODES,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_TEAM_MEMORY_CONTRADICTION_LIMIT,
  SleepConsolidator,
  applyTeamMemoryAntibodyOutcomes,
  chooseContradictionOrientation,
  isSubstantiveTeamMemoryClaim,
  looksLikeOperationalNoiseStatement,
  resolveEvidenceLedgerPath,
  resolveSessionStatePath,
  runDbscan,
  syncTeamMemoryContradictionsToAntibody,
  vectorDistance,
};
