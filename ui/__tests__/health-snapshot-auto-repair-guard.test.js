'use strict';

/**
 * The GUARD is the feature (S483). Auto-repairing James's memory index is only
 * acceptable because the scope is additive by construction - so the code must
 * PROVE that per-run instead of trusting the scope flag it just passed in.
 *
 * If a future scope change ever makes `missing-only` plan a delete, this must
 * ABORT rather than apply. An auto-repair that trusts its own flag is exactly
 * the silent-success class: it would look like a healthy auto-fix while
 * deleting user memory.
 */

const path = require('path');

const MODULE_PATH = path.join(__dirname, '..', 'scripts', 'hm-health-snapshot.js');
const CONSISTENCY_PATH = path.join(__dirname, '..', 'modules', 'memory-consistency-check.js');

describe('startup auto-repair guard (missing-only, additive by construction)', () => {
  let planMock;
  let repairMock;

  beforeEach(() => {
    jest.resetModules();
    planMock = jest.fn();
    repairMock = jest.fn(() => ({ execution: { appliedActions: 2, insertedNodes: 2, resyncedNodes: 0, deletedNodes: 0 } }));
    jest.doMock(CONSISTENCY_PATH, () => ({
      REQUIRED_NODE_COLUMNS: [],
      runMemoryConsistencyCheck: jest.fn(() => ({ status: 'synced', synced: true, summary: {} })),
      planMemoryConsistencyRepair: planMock,
      runMemoryConsistencyRepair: repairMock,
      resolveCognitiveMemoryDbPath: jest.fn(() => null),
    }));
  });

  afterEach(() => {
    jest.dontMock(CONSISTENCY_PATH);
  });

  test('ABORTS without applying when the plan contains any delete', () => {
    planMock.mockReturnValue({
      actions: [{ kind: 'delete_revision_skew_orphan', deleteCount: 1 }],
      skipped: [],
      summary: { deleteCount: 1, orphanDeleteCount: 1 },
    });
    const { maybeAutoRepairMissingOnly } = require(MODULE_PATH);
    const result = maybeAutoRepairMissingOnly({ summary: { missingInCognitiveCount: 3 } }, {});

    expect(result.applied).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.reason).toBe('planned_deletes_nonzero_scope_contract_violated');
    // THE POINT: the repair was never executed.
    expect(repairMock).not.toHaveBeenCalled();
  });

  test('applies only when the plan is provably delete-free', () => {
    planMock.mockReturnValue({
      actions: [{ kind: 'insert_missing_node' }, { kind: 'resync_same_heading' }],
      skipped: [],
      summary: { deleteCount: 0, orphanDeleteCount: 0 },
    });
    const { maybeAutoRepairMissingOnly } = require(MODULE_PATH);
    const result = maybeAutoRepairMissingOnly({ summary: { missingInCognitiveCount: 2 } }, {});

    expect(result.applied).toBe(true);
    expect(result.scope).toBe('missing-only');
    expect(result.deletedNodes).toBe(0);
    expect(repairMock).toHaveBeenCalledTimes(1);
    // Scope is forced, never inherited from the caller.
    expect(repairMock.mock.calls[0][0].repairScope).toBe('missing-only');
  });

  test('does nothing when nothing is missing (no drift = no writes)', () => {
    const { maybeAutoRepairMissingOnly } = require(MODULE_PATH);
    expect(maybeAutoRepairMissingOnly({ summary: { missingInCognitiveCount: 0 } }, {})).toBeNull();
    expect(planMock).not.toHaveBeenCalled();
    expect(repairMock).not.toHaveBeenCalled();
  });

  test('does nothing when drift exists but the plan has no actions', () => {
    planMock.mockReturnValue({ actions: [], skipped: [], summary: { deleteCount: 0, orphanDeleteCount: 0 } });
    const { maybeAutoRepairMissingOnly } = require(MODULE_PATH);
    const result = maybeAutoRepairMissingOnly({ summary: { missingInCognitiveCount: 1 } }, {});
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no_actions_planned');
    expect(repairMock).not.toHaveBeenCalled();
  });
});
