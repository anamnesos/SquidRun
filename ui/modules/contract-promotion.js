/**
 * Contract Promotion Engine
 * Tracks shadow contract performance and promotes to enforced when criteria are met.
 *
 * Promotion criteria (all must be met):
 * 1. Ran in shadow mode for >= 5 sessions
 * 2. Zero false positives during shadow period
 * 3. Replay validation (simplified: shadow violations count without false positives)
 * 4. Sign-off from 2 agents (manual, tracked in stats)
 */

const fs = require('fs');
const path = require('path');
const contracts = require('./contracts');
const { resolveCoordPath } = require('../config');

const STATS_PATH = typeof resolveCoordPath === 'function'
  ? resolveCoordPath('contract-stats.json', { forWrite: true })
  : path.join(process.cwd(), '.squidrun', 'contract-stats.json');
const MIN_SESSIONS = 5;
const REQUIRED_SIGNOFFS = 2;

let bus = null;
let stats = { contracts: {} };

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function readStatsFromDisk() {
  try {
    const raw = fs.readFileSync(STATS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.contracts) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function toTimestampMs(isoString) {
  if (!isoString) return 0;
  const ms = Date.parse(String(isoString));
  return Number.isFinite(ms) ? ms : 0;
}

function mergeContractStats(localEntry = {}, diskEntry = {}) {
  const local = asObject(localEntry);
  const disk = asObject(diskEntry);

  const mergedSignoffs = new Set();
  for (const signoff of Array.isArray(local.agentSignoffs) ? local.agentSignoffs : []) {
    mergedSignoffs.add(signoff);
  }
  for (const signoff of Array.isArray(disk.agentSignoffs) ? disk.agentSignoffs : []) {
    mergedSignoffs.add(signoff);
  }

  return {
    mode: local.mode === 'enforced' || disk.mode === 'enforced' ? 'enforced' : 'shadow',
    sessionsTracked: Math.max(Number(local.sessionsTracked || 0), Number(disk.sessionsTracked || 0)),
    shadowViolations: Math.max(Number(local.shadowViolations || 0), Number(disk.shadowViolations || 0)),
    falsePositives: Math.max(Number(local.falsePositives || 0), Number(disk.falsePositives || 0)),
    agentSignoffs: [...mergedSignoffs],
    lastUpdated: toTimestampMs(local.lastUpdated) >= toTimestampMs(disk.lastUpdated)
      ? (local.lastUpdated || new Date().toISOString())
      : (disk.lastUpdated || new Date().toISOString()),
  };
}

function getPromotedContractDefinition(contractId) {
  const base = contracts.getContractById(contractId);
  if (!base) return null;
  return {
    ...base,
    mode: 'enforced',
    emitOnViolation: 'contract.violation',
  };
}

/**
 * Load stats from disk and replace in-memory state.
 */
function loadStats() {
  const parsed = readStatsFromDisk();
  if (parsed) {
    stats = parsed;
    return;
  }
  stats = { contracts: {} };
}

/**
 * Save stats to disk.
 */
function saveStats() {
  try {
    const dir = path.dirname(STATS_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), 'utf8');
  } catch {
    // Non-critical - stats will be rebuilt
  }
}

/**
 * Merge disk state into in-memory state.
 * This keeps renderer-tracked counters while importing IPC-side signoffs/rejections.
 */
function syncStatsFromDisk() {
  const diskStats = readStatsFromDisk();
  if (!diskStats) {
    return getStats();
  }

  const mergedContracts = {};
  const localContracts = asObject(stats.contracts);
  const diskContracts = asObject(diskStats.contracts);
  const contractIds = new Set([
    ...Object.keys(localContracts),
    ...Object.keys(diskContracts),
  ]);

  for (const contractId of contractIds) {
    const localEntry = localContracts[contractId];
    const diskEntry = diskContracts[contractId];
    if (localEntry && diskEntry) {
      mergedContracts[contractId] = mergeContractStats(localEntry, diskEntry);
    } else if (localEntry) {
      mergedContracts[contractId] = { ...localEntry };
    } else if (diskEntry) {
      mergedContracts[contractId] = { ...diskEntry };
    }
  }

  stats = {
    ...asObject(diskStats),
    ...asObject(stats),
    contracts: mergedContracts,
  };
  return getStats();
}

/**
 * Get or create stats entry for a contract.
 */
function getContractStats(contractId) {
  if (!stats.contracts[contractId]) {
    stats.contracts[contractId] = {
      mode: 'shadow',
      sessionsTracked: 0,
      shadowViolations: 0,
      falsePositives: 0,
      agentSignoffs: [],
      lastUpdated: new Date().toISOString(),
    };
  }
  return stats.contracts[contractId];
}

/**
 * Record a shadow violation for a contract.
 */
function recordViolation(contractId) {
  const entry = getContractStats(contractId);
  entry.shadowViolations += 1;
  entry.lastUpdated = new Date().toISOString();
}

/**
 * Record a false positive for a contract.
 */
function recordFalsePositive(contractId) {
  const entry = getContractStats(contractId);
  entry.falsePositives += 1;
  entry.lastUpdated = new Date().toISOString();
}

/**
 * Add an agent sign-off for a contract.
 */
function addSignoff(contractId, agentName) {
  const entry = getContractStats(contractId);
  if (!entry.agentSignoffs.includes(agentName)) {
    entry.agentSignoffs.push(agentName);
    entry.lastUpdated = new Date().toISOString();
  }
}

/**
 * Increment session count for a contract.
 */
function incrementSession(contractId) {
  const entry = getContractStats(contractId);
  entry.sessionsTracked += 1;
  entry.lastUpdated = new Date().toISOString();
}

/**
 * Check if a contract meets promotion criteria.
 */
function isReadyForPromotion(contractId) {
  const entry = stats.contracts[contractId];
  if (!entry || entry.mode !== 'shadow') return false;

  return (
    entry.sessionsTracked >= MIN_SESSIONS &&
    entry.falsePositives === 0 &&
    entry.agentSignoffs.length >= REQUIRED_SIGNOFFS
  );
}

/**
 * Check all contracts and promote any that meet criteria.
 * Returns array of promoted contract IDs.
 */
function checkPromotions() {
  // Keep renderer and main-process mutations converged before evaluating readiness.
  syncStatsFromDisk();

  const promoted = [];

  for (const contractId of Object.keys(stats.contracts)) {
    if (isReadyForPromotion(contractId)) {
      const entry = stats.contracts[contractId];
      entry.mode = 'enforced';
      entry.lastUpdated = new Date().toISOString();
      promoted.push(contractId);

      if (bus) {
        const promotedDefinition = getPromotedContractDefinition(contractId);
        if (promotedDefinition) {
          bus.registerContract(promotedDefinition);
        }

        bus.emit('contract.promoted', {
          paneId: 'system',
          payload: {
            contractId,
            sessionsTracked: entry.sessionsTracked,
            shadowViolations: entry.shadowViolations,
            contractDefinitionFound: Boolean(promotedDefinition),
          },
          source: 'contract-promotion.js',
        });
      }
    }
  }

  return promoted;
}

/**
 * Initialize the promotion engine.
 * Loads stats and subscribes to shadow violation events.
 */
function init(eventBus) {
  bus = eventBus;
  loadStats();

  bus.on('contract.shadow.violation', (event) => {
    const contractId = event.payload?.contractId;
    if (contractId) {
      recordViolation(contractId);
    }
  });
}

/**
 * Get all stats (for testing/introspection).
 */
function getStats() {
  return JSON.parse(JSON.stringify(stats));
}

/**
 * Reset all state (for testing).
 */
function reset() {
  stats = { contracts: {} };
  bus = null;
}

module.exports = {
  init,
  saveStats,
  syncStatsFromDisk,
  checkPromotions,
  // Manual operations
  addSignoff,
  incrementSession,
  recordFalsePositive,
  // Introspection
  getStats,
  getContractStats,
  isReadyForPromotion,
  // Testing
  reset,
  getPromotedContractDefinition,
  // Constants
  MIN_SESSIONS,
  REQUIRED_SIGNOFFS,
  STATS_PATH,
};
