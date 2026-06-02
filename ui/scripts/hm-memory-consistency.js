#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const {
  planGuardedOrphanDeletes,
  planMemoryConsistencyRepair,
  planOrphanMigration,
  runGuardedOrphanDeletes,
  runMemoryConsistencyCheck,
  runMemoryConsistencyRepair,
  runOrphanMigration,
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
    '  node scripts/hm-memory-consistency.js [--json] [--repair | --dry-run] [--repair-scope missing-only] [--allow-orphan-deletes] [--project-root <path>] [--workspace-dir <path>] [--db-path <path>] [--sample-limit <n>] [--evidence-ledger-db-path <path>]',
    '  node scripts/hm-memory-consistency.js [--json] --orphan-migration-review [--mapping-file <path>]',
    '  node scripts/hm-memory-consistency.js [--json] --migrate-orphans --mapping-file <path>',
    '  node scripts/hm-memory-consistency.js [--json] --guarded-delete-review --drop-file <path>',
    '  node scripts/hm-memory-consistency.js [--json] --guarded-delete-orphans --drop-file <path>',
    '',
  ].join('\n'));
}

function readMappingFile(filePath) {
  if (!filePath) return undefined;
  const resolved = path.resolve(String(filePath));
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) {
    return parsed.mappings || parsed;
  }
  return undefined;
}

