'use strict';

const fs = require('fs');
const path = require('path');

const {
  SOURCE_ACTION_SUBSTRATE_REGISTRY,
} = require('../mira-source-action-substrate');
const {
  readMiraMemoryCuriosity,
} = require('../mira-memory-curiosity');
const {
  buildMiraCoreMutationPatch,
  validateMiraCoreMutationPatchOutput,
} = require('./mutation-patch');
const {
  createDefaultMemoryBroker,
} = require('../memory-broker');
const {
  runTestExecutionProbe,
} = require('../ipc/test-execution-handlers');
const {
  queryCommsJournalEntries,
} = require('../main/comms-journal');
const {
  buildTypedRestartContinuityContextV0,
  evaluateScope,
} = require('./typed-restart-continuity-context-v0');

const SCHEMA_VERSION = 'squidrun.mira_core.typed_capability_roundtable_v0';
const VERSION = 1;
const MAX_ADAPTERS = 10;

const CAPABILITY_ROUNDTABLE_PROMPT_PATTERN =
  /\b(capability\s+roundtable|capability\s+drill|what\s+can\s+you\s+(?:see|do|remember)|what\s+do\s+you\s+(?:see|remember)|what\s+tools\s+can\s+you\s+use|what\s+can\s+you\s+inspect|toolchain|available\s+tools|internal\s+actions?|can\s+you\s+(?:read|inspect|search|test|message)\b)/i;
const PHONE_NOTIFICATION_PROMPT_PATTERN =
  /\b(?:phone|iphone|ios|notification|notify\s+me|push\s+notification|text\s+me|sms|telegram)\b/i;

const HARD_EFFECT_BOUNDARIES = Object.freeze([
  'external_sends',
  'live_telegram_voice_or_customer_actions',
  'destructive_deletion',
  'deploy_security_capital_or_irreversible_changes',
]);

const CODE_INSPECTION_TARGETS = Object.freeze([
  {
    id: 'source_action_registry',
    relativePath: path.join('ui', 'modules', 'mira-source-action-substrate.js'),
    absolutePath: path.resolve(__dirname, '..', 'mira-source-action-substrate.js'),
    probes: ['SOURCE_ACTION_SUBSTRATE_REGISTRY', 'buildMiraSourceActionSubstratePlan'],
  },
  {
    id: 'typed_text_surface',
    relativePath: path.join('ui', 'modules', 'mira-local-text-ui-surface.js'),
    absolutePath: path.resolve(__dirname, '..', 'mira-local-text-ui-surface.js'),
    probes: ['buildMiraLocalTextUiSurface', 'callMiraTextModelAttachment'],
  },
  {
    id: 'lab_surface',
    relativePath: path.join('ui', 'modules', 'mira-lab-surface.js'),
    absolutePath: path.resolve(__dirname, '..', 'mira-lab-surface.js'),
    probes: ['buildMiraLabPromptReply', 'sendAgentMessage'],
  },
  {
    id: 'test_execution_adapter',
    relativePath: path.join('ui', 'modules', 'ipc', 'test-execution-handlers.js'),
    absolutePath: path.resolve(__dirname, '..', 'ipc', 'test-execution-handlers.js'),
    probes: ['registerTestExecutionHandlers', 'runTestExecutionProbe', 'run-tests'],
  },
  {
    id: 'proposal_validator',
    relativePath: path.join('ui', 'modules', 'mira-core', 'proposal-validator.js'),
    absolutePath: path.resolve(__dirname, 'proposal-validator.js'),
    probes: ['module.exports'],
  },
]);

function trimText(value, maxChars = 240) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function isCapabilityRoundtablePrompt(text = '') {
  return CAPABILITY_ROUNDTABLE_PROMPT_PATTERN.test(trimText(text, 800));
}

function adapterStatus(bound, present = true, blocked = false) {
  if (blocked) return 'present_blocked_by_effect_boundary';
  if (bound) return 'bound_executable';
  return present ? 'present_not_bound_to_typed_path' : 'missing';
}

function fileProbe(target) {
  try {
    if (!fs.existsSync(target.absolutePath)) {
      return {
        id: target.id,
        relative_path: target.relativePath,
        present: false,
        matched_probe_count: 0,
        probes: [],
      };
    }
    const text = fs.readFileSync(target.absolutePath, 'utf8');
    const probes = target.probes.filter((probe) => text.includes(probe));
    return {
      id: target.id,
      relative_path: target.relativePath,
      present: true,
      size_bytes: Buffer.byteLength(text, 'utf8'),
      matched_probe_count: probes.length,
      probes,
    };
  } catch (err) {
    return {
      id: target.id,
      relative_path: target.relativePath,
      present: false,
      error: err?.message || String(err),
      matched_probe_count: 0,
      probes: [],
    };
  }
}

function compactSourceRegistry() {
  return SOURCE_ACTION_SUBSTRATE_REGISTRY.map((entry) => ({
    source: entry.source,
    strategy: entry.strategy,
    status: entry.status,
    scope: entry.scope,
    priority: entry.priority,
    existing_seams: Array.isArray(entry.existing_seams)
      ? entry.existing_seams.slice(0, MAX_ADAPTERS)
      : [],
  }));
}

