'use strict';

const fs = require('fs');
const path = require('path');

const SYSTEM_PROTECTED_EVAL_SCHEMA_VERSION = 'squidrun.system_protected_evals.v0';
const CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY = 'phase4a.accepted_unverified_never_visible_delivery';
const CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ = 'phase4b.full_materialized_message_requires_full_read';
const CASE_ID_ROUTE_METADATA_GUARD = 'phase4c.route_metadata_guard_metadata_first';
const CASE_ID_WATCHDOG_AUTONOMY_EVIDENCE = 'phase4d.watchdog_autonomy_evidence_not_body_text';
const CASE_ID_ROUTE_INJECT_VISIBLE_DEDUPE = 'phase4e.route_inject_visible_dedupe_metadata_identity';
const CASE_ID_TELEGRAM_RECALL_BODY_FIRST = 'phase4f.telegram_recall_body_first';
const CASE_ID_TELEGRAM_REPLY_EGRESS_PROOF = 'phase4g.telegram_reply_debt_requires_proven_egress';
const CASE_ID_TELEGRAM_POLLER_RESTART_BOUNDARY = 'phase4h.telegram_poller_restart_is_poller_only';
const CASE_ID_TASK_QUEUE_PARKED_NEVER_AUTO_DISPATCHES = 'phase4i.task_queue_parked_never_auto_dispatches';
const CASE_ID_INJECTION_FOCUS_CONTRACT = 'phase4j.injection_focus_contract';

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '../../..');
const FULL_AGENT_MESSAGE_PATH_RE = /(?:^|\s)(?:\.squidrun[\\/]+)?coord[\\/]+full-agent-messages[\\/]+[A-Za-z0-9._-]+\.txt\b/i;
const FULL_AGENT_MESSAGE_POINTER_RE = /\bFULL MSG AT\s+([^\r\n]+)/i;

const ACCEPTED_UNVERIFIED_CASE = Object.freeze({
  id: CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY,
  phase: 'phase4a',
  title: 'accepted.unverified never counts as visible delivery',
  protectedBehavior: 'A transport ACK with accepted.unverified may be accepted by the bus, but visible delivery is not proved until a matching routed ledger row exists.',
  protectedZeroFail: true,
  authorityPolicy: 'system_eval_only_no_dispatch',
  sideEffects: Object.freeze({
    runtime: false,
    network: false,
    writes: false,
    externalSends: false,
    restart: false,
  }),
  sourceRefs: Object.freeze([
    Object.freeze({
      id: 'hm_send_visible_delivery_guard',
      path: 'ui/scripts/hm-send.js',
      anchor: 'function ackIndicatesVisibleDelivery(ack = null)',
      requiredText: 'if (ackStatusRequiresLedgerRouteProof(status)) return false;',
      reason: 'Ambiguous/unverified ACK statuses must fail before misleading verified/userVisible flags are considered.',
    }),
    Object.freeze({
      id: 'hm_send_unverified_requires_ledger_proof',
      path: 'ui/scripts/hm-send.js',
      anchor: 'function ackStatusRequiresLedgerRouteProof(value)',
      requiredText: "status.includes('unverified')",
      reason: 'accepted.unverified and routed_unverified statuses require ledger route proof.',
    }),
    Object.freeze({
      id: 'hm_send_websocket_requires_ledger_proof',
      path: 'ui/scripts/hm-send.js',
      anchor: 'function ackStatusRequiresLedgerRouteProof(value)',
      requiredText: "status === 'delivered.websocket'",
      reason: 'WebSocket-only delivery remains non-visible without route proof.',
    }),
  ]),
  testRefs: Object.freeze([
    Object.freeze({
      id: 'misleading_visible_flags_fail_closed',
      path: 'ui/__tests__/hm-send.test.js',
      testName: 'does not report accepted.unverified ack as visible delivery even with misleading visible flags',
      requiredText: Object.freeze([
        "status: 'accepted.unverified'",
        'userVisible: true',
        'verified: true',
        "expect(result.stderr).toContain('ledger route proof is missing')",
        "expect(result.stderr).toContain('ack: accepted.unverified')",
        "expect(result.stdout).not.toContain('delivered to builder')",
      ]),
    }),
    Object.freeze({
      id: 'ledger_route_proof_can_confirm_routed_unverified',
      path: 'ui/__tests__/hm-send.test.js',
      testName: 'accepts accepted-but-unverified ack only after ledger route proof confirms routed row',
      requiredText: Object.freeze([
        "ackStatus: 'routed_unverified'",
        "status: 'routed_unverified'",
        "expect(result.stdout).toContain('Route proof confirmed for builder')",
        "expect(result.stdout).toContain('Visible delivery is not claimed')",
      ]),
    }),
    Object.freeze({
      id: 'missing_route_proof_fails_closed',
      path: 'ui/__tests__/hm-send.test.js',
      testName: 'fails closed without fallback when accepted-but-unverified delivery has no routed ledger row',
      requiredText: Object.freeze([
        "expect(result.stderr).toContain('ledger route proof is missing')",
        "expect(result.stdout).not.toContain('delivered to builder')",
      ]),
    }),
    Object.freeze({
      id: 'wrong_session_route_proof_fails_closed',
      path: 'ui/__tests__/hm-send.test.js',
      testName: 'fails closed when ledger route proof is for the wrong session',
      requiredText: Object.freeze([
        "expect(result.stderr).toContain('ledger route proof is missing')",
        "expect(result.stderr).toContain('proof: ledger_route_wrong_session')",
      ]),
    }),
  ]),
  focusedCommands: Object.freeze([
    'node ui/scripts/hm-system-protected-evals.js --case phase4a.accepted_unverified_never_visible_delivery --pretty',
    'npm --prefix ui test -- system-protected-evals.test.js --runInBand',
    'npm --prefix ui test -- hm-send.test.js --runInBand --testNamePattern "accepted-but-unverified ack only after ledger route proof|accepted\\.unverified ack as visible delivery|accepted-but-unverified delivery has no routed ledger row|ledger route proof is for the wrong session|websocket-only ack as visible delivery"',
  ]),
  expectedRegressionFailures: Object.freeze([
    Object.freeze({
      id: 'accepted_unverified_visible_guard_removed',
      mutation: 'Remove the early ackStatusRequiresLedgerRouteProof guard from ackIndicatesVisibleDelivery.',
      expectedFailedCheckIds: Object.freeze(['accepted_unverified_visible_guard_before_flags']),
    }),
    Object.freeze({
      id: 'unverified_status_no_longer_requires_ledger_proof',
      mutation: 'Remove unverified matching from ackStatusRequiresLedgerRouteProof.',
      expectedFailedCheckIds: Object.freeze(['accepted_unverified_status_requires_ledger_proof']),
    }),
    Object.freeze({
      id: 'misleading_visible_flags_test_removed',
      mutation: 'Remove or rename the accepted.unverified misleading visible flags hm-send test.',
      expectedFailedCheckIds: Object.freeze(['test_ref_misleading_visible_flags_fail_closed']),
    }),
  ]),
});

const FULL_MATERIALIZED_MESSAGE_CASE = Object.freeze({
  id: CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ,
  phase: 'phase4b',
  title: 'materialized full inbound messages require full-file read',
  protectedBehavior: 'A clipped pane preview that points to .squidrun/coord/full-agent-messages/*.txt is not the complete task body; agents must read the full materialized file before acting or replying.',
  protectedZeroFail: true,
  authorityPolicy: 'system_eval_only_no_dispatch',
  sideEffects: Object.freeze({
    runtime: false,
    network: false,
    writes: false,
    externalSends: false,
    restart: false,
  }),
  sourceRefs: Object.freeze([
    Object.freeze({
      id: 'daemon_pointer_includes_full_msg_path',
      path: 'ui/modules/daemon-handlers.js',
      anchor: 'function materializeLongAgentMessageForPane(message, context = {})',
      requiredText: 'FULL MSG AT ${full.displayPath}',
      reason: 'Pane-visible previews must carry a machine-addressable full-message file path.',
    }),
    Object.freeze({
      id: 'daemon_pointer_requires_full_file_read',
      path: 'ui/modules/daemon-handlers.js',
      anchor: 'function materializeLongAgentMessageForPane(message, context = {})',
      requiredText: 'Do not act from this preview alone; read the full file, then reply via hm-send.js.',
      reason: 'The pointer must state that the preview is not authority.',
    }),
    Object.freeze({
      id: 'daemon_writes_full_message_body',
      path: 'ui/modules/daemon-handlers.js',
      anchor: 'function writeFullAgentMessageFile(message, context = {})',
      requiredText: '--- FULL MESSAGE START ---',
      reason: 'The materialized file must preserve the full body behind explicit delimiters.',
    }),
    Object.freeze({
      id: 'daemon_emits_materialized_metadata',
      path: 'ui/modules/daemon-handlers.js',
      anchor: 'function processThrottleQueue(paneId)',
      requiredText: 'materializedFullPayload: materialized.materialized === true',
      reason: 'Metadata must identify materialized payloads without depending on English body text.',
    }),
    Object.freeze({
      id: 'daemon_emits_full_payload_path',
      path: 'ui/modules/daemon-handlers.js',
      anchor: 'function processThrottleQueue(paneId)',
      requiredText: 'fullPayloadPath: materialized.displayPath || null',
      reason: 'Metadata must preserve the full materialized file path.',
    }),
    Object.freeze({
      id: 'daemon_emits_materialized_trace_event',
      path: 'ui/modules/daemon-handlers.js',
      anchor: 'function processThrottleQueue(paneId)',
      requiredText: "eventType: 'renderer_full_agent_message_materialized'",
      reason: 'The trace stream must expose a durable materialization event.',
    }),
  ]),
  testRefs: Object.freeze([
    Object.freeze({
      id: 'daemon_pointer_fixture',
      path: 'ui/__tests__/daemon-handlers.test.js',
      testName: 'materializes long hm-send payloads and injects a full-message pointer',
      requiredText: Object.freeze([
        'FULL MSG AT .squidrun/coord/full-agent-messages/hm-long-agent-message-1.txt',
        'Do not act from this preview alone',
        'expect(injectedPointer).not.toBe(longPayload)',
        '--- FULL MESSAGE START ---',
        'expect(fullMessageWrite[1]).toContain(longPayload)',
      ]),
    }),
    Object.freeze({
      id: 'observed_signal_replay_fixture',
      path: 'ui/__tests__/observed-signal-work-items.test.js',
      testName: 'replays truncation/materialization incident into a builder-owned regression WorkItem',
      requiredText: Object.freeze([
        'full_message_materialization',
        '.squidrun/coord/full-agent-messages/hm-long-inbound.txt',
        'Long inbound payload must be materialized and read before recall/context injection.',
      ]),
    }),
  ]),
  decisionFixtures: Object.freeze([
    Object.freeze({
      id: 'metadata_path_wins_without_body_phrase',
      input: Object.freeze({
        metadata: Object.freeze({
          materializedFullPayload: true,
          fullPayloadPath: '.squidrun/coord/full-agent-messages/hm-meta-only.txt',
        }),
        body: 'HEAD: clipped preview only\nTAIL: clipped preview only',
      }),
      expectedDecision: 'must_read_materialized_full_message',
      expectedAuthority: 'metadata_path',
    }),
    Object.freeze({
      id: 'body_pointer_fallback_requires_full_msg_path',
      input: Object.freeze({
        body: '[AGENT MSG] FULL MSG AT .squidrun/coord/full-agent-messages/hm-body-pointer.txt\nHEAD: not enough\nTAIL: not enough',
      }),
      expectedDecision: 'must_read_materialized_full_message',
      expectedAuthority: 'body_pointer_fallback',
    }),
    Object.freeze({
      id: 'preview_head_tail_without_path_is_not_authority',
      input: Object.freeze({
        body: 'HEAD: [AGENT MSG - reply via hm-send.js] (ARCHITECT -> BUILDER): Ship the invoice fix now; tests are green and the customer is waiting.\nTAIL: Commit it, push it, and tell James it is live. [CURRENT PROJECT] name=TrustQuote | path=D:\\projects\\TrustQuote',
      }),
      expectedDecision: 'preview_only_not_authority',
      expectedAuthority: 'none',
    }),
    Object.freeze({
      id: 'complete_non_materialized_body_is_not_blocked',
      input: Object.freeze({
        body: '(ORACLE #12): This is a complete short routed message. No materialized file pointer is present and no preview markers are present.',
      }),
      expectedDecision: 'no_materialized_full_message_signal',
      expectedAuthority: 'none',
    }),
  ]),
  focusedCommands: Object.freeze([
    'node ui/scripts/hm-system-protected-evals.js --case phase4b.full_materialized_message_requires_full_read --pretty',
    'npm --prefix ui test -- system-protected-evals.test.js daemon-handlers.test.js observed-signal-work-items.test.js --runInBand --testNamePattern "full materialized|materializes long hm-send payloads|truncation/materialization"',
  ]),
  expectedRegressionFailures: Object.freeze([
    Object.freeze({
      id: 'full_read_instruction_removed',
      mutation: 'Remove the pointer warning requiring agents to read the full materialized file.',
      expectedFailedCheckIds: Object.freeze(['source_ref_daemon_pointer_requires_full_file_read']),
    }),
    Object.freeze({
      id: 'materialized_metadata_removed',
      mutation: 'Remove materializedFullPayload/fullPayloadPath metadata from the inbound handling path.',
      expectedFailedCheckIds: Object.freeze(['full_materialized_metadata_path_emitted']),
    }),
    Object.freeze({
      id: 'preview_only_accepted_as_authority',
      mutation: 'Treat HEAD/TAIL preview text as the full task body without a full-agent-message path.',
      expectedFailedCheckIds: Object.freeze(['full_materialized_preview_only_not_authority']),
    }),
  ]),
});

const ROUTE_METADATA_GUARD_CASE = Object.freeze({
  id: CASE_ID_ROUTE_METADATA_GUARD,
  phase: 'phase4c',
  title: 'route metadata guard stays metadata-first',
  protectedBehavior: 'Pane injection route metadata is authoritative when present: body text cannot override wrong profile/session/window metadata, and metadata mismatch must fail closed without main/default fallback.',
  protectedZeroFail: true,
  authorityPolicy: 'system_eval_only_no_dispatch',
  sideEffects: Object.freeze({
    runtime: false,
    network: false,
    writes: false,
    externalSends: false,
    restart: false,
  }),
  sourceRefs: Object.freeze([
    Object.freeze({
      id: 'squidrun_app_metadata_validator_mismatch_reason',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'validateInjectRouteMetadata(packet = {}, paneId = \'\', targetWindowKey = \'main\')',
      requiredText: "reason: 'inject_route_metadata_mismatch'",
      reason: 'Wrong route metadata must expose an actionable block reason.',
    }),
    Object.freeze({
      id: 'squidrun_app_metadata_validator_profile_mismatch',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'validateInjectRouteMetadata(packet = {}, paneId = \'\', targetWindowKey = \'main\')',
      requiredText: 'profile_mismatch:${routeMetadata.profileName}->${expectedProfileName}',
      reason: 'Profile metadata mismatch must be detected before body fallback.',
    }),
    Object.freeze({
      id: 'squidrun_app_metadata_validator_session_mismatch',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'validateInjectRouteMetadata(packet = {}, paneId = \'\', targetWindowKey = \'main\')',
      requiredText: 'session_scope_mismatch:${routeMetadata.sessionScopeId}->${expectedSessionScopeId}',
      reason: 'Session metadata mismatch must be detected before body fallback.',
    }),
    Object.freeze({
      id: 'squidrun_app_route_metadata_guard_before_delivery',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'routeInjectMessage(payload = {})',
      requiredText: 'const routeValidation = this.validateInjectRouteMetadata(packet, paneId, normalizedTargetWindowKey);',
      reason: 'Route metadata must be validated before visible or hidden delivery is attempted.',
    }),
    Object.freeze({
      id: 'squidrun_app_route_metadata_guard_block_event',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'routeInjectMessage(payload = {})',
      requiredText: "deliveryPath: 'metadata_route_guard'",
      reason: 'Metadata mismatch must leave an auditable blocked handoff event.',
    }),
  ]),
  testRefs: Object.freeze([
    Object.freeze({
      id: 'correct_metadata_misleading_body_routes',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'routes correct metadata even when body text mentions another profile',
      requiredText: Object.freeze([
        'This body says Eunbyeol/scoped, but the envelope belongs to main.',
        "expect(app.routeInjectMessage({",
        "profileName: 'main'",
        "sessionScopeId: 'app-session-462'",
        'expect(app.lastInjectRouteBlock).toBeNull()',
      ]),
    }),
    Object.freeze({
      id: 'wrong_profile_metadata_plausible_body_blocks',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'blocks wrong metadata even when body text looks plausible for the target window',
      requiredText: Object.freeze([
        'Builder, this is for the main current session. Please handle it here.',
        "expect(app.routeInjectMessage({",
        'expect(sendToVisibleWindow).not.toHaveBeenCalled()',
        "reason: 'inject_route_metadata_mismatch'",
        'profile_mismatch:eunbyeol->main',
        'session_scope_mismatch:app-session-462:eunbyeol->app-session-462',
      ]),
    }),
    Object.freeze({
      id: 'wrong_session_metadata_plausible_body_blocks',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'blocks wrong session metadata even when body text looks plausible for the target window',
      requiredText: Object.freeze([
        'Builder, this body says main profile and current session; metadata says otherwise.',
        "expect(app.routeInjectMessage({",
        'expect(sendToVisibleWindow).not.toHaveBeenCalled()',
        "reason: 'inject_route_metadata_mismatch'",
        'session_scope_mismatch:app-session-999->app-session-462',
      ]),
    }),
  ]),
  focusedCommands: Object.freeze([
    'node ui/scripts/hm-system-protected-evals.js --case phase4c.route_metadata_guard_metadata_first --pretty',
    'npm --prefix ui test -- system-protected-evals.test.js --runInBand',
    'npm --prefix ui test -- squidrun-app.test.js --runInBand --testNamePattern "routes correct metadata even when body text mentions another profile|blocks wrong metadata even when body text looks plausible for the target window|blocks wrong session metadata even when body text looks plausible for the target window"',
  ]),
  expectedRegressionFailures: Object.freeze([
    Object.freeze({
      id: 'metadata_guard_removed',
      mutation: 'Remove or bypass validateInjectRouteMetadata before pane injection delivery.',
      expectedFailedCheckIds: Object.freeze(['route_metadata_guard_runs_before_delivery']),
    }),
    Object.freeze({
      id: 'body_override_wrong_metadata',
      mutation: 'Allow plausible body text to override wrong profile/session metadata.',
      expectedFailedCheckIds: Object.freeze(['route_metadata_wrong_profile_fixture_blocks']),
    }),
    Object.freeze({
      id: 'metadata_mismatch_main_fallback_allowed',
      mutation: 'Let metadata mismatch fall through to visible/main/default fallback instead of continuing fail-closed.',
      expectedFailedCheckIds: Object.freeze(['route_metadata_mismatch_blocks_before_visible_fallback']),
    }),
  ]),
});

