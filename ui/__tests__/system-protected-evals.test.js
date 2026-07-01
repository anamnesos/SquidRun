'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY,
  CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ,
  CASE_ID_ROUTE_METADATA_GUARD,
  CASE_ID_WATCHDOG_AUTONOMY_EVIDENCE,
  SYSTEM_PROTECTED_EVAL_SCHEMA_VERSION,
  buildSystemProtectedEvalRunPlan,
  deriveFullMaterializedMessageDecision,
  runSystemProtectedEvals,
} = require('../modules/main/system-protected-evals');

const repoRoot = path.resolve(__dirname, '../..');

function readRel(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function defaultOverrides(overrides = {}) {
  return {
    'ui/scripts/hm-send.js': overrides.hmSend || readRel('ui/scripts/hm-send.js'),
    'ui/__tests__/hm-send.test.js': overrides.hmSendTest || readRel('ui/__tests__/hm-send.test.js'),
    'ui/modules/daemon-handlers.js': overrides.daemonHandlers || readRel('ui/modules/daemon-handlers.js'),
    'ui/__tests__/daemon-handlers.test.js': overrides.daemonHandlersTest || readRel('ui/__tests__/daemon-handlers.test.js'),
    'ui/__tests__/observed-signal-work-items.test.js': overrides.observedSignalTest || readRel('ui/__tests__/observed-signal-work-items.test.js'),
    'ui/modules/main/squidrun-app.js': overrides.squidrunApp || readRel('ui/modules/main/squidrun-app.js'),
    'ui/__tests__/squidrun-app.test.js': overrides.squidrunAppTest || readRel('ui/__tests__/squidrun-app.test.js'),
  };
}

function checkIds(report) {
  return report.cases.flatMap((evalCase) => evalCase.checks.map((check) => check.id));
}

function failedCheckIds(report) {
  return report.failures.map((failure) => failure.checkId);
}

describe('system protected evals', () => {
  test('registers Phase 4A accepted.unverified as a protected zero-fail eval with no side effects', () => {
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY],
      generatedAt: '2026-06-30T00:00:00.000Z',
    });

    expect(report.ok).toBe(true);
    expect(report.schema).toBe(SYSTEM_PROTECTED_EVAL_SCHEMA_VERSION);
    expect(report.runner).toBe('squidrun_system_protected_eval_static_runner_v0');
    expect(report.mode).toBe('static_source_and_test_refs_only');
    expect(report.sideEffects).toEqual({
      runtime: false,
      network: false,
      writes: false,
      externalSends: false,
      restart: false,
    });
    expect(report.summary).toEqual(expect.objectContaining({
      caseCount: 1,
      protectedZeroFailCount: 1,
      passed: 1,
      failed: 0,
    }));
    expect(report.focusedCommands).toEqual(expect.arrayContaining([
      expect.stringContaining('hm-system-protected-evals.js --case phase4a.accepted_unverified_never_visible_delivery'),
      expect.stringContaining('hm-send.test.js'),
    ]));
    expect(checkIds(report)).toEqual(expect.arrayContaining([
      'accepted_unverified_visible_guard_before_flags',
      'accepted_unverified_status_requires_ledger_proof',
      'accepted_unverified_misleading_visible_flags_fixture',
      'test_ref_misleading_visible_flags_fail_closed',
    ]));
  });

  test('exposes source and focused hm-send test refs needed for future gates', () => {
    const plan = buildSystemProtectedEvalRunPlan({
      caseIds: [CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY],
    });
    const [evalCase] = plan.cases;

    expect(evalCase.id).toBe(CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY);
    expect(evalCase.sourceRefs.map((ref) => ref.id)).toEqual([
      'hm_send_visible_delivery_guard',
      'hm_send_unverified_requires_ledger_proof',
      'hm_send_websocket_requires_ledger_proof',
    ]);
    expect(evalCase.testRefs.map((ref) => ref.testName)).toEqual(expect.arrayContaining([
      'does not report accepted.unverified ack as visible delivery even with misleading visible flags',
      'accepts accepted-but-unverified ack only after ledger route proof confirms routed row',
      'fails closed without fallback when accepted-but-unverified delivery has no routed ledger row',
      'fails closed when ledger route proof is for the wrong session',
    ]));
    expect(evalCase.expectedRegressionFailures.map((failure) => failure.id)).toEqual([
      'accepted_unverified_visible_guard_removed',
      'unverified_status_no_longer_requires_ledger_proof',
      'misleading_visible_flags_test_removed',
    ]);
  });

  test('fails if accepted.unverified can reach visible-delivery flags before ledger proof', () => {
    const hmSend = readRel('ui/scripts/hm-send.js').replace(
      '  if (ackStatusRequiresLedgerRouteProof(status)) return false;\n',
      ''
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY],
      fileTextOverrides: defaultOverrides({ hmSend }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('accepted_unverified_visible_guard_before_flags');
    expect(failedCheckIds(report)).toContain('source_ref_hm_send_visible_delivery_guard');
  });

  test('fails if unverified ACK statuses no longer require ledger route proof', () => {
    const hmSend = readRel('ui/scripts/hm-send.js').replace(
      "    status.includes('unverified')\n",
      "    false\n"
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY],
      fileTextOverrides: defaultOverrides({ hmSend }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('accepted_unverified_status_requires_ledger_proof');
    expect(failedCheckIds(report)).toContain('source_ref_hm_send_unverified_requires_ledger_proof');
  });

  test('fails if the misleading accepted.unverified fixture is removed or renamed', () => {
    const hmSendTest = readRel('ui/__tests__/hm-send.test.js').replace(
      "does not report accepted.unverified ack as visible delivery even with misleading visible flags",
      'renamed accepted unverified fixture'
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY],
      fileTextOverrides: defaultOverrides({ hmSendTest }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('test_ref_misleading_visible_flags_fail_closed');
    expect(failedCheckIds(report)).toContain('accepted_unverified_misleading_visible_flags_fixture');
  });

  test('CLI prints reusable JSON and exits nonzero for missing cases', () => {
    const ok = spawnSync(
      process.execPath,
      ['ui/scripts/hm-system-protected-evals.js', '--case', CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    expect(ok.status).toBe(0);
    const payload = JSON.parse(ok.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.cases[0].id).toBe(CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY);
    expect(payload.sideEffects.externalSends).toBe(false);

    const missing = spawnSync(
      process.execPath,
      ['ui/scripts/hm-system-protected-evals.js', '--case', 'phase4a.missing_case'],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    expect(missing.status).toBe(1);
    const missingPayload = JSON.parse(missing.stdout);
    expect(missingPayload.ok).toBe(false);
    expect(failedCheckIds(missingPayload)).toContain('missing_case_id');
  });

  test('registers Phase 4B full materialized message as metadata-first protected eval', () => {
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ],
      generatedAt: '2026-06-30T00:00:00.000Z',
    });

    expect(report.ok).toBe(true);
    expect(report.summary).toEqual(expect.objectContaining({
      caseCount: 1,
      protectedZeroFailCount: 1,
      passed: 1,
      failed: 0,
    }));
    expect(report.focusedCommands).toEqual(expect.arrayContaining([
      expect.stringContaining('hm-system-protected-evals.js --case phase4b.full_materialized_message_requires_full_read'),
      expect.stringContaining('daemon-handlers.test.js'),
    ]));
    expect(checkIds(report)).toEqual(expect.arrayContaining([
      'full_materialized_pointer_includes_path_and_read_instruction',
      'full_materialized_metadata_path_emitted',
      'full_materialized_decision_metadata_path_wins_without_body_phrase',
      'full_materialized_decision_body_pointer_fallback_requires_full_msg_path',
      'full_materialized_decision_preview_head_tail_without_path_is_not_authority',
      'full_materialized_decision_complete_non_materialized_body_is_not_blocked',
      'full_materialized_preview_only_not_authority',
      'full_materialized_phrase_alone_not_authority',
      'full_materialized_complete_non_materialized_body_not_blocked',
    ]));
  });

  test('Phase 4B exposes daemon source refs and concrete materialized-message fixtures', () => {
    const plan = buildSystemProtectedEvalRunPlan({
      caseIds: [CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ],
    });
    const [evalCase] = plan.cases;

    expect(evalCase.id).toBe(CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ);
    expect(evalCase.sourceRefs.map((ref) => ref.id)).toEqual([
      'daemon_pointer_includes_full_msg_path',
      'daemon_pointer_requires_full_file_read',
      'daemon_writes_full_message_body',
      'daemon_emits_materialized_metadata',
      'daemon_emits_full_payload_path',
      'daemon_emits_materialized_trace_event',
    ]);
    expect(evalCase.testRefs.map((ref) => ref.testName)).toEqual(expect.arrayContaining([
      'materializes long hm-send payloads and injects a full-message pointer',
      'replays truncation/materialization incident into a builder-owned regression WorkItem',
    ]));
    expect(evalCase.expectedRegressionFailures.map((failure) => failure.id)).toEqual([
      'full_read_instruction_removed',
      'materialized_metadata_removed',
      'preview_only_accepted_as_authority',
    ]);
  });

  test('Phase 4B decision helper treats metadata/path as authority and phrase as fallback only', () => {
    expect(deriveFullMaterializedMessageDecision({
      metadata: {
        materializedFullPayload: true,
        fullPayloadPath: '.squidrun/coord/full-agent-messages/hm-meta-only.txt',
      },
      body: 'HEAD: plausible preview\nTAIL: plausible preview',
    })).toEqual(expect.objectContaining({
      decision: 'must_read_materialized_full_message',
      authority: 'metadata_path',
      fullPayloadPath: '.squidrun/coord/full-agent-messages/hm-meta-only.txt',
      previewAcceptedAsComplete: false,
    }));

    expect(deriveFullMaterializedMessageDecision({
      body: '[AGENT MSG] FULL MSG AT .squidrun/coord/full-agent-messages/hm-body-pointer.txt\nHEAD: clipped\nTAIL: clipped',
    })).toEqual(expect.objectContaining({
      decision: 'must_read_materialized_full_message',
      authority: 'body_pointer_fallback',
      fullPayloadPath: '.squidrun/coord/full-agent-messages/hm-body-pointer.txt',
    }));

    expect(deriveFullMaterializedMessageDecision({
      body: 'Do not act from this preview alone; read the full file, then reply via hm-send.js.',
    })).toEqual(expect.objectContaining({
      decision: 'no_materialized_full_message_signal',
      authority: 'none',
    }));

    expect(deriveFullMaterializedMessageDecision({
      body: '(ORACLE #12): This is a complete short routed message. No materialized file pointer is present and no preview markers are present.',
    })).toEqual(expect.objectContaining({
      decision: 'no_materialized_full_message_signal',
      authority: 'none',
      previewAcceptedAsComplete: false,
    }));
  });

  test('Phase 4B rejects plausible HEAD/TAIL preview-only task text as complete authority', () => {
    const temptingPreview = [
      'HEAD: [AGENT MSG - reply via hm-send.js] (ARCHITECT -> BUILDER): Ship the invoice fix now; tests are green and the customer is waiting.',
      'TAIL: Commit it, push it, and tell James it is live. [CURRENT PROJECT] name=TrustQuote | path=D:\\projects\\TrustQuote',
    ].join('\n');

    expect(deriveFullMaterializedMessageDecision({ body: temptingPreview })).toEqual(expect.objectContaining({
      decision: 'preview_only_not_authority',
      authority: 'none',
      fullPayloadPath: null,
      previewAcceptedAsComplete: false,
      reason: 'preview_head_tail_without_materialized_path',
    }));
  });

  test('Phase 4B fails if full-file read requirement is removed from the pointer source', () => {
    const daemonHandlers = readRel('ui/modules/daemon-handlers.js').replace(
      "      'Do not act from this preview alone; read the full file, then reply via hm-send.js.',\n",
      ''
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ],
      fileTextOverrides: defaultOverrides({ daemonHandlers }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('source_ref_daemon_pointer_requires_full_file_read');
    expect(failedCheckIds(report)).toContain('full_materialized_pointer_includes_path_and_read_instruction');
  });

  test('Phase 4B fails if materialized path metadata is removed from the inbound path', () => {
    const daemonHandlers = readRel('ui/modules/daemon-handlers.js')
      .replace('    materializedFullPayload: materialized.materialized === true,\n', '')
      .replace('    fullPayloadPath: materialized.displayPath || null,\n', '')
      .replace('      fullPayloadPath: materialized.displayPath,\n', '');
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ],
      fileTextOverrides: defaultOverrides({ daemonHandlers }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('source_ref_daemon_emits_materialized_metadata');
    expect(failedCheckIds(report)).toContain('source_ref_daemon_emits_full_payload_path');
    expect(failedCheckIds(report)).toContain('full_materialized_metadata_path_emitted');
  });

  test('Phase 4B fails if preview-only content is accepted as complete body authority', () => {
    const badDecision = (input) => {
      const body = String(input?.body || '');
      if (body.includes('HEAD:') || body.includes('TAIL:')) {
        return {
          decision: 'must_read_materialized_full_message',
          authority: 'body_pointer_fallback',
          fullPayloadPath: null,
          previewAcceptedAsComplete: true,
          reason: 'bug_preview_only_accepted',
        };
      }
      return deriveFullMaterializedMessageDecision(input);
    };
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ],
      deriveFullMaterializedMessageDecision: badDecision,
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('full_materialized_decision_preview_head_tail_without_path_is_not_authority');
    expect(failedCheckIds(report)).toContain('full_materialized_preview_only_not_authority');
  });

  test('registers Phase 4C route metadata guard as metadata-first protected eval', () => {
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_ROUTE_METADATA_GUARD],
      generatedAt: '2026-06-30T00:00:00.000Z',
    });

    expect(report.ok).toBe(true);
    expect(report.summary).toEqual(expect.objectContaining({
      caseCount: 1,
      protectedZeroFailCount: 1,
      passed: 1,
      failed: 0,
    }));
    expect(report.focusedCommands).toEqual(expect.arrayContaining([
      expect.stringContaining('hm-system-protected-evals.js --case phase4c.route_metadata_guard_metadata_first'),
      expect.stringContaining('squidrun-app.test.js'),
    ]));
    expect(checkIds(report)).toEqual(expect.arrayContaining([
      'route_metadata_validator_detects_profile_and_session_mismatch',
      'route_metadata_guard_runs_before_delivery',
      'route_metadata_mismatch_blocks_before_visible_fallback',
      'route_metadata_correct_metadata_fixture_routes',
      'route_metadata_wrong_profile_fixture_blocks',
      'route_metadata_wrong_session_fixture_blocks',
    ]));
  });

  test('Phase 4C exposes route metadata source refs and focused routeInjectMessage fixtures', () => {
    const plan = buildSystemProtectedEvalRunPlan({
      caseIds: [CASE_ID_ROUTE_METADATA_GUARD],
    });
    const [evalCase] = plan.cases;

    expect(evalCase.id).toBe(CASE_ID_ROUTE_METADATA_GUARD);
    expect(evalCase.sourceRefs.map((ref) => ref.id)).toEqual([
      'squidrun_app_metadata_validator_mismatch_reason',
      'squidrun_app_metadata_validator_profile_mismatch',
      'squidrun_app_metadata_validator_session_mismatch',
      'squidrun_app_route_metadata_guard_before_delivery',
      'squidrun_app_route_metadata_guard_block_event',
    ]);
    expect(evalCase.testRefs.map((ref) => ref.testName)).toEqual(expect.arrayContaining([
      'routes correct metadata even when body text mentions another profile',
      'blocks wrong metadata even when body text looks plausible for the target window',
      'blocks wrong session metadata even when body text looks plausible for the target window',
    ]));
    expect(evalCase.expectedRegressionFailures.map((failure) => failure.id)).toEqual([
      'metadata_guard_removed',
      'body_override_wrong_metadata',
      'metadata_mismatch_main_fallback_allowed',
    ]);
  });

  test('Phase 4C fails if route metadata validation is bypassed before delivery', () => {
    const squidrunApp = readRel('ui/modules/main/squidrun-app.js').replace(
      '      const routeValidation = this.validateInjectRouteMetadata(packet, paneId, normalizedTargetWindowKey);\n',
      '      const routeValidation = { ok: true, routeMetadata: {}, targetScope: {} };\n'
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_ROUTE_METADATA_GUARD],
      fileTextOverrides: defaultOverrides({ squidrunApp }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('source_ref_squidrun_app_route_metadata_guard_before_delivery');
    expect(failedCheckIds(report)).toContain('route_metadata_guard_runs_before_delivery');
  });

  test('Phase 4C fails if metadata mismatch can fall through to visible/default fallback', () => {
    const squidrunApp = readRel('ui/modules/main/squidrun-app.js').replace(
      "        log.warn(\n          'InjectIPC',\n          `Blocked inject route for pane ${paneId}: ${routeValidation.reason} (${routeValidation.blockers.join(', ')})`\n        );\n        continue;\n",
      "        log.warn(\n          'InjectIPC',\n          `Blocked inject route for pane ${paneId}: ${routeValidation.reason} (${routeValidation.blockers.join(', ')})`\n        );\n"
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_ROUTE_METADATA_GUARD],
      fileTextOverrides: defaultOverrides({ squidrunApp }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('route_metadata_mismatch_blocks_before_visible_fallback');
  });

  test('Phase 4C fails if the wrong-session tempting-body fixture is removed', () => {
    const squidrunAppTest = readRel('ui/__tests__/squidrun-app.test.js').replace(
      'blocks wrong session metadata even when body text looks plausible for the target window',
      'renamed wrong session route metadata fixture'
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_ROUTE_METADATA_GUARD],
      fileTextOverrides: defaultOverrides({ squidrunAppTest }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('test_ref_wrong_session_metadata_plausible_body_blocks');
    expect(failedCheckIds(report)).toContain('route_metadata_wrong_session_fixture_blocks');
  });

  test('registers Phase 4D watchdog autonomy evidence as a protected eval', () => {
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_WATCHDOG_AUTONOMY_EVIDENCE],
      generatedAt: '2026-06-30T00:00:00.000Z',
    });

    expect(report.ok).toBe(true);
    expect(report.summary).toEqual(expect.objectContaining({
      caseCount: 1,
      protectedZeroFailCount: 1,
      passed: 1,
      failed: 0,
    }));
    expect(report.focusedCommands).toEqual(expect.arrayContaining([
      expect.stringContaining('hm-system-protected-evals.js --case phase4d.watchdog_autonomy_evidence_not_body_text'),
      expect.stringContaining('squidrun-app.test.js'),
    ]));
    expect(checkIds(report)).toEqual(expect.arrayContaining([
      'watchdog_autonomy_states_declared',
      'watchdog_pending_autonomy_state_checked',
      'watchdog_ledger_autonomy_state_checked_before_generic_resolution',
      'watchdog_work_item_and_current_lane_checked_before_unresolved',
      'watchdog_work_item_and_current_lane_autonomy_sources',
      'watchdog_unresolved_fails_open_with_blockers',
      'watchdog_body_only_no_reply_fixture_still_fires',
      'watchdog_evidence_backed_autonomy_fixtures_suppress',
      'watchdog_unresolved_blocker_fixture_fires',
    ]));
  });

  test('Phase 4D exposes watchdog source refs and focused watchdog fixtures', () => {
    const plan = buildSystemProtectedEvalRunPlan({
      caseIds: [CASE_ID_WATCHDOG_AUTONOMY_EVIDENCE],
    });
    const [evalCase] = plan.cases;

    expect(evalCase.id).toBe(CASE_ID_WATCHDOG_AUTONOMY_EVIDENCE);
    expect(evalCase.sourceRefs.map((ref) => ref.id)).toEqual([
      'squidrun_app_watchdog_autonomy_states_declared',
      'squidrun_app_watchdog_pending_state_checked',
      'squidrun_app_watchdog_ledger_state_checked',
      'squidrun_app_watchdog_work_item_checked',
      'squidrun_app_watchdog_current_lane_checked',
      'squidrun_app_watchdog_unresolved_blockers',
    ]);
    expect(evalCase.testRefs.map((ref) => ref.testName)).toEqual(expect.arrayContaining([
      'still watchdogs explicit tasks when no-reply-needed is body text only',
      'suppresses response watchdog when pending entry has explicit no_ack_needed state',
      'suppresses response watchdog when later ledger metadata has explicit no_ack_needed state',
      'suppresses response watchdog when correlated WorkItem has explicit intentional_hold route state',
      'suppresses response watchdog when correlated current-lane has explicit auto_proceed route state',
      'reports exact correlation blockers before architect-to-oracle watchdog fires',
    ]));
    expect(evalCase.expectedRegressionFailures.map((failure) => failure.id)).toEqual([
      'body_text_suppression_allowed',
      'evidence_backed_autonomy_states_ignored',
      'unresolved_task_no_longer_fires',
    ]);
  });

  test('Phase 4D fails if pending autonomy evidence is ignored', () => {
    const squidrunApp = readRel('ui/modules/main/squidrun-app.js').replace(
      '    const pendingWatchdogState = findRecordIntentionalAutonomyState(entry);\n',
      '    const pendingWatchdogState = null;\n'
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_WATCHDOG_AUTONOMY_EVIDENCE],
      fileTextOverrides: defaultOverrides({ squidrunApp }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('source_ref_squidrun_app_watchdog_pending_state_checked');
    expect(failedCheckIds(report)).toContain('watchdog_pending_autonomy_state_checked');
  });

  test('Phase 4D fails if body-only no-reply wording is no longer proven to fire', () => {
    const squidrunAppTest = readRel('ui/__tests__/squidrun-app.test.js').replace(
      'Verify the watchdog no-reply body text and report. No reply needed.',
      'Status only. No reply needed.'
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_WATCHDOG_AUTONOMY_EVIDENCE],
      fileTextOverrides: defaultOverrides({ squidrunAppTest }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report).some((id) => id.startsWith('test_ref_body_only_no_reply_still_fires_contains_'))).toBe(true);
    expect(failedCheckIds(report)).toContain('watchdog_body_only_no_reply_fixture_still_fires');
  });

  test('Phase 4D fails if unresolved task blocker reporting is removed', () => {
    const squidrunAppTest = readRel('ui/__tests__/squidrun-app.test.js').replace(
      'Closure correlation blockers: comms_journal:no_later_resolution; work_items:no_correlating_work_item; current_lane:missing.',
      'No correlation blockers reported.'
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_WATCHDOG_AUTONOMY_EVIDENCE],
      fileTextOverrides: defaultOverrides({ squidrunAppTest }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('watchdog_unresolved_blocker_fixture_fires');
  });
});
