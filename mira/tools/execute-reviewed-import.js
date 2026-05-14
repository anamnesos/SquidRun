'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { resolveStateRoot } = require('./resolve-state-root');
const { relativeDestinationInsideRoot } = require('./plan-reviewed-imports');

const repoRoot = path.resolve(__dirname, '..', '..');
const defaultQueuePath = path.join(repoRoot, 'mira', 'imports', 'review-queue.json');
const toolVersion = '0.1.0';

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

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest('hex')}`;
}

function buildExecutionPlan(options = {}) {
  const env = options.env || process.env;
  const reportPath = options.reportPath;
  const approvalPath = options.approvalPath;
  const queuePath = options.queuePath || defaultQueuePath;
  const errors = [];

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
    approval_id: approval.approval_id || null,
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

function buildDryRunExecutionPlan(options = {}) {
  return buildExecutionPlan({ ...options, apply: false });
}

function buildReceiptId(batchId, date = new Date()) {
  const stamp = date.toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
  return `${batchId}-${stamp}`;
}

function applyReviewedImport(options = {}) {
  const plan = buildExecutionPlan(options);
  if (!plan.ok) {
    return {
      ...plan,
      applied: false,
      copied: false,
      receipt_path: null,
      receipt: null,
    };
  }

  const copiedRecords = [];
  const queueStatusBefore = {};
  const receiptId = options.receiptId || buildReceiptId(plan.batch_id);
  const receiptsDir = path.join(plan.state_root, 'imports', 'receipts');
  const receiptPath = path.join(receiptsDir, `${receiptId}.json`);

  if (fs.existsSync(receiptPath)) {
    return {
      ...plan,
      ok: false,
      applied: false,
      copied: false,
      receipt_path: receiptPath,
      receipt: null,
      errors: [`receipt already exists: ${receiptPath}`],
    };
  }

  try {
    for (const record of plan.would_copy) {
      fs.mkdirSync(path.dirname(record.destination_absolute_path), { recursive: true });
      fs.copyFileSync(record.source_absolute_path, record.destination_absolute_path, fs.constants.COPYFILE_EXCL);
      const sourceHash = sha256File(record.source_absolute_path);
      const destinationHash = sha256File(record.destination_absolute_path);

      if (sourceHash !== destinationHash) {
        throw new Error(`${record.id}: destination hash does not match source hash`);
      }

      queueStatusBefore[record.id] = 'not_imported';
      copiedRecords.push({
        id: record.id,
        source_path: record.source_path,
        source_sha256: sourceHash,
        destination_relative_path: record.destination_relative_path,
        destination_sha256: destinationHash,
        destination_created: true,
        queue_status_before: 'not_imported',
      });
    }

    const receipt = {
      schema: 'mira.import_receipt.v0',
      receipt_id: receiptId,
      batch_id: plan.batch_id,
      report_id: plan.report_id,
      tool: {
        name: 'execute-reviewed-import',
        version: toolVersion,
      },
      copied_at: (options.now || new Date()).toISOString(),
      mutation_flags: {
        copied: true,
        moved: false,
        deleted: false,
        queue_mutated: false,
        report_mutated: false,
        status_mutated: false,
      },
      queue_status_before: queueStatusBefore,
      records: copiedRecords,
    };

    fs.mkdirSync(receiptsDir, { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });

    return {
      ...plan,
      applied: true,
      copied: true,
      moved: false,
      deleted: false,
      queue_mutated: false,
      status_mutated: false,
      receipt_path: receiptPath,
      receipt,
    };
  } catch (error) {
    return {
      ...plan,
      ok: false,
      applied: false,
      copied: copiedRecords.length > 0,
      receipt_path: receiptPath,
      receipt: null,
      errors: [error.message],
    };
  }
}

function formatExecutionPlan(plan) {
  if (!plan.ok) {
    return `Mira reviewed import ${plan.applied ? 'apply' : 'dry-run'} failed:\n${plan.errors.join('\n')}`;
  }

  if (plan.applied) {
    return [
      `Mira reviewed import apply (${plan.receipt?.records?.length || 0} records)`,
      `batch_id=${plan.batch_id}`,
      `receipt=${plan.receipt_path}`,
      'applied=true copied=true moved=false deleted=false queue_mutated=false status_mutated=false',
    ].join('\n');
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
  const plan = args.apply ? applyReviewedImport({
    reportPath: args.report,
    approvalPath: args.approval,
  }) : buildDryRunExecutionPlan({
    reportPath: args.report,
    approvalPath: args.approval,
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
  applyReviewedImport,
  buildExecutionPlan,
  buildDryRunExecutionPlan,
  buildReceiptId,
  formatExecutionPlan,
  parseArgs,
  sha256File,
  validateApprovalMarker,
};
