const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CURRENT_LANE_RELATIVE_PATH,
  PRESENCE_SUMMARY_RELATIVE_PATH,
  SOURCE_KINDS,
  buildTypedRestartContinuityContextV0,
  evaluateScope,
} = require('../modules/mira-core/typed-restart-continuity-context-v0');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-typed-continuity-'));
}

function writeJson(projectRoot, relativePath, payload) {
  const filePath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function mainMetadata(overrides = {}) {
  return {
    profileName: 'main',
    windowKey: 'main',
    sourceScope: 'main',
    deviceId: 'VIGIL',
    sessionId: 'app-session-372',
    activeState: 'open',
    visibleIndicatorPresent: true,
    ...overrides,
  };
}

function writeCurrentLane(projectRoot, overrides = {}) {
  return writeJson(projectRoot, CURRENT_LANE_RELATIVE_PATH, {
    version: 1,
    generatedAt: '2026-05-13T17:00:00.000Z',
    sessionId: 'app-session-372',
    source: 'comms_journal',
    status: 'active',
    activeLane: {
      laneId: 'app-session-372:architect-48:m-main',
      objective: 'MAIN CURRENT LANE SENTINEL: typed restart continuity',
      kind: 'current_lane',
      status: 'active',
      sourceMessageId: 'm-main',
      sourceRef: 'architect#48',
      sourceTimestampMs: Date.parse('2026-05-13T16:59:00.000Z'),
      senderRole: 'architect',
      targetRole: 'builder',
      rawBody: 'STARTUP PROSE SENTINEL should never project',
      wholeSnapshotSentinel: 'WHOLE SNAPSHOT SENTINEL should never project',
    },
    ...overrides,
  });
}

function writePresenceSummary(projectRoot, summaryOverrides = {}, rootOverrides = {}) {
  return writeJson(projectRoot, PRESENCE_SUMMARY_RELATIVE_PATH, {
    schema: 'squidrun.startup_ai_briefing.mira_presence_runtime_state_summary.v0',
    surface: 'backstage_internal_only',
    visible_injection_allowed: false,
    generated_at: '2026-05-13T17:00:00.000Z',
    ...rootOverrides,
    context: {
      present: true,
      decision: 'durable_state_loaded',
      surface: 'backstage_internal_only',
      visible_injection_allowed: false,
      summary: {
        active_mira_presence_lane: 'MAIN PRESENCE LANE SENTINEL',
        accepted_critique: 'structured critique sentinel',
        next_product_action: 'MAIN PRESENCE ACTION SENTINEL',
        proof_test_state: 'focused typed continuity tests pending',
        stale_markers: ['renderer thread non-durable'],
        startup_prose_sentinel: 'STARTUP PROSE SENTINEL should never project',
        ...summaryOverrides,
      },
    },
  });
}

describe('typed restart continuity context v0', () => {
  test('projects only whitelisted structured fields and never startup prose or whole snapshots', () => {
    const projectRoot = tempProject();
    try {
      writeCurrentLane(projectRoot);
      writePresenceSummary(projectRoot);
      writeJson(projectRoot, path.join('.squidrun', 'handoffs', 'ai-briefing.md'), {
        forbidden: 'STARTUP PROSE SENTINEL from ai briefing',
      });

      const context = buildTypedRestartContinuityContextV0({
        projectRoot,
        metadata: mainMetadata(),
        nowMs: Date.parse('2026-05-13T17:05:00.000Z'),
      });

      expect(context.present).toBe(true);
      expect(context.decision).toBe('structured_restart_context_ready');
      expect(context.source_status.current_lane.source_kind).toBe(SOURCE_KINDS.currentLane);
      expect(context.source_status.mira_presence_runtime.source_kind).toBe(SOURCE_KINDS.presenceSummary);
      expect(context.current_lane.objective).toContain('MAIN CURRENT LANE SENTINEL');
      expect(context.mira_presence_runtime.next_product_action).toContain('MAIN PRESENCE ACTION SENTINEL');

      const rendered = JSON.stringify(context);
      expect(rendered).not.toContain('STARTUP PROSE SENTINEL');
      expect(rendered).not.toContain('WHOLE SNAPSHOT SENTINEL');
      expect(rendered).not.toContain('rawBody');
      expect(rendered).not.toContain('ai-briefing');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('fails closed for non-main, inactive, invisible, missing, ambiguous, and side-session metadata', () => {
    const base = mainMetadata();
    const cases = [
      ['profileName_not_main', { profileName: 'eunbyeol' }],
      ['windowKey_not_main', { windowKey: 'eunbyeol' }],
      ['sourceScope_not_main', { sourceScope: 'eunbyeol' }],
      ['deviceId_not_VIGIL', { deviceId: 'PHONE' }],
      ['activeState_not_open', { activeState: 'closed' }],
      ['visibleIndicatorPresent_not_true', { visibleIndicatorPresent: false }],
      ['non_main_session_suffix', { sessionId: 'app-session-372:eunbyeol' }],
      ['sessionScopeId_non_main_session_suffix', { sessionScopeId: 'app-session-372:eunbyeol' }],
      ['ambiguous_session_scope', { sessionId: 'app-session-372:' }],
      ['missing_or_ambiguous_scope', { profileName: undefined }],
      ['profileName_not_main', { windowKey: 'main', profileName: 'eunbyeol' }],
    ];

    for (const [expected, overrides] of cases) {
      const metadata = { ...base, ...overrides };
      for (const key of Object.keys(metadata)) {
        if (metadata[key] === undefined) delete metadata[key];
      }
      const projectRoot = tempProject();
      try {
        const scope = evaluateScope(metadata);
        const context = buildTypedRestartContinuityContextV0({
          projectRoot,
          metadata,
          nowMs: Date.parse('2026-05-13T17:05:00.000Z'),
        });
        expect(context.present).toBe(false);
        expect(context.decision).toMatch(/^absent_/);
        expect([...scope.invalid, ...scope.missing, scope.decision].join('|')).toContain(expected);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    }
  });

  test('dual main and Eunbyeol sentinels resolve only the main structured sources', () => {
    const projectRoot = tempProject();
    try {
      writeCurrentLane(projectRoot);
      writePresenceSummary(projectRoot);
      writeJson(projectRoot, path.join('.squidrun', 'handoffs-eunbyeol', 'current-lane.json'), {
        version: 1,
        generatedAt: '2026-05-13T17:00:00.000Z',
        sessionId: 'app-session-372:eunbyeol',
        status: 'active',
        activeLane: { objective: 'EUNBYEOL CURRENT LANE SENTINEL' },
      });
      writeJson(projectRoot, path.join('.squidrun', 'handoffs-eunbyeol', 'mira-presence-runtime-state-summary.json'), {
        context: { summary: { next_product_action: 'EUNBYEOL PRESENCE SENTINEL' } },
      });

      const context = buildTypedRestartContinuityContextV0({
        projectRoot,
        metadata: mainMetadata(),
        nowMs: Date.parse('2026-05-13T17:05:00.000Z'),
      });
      const rendered = JSON.stringify(context);
      expect(rendered).toContain('MAIN CURRENT LANE SENTINEL');
      expect(rendered).toContain('MAIN PRESENCE ACTION SENTINEL');
      expect(rendered).not.toContain('EUNBYEOL CURRENT LANE SENTINEL');
      expect(rendered).not.toContain('EUNBYEOL PRESENCE SENTINEL');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('reports present, absent, and stale restart-continuity behavior honestly', () => {
    const absentRoot = tempProject();
    try {
      const absent = buildTypedRestartContinuityContextV0({
        projectRoot: absentRoot,
        metadata: mainMetadata(),
        nowMs: Date.parse('2026-05-13T17:05:00.000Z'),
      });
      expect(absent.present).toBe(false);
      expect(absent.decision).toBe('absent_no_structured_restart_context');
    } finally {
      fs.rmSync(absentRoot, { recursive: true, force: true });
    }

    const presentRoot = tempProject();
    try {
      writeCurrentLane(presentRoot);
      writePresenceSummary(presentRoot);
      const present = buildTypedRestartContinuityContextV0({
        projectRoot: presentRoot,
        metadata: mainMetadata(),
        nowMs: Date.parse('2026-05-13T17:05:00.000Z'),
      });
      expect(present.present).toBe(true);
      expect(present.stale).toBe(false);

      const stale = buildTypedRestartContinuityContextV0({
        projectRoot: presentRoot,
        metadata: mainMetadata(),
        nowMs: Date.parse('2026-05-13T17:05:00.000Z'),
        staleAfterMs: 1000,
      });
      expect(stale.present).toBe(true);
      expect(stale.decision).toBe('structured_restart_context_stale');
      expect(stale.stale_sources).toEqual(expect.arrayContaining(['current_lane', 'mira_presence_runtime']));
    } finally {
      fs.rmSync(presentRoot, { recursive: true, force: true });
    }
  });
});
