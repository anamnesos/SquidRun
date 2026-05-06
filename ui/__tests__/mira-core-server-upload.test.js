const serverUploadContract = require('./fixtures/mira-core-server-upload-contract.json');
const {
  ENVELOPE_SCHEMA_VERSION,
  REQUIRED_ENVELOPE_FIELDS,
  REQUIRED_INCLUDED_ITEM_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  buildMiraCoreServerUpload,
  validateMiraCoreServerUploadOutput,
} = require('../modules/mira-core/server-upload');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-server-upload');

function acceptance(id) {
  return serverUploadContract.acceptanceChecks.find((check) => check.id === id);
}

function expectedUploadEnvelopeShape() {
  return serverUploadContract.expectedUploadEnvelopeShape || serverUploadContract.expectedEnvelopeShape;
}

function uploadContract() {
  return {
    ...serverUploadContract,
    expectedUploadEnvelopeShape: expectedUploadEnvelopeShape(),
  };
}

function text(value) {
  return JSON.stringify(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectNoForbiddenOutput(output, extra = []) {
  const outputText = text(output);
  for (const forbidden of [...serverUploadContract.forbiddenOutputSubstrings, ...extra]) {
    expect(outputText).not.toContain(forbidden);
  }
}

function expectRequiredFields(value, fields) {
  for (const field of fields) {
    expect(value).toHaveProperty(field);
  }
}

describe('mira core server upload envelope v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle server-upload output, envelope, validation, and item shapes', () => {
    const check = acceptance('eligible-items-included-only');
    const output = buildMiraCoreServerUpload({
      inputSignals: check.inputSignals,
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });
    const envelope = output.upload_envelope;
    const report = output.validation_report;
    const envelopeShape = expectedUploadEnvelopeShape();

    expectRequiredFields(output, serverUploadContract.expectedOutputShape.requiredTopLevelFields);
    expect(serverUploadContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(envelope.schema).toBe(ENVELOPE_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(envelope, envelopeShape.requiredTopLevelFields);
    expect(envelopeShape.requiredTopLevelFields).toEqual(REQUIRED_ENVELOPE_FIELDS);
    expectRequiredFields(report, serverUploadContract.expectedValidationReportShape.requiredTopLevelFields);
    expect(serverUploadContract.expectedValidationReportShape.requiredTopLevelFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expectRequiredFields(envelope.profile, envelopeShape.profileRequiredFields);
    expectRequiredFields(envelope.snapshotRef, envelopeShape.snapshotRefRequiredFields);
    for (const watermark of envelope.source_watermarks) {
      expectRequiredFields(watermark, envelopeShape.sourceWatermarkRequiredFields);
    }
    for (const item of envelope.included_items) {
      expectRequiredFields(item, envelopeShape.includedItemRequiredFields);
      expect(envelopeShape.includedItemRequiredFields).toEqual(REQUIRED_INCLUDED_ITEM_FIELDS);
    }
    expectRequiredFields(envelope.withheld_items_summary, envelopeShape.withheldSummaryRequiredFields);
    expectRequiredFields(envelope.server_migration, envelopeShape.serverMigrationRequiredFields);
    expectRequiredFields(envelope.signature_envelope, envelopeShape.signatureEnvelopeContract.requiredFields);
    expect(validateMiraCoreServerUploadOutput(output, uploadContract())).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('eligible safe and already-redacted items are included, unsafe items are withheld', () => {
    const check = acceptance('eligible-items-included-only');
    const output = buildMiraCoreServerUpload({ inputSignals: check.inputSignals });
    const envelope = output.upload_envelope;
    const report = output.validation_report;

    expect(envelope.included_items.map((item) => item.id)).toEqual(check.expectedOutput.includedItemIds);
    expect(report.eligibility_result.withheldItemIds).toEqual(expect.arrayContaining(check.expectedOutput.withheldItemIds));
    expect(envelope.withheld_items_summary.by_reason).toEqual(expect.objectContaining(check.expectedOutput.withheldByReasonMustInclude));
    expect(report.decision).toBe(check.expectedOutput.decision);
    expect(report.side_effect_result.networkRequestsAttempted).toBe(0);
    expect(report.side_effect_result.queuesCreated).toBe(0);
    expect(report.side_effect_result.sourceStoreWritesAttempted).toBe(0);
    expect(report.side_effect_result.memoryCommitsAttempted).toBe(0);
    expect(report.side_effect_result.profileCommitsAttempted).toBe(0);
  });

  test('unredacted core_sync_redacted items are withheld with warning decision', () => {
    const check = acceptance('unredacted-core-sync-redacted-withheld');
    const output = buildMiraCoreServerUpload({ inputSignals: check.inputSignals });

    expect(output.upload_envelope.included_items.map((item) => item.id)).toEqual(check.expectedOutput.includedItemIds);
    expect(output.upload_envelope.redaction_audit.withheldByReason).toEqual(expect.objectContaining(check.expectedOutput.withheldByReasonMustInclude));
    expect(output.validation_report.decision).toBe(check.expectedOutput.decision);
    expect(output.upload_envelope.redaction_audit.rawCommsExported).toBe(false);
    expect(output.upload_envelope.redaction_audit.withheldCount).toBe(check.expectedOutput.redaction_audit.withheldCount);
    expectNoForbiddenOutput(output);
  });

  test('raw private data classes are counted without leaking payload content', () => {
    const check = acceptance('raw-content-leak-prevention');
    const output = buildMiraCoreServerUpload({ inputSignals: check.inputSignals });

    expect(output.upload_envelope.redaction_audit).toEqual(expect.objectContaining(check.expectedOutput.redactionAuditMustSet));
    for (const dataClass of check.inputSignals.blockedDataClasses) {
      expect(output.upload_envelope.redaction_audit.withheldByReason).toHaveProperty(dataClass);
      expect(output.upload_envelope.withheld_items_summary.by_reason).toHaveProperty(dataClass);
    }
    expect(output.upload_envelope.withheld_items_summary.examples_are_refs_only).toBe(true);
    expectNoForbiddenOutput(output, check.expectedOutput.forbiddenOutputSubstringsMustBeAbsent);
  });

  test('side-profile, profile mismatch, and missing scope are withheld', () => {
    const check = acceptance('profile-isolation-side-profile-withheld');
    const output = buildMiraCoreServerUpload({ inputSignals: check.inputSignals });

    expect(output.upload_envelope.included_items.map((item) => item.id)).toEqual(check.expectedOutput.includedItemIds);
    expect(output.validation_report.eligibility_result.withheldItemIds).toEqual(expect.arrayContaining(check.expectedOutput.withheldItemIds));
    expect(output.upload_envelope.redaction_audit.withheldByReason).toEqual(expect.objectContaining(check.expectedOutput.withheldByReasonMustInclude));
    for (const item of output.upload_envelope.included_items) {
      expect(item.profile).toBe('main');
      expect(item.sessionId).toBe('app-session-326');
      expect(item.deviceId).toBe('VIGIL');
    }
  });

  test('redaction audit counts and refs match withheld summary', () => {
    const check = acceptance('redaction-audit-counts-and-refs');
    const output = buildMiraCoreServerUpload({ inputSignals: check.inputSignals });
    const audit = output.upload_envelope.redaction_audit;

    for (const field of check.expectedOutput.redactionAuditMustInclude) {
      expect(audit).toHaveProperty(field);
    }
    expect(audit.redactedCount).toBe(check.inputSignals.expectedRedactedIncluded);
    expect(audit.withheldByReason).toEqual(expect.objectContaining(check.inputSignals.expectedWithheldByReason));
    expect(audit.withheldCount).toBe(output.upload_envelope.withheld_items_summary.total);
    expect(audit.withheldByReason).toEqual(output.upload_envelope.withheld_items_summary.by_reason);
    expect(output.upload_envelope.withheld_items_summary.examples_are_refs_only).toBe(true);
    expect(text(output.upload_envelope.withheld_items_summary.sample_refs)).not.toContain('payload text');
  });

  test('idempotency is stable for same canonical input and sensitive to changed watermarks, profile, device, and snapshot', () => {
    const check = acceptance('idempotency-stable-and-sensitive');
    const fixtureA = buildMiraCoreServerUpload({ inputSignals: check.inputSignals.fixtureA });
    const fixtureB = buildMiraCoreServerUpload({ inputSignals: check.inputSignals.fixtureB });
    const changedWatermark = buildMiraCoreServerUpload({ inputSignals: check.inputSignals.fixtureChangedWatermark });
    const changedProfile = buildMiraCoreServerUpload({
      inputSignals: { ...check.inputSignals.fixtureA, profile: 'alt-profile' },
    });
    const changedDevice = buildMiraCoreServerUpload({
      inputSignals: { ...check.inputSignals.fixtureA, deviceId: 'ALTDEVICE' },
    });
    const changedSnapshot = buildMiraCoreServerUpload({
      inputSignals: { ...check.inputSignals.fixtureA, snapshotHash: 'sha256:snapshot-b' },
    });

    expect(fixtureA.upload_envelope.idempotency_key).toBe(fixtureB.upload_envelope.idempotency_key);
    expect(changedWatermark.upload_envelope.idempotency_key).not.toBe(fixtureA.upload_envelope.idempotency_key);
    expect(changedProfile.upload_envelope.idempotency_key).not.toBe(fixtureA.upload_envelope.idempotency_key);
    expect(changedDevice.upload_envelope.idempotency_key).not.toBe(fixtureA.upload_envelope.idempotency_key);
    expect(changedSnapshot.upload_envelope.idempotency_key).not.toBe(fixtureA.upload_envelope.idempotency_key);
    expect(fixtureA.validation_report.idempotency_result.excludes).toEqual(expect.arrayContaining(check.expectedOutput.idempotencyInputMustExclude));
  });

  test('source watermarks are required and every included item points to one', () => {
    const check = acceptance('source-watermarks-required');
    const output = buildMiraCoreServerUpload({ inputSignals: check.inputSignals });
    const watermarkRefs = new Set(output.upload_envelope.source_watermarks.map((watermark) => `${watermark.source}:${watermark.scope}`));

    for (const source of check.inputSignals.requiredSources) {
      expect(output.upload_envelope.source_watermarks.map((watermark) => watermark.source)).toContain(source);
    }
    for (const item of output.upload_envelope.included_items) {
      for (const field of check.expectedOutput.everyIncludedItemMustHave) {
        expect(item).toHaveProperty(field);
      }
      expect(watermarkRefs.has(item.source_watermark_ref)).toBe(true);
    }

    const missing = buildMiraCoreServerUpload({
      inputSignals: {
        sourceWatermarksMissing: true,
        snapshotItems: [{
          id: 'safe-without-watermark',
          syncEligibility: 'core_sync_safe',
          redactionStatus: 'none',
          profile: 'main',
          sessionId: 'app-session-326',
          deviceId: 'VIGIL',
        }],
      },
    });
    expect(missing.validation_report.decision).toBe(check.expectedOutput.missingWatermarkDecision);
    const regression = buildMiraCoreServerUpload({
      inputSignals: {
        ...check.inputSignals,
        watermarkRegression: true,
      },
    });
    expect(regression.validation_report.decision).toBe(check.expectedOutput.watermarkRegressionDecision);
  });

  test('capability truth preserves local-arms/server boundary and blocks Builder/Oracle targeting', () => {
    const check = acceptance('capability-truth-local-arms-boundary');
    const output = buildMiraCoreServerUpload({ inputSignals: check.inputSignals });

    expect(output.upload_envelope.capability_summary).toEqual(expect.objectContaining(check.expectedOutput.capability_summary));
    expect(output.upload_envelope.server_migration).toEqual(expect.objectContaining(check.expectedOutput.server_migration));
    expect(output.upload_envelope.server_migration.serverMustNot).toEqual(expect.arrayContaining(check.expectedOutput.server_migration.serverMustNot));
    for (const forbidden of check.expectedOutput.mustNotInclude) {
      expect(text(output)).not.toContain(forbidden);
    }
  });

  test('bridge and delivery proof remain unproven without role discovery and quote-back', () => {
    const check = acceptance('bridge-delivery-truth-preserved');
    const output = buildMiraCoreServerUpload({ inputSignals: check.inputSignals });

    expect(output.upload_envelope.capability_summary).toEqual(expect.objectContaining(check.expectedOutput.capability_summary));
    expect(output.validation_report.bridge_delivery_truth_result).toEqual(expect.objectContaining(check.expectedOutput.validation_report.bridge_delivery_truth_result));
    expect(output.validation_report.bridge_delivery_truth_result.warnings).toEqual(expect.arrayContaining(check.expectedOutput.validation_report.bridge_delivery_truth_result.warnings));
    for (const forbidden of check.expectedOutput.mustNotInclude) {
      expect(text(output)).not.toContain(forbidden);
    }
  });

  test('stale snapshots warn and watermark regressions reject', () => {
    const check = acceptance('stale-snapshot-warning-or-reject');
    const output = buildMiraCoreServerUpload({ inputSignals: check.inputSignals });

    expect(check.expectedOutput.allowedDecision).toContain(output.validation_report.decision);
    expect(output.validation_report.reasons).toEqual(expect.arrayContaining(check.expectedOutput.reasonsMustInclude));

    const regression = buildMiraCoreServerUpload({
      inputSignals: {
        ...check.inputSignals,
        watermarkRegression: true,
      },
    });
    expect(regression.validation_report.decision).toBe(check.expectedOutput.ifWatermarkRegressionThen.decision);
    expect(regression.validation_report.reasons).toEqual(expect.arrayContaining(check.expectedOutput.ifWatermarkRegressionThen.reasonsMustInclude));
  });

  test('signature envelope is placeholder-only with deterministic payload hash and no secrets', () => {
    const outputA = buildMiraCoreServerUpload({
      inputSignals: acceptance('eligible-items-included-only').inputSignals,
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });
    const outputB = buildMiraCoreServerUpload({
      inputSignals: acceptance('eligible-items-included-only').inputSignals,
      nowMs: Date.parse('2026-05-06T05:00:00.000Z'),
    });
    const signature = outputA.upload_envelope.signature_envelope;

    expect(signature).toEqual(expect.objectContaining(expectedUploadEnvelopeShape().signatureEnvelopeContract.requiredV0Values));
    expect(signature.payload_hash).toMatch(/^sha256:/);
    expect(signature.payload_hash).toBe(outputB.upload_envelope.signature_envelope.payload_hash);
    expect(text(signature)).not.toContain('BEGIN PRIVATE KEY');
    expect(text(signature)).not.toContain('Authorization: Bearer');
  });

  test('no network, queue, action, deploy, trade, or output-file side effects occur', () => {
    const check = acceptance('no-network-queue-action-side-effects');
    const output = buildMiraCoreServerUpload({ inputSignals: check.inputSignals });

    expect(output.upload_envelope.no_network_performed).toBe(true);
    expect(output.validation_report.side_effect_result).toEqual(expect.objectContaining(check.expectedOutput.validation_report.side_effect_result));
    expect(output.validation_report.side_effect_result.deploysAttempted).toBe(0);
    expect(output.validation_report.side_effect_result.tradesAttempted).toBe(0);
    expect(output.validation_report.side_effect_result.outputFileWritten).toBe(false);
    for (const forbidden of check.expectedOutput.mustNotInclude) {
      expect(text(output)).not.toContain(forbidden);
    }
  });

  test('static validation rules are covered by the output validator', () => {
    const output = buildMiraCoreServerUpload({
      inputSignals: {
        ...acceptance('eligible-items-included-only').inputSignals,
        bridge: acceptance('bridge-delivery-truth-preserved').inputSignals.bridge,
        delivery: acceptance('bridge-delivery-truth-preserved').inputSignals.delivery,
      },
    });
    const validation = validateMiraCoreServerUploadOutput(output, uploadContract());

    expect(validation.ok).toBe(true);
    const checkIds = validation.checks.map((check) => check.id);
    for (const rule of serverUploadContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
  });

  test('validator rejects missing fixture-owned required fields and literal changes', () => {
    const valid = buildMiraCoreServerUpload({
      inputSignals: acceptance('eligible-items-included-only').inputSignals,
    });
    expect(validateMiraCoreServerUploadOutput(valid, uploadContract()).ok).toBe(true);

    const missingEvidence = clone(valid);
    delete missingEvidence.upload_envelope.included_items[0].evidenceRefs;
    expect(validateMiraCoreServerUploadOutput(missingEvidence, uploadContract())).toEqual(expect.objectContaining({ ok: false }));

    const missingPayloadHash = clone(valid);
    delete missingPayloadHash.upload_envelope.included_items[0].payload_hash;
    expect(validateMiraCoreServerUploadOutput(missingPayloadHash, uploadContract())).toEqual(expect.objectContaining({ ok: false }));

    const missingWatermarkHash = clone(valid);
    delete missingWatermarkHash.upload_envelope.source_watermarks[0].contentHash;
    expect(validateMiraCoreServerUploadOutput(missingWatermarkHash, uploadContract())).toEqual(expect.objectContaining({ ok: false }));

    const missingAuditRefs = clone(valid);
    delete missingAuditRefs.upload_envelope.redaction_audit.auditRefs;
    expect(validateMiraCoreServerUploadOutput(missingAuditRefs, uploadContract())).toEqual(expect.objectContaining({ ok: false }));

    const capabilityOverclaim = clone(valid);
    capabilityOverclaim.upload_envelope.capability_summary.serverCanExecuteLocal = true;
    expect(validateMiraCoreServerUploadOutput(capabilityOverclaim, uploadContract())).toEqual(expect.objectContaining({ ok: false }));
  });

  test('CLI prints stdout JSON only and ignores output-file flags', () => {
    expect(parseArgs(['--pretty', '--out', 'upload.json'])).toEqual({ pretty: true });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=upload.json'], JSON.stringify(acceptance('eligible-items-included-only').inputSignals));

    expect(output.upload_envelope.schema).toBe(ENVELOPE_SCHEMA_VERSION);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(printed.upload_envelope.schema).toBe(ENVELOPE_SCHEMA_VERSION);
    expect(printed.validation_report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expect(printed.upload_envelope.no_network_performed).toBe(true);
    expect(printed.validation_report.side_effect_result.networkRequestsAttempted).toBe(0);
  });
});
