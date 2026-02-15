const fs = require('fs');
const os = require('os');
const path = require('path');

const { TeamMemoryStore, loadSqliteDriver } = require('../modules/team-memory/store');
const { TeamMemoryPatterns } = require('../modules/team-memory/patterns');
const { TeamMemoryGuards } = require('../modules/team-memory/guards');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

maybeDescribe('team-memory guards module', () => {
  let tempDir;
  let store;
  let patterns;
  let guards;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-team-guards-'));
    store = new TeamMemoryStore({
      dbPath: path.join(tempDir, 'team-memory.sqlite'),
    });
    expect(store.init().ok).toBe(true);
    patterns = new TeamMemoryPatterns(store.db);
    guards = new TeamMemoryGuards(store.db);
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('creates, queries, activates, and deactivates guards', () => {
    const created = guards.createGuard({
      action: 'warn',
      triggerCondition: {
        scope: 'ui/modules/triggers.js',
        patternType: 'failure',
      },
    });

    expect(created.ok).toBe(true);
    expect(created.guard.action).toBe('warn');
    expect(created.guard.active).toBe(true);

    const queried = guards.queryGuards({
      active: true,
      scope: 'ui/modules/triggers.js',
      patternType: 'failure',
    });
    expect(queried.ok).toBe(true);
    expect(queried.total).toBeGreaterThanOrEqual(1);

    const deactivated = guards.deactivateGuard(created.guard.id);
    expect(deactivated.ok).toBe(true);
    expect(deactivated.guard.active).toBe(false);

    const reactivated = guards.activateGuard(created.guard.id);
    expect(reactivated.ok).toBe(true);
    expect(reactivated.guard.active).toBe(true);
  });

  test('evaluates warn/block/suggest guard actions from hook events', () => {
    guards.createGuard({
      action: 'warn',
      triggerCondition: {
        scope: 'ui/modules/triggers.js',
        patternType: 'failure',
      },
    });
    guards.createGuard({
      action: 'block',
      triggerCondition: {
        scope: 'ui/modules/triggers.js',
        eventType: 'inject',
      },
    });
    guards.createGuard({
      action: 'suggest',
      triggerCondition: {
        scope: 'ui/modules/injection.js',
        suggestion: 'Consider a larger enter delay for long payloads.',
      },
    });

    const evaluation = guards.evaluateHookEvents([
      {
        scope: 'ui/modules/triggers.js',
        patternType: 'failure',
        eventType: 'inject',
        message: 'delivery failure observed',
      },
      {
        scope: 'ui/modules/injection.js',
        eventType: 'render',
      },
    ]);

    expect(evaluation.ok).toBe(true);
    expect(evaluation.actions.some((entry) => entry.action === 'warn')).toBe(true);
    expect(evaluation.actions.some((entry) => entry.action === 'block')).toBe(true);
    expect(evaluation.actions.some((entry) => entry.action === 'suggest')).toBe(true);
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.blockedCount).toBeGreaterThanOrEqual(1);
  });

  test('auto-creates warn guard from high-confidence failure pattern', () => {
    const patternCreate = patterns.createPattern({
      patternType: 'failure',
      scope: 'ui/modules/triggers.js',
      agents: ['architect', 'builder'],
      frequency: 4,
      confidence: 0.92,
    });
    expect(patternCreate.ok).toBe(true);

    const autoCreate = guards.autoCreateGuardsFromPatterns({
      patterns: [patternCreate.pattern],
      threshold: 0.8,
    });
    expect(autoCreate.ok).toBe(true);
    expect(autoCreate.createdCount).toBe(1);
    expect(autoCreate.created[0].action).toBe('warn');
    expect(autoCreate.created[0].sourcePattern).toBe(patternCreate.pattern.id);

    const secondRun = guards.autoCreateGuardsFromPatterns({
      patterns: [patternCreate.pattern],
      threshold: 0.8,
    });
    expect(secondRun.ok).toBe(true);
    expect(secondRun.createdCount).toBe(0);
    expect(secondRun.existingCount).toBeGreaterThanOrEqual(1);
  });
});
