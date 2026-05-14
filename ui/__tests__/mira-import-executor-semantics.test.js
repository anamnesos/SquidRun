'use strict';

const fs = require('fs');
const path = require('path');

describe('Mira import executor semantics contract', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const contractPath = path.join(repoRoot, 'mira', 'imports', 'import-executor-semantics-v0.md');
  const reportPath = path.join(repoRoot, 'mira', 'imports', 'reports', 'first-batch-dry-run-v1.json');

  test('keeps v0 contract-only and dry-run first', () => {
    const contract = fs.readFileSync(contractPath, 'utf8');

    expect(contract).toContain('Status: contract only. No executor code exists in this milestone.');
    expect(contract).toContain('V0 is dry-run first.');
    expect(contract).toContain('`--apply` is not available');
    expect(contract).toContain('Default execution must emit a plan only');
    expect(contract).toContain('Dry-run must create no directories, copy no files, write no receipts');
  });

  test('requires report-gated batch verification before any future write', () => {
    const contract = fs.readFileSync(contractPath, 'utf8');

    expect(contract).toContain('It must read exactly one report path supplied by `--report`.');
    expect(contract).toContain('It must consider only records listed in that report.');
    expect(contract).toContain('It must not scan or import the full review queue.');
    expect(contract).toContain('queue status is `not_imported`;');
    expect(contract).toContain('destination resolves under `MIRA_STATE_ROOT`;');
    expect(contract).toContain('Any mismatch fails the whole batch before any write.');
  });

  test('does not let current first-batch report act as import approval', () => {
    const contract = fs.readFileSync(contractPath, 'utf8');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

    expect(report.proposal).toEqual(expect.objectContaining({
      status: 'review_only',
      requires_explicit_approval_before_import: true,
    }));
    expect(report.mutation_flags).toEqual({
      copied: false,
      moved: false,
      deleted: false,
      status_mutated: false,
      queue_mutated: false,
    });
    expect(contract).toContain('the only allowed behavior is dry-run planning');
  });

  test('keeps apply semantics and queue mutation in later lanes', () => {
    const contract = fs.readFileSync(contractPath, 'utf8');

    expect(contract).toContain('Apply mode is non-scope for this contract.');
    expect(contract).toContain('copy selected files with exclusive-create/no-overwrite semantics');
    expect(contract).toContain('keep queue status mutation as a separate reviewed lane');
    expect(contract).toContain('do not cause runtime to auto-load imported continuity');
    expect(contract).toContain('No bridge, UI, or Telegram route work.');
  });
});
