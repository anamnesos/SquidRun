/**
 * Migration 007 - Phase 6b pending_proof Tests
 * Target: Full coverage of team-memory/migrations/007-phase6b-pending-proof.js
 */

'use strict';

const migration = require('../modules/team-memory/migrations/007-phase6b-pending-proof');

function createMockDb({ claimsSql = '', throwOnPrepare = false, throwOnExec = false } = {}) {
  const execCalls = [];
  const db = {
    prepare: jest.fn(() => ({
      get: jest.fn(() => (throwOnPrepare ? (() => { throw new Error('prepare fail'); })() : { sql: claimsSql })),
    })),
    exec: jest.fn((sql) => {
      execCalls.push(sql);
      if (throwOnExec && sql.includes('BEGIN')) {
        throw new Error('exec fail');
      }
    }),
  };
  return { db, execCalls };
}

describe('Migration 007 - pending_proof', () => {
  test('exports version 7', () => {
    expect(migration.version).toBe(7);
  });

  test('exports description', () => {
    expect(migration.description).toContain('pending_proof');
  });

  test('skips migration when pending_proof already exists', () => {
    const { db } = createMockDb({
      claimsSql: "CREATE TABLE claims (status TEXT CHECK (status IN ('proposed','confirmed','contested','pending_proof','deprecated')))",
    });

    migration.up(db);

    // Should only call prepare (to check), NOT exec any DDL
    expect(db.prepare).toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
  });

  test('runs migration when pending_proof is missing', () => {
    const { db, execCalls } = createMockDb({
      claimsSql: "CREATE TABLE claims (status TEXT CHECK (status IN ('proposed','confirmed','contested','deprecated')))",
    });

    migration.up(db);

    // Should disable foreign keys, begin, recreate, commit, re-enable
    expect(execCalls.some(s => s.includes('foreign_keys = OFF'))).toBe(true);
    expect(execCalls.some(s => s.includes('BEGIN IMMEDIATE'))).toBe(true);
    expect(execCalls.some(s => s.includes('claims_next_v7'))).toBe(true);
    expect(execCalls.some(s => s.includes('COMMIT'))).toBe(true);
    expect(execCalls.some(s => s.includes('foreign_keys = ON'))).toBe(true);
  });

  test('runs migration when claims table has no sql (null row)', () => {
    const { db } = createMockDb({ claimsSql: '' });

    migration.up(db);

    // Empty sql → no 'pending_proof' → should run migration
    expect(db.exec).toHaveBeenCalled();
  });

  test('runs migration when prepare returns null row', () => {
    const db = {
      prepare: jest.fn(() => ({
        get: jest.fn(() => null),
      })),
      exec: jest.fn(),
    };

    migration.up(db);

    // null row → String(undefined).includes('pending_proof') → false → runs migration
    expect(db.exec).toHaveBeenCalled();
  });

  test('handles hasPendingProofStatus exception gracefully', () => {
    const db = {
      prepare: jest.fn(() => { throw new Error('db locked'); }),
      exec: jest.fn(),
    };

    migration.up(db);

    // Exception in hasPendingProofStatus → returns false → runs migration
    expect(db.exec).toHaveBeenCalled();
  });

  test('rolls back and re-throws on recreate failure', () => {
    let execCalls = [];
    const db = {
      prepare: jest.fn(() => ({
        get: jest.fn(() => ({ sql: 'CREATE TABLE claims (status TEXT)' })),
      })),
      exec: jest.fn((sql) => {
        execCalls.push(sql);
        if (sql.includes('claims_next_v7')) {
          throw new Error('DDL failed');
        }
      }),
    };

    expect(() => migration.up(db)).toThrow('DDL failed');

    // Should have attempted ROLLBACK
    expect(execCalls.some(s => s.includes('ROLLBACK'))).toBe(true);
    // Should still re-enable foreign keys (finally block)
    expect(execCalls.some(s => s.includes('foreign_keys = ON'))).toBe(true);
  });

  test('re-enables foreign keys even if ROLLBACK throws', () => {
    let execCalls = [];
    const db = {
      prepare: jest.fn(() => ({
        get: jest.fn(() => ({ sql: 'CREATE TABLE claims (status TEXT)' })),
      })),
      exec: jest.fn((sql) => {
        execCalls.push(sql);
        if (sql.includes('claims_next_v7')) {
          throw new Error('DDL failed');
        }
        if (sql.includes('ROLLBACK')) {
          throw new Error('rollback failed too');
        }
      }),
    };

    expect(() => migration.up(db)).toThrow('DDL failed');

    // Despite ROLLBACK failing, foreign_keys should still be turned ON
    expect(execCalls.some(s => s.includes('foreign_keys = ON'))).toBe(true);
  });

  test('recreate SQL includes all expected columns', () => {
    const { db, execCalls } = createMockDb({
      claimsSql: "CREATE TABLE claims (status TEXT CHECK (status IN ('proposed','confirmed')))",
    });

    migration.up(db);

    const createSql = execCalls.find(s => s.includes('claims_next_v7'));
    expect(createSql).toBeDefined();
    expect(createSql).toContain('id TEXT PRIMARY KEY');
    expect(createSql).toContain('idempotency_key TEXT UNIQUE');
    expect(createSql).toContain('statement TEXT NOT NULL');
    expect(createSql).toContain('claim_type TEXT NOT NULL');
    expect(createSql).toContain('owner TEXT NOT NULL');
    expect(createSql).toContain('confidence REAL');
    expect(createSql).toContain('pending_proof');
    expect(createSql).toContain('supersedes TEXT');
    expect(createSql).toContain('session TEXT');
    expect(createSql).toContain('ttl_hours INTEGER');
    expect(createSql).toContain('created_at INTEGER NOT NULL');
    expect(createSql).toContain('updated_at INTEGER NOT NULL');
  });

  test('recreate SQL creates expected indexes', () => {
    const { db, execCalls } = createMockDb({ claimsSql: 'CREATE TABLE claims ()' });

    migration.up(db);

    const createSql = execCalls.find(s => s.includes('claims_next_v7'));
    expect(createSql).toContain('idx_claims_status');
    expect(createSql).toContain('idx_claims_owner');
    expect(createSql).toContain('idx_claims_type');
    expect(createSql).toContain('idx_claims_session');
    expect(createSql).toContain('idx_claims_created');
  });

  test('recreate SQL uses CASE to normalize invalid status values', () => {
    const { db, execCalls } = createMockDb({ claimsSql: 'CREATE TABLE claims ()' });

    migration.up(db);

    const createSql = execCalls.find(s => s.includes('claims_next_v7'));
    expect(createSql).toContain("ELSE 'proposed'");
  });
});