const WATCHDOG_AUTONOMY_EVIDENCE_CASE = Object.freeze({
  id: CASE_ID_WATCHDOG_AUTONOMY_EVIDENCE,
  phase: 'phase4d',
  title: 'watchdog autonomy suppression is evidence-backed',
  protectedBehavior: 'Agent response watchdog suppression can come from explicit pending/comms-ledger/WorkItem/current-lane autonomy state, but body-only no-reply wording cannot silence explicit tasks and unresolved tasks still fire with blockers.',
  protectedZeroFail: true,
  authorityPolicy: 'system_eval_only_no_dispatch',
  sideEffects: Object.freeze({
    runtime: false,
    network: false,
    writes: false,
    externalSends: false,
    restart: false,
  }),
  sourceRefs: Object.freeze([
    Object.freeze({
      id: 'squidrun_app_watchdog_autonomy_states_declared',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'const WATCHDOG_INTENTIONAL_AUTONOMY_STATES = new Set([',
      requiredText: "'intentional_hold'",
      reason: 'Intentional autonomy states must be explicit metadata values, not inferred from body prose.',
    }),
    Object.freeze({
      id: 'squidrun_app_watchdog_pending_state_checked',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'evaluateAgentResponseWatchdogEvidence(entry = {})',
      requiredText: 'const pendingWatchdogState = findRecordIntentionalAutonomyState(entry);',
      reason: 'Pending watchdog metadata must be an authoritative suppression source.',
    }),
    Object.freeze({
      id: 'squidrun_app_watchdog_ledger_state_checked',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'evaluateAgentResponseWatchdogEvidence(entry = {})',
      requiredText: 'const ledgerIntentional = findLedgerIntentionalAutonomyResolution(rows, normalizedSenderRole, normalizedTargetRole);',
      reason: 'Comms journal metadata must be checked for explicit autonomy state before unresolved tasks fire.',
    }),
    Object.freeze({
      id: 'squidrun_app_watchdog_work_item_checked',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'evaluateAgentResponseWatchdogEvidence(entry = {})',
      requiredText: 'const workItemEvidence = this.findWorkItemWatchdogResolution(correlation, normalizedTargetRole);',
      reason: 'Correlated WorkItems must be consulted before firing a stale response watchdog.',
    }),
    Object.freeze({
      id: 'squidrun_app_watchdog_current_lane_checked',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'evaluateAgentResponseWatchdogEvidence(entry = {})',
      requiredText: 'const currentLaneEvidence = this.findCurrentLaneWatchdogResolution(correlation);',
      reason: 'Current-lane state must be consulted before firing a stale response watchdog.',
    }),
    Object.freeze({
      id: 'squidrun_app_watchdog_unresolved_blockers',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'evaluateAgentResponseWatchdogEvidence(entry = {})',
      requiredText: "reason: 'no_terminal_or_acknowledged_evidence'",
      reason: 'Unresolved watchdogs must fail open with an actionable reason instead of silently suppressing.',
    }),
  ]),
  testRefs: Object.freeze([
    Object.freeze({
      id: 'body_only_no_reply_still_fires',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'still watchdogs explicit tasks when no-reply-needed is body text only',
      requiredText: Object.freeze([
        'Verify the watchdog no-reply body text and report. No reply needed.',
        'expect(spawn).toHaveBeenCalledWith',
        '[WATCHDOG] No response from builder for task sent at 10:06. Check if task was received.',
      ]),
    }),
    Object.freeze({
      id: 'pending_no_ack_metadata_suppresses',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'suppresses response watchdog when pending entry has explicit no_ack_needed state',
      requiredText: Object.freeze([
        "responseWatchdogState: 'no_ack_needed'",
        'expect(spawn).not.toHaveBeenCalled()',
        'expect(app.pendingAgentResponseWatchdogs.size).toBe(0)',
      ]),
    }),
    Object.freeze({
      id: 'ledger_no_ack_metadata_suppresses',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'suppresses response watchdog when later ledger metadata has explicit no_ack_needed state',
      requiredText: Object.freeze([
        "responseWatchdogState: 'no_ack_needed'",
        'routeHealthRequirement',
        'expect(queryCommsJournalEntries).toHaveBeenCalledWith',
        'expect(spawn).not.toHaveBeenCalled()',
      ]),
    }),
    Object.freeze({
      id: 'work_item_intentional_hold_suppresses',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'suppresses response watchdog when correlated WorkItem has explicit intentional_hold route state',
      requiredText: Object.freeze([
        "id: 'wi-watchdog-intentional-hold'",
        "responseWatchdogState: 'intentional_hold'",
        'expect(spawn).not.toHaveBeenCalled()',
      ]),
    }),
    Object.freeze({
      id: 'current_lane_auto_proceed_suppresses',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'suppresses response watchdog when correlated current-lane has explicit auto_proceed route state',
      requiredText: Object.freeze([
        "responseWatchdogState: 'auto_proceed'",
        "source: 'work_item'",
        'expect(spawn).not.toHaveBeenCalled()',
      ]),
    }),
    Object.freeze({
      id: 'unresolved_explicit_task_reports_blockers',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'reports exact correlation blockers before architect-to-oracle watchdog fires',
      requiredText: Object.freeze([
        'Verify the watchdog blocker report and reply.',
        'Closure correlation blockers: comms_journal:no_later_resolution; work_items:no_correlating_work_item; current_lane:missing.',
        'expect(spawn).toHaveBeenCalledWith',
      ]),
    }),
  ]),
  focusedCommands: Object.freeze([
    'node ui/scripts/hm-system-protected-evals.js --case phase4d.watchdog_autonomy_evidence_not_body_text --pretty',
    'npm --prefix ui test -- system-protected-evals.test.js --runInBand',
    'npm --prefix ui test -- squidrun-app.test.js --runInBand --testNamePattern "explicit tasks when no-reply-needed is body text only|pending entry has explicit no_ack_needed state|later ledger metadata has explicit no_ack_needed state|correlated WorkItem has explicit intentional_hold route state|correlated current-lane has explicit auto_proceed route state|reports exact correlation blockers"',
  ]),
  expectedRegressionFailures: Object.freeze([
    Object.freeze({
      id: 'body_text_suppression_allowed',
      mutation: 'Treat body-only no-reply wording as enough to suppress an explicit task.',
      expectedFailedCheckIds: Object.freeze(['watchdog_body_only_no_reply_fixture_still_fires']),
    }),
    Object.freeze({
      id: 'evidence_backed_autonomy_states_ignored',
      mutation: 'Ignore explicit pending/comms-ledger/WorkItem/current-lane autonomy state.',
      expectedFailedCheckIds: Object.freeze(['watchdog_pending_autonomy_state_checked']),
    }),
    Object.freeze({
      id: 'unresolved_task_no_longer_fires',
      mutation: 'Stop unresolved explicit tasks from firing with correlation blockers.',
      expectedFailedCheckIds: Object.freeze(['watchdog_unresolved_fails_open_with_blockers']),
    }),
  ]),
});

const ROUTE_INJECT_VISIBLE_DEDUPE_CASE = Object.freeze({
  id: CASE_ID_ROUTE_INJECT_VISIBLE_DEDUPE,
  phase: 'phase4e',
  title: 'route injection visible dedupe preserves metadata identity',
  protectedBehavior: 'Visible-window pane injection dedupe collapses repeat delivery only by stable message metadata scope; fresh message IDs still route, and failed visible handoffs are not cached as delivered.',
  protectedZeroFail: true,
  authorityPolicy: 'system_eval_only_no_dispatch',
  sideEffects: Object.freeze({
    runtime: false,
    network: false,
    writes: false,
    externalSends: false,
    restart: false,
  }),
  sourceRefs: Object.freeze([
    Object.freeze({
      id: 'squidrun_app_visible_dedupe_key_stable_message_id',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'buildVisibleInjectDeliveryDedupeKey(packet = {}, paneId = \'\', windowKey = \'main\', messageId = null, options = {})',
      requiredText: 'const stableMessageId = toNonEmptyString(messageId)',
      reason: 'Visible inject dedupe must be anchored by a stable message identity, not pane body text.',
    }),
    Object.freeze({
      id: 'squidrun_app_visible_dedupe_key_metadata_scope',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'buildVisibleInjectDeliveryDedupeKey(packet = {}, paneId = \'\', windowKey = \'main\', messageId = null, options = {})',
      requiredText: 'normalizedSessionScope,',
      reason: 'Startup/session duplicate collapse must include session scope in the dedupe key.',
    }),
    Object.freeze({
      id: 'squidrun_app_visible_dedupe_key_route_kind',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'buildVisibleInjectDeliveryDedupeKey(packet = {}, paneId = \'\', windowKey = \'main\', messageId = null, options = {})',
      requiredText: 'normalizedRouteKind,',
      reason: 'Startup/session duplicate collapse must keep route kind separate from generic visible delivery.',
    }),
    Object.freeze({
      id: 'squidrun_app_visible_dedupe_duplicate_result',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'hasVisibleInjectDelivery(packet = {}, paneId = \'\', windowKey = \'main\', messageId = null, now = Date.now(), options = {})',
      requiredText: 'return { duplicate: true, dedupeKey };',
      reason: 'Existing visible inject deliveries must short-circuit as duplicate route proof, not resend.',
    }),
    Object.freeze({
      id: 'squidrun_app_route_inject_uses_visible_dedupe_before_delivery',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'routeInjectMessage(payload = {})',
      requiredText: 'const dedupe = this.hasVisibleInjectDelivery(packet, paneId, targetWindowKey, messageId, Date.now(), {',
      reason: 'routeInjectMessage must check the visible-inject dedupe cache before visible-window delivery.',
    }),
    Object.freeze({
      id: 'squidrun_app_route_inject_records_cache_after_delivery',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'routeInjectMessage(payload = {})',
      requiredText: 'this.recordVisibleInjectDelivery(dedupe.dedupeKey);',
      reason: 'Visible-inject cache is delivery proof only after a successful visible-window handoff.',
    }),
  ]),
  testRefs: Object.freeze([
    Object.freeze({
      id: 'side_profile_visible_duplicate_by_message_id',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'dedupes repeated side-profile visible-window injections by messageId',
      requiredText: Object.freeze([
        'hm-eunbyeol-visible-replay-1',
        "windowKey: 'eunbyeol'",
        "profileName: 'eunbyeol'",
        'expect(injectCalls).toHaveLength(1)',
        'expect(app.visibleInjectDeliveryCache.size).toBe(1)',
      ]),
    }),
    Object.freeze({
      id: 'startup_session_body_drift_duplicate',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'dedupes repeated startup/session injections by metadata identity before body text',
      requiredText: Object.freeze([
        'Startup context retry with changed body text.',
        "sessionScopeId: 'app-session-462'",
        "routeKind: 'startup'",
        "hm-startup-session-duplicate-1",
        "expect(dedupeKey).toContain('main|main|app-session-462|startup|2|hm-startup-session-duplicate-1|')",
      ]),
    }),
    Object.freeze({
      id: 'fresh_startup_message_ids_still_route',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'routes fresh startup/session injections when message ids differ',
      requiredText: Object.freeze([
        'hm-startup-session-fresh-1',
        'hm-startup-session-fresh-2',
        'expect(injectCalls).toHaveLength(2)',
        'expect(app.visibleInjectDeliveryCache.size).toBe(2)',
      ]),
    }),
    Object.freeze({
      id: 'failed_visible_handoff_not_cached',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'does not cache failed side-profile visible-window handoffs',
      requiredText: Object.freeze([
        '.mockReturnValueOnce(false)',
        '.mockReturnValueOnce(true)',
        'expect(app.routeInjectMessage(payload)).toBe(false)',
        'expect(app.routeInjectMessage(payload)).toBe(true)',
        "expect(sendToVisibleWindow.mock.calls.filter(([channel]) => channel === 'inject-message')).toHaveLength(2)",
      ]),
    }),
  ]),
  focusedCommands: Object.freeze([
    'node ui/scripts/hm-system-protected-evals.js --case phase4e.route_inject_visible_dedupe_metadata_identity --pretty',
    'npm --prefix ui test -- system-protected-evals.test.js --runInBand',
    'npm --prefix ui test -- squidrun-app.test.js --runInBand --testNamePattern "dedupes repeated side-profile visible-window injections by messageId|dedupes repeated startup/session injections by metadata identity before body text|routes fresh startup/session injections when message ids differ|does not cache failed side-profile visible-window handoffs"',
  ]),
  expectedRegressionFailures: Object.freeze([
    Object.freeze({
      id: 'dedupe_metadata_scope_removed',
      mutation: 'Remove session/profile/route-kind/message-id identity from the visible inject dedupe key.',
      expectedFailedCheckIds: Object.freeze(['route_inject_dedupe_key_includes_metadata_identity']),
    }),
    Object.freeze({
      id: 'failed_handoff_cached',
      mutation: 'Record visible inject cache before sendToVisibleWindow returns delivered=true.',
      expectedFailedCheckIds: Object.freeze(['route_inject_cache_recorded_only_after_successful_delivery']),
    }),
    Object.freeze({
      id: 'fresh_ids_collapsed_or_body_drift_required',
      mutation: 'Treat changed body text or distinct fresh message IDs as the duplicate authority.',
      expectedFailedCheckIds: Object.freeze(['route_inject_startup_body_drift_duplicate_fixture']),
    }),
  ]),
});

