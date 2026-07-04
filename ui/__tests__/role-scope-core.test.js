'use strict';

/**
 * S468 role-scope-consolidation: contracts AGAINST the canon
 * (ui/types/contracts.d.ts 6ad2ff9c — KnownRole / RoleParty /
 * NormalizeRole / ScopeEnvelope). The core module implements these;
 * 9 divergent normalizeRole bodies and the mira-core scope family
 * migrate onto it.
 */
const {
  KNOWN_ROLES,
  normalizeRole,
  normalizeRoleParty,
  normalizeScopeEnvelope,
} = require('../modules/role-scope-core');

describe('normalizeRole — the one true role contract', () => {
  test('trim + lowercase on the three known roles', () => {
    expect(normalizeRole(' ORACLE ')).toBe('oracle');
    expect(normalizeRole('Builder')).toBe('builder');
    expect(normalizeRole('architect')).toBe('architect');
  });

  test('alias map: pane numbers and main', () => {
    expect(normalizeRole('1')).toBe('architect');
    expect(normalizeRole('main')).toBe('architect');
    expect(normalizeRole('2')).toBe('builder');
    expect(normalizeRole('3')).toBe('oracle');
    expect(normalizeRole(2)).toBe('builder'); // numeric pane ids coerce
  });

  test('unknown/empty -> null ALWAYS — never architect, never "", never passthrough', () => {
    for (const junk of ['gemini', 'codex', '', '  ', null, undefined, 42, {}, 'admin', '4']) {
      expect(normalizeRole(junk)).toBeNull();
    }
  });

  test('broader parties are NOT pane roles — normalizeRole refuses them', () => {
    for (const party of ['user', 'james', 'mira', 'system']) {
      expect(normalizeRole(party)).toBeNull();
    }
  });

  test('KNOWN_ROLES export matches the canon', () => {
    expect(KNOWN_ROLES).toEqual(['architect', 'builder', 'oracle']);
  });
});

describe('normalizeRoleParty — validated where legal, never coerced to a pane', () => {
  test('accepts known roles and the four broader parties', () => {
    expect(normalizeRoleParty('ORACLE')).toBe('oracle');
    expect(normalizeRoleParty(' james ')).toBe('james');
    expect(normalizeRoleParty('system')).toBe('system');
    expect(normalizeRoleParty('mira')).toBe('mira');
    expect(normalizeRoleParty('user')).toBe('user');
  });

  test('unknown -> null; pane aliases still resolve (a party field may carry them)', () => {
    expect(normalizeRoleParty('admin')).toBeNull();
    expect(normalizeRoleParty('')).toBeNull();
    expect(normalizeRoleParty('2')).toBe('builder');
  });
});

describe('normalizeScopeEnvelope — defaults at ingress only, null over fiction', () => {
  test('empty input gets ingress defaults: profileName main, windowKey := profileName, ids null', () => {
    expect(normalizeScopeEnvelope({})).toEqual({
      profileName: 'main',
      windowKey: 'main',
      sessionId: null,
      deviceId: null,
      projectPath: null,
    });
  });

  test('explicit values survive; windowKey follows a custom profile when absent', () => {
    const out = normalizeScopeEnvelope({ profileName: 'eunbyeol', sessionId: 'app-session-500' });
    expect(out.profileName).toBe('eunbyeol');
    expect(out.windowKey).toBe('eunbyeol');
    expect(out.sessionId).toBe('app-session-500');
    expect(normalizeScopeEnvelope({ windowKey: 'squid-room' }).windowKey).toBe('squid-room');
  });

  test('NEVER a fixture literal: unknown sessionId is null, not app-session-326', () => {
    const out = normalizeScopeEnvelope({ sessionId: undefined });
    expect(out.sessionId).toBeNull();
    expect(JSON.stringify(out)).not.toContain('app-session-326');
    expect(JSON.stringify(out)).not.toContain('session-328');
  });

  test('junk-typed fields null out instead of throwing or passing through', () => {
    const out = normalizeScopeEnvelope({ sessionId: 42, deviceId: {}, projectPath: ['x'], profileName: 7 });
    expect(out.sessionId).toBeNull();
    expect(out.deviceId).toBeNull();
    expect(out.projectPath).toBeNull();
    expect(out.profileName).toBe('main'); // non-string profile -> ingress default
  });
});
