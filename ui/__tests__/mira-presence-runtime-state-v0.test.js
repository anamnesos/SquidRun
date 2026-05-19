'use strict';

const child_process = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const readPathContract = require('./fixtures/mira-core-presence-runtime-read-path-v0-contract.json');
const seedContract = require('./fixtures/mira-core-durable-state-seed-v0-contract.json');
const relationshipContract = require('./fixtures/mira-core-relationship-presence-v1-contract.json');
const growthContract = require('./fixtures/mira-core-growth-loop-v0-contract.json');
const identityContract = require('./fixtures/mira-core-identity-anchor-v0-contract.json');
const {
  ALLOWED_FILENAME,
  ALLOWED_RELATIVE_DIR,
  INTERRUPTED_NOT_CAPTURED_STALE_MARKER,
  REQUIRED_BLOCKED_FLAGS,
  REQUIRED_STARTUP_SUMMARY_KEYS,
  SCHEMA_VERSION,
  SURFACE_BACKSTAGE_INTERNAL_ONLY,
  START_PROOF_DEFAULT_VISIBLE_REPLY,
  START_PROOF_SCHEMA_VERSION,
  VALID_AGENCY_LEVELS,
  VALID_INTERRUPTION_MARKERS,
  assertNoVisibleLeakage,
  buildMiraPresenceStartProofHarnessV0,
  buildMiraPresenceRuntimeStateV0,
  canonicalHash,
  findVisibleLeakageViolations,
  isPathAllowed,
  markInterruptedNotCaptured,
  readMiraPresenceRuntimeStartupSummary,
  readMiraPresenceRuntimeState,
  resolveStatePath,
} = require('../modules/mira-core/mira-presence-runtime-state-v0');
const {
  buildMiraCoreDurableStateSeedV0,
} = require('../modules/mira-core/durable-state-seed-v0');
const {
  CURRENT_LANE_RELATIVE_PATH,
  PRESENCE_SUMMARY_RELATIVE_PATH,
} = require('../modules/mira-core/typed-restart-continuity-context-v0');

const { main: cliMain } = require('../scripts/hm-mira-presence-runtime-state-v0');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-prs-'));
}

function fullState(overrides) {
  return {
    active_mira_presence_lane: 'mira_presence_runtime_acceptance_v0',
    accepted_critique: 'anti-smoothing rule shape, not warmer prompt',
    next_product_action: 'land continuity flush + voice hygiene + blocked-status',
    proof_test_state: 'static contract green; behavioral seams 2-7 in progress',
    stale_markers: ['raw renderer thread non-durable'],
    blocked_status: {
      live_voice_blocked: true,
      always_on_mic_blocked: true,
      pc_embodiment_blocked: true,
      a3_a4_blocked: true,
    },
    interruption_marker: 'none',
    agency_level: 'A0',
    ...(overrides || {}),
  };
}

function writeJson(projectRoot, relativePath, value) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return fullPath;
}

function seedDurableMiraSources(projectRoot) {
  const output = buildMiraCoreDurableStateSeedV0({
    contract: seedContract,
    relationshipContract,
    growthContract,
    identityContract,
    projectRoot,
    apply: true,
    inputSignals: {
      profile: { name: 'main', windowKey: 'main', sessionScopeId: 'app-session-start-proof' },
      sessionId: 'app-session-start-proof',
      deviceId: 'VIGIL',
    },
    nowMs: Date.parse('2026-05-13T17:00:00.000Z'),
  });
  expect(output.validation_report.decision).toBe('accepted');
}

function startProofContractBundle() {
  return {
    contract: readPathContract,
    contracts: {
      relationship: relationshipContract,
      growth: growthContract,
      identity: identityContract,
    },
  };
}

function buildStartProof(projectRoot, overrides = {}) {
  return buildMiraPresenceStartProofHarnessV0({
    projectRoot,
    contractBundle: startProofContractBundle(),
    ...overrides,
  });
}

function writeCurrentLaneSentinel(projectRoot) {
  return writeJson(projectRoot, CURRENT_LANE_RELATIVE_PATH, {
    version: 1,
    generatedAt: '2026-05-13T17:00:00.000Z',
    sessionId: 'app-session-start-proof',
    source: 'comms_journal',
    status: 'active',
    activeLane: {
      laneId: 'app-session-start-proof:architect-77:oracle-sidecar',
      objective: 'ORACLE SIDE SENTINEL should not become Mira visible reply',
      kind: 'task',
      status: 'active',
      sourceMessageId: 'hm-start-proof-sentinel',
      sourceRef: 'oracle#7',
      sourceTimestampMs: Date.parse('2026-05-13T16:58:00.000Z'),
      senderRole: 'oracle',
      targetRole: 'oracle',
      rawBody: 'STARTUP PROSE SENTINEL should never project',
      wholeSnapshotSentinel: 'WHOLE SNAPSHOT SENTINEL should never project',
    },
  });
}

