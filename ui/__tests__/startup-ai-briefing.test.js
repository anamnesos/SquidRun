'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  generateStartupBriefing,
  readStartupBriefing,
  readStartupBriefingForInjection,
  _internals,
} = require('../modules/startup-ai-briefing');
const progressContract = require('./fixtures/mira-progress-contract-v0.json');

describe('startup-ai-briefing', () => {
  test('startup scope keeps non-main profileName when windowKey is generic main', () => {
    expect(_internals.resolveStartupScopeKey({
      windowKey: 'main',
      profileName: 'eunbyeol',
    })).toBe('eunbyeol');
  });

  test('startup scope treats hyphen-suffixed app-session ids as side profile scope', () => {
    const sideSessionId = 'app-session-254-eunbyeol';
    const sideRow = {
      senderRole: 'architect',
      targetRole: 'builder',
      status: 'routed',
      rawBody: '(ARCHITECT #1): Eunbyeol scoped startup context.',
      sentAtMs: 2000,
      sessionId: sideSessionId,
      metadata: {},
    };
    const sideSnapshot = {
      version: 1,
      sessionId: sideSessionId,
      status: 'active',
      activeLane: {
        objective: 'Eunbyeol scoped startup context.',
      },
    };

    expect(_internals.extractSessionScopeSuffix(sideSessionId)).toBe('eunbyeol');
    expect(_internals.resolveStartupScopeKey({ sessionScopeId: sideSessionId })).toBe('eunbyeol');
    expect(_internals.rowMatchesStartupScope(sideRow, { windowKey: 'main', profileName: 'main' })).toBe(false);
    expect(_internals.rowMatchesStartupScope(sideRow, { sessionScopeId: sideSessionId })).toBe(true);
    expect(_internals.snapshotMatchesStartupScope(sideSnapshot, { windowKey: 'main', profileName: 'main' })).toBe(false);
    expect(_internals.snapshotMatchesStartupScope(sideSnapshot, { sessionScopeId: sideSessionId })).toBe(true);
  });

  test('selects newest transcript files first', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-files-'));
    try {
      const older = path.join(tempRoot, 'older.jsonl');
      const newer = path.join(tempRoot, 'newer.jsonl');
      fs.writeFileSync(older, '');
      fs.writeFileSync(newer, '');
      const oldTime = new Date('2026-04-01T00:00:00.000Z');
      const newTime = new Date('2026-04-02T00:00:00.000Z');
      fs.utimesSync(older, oldTime, oldTime);
      fs.utimesSync(newer, newTime, newTime);

      const files = _internals.listRecentTranscriptFiles({
        projectsDir: tempRoot,
        maxTranscripts: 2,
      });

      expect(files.map((entry) => entry.name)).toEqual(['newer.jsonl', 'older.jsonl']);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('generates and saves a startup briefing from recent transcripts', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-gen-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      fs.mkdirSync(path.join(tempRoot, 'workspace', 'knowledge'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'workspace', 'knowledge', 'case-operations.md'), [
        '## Hard Error Rules',
        '- registration must happen **before 2026-06-03** (the eligibility 기준시점), not after.',
      ].join('\n'));
      const transcriptPath = path.join(tempRoot, 'session-1.jsonl');
      fs.writeFileSync(transcriptPath, [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-04-04T00:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'The user wants a hard cap of three active tasks.' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-04T00:01:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Builder shipped the cap and restarted the supervisor.' }] },
        }),
      ].join('\n'));

      const result = await generateStartupBriefing({
        projectsDir: tempRoot,
        projectRoot: tempRoot,
        outputPath,
        statusPath,
        apiKey: 'sk-ant-test-fake-key-do-not-use',
        fetchImpl: jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            content: [
              {
                type: 'text',
                text: '## What Happened\n- Automation was turned on with a $200 cap.\n',
              },
            ],
          }),
        }),
      });

      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expect(readStartupBriefing({ outputPath })).toContain('# AI Startup Briefing');
      expect(readStartupBriefing({ outputPath })).toContain('Automation was turned on with a $200 cap.');
      expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toEqual(expect.objectContaining({
        ok: true,
        transcriptCount: 1,
        liveSnapshotOk: false,
        canonicalSourceCount: 1,
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('marks injected briefing stale when status age is unknown', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-unknown-age-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      fs.writeFileSync(outputPath, '# AI Startup Briefing\n\n## What Happened\n- Keep the non-live briefing content.\n');

      const guarded = readStartupBriefingForInjection({
        outputPath,
        statusPath,
        nowMs: Date.parse('2026-04-26T19:00:00.000Z'),
      });

      expect(guarded).toMatch(/^STALE SNAPSHOT generated at unknown time, account values may have moved\./);
      expect(guarded).toContain('## What Happened');
      expect(guarded).toContain('Keep the non-live briefing content.');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('prepends warning when injected briefing is older than fifteen minutes', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-16m-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      fs.writeFileSync(outputPath, '# AI Startup Briefing\n\n- Scheduler status is the current priority.\n');
      fs.writeFileSync(statusPath, JSON.stringify({
        generatedAt: '2026-04-26T18:44:00.000Z',
      }));

      const guarded = readStartupBriefingForInjection({
        outputPath,
        statusPath,
        nowMs: Date.parse('2026-04-26T19:00:00.000Z'),
      });

      expect(guarded).toMatch(/^STALE SNAPSHOT generated 16 minutes ago, account values may have moved\./);
      expect(guarded).toContain('Scheduler status is the current priority.');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('prepends current lane and recent current-scope comms before older briefing prose', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-continuity-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');
    const currentLanePath = path.join(tempRoot, 'current-lane.json');

    try {
      fs.writeFileSync(outputPath, '# AI Startup Briefing\n\n- Historical handoff prose comes later.\n');
      fs.writeFileSync(statusPath, JSON.stringify({
        ok: true,
        generatedAt: '2026-05-08T17:00:00.000Z',
      }));
      fs.writeFileSync(currentLanePath, JSON.stringify({
        version: 1,
        status: 'active',
        activeLane: {
          laneId: 'app-session-336:architect-25:m-mira-lane',
          objective: 'New Mira implementation seam',
          sourceMessageId: 'm-mira-lane',
        },
      }));

      const guarded = readStartupBriefingForInjection({
        outputPath,
        statusPath,
        currentLanePath,
        nowMs: Date.parse('2026-05-08T17:05:00.000Z'),
        recentCommsRows: [
          {
            messageId: 'm-old',
            senderRole: 'architect',
            targetRole: 'builder',
            status: 'routed',
            rawBody: '(ARCHITECT #12): TASK: stale startup-health bridge probe.',
            brokeredAtMs: 1000,
          },
          {
            messageId: 'm-new',
            senderRole: 'architect',
            targetRole: 'builder',
            status: 'brokered',
            rawBody: '(ARCHITECT #25): CURRENT LANE: New Mira implementation seam.',
            brokeredAtMs: 2000,
          },
        ],
      });

      expect(guarded).toContain('AI startup briefing age: 5 minutes.');
      expect(guarded).toContain('## Live Current Lane (machine-readable)');
      expect(guarded).toContain('## Recent Current-Scope Comms (last 2)');
      expect(guarded).toContain('New Mira implementation seam');
      expect(guarded.indexOf('## Live Current Lane')).toBeLessThan(guarded.indexOf('# AI Startup Briefing'));
      expect(guarded.indexOf('## Recent Current-Scope Comms')).toBeLessThan(guarded.indexOf('# AI Startup Briefing'));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('injects machine-readable Mira Presence restart accounting from durable state', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-mira-accounting-'));
    const outputPath = path.join(tempRoot, '.squidrun', 'handoffs', 'ai-briefing.md');
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'startup-briefing-status.json');
    const currentLanePath = path.join(tempRoot, '.squidrun', 'handoffs', 'current-lane.json');

    try {
      fs.mkdirSync(path.join(tempRoot, '.squidrun', 'handoffs'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, '.squidrun', 'runtime'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, '.squidrun', 'state'), { recursive: true });
      fs.writeFileSync(
        outputPath,
        '# AI Startup Briefing\n\n- Historical generic Mira prose should not count.\n'
      );
      fs.writeFileSync(
        statusPath,
        JSON.stringify({
          ok: false,
          generatedAt: '2026-05-24T05:20:00.000Z',
          error: 'ANTHROPIC_API_KEY is not set',
        })
      );
      fs.writeFileSync(
        path.join(tempRoot, '.squidrun', 'state', 'mira-presence-runtime-state.json'),
        JSON.stringify({
          schema: 'squidrun.mira_core.presence_runtime_state.v0',
          version: 1,
          generated_at: '2026-05-24T05:19:00.000Z',
          surface: 'backstage_internal_only',
          active_mira_presence_lane: 'sentinel_presence_lane',
          accepted_critique: 'sentinel accepted critique from durable state',
          next_product_action: 'sentinel next product action from durable state',
          proof_test_state: 'sentinel proof test state',
          stale_markers: ['sentinel stale marker'],
          blocked_status: {
            live_voice_blocked: true,
            always_on_mic_blocked: true,
            pc_embodiment_blocked: true,
            a3_a4_blocked: true,
          },
          interruption_marker: 'none',
          agency_level: 'A0',
          canonical_hash: 'sha256:sentinel',
        })
      );
      fs.writeFileSync(
        currentLanePath,
        JSON.stringify({
          version: 1,
          generatedAt: '2026-05-24T05:21:00.000Z',
          sessionId: 'app-session-380',
          status: 'active',
          activeLane: {
            objective: 'Startup should surface durable Mira evidence.',
            status: 'active',
            sourceRef: 'architect#27',
            sourceMessageId: 'hm-sentinel-task',
            sourceTimestampMs: Date.parse('2026-05-24T05:18:00.000Z'),
          },
        })
      );

      const guarded = readStartupBriefingForInjection({
        projectRoot: tempRoot,
        outputPath,
        statusPath,
        currentLanePath,
        nowMs: Date.parse('2026-05-24T05:25:00.000Z'),
        miraProgressContract: progressContract,
        miraProgressHead: {
          short_sha: '6427991e',
          committed_at: '2026-05-24T05:22:00.000Z',
          subject: 'Add Mira restart accounting startup proof',
        },
        miraProgressInputSignals: {
          proofs: {
            'startup-ai-briefing.test.js': {
              status: 'PASS',
              source_ref: 'npm --prefix ui test -- startup-ai-briefing.test.js',
            },
          },
        },
      });

      expect(guarded).toContain('UNTRUSTED AI BRIEFING');
      expect(guarded).toContain('## Mira Presence Restart Accounting (machine-readable)');
      expect(guarded).toContain('"schema": "squidrun.startup_ai_briefing.mira_presence_restart_accounting.v0"');
      expect(guarded).toContain('coherent runtime continuity/agency/critique/next-action across restart and surfaces');
      expect(guarded).toContain('"tone wrapper"');
      expect(guarded).toContain('"generic startup summary"');
      expect(guarded).toContain('"global Mira percentage without accounting"');
      expect(guarded).toContain('"source_ref": ".squidrun/state/mira-presence-runtime-state.json"');
      expect(guarded).toContain('"active_mira_presence_lane": "sentinel_presence_lane"');
      expect(guarded).toContain('"accepted_critique": "sentinel accepted critique from durable state"');
      expect(guarded).toContain('"next_product_action": "sentinel next product action from durable state"');
      expect(guarded).toContain('"proof_test_state": "sentinel proof test state"');
      expect(guarded).toContain('"sentinel stale marker"');
      expect(guarded).toContain('"source_ref": "architect#27"');
      expect(guarded).toContain('"source_message_id": "hm-sentinel-task"');
      expect(guarded).toContain('"computed_progress"');
      expect(guarded).toContain('"schema": "squidrun.mira.progress_report.v0"');
      expect(guarded).toContain('"historical_baseline"');
      expect(guarded).toContain('"label": "35-45% real"');
      expect(guarded).toContain('"computed_authority": false');
      expect(guarded).toContain('"id": "voice_transport"');
      expect(guarded).toContain('"computed_percent": 0');
      expect(guarded).toContain('"presence_state_predates_head"');
      expect(guarded).not.toContain('"global_percent":');
      expect(guarded.indexOf('## Mira Presence Restart Accounting')).toBeLessThan(guarded.indexOf('## Live Current Lane'));
      expect(guarded).not.toContain('Historical generic Mira prose should not count');
      expect(guarded).not.toContain('# AI Startup Briefing');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('recent comms formatting falls through from null brokeredAtMs to sentAtMs', () => {
    const block = _internals.formatRecentCommsWindow([
      {
        messageId: 'm-sent-fallback',
        senderRole: 'architect',
        targetRole: 'builder',
        status: 'recorded',
        rawBody: '(ARCHITECT #1): Sent timestamp should render.',
        brokeredAtMs: null,
        sentAtMs: 2000,
      },
    ]);

    expect(block).toContain('1970-01-01T00:00:02.000Z');
    expect(block).toContain('Sent timestamp should render.');
    expect(block).not.toContain('| - | architect | builder | recorded |');
  });

  test('excludes main Mira durable requirements and current lane from Eunbyeol startup scope', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-eunbyeol-scope-'));

    try {
      fs.mkdirSync(path.join(tempRoot, '.squidrun', 'handoffs'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, '.squidrun', 'runtime'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, 'docs'), { recursive: true });
      fs.writeFileSync(
        path.join(tempRoot, '.squidrun', 'handoffs', 'ai-briefing.md'),
        '# AI Startup Briefing\n\n- Main Mira startup prose.\n'
      );
      fs.writeFileSync(
        path.join(tempRoot, '.squidrun', 'handoffs', 'current-lane.json'),
        JSON.stringify({
          version: 1,
          sessionId: 'app-session-372',
          status: 'active',
          activeLane: {
            laneId: 'app-session-372:architect-9:mira',
            objective: 'Main Mira Presence Runtime acceptance',
          },
        })
      );
      fs.writeFileSync(
        path.join(tempRoot, 'docs', 'mira-presence-runtime-acceptance-v0.md'),
        '# Mira Presence Runtime Acceptance v0\n\nVisible Mira replies must satisfy anti-smoothing constraints.\n'
      );

      const guarded = readStartupBriefingForInjection({
        projectRoot: tempRoot,
        windowKey: 'eunbyeol',
        profileName: 'eunbyeol',
        sessionScopeId: 'app-session-372:eunbyeol',
        nowMs: Date.parse('2026-05-13T16:45:00.000Z'),
        recentCommsRows: [
          {
            senderRole: 'architect',
            targetRole: 'builder',
            status: 'routed',
            rawBody: '(ARCHITECT #9): Main Mira Presence lane should stay main.',
            brokeredAtMs: 1000,
            sessionId: 'app-session-372',
            metadata: { windowKey: 'main', profileName: 'main' },
          },
          {
            senderRole: 'architect',
            targetRole: 'builder',
            status: 'routed',
            rawBody: '(ARCHITECT #10): Eunbyeol case runtime context.',
            brokeredAtMs: 2000,
            sessionId: 'app-session-372:eunbyeol',
            metadata: { windowKey: 'eunbyeol', profileName: 'eunbyeol' },
          },
        ],
      });

      expect(guarded).toContain('Eunbyeol case runtime context');
      expect(guarded).not.toContain('Startup-Facing Durable Requirements');
      expect(guarded).not.toContain('Mira Presence Restart Accounting');
      expect(guarded).not.toContain('Main Mira Presence Runtime acceptance');
      expect(guarded).not.toContain('Main Mira startup prose');
      expect(guarded).not.toContain('Main Mira Presence lane should stay main');
      expect(guarded).not.toContain('anti-smoothing');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('generateStartupBriefing skips gracefully when Anthropic key is intentionally absent', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-skip-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      const transcriptPath = path.join(tempRoot, 'session-1.jsonl');
      fs.writeFileSync(transcriptPath, JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'unused transcript' }] },
      }));

      const fetchImpl = jest.fn();

      const result = await generateStartupBriefing({
        projectsDir: tempRoot,
        projectRoot: tempRoot,
        outputPath,
        statusPath,
        env: { OPENAI_API_KEY: 'sk-test-openai-fake' },
        fetchImpl,
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        skipped: true,
        skipReason: 'anthropic_provider_disabled',
        fallbackAvailable: true,
      }));

      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      expect(status).toEqual(expect.objectContaining({
        ok: true,
        skipped: true,
        skipReason: 'anthropic_provider_disabled',
        fallbackAvailable: true,
      }));
      expect(JSON.stringify(status)).not.toMatch(/sk-test-openai-fake/);
      expect(JSON.stringify(status)).not.toMatch(/ANTHROPIC_API_KEY/);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('injected briefing emits a calm skip note (not UNTRUSTED prose) when status is skipped', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-skip-inject-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      fs.writeFileSync(outputPath, '# AI Startup Briefing\n\n- Stale prose must not survive a skipped briefing.\n');
      fs.writeFileSync(statusPath, JSON.stringify({
        ok: true,
        skipped: true,
        skipReason: 'anthropic_provider_disabled',
        generatedAt: '2026-05-10T18:00:00.000Z',
      }));

      const guarded = readStartupBriefingForInjection({
        outputPath,
        statusPath,
        nowMs: Date.parse('2026-05-10T18:05:00.000Z'),
      });

      expect(guarded).toContain('AI briefing skipped: anthropic_provider_disabled');
      expect(guarded).toContain('non-blocking');
      expect(guarded).not.toContain('UNTRUSTED AI BRIEFING');
      expect(guarded).not.toContain('failed');
      expect(guarded).not.toContain('Stale prose must not survive');
      expect(guarded).not.toContain('# AI Startup Briefing');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('omits old briefing prose and scopes missing Anthropic key wording to the startup process when latest generation failed', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-untrusted-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      fs.writeFileSync(outputPath, '# AI Startup Briefing\n\n- Bridge is the current live blocker.\n');
      fs.writeFileSync(statusPath, JSON.stringify({
        ok: false,
        generatedAt: '2026-05-08T17:00:00.000Z',
        error: 'ANTHROPIC_API_KEY is not set',
      }));

      const guarded = readStartupBriefingForInjection({
        outputPath,
        statusPath,
        nowMs: Date.parse('2026-05-08T17:05:00.000Z'),
      });

      expect(guarded).toContain('UNTRUSTED AI BRIEFING');
      expect(guarded).toContain('startup generator process could not see ANTHROPIC_API_KEY');
      expect(guarded).not.toContain('ANTHROPIC_API_KEY is not set');
      expect(guarded).not.toContain('Bridge is the current live blocker.');
      expect(guarded).not.toContain('# AI Startup Briefing');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('surfaces durable Mira Presence Runtime requirements even when generated briefing prose is untrusted', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-presence-durable-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      fs.mkdirSync(path.join(tempRoot, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'docs', 'mira-presence-runtime-acceptance-v0.md'), [
        '# Mira Presence Runtime Acceptance v0',
        '',
        '## Visible Reply Contract',
        'Visible Mira replies must satisfy anti-smoothing / anti-performance / anti-leak constraints.',
        '',
        '## Restart Continuity Gate',
        'James must not be the restart or stop-turn continuity harness for this critique.',
      ].join('\n'));
      fs.writeFileSync(outputPath, '# AI Startup Briefing\n\n- Historical prose should not survive a failed generation.\n');
      fs.writeFileSync(statusPath, JSON.stringify({
        ok: false,
        generatedAt: '2026-05-09T00:05:00.000Z',
        error: 'ANTHROPIC_API_KEY is not set',
      }));

      const guarded = readStartupBriefingForInjection({
        projectRoot: tempRoot,
        outputPath,
        statusPath,
        nowMs: Date.parse('2026-05-09T00:10:00.000Z'),
      });

      expect(guarded).toContain('UNTRUSTED AI BRIEFING');
      expect(guarded).toContain('## Startup-Facing Durable Requirements');
      expect(guarded).toContain('docs/mira-presence-runtime-acceptance-v0.md');
      expect(guarded).toContain('anti-smoothing / anti-performance / anti-leak');
      expect(guarded).toContain('assistant-voice collapse');
      expect(guarded).toContain('James does not have to restate the critique');
      expect(guarded).toContain('not hidden prompt prose or durable memory claims');
      expect(guarded).not.toContain('Historical prose should not survive');
      expect(guarded).not.toContain('# AI Startup Briefing');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('Mira Lab verifier bootstrap stale block is injected when state is non-ready and clears when ready', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-mira-bootstrap-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');
    const stateDir = path.join(tempRoot, '.squidrun', 'runtime');
    const statePath = path.join(stateDir, 'mira-lab-verify-bootstrap.json');

    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(outputPath, '# AI Startup Briefing\n\n- Some prior content.\n');
      fs.writeFileSync(statusPath, JSON.stringify({ ok: true, generatedAt: '2026-05-10T19:30:00.000Z' }));
      fs.writeFileSync(statePath, JSON.stringify({
        schema: 'squidrun.mira_lab_verify.bootstrap.v1',
        bootstrap_status: 'action_not_loaded_in_running_main',
        prompt_path_status: 'complete',
        last_verified_at: '2026-05-10T19:00:00.000Z',
      }));

      const stale = readStartupBriefingForInjection({
        projectRoot: tempRoot,
        outputPath,
        statusPath,
        nowMs: Date.parse('2026-05-10T19:35:00.000Z'),
      });

      expect(stale).toMatch(/Mira Lab Verifier Bootstrap: stale \(window-open only\)/);
      expect(stale).toMatch(/hm-mira-lab-verify\.js --session-id verify-post-restart-mira-lab --json/);
      expect(stale).toMatch(/prompt_path: PASS/);

      fs.writeFileSync(statePath, JSON.stringify({
        schema: 'squidrun.mira_lab_verify.bootstrap.v1',
        bootstrap_status: 'ready',
        prompt_path_status: 'complete',
        last_verified_at: '2026-05-10T19:34:00.000Z',
      }));

      const cleared = readStartupBriefingForInjection({
        projectRoot: tempRoot,
        outputPath,
        statusPath,
        nowMs: Date.parse('2026-05-10T19:36:00.000Z'),
      });

      expect(cleared).not.toMatch(/Mira Lab Verifier Bootstrap: stale/);
      expect(cleared).not.toMatch(/verify-post-restart-mira-lab/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('strips live account blocks when injected briefing is older than sixty minutes', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-61m-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      fs.writeFileSync(outputPath, [
        '# AI Startup Briefing',
        '',
        '## Live Account Status',
        '- Account value: $616.93',
        '- SAMPLE/USD short size=-7683',
        '',
        '## What Happened',
        '- Curator cleanup landed and non-live context remains useful.',
        '',
        '## Verified Live Account Snapshot',
        '- Withdrawable: $0.04',
        '',
        '## Next Work',
        '- Keep removing disabled lanes.',
        '',
      ].join('\n'));
      fs.writeFileSync(statusPath, JSON.stringify({
        generatedAt: '2026-04-26T17:59:00.000Z',
      }));

      const guarded = readStartupBriefingForInjection({
        outputPath,
        statusPath,
        nowMs: Date.parse('2026-04-26T19:00:00.000Z'),
      });

      expect(guarded).toMatch(/^STALE SNAPSHOT generated 61 minutes ago; live-account block omitted, account values may have moved\./);
      expect(guarded).not.toContain('Account value: $616.93');
      expect(guarded).not.toContain('SAMPLE/USD short');
      expect(guarded).not.toContain('Verified Live Account Snapshot');
      expect(guarded).not.toContain('Withdrawable: $0.04');
      expect(guarded).toContain('Curator cleanup landed and non-live context remains useful.');
      expect(guarded).toContain('Keep removing disabled lanes.');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('builds a prompt with the verified live snapshot', () => {
    const prompt = _internals.buildBriefingPrompt(
      [{ name: 'session-1.jsonl', modifiedAt: '2026-04-17T01:30:22.795Z' }],
      'USER: Briefing says SOL was closed.\n\nASSISTANT: Need to verify live state.',
      {
        liveSnapshot: {
          ok: true,
          checkedAt: '2026-04-17T01:31:03.643Z',
          accountValue: 508.55,
          withdrawable: 0,
          positions: [
            {
              ticker: 'SOL/USD',
              side: 'short',
              size: -111.46,
              entryPx: 88.451,
              unrealizedPnl: 20.17,
              liquidationPx: 90.55,
            },
          ],
        },
      }
    );

    expect(prompt).toContain('Verified live account snapshot:');
    expect(prompt).toContain('SOL/USD short size=-111.46');
    expect(prompt).toContain('Use the verified live snapshot');
  });

  test('uses canonical case files to override stale Scoped transcript summaries', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-briefing-canonical-'));
    const outputPath = path.join(tempRoot, 'ai-briefing.md');
    const statusPath = path.join(tempRoot, 'startup-briefing-status.json');

    try {
      fs.mkdirSync(path.join(tempRoot, 'workspace', 'knowledge'), { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'workspace', 'knowledge', 'case-operations.md'), [
        '## Hard Error Rules',
        '- registration must happen **before 2026-06-03** (the eligibility 기준시점), not after.',
        '',
        '| Startup Program 2026 1기 | **Submitted 2026-04-29** (Scoped confirmed via Telegram). | Selection result. |',
      ].join('\n'));
      fs.writeFileSync(path.join(tempRoot, 'workspace', 'knowledge', 'handoff-corrections.md'), [
        '## Fast Use',
        '- If an agent is about to say stale facts, re-check this file first.',
      ].join('\n'));

      const transcriptPath = path.join(tempRoot, 'session-1.jsonl');
      fs.writeFileSync(transcriptPath, JSON.stringify({
        type: 'user',
        timestamp: '2026-04-29T20:58:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'registration timing Must be after 6/3. Startup Program status uncertain.',
            },
          ],
        },
      }));

      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [
            {
              type: 'text',
              text: [
                '## Key Dates & Numbers',
                '| registration timing | Must be **after 6/3** to preserve eligibility benefit eligibility |',
                '',
                '## Immediate Priorities',
                '1. Confirm Startup Program submission status — did she finish and submit, or is it still in progress?',
              ].join('\n'),
            },
          ],
        }),
      });

      const result = await generateStartupBriefing({
        projectsDir: tempRoot,
        projectRoot: tempRoot,
        outputPath,
        statusPath,
        apiKey: 'sk-ant-test-fake-key-do-not-use',
        fetchImpl,
      });

      const prompt = JSON.parse(fetchImpl.mock.calls[0][1].body).messages[0].content;
      const briefing = readStartupBriefing({ outputPath });

      expect(result.ok).toBe(true);
      expect(prompt).toContain('Canonical source-of-truth (highest priority):');
      expect(prompt).toContain('registration must happen **before 2026-06-03**');
      expect(briefing).toContain('Canonical Source-Of-Truth Overrides');
      expect(briefing).toContain('Must be **on or before 2026-06-03**');
      expect(briefing).toContain('Monitor Startup Program Stage 1 announcement');
      expect(briefing).not.toContain('Must be **after 6/3**');
      expect(briefing).not.toContain('Confirm Startup Program submission status');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