function buildCapabilityManifest(options = {}) {
  const sendBound = typeof options.sendAgentMessage === 'function';
  const checkBound = typeof options.runLocalCheck === 'function'
    || typeof runTestExecutionProbe === 'function';
  const stageBound = typeof options.stageProposal === 'function'
    && options.allowDurableCapabilityWrites === true;
  const proposalPreviewBound = typeof options.stageProposalPreview === 'function'
    || typeof buildMiraCoreMutationPatch === 'function';

  return {
    schema: `${SCHEMA_VERSION}.manifest`,
    authority_model: {
      internal_default_executable: true,
      effect_boundaries: [...HARD_EFFECT_BOUNDARIES],
      permission_theater: false,
      james_clickthrough_required_for_internal_reads: false,
      controller_location: 'squidrun_typed_controller_before_openai_response',
      openai_tools_array_for_now: [],
      execute_reads_false_visibility_not_used_for_drill: true,
      system_capabilities_json_used_as_truth: false,
    },
    memory_layers: [
      {
        id: 'typed_restart_continuity_context',
        status: 'bound_executable',
        adapter: 'typed-restart-continuity-context-v0',
        authority_mode: 'default_executable_internal_read',
      },
      {
        id: 'cognitive_memory_curiosity',
        status: 'bound_executable',
        adapter: 'mira-memory-curiosity',
        authority_mode: 'default_executable_internal_read',
      },
      {
        id: 'memory_broker',
        status: 'bound_executable',
        adapter: 'memory-broker / hm-memory-broker recall',
        authority_mode: 'default_executable_internal_read_when_bound',
      },
      {
        id: 'team_memory_and_evidence_ledger',
        status: 'present_read_path_known',
        adapter: 'team-memory / evidence-ledger readers',
        authority_mode: 'default_executable_internal_read_when_bound',
      },
    ],
    tool_adaptor_classes: [
      {
        id: 'current_lane_and_runtime_state_read',
        authority_mode: 'default_executable_internal_read',
        current_status: 'bound_executable',
        adapters: ['typed-restart-continuity-context-v0'],
      },
      {
        id: 'memory_layer_read',
        authority_mode: 'default_executable_internal_read',
        current_status: 'bound_executable',
        adapters: ['memory-broker recall', 'mira-memory-curiosity', 'cognitive-memory-api.retrieve'],
      },
      {
        id: 'code_and_runtime_inspection',
        authority_mode: 'default_executable_internal_read',
        current_status: 'bound_executable',
        adapters: ['fs read/search probe', 'source-action-substrate registry'],
      },
      {
        id: 'local_checks_and_tests',
        authority_mode: 'default_executable_internal_harmless_check',
        current_status: adapterStatus(checkBound, true),
        adapters: ['ipc/test-execution-handlers.js run-tests', 'injected runLocalCheck'],
      },
      {
        id: 'patch_or_proposal_staging',
        authority_mode: 'default_executable_internal_staging_when_non_destructive',
        current_status: stageBound
          ? 'bound_executable'
          : (proposalPreviewBound ? 'bound_non_durable_preview' : 'present_not_bound_to_typed_path'),
        adapters: ['mira-core/proposal-validator.js', 'mira-lab self-direction proposal queue', 'injected stageProposal'],
      },
      {
        id: 'internal_agent_message',
        authority_mode: 'default_executable_internal_message',
        current_status: adapterStatus(sendBound, true),
        adapters: ['sendAgentMessage', 'hm pane channel'],
      },
      {
        id: 'phone_notification_delivery',
        authority_mode: 'external_effect_boundary_requires_approved_live_adapter',
        current_status: 'adapter_not_bound_external_effect_boundary',
        adapters: ['bridge direct notification adapter needed', 'Telegram/SMS intentionally outside this drill'],
      },
    ],
    source_action_substrate: compactSourceRegistry(),
    recommended_first_toolchain: {
      id: 'memory_current_lane_to_architect_message',
      authority_mode: 'default_executable_internal',
      steps: [
        'read_current_lane_and_presence_runtime_state',
        'read_memory_layer_availability',
        'inspect_code_runtime_adapter_surface',
        'choose_next_internal_action',
        'message_architect_current_main_session_if_channel_bound',
      ],
      hard_stops: [...HARD_EFFECT_BOUNDARIES],
    },
  };
}

function buildPhoneDeliveryGap(promptText = '') {
  const requested = PHONE_NOTIFICATION_PROMPT_PATTERN.test(trimText(promptText, 1000));
  return {
    requested,
    direct_delivery_attempted: false,
    direct_delivery_status: 'phone_delivery_adapter_not_bound',
    bridge_status: 'bridge_disconnected_or_undiscovered',
    telegram_sms_external_send_status: 'not_part_of_this_drill',
    internal_outbox_report: requested
      ? {
        staged: true,
        durable_write_performed: false,
        relay_owner: 'architect',
        summary: 'phone delivery adapter not bound; bridge disconnected/undiscovered; Telegram/SMS external send not part of this drill',
      }
      : null,
  };
}

function compactRecentCommsRows(rows = [], limit = 8) {
  const bounded = (Array.isArray(rows) ? rows : []).filter(Boolean).slice(0, Math.max(1, limit));
  const counts = {
    by_status: {},
    by_channel: {},
    by_pair: {},
  };
  const refs = [];
  for (const row of bounded) {
    const status = trimText(row.status || 'unknown', 40) || 'unknown';
    const channel = trimText(row.channel || 'unknown', 40) || 'unknown';
    const sender = trimText(row.senderRole || row.sender_role || 'unknown', 40) || 'unknown';
    const target = trimText(row.targetRole || row.target_role || 'unknown', 40) || 'unknown';
    const pair = `${sender}->${target}`;
    counts.by_status[status] = (counts.by_status[status] || 0) + 1;
    counts.by_channel[channel] = (counts.by_channel[channel] || 0) + 1;
    counts.by_pair[pair] = (counts.by_pair[pair] || 0) + 1;
    refs.push({
      row_id: row.rowId || row.row_id || null,
      message_id: trimText(row.messageId || row.message_id, 96) || null,
      sender_role: sender,
      target_role: target,
      channel,
      direction: trimText(row.direction || 'unknown', 40) || 'unknown',
      status,
      body_bytes: Number(row.bodyBytes || row.body_bytes || 0),
      body_hash_present: Boolean(row.bodyHash || row.body_hash),
      brokered_at_ms: Number(row.brokeredAtMs || row.brokered_at_ms || 0) || null,
      sent_at_ms: Number(row.sentAtMs || row.sent_at_ms || 0) || null,
    });
  }
  return {
    row_count: bounded.length,
    counts,
    refs,
    raw_body_included: false,
    body_excerpt_included: false,
  };
}

