'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveStateRoot } = require('./resolve-state-root');
const { relativeDestinationInsideRoot } = require('./plan-reviewed-imports');

const repoRoot = path.resolve(__dirname, '..', '..');
const defaultContractPath = path.join(repoRoot, 'mira', 'imports', 'normalizers', 'batch-2a-core-normalizer-contract-v0.json');
const defaultReportPath = path.join(repoRoot, 'mira', 'imports', 'reports', 'batch-2a-normalized-core-dry-run-v1.json');
const defaultApprovalPath = path.join(repoRoot, 'mira', 'imports', 'approvals', 'batch-2a-normalized-core-approval-v1.json');
const toolVersion = '0.1.0';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function buildReceiptId(batchId, date = new Date()) {
  const stamp = date.toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
  return `${batchId}-${stamp}`;
}

function sourceMetadata(source) {
  return {
    profile: source.profile || source.scope?.profile || null,
    source_scope: source.source_scope || source.scope?.source_scope || null,
    stale_session: source.session || source.scope?.sessionId || null,
    stale_window: source.window || source.scope?.windowKey || null,
    stale_device: source.device || source.scope?.deviceId || null,
    metadata_only: true,
    live_continuity_excluded: true,
  };
}

function provenanceFor(source) {
  return {
    schema: source.schema || null,
    artifact_id: source.artifact_id || null,
    seed_id: source.seed_id || null,
    seeded_at: source.seeded_at || null,
    generated_at: source.generated_at || null,
    updated_at: source.updated_at || null,
    source_label: source.source_label || source.provenance?.source_label || null,
    raw_content_included: source.provenance?.raw_content_included ?? null,
    redacted_summary_only: source.provenance?.redacted_summary_only ?? null,
    evidenceRefs: source.evidenceRefs || source.provenance?.evidenceRefs || [],
  };
}

function normalizeSelfProfile(source) {
  return {
    schema: 'mira.normalized.self_profile.v1',
    artifact_id: 'mira_self_profile',
    name: source.name || null,
    profile_kind: source.profile_kind || null,
    role: source.role || null,
    data_not_theater: source.data_not_theater === true,
    model_runtime_active: source.model_runtime_active === true,
    persona_runtime_active: source.persona_runtime_active === true,
    claims: {
      actual_consciousness: source.claims_actual_consciousness === true,
      actual_suffering: source.claims_actual_suffering === true,
      actual_fear: source.claims_actual_fear === true,
      actual_love_as_internal_fact: source.claims_actual_love_as_internal_fact === true,
    },
    expressive_range_allowed: Array.isArray(source.expressive_range_allowed)
      ? [...source.expressive_range_allowed]
      : [],
    boundary_note: source.boundary_note || null,
    provenance: provenanceFor(source),
    source_metadata: sourceMetadata(source),
  };
}

function normalizeRelationshipState(source) {
  return {
    schema: 'mira.normalized.james_relationship_state.v1',
    artifact_id: 'james_relationship_state',
    user_name: source.user_name || null,
    relationship_mode: source.relationship_mode || null,
    source_focus_summary: source.current_focus ? {
      value: source.current_focus,
      generated_at: source.generated_at || null,
      updated_at: source.updated_at || null,
      metadata_only: true,
      live_continuity_excluded: true,
    } : null,
    what_mira_knows_about_james: source.what_mira_knows_about_james || null,
    preferences: Array.isArray(source.preferences) ? [...source.preferences] : [],
    trust: source.trust || null,
    repair: source.repair || null,
    boundaries: source.boundaries || null,
    promises: source.promises || null,
    confidence: typeof source.confidence === 'number' ? source.confidence : null,
    raw_content_present: source.raw_content_present === true,
    provenance: provenanceFor(source),
    source_metadata: sourceMetadata(source),
  };
}

