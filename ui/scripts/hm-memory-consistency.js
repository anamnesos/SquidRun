#!/usr/bin/env node

const path = require('path');
const {
  planMemoryConsistencyRepair,
  runMemoryConsistencyCheck,
  runMemoryConsistencyRepair,
} = require('../modules/memory-consistency-check');

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !String(next).startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node scripts/hm-memory-consistency.js [--json] [--repair | --dry-run] [--project-root <path>] [--workspace-dir <path>] [--db-path <path>] [--sample-limit <n>] [--evidence-ledger-db-path <path>]',
    '',
  ].join('\n'));
}

function renderBaseReport(result) {
  const lines = [
    `Memory consistency: ${result.status}`,
    `workspace: ${result.workspaceDir}`,
    `knowledge_dir: ${result.knowledgeDir}`,
    `cognitive_db: ${result.cognitiveDbPath}`,
    `knowledge_entries: ${result.summary.knowledgeEntryCount}`,
    `knowledge_nodes: ${result.summary.knowledgeNodeCount}`,
    `missing_in_cognitive: ${result.summary.missingInCognitiveCount}`,
    `orphaned_nodes: ${result.summary.orphanedNodeCount}`,
    `duplicate_hashes: ${result.summary.duplicateKnowledgeHashCount}`,
    `issues: ${result.summary.issueCount}`,
    `synced: ${result.synced ? 'yes' : 'no'}`,
  ];
  return lines;
}

function renderDriftSections(lines, result) {
  if (result.drift.issues.length > 0) {
    lines.push('', 'Issues:');
    for (const issue of result.drift.issues) {
      lines.push(`- ${issue.code}: ${issue.detail}`);
    }
  }

  if (result.drift.missingKnowledgeEntries.length > 0) {
    lines.push('', 'Missing Knowledge Entries:');
    for (const entry of result.drift.missingKnowledgeEntries) {
      lines.push(`- ${entry.sourcePath} :: ${entry.heading || '(no heading)'}`);
    }
  }

  if (result.drift.orphanedKnowledgeNodes.length > 0) {
    lines.push('', 'Orphaned Knowledge Nodes:');
    for (const node of result.drift.orphanedKnowledgeNodes) {
      lines.push(`- ${node.nodeId} :: ${node.sourcePath || '(no path)'} :: ${node.heading || '(no heading)'}`);
    }
  }

  if (result.drift.duplicateKnowledgeHashes.length > 0) {
    lines.push('', 'Duplicate Knowledge Hashes:');
    for (const entry of result.drift.duplicateKnowledgeHashes) {
      lines.push(`- ${entry.contentHash} :: count=${entry.count} :: nodes=${entry.nodeIds.join(', ')}`);
    }
  }

  return lines;
}

function renderRepairSections(lines, result) {
  lines.push(
    '',
    `repair_mode: ${result.mode}`,
    `planned_actions: ${result.summary.actionCount}`,
    `planned_inserts: ${result.summary.insertCount}`,
    `planned_duplicate_merges: ${result.summary.duplicateMergeCount}`,
    `planned_orphan_deletes: ${result.summary.orphanDeleteCount}`,
    `planned_total_deletes: ${result.summary.deleteCount}`,
    `planned_skips: ${result.summary.skippedCount}`
  );

  if (result.actions.length > 0) {
    lines.push('', 'Planned Actions:');
    for (const action of result.actions) {
      if (action.kind === 'insert_missing_chunk') {
        lines.push(`- INSERT ${action.entry.sourcePath} :: ${action.entry.heading || '(no heading)'}`);
        continue;
      }
      if (action.kind === 'collapse_duplicate_hash') {
        lines.push(`- MERGE ${action.contentHash} :: keep=${action.survivorNodeId} :: delete=${action.loserNodeIds.join(', ')}`);
        continue;
      }
      if (action.kind === 'delete_revision_skew_orphan') {
        lines.push(`- DELETE ${action.node.nodeId} :: ${action.node.sourcePath || '(no path)'} :: ${action.node.heading || '(no heading)'}`);
      }
    }
  }

  if (result.skipped.length > 0) {
    lines.push('', 'Skipped Items:');
    for (const entry of result.skipped) {
      lines.push(`- ${entry.nodeId || entry.kind} :: ${entry.reason}`);
    }
  }

  if (result.execution) {
    lines.push(
      '',
      `applied_actions: ${result.execution.appliedActions}`,
      `inserted_nodes: ${result.execution.insertedNodes}`,
      `deleted_nodes: ${result.execution.deletedNodes}`,
      `merged_duplicate_groups: ${result.execution.mergedDuplicateGroups}`,
      `audit_events_written: ${result.execution.auditEventsWritten}`
    );
    if (result.execution.failures.length > 0) {
      lines.push('', 'Execution Failures:');
      for (const failure of result.execution.failures) {
        lines.push(`- ${failure.action}: ${failure.reason}`);
      }
    }
  }

  if (result.postCheck) {
    lines.push('', `post_repair_status: ${result.postCheck.status}`);
    lines.push(`post_repair_synced: ${result.postCheck.synced ? 'yes' : 'no'}`);
    lines.push(`post_repair_missing: ${result.postCheck.summary.missingInCognitiveCount}`);
    lines.push(`post_repair_orphans: ${result.postCheck.summary.orphanedNodeCount}`);
    lines.push(`post_repair_duplicates: ${result.postCheck.summary.duplicateKnowledgeHashCount}`);
  }

  return lines;
}

function renderTextReport(result) {
  const base = result.detection || result;
  const lines = renderBaseReport(base);
  renderDriftSections(lines, base);
  if (result.mode === 'dry_run' || result.mode === 'repair') {
    renderRepairSections(lines, result);
  }
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  const { flags } = parseArgs(argv);
  if (flags.help) {
    printUsage();
    return 0;
  }

  const options = {
    projectRoot: flags['project-root'] ? path.resolve(String(flags['project-root'])) : undefined,
    workspaceDir: flags['workspace-dir'] ? path.resolve(String(flags['workspace-dir'])) : undefined,
    dbPath: flags['db-path'] ? path.resolve(String(flags['db-path'])) : undefined,
    sampleLimit: flags['sample-limit'],
    evidenceLedgerDbPath: flags['evidence-ledger-db-path']
      ? path.resolve(String(flags['evidence-ledger-db-path']))
      : undefined,
  };
  const result = flags['dry-run']
    ? planMemoryConsistencyRepair(options)
    : (flags.repair ? runMemoryConsistencyRepair(options) : runMemoryConsistencyCheck(options));

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderTextReport(result));
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  main,
  parseArgs,
  renderTextReport,
};
