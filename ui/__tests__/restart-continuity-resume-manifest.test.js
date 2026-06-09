/* global afterEach, beforeEach, describe, expect, jest, test */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function extractBlockPayload(text) {
  const match = String(text || '').match(/## Restart Continuity Resume \(machine-readable\)[\s\S]*?```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error('missing_restart_continuity_resume_block');
  return JSON.parse(match[1]);
}

describe('restart-continuity-resume-manifest', () => {
  let tempRoot;
  let manifest;
  let ledger;
  let queue;
  let startup;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-restart-resume-'));
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      PROJECT_ROOT: tempRoot,
      WORKSPACE_PATH: path.join(tempRoot, '.squidrun'),
      getProjectRoot: () => tempRoot,
      getActiveProfile: () => 'main',
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        '.squidrun',
        String(relPath || '').replace(/^[/\\]+/, '').replace(/[/\\]+/g, path.sep),
      ),
    }));
    manifest = require('../modules/main/restart-continuity-resume-manifest');
    ledger = require('../modules/main/work-item-ledger');
    queue = require('../scripts/hm-task-queue');
    startup = require('../modules/startup-ai-briefing');
    writeJson(path.join(tempRoot, '.squidrun', 'app-status.json'), {
      session_id: 'app-session-418',
    });
    writeJson(path.join(tempRoot, '.squidrun', 'handoffs', 'current-lane.json'), {
      version: 1,
      generatedAt: '2026-06-09T06:00:00.000Z',
      sessionId: 'app-session-418',
      source: 'comms_journal',
      status: 'none',
      activeLane: null,
    });
    queue.writeQueue({
      updatedAt: '2026-06-09T06:00:00.000Z',
      agents: {
        architect: { active: null, pending: [], history: [] },
        builder: { active: null, pending: [], history: [] },
        oracle: { active: null, pending: [], history: [] },
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('../config');
  });

  test('typed active work item wins route authority over current-lane and queue stores', () => {
    const nowMs = Date.parse('2026-06-09T06:05:00.000Z');
    ledger.openWorkItem({
      id: 'wi-typed-authority',
      sessionId: 'app-session-418',
      profile: 'main',
      windowKey: 'main',
      objective: 'Continue proof-bound restart work',
      ownerRoles: ['builder'],
      riskClass: 'caution',
      sourceMessageIds: ['hm-architect-current-lane'],
      artifactRefs: [{ ref: 'jest:typed-work', summary: 'Typed proof source' }],
      now: '2026-06-09T06:01:00.000Z',
    });
    writeJson(path.join(tempRoot, '.squidrun', 'handoffs', 'current-lane.json'), {
      version: 1,
      generatedAt: '2026-06-09T06:02:00.000Z',
      sessionId: 'app-session-418',
      status: 'active',
      activeLane: {
        laneId: 'current-lane-loser',
        sourceRef: 'architect#99',
        sourceMessageId: 'hm-losing-current-lane',
        objective: 'Unverified current lane should lose',
        targetRole: 'oracle',
      },
    });
    queue.writeQueue({
      updatedAt: '2026-06-09T06:02:00.000Z',
      agents: {
        architect: { active: null, pending: [], history: [] },
        builder: {
          active: {
            taskId: 'queue-loser',
            owner: 'builder',
            state: 'active',
            riskClass: 'safe',
            message: 'Queue active should not own authority',
          },
          pending: [],
          history: [],
        },
        oracle: { active: null, pending: [], history: [] },
      },
    });

    const result = manifest.buildRestartContinuityResumeManifest({
      projectRoot: tempRoot,
      nowMs,
      head: { short_sha: 'testhead1', committed_at: '2026-06-09T06:04:00.000Z', subject: 'test' },
    });

    expect(result.status).toBe('ready');
    expect(result.authority).toEqual(expect.objectContaining({
      decision: 'typed_active_work_item',
      current_lane_authority: 'typed_active_work_item',
      active_work_item_id: 'wi-typed-authority',
      queue_candidates_create_current_lane: false,
    }));
    expect(result.resumeCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'typed_active_work_item',
        agent: 'builder',
        action: 'preview_only',
        currentLaneAuthority: true,
      }),
      expect.objectContaining({
        kind: 'owned_work_active',
        agent: 'builder',
        currentLaneAuthority: false,
      }),
    ]));
    expect(JSON.stringify(result)).not.toContain('rawBody');
    expect(result.sendSurface).toEqual(expect.objectContaining({
      available: false,
      dispatchWired: false,
    }));
  });

  test('queue resume candidate is visible but has no current-lane authority', () => {
    const nowMs = Date.parse('2026-06-09T06:05:00.000Z');
    ledger.openWorkItem({
      id: 'wi-old-session-must-not-resume',
      sessionId: 'app-session-412',
      profile: 'main',
      windowKey: 'main',
      objective: 'Prior-session work must not become current restart authority',
      ownerRoles: ['builder'],
      riskClass: 'caution',
      now: '2026-06-09T05:00:00.000Z',
    });
    queue.writeQueue({
      updatedAt: '2026-06-09T06:04:00.000Z',
      agents: {
        architect: { active: null, pending: [], history: [] },
        builder: {
          active: null,
          pending: [{
            taskId: 'builder-post-wake',
            owner: 'builder',
            state: 'queued',
            riskClass: 'safe',
            title: 'Restart-free docs check',
            message: 'Do typed-source work only',
            nextStep: 'Run the read-model proof.',
            wakeTrigger: 'post-wake',
            lastAdvancedAt: nowMs - 1000,
          }],
          history: [],
        },
        oracle: { active: null, pending: [], history: [] },
      },
    });

    const result = manifest.buildRestartContinuityResumeManifest({
      projectRoot: tempRoot,
      nowMs,
      head: { short_sha: 'testhead2', committed_at: '2026-06-09T06:04:00.000Z', subject: 'test' },
    });

    expect(result.authority).toEqual(expect.objectContaining({
      decision: 'none',
      current_lane_authority: 'none',
      active_lane_present: false,
      queue_candidates_create_current_lane: false,
    }));
    expect(result.activeWorkReconciliation).toEqual(expect.objectContaining({
      authority: 'none',
      activeWorkItemId: null,
      activeWorkItemIds: [],
    }));
    expect(result.resumeCandidates).toEqual([
      expect.objectContaining({
        kind: 'owned_work_resume_candidate',
        agent: 'builder',
        taskId: 'builder-post-wake',
        action: 'auto_dispatch_candidate',
        previewOnly: true,
        currentLaneAuthority: false,
        authority: 'owned_work_queue_candidate_no_current_lane_authority',
        dispatchEligibility: expect.objectContaining({
          eligible: true,
          reason: 'preview_only_phase_1_not_dispatched',
        }),
      }),
    ]);
    expect(result.perArm.builder.action).toBe('auto_dispatch_candidate');
  });

  test('sessionless typed work item cannot inherit current restart authority', () => {
    const nowMs = Date.parse('2026-06-09T06:05:00.000Z');
    const workItemRoot = path.join(tempRoot, '.squidrun', 'runtime', 'work-items');
    writeJson(path.join(workItemRoot, 'wi-sessionless.json'), {
      schema: 'squidrun.work_item.v0',
      version: 1,
      id: 'wi-sessionless',
      state: 'active',
      profile: 'main',
      window: { key: 'main' },
      objective: 'Malformed historical work item must not become current authority',
      ownerRoles: ['builder'],
      riskClass: 'caution',
      createdAt: '2026-06-09T05:00:00.000Z',
      updatedAt: '2026-06-09T05:00:00.000Z',
    });
    writeJson(path.join(workItemRoot, 'index.json'), {
      schema: 'squidrun.work_item_index.v0',
      version: 1,
      updatedAt: '2026-06-09T05:00:00.000Z',
      activeWorkItemId: 'wi-sessionless',
      items: [{
        id: 'wi-sessionless',
        state: 'active',
        sessionId: null,
        profile: 'main',
        windowKey: 'main',
        objective: 'Malformed historical work item must not become current authority',
        updatedAt: '2026-06-09T05:00:00.000Z',
        path: path.join(workItemRoot, 'wi-sessionless.json'),
      }],
    });

    const result = manifest.buildRestartContinuityResumeManifest({
      projectRoot: tempRoot,
      nowMs,
      head: { short_sha: 'testhead2b', committed_at: '2026-06-09T06:04:00.000Z', subject: 'test' },
    });

    expect(result.authority).toEqual(expect.objectContaining({
      decision: 'none',
      current_lane_authority: 'none',
      active_work_item_id: null,
    }));
    expect(result.activeWorkReconciliation).toEqual(expect.objectContaining({
      authority: 'none',
      activeWorkItemId: null,
      activeWorkItemIds: [],
    }));
    expect(result.resumeCandidates).toEqual([]);
  });

  test('prior-session current-lane fallback is rejected instead of becoming authority', () => {
    const nowMs = Date.parse('2026-06-09T06:05:00.000Z');
    writeJson(path.join(tempRoot, '.squidrun', 'handoffs', 'current-lane.json'), {
      version: 1,
      generatedAt: '2026-06-09T06:04:00.000Z',
      sessionId: 'app-session-412',
      status: 'active',
      activeLane: {
        laneId: 'stale-current-lane',
        sourceRef: 'architect#stale',
        sourceMessageId: 'hm-stale-current-lane',
        objective: 'Old current lane must not resume',
        targetRole: 'builder',
      },
    });

    const result = manifest.buildRestartContinuityResumeManifest({
      projectRoot: tempRoot,
      nowMs,
      head: { short_sha: 'testhead2c', committed_at: '2026-06-09T06:04:00.000Z', subject: 'test' },
    });

    expect(result.authority).toEqual(expect.objectContaining({
      decision: 'none',
      current_lane_authority: 'none',
      active_work_item_id: null,
    }));
    expect(result.resumeCandidates).toEqual([]);
    expect(result.staleMarkers).toEqual(expect.arrayContaining([
      'current_lane_scope_rejected:app-session-412',
    ]));
  });

  test('sessionless current-lane fallback is rejected instead of becoming authority', () => {
    const nowMs = Date.parse('2026-06-09T06:05:00.000Z');
    writeJson(path.join(tempRoot, '.squidrun', 'handoffs', 'current-lane.json'), {
      version: 1,
      generatedAt: '2026-06-09T06:04:00.000Z',
      status: 'active',
      activeLane: {
        laneId: 'sessionless-current-lane',
        sourceRef: 'architect#sessionless',
        sourceMessageId: 'hm-sessionless-current-lane',
        objective: 'Sessionless current lane must not resume',
        targetRole: 'builder',
      },
    });

    const result = manifest.buildRestartContinuityResumeManifest({
      projectRoot: tempRoot,
      nowMs,
      head: { short_sha: 'testhead2d', committed_at: '2026-06-09T06:04:00.000Z', subject: 'test' },
    });

    expect(result.authority).toEqual(expect.objectContaining({
      decision: 'none',
      current_lane_authority: 'none',
      active_work_item_id: null,
    }));
    expect(result.resumeCandidates).toEqual([]);
    expect(result.staleMarkers).toEqual(expect.arrayContaining([
      'current_lane_scope_rejected:missing_session',
    ]));
  });

  test('missing head metadata is reported without shelling out from the read-model', () => {
    const result = manifest.buildRestartContinuityResumeManifest({
      projectRoot: tempRoot,
      nowMs: Date.parse('2026-06-09T06:05:00.000Z'),
    });

    expect(result.head).toEqual(expect.objectContaining({
      source_kind: 'git_head',
      present: false,
      short_sha: null,
      committed_at: null,
      subject: null,
      stale_reason: 'head_metadata_not_supplied',
    }));
    expect(result.staleMarkers).toEqual(expect.arrayContaining([
      'source_missing:head_metadata:head_metadata_not_supplied',
    ]));
  });

  test('approval-required owned work is held for review in preview data', () => {
    const nowMs = Date.parse('2026-06-09T06:05:00.000Z');
    queue.writeQueue({
      updatedAt: '2026-06-09T06:04:00.000Z',
      agents: {
        architect: { active: null, pending: [], history: [] },
        builder: {
          active: null,
          pending: [{
            taskId: 'builder-approval',
            owner: 'builder',
            state: 'queued',
            riskClass: 'approval_required',
            title: 'Needs approval',
            message: 'Send customer-facing email',
            wakeTrigger: 'post-wake',
            lastAdvancedAt: nowMs - 1000,
          }],
          history: [],
        },
        oracle: { active: null, pending: [], history: [] },
      },
    });

    const result = manifest.buildRestartContinuityResumeManifest({
      projectRoot: tempRoot,
      nowMs,
      head: { short_sha: 'testhead3', committed_at: '2026-06-09T06:04:00.000Z', subject: 'test' },
    });

    expect(result.resumeCandidates[0]).toEqual(expect.objectContaining({
      taskId: 'builder-approval',
      action: 'hold_for_review',
      dispatchEligibility: expect.objectContaining({
        eligible: false,
        reason: 'approval_required',
      }),
    }));
    expect(result.counts.heldForReview).toBe(1);
  });

  test('non-main scope is rejected and does not create resume authority', () => {
    const result = manifest.buildRestartContinuityResumeManifest({
      projectRoot: tempRoot,
      profileName: 'eunbyeol',
      windowKey: 'eunbyeol',
      sessionScopeId: 'app-session-418:eunbyeol',
      nowMs: Date.parse('2026-06-09T06:05:00.000Z'),
    });

    expect(result.status).toBe('rejected');
    expect(result.decision).toBe('non_main_scope_rejected');
    expect(result.resumeCandidates).toEqual([]);
    expect(result.authority.current_lane_authority).toBe('none');
    expect(result.perArm.builder.action).toBe('no_action');
  });

  test('reports stale markers, source refs, and hashes', () => {
    const result = manifest.buildRestartContinuityResumeManifest({
      projectRoot: tempRoot,
      nowMs: Date.parse('2026-06-09T07:05:00.000Z'),
      staleAfterMs: 30 * 60 * 1000,
      head: { short_sha: 'testhead4', committed_at: '2026-06-09T07:04:00.000Z', subject: 'test' },
    });

    expect(result.source_refs.current_lane).toEqual(expect.objectContaining({
      source_ref: '.squidrun/handoffs/current-lane.json',
      present: true,
      sha256: expect.stringMatching(/^sha256:/),
      status: 'none',
    }));
    expect(result.source_refs.task_queue).toEqual(expect.objectContaining({
      source_ref: '.squidrun/runtime/agent-task-queue.json',
      present: true,
      sha256: expect.stringMatching(/^sha256:/),
    }));
    expect(result.staleMarkers).toEqual(expect.arrayContaining([
      'source_stale:current_lane:older_than_stale_after_ms',
      'source_stale:task_queue:older_than_stale_after_ms',
    ]));
  });

  test('startup injection writes the approved artifact and emits machine-readable block', () => {
    const outputPath = path.join(tempRoot, '.squidrun', 'handoffs', 'ai-briefing.md');
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'startup-briefing-status.json');
    writeJson(statusPath, {
      ok: true,
      skipped: true,
      skipReason: 'anthropic_provider_disabled',
      generatedAt: '2026-06-09T06:00:00.000Z',
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, '# AI Startup Briefing\n\n- stale prose omitted.\n', 'utf8');
    queue.writeQueue({
      updatedAt: '2026-06-09T06:04:00.000Z',
      agents: {
        architect: { active: null, pending: [], history: [] },
        builder: {
          active: null,
          pending: [{
            taskId: 'builder-startup-block',
            owner: 'builder',
            state: 'queued',
            riskClass: 'safe',
            title: 'Startup read model',
            message: 'typed queue body, not raw comms',
            nextStep: 'Verify the artifact.',
            wakeTrigger: 'post-wake',
            lastAdvancedAt: Date.parse('2026-06-09T06:03:00.000Z'),
          }],
          history: [],
        },
        oracle: { active: null, pending: [], history: [] },
      },
    });

    const injected = startup.readStartupBriefingForInjection({
      projectRoot: tempRoot,
      outputPath,
      statusPath,
      currentLanePath: path.join(tempRoot, '.squidrun', 'handoffs', 'current-lane.json'),
      nowMs: Date.parse('2026-06-09T06:05:00.000Z'),
      head: { short_sha: 'testhead5', committed_at: '2026-06-09T06:04:00.000Z', subject: 'test' },
      recentCommsRows: [],
    });
    const artifactPath = path.join(tempRoot, '.squidrun', 'handoffs', 'restart-continuity-resume.json');
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const blockPayload = extractBlockPayload(injected);

    expect(fs.existsSync(artifactPath)).toBe(true);
    expect(artifact.schema).toBe(manifest.SCHEMA);
    expect(blockPayload).toEqual(expect.objectContaining({
      schema: manifest.STARTUP_BLOCK_SCHEMA,
      status: 'ready',
      preview_only: true,
      artifact_source_ref: '.squidrun/handoffs/restart-continuity-resume.json',
    }));
    expect(blockPayload.authority.current_lane_authority).toBe('none');
    expect(blockPayload.per_arm.builder.action).toBe('auto_dispatch_candidate');
    expect(injected.indexOf('## Restart Continuity Resume')).toBeLessThan(injected.indexOf('## Live Current Lane'));
    expect(JSON.stringify(blockPayload)).not.toContain('rawBody');
    expect(JSON.stringify(blockPayload)).not.toContain('stale prose omitted');
  });
});
