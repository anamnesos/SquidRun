'use strict';

const fs = require('fs');
const path = require('path');

describe('Mira runtime continuity-loader contract', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const contractPath = path.join(repoRoot, 'mira', 'runtime', 'continuity-loader-contract-v0.json');
  const semanticsPath = path.join(repoRoot, 'mira', 'runtime', 'continuity-loader-contract-v0.md');

  test('limits first loader design to imported acceptance documents only', () => {
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

    expect(contract).toEqual(expect.objectContaining({
      schema: 'mira.runtime_continuity_loader_contract.v0',
      status: 'design_only',
      allowed_scope: 'acceptance_docs_only',
      approved_batch_id: 'acceptance-permission-contracts-v1',
      required_receipt_schema: 'mira.import_receipt.v0',
      runtime_session_claim_allowed: false,
      continuity_loaded_claim_allowed: false,
    }));
    expect(contract.allowed_relative_paths).toEqual([
      'acceptance/mira-presence-runtime-acceptance-v0.md',
      'acceptance/mira-north-star-acceptance.md',
      'acceptance/mira-pc-embodiment-permission-v0.md',
    ]);
    expect(contract.allowed_relative_paths.every((entry) => entry.startsWith('acceptance/'))).toBe(true);
  });

  test('keeps mutation and broad memory reads outside the design scope', () => {
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

    expect(contract.mutation_limits).toEqual(expect.objectContaining({
      queue_mutation_allowed: false,
      report_mutation_allowed: false,
      receipt_mutation_allowed: false,
      state_write_allowed: false,
      squidrun_memory_read_allowed: false,
      transcript_read_allowed: false,
    }));
    expect(contract.non_scope).toEqual(expect.arrayContaining([
      'second_import_batch',
      'runtime_session_continuity_claim',
      'model_behavior_migration',
      'bridge_behavior',
      'telegram_route',
      'ui_surface',
    ]));
  });

  test('documents that runtime session continuity remains false until a later approved commit', () => {
    const semantics = fs.readFileSync(semanticsPath, 'utf8');

    expect(semantics).toContain('design contract only');
    expect(semantics).toContain('continuity_loaded');
    expect(semantics).toContain('must remain `false`');
    expect(semantics).toContain('No runtime `/session` continuity claim.');
  });
});
