const path = require('path');
const { TeamMemoryStore } = require('./store');
const { TeamMemoryClaims } = require('./claims');
const { TeamMemoryPatterns } = require('./patterns');
const { TeamMemoryGuards } = require('./guards');
const { runBackfill } = require('./backfill');
const { extractTaggedClaimsFromComms } = require('./comms-tagged-extractor');
const { scanOrphanedEvidenceRefs } = require('./integrity-checker');
const { executeExperimentOperation } = require('../experiment/runtime');
const { resolveCoordPath } = require('../../config');

let sharedRuntime = null;

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function resolveDefaultTeamMemoryDbPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('runtime', 'team-memory.sqlite'), { forWrite: true });
  }
  return null;
}

function normalizeRuntimeOptions(runtimeOptions = {}) {
  const options = asObject(runtimeOptions);
  const storeOptions = asObject(options.storeOptions);
  if (!storeOptions.dbPath) {
    const defaultDbPath = resolveDefaultTeamMemoryDbPath();
    if (defaultDbPath) {
      storeOptions.dbPath = defaultDbPath;
    }
  }
  return {
    ...options,
    storeOptions,
  };
}

function getExplicitRuntimeDbPath(runtimeOptions = {}) {
  const options = asObject(runtimeOptions);
  const storeOptions = asObject(options.storeOptions);
  return asString(storeOptions.dbPath, '');
}

function isRuntimeAvailable(runtime) {
  return Boolean(runtime?.store && typeof runtime.store.isAvailable === 'function' && runtime.store.isAvailable());
}

function createTeamMemoryRuntime(options = {}) {
  const store = new TeamMemoryStore(asObject(options.storeOptions));
  const initResult = store.init({
    nowMs: options.nowMs,
  });
  const claims = new TeamMemoryClaims(store.db);
  const patterns = new TeamMemoryPatterns(store.db, asObject(options.patternOptions));
  const guards = new TeamMemoryGuards(store.db);

  return {
    store,
    claims,
    patterns,
    guards,
    initResult,
  };
}

function getSharedRuntime(deps = {}) {
  const factory = typeof deps.createTeamMemoryRuntime === 'function'
    ? deps.createTeamMemoryRuntime
    : createTeamMemoryRuntime;
  const runtimeOptionsRaw = asObject(deps.runtimeOptions);
  const explicitRequestedDbPath = getExplicitRuntimeDbPath(runtimeOptionsRaw);
  const runtimeOptions = normalizeRuntimeOptions(runtimeOptionsRaw);
  const forceRuntimeRecreate = deps.forceRuntimeRecreate === true;
  const recreateUnavailable = deps.recreateUnavailable !== false;

  if (forceRuntimeRecreate) {
    closeSharedRuntime();
  }

  if (sharedRuntime && recreateUnavailable && !isRuntimeAvailable(sharedRuntime)) {
    closeSharedRuntime();
  }

  const activeDbPath = asString(sharedRuntime?.store?.dbPath, '');
  if (
    sharedRuntime
    && explicitRequestedDbPath
    && activeDbPath
    && path.resolve(explicitRequestedDbPath) !== path.resolve(activeDbPath)
  ) {
    closeSharedRuntime();
  }

  if (sharedRuntime) return sharedRuntime;
  sharedRuntime = factory(runtimeOptions);
  return sharedRuntime;
}

function closeSharedRuntime() {
  if (!sharedRuntime) return;
  try {
    sharedRuntime.store?.close?.();
  } catch {
    // best effort
  }
  sharedRuntime = null;
}

function initializeTeamMemoryRuntime(options = {}) {
  const opts = asObject(options);
  const deps = asObject(opts.deps);
  const runtime = getSharedRuntime({
    ...deps,
    runtimeOptions: opts.runtimeOptions || deps.runtimeOptions,
    forceRuntimeRecreate: opts.forceRuntimeRecreate === true || deps.forceRuntimeRecreate === true,
    recreateUnavailable: opts.recreateUnavailable !== false && deps.recreateUnavailable !== false,
  });

  const status = runtime?.store && typeof runtime.store.getStatus === 'function'
    ? runtime.store.getStatus()
    : null;

  return {
    ok: isRuntimeAvailable(runtime),
    initResult: runtime?.initResult || null,
    status,
  };
}

