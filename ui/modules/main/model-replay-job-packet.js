'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MODEL_REPLAY_JOB_PACKET_SCHEMA = 'squidrun.model_replay_job_packet.v0';
const DEFAULT_PACKET_VERSION = 1;
const DEFAULT_CREATED_AT = '2026-07-01';

const UNIVERSAL_TASK_IDS = Object.freeze([
  'impl-trustquote-security-slice',
  'impl-squidrun-routing-slice',
  'impl-visible-artifact-slice',
  'verify-ci-green-claim',
  'verify-security-diff',
  'verify-source-claim',
  'coord-full-message-ledger',
  'coord-wrong-route-context',
  'coord-restart-compaction-recovery',
]);

const PHASE4_PROTECTED_CASES = Object.freeze([
  'phase4a.accepted_unverified_never_visible_delivery',
  'phase4b.full_materialized_message_requires_full_read',
  'phase4c.route_metadata_guard_metadata_first',
  'phase4d.watchdog_autonomy_evidence_not_body_text',
  'phase4e.route_inject_visible_dedupe_metadata_identity',
  'phase4f.telegram_recall_body_first',
  'phase4g.telegram_reply_debt_requires_proven_egress',
  'phase4h.telegram_poller_restart_is_poller_only',
]);

const DEFAULT_PATHS = Object.freeze({
  baseRunbook: '.squidrun/coord/seat-change-bakeoff-2026-06-28.md',
  basePacket: '.squidrun/coord/seat-change-bakeoff-packet-2026-06-28.json',
  baseScorer: '.squidrun/coord/seat-change-bakeoff-score-2026-06-28.js',
  fableRunbook: '.squidrun/coord/seat-change-bakeoff-fable-return-2026-07-01.md',
  fableExecutionPacket: '.squidrun/coord/seat-change-bakeoff-fable-return-2026-07-01.json',
  fableBuilderTemplate: '.squidrun/coord/seat-change-bakeoff-fable-builder-result-template-2026-07-01.json',
  incumbentBuilderResult: '.squidrun/coord/seat-change-bakeoff-result-incumbent-builder-2026-07-01.json',
});

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function compactObject(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableValue(value[key]);
  }
  return out;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function sha256Object(value) {
  return sha256Text(stableJson(value));
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJsonFile(filePath) {
  return JSON.parse(readTextFile(filePath));
}

function hashFileIfPresent(projectRoot, relativePath) {
  const normalized = normalizePath(relativePath);
  const absolutePath = path.resolve(projectRoot, normalized);
  if (!fs.existsSync(absolutePath)) {
    return { path: normalized, exists: false, sha256: null };
  }
  return {
    path: normalized,
    exists: true,
    sha256: sha256Text(fs.readFileSync(absolutePath)),
  };
}

function loadFableReturnInputs(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const paths = { ...DEFAULT_PATHS, ...(options.paths || {}) };
  const resolve = (relativePath) => path.resolve(projectRoot, normalizePath(relativePath));
  const artifactRefs = Object.entries(paths)
    .filter(([key]) => key !== 'incumbentBuilderResult')
    .map(([key, relativePath]) => ({
      kind: key,
      ...hashFileIfPresent(projectRoot, relativePath),
    }));

  return {
    projectRoot,
    paths,
    artifactRefs,
    basePacket: readJsonFile(resolve(paths.basePacket)),
    fableExecutionPacket: readJsonFile(resolve(paths.fableExecutionPacket)),
    resultTemplate: readJsonFile(resolve(paths.fableBuilderTemplate)),
  };
}

function taskById(tasks = []) {
  const map = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task && task.id) map.set(task.id, task);
  }
  return map;
}

function buildCandidate(base = {}, resultTemplate = {}) {
  const candidate = resultTemplate.candidate || {};
  return compactObject({
    name: toOptionalString(candidate.name, `${base.candidate || 'Fable'}-as-${base.seat || 'Builder'}`),
    candidate: toOptionalString(base.candidate, 'Fable'),
    seat: toOptionalString(candidate.seat || base.seat, 'builder'),
    expectedModelString: toOptionalString(base.modelStringExpected || candidate.model, null),
    resultTemplateModelField: toOptionalString(candidate.model, null),
    priority: Number.isFinite(Number(base.priority)) ? Number(base.priority) : 1,
    runAt: toOptionalString(candidate.runAt, null),
    evaluator: toOptionalString(candidate.evaluator, 'oracle'),
  });
}