function readDropFile(filePath) {
  if (!filePath) return undefined;
  const resolved = path.resolve(String(filePath));
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) {
    return parsed.targets || parsed.dropTargets || parsed.orphanDropTargets || parsed;
  }
  return undefined;
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
    `repair_scope: ${result.repairScope || 'all'}`,
    `planned_actions: ${result.summary.actionCount}`,
    `planned_inserts: ${result.summary.insertCount}`,
    `planned_resyncs: ${result.summary.resyncCount || 0}`,
    `planned_duplicate_merges: ${result.summary.duplicateMergeCount}`,
    `planned_source_heading_merges: ${result.summary.sourceHeadingMergeCount || 0}`,
    `planned_orphan_deletes: ${result.summary.orphanDeleteCount}`,
    `planned_total_deletes: ${result.summary.deleteCount}`,
    `planned_skips: ${result.summary.skippedCount}`
  );
  if (Number(result.summary.deferredActionCount || 0) > 0 || Number(result.summary.deferredSkippedCount || 0) > 0) {
    lines.push(`deferred_actions: ${Number(result.summary.deferredActionCount || 0)}`);
    lines.push(`deferred_skips: ${Number(result.summary.deferredSkippedCount || 0)}`);
  }

  if (result.actions.length > 0) {
    lines.push('', 'Planned Actions:');
    for (const action of result.actions) {
      if (action.kind === 'insert_missing_chunk') {
        lines.push(`- INSERT ${action.entry.sourcePath} :: ${action.entry.heading || '(no heading)'}`);
        continue;
      }
      if (action.kind === 'resync_source_heading') {
        lines.push(`- RESYNC ${action.entry.sourcePath} :: ${action.entry.heading || '(no heading)'} :: keep=${action.survivorNodeId} :: delete=${action.loserNodeIds.join(', ') || '-'}`);
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
      `resynced_nodes: ${result.execution.resyncedNodes || 0}`,
      `deleted_nodes: ${result.execution.deletedNodes}`,
      `merged_duplicate_groups: ${result.execution.mergedDuplicateGroups}`,
      `merged_source_heading_groups: ${result.execution.mergedSourceHeadingGroups || 0}`,
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

function renderOrphanMigrationReport(result) {
  const lines = [
    `Orphan migration: ${result.mode}`,
    `workspace: ${result.workspaceDir}`,
    `cognitive_db: ${result.cognitiveDbPath}`,
    `planned_migrations: ${result.summary.mappedMigrationCount}`,
    `skipped: ${result.summary.skippedCount}`,
    `deleted_source_review: ${result.summary.deletedSourceReviewCount}`,
    `ambiguous_targets: ${result.summary.ambiguousTargetCount}`,
    `no_target: ${result.summary.noTargetCount}`,
    `mapping_required: ${result.summary.mappingRequiredCount}`,
  ];

  if (result.actions.length > 0) {
    lines.push('', 'Planned Migrations:');
    for (const action of result.actions) {
      lines.push(`- MIGRATE ${action.oldNodeId} -> ${action.targetNodeId} :: ${action.sourcePath || '(no path)'}`);
    }
  }

  if (result.skipped.length > 0) {
    lines.push('', 'Review Items:');
    for (const entry of result.skipped) {
      lines.push(`- ${entry.kind} ${entry.nodeId} :: ${entry.reason}`);
    }
  }

  if (result.execution) {
    lines.push(
      '',
      `applied_migrations: ${result.execution.appliedActions}`,
      `deleted_nodes: ${result.execution.deletedNodes}`,
      `moved_edges: ${result.execution.movedEdges}`,
      `deduped_edges: ${result.execution.dedupedEdges}`,
      `moved_traces: ${result.execution.movedTraces}`,
      `deduped_traces: ${result.execution.dedupedTraces}`,
      `moved_leases: ${result.execution.movedLeases}`,
      `audit_events_written: ${result.execution.auditEventsWritten}`
    );
  }

  return `${lines.join('\n')}\n`;
}

function renderGuardedDeleteReport(result) {
  const lines = [
    `Guarded orphan delete: ${result.mode}`,
    `workspace: ${result.workspaceDir}`,
    `cognitive_db: ${result.cognitiveDbPath}`,
    `targets: ${Array.isArray(result.targets) ? result.targets.length : 0}`,
    `planned_deletes: ${result.summary.guardedDeleteCount}`,
    `planned_total_deletes: ${result.summary.deleteCount}`,
    `escalated: ${result.summary.escalatedCount}`,
    `missing_targets: ${result.summary.missingTargetCount}`,
    `skipped: ${result.summary.skippedCount}`,
  ];

  if (result.actions.length > 0) {
    lines.push('', 'Planned Deletes:');
    for (const action of result.actions) {
      lines.push(`- DELETE ${action.node.nodeId} :: ${action.node.sourcePath || '(no path)'} :: ${action.node.heading || '(no heading)'}`);
    }
  }

  if (result.skipped.length > 0) {
    lines.push('', 'Escalations / Skips:');
    for (const entry of result.skipped) {
      const nodePart = entry.nodeId ? `${entry.nodeId} :: ` : '';
      const blockerPart = Array.isArray(entry.blockers) && entry.blockers.length > 0
        ? ` :: blockers=${entry.blockers.join(', ')}`
        : '';
      lines.push(`- ${entry.kind} ${nodePart}${entry.sourcePath || '(no path)'} :: ${entry.heading || '(no heading)'} :: ${entry.reason}${blockerPart}`);
    }
  }

  if (result.execution) {
    lines.push(
      '',
      `applied_deletes: ${result.execution.appliedActions}`,
      `deleted_nodes: ${result.execution.deletedNodes}`,
      `deleted_edges: ${result.execution.deletedEdges}`,
      `deleted_traces: ${result.execution.deletedTraces}`,
      `deleted_leases: ${result.execution.deletedLeases}`,
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
    lines.push('', `post_delete_status: ${result.postCheck.status}`);
    lines.push(`post_delete_missing: ${result.postCheck.summary.missingInCognitiveCount}`);
    lines.push(`post_delete_orphans: ${result.postCheck.summary.orphanedNodeCount}`);
    lines.push(`post_delete_source_heading_duplicates: ${result.postCheck.summary.duplicateSourceHeadingCount || 0}`);
  }

  return `${lines.join('\n')}\n`;
}

function renderTextReport(result) {
  if (result.mode === 'guarded_delete' || result.mode === 'guarded_delete_review' || result.summary?.guardedDeleteCount != null) {
    return renderGuardedDeleteReport(result);
  }
  if (result.mode === 'migrate' || result.summary?.mappedMigrationCount != null) {
    return renderOrphanMigrationReport(result);
  }
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
    repairScope: flags['repair-scope'] || (flags['insert-missing-only'] ? 'missing-only' : undefined),
    allowOrphanDeletes: flags['allow-orphan-deletes'] === true,
    sessionId: flags['session-id'] ? String(flags['session-id']) : undefined,
    orphanMappings: flags['mapping-file'] ? readMappingFile(flags['mapping-file']) : undefined,
    orphanDropTargets: flags['drop-file'] ? readDropFile(flags['drop-file']) : undefined,
    evidenceLedgerDbPath: flags['evidence-ledger-db-path']
      ? path.resolve(String(flags['evidence-ledger-db-path']))
      : undefined,
  };
  const result = flags['guarded-delete-review']
    ? planGuardedOrphanDeletes(options)
    : (flags['guarded-delete-orphans']
      ? runGuardedOrphanDeletes({ ...options, dryRun: false })
      : (flags['orphan-migration-review']
    ? planOrphanMigration(options)
    : (flags['migrate-orphans']
      ? runOrphanMigration({ ...options, dryRun: false })
      : (flags['dry-run']
        ? planMemoryConsistencyRepair(options)
        : (flags.repair ? runMemoryConsistencyRepair(options) : runMemoryConsistencyCheck(options))))));

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
