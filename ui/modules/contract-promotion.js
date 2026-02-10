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

const STATS_PATH = path.join(__dirname, '..', '..', 'workspace', 'contract-stats.json');
const MIN_SESSIONS = 5;
const REQUIRED_SIGNOFFS = 2;

let bus = null;
let stats = { contracts: {} };

/**
 * Load stats from disk
 */
function loadStats() {
  try {
    const raw = fs.readFileSync(STATS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.contracts) {
      stats = parsed;
    }
  } catch {
    // File doesn't exist or is invalid — start fresh
    stats = { contracts: {} };
  }
}

/**
 * Save stats to disk
 */
function saveStats() {
  try {
    const dir = path.dirname(STATS_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), 'utf8');
  } catch {
    // Non-critical — stats will be rebuilt
  }
}

/**
 * Get or create stats entry for a contract
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
 * Record a shadow violation for a contract
 */
function recordViolation(contractId) {
  const entry = getContractStats(contractId);
  entry.shadowViolations++;
  entry.lastUpdated = new Date().toISOString();
}

/**
 * Record a false positive for a contract
 */
function recordFalsePositive(contractId) {
  const entry = getContractStats(contractId);
  entry.falsePositives++;
  entry.lastUpdated = new Date().toISOString();
}

/**
 * Add an agent sign-off for a contract
 */
function addSignoff(contractId, agentName) {
  const entry = getContractStats(contractId);
  if (!entry.agentSignoffs.includes(agentName)) {
    entry.agentSignoffs.push(agentName);
    entry.lastUpdated = new Date().toISOString();
  }
}

/**
 * Increment session count for a contract
 */
function incrementSession(contractId) {
  const entry = getContractStats(contractId);
  entry.sessionsTracked++;
  entry.lastUpdated = new Date().toISOString();
}

/**
 * Check if a contract meets promotion criteria
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
  const promoted = [];

  for (const contractId of Object.keys(stats.contracts)) {
    if (isReadyForPromotion(contractId)) {
      const entry = stats.contracts[contractId];
      entry.mode = 'enforced';
      entry.lastUpdated = new Date().toISOString();
      promoted.push(contractId);

      // Re-register the contract as enforced on the bus
      if (bus) {
        bus.registerContract({
          id: contractId,
          version: 1,
          owner: 'contract-promotion.js',
          appliesTo: [], // caller must provide full contract definition
          preconditions: [],
          severity: 'block',
          action: 'block',
          fallbackAction: 'block',
          mode: 'enforced',
          emitOnViolation: 'contract.violation',
        });

        bus.emit('contract.promoted', {
          paneId: 'system',
          payload: {
            contractId,
            sessionsTracked: entry.sessionsTracked,
            shadowViolations: entry.shadowViolations,
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
 *
 * @param {object} eventBus - The event bus instance
 */
function init(eventBus) {
  bus = eventBus;
  loadStats();

  // Track shadow violations
  bus.on('contract.shadow.violation', (event) => {
    const contractId = event.payload?.contractId;
    if (contractId) {
      recordViolation(contractId);
    }
  });
}

/**
 * Get all stats (for testing/introspection)
 */
function getStats() {
  return JSON.parse(JSON.stringify(stats));
}

/**
 * Reset all state (for testing)
 */
function reset() {
  stats = { contracts: {} };
  bus = null;
}

module.exports = {
  init,
  saveStats,
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
  // Constants
  MIN_SESSIONS,
  REQUIRED_SIGNOFFS,
  STATS_PATH,
};