const TELEGRAM_RECALL_BODY_FIRST_CASE = Object.freeze({
  id: CASE_ID_TELEGRAM_RECALL_BODY_FIRST,
  phase: 'phase4f',
  title: 'Telegram inbound recall never hides the human body',
  protectedBehavior: 'Human/Telegram inbound formatting must keep the raw body before memory recall context; the Telegram reply-target guard stays small, and long recall is capped so the human body appears inside the first pane-injection window.',
  protectedZeroFail: true,
  authorityPolicy: 'system_eval_only_no_dispatch',
  sideEffects: Object.freeze({
    runtime: false,
    network: false,
    writes: false,
    externalSends: false,
    restart: false,
  }),
  sourceRefs: Object.freeze([
    Object.freeze({
      id: 'memory_broker_recall_returns_body_before_block',
      path: 'ui/modules/memory-broker.js',
      anchor: 'function prependRecallToMessage(message, recall, options = {})',
      requiredText: 'return `${text}\\n\\n${block}`;',
      reason: 'The shared recall formatter must append recall after the human body, not prepend it.',
    }),
    Object.freeze({
      id: 'memory_broker_recall_cap_notice_preserves_body_visibility',
      path: 'ui/modules/memory-broker.js',
      anchor: 'function formatRecallForPaneMessage(recall, options = {})',
      requiredText: '... [memory recall capped to keep the inbound message body visible]',
      reason: 'Long recall blocks must be capped with an explicit body-visibility reason.',
    }),
    Object.freeze({
      id: 'telegram_reply_target_guard_is_small_fixed_header',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'buildTelegramReplyTargetPaneMessage(message, recallContext = {})',
      requiredText: '[SQUIDRUN REPLY TARGET: TELEGRAM REQUIRED]',
      reason: 'Telegram inbound messages carry a fixed reply-target guard rather than unbounded recall/header text before the body.',
    }),
    Object.freeze({
      id: 'telegram_reply_target_wraps_body_after_guard',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'buildTelegramReplyTargetPaneMessage(message, recallContext = {})',
      requiredText: 'return `${guardLines.join(\'\\n\')}\\n\\n${text}`;',
      reason: 'The reply-target guard is the only allowed prefix before the already body-first messageWithRecall text.',
    }),
  ]),
  testRefs: Object.freeze([
    Object.freeze({
      id: 'memory_broker_long_recall_body_first_fixture',
      path: 'ui/__tests__/memory-broker.test.js',
      testName: 'keeps inbound message before capped recall context',
      requiredText: Object.freeze([
        'this is the actual body that must not disappear behind memory recall',
        'expect(injected.startsWith(`${inbound}\\n\\n${RECALL_START}`)).toBe(true)',
        'expect(recallBlock.length).toBeLessThanOrEqual(700)',
      ]),
    }),
    Object.freeze({
      id: 'telegram_body_inside_first_injection_window_fixture',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'keeps Telegram body inside first injection window before long recall context',
      requiredText: Object.freeze([
        'synthetic emergency update body that must be visible before any recall context or large header',
        'expect(headerText.length).toBeLessThan(512)',
        'expect(bodyIndex).toBeLessThan(1024)',
        'expect(Buffer.byteLength(deliveredMessage.slice(0, bodyIndex), \'utf8\')).toBeLessThan(1024)',
        'expect(bodyIndex).toBeLessThan(recallIndex)',
      ]),
    }),
    Object.freeze({
      id: 'unified_telegram_recall_body_before_block_fixture',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'prepends unified memory broker recall when ranked context exists',
      requiredText: Object.freeze([
        "expect(deliveredMessage.indexOf('[Telegram from james]: what did you do?'))",
        ".toBeLessThan(deliveredMessage.indexOf('[SQUIDRUN MEMORY RECALL]'))",
      ]),
    }),
  ]),
  focusedCommands: Object.freeze([
    'node ui/scripts/hm-system-protected-evals.js --case phase4f.telegram_recall_body_first --pretty',
    'npm --prefix ui test -- system-protected-evals.test.js --runInBand',
    'npm --prefix ui test -- memory-broker.test.js squidrun-app.test.js --runInBand --testNamePattern "keeps inbound message before capped recall context|keeps Telegram body inside first injection window before long recall context|prepends unified memory broker recall when ranked context exists"',
  ]),
  expectedRegressionFailures: Object.freeze([
    Object.freeze({
      id: 'recall_before_body',
      mutation: 'Change prependRecallToMessage to return recall before the human body.',
      expectedFailedCheckIds: Object.freeze(['telegram_recall_formatter_returns_body_before_recall']),
    }),
    Object.freeze({
      id: 'oversized_header_before_body',
      mutation: 'Let Telegram reply-target/header text grow enough that the body starts after the first 1024-byte pane-injection window.',
      expectedFailedCheckIds: Object.freeze(['telegram_reply_target_body_inside_first_injection_window_fixture']),
    }),
    Object.freeze({
      id: 'telegram_body_first_fixture_removed',
      mutation: 'Remove or rename the focused Telegram body-first fixture.',
      expectedFailedCheckIds: Object.freeze(['test_ref_telegram_body_inside_first_injection_window_fixture']),
    }),
  ]),
});

const TELEGRAM_REPLY_EGRESS_PROOF_CASE = Object.freeze({
  id: CASE_ID_TELEGRAM_REPLY_EGRESS_PROOF,
  phase: 'phase4g',
  title: 'Telegram reply debt requires proven egress',
  protectedBehavior: 'A pending Telegram reply requirement is satisfied only by proven acked Telegram egress; pane-only output and unproven, wrong-session, wrong-chat, or stale journal rows must not clear the debt.',
  protectedZeroFail: true,
  authorityPolicy: 'system_eval_only_no_dispatch',
  sideEffects: Object.freeze({
    runtime: false,
    network: false,
    writes: false,
    externalSends: false,
    restart: false,
  }),
  sourceRefs: Object.freeze([
    Object.freeze({
      id: 'telegram_reply_debt_requires_proven_egress_row',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'isProvenTelegramEgressJournalRow(row = {})',
      requiredText: "String(row.ackStatus || '').toLowerCase() === 'telegram_delivered'",
      reason: 'Only an acked outbound Telegram delivery row may satisfy reply debt.',
    }),
    Object.freeze({
      id: 'telegram_reply_debt_queries_session_scoped_outbound_telegram',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'getAckedTelegramEgressForPendingGuardResult(guard = {}, options = {})',
      requiredText: "channel: 'telegram'",
      reason: 'Journal reconciliation must query Telegram outbound rows for the pending guard session and time window.',
    }),
    Object.freeze({
      id: 'telegram_reply_debt_rejects_wrong_session_chat_and_time',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'getAckedTelegramEgressForPendingGuardResult(guard = {}, options = {})',
      requiredText: 'if (this.getCommsJournalRowSessionId(candidate) !== guardSessionId) return false;',
      reason: 'Wrong-session rows must fail before the debt can clear.',
    }),
    Object.freeze({
      id: 'telegram_reply_debt_pane_output_is_not_satisfaction',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'inspectPaneOutputForReplyGuards(paneId, text, options = {})',
      requiredText: "status: 'telegram_reply_requirement_pending_grace'",
      reason: 'Visible pane output alone keeps the guard pending and unresolved.',
    }),
    Object.freeze({
      id: 'telegram_reply_debt_deferred_nag_rechecks_journal',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'emitDeferredTelegramReplyDebtNagIfStillUnsatisfied(paneId, messageId)',
      requiredText: "reason: 'pane_output_without_telegram_egress'",
      reason: 'Deferred warning must still be grounded in missing Telegram egress, not local pane output.',
    }),
  ]),
  testRefs: Object.freeze([
    Object.freeze({
      id: 'telegram_reply_debt_acked_positive_fixture',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'clears pending Telegram reply debt from an acked hm-send Telegram journal row',
      requiredText: Object.freeze([
        "status: 'acked'",
        "ackStatus: 'telegram_delivered'",
        "status: 'telegram_reply_requirement_satisfied_by_journal'",
        "expect(app.getPendingTelegramReplyRequirement('1')).toBeNull()",
      ]),
    }),
    Object.freeze({
      id: 'telegram_reply_debt_pane_only_fixture',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'keeps Telegram reply requirements unresolved when a pane answers without Telegram egress',
      requiredText: Object.freeze([
        'I answered in the pane only.',
        "status: 'telegram_reply_requirement_pending_grace'",
        "reason: 'pane_output_without_telegram_egress'",
      ]),
    }),
    Object.freeze({
      id: 'telegram_reply_debt_wrong_chat_fixture',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'keeps reply debt unresolved when the acked Telegram journal row is for another chat',
      requiredText: Object.freeze([
        'hm-telegram-other-chat',
        "chatId: '2222222222'",
        "status: 'telegram_reply_requirement_pending_grace'",
      ]),
    }),
    Object.freeze({
      id: 'telegram_reply_debt_wrong_session_fixture',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'keeps reply debt unresolved when the acked Telegram journal row is for another session',
      requiredText: Object.freeze([
        'hm-telegram-other-session',
        "sessionId: otherSessionId",
        "expect(satisfyTelegramReplyObligation).not.toHaveBeenCalled()",
        "expect(app.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({",
      ]),
    }),
    Object.freeze({
      id: 'telegram_reply_debt_pre_inbound_fixture',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'keeps reply debt unresolved when the acked Telegram journal row predates the inbound guard',
      requiredText: Object.freeze([
        'hm-telegram-before-inbound',
        'sentAtMs: createdAtMs - 6000',
        "status: 'telegram_reply_requirement_pending_grace'",
      ]),
    }),
    Object.freeze({
      id: 'telegram_reply_debt_same_chat_adjacent_allowed_fixture',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'clears reply debt when a same-chat delivered Telegram row is tied to an adjacent inbound',
      requiredText: Object.freeze([
        'hm-telegram-other-inbound',
        "replyToMessageId: 'telegram-in-previous-1'",
        "status: 'telegram_reply_requirement_satisfied_by_journal'",
      ]),
    }),
    Object.freeze({
      id: 'telegram_reply_obligation_probe_rejection_fixture',
      path: 'ui/__tests__/telegram-reply-obligations.test.js',
      testName: 'probe explains rejected and matched Telegram egress candidates',
      requiredText: Object.freeze([
        'telegram-out-before',
        'telegram-out-cross-chat',
        'telegram-out-not-proven',
        'before_reply_obligation_window',
        'chat_mismatch',
        'not_proven_telegram_egress',
      ]),
    }),
  ]),
  focusedCommands: Object.freeze([
    'node ui/scripts/hm-system-protected-evals.js --case phase4g.telegram_reply_debt_requires_proven_egress --pretty',
    'npm --prefix ui test -- system-protected-evals.test.js --runInBand',
    'npm --prefix ui test -- squidrun-app.test.js --runInBand --testNamePattern "Telegram reply requirements unresolved when a pane answers without Telegram egress|clears pending Telegram reply debt from an acked hm-send Telegram journal row|acked Telegram journal row is for another chat|acked Telegram journal row is for another session|acked Telegram journal row predates the inbound guard|same-chat delivered Telegram row is tied to an adjacent inbound"',
    'npm --prefix ui test -- telegram-reply-obligations.test.js --runInBand --testNamePattern "probe explains rejected and matched Telegram egress candidates|reconciles same-chat adjacent replyTo egress without accepting cross-chat replies"',
  ]),
  expectedRegressionFailures: Object.freeze([
    Object.freeze({
      id: 'telegram_ack_proof_weakened',
      mutation: 'Allow recorded/unverified/non-telegram rows to satisfy Telegram reply debt.',
      expectedFailedCheckIds: Object.freeze(['telegram_reply_debt_proven_egress_requires_acked_telegram_delivery']),
    }),
    Object.freeze({
      id: 'telegram_session_chat_or_time_guard_removed',
      mutation: 'Drop session, chat, or since-window checks from Telegram reply debt reconciliation.',
      expectedFailedCheckIds: Object.freeze(['telegram_reply_debt_reconciliation_rejects_wrong_session_chat_and_time']),
    }),
    Object.freeze({
      id: 'pane_output_treated_as_satisfaction',
      mutation: 'Treat visible pane output as satisfying Telegram reply debt.',
      expectedFailedCheckIds: Object.freeze(['telegram_reply_debt_pane_output_stays_pending_fixture']),
    }),
    Object.freeze({
      id: 'wrong_session_fixture_removed',
      mutation: 'Remove or rename the wrong-session Telegram egress fixture.',
      expectedFailedCheckIds: Object.freeze(['test_ref_telegram_reply_debt_wrong_session_fixture']),
    }),
  ]),
});

const TELEGRAM_POLLER_RESTART_BOUNDARY_CASE = Object.freeze({
  id: CASE_ID_TELEGRAM_POLLER_RESTART_BOUNDARY,
  phase: 'phase4h',
  title: 'Telegram poller restart stays poller-only',
  protectedBehavior: 'The restart-telegram-poller action may restart Telegram intake only; it must not reload renderer panes, claim to activate restart-bound main-process formatter changes, or collapse into reload-renderers/main restart semantics.',
  protectedZeroFail: true,
  authorityPolicy: 'system_eval_only_no_dispatch',
  sideEffects: Object.freeze({
    runtime: false,
    network: false,
    writes: false,
    externalSends: false,
    restart: false,
  }),
  sourceRefs: Object.freeze([
    Object.freeze({
      id: 'app_control_restart_alias_separate_from_renderer_reload',
      path: 'ui/modules/main/app-control-service.js',
      anchor: 'function normalizeAction(action)',
      requiredText: "return 'restart-telegram-poller';",
      reason: 'App-control normalization keeps Telegram poller restart aliases out of the renderer reload action.',
    }),
    Object.freeze({
      id: 'app_control_restart_branch_delegates_polling_only',
      path: 'ui/modules/main/app-control-service.js',
      anchor: "if (normalizedAction === 'restart-telegram-poller')",
      requiredText: 'const result = ctx.restartTelegramPoller(payload);',
      reason: 'The app-control restart branch delegates to the Telegram poller lifecycle hook instead of enumerating windows.',
    }),
    Object.freeze({
      id: 'squidrun_app_app_control_wires_restart_hook',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: "if (data.message.type === 'app-control')",
      requiredText: 'restartTelegramPoller: (payload = {}) => this.restartTelegramPoller(payload)',
      reason: 'The WebSocket app-control context wires the restart action to SquidRunApp restartTelegramPoller.',
    }),
    Object.freeze({
      id: 'squidrun_app_restart_poller_note_no_pane_reload',
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'restartTelegramPoller(payload = {})',
      requiredText: 'Telegram poller restart requested without reloading panes.',
      reason: 'The app-level restart method explicitly states that poller restart does not reload panes.',
    }),
    Object.freeze({
      id: 'service_lifecycle_telegram_poller_restart_action',
      path: 'ui/modules/service-lifecycle-registry.js',
      anchor: "id: 'telegram-poller'",
      requiredText: "restartAction: 'restart-telegram-poller'",
      reason: 'The lifecycle registry exposes Telegram poller restart as its own service action.',
    }),
    Object.freeze({
      id: 'hm_app_restart_aliases_route_to_poller_restart',
      path: 'ui/scripts/hm-app.js',
      anchor: 'function normalizeCommand(command)',
      requiredText: "return 'restart-telegram-poller';",
      reason: 'The CLI alias layer preserves restart-telegram and reload-telegram-poller as poller-only actions.',
    }),
  ]),
  testRefs: Object.freeze([
    Object.freeze({
      id: 'app_control_restart_delegates_fixture',
      path: 'ui/__tests__/app-control-service.test.js',
      testName: 'restart-telegram-poller delegates to the app poller lifecycle without reloading panes',
      requiredText: Object.freeze([
        "action: 'restart-telegram-poller'",
        'expect(restartTelegramPoller).toHaveBeenCalledWith({ reason: \'test\' })',
      ]),
    }),
    Object.freeze({
      id: 'app_control_restart_no_window_reload_fixture',
      path: 'ui/__tests__/app-control-service.test.js',
      testName: 'restart-telegram-poller does not inspect or reload side-profile windows',
      requiredText: Object.freeze([
        'window reload path must not be used for Telegram restart',
        'expect(getAppWindows).not.toHaveBeenCalled()',
        'expect(getPaneHostWindows).not.toHaveBeenCalled()',
      ]),
    }),
    Object.freeze({
      id: 'app_control_restart_unavailable_fixture',
      path: 'ui/__tests__/app-control-service.test.js',
      testName: 'restart-telegram-poller reports unavailable when the app lacks a restart hook',
      requiredText: Object.freeze([
        "reason: 'restart_unavailable'",
      ]),
    }),
    Object.freeze({
      id: 'app_control_renderer_reload_contrast_fixture',
      path: 'ui/__tests__/app-control-service.test.js',
      testName: 'reload-renderers reloads every live window without restarting the main process',
      requiredText: Object.freeze([
        'getPaneHostWindows',
        'expect(paneHostReload).toHaveBeenCalledTimes(1)',
      ]),
    }),
    Object.freeze({
      id: 'squidrun_app_restart_no_pane_reload_fixture',
      path: 'ui/__tests__/squidrun-app.test.js',
      testName: 'restarts the Telegram poller without reloading app panes',
      requiredText: Object.freeze([
        'expect(reloadEunbyeol).not.toHaveBeenCalled()',
        'Telegram poller restart requested without reloading panes.',
      ]),
    }),
    Object.freeze({
      id: 'service_lifecycle_telegram_poller_fixture',
      path: 'ui/__tests__/service-lifecycle-registry.test.js',
      testName: 'defines Telegram poller restart as service-only and pane-safe',
      requiredText: Object.freeze([
        "restartAction: 'restart-telegram-poller'",
        'requiresMainRestart: false',
        'affectsTerminals: false',
        'safeRestart: true',
        'Restarts remote message intake without touching panes.',
      ]),
    }),
    Object.freeze({
      id: 'hm_app_restart_alias_fixture',
      path: 'ui/__tests__/hm-app.test.js',
      testName: 'keeps Telegram poller restart aliases separate from renderer reload aliases',
      requiredText: Object.freeze([
        "expect(normalizeCommand('restart-telegram')).toBe('restart-telegram-poller')",
        "expect(normalizeCommand('reload-telegram-poller')).toBe('restart-telegram-poller')",
        "expect(normalizeCommand('restart-telegram-poller')).toBe('restart-telegram-poller')",
        "expect(normalizeCommand('reload')).toBe('reload-renderers')",
        "expect(normalizeCommand('reload-renderer')).toBe('reload-renderers')",
      ]),
    }),
  ]),
  focusedCommands: Object.freeze([
    'node ui/scripts/hm-system-protected-evals.js --case phase4h.telegram_poller_restart_is_poller_only --pretty',
    'npm --prefix ui test -- system-protected-evals.test.js --runInBand',
    'npm --prefix ui test -- app-control-service.test.js --runInBand --testNamePattern "restart-telegram-poller delegates to the app poller lifecycle without reloading panes|restart-telegram-poller does not inspect or reload side-profile windows|restart-telegram-poller reports unavailable when the app lacks a restart hook|reload-renderers reloads every live window without restarting the main process"',
    'npm --prefix ui test -- squidrun-app.test.js --runInBand --testNamePattern "restarts the Telegram poller without reloading app panes"',
    'npm --prefix ui test -- service-lifecycle-registry.test.js --runInBand --testNamePattern "defines Telegram poller restart as service-only and pane-safe"',
    'npm --prefix ui test -- hm-app.test.js --runInBand --testNamePattern "keeps Telegram poller restart aliases separate from renderer reload aliases"',
  ]),
  expectedRegressionFailures: Object.freeze([
    Object.freeze({
      id: 'telegram_restart_alias_collapsed_to_renderer_reload',
      mutation: 'Map restart-telegram/reload-telegram-poller aliases to reload-renderers.',
      expectedFailedCheckIds: Object.freeze(['telegram_poller_restart_aliases_stay_separate_from_reload_renderers']),
    }),
    Object.freeze({
      id: 'telegram_restart_branch_reloads_windows',
      mutation: 'Make the restart-telegram-poller branch enumerate app/pane-host windows or call reloadIgnoringCache.',
      expectedFailedCheckIds: Object.freeze(['telegram_poller_restart_branch_does_not_reload_windows']),
    }),
    Object.freeze({
      id: 'telegram_restart_app_note_or_boundary_removed',
      mutation: 'Remove the no-pane-reload note or make SquidRunApp.restartTelegramPoller touch panes.',
      expectedFailedCheckIds: Object.freeze(['telegram_poller_app_restart_stops_and_starts_poller_only']),
    }),
    Object.freeze({
      id: 'telegram_lifecycle_registry_drift',
      mutation: 'Mark telegram-poller as main-restart/terminal-impacting or set its restart action to reload-renderers.',
      expectedFailedCheckIds: Object.freeze(['telegram_poller_lifecycle_registry_is_service_only']),
    }),
    Object.freeze({
      id: 'telegram_restart_no_reload_fixture_removed',
      mutation: 'Remove or rename the no-window-reload or CLI alias fixtures.',
      expectedFailedCheckIds: Object.freeze(['test_ref_app_control_restart_no_window_reload_fixture', 'test_ref_hm_app_restart_alias_fixture']),
    }),
  ]),
});

