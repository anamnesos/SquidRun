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
        "expect(result.stdout).not.toContain('Delivered to builder')",
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
        "expect(result.stdout).not.toContain('Delivered to builder')",
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

const PROTECTED_SYSTEM_EVALS = Object.freeze([
  ACCEPTED_UNVERIFIED_CASE,
  FULL_MATERIALIZED_MESSAGE_CASE,
  ROUTE_METADATA_GUARD_CASE,
  WATCHDOG_AUTONOMY_EVIDENCE_CASE,
  ROUTE_INJECT_VISIBLE_DEDUPE_CASE,
  TELEGRAM_RECALL_BODY_FIRST_CASE,
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
      && hmSendTestText.includes("expect(result.stdout).not.toContain('Delivered to builder')"),
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
    validateWatchdogAutonomySemantics,
  },
};
