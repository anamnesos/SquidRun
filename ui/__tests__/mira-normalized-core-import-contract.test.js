'use strict';

const fs = require('fs');
const path = require('path');

describe('Mira normalized core import contract', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const contractPath = path.join(repoRoot, 'mira', 'imports', 'normalizers', 'batch-2a-core-normalizer-contract-v0.json');
  const reportPath = path.join(repoRoot, 'mira', 'imports', 'reports', 'batch-2a-normalized-core-dry-run-v1.json');
  const semanticsPath = path.join(repoRoot, 'mira', 'imports', 'normalizers', 'batch-2a-core-normalizer-contract-v0.md');

  function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  test('defines batch 2a as normalized core only', () => {
    const contract = readJson(contractPath);

    expect(contract).toEqual(expect.objectContaining({
      schema: 'mira.normalizer_contract.v0',
      batch_id: 'normalized-core-state-v1',
      status: 'dry_run_shape_only',
      source_of_truth: 'Oracle #17',
      normalization_mode: 'normalized_state_not_raw_copy',
    }));
    expect(contract.approved_record_ids).toEqual([
      'mira_self_profile',
      'james_relationship_state',
      'relationship_presence_permissions',
    ]);
    expect(contract.excluded_record_ids).toEqual([
      'relationship_growth_history',
      'relationship_growth_audit',
    ]);
  });

  test('dry-run report shape excludes raw import and apply execution', () => {
    const report = readJson(reportPath);

    expect(report).toEqual(expect.objectContaining({
      schema: 'mira.normalized_core_dry_run_report.v1',
      report_id: 'batch-2a-normalized-core-dry-run-v1',
    }));
    expect(report.proposal).toEqual(expect.objectContaining({
      batch_id: 'normalized-core-state-v1',
      status: 'dry_run_shape_only',
      requires_explicit_approval_before_normalizer_execution: true,
      requires_explicit_approval_before_import_apply: true,
    }));
    expect(report.mutation_flags).toEqual({
      normalized: false,
      copied: false,
      moved: false,
      deleted: false,
      status_mutated: false,
      queue_mutated: false,
      receipt_written: false,
      runtime_loaded: false,
    });
    expect(report.non_scope).toEqual(expect.arrayContaining([
      'raw_import',
      'apply_execution',
      'growth_events',
      'transcript_evidence',
      'telegram_route',
    ]));
  });

  test('dry-run report uses exact Oracle-approved record ids and normalized destinations', () => {
    const report = readJson(reportPath);

    expect(report.batch_records.map((record) => record.id)).toEqual([
      'mira_self_profile',
      'james_relationship_state',
      'relationship_presence_permissions',
    ]);
    expect(report.batch_records.every((record) => record.raw_copy_allowed === false)).toBe(true);
    expect(report.batch_records.map((record) => record.destination_relative_path)).toEqual([
      'continuity/core/mira-self-profile.normalized.json',
      'continuity/core/james-relationship-state.normalized.json',
      'permissions/core/relationship-presence-permissions.normalized.json',
    ]);
    expect(report.batch_records.every((record) => record.action === 'dry_run_shape_only')).toBe(true);
  });

  test('source files exist and schemas match the dry-run report', () => {
    const report = readJson(reportPath);

    for (const record of report.batch_records) {
      const source = readJson(path.join(repoRoot, record.source_path));
      expect(record.source_exists).toBe(true);
      expect(source.schema).toBe(record.source_schema);
      expect(source.artifact_id).toBeTruthy();
    }
  });

  test('semantics document keeps growth and events out of batch 2a', () => {
    const semantics = fs.readFileSync(semanticsPath, 'utf8');

    expect(semantics).toContain('Source of truth: Oracle #17.');
    expect(semantics).toContain('Growth/event history is not part of batch 2a');
    expect(semantics).toContain('later batch 2b only after explicit approval');
    expect(semantics).toContain('Do not copy raw source JSON wholesale.');
  });
});
