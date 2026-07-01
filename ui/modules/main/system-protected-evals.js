'use strict';

const fs = require('fs');
const path = require('path');

const SYSTEM_PROTECTED_EVAL_SCHEMA_VERSION = 'squidrun.system_protected_evals.v0';
const CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY = 'phase4a.accepted_unverified_never_visible_delivery';
const CASE_ID_FULL_MATERIALIZED_MESSAGE_REQUIRES_READ = 'phase4b.full_materialized_message_requires_full_read';

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

const PROTECTED_SYSTEM_EVALS = Object.freeze([
  ACCEPTED_UNVERIFIED_CASE,
  FULL_MATERIALIZED_MESSAGE_CASE,
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
    validateRequiredRefs,
  },
};
