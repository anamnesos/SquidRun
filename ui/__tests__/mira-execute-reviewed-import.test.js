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

  test('requires an explicit report and refuses apply in v0', () => {
    expect(parseArgs(['--report', reportPath, '--json'])).toEqual({
      report: reportPath,
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

  test('builds a dry-run would-copy plan without writing files or mutating queue', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-executor-dry-run-'));
    const queuePath = path.join(repoRoot, 'mira', 'imports', 'review-queue.json');
    const queueBefore = fs.readFileSync(queuePath, 'utf8');
    const plan = buildDryRunExecutionPlan({
      reportPath,
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

    const firstDestination = path.join(tempRoot, report.batch_records[0].destination_relative_path);
    fs.mkdirSync(path.dirname(firstDestination), { recursive: true });
    fs.writeFileSync(firstDestination, 'existing');
    fs.writeFileSync(reportCopyPath, JSON.stringify(report, null, 2));

    const existingDestinationPlan = buildDryRunExecutionPlan({
      reportPath: reportCopyPath,
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
      env: { MIRA_STATE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'mira-executor-mismatch-')) },
    });
    expect(mismatchPlan.ok).toBe(false);
    expect(mismatchPlan.errors).toEqual(expect.arrayContaining([
      'presence_runtime_acceptance: source path mismatch',
      expect.stringContaining('source missing on disk'),
    ]));
  });

  test('cli emits JSON dry-run plan and writes nothing', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-executor-cli-'));
    const output = execFileSync(process.execPath, [
      path.join(repoRoot, 'mira', 'tools', 'execute-reviewed-import.js'),
      '--report',
      reportPath,
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
