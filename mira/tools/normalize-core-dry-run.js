'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const defaultContractPath = path.join(repoRoot, 'mira', 'imports', 'normalizers', 'batch-2a-core-normalizer-contract-v0.json');
const defaultReportPath = path.join(repoRoot, 'mira', 'imports', 'reports', 'batch-2a-normalized-core-dry-run-v1.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
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
  const preview = buildNormalizedPreview();

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
  buildNormalizedPreview,
  formatNormalizedPreview,
  normalizePermissions,
  normalizeRelationshipState,
  normalizeSelfProfile,
};
