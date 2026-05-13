'use strict';

const fs = require('fs');
const path = require('path');
const { resolveStateRoot } = require('./resolve-state-root');
const { validateImportQueue } = require('./validate-import-queue');

const repoRoot = path.resolve(__dirname, '..', '..');
const defaultQueuePath = path.join(repoRoot, 'mira', 'imports', 'review-queue.json');
const defaultContractPath = path.join(repoRoot, 'mira', 'state', 'state-root-contract.json');

function relativeDestinationInsideRoot(stateRoot, destination) {
  const resolvedRoot = path.resolve(stateRoot);
  const resolvedDestination = path.resolve(resolvedRoot, destination);
  const relative = path.relative(resolvedRoot, resolvedDestination);

  return {
    ok: Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative),
    path: resolvedDestination,
    relative,
  };
}

function buildReviewedImportPlan(options = {}) {
  const env = options.env || process.env;
  const queuePath = options.queuePath || defaultQueuePath;
  const contractPath = options.contractPath || defaultContractPath;
  const rootResult = resolveStateRoot(env);

  if (!rootResult.ok) {
    return {
      ok: false,
      error: rootResult.error,
      copied: false,
      moved: false,
      deleted: false,
      records: [],
    };
  }

  const queueValidation = validateImportQueue({ queuePath, contractPath });
  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const errors = [...queueValidation.errors];
  const records = queue.records.map((record) => {
    const sourceAbsolutePath = path.join(repoRoot, record.source_path);
    const sourceExists = fs.existsSync(sourceAbsolutePath);
    const destination = relativeDestinationInsideRoot(rootResult.path, record.destination);

    if (!destination.ok) {
      errors.push(`${record.id}: destination escapes MIRA_STATE_ROOT: ${record.destination}`);
    }

    return {
      id: record.id,
      status: record.status,
      source_path: record.source_path,
      source_exists: sourceExists,
      source_kind: record.source_kind,
      destination_relative_path: record.destination,
      destination_absolute_path: destination.path,
      destination_within_state_root: destination.ok,
      action: 'plan_only',
      selection_policy: record.selection_policy,
      notes: record.notes,
    };
  });

  return {
    ok: errors.length === 0,
    schema: 'mira.reviewed_import_plan.v1',
    state_root: rootResult.path,
    copied: false,
    moved: false,
    deleted: false,
    mutated_queue_status: false,
    errors,
    records,
  };
}

function formatPlanSummary(plan) {
  if (!plan.ok) {
    return `Mira reviewed import dry-run failed:\n${plan.errors.join('\n')}`;
  }

  return [
    `Mira reviewed import dry-run (${plan.records.length} records)`,
    `state_root=${plan.state_root}`,
    'copied=false moved=false deleted=false mutated_queue_status=false',
  ].join('\n');
}

if (require.main === module) {
  const json = process.argv.includes('--json');
  const plan = buildReviewedImportPlan();

  if (json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(formatPlanSummary(plan));
  }

  if (!plan.ok) {
    process.exit(1);
  }
}

module.exports = {
  buildReviewedImportPlan,
  formatPlanSummary,
  relativeDestinationInsideRoot,
};