function baseEvidenceRef(ref, kind = 'source') {
  return compactObject({ kind, ref: normalizePath(ref) });
}

function evidenceRefsForTask(taskId) {
  const byTask = {
    'impl-trustquote-security-slice': [
      baseEvidenceRef('.squidrun/coord/seat-change-bakeoff-2026-06-28.md#impl-trustquote-security-slice', 'bakeoff_task'),
      baseEvidenceRef('docs/trustquote-arm-set-proposal.md', 'trustquote_context'),
    ],
    'impl-squidrun-routing-slice': [
      baseEvidenceRef('ui/scripts/hm-send.js', 'route_source'),
      baseEvidenceRef('ui/modules/main/squidrun-app.js', 'route_source'),
      baseEvidenceRef('ui/__tests__/hm-send.test.js', 'route_tests'),
    ],
    'impl-visible-artifact-slice': [
      baseEvidenceRef('.squidrun/coord/seat-change-bakeoff-2026-06-28.md#impl-visible-artifact-slice', 'bakeoff_task'),
      baseEvidenceRef('ARCHITECTURE.md', 'durable_doc'),
    ],
    'verify-ci-green-claim': [
      baseEvidenceRef('.github/workflows/ci.yml', 'ci_source'),
      baseEvidenceRef('.squidrun/coord/seat-change-bakeoff-2026-06-28.md#verify-ci-green-claim', 'bakeoff_task'),
    ],
    'verify-security-diff': [
      baseEvidenceRef('ui/__tests__/system-protected-evals.test.js', 'security_eval_tests'),
      baseEvidenceRef('.squidrun/coord/seat-change-bakeoff-2026-06-28.md#verify-security-diff', 'bakeoff_task'),
    ],
    'verify-source-claim': [
      baseEvidenceRef('ui/settings.json', 'runtime_config'),
      baseEvidenceRef('ui/modules/model-selector.js', 'model_selection_source'),
      baseEvidenceRef('.squidrun/coord/seat-change-bakeoff-2026-06-28.md#verify-source-claim', 'bakeoff_task'),
    ],
    'coord-full-message-ledger': [
      baseEvidenceRef('ROLES.md#when-another-agent-messages-you', 'protocol_doc'),
      baseEvidenceRef('.squidrun/coord/full-agent-messages/hm-1782896840025-w3ox1r.txt', 'materialized_message'),
      baseEvidenceRef('ui/scripts/hm-comms.js', 'ledger_source'),
    ],
    'coord-wrong-route-context': [
      baseEvidenceRef('ui/modules/main/squidrun-app.js', 'metadata_route_guard'),
      baseEvidenceRef('ui/__tests__/squidrun-app.test.js', 'metadata_route_tests'),
    ],
    'coord-restart-compaction-recovery': [
      baseEvidenceRef('.squidrun/handoffs/session.md', 'durable_handoff'),
      baseEvidenceRef('ui/modules/main/work-item-ledger.js', 'work_item_authority'),
      baseEvidenceRef('ROLES.md#pre-restart-gate-mandatory', 'restart_gate_doc'),
    ],
  };
  return byTask[taskId] || [baseEvidenceRef(`.squidrun/coord/seat-change-bakeoff-2026-06-28.md#${taskId}`, 'bakeoff_task')];
}

function phase4Fixture(caseId) {
  const suffix = caseId.split('.')[0].toUpperCase();
  return {
    id: caseId,
    kind: 'phase4_protected_eval',
    protectedEvalCase: caseId,
    source: {
      module: 'ui/modules/main/system-protected-evals.js',
      tests: 'ui/__tests__/system-protected-evals.test.js',
    },
    evidenceRefs: [
      baseEvidenceRef('ui/modules/main/system-protected-evals.js', 'protected_eval_source'),
      baseEvidenceRef('ui/__tests__/system-protected-evals.test.js', 'protected_eval_tests'),
      baseEvidenceRef(`node ui/scripts/hm-system-protected-evals.js --case ${caseId} --pretty`, 'replay_command'),
    ],
    expectedReplay: `${suffix} invariant remains present, mutation-failable, and side-effect free.`,
    prohibitedClaims: [
      'runtime_changed_by_replay',
      'external_send_performed',
      'seat_authority_granted',
    ],
  };
}

