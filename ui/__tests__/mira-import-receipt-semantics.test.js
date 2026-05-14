'use strict';

const fs = require('fs');
const path = require('path');

describe('Mira import receipt design', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const schemaPath = path.join(repoRoot, 'mira', 'imports', 'import-receipt-schema-v0.json');
  const semanticsPath = path.join(repoRoot, 'mira', 'imports', 'import-receipt-semantics-v0.md');

  test('defines receipt evidence required after a future approved copy', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const semantics = fs.readFileSync(semanticsPath, 'utf8');

    expect(schema.$id).toBe('mira.import_receipt.v0');
    expect(schema.properties.schema.const).toBe('mira.import_receipt.v0');
    expect(schema.required).toEqual(expect.arrayContaining([
      'receipt_id',
      'batch_id',
      'report_id',
      'tool',
      'copied_at',
      'mutation_flags',
      'queue_status_before',
      'records',
    ]));
    expect(schema.properties.records.items.required).toEqual(expect.arrayContaining([
      'source_sha256',
      'destination_sha256',
      'destination_created',
      'queue_status_before',
    ]));
    expect(semantics).toContain('<MIRA_STATE_ROOT>/imports/receipts/<receipt_id>.json');
    expect(semantics).toContain('hash source before copy and destination after copy');
  });

  test('keeps receipt design separate from approval, apply, and queue mutation', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const semantics = fs.readFileSync(semanticsPath, 'utf8');

    expect(schema.properties.mutation_flags.properties.copied.const).toBe(true);
    expect(schema.properties.mutation_flags.properties.moved.const).toBe(false);
    expect(schema.properties.mutation_flags.properties.deleted.const).toBe(false);
    expect(schema.properties.mutation_flags.properties.queue_mutated.const).toBe(false);
    expect(schema.properties.mutation_flags.properties.report_mutated.const).toBe(false);
    expect(schema.properties.mutation_flags.properties.status_mutated.const).toBe(false);
    expect(schema.properties.queue_status_before.additionalProperties.const).toBe('not_imported');
    expect(semantics).toContain('Status: receipt design only.');
    expect(semantics).toContain('No apply/import execution.');
    expect(semantics).toContain('No approval marker.');
    expect(semantics).toContain('No queue status mutation.');
  });
});
