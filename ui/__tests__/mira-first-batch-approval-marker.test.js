'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildDryRunExecutionPlan } = require('../../mira/tools/execute-reviewed-import');

describe('Mira first batch approval marker', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const reportPath = 'mira/imports/reports/first-batch-dry-run-v1.json';
  const approvalPath = path.join('mira', 'imports', 'approvals', 'first-batch-approval-v1.json');
  const approvalFullPath = path.join(repoRoot, approvalPath);

  test('approves only the reviewed first batch records with copy-only limits', () => {
    const approval = JSON.parse(fs.readFileSync(approvalFullPath, 'utf8'));

    expect(approval).toEqual(expect.objectContaining({
      schema: 'mira.import_approval_marker.v0',
      approval_id: 'first-batch-approval-v1',
      approved_by: 'architect',
      batch_id: 'acceptance-permission-contracts-v1',
      report_id: 'first-batch-dry-run-v1',
      report_path: reportPath,
      approval_scope: 'copy_only',
    }));
    expect(approval.approved_record_ids).toEqual([
      'presence_runtime_acceptance',
      'north_star_acceptance',
      'pc_embodiment_permission',
    ]);
    expect(approval.mutation_limits).toEqual({
      copy_allowed: true,
      move_allowed: false,
      delete_allowed: false,
      queue_mutation_allowed: false,
      report_mutation_allowed: false,
      runtime_load_allowed: false,
    });
  });

  test('lets the dry-run executor plan the approved batch without writing files', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-approved-dry-run-'));
    const plan = buildDryRunExecutionPlan({
      reportPath,
      approvalPath,
      env: { MIRA_STATE_ROOT: stateRoot },
    });

    expect(plan).toEqual(expect.objectContaining({
      ok: true,
      report_id: 'first-batch-dry-run-v1',
      batch_id: 'acceptance-permission-contracts-v1',
      applied: false,
      copied: false,
      moved: false,
      deleted: false,
      queue_mutated: false,
      status_mutated: false,
    }));
    expect(plan.would_copy.map((record) => record.id)).toEqual([
      'presence_runtime_acceptance',
      'north_star_acceptance',
      'pc_embodiment_permission',
    ]);
    expect(fs.readdirSync(stateRoot)).toEqual([]);
  });

  test('cli accepts the approval marker for dry-run only', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-approved-cli-'));
    const output = execFileSync(process.execPath, [
      path.join(repoRoot, 'mira', 'tools', 'execute-reviewed-import.js'),
      '--report',
      reportPath,
      '--approval',
      approvalPath,
      '--json',
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIRA_STATE_ROOT: stateRoot,
      },
      encoding: 'utf8',
    });
    const plan = JSON.parse(output);

    expect(plan.ok).toBe(true);
    expect(plan.applied).toBe(false);
    expect(plan.would_copy).toHaveLength(3);
    expect(fs.readdirSync(stateRoot)).toEqual([]);
  });
});
