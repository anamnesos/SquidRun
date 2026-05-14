'use strict';

const fs = require('fs');
const path = require('path');
const { resolveStateRoot } = require('./resolve-state-root');
const { relativeDestinationInsideRoot } = require('./plan-reviewed-imports');

const repoRoot = path.resolve(__dirname, '..', '..');
const defaultQueuePath = path.join(repoRoot, 'mira', 'imports', 'review-queue.json');

function parseArgs(argv) {
  const args = {
    report: null,
    approval: null,
    json: false,
    apply: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--report') {
      args.report = argv[index + 1] || null;
      index += 1;
    } else if (arg === '--approval') {
      args.approval = argv[index + 1] || null;
      index += 1;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--apply') {
      args.apply = true;
    }
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadQueueById(queuePath = defaultQueuePath) {
  const queue = readJson(queuePath);
  const records = new Map();

  for (const record of queue.records || []) {
    records.set(record.id, record);
  }

  return records;
}

function validateApprovalMarker(approval, report, reportPath) {
  const errors = [];
  const reportRecordIds = (report.batch_records || []).map((record) => record.id);
  const approvedRecordIds = approval.approved_record_ids || [];
  const mutationLimits = approval.mutation_limits || {};

  if (approval.schema !== 'mira.import_approval_marker.v0') {
    errors.push('approval schema must be mira.import_approval_marker.v0');
  }

  if (approval.report_id !== report.report_id) {
    errors.push('approval report_id must match report');
  }

  if (approval.batch_id !== report.proposal?.batch_id) {
    errors.push('approval batch_id must match report batch');
  }

  if (path.normalize(approval.report_path || '') !== path.normalize(reportPath || '')) {
    errors.push('approval report_path must match --report path');
  }

  if (approval.approval_scope !== 'copy_only') {
    errors.push('approval_scope must be copy_only');
  }

  if (approvedRecordIds.length !== reportRecordIds.length) {
    errors.push('approval record count must match report batch');
  }

  for (const id of reportRecordIds) {
    if (!approvedRecordIds.includes(id)) {
      errors.push(`approval missing record id: ${id}`);
    }
  }

  const requiredLimits = {
    copy_allowed: true,
    move_allowed: false,
    delete_allowed: false,
    queue_mutation_allowed: false,
    report_mutation_allowed: false,
    runtime_load_allowed: false,
  };
  for (const [key, expected] of Object.entries(requiredLimits)) {
    if (mutationLimits[key] !== expected) {
      errors.push(`approval mutation limit ${key} must be ${expected}`);
    }
  }

  return errors;
}

function buildDryRunExecutionPlan(options = {}) {
  const env = options.env || process.env;
  const reportPath = options.reportPath;
  const approvalPath = options.approvalPath;
  const queuePath = options.queuePath || defaultQueuePath;
  const errors = [];

  if (options.apply) {
    return {
      ok: false,
      error: 'apply_not_supported_v0',
      applied: false,
      copied: false,
      moved: false,
      deleted: false,
      queue_mutated: false,
      status_mutated: false,
      would_copy: [],
      errors: ['--apply is not supported by the v0 dry-run executor.'],
    };
  }

  if (!reportPath) {
    return {
      ok: false,
      error: 'missing_report',
      applied: false,
      copied: false,
      moved: false,
      deleted: false,
      queue_mutated: false,
      status_mutated: false,
      would_copy: [],
      errors: ['--report is required.'],
    };
  }

  if (!approvalPath) {
    return {
      ok: false,
      error: 'missing_approval',
      applied: false,
      copied: false,
      moved: false,
      deleted: false,
      queue_mutated: false,
      status_mutated: false,
      would_copy: [],
      errors: ['--approval is required before an import execution plan can be emitted.'],
    };
  }

  const rootResult = resolveStateRoot(env);
  if (!rootResult.ok) {
    return {
      ok: false,
      error: 'invalid_state_root',
      applied: false,
      copied: false,
      moved: false,
      deleted: false,
      queue_mutated: false,
      status_mutated: false,
      would_copy: [],
      errors: [rootResult.error],
    };
  }

  const resolvedReportPath = path.resolve(repoRoot, reportPath);
  const resolvedApprovalPath = path.resolve(repoRoot, approvalPath);
  const report = readJson(resolvedReportPath);
  const approval = readJson(resolvedApprovalPath);
  const queueById = loadQueueById(queuePath);
  const flags = report.mutation_flags || {};

  if (report.schema !== 'mira.import_batch_dry_run_report.v1') {
    errors.push('report schema must be mira.import_batch_dry_run_report.v1');
  }

  if (report.proposal?.status !== 'review_only') {
    errors.push('report proposal status must remain review_only for v0 dry-run');
  }

  if (report.proposal?.requires_explicit_approval_before_import !== true) {
    errors.push('report must require explicit approval before import');
  }

  for (const [name, value] of Object.entries(flags)) {
    if (value !== false) {
      errors.push(`report mutation flag must be false: ${name}`);
    }
  }

  errors.push(...validateApprovalMarker(approval, report, reportPath));

  const wouldCopy = [];
  for (const record of report.batch_records || []) {
    const queueRecord = queueById.get(record.id);
    if (!queueRecord) {
      errors.push(`${record.id}: missing from review queue`);
      continue;
    }

    if (queueRecord.source_path !== record.source_path) {
      errors.push(`${record.id}: source path mismatch`);
    }

    if (queueRecord.destination !== record.destination_relative_path) {
      errors.push(`${record.id}: destination path mismatch`);
    }

    if (queueRecord.status !== 'not_imported' || record.current_queue_status !== 'not_imported') {
      errors.push(`${record.id}: queue status must be not_imported`);
    }

    const sourceAbsolutePath = path.join(repoRoot, record.source_path || '');
    if (!fs.existsSync(sourceAbsolutePath)) {
      errors.push(`${record.id}: source missing on disk: ${record.source_path}`);
    }

    const destination = relativeDestinationInsideRoot(rootResult.path, record.destination_relative_path || '');
    if (!destination.ok || record.destination_under_state_root !== true) {
      errors.push(`${record.id}: destination escapes MIRA_STATE_ROOT`);
    }

    if (destination.ok && fs.existsSync(destination.path)) {
      errors.push(`${record.id}: destination already exists: ${destination.path}`);
    }

    wouldCopy.push({
      id: record.id,
      source_path: record.source_path,
      source_absolute_path: sourceAbsolutePath,
      destination_relative_path: record.destination_relative_path,
      destination_absolute_path: destination.path,
      action: 'would_copy',
    });
  }

  return {
    ok: errors.length === 0,
    schema: 'mira.reviewed_import_execution_plan.v1',
    report_id: report.report_id || null,
    batch_id: report.proposal?.batch_id || null,
    state_root: rootResult.path,
    applied: false,
    copied: false,
    moved: false,
    deleted: false,
    queue_mutated: false,
    status_mutated: false,
    errors,
    would_copy: wouldCopy,
  };
}

function formatExecutionPlan(plan) {
  if (!plan.ok) {
    return `Mira reviewed import dry-run failed:\n${plan.errors.join('\n')}`;
  }

  return [
    `Mira reviewed import executor dry-run (${plan.would_copy.length} records)`,
    `batch_id=${plan.batch_id}`,
    `state_root=${plan.state_root}`,
    'applied=false copied=false moved=false deleted=false queue_mutated=false status_mutated=false',
  ].join('\n');
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildDryRunExecutionPlan({
    reportPath: args.report,
    approvalPath: args.approval,
    apply: args.apply,
  });

  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(formatExecutionPlan(plan));
  }

  if (!plan.ok) {
    process.exit(1);
  }
}

module.exports = {
  buildDryRunExecutionPlan,
  formatExecutionPlan,
  parseArgs,
  validateApprovalMarker,
};