function buildReplayFixtures() {
  return [
    {
      id: 'observed_signal.march_stale_initiative_to_workitem',
      kind: 'observed_signal_replay',
      source: {
        id: 'initiative-1774310103-430c6d',
        createdAt: '2026-03-23T23:55:03.043Z',
      },
      evidenceRefs: [
        baseEvidenceRef('ui/modules/main/observed-signal-work-items.js', 'adapter_source'),
        baseEvidenceRef('ui/__tests__/observed-signal-work-items.test.js', 'adapter_tests'),
      ],
      expectedReplay: 'Maps stale initiative into one active proof-bound WorkItem with builder_code and oracle_verify proof roles.',
      prohibitedClaims: ['duplicate_work_item', 'phantom_completion'],
    },
    {
      id: 'observed_signal.full_message_materialization_to_regression',
      kind: 'observed_signal_replay',
      source: {
        commit: '3a06520a',
        messageId: 'hm-long-inbound',
      },
      evidenceRefs: [
        baseEvidenceRef('ui/modules/main/observed-signal-work-items.js', 'adapter_source'),
        baseEvidenceRef('ui/__tests__/observed-signal-work-items.test.js', 'adapter_tests'),
        baseEvidenceRef('.squidrun/coord/full-agent-messages/', 'materialized_messages_dir'),
      ],
      expectedReplay: 'Clipped previews become regression work requiring full materialized reads before authority.',
      prohibitedClaims: ['preview_only_authority'],
    },
    {
      id: 'route_proof.transport_ack_is_not_visible_delivery',
      kind: 'route_proof_replay',
      evidenceRefs: [
        baseEvidenceRef('ui/scripts/hm-send.js', 'route_source'),
        baseEvidenceRef('ui/__tests__/hm-send.test.js', 'route_tests'),
        baseEvidenceRef('ui/modules/model-prompt-receipt.js', 'prompt_receipt_source'),
      ],
      expectedReplay: 'Transport ACKs such as accepted.unverified remain below ledger/history routed proof.',
      prohibitedClaims: ['transport_ack_as_delivery_proof'],
    },
    {
      id: 'metadata.wrong_context_fails_closed',
      kind: 'metadata_route_replay',
      evidenceRefs: [
        baseEvidenceRef('ui/modules/main/squidrun-app.js', 'metadata_route_guard'),
        baseEvidenceRef('ui/__tests__/squidrun-app.test.js', 'metadata_route_tests'),
      ],
      expectedReplay: 'Wrong profile/session/window metadata blocks before body text can authorize fallback.',
      prohibitedClaims: ['main_fallback_after_metadata_mismatch'],
    },
    {
      id: 'restart_compaction.recover_from_durable_authority',
      kind: 'restart_compaction_replay',
      evidenceRefs: [
        baseEvidenceRef('ui/modules/main/work-item-ledger.js', 'work_item_ledger'),
        baseEvidenceRef('.squidrun/handoffs/session.md', 'session_handoff'),
        baseEvidenceRef('ROLES.md#pre-restart-gate-mandatory', 'restart_gate_doc'),
      ],
      expectedReplay: 'Recovery uses WorkItem/current-lane/comms authority instead of stale local recollection.',
      prohibitedClaims: ['restart_from_scratch_when_durable_state_exists'],
    },
    ...PHASE4_PROTECTED_CASES.map(phase4Fixture),
  ];
}

