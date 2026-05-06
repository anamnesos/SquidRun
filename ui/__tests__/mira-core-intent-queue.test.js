const intentContract = require('./fixtures/mira-core-intent-queue-contract.json');
const {
  INTENT_RECORD_SCHEMA_VERSION,
  REQUIRED_INTENT_RECORD_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  buildMiraCoreIntentQueue,
  validateMiraCoreIntentQueueOutput,
} = require('../modules/mira-core/intent-queue');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-intent-queue');

function acceptance(id) {
  return intentContract.acceptanceChecks.find((check) => check.id === id);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return JSON.stringify(value);
}

function expectRequiredFields(value, fields) {
  for (const field of fields) {
    expect(value).toHaveProperty(field);
  }
}

function expectNoForbiddenOutput(output, extra = []) {
  const outputText = text(output);
  for (const forbidden of [...intentContract.forbiddenOutputSubstrings, ...extra]) {
    expect(outputText).not.toContain(forbidden);
  }
}

function recordFor(output, actionClassOrIndex = 0) {
  if (typeof actionClassOrIndex === 'number') return output.intent_records[actionClassOrIndex];
  return output.intent_records.find((record) => record.action_class === actionClassOrIndex);
}

describe('mira core intent queue v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle intent output, record, report, source ref, and requested_by shapes', () => {
    const output = buildMiraCoreIntentQueue({
      inputSignals: acceptance('safe-research-intent-accepted-pending-local-acceptance').inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = output.intent_records[0];
    const report = output.validation_report;

    expectRequiredFields(output, intentContract.expectedOutputShape.requiredTopLevelFields);
    expect(intentContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(record.schema).toBe(INTENT_RECORD_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(record, intentContract.expectedIntentRecordShape.requiredFields);
    expect(intentContract.expectedIntentRecordShape.requiredFields).toEqual(REQUIRED_INTENT_RECORD_FIELDS);
    expectRequiredFields(record.source_refs[0], intentContract.expectedIntentRecordShape.sourceRefsRequiredFields);
    expectRequiredFields(record.requested_by, intentContract.expectedIntentRecordShape.requestedByRequiredFields);
    expectRequiredFields(report, intentContract.expectedValidationReportShape.requiredTopLevelFields);
    expect(intentContract.expectedValidationReportShape.requiredTopLevelFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreIntentQueueOutput(output, intentContract)).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('Tier 0 read-only research is accepted for local Architect only', () => {
    const check = acceptance('safe-research-intent-accepted-pending-local-acceptance');
    const output = buildMiraCoreIntentQueue({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = output.intent_records[0];

    expect(record).toEqual(expect.objectContaining(check.expectedRecord));
    expect(record.risk_tier).toBe('tier0_read_only');
    expect(record.action_class).toBe('read_only_research');
    expect(record.requested_by.kind).toBe('mira_pulse');
    expect(output.validation_report.accepted_count).toBe(1);
    expect(output.validation_report.side_effect_result.no_queue_created).toBe(true);
    for (const forbidden of check.mustNotInclude) {
      expect(text(output)).not.toContain(forbidden);
    }
  });

  test('offline reminder is pending local acceptance with expiry and no queue/enqueue/route/send', () => {
    const check = acceptance('offline-queued-reminder-accepted');
    const output = buildMiraCoreIntentQueue({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = output.intent_records[0];

    expect(record).toEqual(expect.objectContaining(check.expectedRecord));
    expect(record.requested_by.kind).toBe('server_offline_capture');
    expect(output.validation_report.side_effect_result.no_queue_created).toBe(true);
    expect(output.validation_report.side_effect_result.no_enqueue_performed).toBe(true);
    expect(output.validation_report.side_effect_result.no_route_performed).toBe(true);
    expect(output.validation_report.side_effect_result.externalSendsAttempted).toBe(0);
  });

  test('Tier 3 customer/deploy and Tier 4 financial actions are blocked with safe alternatives', () => {
    const check = acceptance('high-risk-customer-deploy-financial-blocked');
    const output = buildMiraCoreIntentQueue({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });

    for (const expectedRecord of check.expectedRecords) {
      expect(recordFor(output, expectedRecord.action_class)).toEqual(expect.objectContaining(expectedRecord));
    }
    expect(output.validation_report.blocked_count).toBe(3);
    for (const forbidden of check.mustNotInclude) {
      expect(text(output)).not.toContain(forbidden);
    }
  });

  test('Tier 2 repo mutation is review-required or blocked, never pending local acceptance', () => {
    const check = acceptance('repo-mutation-review-required-or-blocked');
    const output = buildMiraCoreIntentQueue({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = output.intent_records[0];

    expect(check.expectedRecord.allowedStatuses).toContain(record.status);
    expect(record.status).not.toBe(check.expectedRecord.mustNotStatus);
    expect(record.review_required).toBe(check.expectedRecord.review_required);
    expect(record.safe_next_action).toBe(check.expectedRecord.safe_next_action);
  });

  test('identity rewrites, secrets/auth, and local execution are blocked', () => {
    const check = acceptance('identity-secrets-auth-local-execution-blocked');
    const output = buildMiraCoreIntentQueue({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });

    for (const expectedRecord of check.expectedRecords) {
      expect(recordFor(output, expectedRecord.action_class)).toEqual(expect.objectContaining(expectedRecord));
    }
    for (const forbidden of check.mustNotInclude) {
      expect(text(output)).not.toContain(forbidden);
    }
  });

  test('direct Builder and Oracle future-server targets are blocked', () => {
    const check = acceptance('wrong-target-role-blocked');
    const output = buildMiraCoreIntentQueue({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });

    for (const expectedRecord of check.expectedRecords) {
      const record = output.intent_records.find((entry) => entry.target_role === expectedRecord.target_role);
      expect(record).toEqual(expect.objectContaining(expectedRecord));
    }
    expect(output.validation_report.routing_result.directBuilderOracleTargetsBlocked).toBe(2);
    for (const forbidden of check.mustNotInclude) {
      expect(text(output)).not.toContain(forbidden);
    }
  });

  test('profile/session/device mismatch fails closed', () => {
    const check = acceptance('profile-mismatch-blocked');
    const output = buildMiraCoreIntentQueue({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = output.intent_records[0];

    expect(record).toEqual(expect.objectContaining(check.expectedRecord));
    expect(output.validation_report.reasons).toEqual(expect.arrayContaining(check.validationReportMustIncludeReason));
  });

  test('stale and expired intents do not become pending local acceptance', () => {
    const check = acceptance('stale-expired-intent-rejected');
    const output = buildMiraCoreIntentQueue({ inputSignals: check.inputSignals });
    const record = output.intent_records[0];

    expect(record).toEqual(expect.objectContaining(check.expectedRecord));
    expect(output.validation_report.reasons).toEqual(expect.arrayContaining(check.validationReportMustIncludeReason));
    expect(record.status).not.toBe('pending_local_acceptance');
  });

  test('raw payload leakage is blocked and summarized without private content', () => {
    const check = acceptance('raw-payload-leakage-prevented');
    const output = buildMiraCoreIntentQueue({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = output.intent_records[0];

    expect(record).toEqual(expect.objectContaining(check.expectedRecord));
    expect(output.validation_report.redaction_result.rawPayloadBlocked).toBe(1);
    expectNoForbiddenOutput(output, check.forbiddenOutputSubstringsMustBeAbsent);
  });

  test('fixture-style blocked examples create a blocked redacted intent record', () => {
    const output = buildMiraCoreIntentQueue({
      inputSignals: {
        blockedExamples: [
          'OPENAI_API_KEY=example',
          'Authorization: Bearer example',
          'raw terminal scrollback',
        ],
      },
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = output.intent_records[0];

    expect(output.intent_records).toHaveLength(1);
    expect(record.status).toBe('blocked');
    expect(record.payload_redaction_status).toBe('blocked');
    expect(record.payload_summary).toBe('Redacted request summary unavailable because payload contains blocked private content.');
    expect(record.no_execution_performed).toBe(true);
    expect(output.validation_report.blocked_count).toBe(1);
    expectNoForbiddenOutput(output);
  });

  test('blocked redaction metadata forces blocked status instead of pending acceptance', () => {
    const output = buildMiraCoreIntentQueue({
      inputSignals: {
        request: {
          target_role: 'architect',
          risk_tier: 'tier0_read_only',
          action_class: 'read_only_research',
          payload_redaction_status: 'blocked',
          payload_summary: 'Redacted upstream payload should not be accepted.',
        },
      },
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = output.intent_records[0];

    expect(record.status).toBe('blocked');
    expect(record.payload_redaction_status).toBe('blocked');
    expect(record.payload_summary).toBe('Redacted request summary unavailable because payload contains blocked private content.');
    expect(record.safe_next_action).toBe('Create a new redacted summary-only request for local Architect review.');
    expect(record.no_execution_performed).toBe(true);
    expect(output.validation_report.blocked_count).toBe(1);
  });

  test('raw private substrings in payload_summary are blocked and redacted without throwing', () => {
    const output = buildMiraCoreIntentQueue({
      inputSignals: {
        request: {
          target_role: 'architect',
          risk_tier: 'tier0_read_only',
          action_class: 'read_only_research',
          payload_summary: 'OPENAI_API_KEY=example and customer private note',
        },
      },
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const record = output.intent_records[0];

    expect(record.status).toBe('blocked');
    expect(record.payload_summary).toBe('Redacted request summary unavailable because payload contains blocked private content.');
    expect(record.payload_redaction_status).toBe('blocked');
    expectNoForbiddenOutput(output);
  });

  test('idempotency and dedupe keys are stable for same canonical input and sensitive to changed payload/scope', () => {
    const check = acceptance('idempotency-stable-sensitive');
    const fixtureA = buildMiraCoreIntentQueue({ inputSignals: check.inputSignals.fixtureA });
    const fixtureB = buildMiraCoreIntentQueue({ inputSignals: check.inputSignals.fixtureB });
    const changedPayload = buildMiraCoreIntentQueue({ inputSignals: check.inputSignals.fixtureChangedPayload });
    const changedScope = buildMiraCoreIntentQueue({ inputSignals: check.inputSignals.fixtureChangedScope });
    const recordA = fixtureA.intent_records[0];

    expect(recordA.idempotency_key).toBe(fixtureB.intent_records[0].idempotency_key);
    expect(recordA.dedupe_key).toBe(fixtureB.intent_records[0].dedupe_key);
    expect(changedPayload.intent_records[0].idempotency_key).not.toBe(recordA.idempotency_key);
    expect(changedPayload.intent_records[0].dedupe_key).not.toBe(recordA.dedupe_key);
    expect(changedScope.intent_records[0].idempotency_key).not.toBe(recordA.idempotency_key);
    expect(changedScope.intent_records[0].dedupe_key).not.toBe(recordA.dedupe_key);
    expect(fixtureA.validation_report.idempotency_result.excludes).toEqual(expect.arrayContaining(check.expectedOutput.keysMustExclude));
  });

  test('intent prep has no queue, route, lease, execution, send, write, deploy, trade, or output-file side effects', () => {
    const check = acceptance('no-side-effects');
    const output = buildMiraCoreIntentQueue({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });

    for (const record of output.intent_records) {
      expect(record.no_execution_performed).toBe(true);
    }
    expect(output.validation_report.side_effect_result).toEqual(expect.objectContaining(check.expectedOutput.validation_report.side_effect_result));
    expect(output.validation_report.side_effect_result.outputFileWritten).toBe(false);
    for (const forbidden of check.expectedOutput.mustNotInclude) {
      if (forbidden === 'enqueue') {
        expect(output.validation_report.side_effect_result.no_enqueue_performed).toBe(true);
        expect(output.validation_report.side_effect_result.queueWritesAttempted).toBe(0);
        continue;
      }
      expect(text(output)).not.toContain(forbidden);
    }
  });

  test('static validation rules are covered by the output validator', () => {
    const output = buildMiraCoreIntentQueue({
      inputSignals: {
        requests: [
          acceptance('safe-research-intent-accepted-pending-local-acceptance').inputSignals.request,
          ...acceptance('high-risk-customer-deploy-financial-blocked').inputSignals.requests,
          acceptance('repo-mutation-review-required-or-blocked').inputSignals.request,
        ].filter(Boolean),
        source_refs: acceptance('safe-research-intent-accepted-pending-local-acceptance').inputSignals.source_refs,
      },
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const validation = validateMiraCoreIntentQueueOutput(output, intentContract);

    expect(validation.ok).toBe(true);
    const checkIds = validation.checks.map((check) => check.id);
    for (const rule of intentContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
  });

  test('validator rejects missing fields, unsafe pending statuses, raw leakage, unstable keys, and side-effect lies', () => {
    const valid = buildMiraCoreIntentQueue({
      inputSignals: acceptance('safe-research-intent-accepted-pending-local-acceptance').inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    expect(validateMiraCoreIntentQueueOutput(valid, intentContract).ok).toBe(true);

    const missingEvidence = clone(valid);
    delete missingEvidence.intent_records[0].evidenceRefs;
    expect(validateMiraCoreIntentQueueOutput(missingEvidence, intentContract)).toEqual(expect.objectContaining({ ok: false }));

    const missingPayloadHash = clone(valid);
    delete missingPayloadHash.intent_records[0].payload_hash;
    expect(validateMiraCoreIntentQueueOutput(missingPayloadHash, intentContract)).toEqual(expect.objectContaining({ ok: false }));

    const directBuilderPending = clone(valid);
    directBuilderPending.intent_records[0].target_role = 'builder';
    directBuilderPending.intent_records[0].status = 'pending_local_acceptance';
    expect(validateMiraCoreIntentQueueOutput(directBuilderPending, intentContract)).toEqual(expect.objectContaining({ ok: false }));

    const tier3Pending = clone(valid);
    tier3Pending.intent_records[0].risk_tier = 'tier3_external_side_effect';
    tier3Pending.intent_records[0].status = 'pending_local_acceptance';
    expect(validateMiraCoreIntentQueueOutput(tier3Pending, intentContract)).toEqual(expect.objectContaining({ ok: false }));

    const expiredAccepted = clone(valid);
    expiredAccepted.intent_records[0].expires_at = '2026-05-05T00:00:00.000Z';
    expiredAccepted.intent_records[0].created_at = '2026-05-06T00:00:00.000Z';
    expiredAccepted.intent_records[0].status = 'pending_local_acceptance';
    expect(validateMiraCoreIntentQueueOutput(expiredAccepted, intentContract)).toEqual(expect.objectContaining({ ok: false }));

    const rawLeakage = clone(valid);
    rawLeakage.intent_records[0].payload_summary = 'OPENAI_API_KEY=example';
    expect(validateMiraCoreIntentQueueOutput(rawLeakage, intentContract)).toEqual(expect.objectContaining({ ok: false }));

    const unstableKeys = clone(valid);
    unstableKeys.intent_records[0].payload_hash = 'sha256:changed-without-key-update';
    expect(validateMiraCoreIntentQueueOutput(unstableKeys, intentContract)).toEqual(expect.objectContaining({ ok: false }));

    const sideEffectLie = clone(valid);
    sideEffectLie.validation_report.side_effect_result.no_queue_created = false;
    sideEffectLie.validation_report.side_effect_result.queueWritesAttempted = 1;
    expect(validateMiraCoreIntentQueueOutput(sideEffectLie, intentContract)).toEqual(expect.objectContaining({ ok: false }));
  });

  test('CLI prints stdout JSON only and ignores output-file flags', () => {
    expect(parseArgs(['--pretty', '--out', 'intent.json'])).toEqual({ pretty: true });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=intent.json'], JSON.stringify(acceptance('safe-research-intent-accepted-pending-local-acceptance').inputSignals));

    expect(output.intent_records[0].schema).toBe(INTENT_RECORD_SCHEMA_VERSION);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.intent_records[0].schema).toBe(INTENT_RECORD_SCHEMA_VERSION);
    expect(printed.validation_report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(printed.validation_report.side_effect_result.no_queue_created).toBe(true);
    expect(printed.validation_report.side_effect_result.queueWritesAttempted).toBe(0);
  });
});
