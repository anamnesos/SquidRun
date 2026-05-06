const perceptionContract = require('./fixtures/mira-core-perception-contract.json');
const {
  CAPTURE_REQUEST_RECORD_SCHEMA_VERSION,
  EVIDENCE_SUMMARY_RECORD_SCHEMA_VERSION,
  REQUIRED_CAPTURE_REQUEST_FIELDS,
  REQUIRED_EVIDENCE_SUMMARY_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  buildMiraCorePerception,
  validateMiraCorePerceptionOutput,
} = require('../modules/mira-core/perception');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-perception');

function acceptance(id) {
  return perceptionContract.acceptanceChecks.find((check) => check.id === id);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return JSON.stringify(value);
}

function firstCapture(output) {
  return output.capture_request_records[0];
}

function firstEvidence(output) {
  return output.evidence_summary_records[0];
}

function expectRequiredFields(value, fields) {
  for (const field of fields) {
    expect(value).toHaveProperty(field);
  }
}

function expectNoForbiddenOutput(output, extra = []) {
  const outputText = text(output);
  for (const forbidden of [...perceptionContract.forbiddenOutputSubstrings, ...extra]) {
    expect(outputText).not.toContain(forbidden);
  }
}

describe('mira core perception v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, capture request, evidence summary, and validation report shapes', () => {
    const output = buildMiraCorePerception({
      inputSignals: acceptance('ready-active-task-window-request').inputSignals,
      nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
    });
    const capture = firstCapture(output);
    const evidence = firstEvidence(output);
    const report = output.validation_report;

    expectRequiredFields(output, perceptionContract.expectedOutputShape.requiredTopLevelFields);
    expect(perceptionContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(capture.schema).toBe(CAPTURE_REQUEST_RECORD_SCHEMA_VERSION);
    expect(evidence.schema).toBe(EVIDENCE_SUMMARY_RECORD_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(capture, perceptionContract.expectedCaptureRequestRecordShape.requiredFields);
    expect(perceptionContract.expectedCaptureRequestRecordShape.requiredFields).toEqual(REQUIRED_CAPTURE_REQUEST_FIELDS);
    expectRequiredFields(capture.source_acceptance_ref, perceptionContract.expectedCaptureRequestRecordShape.sourceAcceptanceRequiredFields);
    expectRequiredFields(capture.source_mutation_patch_ref, perceptionContract.expectedCaptureRequestRecordShape.sourceMutationPatchRequiredFields);
    expectRequiredFields(capture.opt_in, perceptionContract.expectedCaptureRequestRecordShape.optInRequiredFields);
    expectRequiredFields(capture.task_scope, perceptionContract.expectedCaptureRequestRecordShape.taskScopeRequiredFields);
    for (const source of capture.allowed_sources) {
      expectRequiredFields(source, perceptionContract.expectedCaptureRequestRecordShape.allowedSourcesRequiredFields);
    }
    expectRequiredFields(capture.redaction_policy, perceptionContract.expectedCaptureRequestRecordShape.redactionPolicyRequiredFields);
    expectRequiredFields(capture.expiry, perceptionContract.expectedCaptureRequestRecordShape.expiryRequiredFields);
    expectRequiredFields(capture.deletion_policy, perceptionContract.expectedCaptureRequestRecordShape.deletionPolicyRequiredFields);
    expectRequiredFields(capture.james_visible_controls, perceptionContract.expectedCaptureRequestRecordShape.jamesVisibleControlsRequiredFields);
    expectRequiredFields(capture.capability_truth, perceptionContract.expectedCaptureRequestRecordShape.capabilityTruthRequiredFields);
    expectRequiredFields(evidence, perceptionContract.expectedEvidenceSummaryRecordShape.requiredFields);
    expect(perceptionContract.expectedEvidenceSummaryRecordShape.requiredFields).toEqual(REQUIRED_EVIDENCE_SUMMARY_FIELDS);
    expectRequiredFields(evidence.redaction_audit, perceptionContract.expectedEvidenceSummaryRecordShape.redactionAuditRequiredFields);
    expectRequiredFields(report, perceptionContract.expectedValidationReportShape.requiredTopLevelFields);
    expect(perceptionContract.expectedValidationReportShape.requiredTopLevelFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCorePerceptionOutput(output, perceptionContract)).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('explicit active-task window request is ready for review without capture', () => {
    const check = acceptance('ready-active-task-window-request');
    const output = buildMiraCorePerception({ inputSignals: check.inputSignals });
    const capture = firstCapture(output);

    expect(capture).toEqual(expect.objectContaining({
      status: check.expectedCaptureRequest.status,
      risk_tier: check.expectedCaptureRequest.risk_tier,
      review_required: check.expectedCaptureRequest.review_required,
    }));
    expect(capture.opt_in).toEqual(expect.objectContaining(check.expectedCaptureRequest.opt_in));
    expect(capture.redaction_policy).toEqual(expect.objectContaining(check.expectedCaptureRequest.redaction_policy));
    expect(capture.side_effect_result).toEqual(expect.objectContaining(check.expectedCaptureRequest.side_effect_result));
    expect(capture.allowed_sources[0].source_type).toBe('active_task_window');
    expect(output.validation_report.ready_for_review_count).toBe(1);
  });

  test('redacted evidence summary exports summary, hash, and refs only', () => {
    const check = acceptance('ready-redacted-evidence-summary-shape');
    const output = buildMiraCorePerception({ inputSignals: check.inputSignals });
    const evidence = firstEvidence(output);

    expect(evidence).toEqual(expect.objectContaining({
      capture_status: check.expectedEvidenceSummary.capture_status,
      raw_artifacts_exported: check.expectedEvidenceSummary.raw_artifacts_exported,
      raw_artifacts_retained: check.expectedEvidenceSummary.raw_artifacts_retained,
      memory_commit_status: check.expectedEvidenceSummary.memory_commit_status,
    }));
    expect(evidence.redaction_audit).toEqual(expect.objectContaining(check.expectedEvidenceSummary.redaction_audit));
    expect(evidence.summary_hash).toMatch(/^sha256:/);
    expect(evidence.evidenceRefs).toHaveLength(1);
  });

  test('always-on and all-window screen memory is blocked', () => {
    const check = acceptance('block-always-on-screen-memory');
    const output = buildMiraCorePerception({ inputSignals: check.inputSignals });
    const capture = firstCapture(output);

    expect(capture).toEqual(expect.objectContaining(check.expectedCaptureRequest));
    expect(output.validation_report.blocked_count).toBe(1);
    expectNoForbiddenOutput(output, check.mustNotInclude);
  });

  test('raw screenshot and OCR export requests are blocked', () => {
    const check = acceptance('block-raw-screenshot-ocr-export');
    const output = buildMiraCorePerception({ inputSignals: check.inputSignals });
    const capture = firstCapture(output);

    expect(capture.status).toBe(check.expectedCaptureRequest.status);
    expect(capture.redaction_policy).toEqual(expect.objectContaining(check.expectedCaptureRequest.redaction_policy));
    expect(capture.blocked_because).toBe(check.expectedCaptureRequest.blocked_because);
    expectNoForbiddenOutput(output, check.forbiddenOutputSubstringsMustBeAbsent);
  });

  test('browser profile state and cookies are blocked', () => {
    const check = acceptance('block-browser-profile-state');
    const output = buildMiraCorePerception({ inputSignals: check.inputSignals });
    const capture = firstCapture(output);

    expect(capture).toEqual(expect.objectContaining(check.expectedCaptureRequest));
    expectNoForbiddenOutput(output, check.mustNotInclude);
  });

  test('customer private content without review is blocked and routed to James review', () => {
    const check = acceptance('block-customer-private-without-review');
    const output = buildMiraCorePerception({ inputSignals: check.inputSignals });
    const capture = firstCapture(output);

    expect(capture).toEqual(expect.objectContaining(check.expectedCaptureRequest));
    expectNoForbiddenOutput(output, check.mustNotInclude);
  });

  test('secret or auth material is always blocked', () => {
    const check = acceptance('block-secret-auth-material');
    const output = buildMiraCorePerception({ inputSignals: check.inputSignals });
    const capture = firstCapture(output);

    expect(capture.status).toBe(check.expectedCaptureRequest.status);
    expect(capture.blocked_because).toBe(check.expectedCaptureRequest.blocked_because);
    expectNoForbiddenOutput(output, check.forbiddenOutputSubstringsMustBeAbsent);
  });

  test('side-profile content cannot enter main-profile evidence', () => {
    const check = acceptance('block-side-profile-content');
    const output = buildMiraCorePerception({ inputSignals: check.inputSignals });
    const capture = firstCapture(output);

    expect(capture).toEqual(expect.objectContaining(check.expectedCaptureRequest));
  });

  test('expiry and James delete/pause/revoke controls are required', () => {
    const check = acceptance('expiry-and-delete-controls-required');
    const output = buildMiraCorePerception({ inputSignals: check.inputSignals });
    const capture = firstCapture(output);

    expect(capture.status).toBe(check.expectedCaptureRequest.status);
    expect(capture.blocked_because).toBe(check.expectedCaptureRequest.blocked_because);
    expect(capture.deletion_policy).toEqual(expect.objectContaining(check.expectedCaptureRequest.deletion_policy));
  });

  test('capability truth preserves proposal/capture/memory/proof boundaries', () => {
    const check = acceptance('capability-truth-proof-boundaries');
    const output = buildMiraCorePerception({ inputSignals: check.inputSignals });
    const capture = firstCapture(output);

    expect(capture.capability_truth).toEqual(expect.objectContaining(check.expectedCaptureRequest.capability_truth));
    expect(output.validation_report.capability_truth_result.serverCanCaptureLocalScreen).toBe(false);
    expect(output.validation_report.capability_truth_result.alwaysOnMemoryAllowed).toBe(false);
    expectNoForbiddenOutput(output, check.mustNotInclude);
  });

  test('idempotency is stable for same scope and changes with app/window scope', () => {
    const check = acceptance('idempotency-stable-sensitive');
    const outputA = buildMiraCorePerception({ inputSignals: { request: check.inputSignals.fixtureA } });
    const outputB = buildMiraCorePerception({ inputSignals: { request: check.inputSignals.fixtureB } });
    const changed = buildMiraCorePerception({ inputSignals: { request: check.inputSignals.fixtureChangedScope } });

    expect(firstCapture(outputA).idempotency_key).toBe(firstCapture(outputB).idempotency_key);
    expect(firstEvidence(outputA).idempotency_key).toBe(firstEvidence(outputB).idempotency_key);
    expect(firstCapture(changed).idempotency_key).not.toBe(firstCapture(outputA).idempotency_key);
    expect(outputA.validation_report.input_refs.capture_request_ids).toContain(firstCapture(outputA).capture_request_id);
    expect(check.expectedOutput.keysMustExclude).toEqual(expect.arrayContaining([
      'capture_request_id',
      'evidence_summary_id',
      'created_at',
      'validation_run_id',
      'generated_at',
    ]));
  });

  test('no capture, browser access, write, network, send, deploy, trade, or output file occurs', () => {
    const check = acceptance('no-side-effects');
    const output = buildMiraCorePerception({ inputSignals: check.inputSignals });

    expect(output.validation_report.side_effect_result).toEqual(expect.objectContaining(check.expectedOutput.validation_report.side_effect_result));
    expect(output.validation_report.side_effect_result.outputFileWritten).toBe(false);
    expect(firstCapture(output).side_effect_result.capturesAttempted).toBe(0);
    expect(firstEvidence(output).side_effect_result.ocrAttempted).toBe(0);
    expectNoForbiddenOutput(output, check.expectedOutput.mustNotInclude);
  });

  test('static validation rules are represented by validator checks', () => {
    const output = buildMiraCorePerception({
      inputSignals: {
        requests: [
          acceptance('ready-active-task-window-request').inputSignals.request,
          acceptance('block-always-on-screen-memory').inputSignals.request,
          acceptance('block-secret-auth-material').inputSignals.request,
        ],
      },
    });
    const validation = validateMiraCorePerceptionOutput(output, perceptionContract);

    expect(validation.ok).toBe(true);
    const checkIds = validation.checks.map((entry) => entry.id);
    for (const rule of perceptionContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
  });

  test('validator rejects missing fields, bad opt-in, broad source, raw export, capability lies, missing expiry, side-effect lies, and unstable keys', () => {
    const valid = buildMiraCorePerception({
      inputSignals: acceptance('ready-active-task-window-request').inputSignals,
    });
    expect(validateMiraCorePerceptionOutput(valid, perceptionContract).ok).toBe(true);

    const missingField = clone(valid);
    delete missingField.capture_request_records[0].opt_in;
    expect(validateMiraCorePerceptionOutput(missingField, perceptionContract)).toEqual(expect.objectContaining({ ok: false }));

    const missingOptIn = clone(valid);
    missingOptIn.capture_request_records[0].opt_in.explicit = false;
    expect(validateMiraCorePerceptionOutput(missingOptIn, perceptionContract)).toEqual(expect.objectContaining({ ok: false }));

    const broadSource = clone(valid);
    broadSource.capture_request_records[0].allowed_sources[0].source_type = 'all_windows';
    expect(validateMiraCorePerceptionOutput(broadSource, perceptionContract)).toEqual(expect.objectContaining({ ok: false }));

    const rawExport = clone(valid);
    rawExport.evidence_summary_records[0].raw_artifacts_exported = true;
    rawExport.evidence_summary_records[0].raw_artifact_hashes = ['sha256:raw'];
    expect(validateMiraCorePerceptionOutput(rawExport, perceptionContract)).toEqual(expect.objectContaining({ ok: false }));

    const serverCaptureLie = clone(valid);
    serverCaptureLie.capture_request_records[0].capability_truth.server_can_capture_local_screen = true;
    expect(validateMiraCorePerceptionOutput(serverCaptureLie, perceptionContract)).toEqual(expect.objectContaining({ ok: false }));

    const alwaysOnMemoryLie = clone(valid);
    alwaysOnMemoryLie.validation_report.capability_truth_result.alwaysOnMemoryAllowed = true;
    expect(validateMiraCorePerceptionOutput(alwaysOnMemoryLie, perceptionContract)).toEqual(expect.objectContaining({ ok: false }));

    const sideProfileLeak = clone(valid);
    sideProfileLeak.evidence_summary_records[0].privacy_classification = 'side_profile';
    sideProfileLeak.evidence_summary_records[0].redaction_audit.sideProfileContentExported = true;
    expect(validateMiraCorePerceptionOutput(sideProfileLeak, perceptionContract)).toEqual(expect.objectContaining({ ok: false }));

    const missingExpiry = clone(valid);
    missingExpiry.capture_request_records[0].expiry.expires_at = null;
    expect(validateMiraCorePerceptionOutput(missingExpiry, perceptionContract)).toEqual(expect.objectContaining({ ok: false }));

    const sideEffectLie = clone(valid);
    sideEffectLie.validation_report.side_effect_result.no_capture_performed = false;
    sideEffectLie.validation_report.side_effect_result.capturesAttempted = 1;
    expect(validateMiraCorePerceptionOutput(sideEffectLie, perceptionContract)).toEqual(expect.objectContaining({ ok: false }));

    const unstableKey = clone(valid);
    unstableKey.capture_request_records[0].idempotency_key = 'perception-capture-idem:tampered';
    expect(validateMiraCorePerceptionOutput(unstableKey, perceptionContract)).toEqual(expect.objectContaining({ ok: false }));
  });

  test('CLI prints stdout JSON only and ignores output-file flags', () => {
    expect(parseArgs(['--pretty', '--out', 'perception.json'])).toEqual({ pretty: true });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=perception.json'], JSON.stringify(acceptance('ready-active-task-window-request').inputSignals));

    expect(firstCapture(output).schema).toBe(CAPTURE_REQUEST_RECORD_SCHEMA_VERSION);
    expect(firstEvidence(output).schema).toBe(EVIDENCE_SUMMARY_RECORD_SCHEMA_VERSION);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.capture_request_records[0].schema).toBe(CAPTURE_REQUEST_RECORD_SCHEMA_VERSION);
    expect(printed.evidence_summary_records[0].schema).toBe(EVIDENCE_SUMMARY_RECORD_SCHEMA_VERSION);
    expect(printed.validation_report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(printed.validation_report.side_effect_result.no_capture_performed).toBe(true);
    expect(printed.validation_report.side_effect_result.outputFileWritten).toBe(false);
  });
});
