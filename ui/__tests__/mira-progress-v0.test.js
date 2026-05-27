'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const progressContract = require('./fixtures/mira-progress-contract-v0.json');
const {
  PROGRESS_CONTRACT_SCHEMA,
  PROGRESS_REPORT_SCHEMA,
  buildMiraProgressReport,
  formatMiraProgressPlain,
  validateContract,
} = require('../modules/mira-core/mira-progress-v0');
const {
  INTERNAL_HANDOFF_APPROVAL_PROOF_KEY,
  INTERNAL_HANDOFF_PREVIEW_PROOF_KEY,
  INTERNAL_REQUEST_DRAFT_PROOF_KEY,
  LIVE_WHAT_NOW_PROOF_KEY,
  LOCAL_TEXT_UI_SURFACE_PROOF_KEY,
  VISIBLE_PRESENCE_A0_PROOF_KEY,
  writeProgressProofArtifact,
  writeVisiblePresenceProofArtifact,
} = require('../modules/mira-core/mira-progress-proof-inputs-v0');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-progress');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value = 'present\n') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function seedProject({ stalePresence = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-progress-'));
  writeJson(path.join(root, '.squidrun', 'state', 'mira-presence-runtime-state.json'), {
    schema: 'squidrun.mira_core.presence_runtime_state.v0',
    version: 1,
    generated_at: stalePresence ? '2026-05-01T00:00:00.000Z' : '2026-05-11T00:00:00.000Z',
    surface: 'backstage_internal_only',
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
    canonical_hash: 'sha256:test-state',
  });
  writeJson(path.join(root, 'ui', '__tests__', 'fixtures', 'mira-presence-runtime-acceptance-v0-contract.json'), {
    schema: 'squidrun.mira_presence_runtime_acceptance.v0',
  });
  writeJson(path.join(root, 'ui', '__tests__', 'fixtures', 'mira-north-star-acceptance-contract.json'), {
    schema: 'squidrun.mira.north_star_acceptance_contract.v0',
  });
  writeJson(path.join(root, 'ui', '__tests__', 'fixtures', 'mira-progress-contract-v0.json'), progressContract);
  for (const filePath of [
    'docs/mira-north-star-roadmap.md',
    'docs/mira-system-map.md',
    'mira/runtime/src/squidrun-context.ts',
    'ui/scripts/hm-send.js',
    'mira/runtime/src/bridge-request-plan.ts',
    'ui/modules/mira-telegram-turn-candidate.js',
    'ui/modules/mira-direct-channel-readiness.js',
    'docs/mira-voice-audio-intake-v0.md',
    'ui/modules/voice-broker.js',
    'mira/runtime/src/work-task.ts',
    'mira/runtime/src/mission-control-route-preview.ts',
  ]) {
    writeText(path.join(root, filePath));
  }
  return root;
}

function passingProofInputs() {
  return {
    proofs: {
      'mira-presence-runtime-acceptance.test.js': { status: 'PASS', source_ref: 'npm --prefix ui test -- mira-presence-runtime-acceptance.test.js' },
      'startup-ai-briefing.test.js': { status: 'PASS', source_ref: 'npm --prefix ui test -- startup-ai-briefing.test.js' },
      'hm-restart-verify': { status: 'PASS', source_ref: 'node ui/scripts/hm-restart-verify.js --no-send --json' },
      [LIVE_WHAT_NOW_PROOF_KEY]: { status: 'PASS', source_ref: 'npm --prefix ui test -- --runTestsByPath __tests__/mira-live-what-now-answer-v0.test.js' },
      [INTERNAL_REQUEST_DRAFT_PROOF_KEY]: { status: 'PASS', source_ref: 'npm --prefix ui test -- --runTestsByPath __tests__/mira-live-internal-request-draft-v0.test.js' },
      [INTERNAL_HANDOFF_PREVIEW_PROOF_KEY]: { status: 'PASS', source_ref: 'npm --prefix ui test -- --runTestsByPath __tests__/mira-live-internal-handoff-preview-v0.test.js' },
      [INTERNAL_HANDOFF_APPROVAL_PROOF_KEY]: { status: 'PASS', source_ref: 'npm --prefix ui test -- --runTestsByPath __tests__/mira-live-internal-handoff-approval-v0.test.js' },
      [LOCAL_TEXT_UI_SURFACE_PROOF_KEY]: { status: 'PASS', source_ref: 'npm --prefix ui test -- --runTestsByPath __tests__/mira-local-text-ui-surface.test.js' },
      'mira-runtime-squidrun-context.test.js': { status: 'PASS', source_ref: 'npm --prefix ui test -- mira-runtime-squidrun-context.test.js' },
      'mira-runtime-bridge-api.test.js': { status: 'PASS', source_ref: 'npm --prefix ui test -- mira-runtime-bridge-api.test.js' },
      'mira-north-star-acceptance.test.js': { status: 'PASS', source_ref: 'npm --prefix ui test -- mira-north-star-acceptance.test.js' },
      'mira-telegram-turn-candidate.test.js': { status: 'PASS', source_ref: 'npm --prefix ui test -- mira-telegram-turn-candidate.test.js' },
      'mira-direct-channel-readiness.test.js': { status: 'PASS', source_ref: 'npm --prefix ui test -- mira-direct-channel-readiness.test.js' },
      'mira-voice-lab.test.js': { status: 'PASS', source_ref: 'npm --prefix ui test -- mira-voice-lab.test.js' },
      'mira-runtime-ui-read-only-boot.test.js': { status: 'PASS', source_ref: 'npm --prefix ui test -- mira-runtime-ui-read-only-boot.test.js' },
    },
  };
}

