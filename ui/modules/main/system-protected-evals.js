'use strict';

const fs = require('fs');
const path = require('path');

const SYSTEM_PROTECTED_EVAL_SCHEMA_VERSION = 'squidrun.system_protected_evals.v0';
const CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY = 'phase4a.accepted_unverified_never_visible_delivery';

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '../../..');

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

const PROTECTED_SYSTEM_EVALS = Object.freeze([
  ACCEPTED_UNVERIFIED_CASE,
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
  const braceStart = sourceText.indexOf('{', start);
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
    const testNameOk = text.includes(`test('${ref.testName}'`) || text.includes(`test("${ref.testName}"`);
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
  PROTECTED_SYSTEM_EVALS,
  SYSTEM_PROTECTED_EVAL_SCHEMA_VERSION,
  buildSystemProtectedEvalRunPlan,
  runSystemProtectedEvals,
  validateProtectedSystemEvalCase,
  _internals: {
    DEFAULT_REPO_ROOT,
    extractFunctionBlock,
    readProjectFile,
    validateAcceptedUnverifiedSemantics,
    validateRequiredRefs,
  },
};
