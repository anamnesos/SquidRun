const serverBoundaryContract = require('./fixtures/mira-core-server-boundary-contract.json');
const {
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SERVER_RECEIVE_FIELDS,
  REQUIRED_SERVER_STATUS_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  SERVER_RECEIVE_RECORD_SCHEMA_VERSION,
  SERVER_STATUS_SUMMARY_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  buildMiraCoreServerBoundary,
  validateMiraCoreServerBoundaryOutput,
} = require('../modules/mira-core/server-boundary');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-server-boundary');

function acceptance(id) {
  return serverBoundaryContract.acceptanceChecks.find((check) => check.id === id);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return JSON.stringify(value);
}

function firstReceive(output) {
  return output.server_receive_records[0];
}

function firstStatus(output) {
  return output.server_status_summaries[0];
}

function expectRequiredFields(value, fields) {
  for (const field of fields) {
    expect(value).toHaveProperty(field);
  }
}

function expectNoForbiddenOutput(output, extra = []) {
  const outputText = text(output);
  for (const forbidden of [...serverBoundaryContract.forbiddenOutputSubstrings, ...extra]) {
    expect(outputText).not.toContain(forbidden);
  }
}

describe('mira core server boundary v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, receive, status, and validation report shapes', () => {
    const output = buildMiraCoreServerBoundary({
      inputSignals: acceptance('accept-redacted-upload-envelope-ref').inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const receive = firstReceive(output);
    const status = firstStatus(output);
    const report = output.validation_report;

    expectRequiredFields(output, serverBoundaryContract.expectedOutputShape.requiredTopLevelFields);
    expect(serverBoundaryContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(receive.schema).toBe(SERVER_RECEIVE_RECORD_SCHEMA_VERSION);
    expect(status.schema).toBe(SERVER_STATUS_SUMMARY_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(receive, serverBoundaryContract.expectedServerReceiveRecordShape.requiredFields);
    expect(serverBoundaryContract.expectedServerReceiveRecordShape.requiredFields).toEqual(REQUIRED_SERVER_RECEIVE_FIELDS);
    expectRequiredFields(receive.source_upload_ref, serverBoundaryContract.expectedServerReceiveRecordShape.sourceUploadRefRequiredFields);
    for (const intent of receive.source_intent_refs) {
      expectRequiredFields(intent, serverBoundaryContract.expectedServerReceiveRecordShape.sourceIntentRefRequiredFields);
    }
    expectRequiredFields(receive.accepted_items_summary, serverBoundaryContract.expectedServerReceiveRecordShape.acceptedItemsSummaryRequiredFields);
    expectRequiredFields(receive.stored_future_shape, serverBoundaryContract.expectedServerReceiveRecordShape.storedFutureShapeRequiredFields);
    expectRequiredFields(receive.redaction_audit, serverBoundaryContract.expectedServerReceiveRecordShape.redactionAuditRequiredFields);
    expectRequiredFields(receive.capability_truth, serverBoundaryContract.expectedServerReceiveRecordShape.capabilityTruthRequiredFields);
    expectRequiredFields(receive.server_targeting, serverBoundaryContract.expectedServerReceiveRecordShape.serverTargetingRequiredFields);
    expectRequiredFields(receive.deletion_controls, serverBoundaryContract.expectedServerReceiveRecordShape.deletionControlsRequiredFields);
    expectRequiredFields(receive.export_controls, serverBoundaryContract.expectedServerReceiveRecordShape.exportControlsRequiredFields);
    expectRequiredFields(status, serverBoundaryContract.expectedServerStatusSummaryShape.requiredFields);
    expect(serverBoundaryContract.expectedServerStatusSummaryShape.requiredFields).toEqual(REQUIRED_SERVER_STATUS_FIELDS);
    expectRequiredFields(status.pc_local_arms_status, serverBoundaryContract.expectedServerStatusSummaryShape.pcLocalArmsStatusRequiredFields);
    expectRequiredFields(status.server_capability_summary, serverBoundaryContract.expectedServerStatusSummaryShape.serverCapabilitySummaryRequiredFields);
    expectRequiredFields(status.pending_intent_summary, serverBoundaryContract.expectedServerStatusSummaryShape.pendingIntentSummaryRequiredFields);
    expectRequiredFields(status.bridge_delivery_truth, serverBoundaryContract.expectedServerStatusSummaryShape.bridgeDeliveryTruthRequiredFields);
    expectRequiredFields(status.local_architect_handoff, serverBoundaryContract.expectedServerStatusSummaryShape.localArchitectHandoffRequiredFields);
    expectRequiredFields(report, serverBoundaryContract.expectedValidationReportShape.requiredTopLevelFields);
    expect(serverBoundaryContract.expectedValidationReportShape.requiredTopLevelFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreServerBoundaryOutput(output, serverBoundaryContract)).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('redacted upload envelope refs are accepted as future store shape with no write', () => {
    const check = acceptance('accept-redacted-upload-envelope-ref');
    const output = buildMiraCoreServerBoundary({ inputSignals: check.inputSignals });
    const receive = firstReceive(output);

    expect(receive.decision).toBe(check.expectedReceiveRecord.decision);
    expect(receive.stored_future_shape).toEqual(expect.objectContaining(check.expectedReceiveRecord.stored_future_shape));
    expect(receive.accepted_items_summary.by_syncEligibility).toHaveProperty('core_sync_safe');
    expect(receive.accepted_items_summary.by_syncEligibility).toHaveProperty('core_sync_redacted');
    expect(receive.redaction_audit.rawCommsStored).toBe(false);
  });

  test('validation-only Architect intent refs are accepted for future local Architect acceptance', () => {
    const check = acceptance('accept-validation-only-intent-ref');
    const output = buildMiraCoreServerBoundary({ inputSignals: check.inputSignals });
    const receive = firstReceive(output);

    expect(receive.decision).toBe(check.expectedReceiveRecord.decision);
    expect(receive.server_targeting).toEqual(expect.objectContaining(check.expectedReceiveRecord.server_targeting));
    expect(receive.source_intent_refs[0].target_role).toBe('architect');
    expect(receive.source_intent_refs[0].no_execution_performed).toBe(true);
  });

  test('blocked, local-only, approval-required, and unredacted items are blocked', () => {
    const check = acceptance('block-unredacted-or-ineligible-upload');
    const output = buildMiraCoreServerBoundary({ inputSignals: check.inputSignals });
    const receive = firstReceive(output);

    expect(receive.decision).toBe(check.expectedReceiveRecord.decision);
    for (const reason of check.expectedReceiveRecord.withheld_items_summary.by_reason) {
      expect(receive.withheld_items_summary.by_reason).toHaveProperty(reason);
    }
  });

  test('raw private server storage is blocked without reconstructing raw payload', () => {
    const check = acceptance('block-raw-private-server-storage');
    const output = buildMiraCoreServerBoundary({ inputSignals: check.inputSignals });
    const receive = firstReceive(output);

    expect(receive.decision).toBe(check.expectedReceiveRecord.decision);
    expect(receive.redaction_audit).toEqual(expect.objectContaining(check.expectedReceiveRecord.redaction_audit));
    expect(receive.redaction_audit.withheldByReason.raw_private_payload_blocked).toBe(1);
    expectNoForbiddenOutput(output, check.forbiddenOutputSubstringsMustBeAbsent);
  });

  test('local arms offline status is honest and never claims local execution', () => {
    const check = acceptance('status-local-arms-offline-honest');
    const output = buildMiraCoreServerBoundary({ inputSignals: check.inputSignals });
    const status = firstStatus(output);

    expect(status.pc_local_arms_status).toEqual(expect.objectContaining(check.expectedStatusSummary.pc_local_arms_status));
    expect(status.server_capability_summary).toEqual(expect.objectContaining(check.expectedStatusSummary.server_capability_summary));
    expect(status.server_capability_summary.serverCanExecuteLocal).toBe(false);
  });

  test('server local capability overclaims are blocked by status truth', () => {
    const check = acceptance('block-server-local-capability-overclaim');
    const output = buildMiraCoreServerBoundary({ inputSignals: check.inputSignals });
    const status = firstStatus(output);

    expect(status.server_capability_summary).toEqual(expect.objectContaining(check.expectedStatusSummary.server_capability_summary));
    expectNoForbiddenOutput(output);
  });

  test('server-originated direct Builder and Oracle targeting is blocked', () => {
    const check = acceptance('block-builder-oracle-server-targeting');
    const output = buildMiraCoreServerBoundary({ inputSignals: check.inputSignals });
    const receive = firstReceive(output);

    expect(receive.decision).toBe(check.expectedReceiveRecord.decision);
    expect(receive.server_targeting).toEqual(expect.objectContaining(check.expectedReceiveRecord.server_targeting));
    expect(output.validation_report.targeting_result.blockedDirectTargetCount).toBe(2);
    expectNoForbiddenOutput(output, check.mustNotInclude);
  });

  test('bridge and delivery proof boundaries stay explicit', () => {
    const check = acceptance('bridge-delivery-truth');
    const output = buildMiraCoreServerBoundary({ inputSignals: check.inputSignals });
    const status = firstStatus(output);

    expect(status.bridge_delivery_truth).toEqual(expect.objectContaining(check.expectedStatusSummary.bridge_delivery_truth));
    expect(status.server_capability_summary.serverCanProveModelProcessing).toBe(false);
  });

  test('stale upload and watermark regression reject the receive record', () => {
    const check = acceptance('stale-watermark-rejection');
    const output = buildMiraCoreServerBoundary({ inputSignals: check.inputSignals });
    const receive = firstReceive(output);

    expect(receive.decision).toBe(check.expectedReceiveRecord.decision);
    expect(receive.stale_watermark_result).toEqual(expect.objectContaining({
      reasons: expect.arrayContaining(check.expectedReceiveRecord.stale_watermark_result.reasons),
    }));
    expect(output.validation_report.rejected_count).toBe(1);
  });

  test('future deletion and export controls are present and non-mutating', () => {
    const check = acceptance('deletion-export-controls-present');
    const output = buildMiraCoreServerBoundary({ inputSignals: check.inputSignals });
    const receive = firstReceive(output);

    expect(receive.deletion_controls).toEqual(expect.objectContaining(check.expectedReceiveRecord.deletion_controls));
    expect(receive.export_controls).toEqual(expect.objectContaining(check.expectedReceiveRecord.export_controls));
    expect(firstStatus(output).deletion_export_controls.export_controls.raw_export_allowed).toBe(false);
  });

  test('receive/status idempotency is stable for replay and sensitive to watermark changes', () => {
    const check = acceptance('idempotency-replay-stable-sensitive');
    const outputA = buildMiraCoreServerBoundary({ inputSignals: { fixtureA: check.inputSignals.fixtureA } });
    const outputB = buildMiraCoreServerBoundary({ inputSignals: { fixtureA: check.inputSignals.fixtureB } });
    const changed = buildMiraCoreServerBoundary({ inputSignals: { fixtureA: check.inputSignals.fixtureChangedWatermark } });

    expect(firstReceive(outputA).idempotency_key).toBe(firstReceive(outputB).idempotency_key);
    expect(firstStatus(outputA).idempotency_key).toBe(firstStatus(outputB).idempotency_key);
    expect(firstReceive(changed).idempotency_key).not.toBe(firstReceive(outputA).idempotency_key);
    expect(outputA.validation_report.idempotency_result.excludes).toEqual(expect.arrayContaining(check.expectedOutput.keysMustExclude));
  });

  test('server boundary validation performs no server/network/store/queue/action side effects', () => {
    const check = acceptance('no-side-effects');
    const output = buildMiraCoreServerBoundary({ inputSignals: check.inputSignals });

    expect(output.validation_report.side_effect_result).toEqual(expect.objectContaining(check.expectedOutput.validation_report.side_effect_result));
    expect(output.validation_report.side_effect_result.outputFileWritten).toBe(false);
    expect(firstReceive(output).side_effect_result.databaseWritesAttempted).toBe(0);
    expect(firstStatus(output).side_effect_result.queuesCreated).toBe(0);
    expectNoForbiddenOutput(output, check.expectedOutput.mustNotInclude);
  });

  test('static validation rules are represented by validator checks', () => {
    const output = buildMiraCoreServerBoundary({
      inputSignals: {
        upload_envelope: acceptance('accept-redacted-upload-envelope-ref').inputSignals.upload_envelope,
        bridge: acceptance('bridge-delivery-truth').inputSignals.bridge,
        delivery: acceptance('bridge-delivery-truth').inputSignals.delivery,
      },
    });
    const validation = validateMiraCoreServerBoundaryOutput(output, serverBoundaryContract);

    expect(validation.ok).toBe(true);
    const checkIds = validation.checks.map((entry) => entry.id);
    for (const rule of serverBoundaryContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
  });

  test('validator rejects required-field gaps, raw storage, capability/proof lies, direct targets, side effects, stale acceptance, and bad idempotency', () => {
    const valid = buildMiraCoreServerBoundary({
      inputSignals: acceptance('accept-redacted-upload-envelope-ref').inputSignals,
    });
    expect(validateMiraCoreServerBoundaryOutput(valid, serverBoundaryContract).ok).toBe(true);

    const missingField = clone(valid);
    delete missingField.server_receive_records[0].source_upload_ref;
    expect(validateMiraCoreServerBoundaryOutput(missingField, serverBoundaryContract)).toEqual(expect.objectContaining({ ok: false }));

    const rawStored = clone(valid);
    rawStored.server_receive_records[0].redaction_audit.rawCommsStored = true;
    expect(validateMiraCoreServerBoundaryOutput(rawStored, serverBoundaryContract)).toEqual(expect.objectContaining({ ok: false }));

    const serverCanExecute = clone(valid);
    serverCanExecute.server_receive_records[0].capability_truth.serverCanExecuteLocal = true;
    expect(validateMiraCoreServerBoundaryOutput(serverCanExecute, serverBoundaryContract)).toEqual(expect.objectContaining({ ok: false }));

    const bridgeGreenLie = clone(valid);
    bridgeGreenLie.server_status_summaries[0].bridge_delivery_truth.bridgeGreenFromSocketAlone = true;
    expect(validateMiraCoreServerBoundaryOutput(bridgeGreenLie, serverBoundaryContract)).toEqual(expect.objectContaining({ ok: false }));

    const modelProofLie = clone(valid);
    modelProofLie.server_status_summaries[0].server_capability_summary.serverCanProveModelProcessing = true;
    expect(validateMiraCoreServerBoundaryOutput(modelProofLie, serverBoundaryContract)).toEqual(expect.objectContaining({ ok: false }));

    const bridgeModelProofLie = clone(valid);
    bridgeModelProofLie.server_status_summaries[0].bridge_delivery_truth.modelProcessingProof = true;
    bridgeModelProofLie.server_status_summaries[0].bridge_delivery_truth.modelProcessingProofBasis = 'server claimed it';
    const bridgeValidation = validateMiraCoreServerBoundaryOutput(bridgeModelProofLie, serverBoundaryContract);
    expect(bridgeValidation).toEqual(expect.objectContaining({ ok: false }));
    expect(bridgeValidation.checks.find((entry) => entry.id === 'bridge-delivery-proof-boundary')).toEqual(expect.objectContaining({ ok: false }));

    const futureTargetBuilder = clone(valid);
    futureTargetBuilder.server_receive_records[0].server_targeting.future_server_originated_target = 'builder';
    expect(validateMiraCoreServerBoundaryOutput(futureTargetBuilder, serverBoundaryContract)).toEqual(expect.objectContaining({ ok: false }));

    const directOracleAccepted = clone(valid);
    directOracleAccepted.server_receive_records[0].source_intent_refs[0].target_role = 'oracle';
    directOracleAccepted.server_receive_records[0].decision = 'accepted_for_future_store_shape_no_write';
    expect(validateMiraCoreServerBoundaryOutput(directOracleAccepted, serverBoundaryContract)).toEqual(expect.objectContaining({ ok: false }));

    const sideEffectLie = clone(valid);
    sideEffectLie.validation_report.side_effect_result.no_network_performed = false;
    sideEffectLie.validation_report.side_effect_result.networkRequestsAttempted = 1;
    expect(validateMiraCoreServerBoundaryOutput(sideEffectLie, serverBoundaryContract)).toEqual(expect.objectContaining({ ok: false }));

    const staleAccepted = clone(valid);
    staleAccepted.server_receive_records[0].stale_watermark_result.reasons = ['watermark_regression'];
    staleAccepted.server_receive_records[0].stale_watermark_result.watermark_regression = true;
    staleAccepted.server_receive_records[0].decision = 'accepted_for_future_store_shape_no_write';
    expect(validateMiraCoreServerBoundaryOutput(staleAccepted, serverBoundaryContract)).toEqual(expect.objectContaining({ ok: false }));

    const unstableKey = clone(valid);
    unstableKey.server_receive_records[0].idempotency_key = 'server-boundary-receive-idem:tampered';
    expect(validateMiraCoreServerBoundaryOutput(unstableKey, serverBoundaryContract)).toEqual(expect.objectContaining({ ok: false }));
  });

  test('CLI prints stdout JSON only and ignores output-file flags', () => {
    expect(parseArgs(['--pretty', '--out', 'server-boundary.json'])).toEqual({ pretty: true });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=server-boundary.json'], JSON.stringify(acceptance('accept-redacted-upload-envelope-ref').inputSignals));

    expect(firstReceive(output).schema).toBe(SERVER_RECEIVE_RECORD_SCHEMA_VERSION);
    expect(firstStatus(output).schema).toBe(SERVER_STATUS_SUMMARY_SCHEMA_VERSION);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.server_receive_records[0].schema).toBe(SERVER_RECEIVE_RECORD_SCHEMA_VERSION);
    expect(printed.server_status_summaries[0].schema).toBe(SERVER_STATUS_SUMMARY_SCHEMA_VERSION);
    expect(printed.validation_report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(printed.validation_report.side_effect_result.no_database_write_performed).toBe(true);
    expect(printed.validation_report.side_effect_result.outputFileWritten).toBe(false);
  });
});