const TASK_QUEUE_PARKED_NEVER_AUTO_DISPATCHES_CASE = Object.freeze({
  id: CASE_ID_TASK_QUEUE_PARKED_NEVER_AUTO_DISPATCHES,
  phase: 'phase4i',
  title: 'parked owned work never auto-dispatches',
  protectedBehavior: 'Owned work in parked state is durable across restarts but is not wake-eligible, cannot activate/continue/unblock, and requires explicit unpark before it can enter the executable queue again.',
  protectedZeroFail: true,
  authorityPolicy: 'system_eval_only_no_dispatch',
  sideEffects: Object.freeze({
    runtime: false,
    network: false,
    writes: false,
    externalSends: false,
    restart: false,
  }),
  sourceRefs: Object.freeze([
    Object.freeze({
      id: 'task_queue_declares_parked_state',
      path: 'ui/scripts/hm-task-queue.js',
      anchor: 'const VALID_STATES',
      requiredText: "'parked'",
      reason: 'The queue schema must recognize parked as a first-class durable state.',
    }),
    Object.freeze({
      id: 'task_queue_wake_states_exclude_parked',
      path: 'ui/scripts/hm-task-queue.js',
      anchor: 'const WAKE_DISPATCH_STATES',
      requiredText: "const WAKE_DISPATCH_STATES = new Set(['queued', 'blocked', 'waiting']);",
      reason: 'Wake candidate collection must not include parked work.',
    }),
    Object.freeze({
      id: 'task_queue_wake_eligibility_refuses_parked',
      path: 'ui/scripts/hm-task-queue.js',
      anchor: 'function isWakeEligible',
      requiredText: "normalizeState(task.state, 'queued') === 'parked'",
      reason: 'A parked task must fail the wake-eligible predicate even if it is restart-persistent.',
    }),
    Object.freeze({
      id: 'task_queue_activate_refuses_parked',
      path: 'ui/scripts/hm-task-queue.js',
      anchor: 'function activateTask',
      requiredText: "reason: 'task_parked'",
      reason: 'Activation must require an explicit unpark transition first.',
    }),
    Object.freeze({
      id: 'task_queue_continue_refuses_parked',
      path: 'ui/scripts/hm-task-queue.js',
      anchor: 'function continueTask',
      requiredText: "reason: 'task_parked'",
      reason: 'Dispatcher continuation must fail closed if a parked task ever reaches it.',
    }),
    Object.freeze({
      id: 'task_queue_unblock_refuses_parked',
      path: 'ui/scripts/hm-task-queue.js',
      anchor: 'function unblockTask',
      requiredText: "reason: 'task_parked'",
      reason: 'Unblock must not become an implicit unpark path.',
    }),
    Object.freeze({
      id: 'task_queue_unpark_is_explicit_queued_transition',
      path: 'ui/scripts/hm-task-queue.js',
      anchor: 'function unparkTask',
      requiredText: "state: 'queued'",
      reason: 'Unpark is the explicit transition back into the executable queue.',
    }),
    Object.freeze({
      id: 'task_queue_migrates_parked_history_convention',
      path: 'ui/scripts/hm-task-queue.js',
      anchor: 'function normalizeBucket',
      requiredText: 'isParkedHistoryTask(task)',
      reason: 'The old parked_not_executed history convention must become pending parked work.',
    }),
  ]),
  testRefs: Object.freeze([
    Object.freeze({
      id: 'parked_requires_explicit_unpark_fixture',
      path: 'ui/__tests__/hm-task-queue.test.js',
      testName: 'parks owned work durably and requires explicit unpark before activation or continuation',
      requiredText: Object.freeze([
        "reason: 'task_parked'",
        'queue.unparkTask',
        "state: 'queued'",
        'restartPersistence: true',
      ]),
    }),
    Object.freeze({
      id: 'parked_never_auto_dispatches_fixture',
      path: 'ui/__tests__/hm-task-queue.test.js',
      testName: 'keeps parked work out of wake candidates and never auto-dispatches it',
      requiredText: Object.freeze([
        'expect(result.candidates).toEqual([])',
        'expect(result.dispatched).toEqual([])',
        'expect(dispatcher).not.toHaveBeenCalled()',
        "state: 'parked'",
      ]),
    }),
    Object.freeze({
      id: 'parked_history_migration_fixture',
      path: 'ui/__tests__/hm-task-queue.test.js',
      testName: 'migrates parked_not_executed history into pending parked work',
      requiredText: Object.freeze([
        "completionReason: 'parked_not_executed'",
        'expect(state.agents.builder.history).toEqual([])',
        "state: 'parked'",
        'migratedFromHistoryCompletionReason',
      ]),
    }),
  ]),
  focusedCommands: Object.freeze([
    'node ui/scripts/hm-system-protected-evals.js --case phase4i.task_queue_parked_never_auto_dispatches --pretty',
    'npm --prefix ui test -- system-protected-evals.test.js --runInBand',
    'npm --prefix ui test -- hm-task-queue.test.js --runInBand --testNamePattern "parks owned work durably and requires explicit unpark before activation or continuation|keeps parked work out of wake candidates and never auto-dispatches it|migrates parked_not_executed history into pending parked work"',
  ]),
  expectedRegressionFailures: Object.freeze([
    Object.freeze({
      id: 'parked_added_to_wake_dispatch_states',
      mutation: 'Add parked to WAKE_DISPATCH_STATES or remove the parked wake-eligibility refusal.',
      expectedFailedCheckIds: Object.freeze(['task_queue_wake_states_exclude_parked', 'task_queue_parked_wake_exclusion']),
    }),
    Object.freeze({
      id: 'activation_or_continue_allows_parked',
      mutation: 'Remove task_parked refusals from activateTask or continueTask.',
      expectedFailedCheckIds: Object.freeze(['task_queue_parked_cannot_activate_continue_or_unblock']),
    }),
    Object.freeze({
      id: 'unpark_not_explicit',
      mutation: 'Let unblock/activate silently convert parked work into executable queued work.',
      expectedFailedCheckIds: Object.freeze(['task_queue_unpark_is_only_explicit_transition']),
    }),
    Object.freeze({
      id: 'parked_history_migration_removed',
      mutation: 'Keep parked_not_executed tasks in history instead of pending parked state.',
      expectedFailedCheckIds: Object.freeze(['task_queue_parked_history_migrates_to_pending']),
    }),
  ]),
});

const INJECTION_FOCUS_CONTRACT_CASE = Object.freeze({
  id: CASE_ID_INJECTION_FOCUS_CONTRACT,
  phase: 'phase4j',
  title: 'bus injection never steals user focus',
  protectedBehavior: 'Programmatic PTY injection never moves user keyboard focus: the hm-send fast path performs no DOM focus at all, focus moved for trusted-Enter/clipboard operations is restored on EVERY completion path via the finish() choke point, stolen focus is released via blur when the prior focus element is gone, and a user re-focus mid-injection always wins over restore. (S463: agent traffic into Claude panes stole James\'s typing.)',
  protectedZeroFail: true,
  authorityPolicy: 'system_eval_only_no_dispatch',
  sideEffects: Object.freeze({
    runtime: false,
    network: false,
    writes: false,
    externalSends: false,
    restart: false,
  }),
  sourceRefs: Object.freeze([
    Object.freeze({
      id: 'injection_fast_path_never_requires_focus',
      path: 'ui/modules/terminal/injection.js',
      anchor: 'async function doSendToPane(paneId, message, onComplete, traceContext = null, behaviorOverrides = {})',
      requiredText: 'const willUseTrustedEnter = capabilities.requiresFocusForEnter && !hmSendFastEnter;',
      reason: 'The hm-send fast path is pure PTY write + PTY Enter; it must be excluded from the focus-requiring gate.',
    }),
    Object.freeze({
      id: 'injection_focus_gated_and_tracked',
      path: 'ui/modules/terminal/injection.js',
      anchor: 'async function doSendToPane(paneId, message, onComplete, traceContext = null, behaviorOverrides = {})',
      requiredText: 'if ((willUseTrustedEnter || shouldAttemptClipboardPaste) && textarea) {',
      reason: 'Focus may move ONLY for operations that genuinely need DOM focus, and only through this gate.',
    }),
    Object.freeze({
      id: 'injection_focus_move_flagged',
      path: 'ui/modules/terminal/injection.js',
      anchor: 'async function doSendToPane(paneId, message, onComplete, traceContext = null, behaviorOverrides = {})',
      requiredText: 'focusMovedByInjection = true;',
      reason: 'Every focus move by injection must be tracked so restore can be conditional and guaranteed.',
    }),
    Object.freeze({
      id: 'injection_restore_at_finish_choke_point',
      path: 'ui/modules/terminal/injection.js',
      anchor: 'async function doSendToPane(paneId, message, onComplete, traceContext = null, behaviorOverrides = {})',
      requiredText: 'restoreFocusHook();',
      reason: 'The restore hook must run inside finish() so every exit path (success, failure, timeout, early return) restores focus.',
    }),
    Object.freeze({
      id: 'injection_user_refocus_wins',
      path: 'ui/modules/terminal/injection.js',
      anchor: 'async function doSendToPane(paneId, message, onComplete, traceContext = null, behaviorOverrides = {})',
      requiredText: 'if (document.activeElement !== textarea) return; // user moved on - respect it',
      reason: 'Restore fires only while focus is still where injection put it; a user re-focus is never yanked back.',
    }),
    Object.freeze({
      id: 'injection_blur_release_branch',
      path: 'ui/modules/terminal/injection.js',
      anchor: 'async function doSendToPane(paneId, message, onComplete, traceContext = null, behaviorOverrides = {})',
      requiredText: 'textarea.blur?.();',
      reason: 'When the prior focus element is gone, stolen focus must be RELEASED, never silently left on the terminal.',
    }),
  ]),
  testRefs: Object.freeze([
    Object.freeze({
      id: 'fast_path_never_focuses',
      path: 'ui/__tests__/injection.test.js',
      testName: 'hm-send fast path NEVER focuses the pane textarea (Claude pane)',
      requiredText: Object.freeze([
        'expect(mockTextarea.focus).not.toHaveBeenCalled();',
      ]),
    }),
    Object.freeze({
      id: 'trusted_path_restores_on_completion',
      path: 'ui/__tests__/injection.test.js',
      testName: 'trusted path restores the user focus after completion',
      requiredText: Object.freeze([
        'expect(userInput.focus).toHaveBeenCalled();',
      ]),
    }),
    Object.freeze({
      id: 'restore_on_pty_failure',
      path: 'ui/__tests__/injection.test.js',
      testName: 'restores focus even when the PTY write fails',
      requiredText: Object.freeze([
        'expect(document.activeElement).toBe(userInput);',
      ]),
    }),
    Object.freeze({
      id: 'user_refocus_respected',
      path: 'ui/__tests__/injection.test.js',
      testName: 'a focus target the user chose mid-injection is respected (no yank-back)',
      requiredText: Object.freeze([
        'expect(userInput.focus).not.toHaveBeenCalled();',
        'expect(document.activeElement).toBe(otherInput);',
      ]),
    }),
    Object.freeze({
      id: 'blur_release_when_saved_focus_gone',
      path: 'ui/__tests__/injection.test.js',
      testName: 'releases stolen focus via blur when the prior focus is gone',
      requiredText: Object.freeze([
        'expect(mockTextarea.blur).toHaveBeenCalled();',
      ]),
    }),
  ]),
  focusedCommands: Object.freeze([
    'node ui/scripts/hm-system-protected-evals.js --case phase4j.injection_focus_contract --pretty',
    'npm --prefix ui test -- system-protected-evals.test.js --runInBand',
    'npm --prefix ui test -- injection.test.js --runInBand --testNamePattern "focus-steal guarantee"',
  ]),
  expectedRegressionFailures: Object.freeze([
    Object.freeze({
      id: 'fast_path_gains_focus_call',
      mutation: 'Drop the !hmSendFastEnter exclusion so the fast path focuses the textarea again.',
      expectedFailedCheckIds: Object.freeze(['source_ref_injection_fast_path_never_requires_focus']),
    }),
    Object.freeze({
      id: 'restore_leaves_finish_choke_point',
      mutation: 'Remove the restoreFocusHook() call from finish().',
      expectedFailedCheckIds: Object.freeze(['source_ref_injection_restore_at_finish_choke_point']),
    }),
    Object.freeze({
      id: 'blur_release_removed',
      mutation: 'Keep stolen focus on the terminal when the saved focus element is detached.',
      expectedFailedCheckIds: Object.freeze(['source_ref_injection_blur_release_branch', 'test_ref_blur_release_when_saved_focus_gone']),
    }),
  ]),
});

const PROTECTED_SYSTEM_EVALS = Object.freeze([
  ACCEPTED_UNVERIFIED_CASE,
  FULL_MATERIALIZED_MESSAGE_CASE,
  ROUTE_METADATA_GUARD_CASE,
  WATCHDOG_AUTONOMY_EVIDENCE_CASE,
  ROUTE_INJECT_VISIBLE_DEDUPE_CASE,
  TELEGRAM_RECALL_BODY_FIRST_CASE,
  TELEGRAM_REPLY_EGRESS_PROOF_CASE,
  TELEGRAM_POLLER_RESTART_BOUNDARY_CASE,
  TASK_QUEUE_PARKED_NEVER_AUTO_DISPATCHES_CASE,
  INJECTION_FOCUS_CONTRACT_CASE,
]);

function normalizeRelPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function uniqueStrings(values = []) {
  const out = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = String(value || '').trim();
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

function getOverrideText(overrides, relPath) {
  if (!overrides) return null;
  const normalized = normalizeRelPath(relPath);
  if (Object.prototype.hasOwnProperty.call(overrides, normalized)) return String(overrides[normalized]);
  if (Object.prototype.hasOwnProperty.call(overrides, relPath)) return String(overrides[relPath]);
  return null;
}

function readProjectFile(relPath, options = {}) {
  const normalized = normalizeRelPath(relPath);
  const override = getOverrideText(options.fileTextOverrides, normalized);
  if (override !== null) return override;
  if (typeof options.readFile === 'function') return String(options.readFile(normalized));
  const repoRoot = options.repoRoot || DEFAULT_REPO_ROOT;
  return fs.readFileSync(path.join(repoRoot, normalized), 'utf8');
}

function makeCheck(id, ok, message, details = {}) {
  return {
    id,
    ok: ok === true,
    message,
    ...details,
  };
}

function extractFunctionBlock(sourceText, signature) {
  const start = sourceText.indexOf(signature);
  if (start === -1) return '';
  let parenDepth = 0;
  let braceStart = -1;
  for (let index = start; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '(') parenDepth += 1;
    if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (char === '{' && parenDepth === 0) {
      braceStart = index;
      break;
    }
  }
  if (braceStart === -1) return sourceText.slice(start);
  let depth = 0;
  for (let index = braceStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return sourceText.slice(start, index + 1);
    }
  }
  return sourceText.slice(start);
}

function hasFullAgentMessagePath(value) {
  return FULL_AGENT_MESSAGE_PATH_RE.test(String(value || ''));
}

function extractFullAgentMessagePath(value) {
  const text = String(value || '');
  const pointerMatch = text.match(FULL_AGENT_MESSAGE_POINTER_RE);
  if (pointerMatch && hasFullAgentMessagePath(pointerMatch[1])) {
    return pointerMatch[1].trim().split(/\s+/)[0].replace(/[.,;:)]$/, '');
  }
  const pathMatch = text.match(FULL_AGENT_MESSAGE_PATH_RE);
  return pathMatch ? pathMatch[0].trim() : null;
}