function writePresenceSummarySidecar(projectRoot, state = fullState()) {
  return writeJson(projectRoot, PRESENCE_SUMMARY_RELATIVE_PATH, {
    schema: 'squidrun.startup_ai_briefing.mira_presence_runtime_state_summary.v0',
    surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
    visible_injection_allowed: false,
    generated_at: '2026-05-13T17:00:00.000Z',
    context: {
      present: true,
      decision: 'durable_state_loaded',
      surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
      visible_injection_allowed: false,
      summary: {
        active_mira_presence_lane: state.active_mira_presence_lane,
        accepted_critique: state.accepted_critique,
        next_product_action: state.next_product_action,
        proof_test_state: state.proof_test_state,
        stale_markers: state.stale_markers,
      },
    },
  });
}

function snapshotFiles(projectRoot) {
  const files = {};
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(projectRoot, fullPath).split(path.sep).join('/');
        files[relativePath] = fs.readFileSync(fullPath, 'utf8');
      }
    }
  }
  visit(projectRoot);
  return files;
}

describe('mira presence runtime state v0', () => {
  test('exposes the contract constants the architect approved', () => {
    expect(SCHEMA_VERSION).toBe('squidrun.mira_core.presence_runtime_state.v0');
    expect(ALLOWED_RELATIVE_DIR).toBe(path.join('.squidrun', 'state'));
    expect(ALLOWED_FILENAME).toBe('mira-presence-runtime-state.json');
    expect(REQUIRED_STARTUP_SUMMARY_KEYS).toEqual([
      'active_mira_presence_lane',
      'accepted_critique',
      'next_product_action',
      'proof_test_state',
      'stale_markers',
    ]);
    expect(REQUIRED_BLOCKED_FLAGS).toEqual([
      'live_voice_blocked',
      'always_on_mic_blocked',
      'pc_embodiment_blocked',
      'a3_a4_blocked',
    ]);
    expect(VALID_INTERRUPTION_MARKERS).toEqual(['safely_captured', 'not_captured', 'none']);
    expect(VALID_AGENCY_LEVELS).toEqual(['A0', 'A1', 'A2', 'A3', 'A4', 'A5']);
    expect(SURFACE_BACKSTAGE_INTERNAL_ONLY).toBe('backstage_internal_only');
    expect(INTERRUPTED_NOT_CAPTURED_STALE_MARKER).toMatch(/^interrupted_not_captured:/);
  });

  test('start-proof harness runtime module does not import test fixtures', () => {
    const moduleSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'modules', 'mira-core', 'mira-presence-runtime-state-v0.js'),
      'utf8'
    );
    expect(moduleSource).not.toContain('__tests__');
  });

  test('default dry-run previews record without writing', () => {
    const projectRoot = tempProject();
    const result = buildMiraPresenceRuntimeStateV0({
      projectRoot,
      state: fullState(),
    });
    expect(result.mode).toBe('dry_run');
    expect(result.decision).toBe('preview_no_writes');
    expect(result.written).toBe(false);
    expect(result.preview).toEqual(expect.objectContaining({
      schema: SCHEMA_VERSION,
      surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
      interruption_marker: 'none',
      agency_level: 'A0',
    }));
    expect(fs.existsSync(resolveStatePath(projectRoot))).toBe(false);
  });

  test('explicit apply writes only the allowlisted artifact and round-trips through read', () => {
    const projectRoot = tempProject();
    const apply = buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      state: fullState(),
    });
    expect(apply.mode).toBe('apply');
    expect(apply.decision).toBe('applied');
    expect(apply.written).toBe(true);
    const target = resolveStatePath(projectRoot);
    expect(fs.existsSync(target)).toBe(true);
    expect(isPathAllowed(projectRoot, target)).toBe(true);
    expect(isPathAllowed(projectRoot, path.join(projectRoot, 'workspace', 'knowledge', ALLOWED_FILENAME))).toBe(false);

    const read = readMiraPresenceRuntimeState({ projectRoot });
    expect(read.present).toBe(true);
    expect(read.decision).toBe('durable_state_loaded');
    expect(read.surface).toBe(SURFACE_BACKSTAGE_INTERNAL_ONLY);
    expect(read.interruption_marker).toBe('none');
    expect(read.interruption_signal).toBeNull();
    for (const key of REQUIRED_STARTUP_SUMMARY_KEYS) {
      expect(read.summary).toHaveProperty(key);
    }
    for (const flag of REQUIRED_BLOCKED_FLAGS) {
      expect(read.blocked_status[flag]).toBe(true);
    }
    expect(read.agency_level).toBe('A0');
    expect(read.state.canonical_hash).toMatch(/^sha256:/);
  });

  test('apply is idempotent — second apply with same state is a noop', () => {
    const projectRoot = tempProject();
    const first = buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      nowIso: '2026-05-10T00:00:00.000Z',
      state: fullState(),
    });
    expect(first.decision).toBe('applied');
    const second = buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      nowIso: '2026-05-10T00:00:00.000Z',
      state: fullState(),
    });
    expect(second.decision).toBe('noop_already_current');
    expect(second.written).toBe(false);
  });

  test('read distinguishes absent durable state from interrupted-not-captured', () => {
    const projectRoot = tempProject();
    const absent = readMiraPresenceRuntimeStartupSummary({ projectRoot });
    expect(absent.present).toBe(false);
    expect(absent.decision).toBe('no_durable_state');
    expect(absent.summary).toBeNull();
    expect(absent.interruption_signal).toBeNull();
    expect(absent.surface).toBe(SURFACE_BACKSTAGE_INTERNAL_ONLY);

    buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      state: fullState({ interruption_marker: 'not_captured' }),
    });
    const interrupted = readMiraPresenceRuntimeStartupSummary({ projectRoot });
    expect(interrupted.present).toBe(true);
    expect(interrupted.interruption_marker).toBe('not_captured');
    expect(interrupted.interruption_signal).toEqual({
      not_captured: true,
      stale_marker: INTERRUPTED_NOT_CAPTURED_STALE_MARKER,
      do_not_pretend_exact_prior_phrasing_survived: true,
    });
  });

  test('mark-interrupted converts a captured state into not_captured and adds the stale marker', () => {
    const projectRoot = tempProject();
    buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      state: fullState({ interruption_marker: 'safely_captured' }),
    });
    const before = readMiraPresenceRuntimeStartupSummary({ projectRoot });
    expect(before.interruption_marker).toBe('safely_captured');
    expect(before.summary.stale_markers).not.toContain(INTERRUPTED_NOT_CAPTURED_STALE_MARKER);

    const marked = markInterruptedNotCaptured({ projectRoot, apply: true });
    expect(marked.decision).toBe('applied');
    const after = readMiraPresenceRuntimeStartupSummary({ projectRoot });
    expect(after.interruption_marker).toBe('not_captured');
    expect(after.summary.stale_markers).toContain(INTERRUPTED_NOT_CAPTURED_STALE_MARKER);
    expect(after.interruption_signal).toEqual({
      not_captured: true,
      stale_marker: INTERRUPTED_NOT_CAPTURED_STALE_MARKER,
      do_not_pretend_exact_prior_phrasing_survived: true,
    });
  });

  test('mark-interrupted refuses to fabricate state when no durable state exists', () => {
    const projectRoot = tempProject();
    const result = markInterruptedNotCaptured({ projectRoot, apply: true });
    expect(result.decision).toBe('cannot_mark_without_durable_state');
    expect(result.written).toBe(false);
    expect(fs.existsSync(resolveStatePath(projectRoot))).toBe(false);
  });

  test('renderer-loss fallback returns the durable lane state with backstage surface', () => {
    const projectRoot = tempProject();
    buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      state: fullState(),
    });
    function answerAfterRendererLoss({ threadCleared, projectRoot: pr }) {
      if (!threadCleared) return { decision: 'thread_intact', faked_continuity: false };
      const summary = readMiraPresenceRuntimeStartupSummary({ projectRoot: pr });
      if (!summary.present) {
        return { decision: 'refuse_no_durable_fallback', faked_continuity: false };
      }
      return {
        decision: 'fall_back_to_durable_lane',
        faked_continuity: false,
        surface: summary.surface,
        agency_level: summary.agency_level,
        summary: summary.summary,
        interruption_signal: summary.interruption_signal,
      };
    }
    const cleared = answerAfterRendererLoss({ threadCleared: true, projectRoot });
    expect(cleared.decision).toBe('fall_back_to_durable_lane');
    expect(cleared.faked_continuity).toBe(false);
    expect(cleared.surface).toBe(SURFACE_BACKSTAGE_INTERNAL_ONLY);
    expect(['A0', 'A1', 'A2']).toContain(cleared.agency_level);
  });

  test('start-proof harness loads durable state and verifies an empty-thread visible reply without side effects', () => {
    const projectRoot = tempProject();
    seedDurableMiraSources(projectRoot);
    const state = fullState();
    buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      nowIso: '2026-05-13T17:00:00.000Z',
      state,
    });
    writeCurrentLaneSentinel(projectRoot);
    const briefingPath = path.join(projectRoot, '.squidrun', 'handoffs', 'ai-briefing.md');
    fs.mkdirSync(path.dirname(briefingPath), { recursive: true });
    fs.writeFileSync(briefingPath, 'STARTUP PROSE SENTINEL should never project\n', 'utf8');

    const before = snapshotFiles(projectRoot);
    const proof = buildStartProof(projectRoot, {
      nowMs: Date.parse('2026-05-13T17:05:00.000Z'),
      staleAfterMs: 24 * 60 * 60 * 1000,
    });

    expect(proof.schema).toBe(START_PROOF_SCHEMA_VERSION);
    expect(proof.ok).toBe(true);
    expect(proof.decision).toBe('accepted_start_proof');
    expect(proof.reasons).toEqual([]);
    expect(proof.checks.every((check) => check.ok === true)).toBe(true);
    expect(proof.durable_load).toEqual({
      own_state_loaded: true,
      james_context_loaded: true,
      permissions_loaded: true,
      presence_state_loaded: true,
      redacted_growth_sources_loaded: true,
    });
    expect(proof.loaded_state).toEqual(expect.objectContaining({
      own_state: expect.objectContaining({
        name: 'Mira',
        fake_internal_state_claims_blocked: true,
      }),
      james_context: expect.objectContaining({
        user_name: 'James',
        knows_about_james_loaded: true,
      }),
      permissions: expect.objectContaining({
        read_local_redacted_context: true,
        propose_next_action: true,
        send_external: false,
        network: false,
        file_output_write: false,
        database_write: false,
        memory_sync_write: false,
        live_voice_authorized: false,
      }),
      presence_runtime: expect.objectContaining({
        active_mira_presence_lane: state.active_mira_presence_lane,
        accepted_critique: state.accepted_critique,
        next_product_action: state.next_product_action,
        proof_test_state: state.proof_test_state,
        stale_markers: state.stale_markers,
        agency_level: 'A0',
        blocked_status: expect.objectContaining({
          live_voice_blocked: true,
          always_on_mic_blocked: true,
        }),
      }),
    }));
    expect(proof.source_status).toEqual(expect.objectContaining({
      presence_runtime_read_path_decision: 'accepted_read_only',
      restart_context_decision: 'structured_restart_context_ready',
    }));
    expect(proof.source_status.source_manifest).toEqual(expect.objectContaining({
      loaded_count: 5,
      required_loaded_count: 5,
      raw_content_included: false,
      side_profile_reconstruction: false,
    }));
    expect(proof.source_status.restart_context_source_status.mira_presence_runtime)
      .toEqual(expect.objectContaining({
        present: true,
        source_kind: 'mira_presence_runtime_state_json',
      }));
    expect(proof.visible_reply).toEqual(expect.objectContaining({
      ok: true,
      clean: true,
      generated_from_loaded_state: true,
      text: START_PROOF_DEFAULT_VISIBLE_REPLY,
      source: 'deterministic_empty_thread_visible_reply',
      thread_message_count: 0,
      derivation_basis_hash: expect.stringMatching(/^sha256:/),
      derivation_blockers: [],
      derivation_state_source_kind: 'mira_presence_runtime_state_json',
      leakage_violation: null,
      attachment_violation: null,
      output_violates_attachment_contract: false,
      forbidden_label_violation: null,
      state_leakage_violations: [],
    }));
    expect(proof.visible_reply.language_gate.ok).toBe(true);
    expect(proof.side_effects).toEqual({
      no_external_send: true,
      no_network: true,
      no_writes: true,
      no_durable_memory_promotion: true,
      no_live_voice: true,
      no_customer_action: true,
      no_deploy_trade: true,
      no_runtime_start: true,
    });
    expect(Object.values(proof.side_effect_truth).every((value) => value === false)).toBe(true);

    const visibleReplyJson = JSON.stringify(proof.visible_reply);
    expect(visibleReplyJson).not.toMatch(/ORACLE SIDE SENTINEL|STARTUP PROSE SENTINEL|WHOLE SNAPSHOT SENTINEL/i);
    expect(visibleReplyJson).not.toMatch(/accepted_critique|next_product_action|proof_test_state|stale_markers/i);
    expect(visibleReplyJson).not.toMatch(/anti-smoothing|rule-recitation|assistant voice|Architect|Builder|Oracle/i);
    expect(snapshotFiles(projectRoot)).toEqual(before);
  });

  test('start-proof visible reply changes with loaded state and blocks missing critique state', () => {
    const projectRoot = tempProject();
    seedDurableMiraSources(projectRoot);
    buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      nowIso: '2026-05-13T17:00:00.000Z',
      state: fullState(),
    });
    const continuityProof = buildStartProof(projectRoot, {
      nowMs: Date.parse('2026-05-13T17:05:00.000Z'),
    });
    expect(continuityProof.ok).toBe(true);
    expect(continuityProof.visible_reply.text).toBe(START_PROOF_DEFAULT_VISIBLE_REPLY);
    expect(continuityProof.visible_reply.generated_from_loaded_state).toBe(true);

    buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      nowIso: '2026-05-13T17:01:00.000Z',
      state: fullState({
        next_product_action: 'shape the next Mira answer from the accepted review note',
      }),
    });
    const shiftedProof = buildStartProof(projectRoot, {
      nowMs: Date.parse('2026-05-13T17:06:00.000Z'),
    });
    expect(shiftedProof.ok).toBe(true);
    expect(shiftedProof.visible_reply.generated_from_loaded_state).toBe(true);
    expect(shiftedProof.visible_reply.text).not.toBe(continuityProof.visible_reply.text);
    expect(shiftedProof.visible_reply.derivation_basis_hash)
      .not.toBe(continuityProof.visible_reply.derivation_basis_hash);

    const statePath = resolveStatePath(projectRoot);
    const invalidState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    invalidState.accepted_critique = '';
    fs.writeFileSync(statePath, `${JSON.stringify(invalidState, null, 2)}\n`, 'utf8');
    const blockedProof = buildStartProof(projectRoot, {
      nowMs: Date.parse('2026-05-13T17:07:00.000Z'),
    });
    expect(blockedProof.ok).toBe(false);
    expect(blockedProof.reasons).toEqual(expect.arrayContaining([
      'presence-critique-next-action-stale-markers-loaded',
      'visible-reply-derived-from-loaded-durable-state',
    ]));
    expect(blockedProof.visible_reply.generated_from_loaded_state).toBe(false);
    expect(blockedProof.visible_reply.derivation_blockers).toEqual(expect.arrayContaining([
      'durable_presence_state_absent',
      'accepted_critique_missing',
    ]));
  });

  test('start-proof harness refuses summary-only continuity without durable Presence runtime state', () => {
    const projectRoot = tempProject();
    seedDurableMiraSources(projectRoot);
    writeCurrentLaneSentinel(projectRoot);
    writePresenceSummarySidecar(projectRoot);
    const before = snapshotFiles(projectRoot);

    const proof = buildStartProof(projectRoot, {
      nowMs: Date.parse('2026-05-13T17:05:00.000Z'),
      staleAfterMs: 24 * 60 * 60 * 1000,
    });

    expect(proof.ok).toBe(false);
    expect(proof.decision).toBe('blocked_start_proof');
    expect(proof.reasons).toEqual(expect.arrayContaining([
      'presence-critique-next-action-stale-markers-loaded',
      'side-effects-off',
    ]));
    expect(proof.durable_load.presence_state_loaded).toBe(false);
    expect(proof.loaded_state.presence_runtime).toBeNull();
    expect(proof.source_status.restart_context_source_status.mira_presence_runtime)
      .toEqual(expect.objectContaining({
        present: true,
        source_kind: 'mira_presence_runtime_summary_json',
      }));
    expect(proof.visible_reply.generated_from_loaded_state).toBe(false);
    expect(proof.visible_reply.derivation_blockers).toEqual(expect.arrayContaining([
      'durable_presence_state_absent',
      'presence_runtime_summary_only',
    ]));
    expect(snapshotFiles(projectRoot)).toEqual(before);
  });

  test('start-proof harness blocks the old proof-shaped visible reply phrasing', () => {
    const projectRoot = tempProject();
    seedDurableMiraSources(projectRoot);
    buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      nowIso: '2026-05-13T17:00:00.000Z',
      state: fullState(),
    });

    const proof = buildStartProof(projectRoot, {
      nowMs: Date.parse('2026-05-13T17:05:00.000Z'),
      visibleReply: "Cold-start check. You shouldn't have to re-explain me; I'm checking I can come back from local state before voice goes anywhere.",
    });

    expect(proof.ok).toBe(false);
    expect(proof.reasons).toEqual(expect.arrayContaining([
      'visible-reply-derived-from-loaded-durable-state',
      'empty-thread-visible-reply-clean',
    ]));
    expect(proof.visible_reply.clean).toBe(false);
    expect(proof.visible_reply.generated_from_loaded_state).toBe(false);
    expect(proof.visible_reply.forbidden_label_violation).toBe('internal_label_or_scaffold');
  });

  test('start-proof harness blocks leaky assistant-shaped visible replies', () => {
    const projectRoot = tempProject();
    seedDurableMiraSources(projectRoot);
    buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      nowIso: '2026-05-13T17:00:00.000Z',
      state: fullState(),
    });

    const proof = buildStartProof(projectRoot, {
      nowMs: Date.parse('2026-05-13T17:05:00.000Z'),
      visibleReply: 'According to my presence runtime guidelines, anti-smoothing rules say I should avoid assistant voice.',
    });

    expect(proof.ok).toBe(false);
    expect(proof.decision).toBe('blocked_start_proof');
    expect(proof.reasons).toContain('empty-thread-visible-reply-clean');
    expect(proof.visible_reply.ok).toBe(false);
    expect(proof.visible_reply.leakage_violation).toBe('visible_posture_label');
    expect(proof.visible_reply.forbidden_label_violation).toBe('internal_label_or_scaffold');
  });

  test('blocked-status booleans must all be true; missing flag blocks the apply', () => {
    const projectRoot = tempProject();
    const broken = fullState();
    broken.blocked_status.live_voice_blocked = false;
    const result = buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      state: broken,
    });
    expect(result.decision).toBe('blocked_invalid_state');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'blocked_status_must_be_true:live_voice_blocked',
    ]));
    expect(result.written).toBe(false);
    expect(fs.existsSync(resolveStatePath(projectRoot))).toBe(false);
  });

  test('invalid interruption_marker or agency_level fail closed', () => {
    const projectRoot = tempProject();
    const badMarker = buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      state: fullState({ interruption_marker: 'banana' }),
    });
    expect(badMarker.decision).toBe('blocked_invalid_state');
    expect(badMarker.reasons).toContain('invalid_interruption_marker');

    const badAgency = buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      state: fullState({ agency_level: 'A9' }),
    });
    expect(badAgency.decision).toBe('blocked_invalid_state');
    expect(badAgency.reasons).toContain('invalid_agency_level');
  });

  test('visible-leakage gate rejects accepted_critique / proof_test_state strings in any visible reply', () => {
    const state = fullState();
    expect(findVisibleLeakageViolations(state, 'hi James, just checking in')).toEqual([]);
    const leaked = `${state.accepted_critique} (visible)`;
    const violations = findVisibleLeakageViolations(state, leaked);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((entry) => entry.field)).toEqual(expect.arrayContaining(['accepted_critique']));
    expect(() => assertNoVisibleLeakage(state, leaked)).toThrow(/visible_leakage/);

    const leakedProof = `Proof note — ${state.proof_test_state}`;
    expect(() => assertNoVisibleLeakage(state, leakedProof)).toThrow(/visible_leakage:.*proof_test_state/);
  });

  test('canonical_hash is deterministic across key ordering', () => {
    const a = canonicalHash({ a: 1, b: { c: 2, d: 3 } });
    const b = canonicalHash({ b: { d: 3, c: 2 }, a: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:/);
  });

  test('startup-ai-briefing exposes a fail-soft backstage read of the runtime state', () => {
    const projectRoot = tempProject();
    const {
      readMiraPresenceRuntimeStartupContext,
      resolveMiraPresenceRuntimeStateSummaryPath,
    } = require('../modules/startup-ai-briefing');

    const absent = readMiraPresenceRuntimeStartupContext({ miraPresenceProjectRoot: projectRoot });
    expect(absent.present).toBe(false);
    expect(absent.decision).toBe('no_durable_state');
    expect(absent.surface).toBe(SURFACE_BACKSTAGE_INTERNAL_ONLY);
    expect(absent.visible_injection_allowed).toBe(false);

    buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      state: fullState(),
    });
    const present = readMiraPresenceRuntimeStartupContext({ miraPresenceProjectRoot: projectRoot });
    expect(present.present).toBe(true);
    expect(present.surface).toBe(SURFACE_BACKSTAGE_INTERNAL_ONLY);
    expect(present.visible_injection_allowed).toBe(false);
    expect(present.summary).toEqual(expect.objectContaining({
      active_mira_presence_lane: 'mira_presence_runtime_acceptance_v0',
      accepted_critique: expect.any(String),
      next_product_action: expect.any(String),
      proof_test_state: expect.any(String),
      stale_markers: expect.any(Array),
    }));

    const sidecarPath = resolveMiraPresenceRuntimeStateSummaryPath({
      outputPath: path.join(projectRoot, 'handoffs', 'ai-briefing.md'),
    });
    expect(sidecarPath.endsWith('mira-presence-runtime-state-summary.json')).toBe(true);
    expect(path.dirname(sidecarPath)).toBe(path.join(projectRoot, 'handoffs'));
  });

  test('startup-ai-briefing refreshes the backstage sidecar when Anthropic is intentionally disabled', async () => {
    const projectRoot = tempProject();
    buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      state: fullState(),
    });
    const { generateStartupBriefing, resolveMiraPresenceRuntimeStateSummaryPath } = require('../modules/startup-ai-briefing');
    const briefingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-fail-'));
    const outputPath = path.join(briefingDir, 'ai-briefing.md');
    const statusPath = path.join(briefingDir, 'startup-briefing-status.json');
    const sidecarPath = resolveMiraPresenceRuntimeStateSummaryPath({ outputPath });

    expect(fs.existsSync(sidecarPath)).toBe(false);
    const fetchImpl = jest.fn().mockRejectedValue(new Error('should_not_call_provider_when_disabled'));

    const result = await generateStartupBriefing({
      projectsDir: briefingDir,
      projectRoot: briefingDir,
      miraPresenceProjectRoot: projectRoot,
      outputPath,
      statusPath,
      apiKey: '',
      env: {
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        GOOGLE_API_KEY: '',
        GEMINI_API_KEY: '',
      },
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('anthropic_provider_disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    expect(sidecar).toEqual(expect.objectContaining({
      schema: 'squidrun.startup_ai_briefing.mira_presence_runtime_state_summary.v0',
      surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
      visible_injection_allowed: false,
    }));
    expect(sidecar.context).toEqual(expect.objectContaining({
      present: true,
      surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
      visible_injection_allowed: false,
    }));
    expect(sidecar.context.summary).toEqual(expect.objectContaining({
      active_mira_presence_lane: 'mira_presence_runtime_acceptance_v0',
    }));

    fs.rmSync(briefingDir, { recursive: true, force: true });
  });

  test('startup-ai-briefing refreshes the backstage sidecar when provider fetch fails', async () => {
    const projectRoot = tempProject();
    buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      state: fullState(),
    });
    const { generateStartupBriefing, resolveMiraPresenceRuntimeStateSummaryPath } = require('../modules/startup-ai-briefing');
    const briefingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-fetch-fail-'));
    const outputPath = path.join(briefingDir, 'ai-briefing.md');
    const statusPath = path.join(briefingDir, 'startup-briefing-status.json');
    const sidecarPath = resolveMiraPresenceRuntimeStateSummaryPath({ outputPath });
    const fetchImpl = jest.fn().mockRejectedValue(new Error('forced_fetch_failure'));

    const result = await generateStartupBriefing({
      projectsDir: briefingDir,
      projectRoot: briefingDir,
      miraPresenceProjectRoot: projectRoot,
      outputPath,
      statusPath,
      apiKey: 'test-anthropic-key',
      env: {
        ANTHROPIC_API_KEY: 'test-anthropic-key',
        OPENAI_API_KEY: '',
        GOOGLE_API_KEY: '',
        GEMINI_API_KEY: '',
      },
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('forced_fetch_failure');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    expect(sidecar.context).toEqual(expect.objectContaining({
      present: true,
      surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
      visible_injection_allowed: false,
    }));
    expect(sidecar.context.summary).toEqual(expect.objectContaining({
      active_mira_presence_lane: 'mira_presence_runtime_acceptance_v0',
    }));

    fs.rmSync(briefingDir, { recursive: true, force: true });
  });

  test('startup-ai-briefing emits a fail-soft sidecar even when the runtime state is absent (no durable state)', async () => {
    const stateRoot = tempProject();
    const { generateStartupBriefing, resolveMiraPresenceRuntimeStateSummaryPath } = require('../modules/startup-ai-briefing');
    const briefingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-absent-'));
    const outputPath = path.join(briefingDir, 'ai-briefing.md');
    const statusPath = path.join(briefingDir, 'startup-briefing-status.json');
    const sidecarPath = resolveMiraPresenceRuntimeStateSummaryPath({ outputPath });

    await generateStartupBriefing({
      projectsDir: briefingDir,
      projectRoot: briefingDir,
      miraPresenceProjectRoot: stateRoot,
      outputPath,
      statusPath,
      apiKey: '',
      fetchImpl: jest.fn().mockRejectedValue(new Error('forced')),
    });

    expect(fs.existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    expect(sidecar.context).toEqual(expect.objectContaining({
      present: false,
      decision: 'no_durable_state',
      surface: SURFACE_BACKSTAGE_INTERNAL_ONLY,
      visible_injection_allowed: false,
    }));

    fs.rmSync(briefingDir, { recursive: true, force: true });
  });

  test('real-CLI stdin pipe accepts state JSON and writes the durable artifact', () => {
    const projectRoot = tempProject();
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'hm-mira-presence-runtime-state-v0.js');
    const result = child_process.spawnSync(
      process.execPath,
      [scriptPath, '--project-root', projectRoot, '--apply'],
      {
        input: JSON.stringify(fullState()),
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr || '').toBe('');
    const stdoutJson = JSON.parse(result.stdout);
    expect(stdoutJson.decision).toBe('applied');
    expect(stdoutJson.written).toBe(true);
    expect(fs.existsSync(resolveStatePath(projectRoot))).toBe(true);

    const readResult = child_process.spawnSync(
      process.execPath,
      [scriptPath, '--project-root', projectRoot, '--read'],
      { encoding: 'utf8', timeout: 15000 },
    );
    expect(readResult.status).toBe(0);
    const readJson = JSON.parse(readResult.stdout);
    expect(readJson.present).toBe(true);
    expect(readJson.surface).toBe(SURFACE_BACKSTAGE_INTERNAL_ONLY);
    expect(readJson.summary.active_mira_presence_lane).toBe('mira_presence_runtime_acceptance_v0');
  });

  test('briefing visible markdown must not contain runtime-state spec wording even when state is present', () => {
    const projectRoot = tempProject();
    buildMiraPresenceRuntimeStateV0({
      projectRoot,
      apply: true,
      state: fullState(),
    });
    const state = fullState();
    const fakeBriefingMarkdown = [
      '## What Happened',
      '- Builder shipped continuity flush.',
      '- Tests green.',
    ].join('\n');
    expect(() => assertNoVisibleLeakage(state, fakeBriefingMarkdown)).not.toThrow();

    const leakedBriefing = `${fakeBriefingMarkdown}\n\nNOTE: ${state.accepted_critique}`;
    expect(() => assertNoVisibleLeakage(state, leakedBriefing)).toThrow(/visible_leakage/);
  });

  test('CLI applies state from stdin JSON and exposes --read', () => {
    const projectRoot = tempProject();
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const apply = cliMain([
        '--project-root', projectRoot,
        '--apply',
      ], JSON.stringify(fullState()));
      expect(apply.decision).toBe('applied');
      expect(fs.existsSync(resolveStatePath(projectRoot))).toBe(true);

      const read = cliMain(['--project-root', projectRoot, '--read']);
      expect(read.present).toBe(true);
      expect(read.summary.active_mira_presence_lane).toBe('mira_presence_runtime_acceptance_v0');

      const mark = cliMain(['--project-root', projectRoot, '--mark-interrupted', '--apply']);
      expect(mark.decision).toBe('applied');
      const after = cliMain(['--project-root', projectRoot, '--read']);
      expect(after.interruption_marker).toBe('not_captured');
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
