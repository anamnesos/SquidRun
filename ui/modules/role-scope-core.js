'use strict';

/**
 * ROLE + SCOPE CORE (S468 role-scope-consolidation) — the ONE implementation
 * of the canon in ui/types/contracts.d.ts (KnownRole / RoleParty /
 * NormalizeRole / ScopeEnvelope, commit 6ad2ff9c).
 *
 * Before this module: normalizeRole existed as 9 copies / 8 distinct bodies
 * (fallbacks disagreed: 'architect' misroutes to pane 1, '' is falsy-null in
 * worse clothing, passthrough lets junk into routing). normalizeScope as
 * 14 copies / 5 bodies spanning two unrelated concepts.
 *
 * THE CONTRACT (body-hash evidence -> Architect ruling, not taste):
 *  - normalizeRole: trim+lowercase; '1'|'main'->architect, '2'->builder,
 *    '3'->oracle; unknown/empty -> null ALWAYS. Callers decide null policy
 *    explicitly.
 *  - normalizeRoleParty: KnownRole plus user|james|mira|system, validated,
 *    never coerced to a pane role.
 *  - normalizeScopeEnvelope: ingress defaults ONLY (profileName 'main',
 *    windowKey := profileName); unknown ids are null — never '' and never
 *    a fossilized fixture literal.
 */

const KNOWN_ROLES = Object.freeze(['architect', 'builder', 'oracle']);

const ROLE_ALIASES = Object.freeze({
  1: 'architect',
  main: 'architect',
  2: 'builder',
  3: 'oracle',
});

const BROADER_PARTIES = Object.freeze(['user', 'james', 'mira', 'system']);

/** @type {import('../types/contracts').NormalizeRole} */
function normalizeRole(value) {
  const text = (typeof value === 'string' || typeof value === 'number')
    ? String(value).trim().toLowerCase()
    : '';
  if (!text) return null;
  if (KNOWN_ROLES.includes(text)) return text;
  if (ROLE_ALIASES[text]) return ROLE_ALIASES[text];
  return null;
}

/** RoleParty: pane roles + the four broader parties; unknown -> null. */
function normalizeRoleParty(value) {
  const asRole = normalizeRole(value);
  if (asRole) return asRole;
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return BROADER_PARTIES.includes(text) ? text : null;
}

function cleanId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** @returns {import('../types/contracts').ScopeEnvelope} */
function normalizeScopeEnvelope(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const profileName = cleanId(src.profileName) || 'main';
  const windowKey = cleanId(src.windowKey) || profileName;
  return {
    profileName,
    windowKey,
    sessionId: cleanId(src.sessionId),
    deviceId: cleanId(src.deviceId),
    projectPath: cleanId(src.projectPath),
  };
}

module.exports = {
  KNOWN_ROLES: KNOWN_ROLES.slice(),
  normalizeRole,
  normalizeRoleParty,
  normalizeScopeEnvelope,
};