function deriveFullMaterializedMessageDecision(input = {}) {
  const metadata = input && typeof input === 'object' && input.metadata && typeof input.metadata === 'object'
    ? input.metadata
    : {};
  const body = String(input?.body || input?.message || '');
  const metadataPath = metadata.fullPayloadPath
    || metadata.materializedFullPayloadPath
    || metadata.fullMessagePath
    || metadata.sourceFile
    || null;
  if ((metadata.materializedFullPayload === true || metadata.materialized === true || metadataPath) && hasFullAgentMessagePath(metadataPath)) {
    return {
      decision: 'must_read_materialized_full_message',
      authority: 'metadata_path',
      fullPayloadPath: String(metadataPath),
      previewAcceptedAsComplete: false,
      reason: 'metadata_path_requires_full_file_read',
    };
  }

  const bodyPath = extractFullAgentMessagePath(body);
  if (bodyPath && FULL_AGENT_MESSAGE_POINTER_RE.test(body)) {
    return {
      decision: 'must_read_materialized_full_message',
      authority: 'body_pointer_fallback',
      fullPayloadPath: bodyPath,
      previewAcceptedAsComplete: false,
      reason: 'body_full_msg_pointer_requires_full_file_read',
    };
  }

  const hasPreviewMarkers = /\bHEAD:\s/i.test(body) || /\bTAIL:\s/i.test(body);
  if (hasPreviewMarkers) {
    return {
      decision: 'preview_only_not_authority',
      authority: 'none',
      fullPayloadPath: null,
      previewAcceptedAsComplete: false,
      reason: 'preview_head_tail_without_materialized_path',
    };
  }

  return {
    decision: 'no_materialized_full_message_signal',
    authority: 'none',
    fullPayloadPath: null,
    previewAcceptedAsComplete: false,
    reason: 'no_full_materialized_message_evidence',
  };
}

function validateRequiredRefs(evalCase, options = {}) {
  const checks = [];
  const sourceCache = new Map();
  const testCache = new Map();

  for (const ref of evalCase.sourceRefs || []) {
    const relPath = normalizeRelPath(ref.path);
    if (!sourceCache.has(relPath)) sourceCache.set(relPath, readProjectFile(relPath, options));
    const text = sourceCache.get(relPath);
    const scope = ref.anchor ? extractFunctionBlock(text, ref.anchor) || text : text;
    const ok = scope.includes(ref.requiredText);
    checks.push(makeCheck(
      `source_ref_${ref.id}`,
      ok,
      ok ? `${ref.id} source ref present` : `${ref.id} source ref missing`,
      { path: relPath, anchor: ref.anchor, requiredText: ref.requiredText }
    ));
  }

  for (const ref of evalCase.testRefs || []) {
    const relPath = normalizeRelPath(ref.path);
    if (!testCache.has(relPath)) testCache.set(relPath, readProjectFile(relPath, options));
    const text = testCache.get(relPath);
    const testNameOk = text.includes(`test('${ref.testName}'`)
      || text.includes(`test("${ref.testName}"`)
      || text.includes(`it('${ref.testName}'`)
      || text.includes(`it("${ref.testName}"`);
    checks.push(makeCheck(
      `test_ref_${ref.id}`,
      testNameOk,
      testNameOk ? `${ref.id} test name present` : `${ref.id} test name missing`,
      { path: relPath, testName: ref.testName }
    ));
    for (const requiredText of ref.requiredText || []) {
      const ok = text.includes(requiredText);
      checks.push(makeCheck(
        `test_ref_${ref.id}_contains_${checks.length}`,
        ok,
        ok ? `${ref.id} assertion text present` : `${ref.id} assertion text missing`,
        { path: relPath, testName: ref.testName, requiredText }
      ));
    }
  }

  return checks;
}

function validateAcceptedUnverifiedSemantics(evalCase, options = {}) {
  const hmSendText = readProjectFile('ui/scripts/hm-send.js', options);
  const visibleBlock = extractFunctionBlock(hmSendText, 'function ackIndicatesVisibleDelivery(ack = null)');
  const proofBlock = extractFunctionBlock(hmSendText, 'function ackStatusRequiresLedgerRouteProof(value)');
  const checks = [];

  const guardIndex = visibleBlock.indexOf('ackStatusRequiresLedgerRouteProof(status)');
  const verifiedIndex = visibleBlock.indexOf('ack.verified === true');
  const userVisibleIndex = visibleBlock.indexOf('ack.userVisible === true');
  checks.push(makeCheck(
    'accepted_unverified_visible_guard_before_flags',
    guardIndex !== -1
      && (verifiedIndex === -1 || guardIndex < verifiedIndex)
      && (userVisibleIndex === -1 || guardIndex < userVisibleIndex),
    'ackIndicatesVisibleDelivery rejects proof-required statuses before verified/userVisible flags',
    {
      path: 'ui/scripts/hm-send.js',
      anchor: 'function ackIndicatesVisibleDelivery(ack = null)',
      guardIndex,
      verifiedIndex,
      userVisibleIndex,
    }
  ));

  checks.push(makeCheck(
    'accepted_unverified_status_requires_ledger_proof',
    proofBlock.includes("status.includes('unverified')") || proofBlock.includes('status.includes("unverified")'),
    'ackStatusRequiresLedgerRouteProof treats unverified statuses as ledger-proof-required',
    {
      path: 'ui/scripts/hm-send.js',
      anchor: 'function ackStatusRequiresLedgerRouteProof(value)',
    }
  ));

  checks.push(makeCheck(
    'websocket_status_requires_ledger_proof',
    proofBlock.includes("status === 'delivered.websocket'") || proofBlock.includes('status === "delivered.websocket"'),
    'ackStatusRequiresLedgerRouteProof treats delivered.websocket as ledger-proof-required',
    {
      path: 'ui/scripts/hm-send.js',
      anchor: 'function ackStatusRequiresLedgerRouteProof(value)',
    }
  ));

  const hmSendTestText = readProjectFile('ui/__tests__/hm-send.test.js', options);
  const hasAcceptedUnverifiedMisleadingCase = hmSendTestText.includes("test('does not report accepted.unverified ack as visible delivery even with misleading visible flags'");
  checks.push(makeCheck(
    'accepted_unverified_misleading_visible_flags_fixture',
    hasAcceptedUnverifiedMisleadingCase
      && hmSendTestText.includes("status: 'accepted.unverified'")
      && hmSendTestText.includes('userVisible: true')
      && hmSendTestText.includes('verified: true')
      && hmSendTestText.includes("expect(result.stdout).not.toContain('delivered to builder')"),
    'hm-send focused test protects misleading accepted.unverified visible flags',
    { path: 'ui/__tests__/hm-send.test.js' }
  ));

  return checks;
}

function validateFullMaterializedMessageSemantics(evalCase, options = {}) {
  const daemonText = readProjectFile('ui/modules/daemon-handlers.js', options);
  const pointerBlock = extractFunctionBlock(daemonText, 'function materializeLongAgentMessageForPane(message, context = {})');
  const processBlock = extractFunctionBlock(daemonText, 'function processThrottleQueue(paneId)');
  const deriveDecision = typeof options.deriveFullMaterializedMessageDecision === 'function'
    ? options.deriveFullMaterializedMessageDecision
    : deriveFullMaterializedMessageDecision;
  const checks = [];

  checks.push(makeCheck(
    'full_materialized_pointer_includes_path_and_read_instruction',
    pointerBlock.includes('FULL MSG AT ${full.displayPath}')
      && pointerBlock.includes('Do not act from this preview alone; read the full file, then reply via hm-send.js.')
      && pointerBlock.includes('HEAD: ${head}')
      && pointerBlock.includes('TAIL: ${tail}'),
    'pointer preview includes full-message path, read-before-action instruction, and explicit HEAD/TAIL preview markers',
    { path: 'ui/modules/daemon-handlers.js', anchor: 'function materializeLongAgentMessageForPane(message, context = {})' }
  ));

  checks.push(makeCheck(
    'full_materialized_metadata_path_emitted',
    processBlock.includes('materializedFullPayload: materialized.materialized === true')
      && processBlock.includes('fullPayloadPath: materialized.displayPath || null')
      && processBlock.includes("eventType: 'renderer_full_agent_message_materialized'")
      && processBlock.includes('fullPayloadPath: materialized.displayPath'),
    'inbound handling path emits metadata/path evidence for materialized full payloads',
    { path: 'ui/modules/daemon-handlers.js', anchor: 'function processThrottleQueue(paneId)' }
  ));

  for (const fixture of evalCase.decisionFixtures || []) {
    const decision = deriveDecision(fixture.input);
    checks.push(makeCheck(
      `full_materialized_decision_${fixture.id}`,
      decision.decision === fixture.expectedDecision && decision.authority === fixture.expectedAuthority,
      `${fixture.id} decision matches protected materialized-message contract`,
      {
        fixtureId: fixture.id,
        expectedDecision: fixture.expectedDecision,
        expectedAuthority: fixture.expectedAuthority,
        actualDecision: decision.decision,
        actualAuthority: decision.authority,
      }
    ));
  }

  const previewOnly = deriveDecision({
    body: 'HEAD: plausible but incomplete preview\nTAIL: plausible but incomplete tail',
  });
  checks.push(makeCheck(
    'full_materialized_preview_only_not_authority',
    previewOnly.decision === 'preview_only_not_authority'
      && previewOnly.previewAcceptedAsComplete === false,
    'HEAD/TAIL preview without metadata/path evidence is never accepted as complete authority',
    { decision: previewOnly }
  ));

  const phraseOnly = deriveDecision({
    body: 'Do not act from this preview alone; read the full file, then reply via hm-send.js.',
  });
  checks.push(makeCheck(
    'full_materialized_phrase_alone_not_authority',
    phraseOnly.decision !== 'must_read_materialized_full_message',
    'the English read-before-action phrase alone is not materialized-message evidence without metadata/path',
    { decision: phraseOnly }
  ));

  const completeBody = deriveDecision({
    body: '(ORACLE #12): This is a complete short routed message. No materialized file pointer is present and no preview markers are present.',
  });
  checks.push(makeCheck(
    'full_materialized_complete_non_materialized_body_not_blocked',
    completeBody.decision === 'no_materialized_full_message_signal'
      && completeBody.previewAcceptedAsComplete === false,
    'complete non-materialized message bodies are not falsely blocked by the materialized-message eval',
    { decision: completeBody }
  ));

  return checks;
}