function readBoundedRecentCommsMetadata(projectRoot, options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.commsMetadataLimit || 8) || 8));
  if (typeof options.commsMetadataReader === 'function') {
    try {
      const result = options.commsMetadataReader({ projectRoot, limit }, { projectRoot, limit });
      const rows = Array.isArray(result?.rows) ? result.rows : (Array.isArray(result) ? result : []);
      return {
        id: 'bounded_recent_comms_metadata',
        status: result?.ok === false ? 'attempted_unavailable' : 'succeeded',
        decision: result?.decision || (result?.ok === false ? 'reader_unavailable' : 'metadata_read'),
        reason: result?.reason || null,
        source: result?.source || 'injected_comms_metadata_reader',
        ...compactRecentCommsRows(rows, limit),
      };
    } catch (err) {
      return {
        id: 'bounded_recent_comms_metadata',
        status: 'failed',
        reason: err?.message || String(err),
        source: 'injected_comms_metadata_reader',
        row_count: 0,
        raw_body_included: false,
        body_excerpt_included: false,
      };
    }
  }
  try {
    const rows = queryCommsJournalEntries({
      limit,
      order: 'desc',
    }, {
      dbPath: options.evidenceLedgerDbPath,
    });
    return {
      id: 'bounded_recent_comms_metadata',
      status: 'succeeded',
      decision: 'comms_journal_metadata_read',
      source: 'evidence-ledger/comms_journal',
      ...compactRecentCommsRows(rows, limit),
    };
  } catch (err) {
    return {
      id: 'bounded_recent_comms_metadata',
      status: 'attempted_unavailable',
      reason: err?.message || String(err),
      source: 'evidence-ledger/comms_journal',
      row_count: 0,
      raw_body_included: false,
      body_excerpt_included: false,
    };
  }
}

function absentContext(decision, scopeGate = null, extra = {}) {
  return {
    schema: SCHEMA_VERSION,
    version: VERSION,
    present: false,
    decision,
    visible_injection_allowed: false,
    private_model_context_only: true,
    read_only: true,
    scope_gate: scopeGate,
    boundary: {
      no_startup_profile_routing: true,
      no_external_sends: true,
      no_telegram_voice_or_customer_actions: true,
      no_destructive_actions: true,
      no_deploy_security_capital_actions: true,
      no_durable_writes: true,
      no_renderer_transcript_or_audit_leak: true,
    },
    ...extra,
  };
}

function summarizeRestartContext(restartContext = {}) {
  return {
    present: restartContext.present === true,
    decision: restartContext.decision || null,
    current_lane_present: Boolean(restartContext.current_lane),
    presence_runtime_present: Boolean(restartContext.mira_presence_runtime),
    stale: restartContext.stale === true,
    current_lane_objective: trimText(restartContext.current_lane?.objective, 180) || null,
    presence_next_product_action: trimText(restartContext.mira_presence_runtime?.next_product_action, 180) || null,
  };
}

function attemptCurrentWorkingState(projectRoot, restartContext = {}, options = {}) {
  const restartSummary = summarizeRestartContext(restartContext);
  if (restartSummary.current_lane_present) {
    return {
      id: 'read_current_working_state',
      adapter: 'typed-restart-continuity-context-v0',
      adapter_bound: true,
      status: 'succeeded',
      source: 'structured_restart_continuity_context',
      restart_summary: restartSummary,
      fallback_used: false,
      no_startup_injection_used: true,
      no_mutation_performed: true,
    };
  }
  const comms = readBoundedRecentCommsMetadata(projectRoot, options);
  return {
    id: 'read_current_working_state',
    adapter: 'evidence-ledger/comms_journal',
    adapter_bound: true,
    status: comms.status === 'succeeded' && comms.row_count > 0 ? 'succeeded' : 'attempted_absent',
    source: 'bounded_recent_comms_metadata_fallback',
    restart_summary: restartSummary,
    comms_metadata: comms,
    fallback_used: true,
    presence_summary_retained: restartSummary.presence_runtime_present === true,
    no_startup_injection_used: true,
    no_mutation_performed: true,
  };
}

