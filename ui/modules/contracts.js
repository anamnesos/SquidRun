/**
 * Contract Engine - Day-1 contracts for the Event Kernel
 * Phase 3: Registers contracts that guard injection, resize, and overlay operations.
 *
 * Contracts are precondition checks evaluated before events pass through the bus.
 * A violated precondition triggers the contract's action (defer, block, skip).
 */

const FOCUS_LOCK_GUARD = {
  id: 'focus-lock-guard',
  version: 1,
  owner: 'contracts.js',
  appliesTo: ['inject.requested'],
  preconditions: [
    (event, state) => !state.gates.focusLocked,
  ],
  severity: 'block',
  action: 'defer',
  fallbackAction: 'defer',
  mode: 'enforced',
  emitOnViolation: 'contract.violation',
};

const COMPACTION_GATE = {
  id: 'compaction-gate',
  version: 1,
  owner: 'contracts.js',
  appliesTo: ['inject.requested'],
  preconditions: [
    (event, state) => state.gates.compacting !== 'confirmed',
  ],
  severity: 'block',
  action: 'defer',
  fallbackAction: 'defer',
  mode: 'enforced',
  emitOnViolation: 'contract.violation',
};

const OWNERSHIP_EXCLUSIVE = {
  id: 'ownership-exclusive',
  version: 1,
  owner: 'contracts.js',
  appliesTo: ['inject.requested', 'resize.requested'],
  preconditions: [
    (event, state) => state.activity === 'idle',
  ],
  severity: 'block',
  action: 'block',
  fallbackAction: 'block',
  mode: 'enforced',
  emitOnViolation: 'contract.violation',
};

const OVERLAY_FIT_EXCLUSION = {
  id: 'overlay-fit-exclusion',
  version: 1,
  owner: 'contracts.js',
  appliesTo: ['resize.started'],
  preconditions: [
    (event, state) => !state.overlay.open,
  ],
  severity: 'warn',
  action: 'skip',
  fallbackAction: 'skip',
  mode: 'enforced',
  emitOnViolation: 'contract.violation',
};

// Shadow variant used by the promotion engine.
// Keep this contract ahead of enforced equivalent so shadow evidence is recorded.
const OVERLAY_FIT_EXCLUSION_SHADOW = {
  id: 'overlay-fit-exclusion-shadow',
  version: 1,
  owner: 'contracts.js',
  appliesTo: ['resize.started'],
  preconditions: [
    (event, state) => !state.overlay.open,
  ],
  severity: 'warn',
  action: 'skip',
  fallbackAction: 'skip',
  mode: 'shadow',
  emitOnViolation: 'contract.shadow.violation',
};

const CONTRACTS = [
  FOCUS_LOCK_GUARD,
  COMPACTION_GATE,
  OWNERSHIP_EXCLUSIVE,
  OVERLAY_FIT_EXCLUSION_SHADOW,
  OVERLAY_FIT_EXCLUSION,
];

const SHADOW_CONTRACTS = CONTRACTS.filter((contract) => contract.mode === 'shadow');
const ENFORCED_CONTRACTS = CONTRACTS.filter((contract) => contract.mode === 'enforced');

/**
 * Initialize and register all day-1 contracts with the event bus.
 * @param {object} bus - The event bus instance
 */
function init(bus) {
  for (const contract of CONTRACTS) {
    bus.registerContract(contract);
  }
}

function getContractById(contractId) {
  return CONTRACTS.find((contract) => contract.id === contractId) || null;
}

module.exports = {
  init,
  CONTRACTS,
  SHADOW_CONTRACTS,
  ENFORCED_CONTRACTS,
  getContractById,
  FOCUS_LOCK_GUARD,
  COMPACTION_GATE,
  OWNERSHIP_EXCLUSIVE,
  OVERLAY_FIT_EXCLUSION_SHADOW,
  OVERLAY_FIT_EXCLUSION,
};