function validateRouteMetadataGuardSemantics(evalCase, options = {}) {
  const appText = readProjectFile('ui/modules/main/squidrun-app.js', options);
  const appTestText = readProjectFile('ui/__tests__/squidrun-app.test.js', options);
  const validatorBlock = extractFunctionBlock(
    appText,
    'validateInjectRouteMetadata(packet = {}, paneId = \'\', targetWindowKey = \'main\')'
  );
  const routeBlock = extractFunctionBlock(appText, 'routeInjectMessage(payload = {})');
  const checks = [];

  checks.push(makeCheck(
    'route_metadata_validator_detects_profile_and_session_mismatch',
    validatorBlock.includes("reason: 'inject_route_metadata_mismatch'")
      && validatorBlock.includes('profile_mismatch:${routeMetadata.profileName}->${expectedProfileName}')
      && validatorBlock.includes('session_scope_mismatch:${routeMetadata.sessionScopeId}->${expectedSessionScopeId}'),
    'metadata validator detects profile/session mismatch with actionable block reason',
    { path: 'ui/modules/main/squidrun-app.js', anchor: 'validateInjectRouteMetadata(packet = {}, paneId = \'\', targetWindowKey = \'main\')' }
  ));

  const routeValidationIndex = routeBlock.indexOf('const routeValidation = this.validateInjectRouteMetadata(packet, paneId, normalizedTargetWindowKey);');
  const routeValidationBlockIndex = routeBlock.indexOf('if (!routeValidation.ok)');
  const visibleWindowIndex = routeBlock.indexOf('const visibleWindowAvailable');
  const hiddenPaneHostIndex = routeBlock.indexOf('this.pendingPaneDeliveries.set');
  const firstDeliveryIndex = [
    routeBlock.indexOf("this.sendToVisibleWindow('inject-message'"),
    hiddenPaneHostIndex,
  ].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? -1;

  checks.push(makeCheck(
    'route_metadata_guard_runs_before_delivery',
    routeValidationIndex >= 0
      && routeValidationBlockIndex > routeValidationIndex
      && (visibleWindowIndex === -1 || routeValidationBlockIndex < visibleWindowIndex)
      && (firstDeliveryIndex === -1 || routeValidationBlockIndex < firstDeliveryIndex),
    'route metadata is validated before visible/default/hidden pane delivery can happen',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'routeInjectMessage(payload = {})',
      routeValidationIndex,
      routeValidationBlockIndex,
      visibleWindowIndex,
      firstDeliveryIndex,
    }
  ));

  const mismatchBlockEnd = routeBlock.indexOf('const preferHiddenPaneHost', routeValidationBlockIndex);
  const mismatchBlock = routeValidationBlockIndex >= 0
    ? routeBlock.slice(routeValidationBlockIndex, mismatchBlockEnd >= 0 ? mismatchBlockEnd : undefined)
    : '';
  checks.push(makeCheck(
    'route_metadata_mismatch_blocks_before_visible_fallback',
    mismatchBlock.includes('this.lastInjectRouteBlock = routeValidation;')
      && mismatchBlock.includes("deliveryPath: 'metadata_route_guard'")
      && mismatchBlock.includes('success: false')
      && mismatchBlock.includes('continue;')
      && !mismatchBlock.includes("this.sendToVisibleWindow('inject-message'"),
    'metadata mismatch records an auditable block and cannot fall through to visible/default fallback',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'routeInjectMessage(payload = {})',
      mismatchBlockLength: mismatchBlock.length,
    }
  ));

  checks.push(makeCheck(
    'route_metadata_correct_metadata_fixture_routes',
    appTestText.includes("it('routes correct metadata even when body text mentions another profile'")
      && appTestText.includes('This body says Eunbyeol/scoped, but the envelope belongs to main.')
      && appTestText.includes("expect(app.routeInjectMessage({")
      && appTestText.includes("profileName: 'main'")
      && appTestText.includes("sessionScopeId: 'app-session-462'")
      && appTestText.includes('expect(app.lastInjectRouteBlock).toBeNull()'),
    'focused routeInjectMessage test proves correct metadata routes despite misleading body',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'route_metadata_wrong_profile_fixture_blocks',
    appTestText.includes("it('blocks wrong metadata even when body text looks plausible for the target window'")
      && appTestText.includes('Builder, this is for the main current session. Please handle it here.')
      && appTestText.includes('expect(sendToVisibleWindow).not.toHaveBeenCalled()')
      && appTestText.includes("reason: 'inject_route_metadata_mismatch'")
      && appTestText.includes('profile_mismatch:eunbyeol->main')
      && appTestText.includes('session_scope_mismatch:app-session-462:eunbyeol->app-session-462'),
    'focused routeInjectMessage test proves wrong profile/session metadata blocks tempting body text',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'route_metadata_wrong_session_fixture_blocks',
    appTestText.includes("it('blocks wrong session metadata even when body text looks plausible for the target window'")
      && appTestText.includes('Builder, this body says main profile and current session; metadata says otherwise.')
      && appTestText.includes('expect(sendToVisibleWindow).not.toHaveBeenCalled()')
      && appTestText.includes("reason: 'inject_route_metadata_mismatch'")
      && appTestText.includes('session_scope_mismatch:app-session-999->app-session-462'),
    'focused routeInjectMessage test proves wrong session metadata alone blocks tempting body text',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  return checks;
}

function validateWatchdogAutonomySemantics(evalCase, options = {}) {
  const appText = readProjectFile('ui/modules/main/squidrun-app.js', options);
  const appTestText = readProjectFile('ui/__tests__/squidrun-app.test.js', options);
  const evidenceBlock = extractFunctionBlock(appText, 'evaluateAgentResponseWatchdogEvidence(entry = {})');
  const workItemBlock = extractFunctionBlock(appText, 'findWorkItemWatchdogResolution(correlation = {}, targetRole = null)');
  const currentLaneBlock = extractFunctionBlock(appText, 'findCurrentLaneWatchdogResolution(correlation = {})');
  const checks = [];

  checks.push(makeCheck(
    'watchdog_autonomy_states_declared',
    appText.includes('WATCHDOG_INTENTIONAL_AUTONOMY_STATES')
      && appText.includes("'auto_proceed'")
      && appText.includes("'intentional_hold'")
      && appText.includes("'no_ack_needed'"),
    'watchdog autonomy states are explicit metadata values',
    { path: 'ui/modules/main/squidrun-app.js', anchor: 'WATCHDOG_INTENTIONAL_AUTONOMY_STATES' }
  ));

  const pendingStateIndex = evidenceBlock.indexOf('const pendingWatchdogState = findRecordIntentionalAutonomyState(entry);');
  const queryRowsIndex = evidenceBlock.indexOf('queryCommsJournalEntries({');
  checks.push(makeCheck(
    'watchdog_pending_autonomy_state_checked',
    pendingStateIndex >= 0
      && (queryRowsIndex === -1 || pendingStateIndex < queryRowsIndex)
      && evidenceBlock.includes('reason: `watchdog_${pendingWatchdogState}`')
      && evidenceBlock.includes("source: 'pending_watchdog'")
      && evidenceBlock.includes('status: pendingWatchdogState'),
    'pending watchdog metadata can explicitly suppress before ledger fallback',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'evaluateAgentResponseWatchdogEvidence(entry = {})',
      pendingStateIndex,
      queryRowsIndex,
    }
  ));

  const ledgerIntentionalIndex = evidenceBlock.indexOf('const ledgerIntentional = findLedgerIntentionalAutonomyResolution(rows, normalizedSenderRole, normalizedTargetRole);');
  const taskRowIndex = evidenceBlock.indexOf('const taskRow = {');
  checks.push(makeCheck(
    'watchdog_ledger_autonomy_state_checked_before_generic_resolution',
    ledgerIntentionalIndex >= 0
      && (taskRowIndex === -1 || ledgerIntentionalIndex < taskRowIndex)
      && evidenceBlock.includes('reason: `comms_journal_${ledgerIntentional.state}`')
      && evidenceBlock.includes("source: 'comms_journal'")
      && evidenceBlock.includes('status: ledgerIntentional.state'),
    'comms-ledger autonomy metadata can explicitly suppress before generic response heuristics',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'evaluateAgentResponseWatchdogEvidence(entry = {})',
      ledgerIntentionalIndex,
      taskRowIndex,
    }
  ));

  const workItemIndex = evidenceBlock.indexOf('const workItemEvidence = this.findWorkItemWatchdogResolution(correlation, normalizedTargetRole);');
  const currentLaneIndex = evidenceBlock.indexOf('const currentLaneEvidence = this.findCurrentLaneWatchdogResolution(correlation);');
  const finalUnresolvedIndex = evidenceBlock.indexOf("reason: 'no_terminal_or_acknowledged_evidence'");
  checks.push(makeCheck(
    'watchdog_work_item_and_current_lane_checked_before_unresolved',
    workItemIndex >= 0
      && currentLaneIndex > workItemIndex
      && finalUnresolvedIndex > currentLaneIndex,
    'correlated WorkItem/current-lane evidence is checked before unresolved watchdog firing',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'evaluateAgentResponseWatchdogEvidence(entry = {})',
      workItemIndex,
      currentLaneIndex,
      finalUnresolvedIndex,
    }
  ));

  checks.push(makeCheck(
    'watchdog_work_item_and_current_lane_autonomy_sources',
    workItemBlock.includes('const intentional = matches')
      && workItemBlock.includes('state: findRecordIntentionalAutonomyState(item)')
      && workItemBlock.includes('reason: `work_item_${intentional.state}`')
      && currentLaneBlock.includes('const intentionalState = findRecordIntentionalAutonomyState(activeLane)')
      && currentLaneBlock.includes('|| findRecordIntentionalAutonomyState(parsed)')
      && currentLaneBlock.includes('reason: `current_lane_${intentionalState}`'),
    'WorkItem and current-lane explicit autonomy state can suppress stale watchdogs',
    { path: 'ui/modules/main/squidrun-app.js' }
  ));

  checks.push(makeCheck(
    'watchdog_unresolved_fails_open_with_blockers',
    evidenceBlock.includes("reason: 'no_terminal_or_acknowledged_evidence'")
      && evidenceBlock.includes("blockers.push('comms_journal:no_later_resolution')")
      && evidenceBlock.includes('blockers.push(...workItemEvidence.blockers)')
      && evidenceBlock.includes('blockers.push(...currentLaneEvidence.blockers)')
      && evidenceBlock.includes('resolved: false'),
    'unresolved explicit tasks fail open to a watchdog with actionable blockers',
    { path: 'ui/modules/main/squidrun-app.js', anchor: 'evaluateAgentResponseWatchdogEvidence(entry = {})' }
  ));

  checks.push(makeCheck(
    'watchdog_body_only_no_reply_fixture_still_fires',
    appTestText.includes("it('still watchdogs explicit tasks when no-reply-needed is body text only'")
      && appTestText.includes('Verify the watchdog no-reply body text and report. No reply needed.')
      && appTestText.includes('expect(spawn).toHaveBeenCalledWith')
      && appTestText.includes('[WATCHDOG] No response from builder for task sent at 10:06. Check if task was received.'),
    'focused watchdog test proves body-only no-reply wording cannot suppress explicit tasks',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'watchdog_evidence_backed_autonomy_fixtures_suppress',
    appTestText.includes("it('suppresses response watchdog when pending entry has explicit no_ack_needed state'")
      && appTestText.includes("it('suppresses response watchdog when later ledger metadata has explicit no_ack_needed state'")
      && appTestText.includes("it('suppresses response watchdog when correlated WorkItem has explicit intentional_hold route state'")
      && appTestText.includes("it('suppresses response watchdog when correlated current-lane has explicit auto_proceed route state'")
      && appTestText.includes("responseWatchdogState: 'no_ack_needed'")
      && appTestText.includes("responseWatchdogState: 'intentional_hold'")
      && appTestText.includes("responseWatchdogState: 'auto_proceed'"),
    'focused watchdog tests prove evidence-backed autonomy state suppresses false watchdogs',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'watchdog_unresolved_blocker_fixture_fires',
    appTestText.includes("it('reports exact correlation blockers before architect-to-oracle watchdog fires'")
      && appTestText.includes('Verify the watchdog blocker report and reply.')
      && appTestText.includes('Closure correlation blockers: comms_journal:no_later_resolution; work_items:no_correlating_work_item; current_lane:missing.')
      && appTestText.includes('expect(spawn).toHaveBeenCalledWith'),
    'focused watchdog test proves unresolved tasks still fire with actionable blockers',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  return checks;
}

function validateRouteInjectVisibleDedupeSemantics(evalCase, options = {}) {
  const appText = readProjectFile('ui/modules/main/squidrun-app.js', options);
  const appTestText = readProjectFile('ui/__tests__/squidrun-app.test.js', options);
  const keyBlock = extractFunctionBlock(
    appText,
    'buildVisibleInjectDeliveryDedupeKey(packet = {}, paneId = \'\', windowKey = \'main\', messageId = null, options = {})'
  );
  const cacheBlock = extractFunctionBlock(
    appText,
    'hasVisibleInjectDelivery(packet = {}, paneId = \'\', windowKey = \'main\', messageId = null, now = Date.now(), options = {})'
  );
  const routeBlock = extractFunctionBlock(appText, 'routeInjectMessage(payload = {})');
  const checks = [];

  const identityTerms = [
    'normalizedWindowKey',
    'normalizedProfile',
    'normalizedSessionScope',
    'normalizedRouteKind',
    'normalizedPaneId',
    'stableMessageId',
    'chunkIndex',
    'chunkCount',
  ];
  const keyReturnStartIndex = keyBlock.indexOf('return [');
  const keyReturnEndIndex = keyBlock.indexOf("].join('|')", keyReturnStartIndex);
  const keyReturnBlock = keyReturnStartIndex >= 0 && keyReturnEndIndex > keyReturnStartIndex
    ? keyBlock.slice(keyReturnStartIndex, keyReturnEndIndex + "].join('|')".length)
    : '';
  const keyUsesBodyText = keyReturnBlock.includes('packet.message')
    || keyReturnBlock.includes('packet?.message')
    || keyReturnBlock.includes('payload.message')
    || keyReturnBlock.includes('createPayloadFingerprint')
    || keyReturnBlock.includes('payloadFingerprint');
  checks.push(makeCheck(
    'route_inject_dedupe_key_includes_metadata_identity',
    identityTerms.every((term) => keyReturnBlock.includes(term))
      && keyReturnBlock.includes("].join('|')")
      && !keyUsesBodyText,
    'visible inject dedupe key includes window/profile/session/route/pane/message/chunk identity and excludes body text',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'buildVisibleInjectDeliveryDedupeKey(packet = {}, paneId = \'\', windowKey = \'main\', messageId = null, options = {})',
      identityTerms,
      keyReturnStartIndex,
      keyReturnEndIndex,
      keyUsesBodyText,
    }
  ));

  checks.push(makeCheck(
    'route_inject_cache_detects_duplicate_entry',
    cacheBlock.includes('const entry = this.visibleInjectDeliveryCache.get(dedupeKey);')
      && cacheBlock.includes('Number(entry.expiresAt) > now')
      && cacheBlock.includes('return { duplicate: true, dedupeKey };')
      && cacheBlock.includes('this.visibleInjectDeliveryCache.delete(dedupeKey);'),
    'visible inject dedupe cache only reports unexpired entries as duplicate and prunes stale entries',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'hasVisibleInjectDelivery(packet = {}, paneId = \'\', windowKey = \'main\', messageId = null, now = Date.now(), options = {})',
    }
  ));

  const dedupeCallIndex = routeBlock.indexOf('const dedupe = this.hasVisibleInjectDelivery(packet, paneId, targetWindowKey, messageId, Date.now(), {');
  const duplicateBranchIndex = routeBlock.indexOf('if (dedupe.duplicate)', dedupeCallIndex);
  const visibleDeliveryIndex = routeBlock.indexOf("const delivered = this.sendToVisibleWindow('inject-message'", dedupeCallIndex);
  checks.push(makeCheck(
    'route_inject_dedupe_checks_before_visible_delivery',
    dedupeCallIndex >= 0
      && duplicateBranchIndex > dedupeCallIndex
      && visibleDeliveryIndex > duplicateBranchIndex,
    'routeInjectMessage checks visible-inject dedupe before visible-window delivery',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'routeInjectMessage(payload = {})',
      dedupeCallIndex,
      duplicateBranchIndex,
      visibleDeliveryIndex,
    }
  ));

  const duplicateBranch = duplicateBranchIndex >= 0 && visibleDeliveryIndex > duplicateBranchIndex
    ? routeBlock.slice(duplicateBranchIndex, visibleDeliveryIndex)
    : '';
  checks.push(makeCheck(
    'route_inject_duplicate_branch_skips_resend',
    duplicateBranch.includes("eventType: 'pane_ipc_handoff_deduped'")
      && duplicateBranch.includes('success: true')
      && duplicateBranch.includes('routed = true;')
      && duplicateBranch.includes('continue;')
      && !duplicateBranch.includes("sendToVisibleWindow('inject-message'"),
    'duplicate visible-inject path records a deduped handoff and skips resend',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'routeInjectMessage(payload = {})',
      duplicateBranchLength: duplicateBranch.length,
    }
  ));

  const recordCallIndex = routeBlock.indexOf('this.recordVisibleInjectDelivery(dedupe.dedupeKey);', visibleDeliveryIndex);
  const deliveredBlockIndex = routeBlock.lastIndexOf('if (delivered) {', recordCallIndex);
  const continueAfterRecordIndex = routeBlock.indexOf('continue;', recordCallIndex);
  const firstRecordIndex = routeBlock.indexOf('this.recordVisibleInjectDelivery(dedupe.dedupeKey);');
  checks.push(makeCheck(
    'route_inject_cache_recorded_only_after_successful_delivery',
    visibleDeliveryIndex >= 0
      && deliveredBlockIndex > visibleDeliveryIndex
      && recordCallIndex > deliveredBlockIndex
      && firstRecordIndex === recordCallIndex
      && continueAfterRecordIndex > recordCallIndex,
    'visible-inject delivery cache is recorded only inside the successful delivered branch',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'routeInjectMessage(payload = {})',
      visibleDeliveryIndex,
      deliveredBlockIndex,
      recordCallIndex,
      firstRecordIndex,
      continueAfterRecordIndex,
    }
  ));

  checks.push(makeCheck(
    'route_inject_side_profile_duplicate_fixture',
    appTestText.includes("it('dedupes repeated side-profile visible-window injections by messageId'")
      && appTestText.includes('hm-eunbyeol-visible-replay-1')
      && appTestText.includes("windowKey: 'eunbyeol'")
      && appTestText.includes("profileName: 'eunbyeol'")
      && appTestText.includes('expect(injectCalls).toHaveLength(1)')
      && appTestText.includes('expect(app.visibleInjectDeliveryCache.size).toBe(1)'),
    'focused routeInjectMessage test proves side-profile duplicate visible-window inject collapses by message/window/profile',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'route_inject_startup_body_drift_duplicate_fixture',
    appTestText.includes("it('dedupes repeated startup/session injections by metadata identity before body text'")
      && appTestText.includes('Startup context retry with changed body text.')
      && appTestText.includes("sessionScopeId: 'app-session-462'")
      && appTestText.includes("routeKind: 'startup'")
      && appTestText.includes('hm-startup-session-duplicate-1')
      && appTestText.includes("expect(dedupeKey).toContain('main|main|app-session-462|startup|2|hm-startup-session-duplicate-1|')"),
    'focused routeInjectMessage test proves startup/session duplicate collapse is metadata-first and body-drift tolerant',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'route_inject_fresh_message_ids_still_route_fixture',
    appTestText.includes("it('routes fresh startup/session injections when message ids differ'")
      && appTestText.includes('hm-startup-session-fresh-1')
      && appTestText.includes('hm-startup-session-fresh-2')
      && appTestText.includes('expect(injectCalls).toHaveLength(2)')
      && appTestText.includes('expect(app.visibleInjectDeliveryCache.size).toBe(2)'),
    'focused routeInjectMessage test proves distinct fresh message IDs still route',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'route_inject_failed_handoff_not_cached_fixture',
    appTestText.includes("it('does not cache failed side-profile visible-window handoffs'")
      && appTestText.includes('.mockReturnValueOnce(false)')
      && appTestText.includes('.mockReturnValueOnce(true)')
      && appTestText.includes('expect(app.routeInjectMessage(payload)).toBe(false)')
      && appTestText.includes('expect(app.routeInjectMessage(payload)).toBe(true)')
      && appTestText.includes("expect(sendToVisibleWindow.mock.calls.filter(([channel]) => channel === 'inject-message')).toHaveLength(2)"),
    'focused routeInjectMessage test proves failed visible handoffs are not cached and can retry',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  return checks;
}

function validateTelegramRecallBodyFirstSemantics(evalCase, options = {}) {
  const memoryBrokerText = readProjectFile('ui/modules/memory-broker.js', options);
  const appText = readProjectFile('ui/modules/main/squidrun-app.js', options);
  const memoryBrokerTestText = readProjectFile('ui/__tests__/memory-broker.test.js', options);
  const appTestText = readProjectFile('ui/__tests__/squidrun-app.test.js', options);
  const prependBlock = extractFunctionBlock(memoryBrokerText, 'function prependRecallToMessage(message, recall, options = {})');
  const formatBlock = extractFunctionBlock(memoryBrokerText, 'function formatRecallForPaneMessage(recall, options = {})');
  const replyTargetBlock = extractFunctionBlock(appText, 'buildTelegramReplyTargetPaneMessage(message, recallContext = {})');
  const deliverBlock = extractFunctionBlock(appText, 'async deliverHumanMessageWithRecall(message, recallContext = {}, logLabel = \'HumanMessage\')');
  const checks = [];

  const bodyFirstReturnIndex = prependBlock.indexOf('return `${text}\\n\\n${block}`;');
  const recallFirstReturnIndex = prependBlock.indexOf('return `${block}\\n\\n${text}`;');
  const blockCreationIndex = prependBlock.indexOf('const block = formatRecallForPaneMessage(recall, options);');
  checks.push(makeCheck(
    'telegram_recall_formatter_returns_body_before_recall',
    bodyFirstReturnIndex >= 0
      && recallFirstReturnIndex === -1
      && (blockCreationIndex === -1 || bodyFirstReturnIndex > blockCreationIndex),
    'shared recall formatter returns the human body before the recall block',
    {
      path: 'ui/modules/memory-broker.js',
      anchor: 'function prependRecallToMessage(message, recall, options = {})',
      bodyFirstReturnIndex,
      recallFirstReturnIndex,
      blockCreationIndex,
    }
  ));

  checks.push(makeCheck(
    'telegram_recall_block_is_capped_for_body_visibility',
    formatBlock.includes('const maxChars = clampInt(options.maxChars, DEFAULT_RECALL_BLOCK_MAX_CHARS, 400, 10000);')
      && formatBlock.includes('... [memory recall capped to keep the inbound message body visible]')
      && formatBlock.includes('return `${block.slice(0, budget).trimEnd()}${notice}${closing}`;'),
    'long memory recall blocks are capped with a body-visibility notice',
    { path: 'ui/modules/memory-broker.js', anchor: 'function formatRecallForPaneMessage(recall, options = {})' }
  ));

  const messageWithRecallIndex = deliverBlock.indexOf('const messageWithRecall = await this.buildHumanMessageWithUnifiedRecall(message, recallContext, logLabel);');
  const replyTargetWrapIndex = deliverBlock.indexOf('? this.buildTelegramReplyTargetPaneMessage(messageWithRecall, recallContext)');
  const deliverCallIndex = deliverBlock.indexOf('const result = await this.deliverPaneMessageReliably({');
  checks.push(makeCheck(
    'telegram_delivery_wraps_body_first_recall_before_reliable_delivery',
    messageWithRecallIndex >= 0
      && replyTargetWrapIndex > messageWithRecallIndex
      && deliverCallIndex > replyTargetWrapIndex,
    'Telegram delivery builds body-first recall text before adding reply-target guard and reliable pane delivery',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'async deliverHumanMessageWithRecall(message, recallContext = {}, logLabel = \'HumanMessage\')',
      messageWithRecallIndex,
      replyTargetWrapIndex,
      deliverCallIndex,
    }
  ));

  const guardLineCount = (replyTargetBlock.match(/\[SQUIDRUN REPLY TARGET: TELEGRAM REQUIRED\]|Source: Telegram from|Reply via `hm-send telegram \.\.\.`|\[END SQUIDRUN REPLY TARGET\]/g) || []).length;
  checks.push(makeCheck(
    'telegram_reply_target_header_is_fixed_and_bounded',
    replyTargetBlock.includes('const guardLines = [')
      && replyTargetBlock.includes('[SQUIDRUN REPLY TARGET: TELEGRAM REQUIRED]')
      && replyTargetBlock.includes('[END SQUIDRUN REPLY TARGET]')
      && replyTargetBlock.includes('Reply via `hm-send telegram ...`')
      && replyTargetBlock.includes('return `${guardLines.join(\'\\n\')}\\n\\n${text}`;')
      && guardLineCount === 4,
    'Telegram reply-target header is a small fixed guard before the already body-first payload',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'buildTelegramReplyTargetPaneMessage(message, recallContext = {})',
      guardLineCount,
    }
  ));

  checks.push(makeCheck(
    'telegram_memory_broker_long_recall_body_first_fixture',
    memoryBrokerTestText.includes("test('keeps inbound message before capped recall context'")
      && memoryBrokerTestText.includes('this is the actual body that must not disappear behind memory recall')
      && memoryBrokerTestText.includes('expect(injected.startsWith(`${inbound}\\n\\n${RECALL_START}`)).toBe(true)')
      && memoryBrokerTestText.includes('expect(recallBlock.length).toBeLessThanOrEqual(700)'),
    'focused memory-broker test proves long recall stays after the human body and is capped',
    { path: 'ui/__tests__/memory-broker.test.js' }
  ));

  checks.push(makeCheck(
    'telegram_reply_target_body_inside_first_injection_window_fixture',
    appTestText.includes("it('keeps Telegram body inside first injection window before long recall context'")
      && appTestText.includes('synthetic emergency update body that must be visible before any recall context or large header')
      && appTestText.includes('expect(headerText.length).toBeLessThan(512)')
      && appTestText.includes('expect(bodyIndex).toBeLessThan(1024)')
      && appTestText.includes("expect(Buffer.byteLength(deliveredMessage.slice(0, bodyIndex), 'utf8')).toBeLessThan(1024)")
      && appTestText.includes('expect(bodyIndex).toBeLessThan(recallIndex)'),
    'focused Telegram delivery test proves the body appears before recall inside the 1024-byte failure window',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'telegram_unified_recall_existing_fixture_body_before_block',
    appTestText.includes("it('prepends unified memory broker recall when ranked context exists'")
      && appTestText.includes("expect(deliveredMessage.indexOf('[Telegram from james]: what did you do?'))")
      && appTestText.includes(".toBeLessThan(deliveredMessage.indexOf('[SQUIDRUN MEMORY RECALL]'))"),
    'existing unified Telegram recall fixture keeps the Telegram body before memory recall',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  return checks;
}

function validateTelegramReplyEgressProofSemantics(evalCase, options = {}) {
  const appText = readProjectFile('ui/modules/main/squidrun-app.js', options);
  const appTestText = readProjectFile('ui/__tests__/squidrun-app.test.js', options);
  const obligationTestText = readProjectFile('ui/__tests__/telegram-reply-obligations.test.js', options);
  const provenBlock = extractFunctionBlock(appText, 'isProvenTelegramEgressJournalRow(row = {})');
  const reconcileBlock = extractFunctionBlock(appText, 'getAckedTelegramEgressForPendingGuardResult(guard = {}, options = {})');
  const inspectBlock = extractFunctionBlock(appText, 'inspectPaneOutputForReplyGuards(paneId, text, options = {})');
  const deferredBlock = extractFunctionBlock(appText, 'emitDeferredTelegramReplyDebtNagIfStillUnsatisfied(paneId, messageId)');
  const checks = [];

  checks.push(makeCheck(
    'telegram_reply_debt_proven_egress_requires_acked_telegram_delivery',
    provenBlock.includes("String(row.channel || '').toLowerCase() === 'telegram'")
      && provenBlock.includes("String(row.direction || '').toLowerCase() === 'outbound'")
      && provenBlock.includes("String(row.status || '').toLowerCase() === 'acked'")
      && provenBlock.includes("String(row.ackStatus || '').toLowerCase() === 'telegram_delivered'")
      && provenBlock.includes('(hasTelegramTargetSignal || hasUserTelegramTargetSignal)'),
    'proven Telegram egress requires outbound acked telegram_delivered delivery with a Telegram/user target signal',
    { path: 'ui/modules/main/squidrun-app.js', anchor: 'isProvenTelegramEgressJournalRow(row = {})' }
  ));

  const queryIndex = reconcileBlock.indexOf('rows = queryFn({');
  const sessionQueryIndex = reconcileBlock.indexOf('sessionId: guardSessionId');
  const channelQueryIndex = reconcileBlock.indexOf("channel: 'telegram'");
  const directionQueryIndex = reconcileBlock.indexOf("direction: 'outbound'");
  const sinceQueryIndex = queryIndex >= 0 ? reconcileBlock.indexOf('sinceMs,', queryIndex) : -1;
  checks.push(makeCheck(
    'telegram_reply_debt_reconciliation_queries_scoped_outbound_telegram',
    queryIndex >= 0
      && sessionQueryIndex > queryIndex
      && channelQueryIndex > queryIndex
      && directionQueryIndex > queryIndex
      && sinceQueryIndex > queryIndex,
    'journal reconciliation queries only session-scoped outbound Telegram rows since the pending guard window',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'getAckedTelegramEgressForPendingGuardResult(guard = {}, options = {})',
      queryIndex,
      sessionQueryIndex,
      channelQueryIndex,
      directionQueryIndex,
      sinceQueryIndex,
    }
  ));

  checks.push(makeCheck(
    'telegram_reply_debt_reconciliation_rejects_wrong_session_chat_and_time',
    reconcileBlock.includes('if (this.getCommsJournalRowSessionId(candidate) !== guardSessionId) return false;')
      && reconcileBlock.includes('if (rowTimestampMs < sinceMs) return false;')
      && reconcileBlock.includes('if (guardChatId && rowChatId && rowChatId !== guardChatId) return false;'),
    'journal reconciliation rejects wrong-session, stale, and cross-chat Telegram rows before satisfaction',
    { path: 'ui/modules/main/squidrun-app.js', anchor: 'getAckedTelegramEgressForPendingGuardResult(guard = {}, options = {})' }
  ));

  checks.push(makeCheck(
    'telegram_reply_debt_allows_exact_or_same_chat_adjacent_match',
    reconcileBlock.includes('if (!replyToMessageId || replyToMessageId === guardMessageId) return true;')
      && reconcileBlock.includes('return Boolean(guardChatId && rowChatId && guardChatId === rowChatId);'),
    'journal reconciliation permits exact replyTo matches and same-chat adjacent replies without accepting cross-chat rows',
    { path: 'ui/modules/main/squidrun-app.js', anchor: 'getAckedTelegramEgressForPendingGuardResult(guard = {}, options = {})' }
  ));

  checks.push(makeCheck(
    'telegram_reply_debt_pane_output_requires_journal_satisfaction_first',
    inspectBlock.includes('const journalSatisfaction = this.reconcilePendingTelegramReplyGuardWithJournal(normalizedPaneId, guard);')
      && inspectBlock.includes("status: journalSatisfaction.status")
      && inspectBlock.includes("guard.status = 'telegram_reply_required_unresolved'")
      && inspectBlock.includes("status: 'telegram_reply_requirement_pending_grace'"),
    'pane output checks journal satisfaction first, then keeps visible-only output pending/unresolved',
    { path: 'ui/modules/main/squidrun-app.js', anchor: 'inspectPaneOutputForReplyGuards(paneId, text, options = {})' }
  ));

  checks.push(makeCheck(
    'telegram_reply_debt_deferred_warning_rechecks_journal_before_nag',
    deferredBlock.includes('const journalSatisfaction = this.reconcilePendingTelegramReplyGuardWithJournal(normalizedPaneId, guard);')
      && deferredBlock.includes("reason: 'pane_output_without_telegram_egress'")
      && deferredBlock.includes("status: 'telegram_reply_requirement_unresolved'"),
    'deferred reply-debt warning rechecks journal egress before emitting a pane-output debt warning',
    { path: 'ui/modules/main/squidrun-app.js', anchor: 'emitDeferredTelegramReplyDebtNagIfStillUnsatisfied(paneId, messageId)' }
  ));

  checks.push(makeCheck(
    'telegram_reply_debt_acked_positive_fixture',
    appTestText.includes("it('clears pending Telegram reply debt from an acked hm-send Telegram journal row'")
      && appTestText.includes("status: 'acked'")
      && appTestText.includes("ackStatus: 'telegram_delivered'")
      && appTestText.includes("status: 'telegram_reply_requirement_satisfied_by_journal'")
      && appTestText.includes("expect(app.getPendingTelegramReplyRequirement('1')).toBeNull()"),
    'focused squidrun-app test proves an acked Telegram journal row clears the pending guard',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'telegram_reply_debt_pane_output_stays_pending_fixture',
    appTestText.includes("it('keeps Telegram reply requirements unresolved when a pane answers without Telegram egress'")
      && appTestText.includes('I answered in the pane only.')
      && appTestText.includes("status: 'telegram_reply_requirement_pending_grace'")
      && appTestText.includes("reason: 'pane_output_without_telegram_egress'"),
    'focused squidrun-app test proves pane-only answers do not satisfy Telegram reply debt',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'telegram_reply_debt_wrong_chat_fixture',
    appTestText.includes("it('keeps reply debt unresolved when the acked Telegram journal row is for another chat'")
      && appTestText.includes('hm-telegram-other-chat')
      && appTestText.includes("chatId: '2222222222'")
      && appTestText.includes("status: 'telegram_reply_requirement_pending_grace'"),
    'focused squidrun-app test proves cross-chat Telegram rows do not satisfy the guard',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'telegram_reply_debt_wrong_session_fixture',
    appTestText.includes("it('keeps reply debt unresolved when the acked Telegram journal row is for another session'")
      && appTestText.includes('hm-telegram-other-session')
      && appTestText.includes('sessionId: otherSessionId')
      && appTestText.includes('expect(satisfyTelegramReplyObligation).not.toHaveBeenCalled()')
      && appTestText.includes("expect(app.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({"),
    'focused squidrun-app test proves wrong-session Telegram rows do not satisfy the guard',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'telegram_reply_debt_pre_inbound_fixture',
    appTestText.includes("it('keeps reply debt unresolved when the acked Telegram journal row predates the inbound guard'")
      && appTestText.includes('hm-telegram-before-inbound')
      && appTestText.includes('sentAtMs: createdAtMs - 6000')
      && appTestText.includes("status: 'telegram_reply_requirement_pending_grace'"),
    'focused squidrun-app test proves stale pre-inbound Telegram rows do not satisfy the guard',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'telegram_reply_debt_same_chat_adjacent_allowed_fixture',
    appTestText.includes("it('clears reply debt when a same-chat delivered Telegram row is tied to an adjacent inbound'")
      && appTestText.includes('hm-telegram-other-inbound')
      && appTestText.includes("replyToMessageId: 'telegram-in-previous-1'")
      && appTestText.includes("status: 'telegram_reply_requirement_satisfied_by_journal'"),
    'focused squidrun-app test proves same-chat adjacent replies remain valid egress proof',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'telegram_reply_obligation_probe_rejects_unproven_wrong_chat_and_stale_candidates',
    obligationTestText.includes("test('probe explains rejected and matched Telegram egress candidates'")
      && obligationTestText.includes('telegram-out-before')
      && obligationTestText.includes('telegram-out-cross-chat')
      && obligationTestText.includes('telegram-out-not-proven')
      && obligationTestText.includes('before_reply_obligation_window')
      && obligationTestText.includes('chat_mismatch')
      && obligationTestText.includes('not_proven_telegram_egress'),
    'focused durable obligation probe explains stale, cross-chat, and unproven rejection reasons',
    { path: 'ui/__tests__/telegram-reply-obligations.test.js' }
  ));

  return checks;
}