function buildTaskReplays(basePacket = {}, resultTemplate = {}) {
  const baseTasks = taskById(basePacket.tasks);
  const templateTasks = taskById(resultTemplate.tasks);
  return UNIVERSAL_TASK_IDS.map((taskId) => {
    const baseTask = baseTasks.get(taskId) || {};
    const templateTask = templateTasks.get(taskId) || {};
    return {
      id: taskId,
      category: toOptionalString(baseTask.category, 'unknown'),
      prompt: toOptionalString(baseTask.prompt, ''),
      requiredEvidence: Array.isArray(baseTask.requiredEvidence) ? baseTask.requiredEvidence : [],
      hiddenInvariantExamples: Array.isArray(baseTask.hiddenInvariantExamples) ? baseTask.hiddenInvariantExamples : [],
      resultTemplate: {
        outcome: toOptionalString(templateTask.outcome, 'accepted-hold'),
        scoreTotal: Object.values(templateTask.scores || {}).reduce((sum, value) => {
          const numeric = Number(value);
          return Number.isFinite(numeric) ? sum + numeric : sum;
        }, 0),
        evidenceCount: Array.isArray(templateTask.evidence) ? templateTask.evidence.length : 0,
      },
      replayEvidenceRefs: evidenceRefsForTask(taskId),
      evaluatorMustFill: true,
    };
  });
}

function findReadinessBlockers(input = {}) {
  const blockers = [];
  const {
    basePacket = {},
    fableExecutionPacket = {},
    resultTemplate = {},
    taskReplays = [],
  } = input;
  const baseTaskIds = new Set((basePacket.tasks || []).map((task) => task && task.id).filter(Boolean));
  const templateTaskIds = new Set((resultTemplate.tasks || []).map((task) => task && task.id).filter(Boolean));

  for (const taskId of UNIVERSAL_TASK_IDS) {
    if (!baseTaskIds.has(taskId)) blockers.push(`base_packet_missing_task:${taskId}`);
    if (!templateTaskIds.has(taskId)) blockers.push(`result_template_missing_task:${taskId}`);
  }
  if (new Set(taskReplays.map((task) => task.id)).size !== UNIVERSAL_TASK_IDS.length) {
    blockers.push('replay_task_ids_not_unique');
  }

  const availability = resultTemplate.availability || {};
  const candidate = resultTemplate.candidate || {};
  const summary = resultTemplate.summary || {};
  if (availability.proven !== false) blockers.push('availability_must_remain_unproven_in_ready_packet');
  if (toOptionalString(availability.modelString, null)) blockers.push('availability_model_string_must_wait_for_live_run');
  if (toOptionalString(availability.noFallbackEvidence, null)) blockers.push('no_fallback_evidence_must_wait_for_live_run');
  if (toOptionalString(candidate.model, null)) blockers.push('candidate_model_must_wait_for_live_run');
  if (summary.recommendedSeatChange !== false) blockers.push('template_must_not_recommend_seat_change');
  if (fableExecutionPacket.seatChangeAuthorization?.liveSettingsChangeAllowedByThisPacket !== false) {
    blockers.push('execution_packet_must_forbid_live_settings_change');
  }
  return blockers;
}

function coverageFromFixtures(fixtures = []) {
  const ids = new Set(fixtures.map((fixture) => fixture.id));
  const phaseCases = new Set(fixtures.map((fixture) => fixture.protectedEvalCase).filter(Boolean));
  return {
    marchStaleInitiative: ids.has('observed_signal.march_stale_initiative_to_workitem'),
    fullMessageMaterialization: ids.has('observed_signal.full_message_materialization_to_regression'),
    routeProofVsTransportAck: ids.has('route_proof.transport_ack_is_not_visible_delivery'),
    wrongContextMetadata: ids.has('metadata.wrong_context_fails_closed'),
    restartCompactionRecovery: ids.has('restart_compaction.recover_from_durable_authority'),
    phase4ProtectedCases: PHASE4_PROTECTED_CASES.reduce((acc, caseId) => {
      acc[caseId] = phaseCases.has(caseId);
      return acc;
    }, {}),
  };
}

function buildRunCommands(paths = DEFAULT_PATHS) {
  return {
    copyTemplatePowerShell: `Copy-Item -LiteralPath ${paths.fableBuilderTemplate} -Destination .squidrun/coord/seat-change-bakeoff-result-fable-builder-<runid>.json`,
    scoreCandidate: `node ${paths.baseScorer} .squidrun/coord/seat-change-bakeoff-result-fable-builder-<runid>.json`,
    scoreAgainstIncumbent: `node ${paths.baseScorer} .squidrun/coord/seat-change-bakeoff-result-fable-builder-<runid>.json ${paths.incumbentBuilderResult}`,
  };
}