function normalizePermissions(source) {
  return {
    schema: 'mira.normalized.relationship_presence_permissions.v1',
    artifact_id: 'relationship_presence_permissions',
    machine_checkable: source.machine_checkable === true,
    permissions: {
      read_local_redacted_context: source.read_local_redacted_context === true,
      propose_next_action: source.propose_next_action === true,
      local_store_write_allowed_now: source.local_store_write_allowed_now === true,
      send_external: source.send_external === true,
      network: source.network === true,
      customer_action: source.customer_action === true,
      trade: source.trade === true,
      deploy: source.deploy === true,
      database_write: source.database_write === true,
      memory_sync_write: source.memory_sync_write === true,
      file_output_write: source.file_output_write === true,
      runtime_start: source.runtime_start === true,
      server_listener_routes: source.server_listener_routes === true,
      live_kill_switch_check: source.live_kill_switch_check === true,
      kill_switch_wiring: source.kill_switch_wiring === true,
      next_action_executed: source.next_action_executed === true,
      fail_closed: source.fail_closed === true,
    },
    caveats: {
      local_store_write_allowed_now: 'scoped_only_to_reviewed_import_and_mira_state_root_writes_after_explicit_approval',
      blanket_mira_runtime_write_permission: false,
      runtime_autonomous_write_permission: false,
    },
    provenance: provenanceFor(source),
    source_metadata: sourceMetadata(source),
  };
}

const normalizers = {
  mira_self_profile: normalizeSelfProfile,
  james_relationship_state: normalizeRelationshipState,
  relationship_presence_permissions: normalizePermissions,
};

function buildNormalizedPreview(options = {}) {
  const contractPath = options.contractPath || defaultContractPath;
  const reportPath = options.reportPath || defaultReportPath;
  const contract = readJson(contractPath);
  const report = readJson(reportPath);
  const errors = [];
  const previews = [];

  if (contract.schema !== 'mira.normalizer_contract.v0') {
    errors.push('contract schema must be mira.normalizer_contract.v0');
  }
  if (report.schema !== 'mira.normalized_core_dry_run_report.v1') {
    errors.push('report schema must be mira.normalized_core_dry_run_report.v1');
  }
  if (contract.batch_id !== report.proposal?.batch_id) {
    errors.push('contract batch_id must match report proposal batch_id');
  }

  for (const record of report.batch_records || []) {
    const normalizer = normalizers[record.id];
    const outputContract = (contract.outputs || []).find((candidate) => candidate.id === record.id);

    if (!normalizer || !outputContract) {
      errors.push(`${record.id}: missing normalizer contract`);
      continue;
    }

    if (record.raw_copy_allowed !== false) {
      errors.push(`${record.id}: raw_copy_allowed must be false`);
    }

    const sourcePath = path.resolve(repoRoot, record.source_path || '');
    if (!fs.existsSync(sourcePath)) {
      errors.push(`${record.id}: source missing: ${record.source_path}`);
      continue;
    }

    const sourceText = fs.readFileSync(sourcePath, 'utf8');
    const source = JSON.parse(sourceText);
    if (source.schema !== record.source_schema || source.schema !== outputContract.source_schema) {
      errors.push(`${record.id}: source schema mismatch`);
    }

    const normalized = normalizer(source);
    const normalizedText = JSON.stringify(normalized, null, 2);
    previews.push({
      id: record.id,
      action: 'would_normalize',
      source_path: record.source_path,
      source_sha256: sha256Text(sourceText),
      destination_relative_path: record.destination_relative_path,
      output_schema: record.output_schema,
      normalized_sha256: sha256Text(`${normalizedText}\n`),
      normalized_preview: normalized,
      excluded_from_live_continuity: record.live_continuity_excluded_fields || [],
      metadata_only_source_fields: record.metadata_only_source_fields || [],
    });
  }

  return {
    ok: errors.length === 0,
    schema: 'mira.normalized_core_dry_run_execution.v1',
    report_id: report.report_id || null,
    batch_id: report.proposal?.batch_id || null,
    normalized: false,
    copied: false,
    moved: false,
    deleted: false,
    queue_mutated: false,
    report_mutated: false,
    receipt_written: false,
    runtime_loaded: false,
    state_written: false,
    raw_imported: false,
    errors,
    previews,
    excluded_records: report.excluded_records || [],
  };
}