function validateTelegramPollerRestartBoundarySemantics(evalCase, options = {}) {
  const appControlText = readProjectFile('ui/modules/main/app-control-service.js', options);
  const squidrunAppText = readProjectFile('ui/modules/main/squidrun-app.js', options);
  const lifecycleText = readProjectFile('ui/modules/service-lifecycle-registry.js', options);
  const hmAppText = readProjectFile('ui/scripts/hm-app.js', options);
  const appControlTestText = readProjectFile('ui/__tests__/app-control-service.test.js', options);
  const squidrunAppTestText = readProjectFile('ui/__tests__/squidrun-app.test.js', options);
  const lifecycleTestText = readProjectFile('ui/__tests__/service-lifecycle-registry.test.js', options);
  const hmAppTestText = readProjectFile('ui/__tests__/hm-app.test.js', options);
  const normalizeActionBlock = extractFunctionBlock(appControlText, 'function normalizeAction(action)');
  const reloadBranch = extractFunctionBlock(appControlText, "if (normalizedAction === 'reload-renderers')");
  const restartBranch = extractFunctionBlock(appControlText, "if (normalizedAction === 'restart-telegram-poller')");
  const appControlContextBlock = extractFunctionBlock(squidrunAppText, "if (data.message.type === 'app-control')");
  const appRestartBlock = extractFunctionBlock(squidrunAppText, 'restartTelegramPoller(payload = {})');
  const hmAppNormalizeBlock = extractFunctionBlock(hmAppText, 'function normalizeCommand(command)');
  const lifecycleTelegramStart = lifecycleText.indexOf("id: 'telegram-poller'");
  const lifecycleTelegramEnd = lifecycleTelegramStart >= 0
    ? lifecycleText.indexOf("id: 'voice-broker'", lifecycleTelegramStart)
    : -1;
  const lifecycleTelegramBlock = lifecycleTelegramStart >= 0
    ? lifecycleText.slice(lifecycleTelegramStart, lifecycleTelegramEnd >= 0 ? lifecycleTelegramEnd : lifecycleText.length)
    : '';
  const checks = [];

  checks.push(makeCheck(
    'telegram_poller_restart_aliases_stay_separate_from_reload_renderers',
    normalizeActionBlock.includes("normalized === 'restart-telegram-poller'")
      && normalizeActionBlock.includes("normalized === 'reload-telegram-poller'")
      && normalizeActionBlock.includes("normalized === 'restart-telegram'")
      && normalizeActionBlock.includes("return 'restart-telegram-poller';")
      && normalizeActionBlock.includes("return 'reload-renderers';")
      && hmAppNormalizeBlock.includes("normalized === 'restart-telegram'")
      && hmAppNormalizeBlock.includes("normalized === 'reload-telegram-poller'")
      && hmAppNormalizeBlock.includes("return 'restart-telegram-poller';")
      && hmAppNormalizeBlock.includes("normalized === 'reload'")
      && hmAppNormalizeBlock.includes("normalized === 'reload-renderer'")
      && hmAppNormalizeBlock.includes("return 'reload-renderers';"),
    'app-control and hm-app aliases keep Telegram poller restart separate from renderer reload',
    {
      path: 'ui/modules/main/app-control-service.js',
      companionPath: 'ui/scripts/hm-app.js',
    }
  ));

  checks.push(makeCheck(
    'telegram_poller_restart_branch_delegates_to_polling_hook',
    restartBranch.includes('typeof ctx.restartTelegramPoller !== \'function\'')
      && restartBranch.includes('const result = ctx.restartTelegramPoller(payload);')
      && restartBranch.includes('action: normalizedAction')
      && !restartBranch.includes('getAppWindows')
      && !restartBranch.includes('getPaneHostWindows')
      && !restartBranch.includes('reloadIgnoringCache')
      && !restartBranch.includes('reload-renderers')
      && !restartBranch.includes('restart-electron-main'),
    'restart-telegram-poller branch delegates to the poller hook and does not inspect/reload renderer windows',
    {
      path: 'ui/modules/main/app-control-service.js',
      anchor: "if (normalizedAction === 'restart-telegram-poller')",
    }
  ));

  checks.push(makeCheck(
    'telegram_poller_renderer_reload_branch_remains_separate',
    reloadBranch.includes('ctx.getAppWindows()')
      && reloadBranch.includes('ctx.getPaneHostWindows()')
      && reloadBranch.includes('windowRef.webContents.reloadIgnoringCache()')
      && reloadBranch.includes("action: normalizedAction")
      && !reloadBranch.includes('restartTelegramPoller'),
    'renderer reload remains a distinct branch that reloads windows without invoking Telegram poller restart',
    {
      path: 'ui/modules/main/app-control-service.js',
      anchor: "if (normalizedAction === 'reload-renderers')",
    }
  ));

  checks.push(makeCheck(
    'telegram_poller_app_control_context_wires_restart_hook',
    appControlContextBlock.includes('restartTelegramPoller: (payload = {}) => this.restartTelegramPoller(payload)')
      && appControlContextBlock.includes('getAppWindows: () => this.getAppWindows()')
      && appControlContextBlock.includes('getPaneHostWindows: () => this.paneHostWindowManager?.getPaneHostWindows?.() || []'),
    'SquidRunApp app-control context exposes both branches while wiring Telegram restart to restartTelegramPoller',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: "if (data.message.type === 'app-control')",
    }
  ));

  checks.push(makeCheck(
    'telegram_poller_app_restart_stops_and_starts_poller_only',
    appRestartBlock.includes('this.inboundPollerService.stopTelegram();')
      && appRestartBlock.includes('const started = this.startTelegramPoller();')
      && appRestartBlock.includes('Telegram poller restart requested without reloading panes.')
      && !appRestartBlock.includes('reloadIgnoringCache')
      && !appRestartBlock.includes('getAppWindows')
      && !appRestartBlock.includes('getPaneHostWindows')
      && !appRestartBlock.includes('reload-renderers'),
    'SquidRunApp.restartTelegramPoller stops/starts Telegram intake and preserves the no-pane-reload boundary note',
    {
      path: 'ui/modules/main/squidrun-app.js',
      anchor: 'restartTelegramPoller(payload = {})',
    }
  ));

  checks.push(makeCheck(
    'telegram_poller_lifecycle_registry_is_service_only',
    lifecycleTelegramBlock.includes("restartAction: 'restart-telegram-poller'")
      && lifecycleTelegramBlock.includes('requiresMainRestart: false')
      && lifecycleTelegramBlock.includes('affectsTerminals: false')
      && lifecycleTelegramBlock.includes('safeRestart: true')
      && lifecycleTelegramBlock.includes('Restarts remote message intake without touching panes.')
      && !lifecycleTelegramBlock.includes("restartAction: 'reload-renderers'")
      && !lifecycleTelegramBlock.includes("restartAction: 'restart-electron-main'")
      && lifecycleText.includes("id: 'main-ipc'")
      && lifecycleText.includes("restartAction: 'restart-electron-main'")
      && lifecycleText.includes('requiresMainRestart: true'),
    'service lifecycle registry marks Telegram poller as a pane-safe service restart, distinct from main IPC restart',
    {
      path: 'ui/modules/service-lifecycle-registry.js',
      anchor: "id: 'telegram-poller'",
    }
  ));

  checks.push(makeCheck(
    'telegram_poller_app_control_no_window_reload_fixture',
    appControlTestText.includes("test('restart-telegram-poller delegates to the app poller lifecycle without reloading panes'")
      && appControlTestText.includes("test('restart-telegram-poller does not inspect or reload side-profile windows'")
      && appControlTestText.includes('window reload path must not be used for Telegram restart')
      && appControlTestText.includes('expect(getAppWindows).not.toHaveBeenCalled()')
      && appControlTestText.includes('expect(getPaneHostWindows).not.toHaveBeenCalled()')
      && appControlTestText.includes("test('reload-renderers reloads every live window without restarting the main process'"),
    'app-control focused fixtures prove restart-poller avoids window reload paths and reload-renderers remains the contrast path',
    { path: 'ui/__tests__/app-control-service.test.js' }
  ));

  checks.push(makeCheck(
    'telegram_poller_squidrun_app_no_pane_reload_fixture',
    squidrunAppTestText.includes("it('restarts the Telegram poller without reloading app panes'")
      && squidrunAppTestText.includes('expect(reloadEunbyeol).not.toHaveBeenCalled()')
      && squidrunAppTestText.includes('Telegram poller restart requested without reloading panes.'),
    'SquidRunApp focused fixture proves restartTelegramPoller does not reload panes and keeps the boundary note',
    { path: 'ui/__tests__/squidrun-app.test.js' }
  ));

  checks.push(makeCheck(
    'telegram_poller_lifecycle_registry_fixture',
    lifecycleTestText.includes("test('defines Telegram poller restart as service-only and pane-safe'")
      && lifecycleTestText.includes("restartAction: 'restart-telegram-poller'")
      && lifecycleTestText.includes('requiresMainRestart: false')
      && lifecycleTestText.includes('affectsTerminals: false')
      && lifecycleTestText.includes('safeRestart: true')
      && lifecycleTestText.includes('Restarts remote message intake without touching panes.'),
    'service-lifecycle-registry focused fixture protects Telegram poller restart metadata',
    { path: 'ui/__tests__/service-lifecycle-registry.test.js' }
  ));

  checks.push(makeCheck(
    'telegram_poller_hm_app_alias_fixture',
    hmAppTestText.includes("test('keeps Telegram poller restart aliases separate from renderer reload aliases'")
      && hmAppTestText.includes("expect(normalizeCommand('restart-telegram')).toBe('restart-telegram-poller')")
      && hmAppTestText.includes("expect(normalizeCommand('reload-telegram-poller')).toBe('restart-telegram-poller')")
      && hmAppTestText.includes("expect(normalizeCommand('restart-telegram-poller')).toBe('restart-telegram-poller')")
      && hmAppTestText.includes("expect(normalizeCommand('reload')).toBe('reload-renderers')")
      && hmAppTestText.includes("expect(normalizeCommand('reload-renderer')).toBe('reload-renderers')"),
    'hm-app focused fixture protects CLI alias separation for poller restart versus renderer reload',
    { path: 'ui/__tests__/hm-app.test.js' }
  ));

  return checks;
}

