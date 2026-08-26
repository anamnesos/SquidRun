const { MEMORY_CLASSES, normalizeClaimType } = require('./schema');

const ROUTING_TABLE = Object.freeze({
  user_preference: Object.freeze({
    tier: 'tier1',
    targetFile: 'workspace/knowledge/user-context.md',
    routeType: 'promotion_candidate',
  }),
  environment_quirk: Object.freeze({
    tier: 'tier1',
    targetFile: 'workspace/knowledge/runtime-environment.md',
    routeType: 'promotion_candidate',
  }),
  procedural_rule: Object.freeze({
    tier: 'tier1',
    targetFile: 'workspace/knowledge/workflows.md',
    routeType: 'promotion_candidate',
  }),
  architecture_decision: Object.freeze({
    tier: 'tier1',
    targetFile: 'ARCHITECTURE.md',
    routeType: 'promotion_candidate',
  }),
  solution_trace: Object.freeze({
    tier: 'tier3',
    routeType: 'auto_route',
  }),
  historical_outcome: Object.freeze({
    tier: 'tier3',
    routeType: 'auto_route',
  }),
  active_task_state: Object.freeze({
    tier: 'tier4',
    routeType: 'auto_route',
  }),
  cross_device_handoff: Object.freeze({
    tier: 'tier4',
    routeType: 'auto_route',
  }),
  codebase_inventory: Object.freeze({
    tier: 'tier3',
    routeType: 'auto_route',
  }),
  system_health_state: Object.freeze({
    tier: 'tier3',
    routeType: 'auto_route',
  }),
});

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function hasDirectUserCorrection(provenance = {}) {
  const source = asObject(provenance);
  const haystack = [
    source.kind,
    source.source,
    source.actor,
    source.type,
    source.reason,
  ]
    .filter(Boolean)
    .map((entry) => String(entry).toLowerCase());

  if (haystack.some((entry) => entry.includes('user_correction') || entry.includes('direct_user_correction'))) {
    return true;
  }

  const claimType = normalizeClaimType(source.claim_type || source.claimType);
  const explicitUserSource = haystack.some((entry) => entry === 'user' || entry === 'direct_user' || entry === 'user_statement');
  return Boolean(claimType && explicitUserSource);
}

function resolveTargetFile(memory = {}) {
  const route = ROUTING_TABLE[memory.memory_class];
  if (!route || route.tier !== 'tier1') return null;

  if (memory.memory_class === 'environment_quirk') {
    return 'workspace/knowledge/runtime-environment.md';
  }

  if (memory.memory_class === 'architecture_decision') {
    const scope = asObject(memory.scope);
    const scopeProject = String(scope.project || scope.domain || '').toLowerCase();
    if (scopeProject.includes('project')) return 'workspace/knowledge/projects.md';
  }

  return route.targetFile || null;
}

function resolveAuthorityLevel(memory = {}) {
  if (hasDirectUserCorrection(memory.provenance)) return 'user_override';
  if (memory.memory_class === 'user_preference') return 'user_signal';
  if (memory.memory_class === 'active_task_state' || memory.memory_class === 'cross_device_handoff') {
    return 'delivery';
  }
  if (
    memory.memory_class === 'solution_trace'
    || memory.memory_class === 'historical_outcome'
    || memory.memory_class === 'codebase_inventory'
    || memory.memory_class === 'system_health_state'
  ) {
    return 'derived';
  }
  return 'candidate';
}

function isPromotionRequired(memory = {}) {
  const route = ROUTING_TABLE[memory.memory_class];
  if (!route || route.tier !== 'tier1') return false;
  const claimType = normalizeClaimType(memory.claim_type);
  if (claimType === 'preference') return false;
  if (claimType === 'objective_fact') return false;
  if (claimType === 'operational_correction') return true;
  if (memory.memory_class === 'user_preference' && hasDirectUserCorrection(memory.provenance)) {
    return false;
  }
  return true;
}

function resolveMemoryRoute(memory = {}) {
  const memoryClass = String(memory.memory_class || '').trim().toLowerCase();
  if (!MEMORY_CLASSES.includes(memoryClass)) {
    return {
      ok: false,
      reason: 'unsupported_memory_class',
      memoryClass,
    };
  }

  const baseRoute = ROUTING_TABLE[memoryClass];
  const promotionRequired = isPromotionRequired(memory);

  return {
    ok: true,
    memoryClass,
    tier: baseRoute.tier,
    routeType: baseRoute.routeType,
    promotionRequired,
    targetFile: resolveTargetFile(memory),
    authorityLevel: resolveAuthorityLevel(memory),
  };
}

module.exports = {
  ROUTING_TABLE,
  hasDirectUserCorrection,
  isPromotionRequired,
  resolveMemoryRoute,
  resolveTargetFile,
};
