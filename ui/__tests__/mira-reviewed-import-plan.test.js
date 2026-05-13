'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildReviewedImportPlan,
  formatPlanSummary,
  relativeDestinationInsideRoot,
} = require('../../mira/tools/plan-reviewed-imports');

describe('Mira reviewed import dry-run planner', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const stateRoot = path.join(repoRoot, 'mira', '.state-dev-test');

  test('reports all reviewed imports without copying or mutating queue state', () => {
    const queuePath = path.join(repoRoot, 'mira', 'imports', 'review-queue.json');
    const before = fs.readFileSync(queuePath, 'utf8');
    const plan = buildReviewedImportPlan({ env: { MIRA_STATE_ROOT: stateRoot } });
    const after = fs.readFileSync(queuePath, 'utf8');

    expect(plan.ok).toBe(true);
    expect(plan.schema).toBe('mira.reviewed_import_plan.v1');
    expect(plan.state_root).toBe(path.resolve(stateRoot));
    expect(plan.copied).toBe(false);
    expect(plan.moved).toBe(false);
    expect(plan.deleted).toBe(false);
    expect(plan.mutated_queue_status).toBe(false);
    expect(plan.records.length).toBe(14);
    expect(plan.records.every((record) => record.status === 'not_imported')).toBe(true);
    expect(plan.records.every((record) => record.source_exists)).toBe(true);
    expect(plan.records.every((record) => record.destination_within_state_root)).toBe(true);
    expect(after).toBe(before);
  });

  test('makes missing sources explicit in the dry-run report', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-import-plan-'));
    const queuePath = path.join(tempRoot, 'review-queue.json');
    const contractPath = path.join(tempRoot, 'state-root-contract.json');

    fs.writeFileSync(contractPath, JSON.stringify({
      forbidden_destinations: ['.squidrun', '.squidrun/**', 'workspace/memory', 'workspace/memory/**'],
    }));
    fs.writeFileSync(queuePath, JSON.stringify({
      schema: 'mira.import_queue.v1',
      records: [
        {
          id: 'missing_source',
          source_path: 'workspace/nope/missing.json',
          source_kind: 'profile_state',
          status: 'not_imported',
          destination: 'continuity/missing.json',
          selection_policy: 'review_current_fields_only',
          notes: 'Missing source fixture.',
        },
      ],
    }));

    const plan = buildReviewedImportPlan({
      env: { MIRA_STATE_ROOT: path.join(tempRoot, 'state-root') },
      queuePath,
      contractPath,
    });

    expect(plan.ok).toBe(false);
    expect(plan.records).toHaveLength(1);
    expect(plan.records[0]).toEqual(expect.objectContaining({
      id: 'missing_source',
      source_exists: false,
      destination_within_state_root: true,
    }));
    expect(plan.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('source_path missing on disk'),
    ]));
  });

  test('rejects destinations that escape the resolved Mira state root', () => {
    const destination = relativeDestinationInsideRoot(stateRoot, '../outside.json');

    expect(destination.ok).toBe(false);
    expect(buildReviewedImportPlan({ env: {} })).toEqual(expect.objectContaining({
      ok: false,
      copied: false,
      moved: false,
      deleted: false,
    }));
  });

  test('formats a concise non-mutating dry-run summary', () => {
    const plan = buildReviewedImportPlan({ env: { MIRA_STATE_ROOT: stateRoot } });
    const summary = formatPlanSummary(plan);

    expect(summary).toContain('Mira reviewed import dry-run (14 records)');
    expect(summary).toContain('copied=false moved=false deleted=false mutated_queue_status=false');
  });
});