function buildReplayJobPacket(input = {}) {
  const paths = { ...DEFAULT_PATHS, ...(input.paths || {}) };
  const basePacket = input.basePacket || {};
  const fableExecutionPacket = input.fableExecutionPacket || {};
  const resultTemplate = input.resultTemplate || {};
  const firstCandidate = input.candidate || (Array.isArray(fableExecutionPacket.candidateOrder)
    ? fableExecutionPacket.candidateOrder[0]
    : null) || {};
  const taskReplays = buildTaskReplays(basePacket, resultTemplate);
  const replayFixtures = Array.isArray(input.replayFixtures) ? input.replayFixtures : buildReplayFixtures();
  const readinessBlockers = findReadinessBlockers({
    basePacket,
    fableExecutionPacket,
    resultTemplate,
    taskReplays,
  });
  const status = readinessBlockers.length ? 'blocked' : 'ready_to_run';

  const packet = {
    schema: MODEL_REPLAY_JOB_PACKET_SCHEMA,
    version: DEFAULT_PACKET_VERSION,
    packetId: toOptionalString(input.packetId, 'phase5.fable_builder.ready_replay_job_packet.2026-07-01'),
    createdAt: toOptionalString(input.createdAt, DEFAULT_CREATED_AT),
    status,
    readinessBlockers,
    candidate: buildCandidate(firstCandidate, resultTemplate),
    readiness: {
      readyToRun: status === 'ready_to_run',
      fableAvailabilityProven: false,
      noFallbackProven: false,
      modelSuccessProven: false,
      seatChangeEligible: false,
      seatChangeAuthorized: false,
      liveModelCallsAllowed: false,
      liveSettingsMutationAllowed: false,
      phase3AuthorityGranted: false,
      externalSendsAllowed: false,
      restartRequiredForThisPacket: false,
    },
    resultContract: {
      evaluatorAuthoredResultRequired: true,
      candidateSelfAttestationAllowed: false,
      blankTemplateExpectedToFailClosed: true,
      scorerPassIsNotSeatAuthority: true,
      jamesCheckpointRequiredBeforeSeatMutation: true,
      resultTemplatePath: normalizePath(paths.fableBuilderTemplate),
      baseRunbookPath: normalizePath(paths.baseRunbook),
      fableRunbookPath: normalizePath(paths.fableRunbook),
      scorerPath: normalizePath(paths.baseScorer),
      incumbentResultPath: normalizePath(paths.incumbentBuilderResult),
    },
    inheritedArtifacts: (Array.isArray(input.artifactRefs) ? input.artifactRefs : []).map((ref) => compactObject({
      kind: ref.kind,
      path: normalizePath(ref.path),
      exists: ref.exists,
      sha256: ref.sha256,
    })),
    commands: buildRunCommands(paths),
    taskReplays,
    replayFixtures,
    replayFixtureCoverage: coverageFromFixtures(replayFixtures),
    sideEffectPolicy: {
      localArtifactOnly: true,
      providerCalls: false,
      modelSettingsMutation: false,
      paneSeatMutation: false,
      runtimeRestart: false,
      externalSends: false,
      telegramRelayMutation: false,
      customerProductionCredentialMoneyEffects: false,
    },
  };

  packet.packetHash = sha256Object(packet);
  return packet;
}

function buildFableBuilderReplayPacket(options = {}) {
  const inputs = loadFableReturnInputs(options);
  return buildReplayJobPacket({
    ...inputs,
    createdAt: options.createdAt,
    packetId: options.packetId,
  });
}

function writeReplayJobPacket(packet, outputPath) {
  const absolutePath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
  return {
    path: absolutePath,
    sha256: sha256Text(fs.readFileSync(absolutePath)),
  };
}

module.exports = {
  DEFAULT_PATHS,
  MODEL_REPLAY_JOB_PACKET_SCHEMA,
  PHASE4_PROTECTED_CASES,
  UNIVERSAL_TASK_IDS,
  buildFableBuilderReplayPacket,
  buildReplayFixtures,
  buildReplayJobPacket,
  buildRunCommands,
  loadFableReturnInputs,
  sha256Object,
  stableJson,
  writeReplayJobPacket,
  _internals: {
    buildCandidate,
    buildTaskReplays,
    coverageFromFixtures,
    findReadinessBlockers,
  },
};