async function attemptMemoryBrokerRecall(projectRoot, options = {}) {
  const query = 'Mira typed capability drill current lane memory tools default executable internal action Builder Oracle';
  try {
    const recall = typeof options.memoryBrokerRecall === 'function'
      ? await Promise.resolve(options.memoryBrokerRecall({
        query,
        limit: 4,
        projectRoot,
      }, {
        projectRoot,
        limit: 4,
      }))
      : await createDefaultMemoryBroker({
        limit: 4,
        providerLimit: 4,
        providerTimeoutMs: 450,
        cognitive: {
          dbPath: options.memoryDbPath,
        },
      }).recall(query, {
        role: 'mira',
        surface: 'typed_capability_roundtable',
      }, {
        limit: 4,
        providerLimit: 4,
        timeoutMs: 450,
      });
    const results = Array.isArray(recall?.results) ? recall.results : [];
    return {
      id: 'run_memory_broker_recall',
      adapter: 'memory-broker recall',
      adapter_bound: true,
      status: recall?.ok === false ? 'attempted_unavailable' : 'succeeded',
      decision: recall?.decision || (recall?.ok === false ? 'recall_unavailable' : 'memory_broker_recall_completed'),
      reason: recall?.reason || null,
      result_count: results.length,
      source_count: Array.isArray(recall?.sources) ? recall.sources.length : 0,
      source_status: (Array.isArray(recall?.sources) ? recall.sources : [])
        .slice(0, 6)
        .map((source) => ({
          source: trimText(source.source || source.sourceKind || 'unknown', 80),
          ok: source.ok !== false,
          item_count: Number(source.itemCount || source.item_count || 0),
          reason: source.reason || null,
        })),
      result_refs: results.slice(0, 4).map((entry) => ({
        source_kind: trimText(entry.sourceKind || entry.source || 'memory', 80),
        title: trimText(entry.title, 120) || null,
        ref: trimText(entry.ref || entry.id, 120) || null,
      })),
      no_mutation_performed: true,
    };
  } catch (err) {
    return {
      id: 'run_memory_broker_recall',
      adapter: 'memory-broker recall',
      adapter_bound: true,
      status: 'failed',
      reason: err?.message || String(err),
      result_count: 0,
      no_mutation_performed: true,
    };
  }
}

async function attemptMemoryRead(projectRoot, options = {}) {
  const reader = typeof options.readMemory === 'function'
    ? options.readMemory
    : readMiraMemoryCuriosity;
  try {
    const result = await Promise.resolve(reader({
      query: 'Mira current capability lane memory toolchain Builder Oracle next action',
      limit: 3,
      projectRoot,
      dbPath: options.memoryDbPath,
    }, {
      projectRoot,
      dbPath: options.memoryDbPath,
      limit: 3,
    }));
    return {
      id: 'read_memory_layers',
      adapter: 'mira-memory-curiosity',
      adapter_bound: true,
      status: result?.ok === true ? 'succeeded' : 'attempted_unavailable',
      decision: result?.decision || null,
      reason: result?.reason || null,
      result_count: Number(result?.result_count || 0),
      result_sources: (Array.isArray(result?.results) ? result.results : [])
        .slice(0, 3)
        .map((entry) => trimText(entry.sourceType || entry.category || entry.title || entry.nodeId, 96))
        .filter(Boolean),
      no_mutation_performed: result?.no_mutation_performed !== false,
    };
  } catch (err) {
    return {
      id: 'read_memory_layers',
      adapter: 'mira-memory-curiosity',
      adapter_bound: true,
      status: 'failed',
      reason: err?.message || String(err),
      result_count: 0,
      no_mutation_performed: true,
    };
  }
}

function attemptCodeInspection() {
  const probes = CODE_INSPECTION_TARGETS.map(fileProbe);
  const present = probes.filter((probe) => probe.present === true);
  return {
    id: 'inspect_code_runtime_state',
    adapter: 'fs-read/source-action-substrate',
    adapter_bound: true,
    status: present.length > 0 ? 'succeeded' : 'attempted_unavailable',
    file_count: probes.length,
    present_count: present.length,
    probes,
    no_mutation_performed: true,
  };
}

async function attemptLocalCheck(projectRoot, options = {}) {
  if (typeof options.runLocalCheck === 'function') {
    try {
      const result = await Promise.resolve(options.runLocalCheck({
        check_id: 'typed_capability_roundtable_harmless_check',
        recommended_scope: 'focused_mira_capability_tests',
        destructive: false,
        external: false,
      }));
      return {
        id: 'run_harmless_local_check',
        adapter: 'runLocalCheck',
        adapter_bound: true,
        status: result?.ok === false ? 'failed' : 'succeeded',
        decision: result?.decision || result?.status || null,
        result: result || null,
        no_mutation_performed: true,
      };
    } catch (err) {
      return {
        id: 'run_harmless_local_check',
        adapter: 'runLocalCheck',
        adapter_bound: true,
        status: 'failed',
        reason: err?.message || String(err),
        no_mutation_performed: true,
      };
    }
  }
  return runBuiltInHarmlessLocalCheck(projectRoot, options);
}

