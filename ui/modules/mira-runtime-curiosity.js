'use strict';

const {
  buildMiraAutonomySubstrateV0,
  validateMiraAutonomySubstrateV0Output,
} = require('./mira-core/autonomy-substrate-v0');
const {
  buildMiraCoreExperienceV0,
  validateMiraCoreExperienceV0Output,
} = require('./mira-core/experience-v0');
const {
  buildMiraCoreGrowthLoopV0,
  validateMiraCoreGrowthLoopV0Output,
} = require('./mira-core/growth-loop-v0');
const {
  buildMiraCoreIntentQueue,
  validateMiraCoreIntentQueueOutput,
} = require('./mira-core/intent-queue');
const {
  buildMiraCorePerception,
  validateMiraCorePerceptionOutput,
} = require('./mira-core/perception');

const MIRA_RUNTIME_CURIOSITY_SCHEMA = 'squidrun.mira.runtime_curiosity_read_v0';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function trimText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function moduleError(name, err) {
  return {
    module: name,
    ok: false,
    status: 'read_error',
    reason: trimText(err?.message) || 'runtime_module_read_error',
  };
}

function readAutonomy(options = {}) {
  try {
    const output = buildMiraAutonomySubstrateV0({
      projectRoot: options.projectRoot,
      generatedAt: options.generatedAt,
      nowMs: options.nowMs,
      executeReads: true,
      inputSignals: {
        currentUserText: options.currentUserText || 'Mira runtime curiosity should inspect herself before choosing the next growth move.',
        currentAssistantText: options.currentAssistantText || 'I will inspect the runtime evidence first.',
      },
    });
    const validation = validateMiraAutonomySubstrateV0Output(output);
    return {
      module: 'autonomy_substrate',
      ok: validation.ok === true,
      status: validation.decision || 'unknown',
      drive_count: asArray(output.drives).length,
      curiosity_count: asArray(output.curiosity_queue).length,
      permissioned_read_count: asArray(output.permissioned_reads?.executed).length,
      failed_check_ids: asArray(validation.failed_check_ids),
      side_effects: {
        write_count: Number(output.side_effect_counters?.write_count || 0),
        external_send_count: Number(output.side_effect_counters?.external_send_count || 0),
        network_count: Number(output.side_effect_counters?.network_count || 0),
      },
    };
  } catch (err) {
    return moduleError('autonomy_substrate', err);
  }
}

function readExperience(options = {}) {
  try {
    const output = buildMiraCoreExperienceV0({
      projectRoot: options.projectRoot,
      generatedAt: options.generatedAt,
      nowMs: options.nowMs,
      inputSignals: {
        prompt: options.prompt || 'Mira runtime curiosity status',
      },
    });
    const validation = validateMiraCoreExperienceV0Output(output);
    const experience = output.mira_experience_v0 || {};
    return {
      module: 'experience',
      ok: validation.ok === true,
      status: output.validation_report?.status || output.validation_report?.decision || 'unknown',
      loaded_source_count: Number(experience.source_manifest?.loaded_count || 0),
      future_gap_count: asArray(experience.future_capability_gaps).length,
      chosen_next_action_type: trimText(experience.chosen_next_desire_action?.action_type) || null,
      chosen_next_action_performed_now: experience.chosen_next_desire_action?.performed_now === true,
      errors: asArray(validation.errors),
      side_effects: {
        external_send: experience.current_behavior_truth?.external_send === true,
        durable_memory_write: experience.current_behavior_truth?.durable_memory_write === true,
      },
    };
  } catch (err) {
    return moduleError('experience', err);
  }
}

function readGrowth(options = {}) {
  try {
    const output = buildMiraCoreGrowthLoopV0({
      projectRoot: options.projectRoot,
      generatedAt: options.generatedAt,
      nowMs: options.nowMs,
      apply: false,
      inputSignals: {
        desiredChange: 'Read runtime capability state and propose the next reviewable growth move.',
        target: 'mira_runtime',
        apply: false,
      },
    });
    const validation = validateMiraCoreGrowthLoopV0Output(output);
    const growth = output.growth_loop_v0 || {};
    return {
      module: 'growth_loop',
      ok: validation.ok === true,
      status: output.validation_report?.status || output.validation_report?.decision || 'unknown',
      proposal_status: trimText(growth.proposal?.status) || null,
      action_status: trimText(growth.action_result?.status || growth.action_result?.decision) || null,
      artifacts_seen: Object.keys(growth.artifacts || {}).length,
      errors: asArray(validation.errors),
      side_effects: {
        file_write_performed: growth.side_effect_result?.no_file_write_performed === false,
        external_send_performed: growth.side_effect_result?.no_send_performed === false,
        network_performed: growth.side_effect_result?.no_network_performed === false,
      },
    };
  } catch (err) {
    return moduleError('growth_loop', err);
  }
}

