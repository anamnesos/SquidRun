'use strict';

const fs = require('fs');
const path = require('path');

describe('Mira first batch dry-run report', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const reportPath = path.join(repoRoot, 'mira', 'imports', 'reports', 'first-batch-dry-run-v1.json');
  const readmePath = path.join(repoRoot, 'mira', 'imports', 'reports', 'README.md');
  const queuePath = path.join(repoRoot, 'mira', 'imports', 'review-queue.json');

  test('proposes only stable acceptance and permission contracts', () => {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

    expect(report.schema).toBe('mira.import_batch_dry_run_report.v1');
    expect(report.proposal).toEqual(expect.objectContaining({
      batch_id: 'acceptance-permission-contracts-v1',
      status: 'review_only',
      requires_explicit_approval_before_import: true,
    }));
    expect(report.batch_records.map((record) => record.id)).toEqual([
      'presence_runtime_acceptance',
      'north_star_acceptance',
      'pc_embodiment_permission',
    ]);
    expect(report.batch_records.every((record) => record.source_exists)).toBe(true);
    expect(report.batch_records.every((record) => record.destination_under_state_root)).toBe(true);
    expect(report.batch_records.every((record) => record.current_queue_status === 'not_imported')).toBe(true);
  });

  test('is explicitly report-only and does not approve mutation', () => {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const readme = fs.readFileSync(readmePath, 'utf8');
    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));

    expect(report.mutation_flags).toEqual({
      copied: false,
      moved: false,
      deleted: false,
      status_mutated: false,
      queue_mutated: false,
    });
    expect(report.non_scope).toEqual(expect.arrayContaining([
      'live_data_copy',
      'live_data_delete',
      'live_data_move',
      'queue_status_mutation',
      'runtime_state_read',
      'telegram_route',
    ]));
    expect(readme).toContain('do not copy, move, delete, or mutate queue status');
    expect(queue.records.every((record) => record.status === 'not_imported')).toBe(true);
  });
});