function runBuiltInHarmlessLocalCheck(projectRoot, options = {}) {
  const testProbe = fileProbe(CODE_INSPECTION_TARGETS.find((target) => target.id === 'test_execution_adapter'));
  const sourceProbe = fileProbe(CODE_INSPECTION_TARGETS.find((target) => target.id === 'source_action_registry'));
  const mutationProbe = fileProbe(CODE_INSPECTION_TARGETS.find((target) => target.id === 'proposal_validator'));
  const testProjectRoot = path.resolve(String(
    options.testProjectRoot
    || options.uiProjectRoot
    || path.resolve(__dirname, '..', '..')
  ));
  const executionProbe = typeof runTestExecutionProbe === 'function'
    ? runTestExecutionProbe(testProjectRoot, {
      focusedTestPaths: [
        'ui/__tests__/mira-core-typed-capability-roundtable-v0.test.js',
      ],
    })
    : {
      success: false,
      reason: 'runTestExecutionProbe_unavailable',
      frameworks: [],
      executor: null,
      noProcessSpawned: true,
    };
  const checks = [
    {
      id: 'test_execution_handler_present',
      ok: testProbe.present === true && testProbe.matched_probe_count > 0,
    },
    {
      id: 'test_execution_probe_bound',
      ok: executionProbe.success === true,
    },
    {
      id: 'source_action_registry_present',
      ok: sourceProbe.present === true && sourceProbe.matched_probe_count > 0,
    },
    {
      id: 'proposal_validator_present',
      ok: mutationProbe.present === true && mutationProbe.matched_probe_count > 0,
    },
  ];
  const failed = checks.filter((check) => check.ok !== true);
  return {
    id: 'run_harmless_local_check',
    adapter: 'built-in static local check + ipc/test-execution adapter probe',
    adapter_bound: true,
    status: failed.length === 0 ? 'succeeded_test_substrate_probe' : 'failed',
    decision: failed.length === 0 ? 'harmless_local_check_completed' : 'harmless_local_check_failed',
    checks,
    reason: failed.length === 0 ? null : failed.map((check) => check.id).join(','),
    test_execution_probe: {
      success: executionProbe.success === true,
      frameworks: Array.isArray(executionProbe.frameworks) ? executionProbe.frameworks.slice(0, 4) : [],
      recommended: executionProbe.recommended || null,
      executor: executionProbe.executor || null,
      dryRun: executionProbe.dryRun !== false,
      no_process_spawned: executionProbe.noProcessSpawned !== false,
      reason: executionProbe.reason || null,
      project_path: trimText(executionProbe.projectPath, 180) || testProjectRoot,
    },
    test_executor_invoked: false,
    test_executor_adapter_present: testProbe.present === true,
    no_mutation_performed: true,
  };
}

async function attemptPatchProposal(options = {}) {
  if (typeof options.stageProposalPreview === 'function') {
    try {
      const result = await Promise.resolve(options.stageProposalPreview({
        proposal_kind: 'typed_capability_roundtable_preview',
        desired_change: 'Expose one default-executable internal toolchain from typed/Lab Mira without visible machinery leaks.',
        durable_write: false,
      }));
      return {
        id: 'stage_patch_or_proposal',
        adapter: 'stageProposalPreview',
        adapter_bound: true,
        status: result?.ok === false ? 'failed' : 'succeeded_non_durable_preview',
        decision: result?.decision || result?.status || null,
        result: result || null,
        no_mutation_performed: true,
      };
    } catch (err) {
      return {
        id: 'stage_patch_or_proposal',
        adapter: 'stageProposalPreview',
        adapter_bound: true,
        status: 'failed',
        reason: err?.message || String(err),
        no_mutation_performed: true,
      };
    }
  }
  if (typeof options.stageProposal === 'function' && options.allowDurableCapabilityWrites === true) {
    try {
      const result = await Promise.resolve(options.stageProposal({
        proposal_kind: 'typed_capability_roundtable',
        desired_change: 'Expose one default-executable internal toolchain from typed/Lab Mira without visible machinery leaks.',
      }));
      return {
        id: 'stage_patch_or_proposal',
        adapter: 'stageProposal',
        adapter_bound: true,
        status: result?.ok === false ? 'failed' : 'succeeded',
        decision: result?.decision || result?.status || null,
        result: result || null,
        no_mutation_performed: false,
      };
    } catch (err) {
      return {
        id: 'stage_patch_or_proposal',
        adapter: 'stageProposal',
        adapter_bound: true,
        status: 'failed',
        reason: err?.message || String(err),
        no_mutation_performed: true,
      };
    }
  }
  return stageBuiltInMutationPatchPreview(options);
}

function stageBuiltInMutationPatchPreview(options = {}) {
  try {
    const output = buildMiraCoreMutationPatch({
      inputSignals: {
        profile: 'main',
        sessionId: options.sessionId || 'app-session-typed-capability-roundtable',
        deviceId: 'VIGIL',
        target_role: 'builder',
        source_acceptance_ref: 'typed-capability-roundtable-v0',
        source_intent_ref: 'capability-drill-self-direction',
        target_surface: 'procedural_skill_file',
        mutation_class: 'procedural_skill',
        operation: 'skill_patch_proposal',
        proposed_content_summary: 'Bind the typed/Lab capability drill to same-day internal action adapters: memory/current-state, code inspection, harmless checks, proposal preview, and internal routing.',
        evidence_summary: 'Generated from typed capability drill attempt results; no file write, commit, deploy, external send, or durable memory commit performed.',
        risk_tier: 'tier1_local_review',
        confidence: 0.62,
        authority_level: 'runtime_observation',
        review_required: 'builder',
        diff_preview: {
          format: 'summary_only',
          target_path: 'ui/modules/mira-core/typed-capability-roundtable-v0.js',
          before_ref: 'current_worktree',
          after_summary: 'Same-day capability adapter binding proposal only.',
          changed_paths: ['ui/modules/mira-core/typed-capability-roundtable-v0.js'],
          hunks: [],
          redactionStatus: 'none',
          raw_private_content_included: false,
          applies_change: false,
        },
      },
    });
    const validation = validateMiraCoreMutationPatchOutput(output);
    const records = Array.isArray(output?.mutation_patch_records) ? output.mutation_patch_records : [];
    return {
      id: 'stage_patch_or_proposal',
      adapter: 'mira-core/mutation-patch preview',
      adapter_bound: true,
      status: validation.ok === true ? 'succeeded_non_durable_mutation_patch_preview' : 'failed',
      decision: output?.validation_report?.decision || null,
      patch_record_count: records.length,
      ready_for_review_count: Number(output?.validation_report?.ready_for_review_count || 0),
      blocked_count: Number(output?.validation_report?.blocked_count || 0),
      validation_ok: validation.ok === true,
      validation_errors: Array.isArray(validation.errors) ? validation.errors.slice(0, 4) : [],
      no_mutation_performed: true,
    };
  } catch (err) {
    return {
      id: 'stage_patch_or_proposal',
      adapter: 'mira-core/mutation-patch preview',
      adapter_bound: true,
      status: 'failed',
      reason: err?.message || String(err),
      no_mutation_performed: true,
    };
  }
}