function cleanWorktree() {
  return {
    present: true,
    source_kind: 'provided_worktree_metadata',
    clean: true,
    dirty_count: 0,
    summary: {
      dirty_count: 0,
      staged_count: 0,
      unstaged_count: 0,
      untracked_count: 0,
      by_code: {},
    },
    status_sha256: 'sha256:clean',
  };
}

describe('mira progress v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('contract is machine-readable, weighted to 100, and has no manual percent authority', () => {
    const validation = validateContract(progressContract);

    expect(progressContract.schema).toBe(PROGRESS_CONTRACT_SCHEMA);
    expect(validation).toEqual({ ok: true, errors: [] });
    expect(progressContract.formula.weight_total).toBe(100);
    expect(progressContract.formula.manual_bumps_allowed).toBe(false);
    expect(progressContract.historical_baseline).toEqual(expect.objectContaining({
      label: '35-45% real',
      computed_authority: false,
    }));
    expect(progressContract.categories.map((category) => category.weight).reduce((sum, weight) => sum + weight, 0)).toBe(100);
    expect(progressContract.categories.map((category) => category.id)).toEqual([
      'visible_presence_a0_text',
      'restart_current_scope_continuity',
      'mission_control_command_context',
      'team_coordination_arms',
      'direct_channel_reachability',
      'voice_transport',
      'tool_app_action_planning',
    ]);
  });

  test('computes deterministic progress from contract, state, proofs, blockers, and HEAD metadata', () => {
    const root = seedProject({ stalePresence: true });
    try {
      const report = buildMiraProgressReport({
        projectRoot: root,
        contract: progressContract,
        inputSignals: passingProofInputs(),
        head: {
          short_sha: 'abcdef12',
          committed_at: '2026-05-10T00:00:00.000Z',
          subject: 'Major Mira code commit',
        },
        nowMs: Date.parse('2026-05-12T00:00:00.000Z'),
      });

      expect(report.schema).toBe(PROGRESS_REPORT_SCHEMA);
      expect(report.decision).toBe('computed_from_contract_state_proofs_blockers_head');
      expect(report.computed_total_percent).toBe(76);
      expect(report.status).toBe('BLOCKED');
      expect(report.warnings).toContain('presence_state_predates_head');
      expect(report.historical_baseline).toEqual(expect.objectContaining({
        label: '35-45% real',
        excluded_from_computation: true,
      }));
      expect(report).not.toHaveProperty('global_percent');
      expect(report.anti_drift.manual_bumps_allowed).toBe(false);
      expect(report.categories.find((category) => category.id === 'voice_transport')).toEqual(expect.objectContaining({
        computed_percent: 0,
        status: 'BLOCKED',
      }));
      expect(report.categories.find((category) => category.id === 'team_coordination_arms')).toEqual(expect.objectContaining({
        computed_percent: 40,
        status: 'BLOCKED',
      }));
      expect(report.canonical_hash).toMatch(/^sha256:/);

      const reportAgain = buildMiraProgressReport({
        projectRoot: root,
        contract: progressContract,
        inputSignals: passingProofInputs(),
        head: {
          short_sha: 'abcdef12',
          committed_at: '2026-05-10T00:00:00.000Z',
          subject: 'Major Mira code commit',
        },
        nowMs: Date.parse('2026-05-13T00:00:00.000Z'),
      });
      expect(reportAgain.computed_total_percent).toBe(report.computed_total_percent);
      expect(reportAgain.canonical_hash).toBe(report.canonical_hash);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing proof inputs degrade category evidence to UNKNOWN without crashing', () => {
    const root = seedProject({ stalePresence: false });
    try {
      const report = buildMiraProgressReport({
        projectRoot: root,
        contract: progressContract,
        inputSignals: {},
        head: {
          short_sha: 'abcdef12',
          committed_at: '2026-05-10T00:00:00.000Z',
          subject: 'Major Mira code commit',
        },
      });

      const restart = report.categories.find((category) => category.id === 'restart_current_scope_continuity');
      expect(restart.evidence.find((signal) => signal.id === 'startup_accounting_tests')).toEqual(expect.objectContaining({
        status: 'UNKNOWN',
        points_awarded: 0,
        why: 'No reported proof input supplied.',
      }));
      expect(report.categories.some((category) => category.status === 'UNKNOWN')).toBe(true);
      expect(report.errors || []).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('default visible Presence proof artifact is absent/fresh/stale with HEAD freshness enforced', () => {
    const root = seedProject({ stalePresence: true });
    const currentHead = {
      short_sha: 'abcdef12',
      committed_at: '2026-05-10T00:00:00.000Z',
      subject: 'Major Mira code commit',
    };
    try {
      const noProof = buildMiraProgressReport({
        projectRoot: root,
        contract: progressContract,
        inputSignals: {},
        head: currentHead,
        worktreeState: cleanWorktree(),
      });
      const noProofVisible = noProof.categories.find((category) => category.id === 'visible_presence_a0_text');
      expect(noProof.computed_total_percent).toBe(28);
      expect(noProofVisible).toEqual(expect.objectContaining({
        computed_percent: 65,
        status: 'UNKNOWN',
      }));
      expect(noProofVisible.evidence.find((signal) => signal.id === 'visible_reply_tests')).toEqual(expect.objectContaining({
        status: 'UNKNOWN',
        points_awarded: 0,
      }));

      writeVisiblePresenceProofArtifact({
        projectRoot: root,
        head: currentHead,
        worktreeState: cleanWorktree(),
        runner: () => ({ ok: true, exitCode: 0, stdout: 'PASS', stderr: '' }),
      });
      const freshProof = buildMiraProgressReport({
        projectRoot: root,
        contract: progressContract,
        inputSignals: {},
        head: currentHead,
        worktreeState: cleanWorktree(),
      });
      const freshVisible = freshProof.categories.find((category) => category.id === 'visible_presence_a0_text');
      expect(freshProof.computed_total_percent).toBe(35);
      expect(freshVisible).toEqual(expect.objectContaining({
        computed_percent: 100,
        status: 'PASS',
      }));
      expect(freshVisible.evidence.find((signal) => signal.id === 'visible_reply_tests')).toEqual(expect.objectContaining({
        status: 'PASS',
        points_awarded: 35,
      }));

      const staleProof = buildMiraProgressReport({
        projectRoot: root,
        contract: progressContract,
        inputSignals: {},
        head: {
          short_sha: '99999999',
          committed_at: '2026-05-10T00:00:00.000Z',
          subject: 'Later source commit',
        },
        worktreeState: cleanWorktree(),
      });
      const staleVisible = staleProof.categories.find((category) => category.id === 'visible_presence_a0_text');
      expect(staleProof.computed_total_percent).toBe(28);
      expect(staleVisible).toEqual(expect.objectContaining({
        computed_percent: 65,
        status: 'STALE',
      }));
      expect(staleVisible.evidence.find((signal) => signal.id === 'visible_reply_tests')).toEqual(expect.objectContaining({
        status: 'STALE',
        points_awarded: 0,
      }));
      expect(staleProof.warnings).toContain('proof_head_mismatch');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('default progress proof artifact counts restart plus A1/A2/handoff-preview evidence from clean HEAD', () => {
    const root = seedProject({ stalePresence: true });
    const currentHead = {
      full_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      short_sha: 'abcdef12',
      committed_at: '2026-05-10T00:00:00.000Z',
      subject: 'A2 current Mira checkpoint',
    };
    try {
      writeProgressProofArtifact({
        projectRoot: root,
        head: currentHead,
        worktreeState: cleanWorktree(),
        nowMs: Date.parse('2026-05-26T22:30:00.000Z'),
        runner: (command, projectRoot, metadata) => ({
          ok: true,
          exitCode: 0,
          stdout: `PASS ${metadata.proofKey}`,
          stderr: '',
        }),
      });

      const report = buildMiraProgressReport({
        projectRoot: root,
        contract: progressContract,
        inputSignals: {},
        head: currentHead,
        worktreeState: cleanWorktree(),
      });

      expect(report.computed_total_percent).toBe(68);
      expect(report.warnings).toEqual(['presence_state_predates_head']);
      expect(report.categories.find((category) => category.id === 'restart_current_scope_continuity')).toEqual(expect.objectContaining({
        computed_percent: 75,
        status: 'STALE',
      }));
      expect(report.categories.find((category) => category.id === 'visible_presence_a0_text')).toEqual(expect.objectContaining({
        computed_percent: 100,
        status: 'PASS',
      }));
      expect(report.categories.find((category) => category.id === 'mission_control_command_context')).toEqual(expect.objectContaining({
        computed_percent: 100,
        status: 'PASS',
      }));
      expect(report.categories.find((category) => category.id === 'team_coordination_arms')).toEqual(expect.objectContaining({
        computed_percent: 40,
        status: 'BLOCKED',
      }));
      expect(report.categories.find((category) => category.id === 'tool_app_action_planning')).toEqual(expect.objectContaining({
        computed_percent: 100,
        status: 'PASS',
      }));
      expect(report.categories.find((category) => category.id === 'mission_control_command_context').last_proof_source_refs).toContain('.squidrun/runtime/mira-progress-proof-inputs-v0.json');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fresh Presence state lets the same default proof artifact fully count restart continuity', () => {
    const root = seedProject({ stalePresence: false });
    const currentHead = {
      full_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      short_sha: 'abcdef12',
      committed_at: '2026-05-10T00:00:00.000Z',
      subject: 'Restart continuity current head',
    };
    try {
      writeProgressProofArtifact({
        projectRoot: root,
        head: currentHead,
        worktreeState: cleanWorktree(),
        nowMs: Date.parse('2026-05-26T22:30:00.000Z'),
        runner: (command, projectRoot, metadata) => ({
          ok: true,
          exitCode: 0,
          stdout: `PASS ${metadata.proofKey}`,
          stderr: '',
        }),
      });

      const report = buildMiraProgressReport({
        projectRoot: root,
        contract: progressContract,
        inputSignals: {},
        head: currentHead,
        worktreeState: cleanWorktree(),
      });

      expect(report.warnings).toEqual([]);
      expect(report.computed_total_percent).toBe(73);
      expect(report.categories.find((category) => category.id === 'restart_current_scope_continuity')).toEqual(expect.objectContaining({
        computed_percent: 100,
        status: 'PASS',
      }));
      expect(report.categories.find((category) => category.id === 'team_coordination_arms')).toEqual(expect.objectContaining({
        computed_percent: 40,
        status: 'BLOCKED',
      }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI prints JSON by default and plain status on request', () => {
    const root = seedProject({ stalePresence: true });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(parseArgs(['--project-root', root, '--plain'])).toEqual(expect.objectContaining({
        projectRoot: root,
        plain: true,
        json: false,
      }));

      const report = main([
        '--project-root',
        root,
        '--plain',
      ], JSON.stringify(passingProofInputs()));

      expect(report.schema).toBe(PROGRESS_REPORT_SCHEMA);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy.mock.calls[0][0]).toContain('Mira computed progress:');
      expect(writeSpy.mock.calls[0][0]).toContain('historical baseline 35-45% real excluded from computation');

      writeSpy.mockClear();
      main(['--project-root', root, '--json'], JSON.stringify(passingProofInputs()));
      const printed = JSON.parse(writeSpy.mock.calls[0][0]);
      expect(printed.schema).toBe(PROGRESS_REPORT_SCHEMA);
      expect(printed.historical_baseline.computed_authority).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('plain formatter keeps computed value separate from historical baseline', () => {
    const text = formatMiraProgressPlain({
      computed_total_percent: 12,
      status: 'UNKNOWN',
      historical_baseline: { label: '35-45% real' },
      categories: [
        { label: 'Voice Transport', computed_percent: 0, status: 'BLOCKED' },
      ],
    });

    expect(text).toContain('Mira computed progress: 12% (UNKNOWN)');
    expect(text).toContain('historical baseline 35-45% real excluded from computation');
    expect(text).toContain('Voice Transport: 0% (BLOCKED)');
  });
});
