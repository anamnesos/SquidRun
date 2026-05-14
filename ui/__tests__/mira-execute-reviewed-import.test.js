'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  buildDryRunExecutionPlan,
  parseArgs,
} = require('../../mira/tools/execute-reviewed-import');

describe('Mira reviewed import dry-run executor', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const reportPath = path.join('mira', 'imports', 'reports', 'first-batch-dry-run-v1.json');

  function writeApprovalMarker(dir, overrides = {}) {
    const marker = {
      schema: 'mira.import_approval_marker.v0',
      approval_id: 'test-approval',
      approved_at: '2026-05-13T00:00:00.000Z',
      approved_by: 'architect',
      batch_id: 'acceptance-permission-contracts-v1',
      report_id: 'first-batch-dry-run-v1',
      report_path: reportPath,
      approved_record_ids: [
        'presence_runtime_acceptance',
        'north_star_acceptance',
        'pc_embodiment_permission',
      ],
      approval_scope: 'copy_only',
      mutation_limits: {
        copy_allowed: true,
        move_allowed: false,
        delete_allowed: false,
        queue_mutation_allowed: false,
        report_mutation_allowed: false,
        runtime_load_allowed: false,
      },
      ...overrides,
    };
    const markerPath = path.join(dir, 'approval.json');
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    return markerPath;
  }

  test('requires an explicit report and refuses apply in v0', () => {
    expect(parseArgs(['--report', reportPath, '--approval', 'approval.json', '--json'])).toEqual({
      report: reportPath,
      approval: 'approval.json',
      json: true,
      apply: false,
    });
    expect(buildDryRunExecutionPlan({ env: { MIRA_STATE_ROOT: path.join(repoRoot, 'mira', '.state-dev-test') } })).toEqual(expect.objectContaining({
      ok: false,
      error: 'missing_report',
      applied: false,
    }));
    expect(buildDryRunExecutionPlan({
      reportPath,
      apply: true,
      env: { MIRA_STATE_ROOT: path.join(repoRoot, 'mira', '.state-dev-test') },
    })).toEqual(expect.objectContaining({
      ok: false,
      error: 'apply_not_supported_v0',
      applied: false,
      copied: false,
      queue_mutated: false,
    }));
  });

  test('refuses to plan an unapproved report', () => {
    expect(buildDryRunExecutionPlan({
      reportPath,
      env: { MIRA_STATE_ROOT: path.join(repoRoot, 'mira', '.state-dev-test') },
    })).toEqual(expect.objectContaining({
      ok: false,
      error: 'missing_approval',
      applied: false,
      copied: false,
      queue_mutated: false,
    }));
  });

  test('builds a dry-run would-copy plan without writing files or mutating queue', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-executor-dry-run-'));
    const approvalPath = writeApprovalMarker(fs.mkdtempSync(path.join(os.tmpdir(), 'mira-executor-approval-')));
    const queuePath = path.join(repoRoot, 'mira', 'imports', 'review-queue.json');
    const queueBefore = fs.readFileSync(queuePath, 'utf8');
    const plan = buildDryRunExecutionPlan({
      reportPath,
      approvalPath,
      env: { MIRA_STATE_ROOT: stateRoot },
    });
    const queueAfter = fs.readFileSync(queuePath, 'utf8');

    expect(plan).toEqual(expect.objectContaining({
      ok: true,
      schema: 'mira.reviewed_import_execution_plan.v1',
      report_id: 'first-batch-dry-run-v1',
      batch_id: 'acceptance-permission-contracts-v1',
      state_root: path.resolve(stateRoot),
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
    expect(plan.would_copy.every((record) => !fs.existsSync(record.destination_absolute_path))).toBe(true);
    expect(queueAfter).toBe(queueBefore);
    expect(fs.readdirSync(stateRoot)).toEqual([]);
  });

  test('fails before write when destination already exists or report mismatches queue', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-executor-fail-'));
    const report = JSON.parse(fs.readFileSync(path.join(repoRoot, reportPath), 'utf8'));
    const reportCopyPath = path.join(tempRoot, 'report.json');
    const approvalPath = writeApprovalMarker(tempRoot, {
      report_path: reportCopyPath,
    });

    const firstDestination = path.join(tempRoot, report.batch_records[0].destination_relative_path);
    fs.mkdirSync(path.dirname(firstDestination), { recursive: true });
    fs.writeFileSync(firstDestination, 'existing');
    fs.writeFileSync(reportCopyPath, JSON.stringify(report, null, 2));

    const existingDestinationPlan = buildDryRunExecutionPlan({
      reportPath: reportCopyPath,
      approvalPath,
      env: { MIRA_STATE_ROOT: tempRoot },
    });
    expect(existingDestinationPlan.ok).toBe(false);
    expect(existingDestinationPlan.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('destination already exists'),
    ]));

    report.batch_records[0].source_path = 'docs/not-the-queue-source.md';
    fs.writeFileSync(reportCopyPath, JSON.stringify(report, null, 2));
    const mismatchPlan = buildDryRunExecutionPlan({
      reportPath: reportCopyPath,
      approvalPath,
      env: { MIRA_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'mira-executor-mismatch-')) },
    });
    expect(mismatchPlan.ok).toBe(false);
    expect(mismatchPlan.errors).toEqual(expect.arrayContaining([
      'presence_runtime_acceptance: source path mismatch',
      expect.stringContaining('source missing on disk'),
    ]));
  });

  test('fails when approval marker does not match the report batch', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-executor-bad-approval-'));
    const approvalPath = writeApprovalMarker(stateRoot, {
      approved_record_ids: ['presence_runtime_acceptance'],
      mutation_limits: {
        copy_allowed: true,
        move_allowed: false,
        delete_allowed: false,
        queue_mutation_allowed: true,
        report_mutation_allowed: false,
        runtime_load_allowed: false,
      },
    });
    const plan = buildDryRunExecutionPlan({
      reportPath,
      approvalPath,
      env: { MIRA_STATE_ROOT: stateRoot },
    });

    expect(plan.ok).toBe(false);
    expect(plan.errors).toEqual(expect.arrayContaining([
      'approval record count must match report batch',
      'approval missing record id: north_star_acceptance',
      'approval missing record id: pc_embodiment_permission',
      'approval mutation limit queue_mutation_allowed must be false',
    ]));
  });

  test('cli emits JSON dry-run plan and writes nothing', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-executor-cli-'));
    const approvalPath = writeApprovalMarker(fs.mkdtempSync(path.join(os.tmpdir(), 'mira-executor-cli-approval-')));
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