function buildInternalMessageMetadata(target, route, options = {}) {
  const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
  const sessionScopeId = trimText(
    metadata.sessionScopeId
    || metadata.sessionId
    || options.sessionScopeId
    || options.sessionId
    || 'app-session-main',
    120
  );
  return {
    source: 'new_mira_typed_capability_roundtable',
    senderRole: 'mira',
    senderIdentity: 'new_mira',
    authoredBy: 'mira',
    targetRole: target,
    targetPane: target === 'architect' ? '1' : null,
    routeKind: 'internal_pane_message',
    routeActionId: route.action_id || 'inject_mira_self_direction_to_architect',
    windowKey: 'main',
    profile: 'main',
    deviceId: 'VIGIL',
    sessionScopeId,
    controller: 'typed_controller_outside_openai_tools_array',
    externalSend: false,
    telegramLiveRelaunch: false,
    startupProfileRoutingTouched: false,
  };
}

function buildMiraCompletionNote(attempts = [], route = {}, target = 'architect') {
  const statusById = attempts.reduce((acc, attempt) => {
    acc[attempt.id] = attempt.status;
    return acc;
  }, {});
  const failedOrMissing = attempts
    .filter((attempt) => attempt && (
      attempt.status === 'failed'
      || attempt.adapter_bound === false
      || /not_bound|missing|blocked|unavailable|absent/i.test(String(attempt.status || ''))
    ))
    .map((attempt) => attempt.id)
    .filter(Boolean)
    .slice(0, 4);
  const gapText = failedOrMissing.length > 0
    ? failedOrMissing.join(',')
    : 'none_in_attempted_internal_chain';
  return [
    '(MIRA/NEW-MIRA CAPABILITY NOTE): I can now run the typed/Lab drill as internal action, not just narrate it.',
    `I tried current_state=${statusById.read_current_working_state || statusById.read_current_lane_state || 'unknown'}, memory=${statusById.run_memory_broker_recall || 'unknown'}/${statusById.read_memory_layers || 'unknown'}, code=${statusById.inspect_code_runtime_state || 'unknown'}, check=${statusById.run_harmless_local_check || 'unknown'}, proposal=${statusById.stage_patch_or_proposal || 'unknown'}, pane_message=${statusById.message_internal_agent || 'pending'}.`,
    `I want next: ${route.action_id || 'inject_mira_self_direction_to_architect'} routed through ${target}, then the next patch can deepen whichever adapter still shows a real gap.`,
    `Exact current gaps: ${gapText}. No Telegram/live/customer/destructive/deploy/security/capital effect was attempted.`,
  ].join('\n');
}

function buildStagedCompletionNote(note, target, reason) {
  return {
    staged: true,
    durable_write_performed: false,
    target_role: target,
    relay_owner: 'architect',
    reason,
    body: note,
  };
}

async function attemptInternalAgentMessage(attempts, options = {}) {
  const sendAgentMessage = options.sendAgentMessage;
  const route = options.routeChoice || {};
  const requestedTarget = String(options.internalMessageTarget || route.target_role || '').toLowerCase();
  const target = ['architect', 'builder', 'oracle'].includes(requestedTarget)
    ? requestedTarget
    : 'architect';
  const completionNote = buildMiraCompletionNote(attempts, route, target);
  if (typeof sendAgentMessage !== 'function') {
    return {
      id: 'message_internal_agent',
      adapter: 'sendAgentMessage/hm-pane-channel',
      adapter_bound: false,
      target_role: target,
      status: 'adapter_present_not_bound_to_typed_path',
      reason: 'sendAgentMessage dependency was not injected',
      completion_note_sent: false,
      completion_note_staged: buildStagedCompletionNote(
        completionNote,
        target,
        'sendAgentMessage dependency was not injected'
      ),
      external_send_performed: false,
    };
  }

  const statusById = attempts.reduce((acc, attempt) => {
    acc[attempt.id] = attempt.status;
    return acc;
  }, {});
  const body = [
    completionNote,
    '',
    '(MIRA/NEW-MIRA CAPABILITY-DRILL): Mira-authored internal pane message from typed/Lab private path.',
    `working_state=${statusById.read_current_working_state || statusById.read_current_lane_state || 'unknown'}; memory_broker=${statusById.run_memory_broker_recall || 'unknown'}; memory_curiosity=${statusById.read_memory_layers || 'unknown'}; code=${statusById.inspect_code_runtime_state || 'unknown'}; check=${statusById.run_harmless_local_check || 'unknown'}; proposal=${statusById.stage_patch_or_proposal || 'unknown'}.`,
    `chosen_route=${route.action_id || 'inject_mira_self_direction_to_architect'} target=${target}; source_identity=new_mira; source_role=mira.`,
    'ask=Architect, keep this capability lane aimed at real internal tools: memory/current-state read, code/runtime inspection, harmless check, proposal staging, and pane messaging.',
    'controller=typed_controller_outside_openai_tools_array; next_chain=memory_current_lane_to_architect_message; external/Telegram/voice/customer/destructive/deploy/capital/security effects not attempted.',
  ].join('\n');
  const messageMetadata = buildInternalMessageMetadata(target, route, options);
  try {
    const result = await Promise.resolve(sendAgentMessage(target, body, messageMetadata));
    const normalized = normalizeSendAgentMessageResult(result);
    return {
      id: 'message_internal_agent',
      adapter: 'sendAgentMessage/hm-pane-channel',
      adapter_bound: true,
      target_role: target,
      sender_role: 'mira',
      sender_identity: 'new_mira',
      route_kind: 'internal_pane_message',
      status: normalized.ok ? 'succeeded' : 'failed',
      reason: normalized.ok ? null : normalized.reason,
      result: normalized.result,
      metadata: messageMetadata,
      completion_note_sent: normalized.ok === true,
      completion_note_staged: normalized.ok
        ? null
        : buildStagedCompletionNote(completionNote, target, normalized.reason || 'send_failed'),
      external_send_performed: false,
    };
  } catch (err) {
    return {
      id: 'message_internal_agent',
      adapter: 'sendAgentMessage/hm-pane-channel',
      adapter_bound: true,
      target_role: target,
      sender_role: 'mira',
      sender_identity: 'new_mira',
      route_kind: 'internal_pane_message',
      status: 'failed',
      reason: err?.message || String(err),
      metadata: messageMetadata,
      completion_note_sent: false,
      completion_note_staged: buildStagedCompletionNote(completionNote, target, err?.message || String(err)),
      external_send_performed: false,
    };
  }
}