function validateApprovalMarker(approval, preview, report, contract) {
  const errors = [];
  const approvedIds = approval.approved_record_ids || [];
  const previewIds = preview.previews.map((record) => record.id);

  if (approval.schema !== 'mira.normalized_core_approval_marker.v0') {
    errors.push('approval schema must be mira.normalized_core_approval_marker.v0');
  }
  if (approval.batch_id !== preview.batch_id || approval.batch_id !== contract.batch_id) {
    errors.push('approval batch_id must match preview and contract');
  }
  if (approval.report_id !== preview.report_id || approval.report_id !== report.report_id) {
    errors.push('approval report_id must match dry-run report');
  }
  if (approval.contract_path !== 'mira/imports/normalizers/batch-2a-core-normalizer-contract-v0.json') {
    errors.push('approval contract_path must match batch 2a contract');
  }
  if (approval.approval_scope !== 'normalized_preview_and_apply_design_only') {
    errors.push('approval_scope must remain normalized_preview_and_apply_design_only');
  }
  if (approvedIds.length !== previewIds.length || !previewIds.every((id) => approvedIds.includes(id))) {
    errors.push('approval record ids must exactly match normalized preview ids');
  }

  const caveats = approval.caveats_preserved || {};
  const requiredCaveats = {
    local_store_write_allowed_now_scoped: true,
    stale_session_window_device_metadata_only: true,
    current_focus_demoted_to_source_focus_summary: true,
    growth_events_excluded: true,
  };
  for (const [key, expected] of Object.entries(requiredCaveats)) {
    if (caveats[key] !== expected) {
      errors.push(`approval caveat ${key} must be ${expected}`);
    }
  }

  const limits = approval.mutation_limits || {};
  const requiredLimits = {
    normalizer_execution_allowed: true,
    apply_design_allowed: true,
    state_write_allowed: false,
    receipt_write_allowed: false,
    queue_mutation_allowed: false,
    report_mutation_allowed: false,
    runtime_load_allowed: false,
    raw_import_allowed: false,
  };
  for (const [key, expected] of Object.entries(requiredLimits)) {
    if (limits[key] !== expected) {
      errors.push(`approval mutation limit ${key} must be ${expected}`);
    }
  }

  return errors;
}

function buildNormalizedApplyPlan(options = {}) {
  const env = options.env || process.env;
  const contractPath = options.contractPath || defaultContractPath;
  const reportPath = options.reportPath || defaultReportPath;
  const approvalPath = options.approvalPath || defaultApprovalPath;
  const preview = buildNormalizedPreview({ contractPath, reportPath });
  const contract = readJson(contractPath);
  const report = readJson(reportPath);
  const approval = readJson(approvalPath);
  const rootResult = resolveStateRoot(env);
  const errors = [...preview.errors, ...validateApprovalMarker(approval, preview, report, contract)];
  const wouldWrite = [];

  if (!rootResult.ok) {
    errors.push(rootResult.error);
  }

  if (preview.previews.length !== 3) {
    errors.push('normalized apply requires exactly three preview records');
  }

  if (rootResult.ok) {
    const receiptId = options.receiptId || buildReceiptId(preview.batch_id, options.now || new Date());
    const receiptPath = path.join(rootResult.path, 'imports', 'receipts', `${receiptId}.json`);
    if (fs.existsSync(receiptPath)) {
      errors.push(`receipt already exists: ${receiptPath}`);
    }

    for (const record of preview.previews) {
      const destination = relativeDestinationInsideRoot(rootResult.path, record.destination_relative_path);
      if (!destination.ok) {
        errors.push(`${record.id}: destination escapes MIRA_STATE_ROOT`);
        continue;
      }
      if (fs.existsSync(destination.path)) {
        errors.push(`${record.id}: destination already exists: ${destination.path}`);
      }

      wouldWrite.push({
        id: record.id,
        source_path: record.source_path,
        source_sha256: record.source_sha256,
        preview_normalized_sha256: record.normalized_sha256,
        destination_relative_path: record.destination_relative_path,
        destination_absolute_path: destination.path,
        output_schema: record.output_schema,
        normalized_preview: record.normalized_preview,
      });
    }
  }

  return {
    ok: errors.length === 0,
    schema: 'mira.normalized_core_apply_plan.v1',
    report_id: preview.report_id,
    batch_id: preview.batch_id,
    approval_id: approval.approval_id || null,
    contract_id: contract.contract_id || null,
    state_root: rootResult.ok ? rootResult.path : null,
    applied: false,
    normalized: false,
    state_written: false,
    receipt_written: false,
    queue_mutated: false,
    report_mutated: false,
    approval_mutated: false,
    runtime_loaded: false,
    raw_imported: false,
    errors,
    would_write: wouldWrite,
  };
}