function readIntent(options = {}) {
  try {
    const output = buildMiraCoreIntentQueue({
      generatedAt: options.generatedAt,
      nowMs: options.nowMs,
      inputSignals: {
        requests: [{
          requested_by: 'mira',
          target_role: 'architect',
          risk_tier: 'tier0_read_only',
          action_class: 'status_request',
          payload_summary: 'Read Mira runtime status and decide the next internal route.',
        }],
      },
    });
    const validation = validateMiraCoreIntentQueueOutput(output);
    const report = output.validation_report || {};
    return {
      module: 'intent_queue',
      ok: validation.ok === true,
      status: report.decision || 'unknown',
      intent_count: asArray(output.intent_records).length,
      accepted_count: Number(report.accepted_count || 0),
      review_required_count: Number(report.review_required_count || 0),
      blocked_count: Number(report.blocked_count || 0),
      errors: asArray(validation.errors),
      side_effects: {
        queue_created: false,
        execution_performed: asArray(output.intent_records).some((record) => record.no_execution_performed !== true),
      },
    };
  } catch (err) {
    return moduleError('intent_queue', err);
  }
}

function readPerception(options = {}) {
  try {
    const output = buildMiraCorePerception({
      generatedAt: options.generatedAt,
      nowMs: options.nowMs,
      inputSignals: {
        requests: [],
      },
    });
    const validation = validateMiraCorePerceptionOutput(output);
    const report = output.validation_report || {};
    return {
      module: 'perception',
      ok: validation.ok === true,
      status: report.decision || 'unknown',
      ready_for_review_count: Number(report.ready_for_review_count || 0),
      review_required_count: Number(report.review_required_count || 0),
      blocked_count: Number(report.blocked_count || 0),
      errors: asArray(validation.errors),
      side_effects: {
        capture_performed: report.side_effect_result?.no_capture_performed === false,
        screenshot_performed: report.side_effect_result?.no_screenshot_performed === false,
        browser_or_window_access_performed: report.side_effect_result?.no_browser_or_window_access_performed === false,
      },
    };
  } catch (err) {
    return moduleError('perception', err);
  }
}

function readMiraRuntimeCuriosity(payload = {}, options = {}) {
  const nowMs = Number.isFinite(Number(payload.nowMs ?? options.nowMs))
    ? Number(payload.nowMs ?? options.nowMs)
    : Date.now();
  const generatedAt = payload.generatedAt || options.generatedAt || new Date(nowMs).toISOString();
  const projectRoot = options.projectRoot || payload.projectRoot || process.cwd();
  const shared = {
    ...options,
    ...payload,
    projectRoot,
    nowMs,
    generatedAt,
  };
  const modules = [
    readAutonomy(shared),
    readExperience(shared),
    readGrowth(shared),
    readIntent(shared),
    readPerception(shared),
  ];
  const blocked = modules.filter((entry) => entry.ok !== true);
  const activeSignals = modules
    .filter((entry) => entry.ok === true)
    .map((entry) => entry.module);

  return {
    schema: MIRA_RUNTIME_CURIOSITY_SCHEMA,
    ok: true,
    decision: blocked.length === 0 ? 'runtime_read_only' : 'runtime_read_with_gaps',
    generated_at: generatedAt,
    module_count: modules.length,
    healthy_runtime: blocked.length === 0,
    active_signal_count: activeSignals.length,
    active_signals: activeSignals,
    blocked_modules: blocked.map((entry) => ({ module: entry.module, reason: entry.reason || entry.status })),
    modules,
    next_runtime_question: blocked.length > 0
      ? 'Which runtime module needs repair before Mira can trust this lane?'
      : 'Which accepted runtime signal should Mira use for the next self-improvement route?',
    no_mutation_performed: true,
    consequence_controls: {
      internal_only: true,
      read_only: true,
      profile_write_performed: false,
      memory_write_performed: false,
      queue_mutation_performed: false,
      dispatch_performed: false,
      capture_performed: false,
      network_performed: false,
      external_send_performed: false,
      autonomous_apply_performed: false,
    },
  };
}

module.exports = {
  MIRA_RUNTIME_CURIOSITY_SCHEMA,
  readMiraRuntimeCuriosity,
};