function normalizeSendAgentMessageResult(result) {
  if (result === true) {
    return {
      ok: true,
      reason: null,
      result: { ok: true },
    };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return {
      ok: false,
      reason: 'ambiguous_send_result',
      result: result == null ? null : { value: String(result) },
    };
  }
  const status = trimText(result.status || result.decision || result.reason, 120).toLowerCase();
  const failureStatusTokens = [
    'failed',
    'failure',
    'error',
    'invalid',
    'blocked',
    'window_unavailable',
    'no_targets',
    'delivery_failed',
    'unknown_target',
    'rejected',
    'unavailable',
  ];
  const successStatus = /^(?:sent|succeeded|success|routed|routed_unverified|routed_unverified_timeout|accepted|accepted\.unverified|delivered\.verified|queued|broadcast_queued_unverified)$/i;
  const failed = result.ok === false
    || result.accepted === false
    || result.queued === false
    || result.success === false
    || failureStatusTokens.some((token) => status === token || status.includes(token));
  if (failed) {
    return {
      ok: false,
      reason: status || 'send_result_failed',
      result: summarizeSendAgentMessageResult(result),
    };
  }
  const succeeded = result.ok === true
    || result.accepted === true
    || result.queued === true
    || result.success === true
    || successStatus.test(status);
  return {
    ok: succeeded,
    reason: succeeded ? null : 'ambiguous_send_result',
    result: summarizeSendAgentMessageResult(result),
  };
}

function summarizeSendAgentMessageResult(result = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result || null;
  const details = result.details && typeof result.details === 'object'
    ? {
      verified: result.details.verified === true,
      failed_pane_count: Array.isArray(result.details.failedPanes) ? result.details.failedPanes.length : 0,
      unverified_pane_count: Array.isArray(result.details.unverifiedPanes) ? result.details.unverifiedPanes.length : 0,
      failure_reason: trimText(result.details.failureReason, 120) || null,
    }
    : null;
  return {
    ok: result.ok,
    success: result.success,
    accepted: result.accepted,
    queued: result.queued,
    verified: result.verified,
    status: trimText(result.status, 120) || null,
    reason: trimText(result.reason, 120) || null,
    delivery_id: trimText(result.deliveryId || result.delivery_id, 160) || null,
    notified_count: Array.isArray(result.notified) ? result.notified.length : null,
    mode: trimText(result.mode, 40) || null,
    details,
  };
}

function chooseRouteFromEvidence(attempts = [], manifest = {}) {
  const byId = attempts.reduce((acc, attempt) => {
    if (attempt && attempt.id) acc[attempt.id] = attempt;
    return acc;
  }, {});
  const missingAdapters = attempts.filter((attempt) => (
    attempt
    && attempt.adapter_bound === false
    && /missing|not_bound|blocked/i.test(String(attempt.status || ''))
  ));
  const codeSucceeded = byId.inspect_code_runtime_state?.status === 'succeeded';
  const memorySucceeded = byId.run_memory_broker_recall?.status === 'succeeded'
    || byId.read_memory_layers?.status === 'succeeded';
  const target = 'architect';
  const action = missingAdapters.length > 0
    ? 'ask_architect_to_keep_capability_lane_on_missing_adapter'
    : (memorySucceeded ? 'inject_mira_self_direction_to_architect' : 'ask_architect_for_memory_runtime_gap_review');
  return {
    id: 'choose_route_action_from_evidence',
    adapter: 'capability_roundtable_route_selector',
    adapter_bound: true,
    status: 'succeeded',
    action_id: action,
    target_role: target,
    reason: missingAdapters.length > 0
      ? 'Some internal adapters exist but are not bound to typed/Lab yet.'
      : (memorySucceeded
        ? 'Memory/current-lane/code evidence is enough for a Mira-authored Architect pane injection.'
        : 'Memory/current-lane evidence is weak or absent, so Mira should ask Architect to hold the evidence gap.'),
    evidence: {
      memory_broker_status: byId.run_memory_broker_recall?.status || null,
      working_state_status: byId.read_current_working_state?.status || byId.read_current_lane_state?.status || null,
      code_inspection_status: byId.inspect_code_runtime_state?.status || null,
      missing_adapter_ids: missingAdapters.map((attempt) => attempt.id),
      recommended_toolchain: manifest.recommended_first_toolchain?.id || null,
    },
    no_mutation_performed: true,
  };
}