function applyNormalizedCore(options = {}) {
  const plan = buildNormalizedApplyPlan(options);
  if (!plan.ok) {
    return {
      ...plan,
      applied: false,
      receipt_path: null,
      receipt: null,
    };
  }

  const receiptId = options.receiptId || buildReceiptId(plan.batch_id, options.now || new Date());
  const receiptPath = path.join(plan.state_root, 'imports', 'receipts', `${receiptId}.json`);
  const records = [];

  try {
    for (const record of plan.would_write) {
      const normalizedText = `${JSON.stringify(record.normalized_preview, null, 2)}\n`;
      const previewHash = sha256Text(normalizedText);
      if (previewHash !== record.preview_normalized_sha256) {
        throw new Error(`${record.id}: preview_normalized_sha256 mismatch before write`);
      }

      fs.mkdirSync(path.dirname(record.destination_absolute_path), { recursive: true });
      fs.writeFileSync(record.destination_absolute_path, normalizedText, { flag: 'wx' });
      const destinationText = fs.readFileSync(record.destination_absolute_path, 'utf8');
      const destinationHash = sha256Text(destinationText);
      if (destinationHash !== record.preview_normalized_sha256) {
        throw new Error(`${record.id}: destination hash does not match preview normalized hash`);
      }

      records.push({
        id: record.id,
        source_path: record.source_path,
        source_sha256: record.source_sha256,
        preview_normalized_sha256: record.preview_normalized_sha256,
        destination_relative_path: record.destination_relative_path,
        destination_sha256: destinationHash,
        output_schema: record.output_schema,
        destination_created: true,
      });
    }

    const approval = readJson(options.approvalPath || defaultApprovalPath);
    const receipt = {
      schema: 'mira.normalized_core_receipt.v0',
      receipt_id: receiptId,
      batch_id: plan.batch_id,
      report_id: plan.report_id,
      approval_id: plan.approval_id,
      contract_id: plan.contract_id,
      tool: {
        name: 'normalize-core-dry-run',
        version: toolVersion,
      },
      normalized_at: (options.now || new Date()).toISOString(),
      mutation_flags: {
        normalized: true,
        copied: false,
        moved: false,
        deleted: false,
        queue_mutated: false,
        report_mutated: false,
        approval_mutated: false,
        runtime_loaded: false,
        raw_imported: false,
      },
      caveats_preserved: approval.caveats_preserved,
      records,
    };

    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });

    return {
      ...plan,
      applied: true,
      normalized: true,
      state_written: true,
      receipt_written: true,
      receipt_path: receiptPath,
      receipt,
    };
  } catch (error) {
    return {
      ...plan,
      ok: false,
      applied: false,
      normalized: records.length > 0,
      state_written: records.length > 0,
      receipt_written: false,
      receipt_path: receiptPath,
      receipt: null,
      errors: [error.message],
    };
  }
}

function formatNormalizedPreview(preview) {
  if (!preview.ok) {
    return `Mira normalized core dry-run failed:\n${preview.errors.join('\n')}`;
  }

  return [
    `Mira normalized core dry-run (${preview.previews.length} records)`,
    `batch_id=${preview.batch_id}`,
    'normalized=false copied=false state_written=false receipt_written=false runtime_loaded=false',
  ].join('\n');
}

if (require.main === module) {
  const json = process.argv.includes('--json');
  const apply = process.argv.includes('--apply');
  const preview = apply ? applyNormalizedCore() : buildNormalizedPreview();

  if (json) {
    console.log(JSON.stringify(preview, null, 2));
  } else {
    console.log(formatNormalizedPreview(preview));
  }

  if (!preview.ok) {
    process.exit(1);
  }
}

module.exports = {
  applyNormalizedCore,
  buildNormalizedApplyPlan,
  buildNormalizedPreview,
  buildReceiptId,
  formatNormalizedPreview,
  normalizePermissions,
  normalizeRelationshipState,
  normalizeSelfProfile,
};
