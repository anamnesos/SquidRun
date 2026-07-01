'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY,
  CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ,
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
});
