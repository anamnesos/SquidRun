/**
 * Migration 008 - contradiction resolved_at Tests
 */

'use strict';

const migration = require('../modules/team-memory/migrations/008-phase6c-contradiction-resolution');

function createMockDb({ hasResolvedAt = false, duplicateOnAlter = false } = {}) {
  const execCalls = [];
  const db = {
    prepare: jest.fn((sql) => {
      if (String(sql).includes('PRAGMA table_info(belief_contradictions)')) {
        return {
          all: jest.fn(() => (
            hasResolvedAt
              ? [{ name: 'id' }, { name: 'resolved_at' }]
              : [{ name: 'id' }]
          )),
        };
      }
      return { all: jest.fn(() => []) };
    }),
    exec: jest.fn((sql) => {
      execCalls.push(sql);
      if (duplicateOnAlter && String(sql).includes('ALTER TABLE belief_contradictions ADD COLUMN resolved_at')) {
        throw new Error('duplicate column name: resolved_at');
      }
    }),
  };
  return { db, execCalls };
}

describe('Migration 008 - contradiction resolved_at', () => {
  test('exports version 8 and description', () => {
    expect(migration.version).toBe(8);
    expect(migration.description).toContain('resolved_at');
  });

  test('adds resolved_at column and runs historical backfill when missing', () => {
    const { db, execCalls } = createMockDb({ hasResolvedAt: false });

    migration.up(db);

    expect(execCalls.some((sql) => sql.includes('ALTER TABLE belief_contradictions ADD COLUMN resolved_at'))).toBe(true);
    expect(execCalls.some((sql) => sql.includes('idx_contradictions_resolved_at'))).toBe(true);
    expect(execCalls.some((sql) => sql.includes('UPDATE belief_contradictions'))).toBe(true);
  });

  test('skips alter when resolved_at already exists', () => {
    const { db, execCalls } = createMockDb({ hasResolvedAt: true });

    migration.up(db);

    expect(execCalls.some((sql) => sql.includes('ALTER TABLE belief_contradictions ADD COLUMN resolved_at'))).toBe(false);
    expect(execCalls.some((sql) => sql.includes('idx_contradictions_resolved_at'))).toBe(true);
    expect(execCalls.some((sql) => sql.includes('UPDATE belief_contradictions'))).toBe(true);
  });

  test('ignores duplicate-column alter errors safely', () => {
    const { db, execCalls } = createMockDb({ hasResolvedAt: false, duplicateOnAlter: true });

    expect(() => migration.up(db)).not.toThrow();
    expect(execCalls.some((sql) => sql.includes('ALTER TABLE belief_contradictions ADD COLUMN resolved_at'))).toBe(true);
  });
});