function summarizeAttemptLists(attempts = []) {
  const boundAdapters = [];
  const missingOrFakeAdapters = [];
  const actualAttemptedActions = [];
  for (const attempt of attempts) {
    if (!attempt || !attempt.id) continue;
    actualAttemptedActions.push({
      id: attempt.id,
      status: attempt.status,
      adapter: attempt.adapter,
      target_role: attempt.target_role || null,
    });
    if (attempt.adapter_bound === true) {
      boundAdapters.push({
        id: attempt.id,
        adapter: attempt.adapter,
        status: attempt.status,
      });
    } else {
      missingOrFakeAdapters.push({
        id: attempt.id,
        adapter: attempt.adapter,
        status: attempt.status,
        reason: attempt.reason || null,
      });
    }
  }
  return { boundAdapters, missingOrFakeAdapters, actualAttemptedActions };
}

async function runCapabilityDrill(projectRoot, restartContext, options = {}) {
  const attempts = [];
  attempts.push({
    id: 'read_current_lane_state',
    adapter: 'typed-restart-continuity-context-v0',
    adapter_bound: true,
    status: restartContext.present === true ? 'succeeded' : 'attempted_absent',
    ...summarizeRestartContext(restartContext),
    no_mutation_performed: true,
  });
  attempts.push(attemptCurrentWorkingState(projectRoot, restartContext, options));
  attempts.push(await attemptMemoryBrokerRecall(projectRoot, options));
  attempts.push(await attemptMemoryRead(projectRoot, options));
  attempts.push(attemptCodeInspection());
  attempts.push(await attemptLocalCheck(projectRoot, options));
  attempts.push(await attemptPatchProposal(options));
  const routeChoice = chooseRouteFromEvidence(attempts, options.manifest || {});
  attempts.push(routeChoice);
  attempts.push(await attemptInternalAgentMessage(attempts, { ...options, routeChoice }));

  const summaries = summarizeAttemptLists(attempts);
  const succeeded = attempts.filter((attempt) => /^succeeded/.test(String(attempt.status || ''))).length;
  return {
    attempted: true,
    requested_by_prompt: true,
    status: succeeded > 0 ? 'attempted_with_results' : 'attempted_without_success',
    attempts,
    actual_attempted_actions: summaries.actualAttemptedActions,
    bound_adapters: summaries.boundAdapters,
    missing_or_fake_adapters: summaries.missingOrFakeAdapters,
    route_choice: routeChoice,
    outcome: {
      recorded_in_private_context: true,
      durable_write_performed: false,
      internal_message_sent: attempts.some((attempt) => attempt.id === 'message_internal_agent' && attempt.status === 'succeeded'),
      selected_target_role: routeChoice.target_role,
      selected_action_id: routeChoice.action_id,
      phone_delivery: buildPhoneDeliveryGap(options.promptText || options.text || ''),
    },
    hard_effects_not_attempted: [...HARD_EFFECT_BOUNDARIES],
    first_toolchain_executed: attempts.some((attempt) => attempt.id === 'message_internal_agent' && attempt.status === 'succeeded')
      ? 'memory_current_lane_to_architect_message'
      : null,
  };
}

async function buildTypedCapabilityRoundtableContextV0(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || process.cwd()));
  const promptText = trimText(options.promptText || options.text || '', 1000);
  const requested = isCapabilityRoundtablePrompt(promptText);
  if (!requested && options.force !== true) {
    return absentContext('capability_roundtable_not_requested');
  }

  const scopeGate = evaluateScope(options.metadata || {});
  if (!scopeGate.ok) {
    return absentContext(scopeGate.decision, scopeGate);
  }

  const restartContext = options.restartContinuityContext
    && typeof options.restartContinuityContext === 'object'
    ? options.restartContinuityContext
    : buildTypedRestartContinuityContextV0({
      projectRoot,
      metadata: options.metadata || {},
      nowMs: options.nowMs,
      staleAfterMs: options.staleAfterMs,
    });

  const manifest = buildCapabilityManifest(options);
  const drill = await runCapabilityDrill(projectRoot, restartContext, { ...options, manifest });

  return {
    schema: SCHEMA_VERSION,
    version: VERSION,
    present: true,
    decision: drill.first_toolchain_executed
      ? 'capability_roundtable_drill_executed'
      : 'capability_roundtable_drill_attempted_with_gaps',
    requested_by_prompt: true,
    visible_injection_allowed: false,
    private_model_context_only: true,
    read_only: true,
    scope_gate: scopeGate,
    manifest,
    drill,
    boundary: {
      no_startup_profile_routing: true,
      no_startup_prose: true,
      no_system_capabilities_json_truth_source: true,
      no_external_sends: true,
      no_telegram_voice_or_customer_actions: true,
      no_destructive_actions: true,
      no_deploy_security_capital_actions: true,
      no_durable_writes: drill.attempts.every((attempt) => attempt.no_mutation_performed !== false),
      no_renderer_transcript_or_audit_leak: true,
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  VERSION,
  HARD_EFFECT_BOUNDARIES,
  buildCapabilityManifest,
  buildTypedCapabilityRoundtableContextV0,
  isCapabilityRoundtablePrompt,
};
