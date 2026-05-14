'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildNormalizedPreview } = require('../../mira/tools/normalize-core-dry-run');

describe('Mira normalized core import contract', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const contractPath = path.join(repoRoot, 'mira', 'imports', 'normalizers', 'batch-2a-core-normalizer-contract-v0.json');
  const reportPath = path.join(repoRoot, 'mira', 'imports', 'reports', 'batch-2a-normalized-core-dry-run-v1.json');
  const approvalPath = path.join(repoRoot, 'mira', 'imports', 'approvals', 'batch-2a-normalized-core-approval-v1.json');
  const approvalSchemaPath = path.join(repoRoot, 'mira', 'imports', 'normalizers', 'normalized-core-approval-marker-schema-v0.json');
  const applySemanticsPath = path.join(repoRoot, 'mira', 'imports', 'normalizers', 'normalized-core-apply-semantics-v0.md');
  const normalizedReceiptSchemaPath = path.join(repoRoot, 'mira', 'imports', 'normalizers', 'normalized-core-receipt-schema-v0.json');
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
      approval_marker_path: 'mira/imports/approvals/batch-2a-normalized-core-approval-v1.json',
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
      'blanket_runtime_write_permission',
      'live_session_window_device_continuity',
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

  test('preserves Oracle permission caveat without granting blanket runtime writes', () => {
    const contract = readJson(contractPath);
    const report = readJson(reportPath);
    const permissionsRecord = report.batch_records.find((record) => record.id === 'relationship_presence_permissions');

    expect(contract.permission_caveats).toEqual(expect.objectContaining({
      local_store_write_allowed_now: 'scoped_only_to_reviewed_import_and_mira_state_root_writes_after_explicit_approval',
      blanket_mira_runtime_write_permission: false,
      runtime_autonomous_write_permission: false,
    }));
    expect(permissionsRecord.permission_caveat).toContain('reviewed import/state-root writes');
    expect(permissionsRecord.permission_caveat).toContain('not blanket Mira runtime write permission');
  });

  test('treats stale SquidRun session window and device fields as metadata-only', () => {
    const contract = readJson(contractPath);
    const report = readJson(reportPath);
    const staleFields = [
      'scope.sessionId',
      'scope.windowKey',
      'scope.deviceId',
      'session',
      'window',
      'device',
    ];

    expect(contract.metadata_only_source_fields).toEqual(staleFields);
    expect(contract.live_continuity_excluded_source_fields).toEqual(expect.arrayContaining(staleFields));

    for (const record of report.batch_records) {
      expect(record.metadata_only_source_fields).toEqual(staleFields);
      expect(record.live_continuity_excluded_fields).toEqual(expect.arrayContaining(staleFields));
    }
  });

  test('semantics document keeps growth and events out of batch 2a', () => {
    const semantics = fs.readFileSync(semanticsPath, 'utf8');

    expect(semantics).toContain('Source of truth: Oracle #17.');
    expect(semantics).toContain('Growth/event history is not part of batch 2a');
    expect(semantics).toContain('later batch 2b only after explicit approval');
    expect(semantics).toContain('Do not copy raw source JSON wholesale.');
    expect(semantics).toContain('session`, `window`, and `device` fields as source');
    expect(semantics).toContain('not blanket Mira runtime write permission');
  });

  test('normalizer dry-run emits normalized previews without state writes or runtime load', () => {
    const preview = buildNormalizedPreview();

    expect(preview).toEqual(expect.objectContaining({
      ok: true,
      schema: 'mira.normalized_core_dry_run_execution.v1',
      batch_id: 'normalized-core-state-v1',
      normalized: false,
      copied: false,
      state_written: false,
      receipt_written: false,
      runtime_loaded: false,
      raw_imported: false,
    }));
    expect(preview.previews.map((record) => record.id)).toEqual([
      'mira_self_profile',
      'james_relationship_state',
      'relationship_presence_permissions',
    ]);
    expect(preview.excluded_records.map((record) => record.id)).toEqual([
      'relationship_growth_history',
      'relationship_growth_audit',
    ]);
  });

  test('normalizer preview excludes growth events and stale live continuity fields', () => {
    const preview = buildNormalizedPreview();
    const selfProfile = preview.previews.find((record) => record.id === 'mira_self_profile').normalized_preview;
    const relationship = preview.previews.find((record) => record.id === 'james_relationship_state').normalized_preview;
    const permissions = preview.previews.find((record) => record.id === 'relationship_presence_permissions').normalized_preview;

    expect(selfProfile).not.toHaveProperty('growth_events');
    expect(relationship).not.toHaveProperty('growth_events');
    expect(relationship).not.toHaveProperty('current_focus');
    expect(relationship).not.toHaveProperty('history');
    expect(relationship).not.toHaveProperty('history_summary');
    expect(selfProfile).not.toHaveProperty('session');
    expect(selfProfile).not.toHaveProperty('window');
    expect(selfProfile).not.toHaveProperty('device');
    expect(relationship).not.toHaveProperty('session');
    expect(permissions).not.toHaveProperty('session');
    expect(selfProfile.source_metadata).toEqual(expect.objectContaining({
      stale_session: 'app-session-329',
      stale_window: 'main',
      stale_device: 'VIGIL',
      metadata_only: true,
      live_continuity_excluded: true,
    }));
  });

  test('normalizer demotes stale relationship focus out of live continuity', () => {
    const preview = buildNormalizedPreview();
    const relationship = preview.previews.find((record) => record.id === 'james_relationship_state').normalized_preview;

    expect(relationship).not.toHaveProperty('current_focus');
    expect(relationship.source_focus_summary).toEqual(expect.objectContaining({
      value: 'durable relationship context for human-range developing non-mirror presence',
      generated_at: '2026-05-07T19:00:00.000Z',
      updated_at: '2026-05-08T07:42:52.553Z',
      metadata_only: true,
      live_continuity_excluded: true,
    }));
  });

  test('normalizer preview preserves permission caveat for local store writes', () => {
    const preview = buildNormalizedPreview();
    const permissions = preview.previews.find((record) => record.id === 'relationship_presence_permissions').normalized_preview;

    expect(permissions.permissions.local_store_write_allowed_now).toBe(true);
    expect(permissions.caveats).toEqual(expect.objectContaining({
      local_store_write_allowed_now: 'scoped_only_to_reviewed_import_and_mira_state_root_writes_after_explicit_approval',
      blanket_mira_runtime_write_permission: false,
      runtime_autonomous_write_permission: false,
    }));
  });

  test('normalizer cli emits JSON dry-run report without writing state root', () => {
    const stateRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mira-normalizer-no-write-'));
    const output = execFileSync(process.execPath, [
      path.join(repoRoot, 'mira', 'tools', 'normalize-core-dry-run.js'),
      '--json',
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIRA_STATE_ROOT: stateRoot,
      },
      encoding: 'utf8',
    });
    const preview = JSON.parse(output);

    expect(preview.ok).toBe(true);
    expect(preview.previews).toHaveLength(3);
    expect(preview.state_written).toBe(false);
    expect(fs.readdirSync(stateRoot)).toEqual([]);
  });

  test('approval marker authorizes only normalized preview and apply design for batch 2a', () => {
    const approval = readJson(approvalPath);
    const approvalSchema = readJson(approvalSchemaPath);
    const report = readJson(reportPath);
    const contract = readJson(contractPath);

    expect(approvalSchema.$id).toBe('mira.normalized_core_approval_marker.v0');
    expect(approval).toEqual(expect.objectContaining({
      schema: 'mira.normalized_core_approval_marker.v0',
      approval_id: 'batch-2a-normalized-core-approval-v1',
      approved_by: 'architect',
      batch_id: report.proposal.batch_id,
      report_id: report.report_id,
      report_path: 'mira/imports/reports/batch-2a-normalized-core-dry-run-v1.json',
      contract_path: 'mira/imports/normalizers/batch-2a-core-normalizer-contract-v0.json',
      approval_scope: 'normalized_preview_and_apply_design_only',
    }));
    expect(approval.approved_record_ids).toEqual(contract.approved_record_ids);
    expect(approval.approved_record_ids).toEqual(report.batch_records.map((record) => record.id));
  });

  test('approval marker preserves Oracle caveats and blocks state mutation', () => {
    const approval = readJson(approvalPath);

    expect(approval.caveats_preserved).toEqual({
      local_store_write_allowed_now_scoped: true,
      stale_session_window_device_metadata_only: true,
      current_focus_demoted_to_source_focus_summary: true,
      growth_events_excluded: true,
    });
    expect(approval.mutation_limits).toEqual({
      normalizer_execution_allowed: true,
      apply_design_allowed: true,
      state_write_allowed: false,
      receipt_write_allowed: false,
      queue_mutation_allowed: false,
      report_mutation_allowed: false,
      runtime_load_allowed: false,
      raw_import_allowed: false,
    });
  });

  test('normalized apply semantics are design-only and block state writes in this commit', () => {
    const semantics = fs.readFileSync(applySemanticsPath, 'utf8');

    expect(semantics).toContain('Status: design contract only.');
    expect(semantics).toContain('No normalized apply implementation');
    expect(semantics).toContain('No state write.');
    expect(semantics).toContain('No receipt write.');
    expect(semantics).toContain('No runtime continuity load.');
    expect(semantics).toContain('write only normalized JSON outputs, never raw source JSON');
  });

  test('normalized receipt schema preserves batch 2a caveats and mutation limits', () => {
    const schema = readJson(normalizedReceiptSchemaPath);

    expect(schema.$id).toBe('mira.normalized_core_receipt.v0');
    expect(schema.properties.batch_id.const).toBe('normalized-core-state-v1');
    expect(schema.properties.report_id.const).toBe('batch-2a-normalized-core-dry-run-v1');
    expect(schema.properties.approval_id.const).toBe('batch-2a-normalized-core-approval-v1');
    expect(schema.properties.mutation_flags.properties).toEqual(expect.objectContaining({
      normalized: { const: true },
      copied: { const: false },
      queue_mutated: { const: false },
      report_mutated: { const: false },
      approval_mutated: { const: false },
      runtime_loaded: { const: false },
      raw_imported: { const: false },
    }));
    expect(schema.properties.caveats_preserved.properties).toEqual(expect.objectContaining({
      local_store_write_allowed_now_scoped: { const: true },
      stale_session_window_device_metadata_only: { const: true },
      current_focus_demoted_to_source_focus_summary: { const: true },
      growth_events_excluded: { const: true },
    }));
  });

  test('normalized receipt schema constrains each record id to exact destination and output schema', () => {
    const schema = readJson(normalizedReceiptSchemaPath);
    const recordDefs = schema.$defs;

    expect(schema.properties.records.items.oneOf).toEqual([
      { $ref: '#/$defs/mira_self_profile_receipt_record' },
      { $ref: '#/$defs/james_relationship_state_receipt_record' },
      { $ref: '#/$defs/relationship_presence_permissions_receipt_record' },
    ]);
    expect(recordDefs.base_receipt_record.required).toEqual(expect.arrayContaining([
      'preview_normalized_sha256',
      'destination_sha256',
    ]));
    expect(recordDefs.mira_self_profile_receipt_record.allOf[1].properties).toEqual(expect.objectContaining({
      id: { const: 'mira_self_profile' },
      destination_relative_path: { const: 'continuity/core/mira-self-profile.normalized.json' },
      output_schema: { const: 'mira.normalized.self_profile.v1' },
    }));
    expect(recordDefs.james_relationship_state_receipt_record.allOf[1].properties).toEqual(expect.objectContaining({
      id: { const: 'james_relationship_state' },
      destination_relative_path: { const: 'continuity/core/james-relationship-state.normalized.json' },
      output_schema: { const: 'mira.normalized.james_relationship_state.v1' },
    }));
    expect(recordDefs.relationship_presence_permissions_receipt_record.allOf[1].properties).toEqual(expect.objectContaining({
      id: { const: 'relationship_presence_permissions' },
      destination_relative_path: { const: 'permissions/core/relationship-presence-permissions.normalized.json' },
      output_schema: { const: 'mira.normalized.relationship_presence_permissions.v1' },
    }));
  });

  test('normalized receipt schema rejects hash-shaped records with arbitrary destination or schema', () => {
    const schema = readJson(normalizedReceiptSchemaPath);
    const defs = schema.$defs;
    const validHash = `sha256:${'a'.repeat(64)}`;
    const baseRecord = {
      id: 'mira_self_profile',
      source_path: 'workspace/knowledge/mira-self-profile.json',
      source_sha256: validHash,
      preview_normalized_sha256: validHash,
      destination_relative_path: 'continuity/core/mira-self-profile.normalized.json',
      destination_sha256: validHash,
      output_schema: 'mira.normalized.self_profile.v1',
      destination_created: true,
    };

    function matchesRecordDef(record, defName) {
      const exact = defs[defName].allOf[1].properties;
      return Object.entries(exact).every(([key, rule]) => record[key] === rule.const);
    }

    expect(matchesRecordDef(baseRecord, 'mira_self_profile_receipt_record')).toBe(true);
    expect(matchesRecordDef({
      ...baseRecord,
      destination_relative_path: 'continuity/core/arbitrary-but-hash-shaped.normalized.json',
    }, 'mira_self_profile_receipt_record')).toBe(false);
    expect(matchesRecordDef({
      ...baseRecord,
      output_schema: 'mira.normalized.arbitrary.v1',
    }, 'mira_self_profile_receipt_record')).toBe(false);
    expect(matchesRecordDef({
      ...baseRecord,
      id: 'james_relationship_state',
    }, 'mira_self_profile_receipt_record')).toBe(false);
  });
});