function executeTeamMemoryOperation(action, payload = {}, options = {}) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const deps = asObject(options.deps);
  const runtime = getSharedRuntime({
    ...deps,
    runtimeOptions: options.runtimeOptions || deps.runtimeOptions,
    forceRuntimeRecreate: options.forceRuntimeRecreate === true || deps.forceRuntimeRecreate === true,
    recreateUnavailable: options.recreateUnavailable !== false && deps.recreateUnavailable !== false,
  });
  const store = runtime?.store;
  const claims = runtime?.claims;
  const patterns = runtime?.patterns;
  const guards = runtime?.guards;

  if (!store || !store.isAvailable()) {
    return { ok: false, reason: 'unavailable' };
  }

  const opPayload = asObject(payload);
  const experimentRuntimeOptions = {
    dbPath: store.dbPath,
    artifactRoot: opPayload.artifactRoot,
    profilesPath: opPayload.profilesPath,
    evidenceLedgerDbPath: opPayload.evidenceLedgerDbPath,
  };

  switch (normalizedAction) {
    case 'health':
      return {
        ok: true,
        status: store.getStatus(),
      };

    case 'create-claim':
      return claims.createClaim(opPayload);

    case 'query-claims':
      return claims.queryClaims(opPayload);

    case 'search-claims':
      return claims.searchClaims(opPayload);

    case 'update-claim-status':
    case 'update-claim': {
      const claimId = opPayload.claimId || opPayload.claim_id || opPayload.id;
      const status = opPayload.status || opPayload.newStatus || opPayload.new_status;
      const changedBy = opPayload.changedBy || opPayload.changed_by || opPayload.owner;
      const reason = opPayload.reason || null;
      return claims.updateClaimStatus(claimId, status, changedBy, reason, opPayload.nowMs);
    }

    case 'deprecate-claim': {
      const claimId = opPayload.claimId || opPayload.claim_id || opPayload.id;
      const changedBy = opPayload.changedBy || opPayload.changed_by || opPayload.owner;
      const reason = opPayload.reason || 'deprecated_by_user';
      return claims.deprecateClaim(claimId, changedBy, reason, opPayload.nowMs);
    }

    case 'add-evidence': {
      const claimId = opPayload.claimId || opPayload.claim_id;
      const evidenceRef = opPayload.evidenceRef || opPayload.evidence_ref;
      const relation = opPayload.relation || 'supports';
      return claims.addEvidence(claimId, evidenceRef, relation, opPayload);
    }

    case 'create-decision':
      return claims.createDecision(opPayload);

    case 'record-consensus':
      return claims.recordConsensus(opPayload);

    case 'get-consensus': {
      const claimId = opPayload.claimId || opPayload.claim_id || opPayload.id;
      return claims.getConsensus(claimId);
    }

    case 'create-belief-snapshot':
      return claims.createBeliefSnapshot(opPayload);

    case 'get-agent-beliefs':
      return claims.getAgentBeliefs(opPayload);

    case 'get-contradictions':
      return claims.getContradictions(opPayload);

    case 'create-pattern':
      return patterns.createPattern(opPayload);

    case 'query-patterns':
      return patterns.queryPatterns(opPayload);

    case 'create-guard':
      return guards.createGuard(opPayload);

    case 'query-guards':
      return guards.queryGuards(opPayload);

    case 'evaluate-guards':
      return guards.evaluateHookEvents(opPayload.events || [], opPayload);

    case 'activate-guard': {
      const guardId = opPayload.guardId || opPayload.guard_id || opPayload.id;
      return guards.activateGuard(guardId, opPayload.nowMs);
    }

    case 'deactivate-guard': {
      const guardId = opPayload.guardId || opPayload.guard_id || opPayload.id;
      return guards.deactivateGuard(guardId, opPayload.nowMs);
    }

    case 'activate-pattern': {
      const patternId = opPayload.patternId || opPayload.pattern_id || opPayload.id;
      return patterns.activatePattern(patternId, opPayload.nowMs);
    }

    case 'deactivate-pattern': {
      const patternId = opPayload.patternId || opPayload.pattern_id || opPayload.id;
      return patterns.deactivatePattern(patternId, opPayload.nowMs);
    }

    case 'process-pattern-spool': {
      const mined = patterns.processPatternSpool(opPayload);
      if (!mined?.ok) return mined;

      const autoCreate = guards.autoCreateGuardsFromPatterns({
        patterns: mined.patterns || [],
        threshold: opPayload.guardAutoCreateThreshold,
        nowMs: opPayload.nowMs,
      });
      const evaluations = guards.evaluateHookEvents(mined.events || [], opPayload);

      return {
        ...mined,
        guardAutoCreate: autoCreate,
        guardActions: evaluations?.actions || [],
        blockedByGuards: Boolean(evaluations?.blocked),
      };
    }

    case 'record-outcome': {
      const decisionId = opPayload.decisionId || opPayload.decision_id || opPayload.id;
      const outcome = opPayload.outcome;
      const notes = opPayload.notes || opPayload.outcomeNotes || opPayload.outcome_notes || null;
      return claims.recordOutcome(decisionId, outcome, notes, opPayload);
    }

    case 'run-backfill':
      return runBackfill({
        teamDb: store.db,
        evidenceLedgerDbPath: opPayload.evidenceLedgerDbPath,
        limit: opPayload.limit,
        nowMs: opPayload.nowMs,
      });

    case 'extract-comms-tagged-claims':
      return extractTaggedClaimsFromComms({
        teamDb: store.db,
        evidenceLedgerDbPath: opPayload.evidenceLedgerDbPath,
        sessionId: opPayload.sessionId || opPayload.session_id || null,
        sinceMs: opPayload.sinceMs,
        untilMs: opPayload.untilMs,
        limit: opPayload.limit,
        nowMs: opPayload.nowMs,
      });

    case 'run-integrity-check':
      return scanOrphanedEvidenceRefs({
        teamDb: store.db,
        evidenceLedgerDbPath: opPayload.evidenceLedgerDbPath,
        limit: opPayload.limit,
      });

    case 'create-experiment':
    case 'run-experiment':
    case 'run_experiment':
      return executeExperimentOperation('run-experiment', opPayload, {
        runtimeOptions: experimentRuntimeOptions,
      });

    case 'get-experiment':
      return executeExperimentOperation('get-experiment', opPayload, {
        runtimeOptions: experimentRuntimeOptions,
      });

    case 'list-experiments':
      return executeExperimentOperation('list-experiments', opPayload, {
        runtimeOptions: experimentRuntimeOptions,
      });

    case 'attach-to-claim':
      return executeExperimentOperation('attach-to-claim', opPayload, {
        runtimeOptions: experimentRuntimeOptions,
      });

    default:
      return {
        ok: false,
        reason: 'unknown_action',
        action: normalizedAction || action || null,
      };
  }
}

module.exports = {
  createTeamMemoryRuntime,
  initializeTeamMemoryRuntime,
  executeTeamMemoryOperation,
  closeSharedRuntime,
};