function validateTaskQueueParkedSemantics(evalCase, options = {}) {
  const queueText = readProjectFile('ui/scripts/hm-task-queue.js', options);
  const queueTestText = readProjectFile('ui/__tests__/hm-task-queue.test.js', options);
  const validStatesBlock = extractFunctionBlock(queueText, 'const VALID_STATES');
  const wakeStatesBlock = extractFunctionBlock(queueText, 'const WAKE_DISPATCH_STATES');
  const wakeEligibleBlock = extractFunctionBlock(queueText, 'function isWakeEligible');
  const normalizeBucketBlock = extractFunctionBlock(queueText, 'function normalizeBucket');
  const activateBlock = extractFunctionBlock(queueText, 'function activateTask');
  const continueBlock = extractFunctionBlock(queueText, 'function continueTask');
  const unblockBlock = extractFunctionBlock(queueText, 'function unblockTask');
  const parkBlock = extractFunctionBlock(queueText, 'function parkTask');
  const unparkBlock = extractFunctionBlock(queueText, 'function unparkTask');
  const checks = [];

  checks.push(makeCheck(
    'task_queue_parked_state_is_first_class_schema',
    queueText.includes('const QUEUE_SCHEMA_VERSION = 3;')
      && validStatesBlock.includes("'parked'")
      && queueText.includes('function parkTask')
      && queueText.includes('function unparkTask')
      && queueText.includes('PARKED_HISTORY_COMPLETION_REASON'),
    'task queue declares parked as a first-class schema state with park/unpark helpers and migration constant',
    { path: 'ui/scripts/hm-task-queue.js' }
  ));

  checks.push(makeCheck(
    'task_queue_parked_wake_exclusion',
    wakeStatesBlock.includes("'queued'")
      && wakeStatesBlock.includes("'blocked'")
      && wakeStatesBlock.includes("'waiting'")
      && !wakeStatesBlock.includes("'parked'")
      && wakeEligibleBlock.includes("normalizeState(task.state, 'queued') === 'parked'")
      && wakeEligibleBlock.indexOf("normalizeState(task.state, 'queued') === 'parked'") < wakeEligibleBlock.indexOf('WAKE_DISPATCH_STATES.has'),
    'parked tasks are excluded both from WAKE_DISPATCH_STATES and the wake-eligible predicate',
    {
      path: 'ui/scripts/hm-task-queue.js',
      wakeStatesAnchor: 'const WAKE_DISPATCH_STATES',
      wakeEligibleAnchor: 'function isWakeEligible',
    }
  ));

  checks.push(makeCheck(
    'task_queue_parked_cannot_activate_continue_or_unblock',
    activateBlock.includes("reason: 'task_parked'")
      && continueBlock.includes("reason: 'task_parked'")
      && unblockBlock.includes("reason: 'task_parked'")
      && activateBlock.includes('isParkedTask(bucket.pending[index])')
      && continueBlock.includes('isParkedTask(found.task)')
      && unblockBlock.includes('isParkedTask(found.task)'),
    'activate, continue, and unblock all refuse parked tasks with task_parked',
    { path: 'ui/scripts/hm-task-queue.js' }
  ));

  checks.push(makeCheck(
    'task_queue_park_action_moves_active_to_pending_parked',
    parkBlock.includes("state: 'parked'")
      && parkBlock.includes('restartPersistence: true')
      && parkBlock.includes('bucket.active = null;')
      && parkBlock.includes('bucket.pending.unshift(parked)')
      && parkBlock.includes('blockedReason: parkedReason'),
    'parkTask makes active work non-active pending parked work with restart persistence',
    { path: 'ui/scripts/hm-task-queue.js', anchor: 'function parkTask' }
  ));

  checks.push(makeCheck(
    'task_queue_unpark_is_only_explicit_transition',
    unparkBlock.includes("reason: 'task_id_required'")
      && unparkBlock.includes("reason: 'task_not_parked'")
      && unparkBlock.includes("state: 'queued'")
      && unblockBlock.includes("reason: 'task_parked'")
      && activateBlock.includes("reason: 'task_parked'"),
    'only unparkTask can convert parked work back to queued, and it requires an explicit task id',
    { path: 'ui/scripts/hm-task-queue.js', anchor: 'function unparkTask' }
  ));

  checks.push(makeCheck(
    'task_queue_parked_history_migrates_to_pending',
    normalizeBucketBlock.includes('isParkedHistoryTask(task)')
      && normalizeBucketBlock.includes('toParkedTask(task, agent)')
      && normalizeBucketBlock.includes('pending.push(parked)')
      && normalizeBucketBlock.includes('retainedHistory.push(task)'),
    'normalizeBucket migrates parked_not_executed history entries into pending parked tasks while retaining normal history',
    { path: 'ui/scripts/hm-task-queue.js', anchor: 'function normalizeBucket' }
  ));

  checks.push(makeCheck(
    'task_queue_parked_focused_fixtures_prove_non_dispatch',
    queueTestText.includes("it('parks owned work durably and requires explicit unpark before activation or continuation'")
      && queueTestText.includes("it('keeps parked work out of wake candidates and never auto-dispatches it'")
      && queueTestText.includes('expect(dispatcher).not.toHaveBeenCalled()')
      && queueTestText.includes("it('migrates parked_not_executed history into pending parked work'")
      && queueTestText.includes("completionReason: 'parked_not_executed'"),
    'hm-task-queue focused fixtures cover explicit unpark, no auto-dispatch, and parked history migration',
    { path: 'ui/__tests__/hm-task-queue.test.js' }
  ));

  return checks;
}

function validateCaseMetadata(evalCase) {
  const sideEffects = evalCase.sideEffects || {};
  return [
    makeCheck(
      'stable_case_id',
      /^[a-z0-9_.:-]+$/.test(String(evalCase.id || '')),
      'case id is stable and machine-addressable',
      { caseId: evalCase.id || null }
    ),
    makeCheck(
      'protected_zero_fail',
      evalCase.protectedZeroFail === true,
      'case is marked protected zero-fail',
      { protectedZeroFail: evalCase.protectedZeroFail === true }
    ),
    makeCheck(
      'system_eval_only_no_dispatch',
      evalCase.authorityPolicy === 'system_eval_only_no_dispatch',
      'case does not grant dispatcher authority',
      { authorityPolicy: evalCase.authorityPolicy || null }
    ),
    makeCheck(
      'no_runtime_network_write_side_effects',
      sideEffects.runtime === false
        && sideEffects.network === false
        && sideEffects.writes === false
        && sideEffects.externalSends === false
        && sideEffects.restart === false,
      'case runner is static and has no runtime/network/write/send/restart side effects',
      { sideEffects }
    ),
    makeCheck(
      'has_expected_regression_failures',
      Array.isArray(evalCase.expectedRegressionFailures) && evalCase.expectedRegressionFailures.length >= 3,
      'case declares concrete regression mutations that must fail the eval',
      { expectedRegressionFailures: evalCase.expectedRegressionFailures || [] }
    ),
  ];
}

function validateProtectedSystemEvalCase(evalCase, options = {}) {
  const checks = [
    ...validateCaseMetadata(evalCase),
    ...validateRequiredRefs(evalCase, options),
  ];
  if (evalCase.id === CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY) {
    checks.push(...validateAcceptedUnverifiedSemantics(evalCase, options));
  }
  if (evalCase.id === CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ) {
    checks.push(...validateFullMaterializedMessageSemantics(evalCase, options));
  }
  if (evalCase.id === CASE_ID_ROUTE_METADATA_GUARD) {
    checks.push(...validateRouteMetadataGuardSemantics(evalCase, options));
  }
  if (evalCase.id === CASE_ID_WATCHDOG_AUTONOMY_EVIDENCE) {
    checks.push(...validateWatchdogAutonomySemantics(evalCase, options));
  }
  if (evalCase.id === CASE_ID_ROUTE_INJECT_VISIBLE_DEDUPE) {
    checks.push(...validateRouteInjectVisibleDedupeSemantics(evalCase, options));
  }
  if (evalCase.id === CASE_ID_TELEGRAM_RECALL_BODY_FIRST) {
    checks.push(...validateTelegramRecallBodyFirstSemantics(evalCase, options));
  }
  if (evalCase.id === CASE_ID_TELEGRAM_REPLY_EGRESS_PROOF) {
    checks.push(...validateTelegramReplyEgressProofSemantics(evalCase, options));
  }
  if (evalCase.id === CASE_ID_TELEGRAM_POLLER_RESTART_BOUNDARY) {
    checks.push(...validateTelegramPollerRestartBoundarySemantics(evalCase, options));
  }
  if (evalCase.id === CASE_ID_TASK_QUEUE_PARKED_NEVER_AUTO_DISPATCHES) {
    checks.push(...validateTaskQueueParkedSemantics(evalCase, options));
  }
  const failures = checks.filter((check) => !check.ok);
  return {
    id: evalCase.id,
    title: evalCase.title,
    phase: evalCase.phase,
    protectedZeroFail: evalCase.protectedZeroFail === true,
    status: failures.length ? 'failed' : 'passed',
    sourceRefs: evalCase.sourceRefs,
    testRefs: evalCase.testRefs,
    focusedCommands: evalCase.focusedCommands,
    expectedRegressionFailures: evalCase.expectedRegressionFailures,
    checks,
    failures,
  };
}

function buildSystemProtectedEvalRunPlan(options = {}) {
  const ids = uniqueStrings(options.caseIds || options.caseId || []);
  const cases = ids.length
    ? PROTECTED_SYSTEM_EVALS.filter((evalCase) => ids.includes(evalCase.id))
    : Array.from(PROTECTED_SYSTEM_EVALS);
  const missingCaseIds = ids.filter((id) => !cases.some((evalCase) => evalCase.id === id));
  return {
    schema: SYSTEM_PROTECTED_EVAL_SCHEMA_VERSION,
    runner: 'squidrun_system_protected_eval_static_runner_v0',
    mode: 'static_source_and_test_refs_only',
    sideEffects: {
      runtime: false,
      network: false,
      writes: false,
      externalSends: false,
      restart: false,
    },
    cases,
    missingCaseIds,
    focusedCommands: uniqueStrings(cases.flatMap((evalCase) => evalCase.focusedCommands || [])),
  };
}

function runSystemProtectedEvals(options = {}) {
  const plan = buildSystemProtectedEvalRunPlan(options);
  const cases = plan.cases.map((evalCase) => validateProtectedSystemEvalCase(evalCase, options));
  const failures = cases.flatMap((evalCase) => evalCase.failures.map((failure) => ({
    caseId: evalCase.id,
    checkId: failure.id,
    message: failure.message,
    path: failure.path || null,
  })));
  for (const missingCaseId of plan.missingCaseIds) {
    failures.push({
      caseId: missingCaseId,
      checkId: 'missing_case_id',
      message: 'requested case id is not registered',
      path: null,
    });
  }

  const ok = failures.length === 0;
  return {
    schema: SYSTEM_PROTECTED_EVAL_SCHEMA_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    runner: plan.runner,
    mode: plan.mode,
    ok,
    verdict: ok ? 'passed' : 'failed',
    summary: {
      caseCount: cases.length,
      protectedZeroFailCount: cases.filter((evalCase) => evalCase.protectedZeroFail).length,
      passed: cases.filter((evalCase) => evalCase.status === 'passed').length,
      failed: cases.filter((evalCase) => evalCase.status === 'failed').length + plan.missingCaseIds.length,
      missingCaseIds: plan.missingCaseIds,
    },
    sideEffects: plan.sideEffects,
    focusedCommands: plan.focusedCommands,
    cases,
    failures,
  };
}

module.exports = {
  CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY,
  CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ,
  CASE_ID_ROUTE_METADATA_GUARD,
  CASE_ID_ROUTE_INJECT_VISIBLE_DEDUPE,
  CASE_ID_TELEGRAM_RECALL_BODY_FIRST,
  CASE_ID_TELEGRAM_REPLY_EGRESS_PROOF,
  CASE_ID_TELEGRAM_POLLER_RESTART_BOUNDARY,
  CASE_ID_TASK_QUEUE_PARKED_NEVER_AUTO_DISPATCHES,
  CASE_ID_WATCHDOG_AUTONOMY_EVIDENCE,
  PROTECTED_SYSTEM_EVALS,
  SYSTEM_PROTECTED_EVAL_SCHEMA_VERSION,
  buildSystemProtectedEvalRunPlan,
  deriveFullMaterializedMessageDecision,
  runSystemProtectedEvals,
  validateProtectedSystemEvalCase,
  _internals: {
    DEFAULT_REPO_ROOT,
    extractFullAgentMessagePath,
    extractFunctionBlock,
    hasFullAgentMessagePath,
    readProjectFile,
    validateAcceptedUnverifiedSemantics,
    validateFullMaterializedMessageSemantics,
    validateRouteMetadataGuardSemantics,
    validateRouteInjectVisibleDedupeSemantics,
    validateRequiredRefs,
    validateTelegramRecallBodyFirstSemantics,
    validateTelegramReplyEgressProofSemantics,
    validateTelegramPollerRestartBoundarySemantics,
    validateTaskQueueParkedSemantics,
    validateWatchdogAutonomySemantics,
  },
};
