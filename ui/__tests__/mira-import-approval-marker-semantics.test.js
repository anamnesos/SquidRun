'use strict';

const fs = require('fs');
const path = require('path');

describe('Mira import approval marker design', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const schemaPath = path.join(repoRoot, 'mira', 'imports', 'import-approval-marker-schema-v0.json');
  const semanticsPath = path.join(repoRoot, 'mira', 'imports', 'import-approval-marker-semantics-v0.md');

  test('defines a copy-only approval marker schema', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    expect(schema.$id).toBe('mira.import_approval_marker.v0');
    expect(schema.properties.schema.const).toBe('mira.import_approval_marker.v0');
    expect(schema.required).toEqual(expect.arrayContaining([
      'approval_id',
      'approved_at',
      'approved_by',
      'batch_id',
      'report_id',
      'report_path',
      'approved_record_ids',
      'approval_scope',
      'mutation_limits',
    ]));
    expect(schema.properties.approval_scope.const).toBe('copy_only');
    expect(schema.properties.mutation_limits.properties.copy_allowed.const).toBe(true);
    expect(schema.properties.mutation_limits.properties.move_allowed.const).toBe(false);
    expect(schema.properties.mutation_limits.properties.delete_allowed.const).toBe(false);
    expect(schema.properties.mutation_limits.properties.queue_mutation_allowed.const).toBe(false);
    expect(schema.properties.mutation_limits.properties.runtime_load_allowed.const).toBe(false);
  });

  test('keeps approval marker design separate from actual approval or import', () => {
    const semantics = fs.readFileSync(semanticsPath, 'utf8');

    expect(semantics).toContain('Status: approval marker design only.');
    expect(semantics).toContain('No marker instance, apply code, copy');
    expect(semantics).toContain('mira/imports/approvals/<approval_id>.json');
    expect(semantics).toContain('not inferred from memory, recall, chat, runtime');
    expect(semantics).toContain('This document does not create that marker.');
    expect(semantics).toContain('No apply/import execution.');
    expect(semantics).toContain('No runtime auto-load of imported continuity.');
  });

  test('names the expected first batch without approving it', () => {
    const semantics = fs.readFileSync(semanticsPath, 'utf8');

    expect(semantics).toContain('first-batch-dry-run-v1');
    expect(semantics).toContain('acceptance-permission-contracts-v1');
    expect(semantics).toContain('presence_runtime_acceptance');
    expect(semantics).toContain('north_star_acceptance');
    expect(semantics).toContain('pc_embodiment_permission');
  });
});
