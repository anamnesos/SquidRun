const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  materializeSessionHandoff,
  buildSessionHandoffMarkdown,
  removeLegacyPaneHandoffFiles,
  _internals,
} = require('../modules/main/auto-handoff-materializer');
const {
  extractCurrentLaneDirective,
} = require('../modules/main/agent-task-resolution');

describe('auto-handoff-materializer', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-auto-handoff-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('buildSessionHandoffMarkdown is deterministic and includes explicit tags + trace ids', () => {
    const rows = [
      {
        messageId: 'm1',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #1): DECISION: Use single handoff file',
        brokeredAtMs: 1000,
        metadata: { traceId: 'trc-1' },
      },
      {
        messageId: 'm2',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'failed',
        ackStatus: 'failed',
        errorCode: 'delivery_timeout',
        rawBody: '(BUILDER #1): Attempted delivery',
        brokeredAtMs: 1500,
        metadata: { traceId: 'trc-2' },
      },
    ];

    const first = buildSessionHandoffMarkdown(rows, { sessionId: 's1', nowMs: 2000 });
    const second = buildSessionHandoffMarkdown(rows, { sessionId: 's1', nowMs: 2000 });

    expect(first).toBe(second);
    expect(first).toContain('Session Handoff Index (auto-generated, deterministic)');
    expect(first).toContain('DECISION');
    expect(first).toContain('trc-1');
    expect(first).toContain('delivery_timeout');
    expect(first).toContain('## Cross-Session Decisions');
  });

  test('extractTag only matches anchored tags or known prefixed markers', () => {
    expect(_internals.extractTag('DECISION: Canonical envelope')).toEqual({
      tag: 'DECISION',
      detail: 'Canonical envelope',
    });
    expect(_internals.extractTag('(ARCHITECT #1): FINDING: Queue race fixed')).toEqual({
      tag: 'FINDING',
      detail: 'Queue race fixed',
    });
    expect(_internals.extractTag('[AGENT MSG - reply via hm-send.js] (BUILDER #4): TASK: Add tests')).toEqual({
      tag: 'TASK',
      detail: 'Add tests',
    });

    expect(_internals.extractTag('We discussed DECISION: but this is inline prose')).toBeNull();
    expect(_internals.extractTag('prefix DECISION: not anchored')).toBeNull();
    expect(_internals.extractTag('(ARCHITECT #1): NOTE: not an allowed tag')).toBeNull();
  });

  test('resolveEffectiveSessionScopeId prefers current app-session scope for legacy app bootstrap ids', () => {
    expect(_internals.resolveEffectiveSessionScopeId('app-7736-1771709282380', {
      resolveCurrentSessionScopeId: () => 'app-session-42',
    })).toBe('app-session-42');
    expect(_internals.resolveEffectiveSessionScopeId(null, {
      resolveCurrentSessionScopeId: () => 7,
    })).toBe('app-session-7');
    expect(_internals.resolveEffectiveSessionScopeId('session-current', {
      resolveCurrentSessionScopeId: () => 'app-session-99',
    })).toBe('session-current');
  });

  test('pending deliveries exclude failed rows and resolved brokered rows', () => {
    const rows = [
      {
        messageId: 'm-brokered-resolved',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #1): standby',
        brokeredAtMs: 1000,
      },
      {
        messageId: 'm-brokered-unverified',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        ackStatus: 'accepted.unverified',
        rawBody: '(ARCHITECT #2): check',
        brokeredAtMs: 1100,
      },
      {
        messageId: 'm-routed-failed',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        errorCode: 'delivery_timeout',
        rawBody: '(ARCHITECT #3): timeout',
        brokeredAtMs: 1200,
      },
      {
        messageId: 'm-recorded-pending',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'recorded',
        rawBody: '(BUILDER #1): queued',
        brokeredAtMs: 1300,
      },
    ];

    const markdown = buildSessionHandoffMarkdown(rows, {
      sessionId: 's-pending-check',
      nowMs: 2000,
    });
    const pendingSection = markdown.split('## Pending Deliveries')[1].split('## Recent Messages')[0];
    const failedSection = markdown.split('## Failed Deliveries')[1].split('## Pending Deliveries')[0];

    expect(markdown).toContain('- failed_rows: 1');
    expect(markdown).toContain('- pending_rows: 2');
    expect(pendingSection).toContain('| m-brokered-unverified |');
    expect(pendingSection).toContain('| m-recorded-pending |');
    expect(pendingSection).not.toContain('| m-brokered-resolved |');
    expect(pendingSection).not.toContain('| m-routed-failed |');
    expect(failedSection).toContain('| m-routed-failed |');
  });

  test('Pending Deliveries excludes brokered rows and tracks unresolved outbound rows only', () => {
    const rows = [
      {
        messageId: 'm-recorded',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'recorded',
        rawBody: '(ARCHITECT #1): TASK: Pending send',
        brokeredAtMs: 1000,
      },
      {
        messageId: 'm-brokered',
        senderRole: 'architect',
        targetRole: 'oracle',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #2): TASK: Delivered to broker',
        brokeredAtMs: 1100,
      },
      {
        messageId: 'm-routed',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        rawBody: '(BUILDER #1): Awaiting verification',
        brokeredAtMs: 1200,
      },
      {
        messageId: 'm-inbound-recorded',
        senderRole: 'user',
        targetRole: 'architect',
        channel: 'telegram',
        direction: 'inbound',
        status: 'recorded',
        rawBody: 'Hello',
        brokeredAtMs: 1300,
      },
    ];

    const markdown = buildSessionHandoffMarkdown(rows, { sessionId: 's-pending', nowMs: 2000 });
    const pendingSection = markdown.split('## Pending Deliveries')[1].split('## Recent Messages')[0];

    expect(markdown).toContain('- pending_rows: 2');
    expect(pendingSection).toContain('m-recorded');
    expect(pendingSection).toContain('m-routed');
    expect(pendingSection).not.toContain('m-brokered');
    expect(pendingSection).not.toContain('m-inbound-recorded');
  });

  test('later quote-back and cleanup rows close stale timeout delivery rows', () => {
    const rows = [
      {
        messageId: 'm-task-timeout',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        ackStatus: 'routed_unverified_timeout',
        errorCode: 'routed_unverified_timeout',
        rawBody: '(ARCHITECT #12): TASK: startup-health bridge probe accuracy.',
        brokeredAtMs: 1000,
      },
      {
        messageId: 'm-builder-ack',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(BUILDER #5): ACK ARCHITECT #12. Proceeding on the focused patch.',
        brokeredAtMs: 2000,
      },
      {
        messageId: 'm-builder-complete',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(BUILDER #6): ARCHITECT #12 complete. Validation passed.',
        brokeredAtMs: 3000,
      },
      {
        messageId: 'm-cancel-timeout',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        ackStatus: 'routed_unverified_timeout',
        errorCode: 'routed_unverified_timeout',
        rawBody: '(ARCHITECT #17): Cancel ARCH #15 and stop this lane now.',
        brokeredAtMs: 4000,
      },
      {
        messageId: 'm-cleanup',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(BUILDER #7): ACK ARCHITECT #17. Cleanup complete; patch reverted.',
        brokeredAtMs: 5000,
      },
    ];

    const markdown = buildSessionHandoffMarkdown(rows, {
      sessionId: 's-stale-resolver',
      nowMs: 6000,
    });
    const failedSection = markdown.split('## Failed Deliveries')[1].split('## Pending Deliveries')[0];
    const pendingSection = markdown.split('## Pending Deliveries')[1].split('## Recent Messages')[0];

    expect(markdown).toContain('- failed_rows: 0');
    expect(markdown).toContain('- pending_rows: 0');
    expect(failedSection).not.toContain('m-task-timeout');
    expect(failedSection).not.toContain('m-cancel-timeout');
    expect(pendingSection).not.toContain('m-task-timeout');
    expect(pendingSection).not.toContain('m-cancel-timeout');
  });

  test('materialization writes current lane and keeps resolved stale tasks out of live work', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const currentLanePath = path.join(tempDir, 'handoffs', 'current-lane.json');
    const rows = [
      {
        messageId: 'm-task-timeout',
        sessionId: 'app-session-336',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        ackStatus: 'routed_unverified_timeout',
        errorCode: 'routed_unverified_timeout',
        rawBody: '(ARCHITECT #12): TASK: startup-health bridge probe accuracy.',
        brokeredAtMs: 1000,
      },
      {
        messageId: 'm-builder-complete',
        sessionId: 'app-session-336',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(BUILDER #6): ARCHITECT #12 complete. Validation passed.',
        brokeredAtMs: 2000,
      },
      {
        messageId: 'm-cancel-timeout',
        sessionId: 'app-session-336',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        ackStatus: 'routed_unverified_timeout',
        errorCode: 'routed_unverified_timeout',
        rawBody: '(ARCHITECT #17): Cancel ARCH #15 and stop this lane now.',
        brokeredAtMs: 3000,
      },
      {
        messageId: 'm-cleanup',
        sessionId: 'app-session-336',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(BUILDER #7): ACK ARCHITECT #17. Cleanup complete; patch reverted.',
        brokeredAtMs: 4000,
      },
      {
        messageId: 'm-mira-lane',
        sessionId: 'app-session-336',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #25): CURRENT LANE: New Mira implementation seam. TASK: Fix startup/restart live-truth resolver and tests.',
        brokeredAtMs: 5000,
      },
    ];

    const result = await materializeSessionHandoff({
      rows,
      outputPath,
      currentLanePath,
      legacyMirrorPath: false,
      sessionId: 'app-session-336',
      queryClaims: () => ({ ok: true, claims: [] }),
      nowMs: 6000,
    });

    expect(result.ok).toBe(true);
    expect(result.currentLane).toEqual(expect.objectContaining({
      status: 'active',
      activeLane: expect.objectContaining({
        objective: expect.stringContaining('New Mira'),
        sourceMessageId: 'm-mira-lane',
      }),
      resolvedOrSupersededCount: 1,
    }));

    const handoff = fs.readFileSync(outputPath, 'utf8');
    const currentLane = JSON.parse(fs.readFileSync(currentLanePath, 'utf8'));
    expect(currentLane.activeLane.objective).toContain('New Mira');
    expect(handoff).toContain('- failed_rows: 0');
    expect(handoff).toContain('- pending_rows: 0');
    expect(handoff.indexOf('## Current Lane (machine-readable)')).toBeLessThan(handoff.indexOf('## Failed Deliveries'));
    expect(handoff).toContain('"sourceMessageId": "m-mira-lane"');
  });

  test('current-session task materializes as current lane and current lane syntax still extracts', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const currentLanePath = path.join(tempDir, 'handoffs', 'current-lane.json');
    const currentSessionTaskBody = '(ARCHITECT #22): CURRENT-SESSION TASK: restart gate for committed Mira/startup package d414bfa';
    const currentLaneBody = '(ARCHITECT #23): CURRENT LANE: verify restart continuity';

    expect(extractCurrentLaneDirective(currentSessionTaskBody)).toEqual(expect.objectContaining({
      kind: 'current_session_task',
      objective: 'restart gate for committed Mira/startup package d414bfa',
    }));
    expect(extractCurrentLaneDirective(currentLaneBody)).toEqual(expect.objectContaining({
      kind: 'current_lane',
      objective: 'verify restart continuity',
    }));

    const rows = [
      {
        messageId: 'm-current-session-task',
        sessionId: 'app-session-338',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: currentSessionTaskBody,
        brokeredAtMs: 1000,
      },
    ];

    const result = await materializeSessionHandoff({
      rows,
      outputPath,
      currentLanePath,
      legacyMirrorPath: false,
      sessionId: 'app-session-338',
      queryClaims: () => ({ ok: true, claims: [] }),
      nowMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(result.currentLane).toEqual(expect.objectContaining({
      status: 'active',
      activeLane: expect.objectContaining({
        kind: 'current_session_task',
        objective: 'restart gate for committed Mira/startup package d414bfa',
        sourceMessageId: 'm-current-session-task',
        sourceRef: 'architect#22',
      }),
    }));

    const currentLane = JSON.parse(fs.readFileSync(currentLanePath, 'utf8'));
    expect(currentLane.activeLane.objective).toBe('restart gate for committed Mira/startup package d414bfa');
  });

  test('restart-continuity objective materializes current lane with completed-fix and stale-backlog context', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const currentLanePath = path.join(tempDir, 'handoffs', 'current-lane.json');
    const restartLaneBody = '(ARCH #84): New lane from James: go ahead on restart continuity, think it through while doing it. Builder-owned implementation after orientation. Plain-language objective: after restart, James should not have to re-explain what we were doing; startup/session handoff should surface recent completed fixes, active lane, next action, and stale/backlog markers without treating old prose as live blockers. Hold edits until Oracle gives read-only seam orientation.';

    expect(extractCurrentLaneDirective(restartLaneBody)).toEqual(expect.objectContaining({
      kind: 'james_plain_language_objective',
      objective: 'after restart, James should not have to re-explain what we were doing; startup/session handoff should surface recent completed fixes, active lane, next action, and stale/backlog markers without treating old prose as live blockers.',
    }));

    const rows = [
      {
        messageId: 'm-finished-user-summary',
        sessionId: 'app-session-374',
        senderRole: 'architect',
        targetRole: 'user',
        channel: 'telegram',
        direction: 'outbound',
        status: 'acked',
        rawBody: 'No, nothing new is running right now. Earlier we finished two fixes: stopping duplicate Telegram replies after accidental short messages, and clearing the false pending delivery state.',
        brokeredAtMs: 1000,
      },
      {
        messageId: 'm-delivery-closed',
        sessionId: 'app-session-374',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        rawBody: '(ARCH #82): Delivery-state truth lane closed. Good restraint on the no-replay guard.',
        brokeredAtMs: 1200,
      },
      {
        messageId: 'm-old-uncertain',
        sessionId: 'app-session-374',
        senderRole: 'oracle',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        ackStatus: 'routed_unverified_timeout',
        rawBody: '(ORACLE #12): Historical delivery uncertainty row.',
        brokeredAtMs: 1300,
      },
      {
        messageId: 'm-recorded-backlog',
        sessionId: 'app-session-374',
        senderRole: 'mira',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'recorded',
        rawBody: '(MIRA CURIOSITY BURST): unchanged no-op candidate.',
        brokeredAtMs: 1400,
      },
      {
        messageId: 'm-restart-lane',
        sessionId: 'app-session-374',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        rawBody: restartLaneBody,
        brokeredAtMs: 2000,
      },
      {
        messageId: 'm-oracle-orientation',
        sessionId: 'app-session-374',
        senderRole: 'oracle',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        rawBody: '(ORACLE #37): Final read-only orientation for restart continuity. This is review criteria only: closed/review/read-only language should not outrank the actual lane.',
        brokeredAtMs: 2200,
      },
      {
        messageId: 'm-review-criteria',
        sessionId: 'app-session-374',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'routed',
        rawBody: '(ARCH #88): Oracle #37 final orientation accepted as review criteria. Builder, continue bounded patch in current dirty scope only.',
        brokeredAtMs: 2400,
      },
    ];

    const result = await materializeSessionHandoff({
      rows,
      outputPath,
      currentLanePath,
      legacyMirrorPath: false,
      sessionId: 'app-session-374',
      queryClaims: () => ({ ok: true, claims: [] }),
      nowMs: 3000,
    });

    expect(result.ok).toBe(true);
    expect(result.currentLane).toEqual(expect.objectContaining({
      status: 'active',
      activeLane: expect.objectContaining({
        kind: 'james_plain_language_objective',
        objective: expect.stringContaining('James should not have to re-explain'),
        sourceMessageId: 'm-restart-lane',
        sourceRef: 'architect#84',
      }),
      continuity: expect.objectContaining({
        next_action: expect.stringContaining('Continue active lane'),
        recent_completed_fixes: expect.arrayContaining([
          expect.objectContaining({
            summary: expect.stringContaining('finished two fixes'),
          }),
        ]),
        stale_backlog_markers: expect.arrayContaining([
          expect.stringContaining('delivery-uncertain comms row'),
          expect.stringContaining('recorded outbound row'),
        ]),
      }),
    }));

    const handoff = fs.readFileSync(outputPath, 'utf8');
    const currentLane = JSON.parse(fs.readFileSync(currentLanePath, 'utf8'));
    expect(currentLane.status).toBe('active');
    expect(currentLane.activeLane.sourceMessageId).toBe('m-restart-lane');
    expect(currentLane.activeLane.objective).not.toMatch(/read-only|review criteria|closed/i);
    expect(handoff).toContain('## Restart Continuity Summary');
    expect(handoff).toContain('treat these as restart context, not live blockers');
    expect(handoff).toContain('finished two fixes');
    expect(handoff).toContain('delivery-uncertain comms row');
    expect(currentLane.activeLane.objective).not.toContain('Hold edits until Oracle');
  });

  test('natural current-lane Mira priority supersedes stale unclosed startup task', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const defaultCurrentLanePath = path.join(tempDir, 'handoffs', 'current-lane.json');
    const rows = [
      {
        messageId: 'm-arch-8',
        sessionId: 'app-session-336',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #8): TASK: Oracle delivery path + startup residual triage.\n\nOBJECTIVE: determine why Oracle checked in but did not quote back ARCH #6/#7, and give the smallest safe fix/next action for startup degraded health.',
        brokeredAtMs: 1000,
      },
      {
        messageId: 'm-arch-31',
        sessionId: 'app-session-336',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #31): New user-facing priority: Mira panel is showing fallback text like "Mira reply from local durable context... no sends, writes, tools, audio, live-model claim, or delivery proof" instead of an attached live model. Treat as current lane over stale startup cleanup if you need to sequence. Investigate the model attachment/config path for the Mira panel.',
        brokeredAtMs: 3000,
      },
      {
        messageId: 'm-arch-33',
        sessionId: 'app-session-336',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #33): Oracle found root cause for Mira panel fallback. OpenAI key exists, but typed Mira live text is disabled because SQUIDRUN_MIRA_TEXT_MODEL_ENABLED is missing/off. Relevant path: mira-local-text -> mira:local-text-session -> mira-local-text-ui-surface -> build local v0 then optional text-model-attachment-v1. Please make this current-lane implementation: expose/bridge the attachment state so the panel is not ambiguous, enable or document the env path cleanly, and verify one safe in-panel model reply reports source=mira_text_model_attachment_v1 with model_call_count=1/network_count=1/tools-sends-writes=0.',
        brokeredAtMs: 4000,
      },
      {
        messageId: 'm-builder-9',
        sessionId: 'app-session-336',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(BUILDER #9): FINDINGS: Mira text had key present but SQUIDRUN_MIRA_TEXT_MODEL_ENABLED missing/off. FIX: panel fails closed and exposes attachment state. VALIDATION: focused suites pass.',
        brokeredAtMs: 5000,
      },
      {
        messageId: 'm-builder-11',
        sessionId: 'app-session-336',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(BUILDER #11): FIX\n- Patched `ui/modules/main/agent-task-resolution.js` so natural current-priority language is authoritative: `New user-facing priority: ...`, `Treat as current lane ...`, and `Please make this current-lane implementation: ...` now outrank stale unclosed TASK lanes.\n\nVALIDATION\n- real app-session-336 smoke selected architect#33.',
        brokeredAtMs: 5500,
      },
    ];

    const result = await materializeSessionHandoff({
      rows,
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'app-session-336',
      queryClaims: () => ({ ok: true, claims: [] }),
      nowMs: 6500,
    });

    expect(result.ok).toBe(true);
    expect(result.currentLane.activeLane).toEqual(expect.objectContaining({
      objective: expect.stringContaining('Mira panel model attachment'),
      sourceMessageId: 'm-arch-33',
      sourceRef: 'architect#33',
    }));
    expect(result.currentLane.activeLane.objective).not.toContain('Oracle delivery path');

    expect(fs.existsSync(defaultCurrentLanePath)).toBe(true);
    const currentLane = JSON.parse(fs.readFileSync(defaultCurrentLanePath, 'utf8'));
    expect(currentLane.activeLane.sourceMessageId).toBe('m-arch-33');
    expect(currentLane.activeLane.objective).toContain('Mira panel model attachment');

    const handoff = fs.readFileSync(outputPath, 'utf8');
    expect(handoff).toContain('"sourceMessageId": "m-arch-33"');
    expect(handoff).not.toContain('"sourceMessageId": "m-arch-8"');
    expect(handoff).not.toContain('"sourceMessageId": "m-builder-11"');
  });

  test('role-addressed casual tasking materializes a live current lane', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const currentLanePath = path.join(tempDir, 'handoffs', 'current-lane.json');
    const rows = [
      {
        messageId: 'm-arch-65',
        sessionId: 'app-session-337',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCH #65): User requested full mess/unfinished sweep across comms/history/worktree. Builder task: do a package/source audit, not a feature expansion. Inspect staged vs unstaged changes, missing docs/tests, Lab registration boundaries, typed-panel reload-smoke readiness, startup-health parked work, memory drift status, and any obvious broken workflow.',
        brokeredAtMs: 1000,
      },
      {
        messageId: 'm-builder-41',
        sessionId: 'app-session-337',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(BUILDER #41): ACK ARCH #65. I am auditing package state now.',
        brokeredAtMs: 1500,
      },
      {
        messageId: 'm-arch-69',
        sessionId: 'app-session-337',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCH #69): Additional audit item for ARCH #65/#66. Builder: classify/fix if obvious in agent-task-resolution/materializer scope; otherwise list as unresolved workflow risk.',
        brokeredAtMs: 2000,
      },
      {
        messageId: 'm-arch-71-status-check',
        sessionId: 'app-session-337',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCH #71): Builder status check on ARCH #65/#67/#69. Need concise delta: package/staging audit result, memory repair status/post-check, stale startup-health reference status, current-lane materialization/fix status, tests/diff check running or done, and any remaining blocker.',
        brokeredAtMs: 2500,
      },
      {
        messageId: 'm-builder-44-status-delta',
        sessionId: 'app-session-337',
        senderRole: 'builder',
        targetRole: 'architect',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(BUILDER #44): Current exact state for ARCH #65/#67/#69/#72: memory backup/repair/post-check completed. Source fixes completed but not yet final-tested. Tests/diff after these latest fixes have not run yet.',
        brokeredAtMs: 3000,
      },
      {
        messageId: 'm-arch-66',
        sessionId: 'app-session-337',
        senderRole: 'architect',
        targetRole: 'oracle',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCH #66): User requested full mess/unfinished sweep across comms/history/worktree. Oracle task: independent read-only reconciliation. Review current-session comms/history, handoff index, worktree/staged state, tests/gates already run, startup-health parked task, and memory drift.',
        brokeredAtMs: 3500,
      },
    ];

    const result = await materializeSessionHandoff({
      rows,
      outputPath,
      currentLanePath,
      legacyMirrorPath: false,
      sessionId: 'app-session-337',
      queryClaims: () => ({ ok: true, claims: [] }),
      nowMs: 3000,
    });

    expect(result.ok).toBe(true);
    expect(result.currentLane).toEqual(expect.objectContaining({
      status: 'active',
      activeLane: expect.objectContaining({
        kind: 'role_task',
        objective: 'do a package/source audit, not a feature expansion.',
        sourceMessageId: 'm-arch-65',
        sourceRef: 'architect#65',
      }),
    }));

    const currentLane = JSON.parse(fs.readFileSync(currentLanePath, 'utf8'));
    expect(currentLane.status).toBe('active');
    expect(currentLane.activeLane.objective).toContain('package/source audit');
    expect(currentLane.activeLane.sourceMessageId).toBe('m-arch-65');
  });

  test('materializeSessionHandoff writes once and skips rewrite when unchanged', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const rows = [
      {
        messageId: 'm1',
        senderRole: 'architect',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'outbound',
        status: 'brokered',
        rawBody: '(ARCHITECT #1): TASK: Implement phase 3',
        brokeredAtMs: 1000,
        metadata: { traceId: 'trc-1' },
      },
    ];

    const first = await materializeSessionHandoff({
      rows,
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-a',
      nowMs: 5000,
    });
    const second = await materializeSessionHandoff({
      rows,
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-a',
      nowMs: 5000,
    });

    expect(first.ok).toBe(true);
    expect(first.written).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.written).toBe(false);
    expect(fs.existsSync(outputPath)).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf8');
    expect(content).toContain('TASK');
  });

  test('materializeSessionHandoff reuses the last meaningful session and preserves the prior handoff copy', async () => {
    const handoffsDir = path.join(tempDir, 'handoffs');
    const outputPath = path.join(handoffsDir, 'session.md');
    const backupPath = path.join(handoffsDir, 'last-session.md');
    fs.mkdirSync(handoffsDir, { recursive: true });
    fs.writeFileSync(outputPath, '# Old Handoff\n\nPrevious content.\n', 'utf8');

    const result = await materializeSessionHandoff({
      sessionId: 'app-session-257',
      outputPath,
      legacyMirrorPath: false,
      enableSessionHistory: true,
      rows: [
        {
          messageId: 'm-current-1',
          sessionId: 'app-session-257',
          senderRole: 'builder',
          targetRole: 'architect',
          channel: 'ws',
          direction: 'outbound',
          status: 'brokered',
          rawBody: '(BUILDER #1): Builder online. Standing by.',
          brokeredAtMs: 4000,
        },
      ],
      crossSessionRows: [
        {
          messageId: 'm-prior-1',
          sessionId: 'app-session-256',
          senderRole: 'architect',
          targetRole: 'builder',
          channel: 'ws',
          direction: 'outbound',
          status: 'brokered',
          rawBody: '(ARCHITECT #9): TASK: Fix session continuity capture',
          brokeredAtMs: 3000,
        },
      ],
      querySessionSnapshot: () => ({
        session: 256,
        sessionSummary: {
          sessionNumber: 256,
          createdAtMs: 3500,
          summaryMarkdown: '# Session 256 Summary\n\n## Findings\n- Session-end snapshot captured.\n',
        },
      }),
      querySessionSummariesFromMemory: () => [],
      readFallbackSummary: () => null,
      queryClaims: () => ({ ok: true, claims: [] }),
      nowMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.written).toBe(true);
    expect(result.usedFallbackSession).toBe(true);
    expect(result.sourceSessionId).toBe('app-session-257');
    expect(result.fallbackSourceSessionId).toBe('app-session-256');
    const handoff = fs.readFileSync(outputPath, 'utf8');
    expect(handoff).toContain('- session_id: app-session-257');
    expect(handoff).toContain('## Prior Context (session 256, age 1 session)');
    expect(handoff).toContain('TASK: Fix session continuity capture');
    expect(handoff).toContain('## Prior Session Summaries');
    expect(handoff).toContain('Session-end snapshot captured.');
    expect(fs.readFileSync(backupPath, 'utf8')).toContain('Previous content.');
  });

  test('materializeSessionHandoff does not overwrite session.md when no meaningful content exists', async () => {
    const handoffsDir = path.join(tempDir, 'handoffs');
    const outputPath = path.join(handoffsDir, 'session.md');
    fs.mkdirSync(handoffsDir, { recursive: true });
    fs.writeFileSync(outputPath, '# Preserved Handoff\n\nKeep me.\n', 'utf8');

    const result = await materializeSessionHandoff({
      sessionId: 'app-session-300',
      outputPath,
      legacyMirrorPath: false,
      rows: [
        {
          messageId: 'm-current-1',
          sessionId: 'app-session-300',
          senderRole: 'architect',
          targetRole: 'builder',
          channel: 'ws',
          direction: 'outbound',
          status: 'brokered',
          rawBody: '(ARCHITECT #1): Copy. Clean session, no pending work. Stand by for tasking.',
          brokeredAtMs: 1000,
        },
      ],
      crossSessionRows: [],
      queryClaims: () => ({ ok: true, claims: [] }),
      nowMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(result.written).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_meaningful_content');
    expect(fs.readFileSync(outputPath, 'utf8')).toContain('Keep me.');
  });

  test('materializeSessionHandoff includes concise unresolved claims section', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const longStatement = 'A very long contested claim statement '.repeat(6);
    const proposedClaims = Array.from({ length: 12 }, (_, index) => ({
      id: `clm_proposed_${String(index).padStart(2, '0')}`,
      status: 'proposed',
      statement: `Proposed claim #${index}`,
      confidence: 0.4 + (index * 0.01),
    }));
    proposedClaims.push({
      id: 'clm_noise',
      status: 'proposed',
      statement: 'delivered.verified',
      confidence: 0.99,
    });
    proposedClaims.push({
      id: 'clm_noise_init',
      status: 'proposed',
      statement: 'Initializing session app-session-900',
      confidence: 0.95,
    });
    proposedClaims.push({
      id: 'clm_noise_start',
      status: 'proposed',
      statement: 'Session started for app-session-900',
      confidence: 0.94,
    });

    const result = await materializeSessionHandoff({
      rows: [],
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-claims',
      nowMs: 6000,
      queryClaims: ({ status }) => {
        if (status === 'contested') {
          return {
            ok: true,
            claims: [{
              id: 'clm_contested',
              status: 'contested',
              statement: longStatement,
              confidence: 0.91,
            }],
          };
        }
        if (status === 'pending_proof') {
          return {
            ok: true,
            claims: [{
              id: 'clm_pending',
              status: 'pending_proof',
              statement: 'Pending proof claim',
              confidence: 0.73,
            }],
          };
        }
        return { ok: true, claims: proposedClaims };
      },
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf8');
    expect(content).toContain('## Unresolved Claims');
    expect(content).toContain('| clm_contested | contested |');
    expect(content).toContain('| clm_pending | pending_proof |');
    expect(content).not.toContain('clm_noise');
    expect(content).not.toContain('clm_noise_init');
    expect(content).not.toContain('clm_noise_start');
    expect(content).not.toContain('delivered.verified');
    expect(content).not.toContain('Initializing session');
    expect(content).not.toContain('Session started');

    const unresolvedRows = content
      .split('\n')
      .filter((line) => line.startsWith('| clm_'));
    expect(unresolvedRows.length).toBe(10);

    const contestedRow = unresolvedRows.find((line) => line.includes('| clm_contested |'));
    expect(contestedRow).toBeDefined();
    expect(contestedRow).toContain('...');
  });

  test('materializeSessionHandoff overfetches unresolved claims before final noise filtering', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session-overfetch-claims.md');
    const queryCalls = [];
    const noisyProposedClaims = Array.from({ length: 10 }, (_, index) => ({
      id: `clm_noise_init_${index}`,
      status: 'proposed',
      statement: 'Initializing session...',
      confidence: 1,
    }));
    const meaningfulProposedClaims = [
      {
        id: 'clm_offline',
        status: 'proposed',
        statement: 'Offline',
        confidence: 1,
      },
      {
        id: 'clm_later_real_1',
        status: 'proposed',
        statement: 'Later proposed claim one',
        confidence: 0.9,
      },
      {
        id: 'clm_later_real_2',
        status: 'proposed',
        statement: 'Later proposed claim two',
        confidence: 0.8,
      },
    ];

    const result = await materializeSessionHandoff({
      rows: [],
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-overfetch-claims',
      nowMs: 6250,
      unresolvedClaimsMax: 3,
      queryClaims: ({ status, limit }) => {
        queryCalls.push({ status, limit });
        if (status === 'contested') {
          return {
            ok: true,
            claims: [{
              id: 'clm_contested_priority',
              status: 'contested',
              statement: 'Contested priority claim',
              confidence: 0.1,
            }],
          };
        }
        if (status === 'pending_proof') {
          return {
            ok: true,
            claims: [{
              id: 'clm_pending_priority',
              status: 'pending_proof',
              statement: 'Pending priority claim',
              confidence: 0.2,
            }],
          };
        }
        if (limit <= 10) {
          return { ok: true, claims: noisyProposedClaims };
        }
        return { ok: true, claims: [...noisyProposedClaims, ...meaningfulProposedClaims] };
      },
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf8');
    expect(content).toContain('## Unresolved Claims');
    expect(content).toContain('| clm_offline | proposed | Offline |');
    expect(content).not.toContain('Initializing session');
    const unresolvedRows = content
      .split('\n')
      .filter((line) => line.startsWith('| clm_'));
    expect(unresolvedRows).toHaveLength(3);
    expect(unresolvedRows[0]).toContain('| clm_contested_priority | contested |');
    expect(unresolvedRows[1]).toContain('| clm_pending_priority | pending_proof |');
    expect(unresolvedRows[2]).toContain('| clm_offline | proposed | Offline |');

    const proposedLimits = queryCalls
      .filter((call) => call.status === 'proposed')
      .map((call) => call.limit);
    expect(proposedLimits).toEqual([10, 20]);
  });

  test('materializeSessionHandoff suppresses only exact memory repair backfill claim noise', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session-memory-repair-filter.md');

    const result = await materializeSessionHandoff({
      rows: [],
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-memory-repair-filter',
      nowMs: 6500,
      queryClaims: ({ status }) => {
        if (status !== 'proposed') return { ok: true, claims: [] };
        return {
          ok: true,
          claims: [
            {
              id: 'clm_memory_repair_noise',
              idempotencyKey: 'backfill:memory.consistency.repair:evt-1',
              status: 'proposed',
              statement: 'memory.consistency.repair',
              confidence: 1,
            },
            {
              id: 'clm_same_statement_not_backfill',
              idempotencyKey: 'manual:memory.consistency.repair:evt-2',
              status: 'proposed',
              statement: 'memory.consistency.repair',
              confidence: 0.99,
            },
            {
              id: 'clm_same_prefix_different_statement',
              idempotencyKey: 'backfill:memory.consistency.repair:evt-3',
              status: 'proposed',
              statement: 'Memory consistency repair needs review',
              confidence: 0.98,
            },
            {
              id: 'clm_regular',
              status: 'proposed',
              statement: 'Regular proposed claim',
              confidence: 0.5,
            },
          ],
        };
      },
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf8');
    expect(content).toContain('## Unresolved Claims');
    expect(content).not.toContain('clm_memory_repair_noise');
    expect(content).toContain('| clm_same_statement_not_backfill | proposed | memory.consistency.repair |');
    expect(content).toContain('| clm_same_prefix_different_statement | proposed | Memory consistency repair needs review |');
    expect(content).toContain('| clm_regular | proposed | Regular proposed claim |');
  });

  test('materializeSessionHandoff suppresses only exact Offline intent telemetry claim noise', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session-offline-intent-filter.md');

    const result = await materializeSessionHandoff({
      rows: [],
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-offline-intent-filter',
      nowMs: 6600,
      queryClaims: ({ status }) => {
        if (status !== 'proposed') return { ok: true, claims: [] };
        return {
          ok: true,
          claims: [
            {
              id: 'clm_offline_intent_noise_camel',
              idempotencyKey: 'backfill:intent.updated:evt-1',
              status: 'proposed',
              statement: 'Offline',
              confidence: 1,
            },
            {
              id: 'clm_offline_intent_noise_snake',
              idempotency_key: 'backfill:intent.updated:evt-2',
              status: 'proposed',
              statement: 'Offline',
              confidence: 1,
            },
            {
              id: 'clm_same_statement_not_backfill',
              idempotencyKey: 'manual:intent.updated:evt-3',
              status: 'proposed',
              statement: 'Offline',
              confidence: 0.99,
            },
            {
              id: 'clm_same_prefix_different_statement',
              idempotencyKey: 'backfill:intent.updated:evt-4',
              status: 'proposed',
              statement: 'Offline remediation follow-up',
              confidence: 0.98,
            },
            {
              id: 'clm_regular',
              status: 'proposed',
              statement: 'Regular proposed claim',
              confidence: 0.5,
            },
          ],
        };
      },
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf8');
    expect(content).toContain('## Unresolved Claims');
    expect(content).not.toContain('clm_offline_intent_noise_camel');
    expect(content).not.toContain('clm_offline_intent_noise_snake');
    expect(content).toContain('| clm_same_statement_not_backfill | proposed | Offline |');
    expect(content).toContain('| clm_same_prefix_different_statement | proposed | Offline remediation follow-up |');
    expect(content).toContain('| clm_regular | proposed | Regular proposed claim |');
  });

  test('materializeSessionHandoff carries cross-session tagged decisions/tasks/findings/blockers', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const queryCalls = [];
    const result = await materializeSessionHandoff({
      sessionId: 'session-current',
      outputPath,
      legacyMirrorPath: false,
      nowMs: 10_000,
      queryCommsJournal: (filters = {}) => {
        queryCalls.push(filters);
        if (filters.sessionId === 'session-current') {
          return [
            {
              messageId: 'm-current',
              sessionId: 'session-current',
              senderRole: 'architect',
              targetRole: 'builder',
              channel: 'ws',
              direction: 'outbound',
              status: 'brokered',
              rawBody: '(ARCHITECT #9): TASK: Current session implementation',
              brokeredAtMs: 3000,
            },
          ];
        }
        return [
          {
            messageId: 'm-old-1',
            sessionId: 'session-old-1',
            senderRole: 'architect',
            targetRole: 'builder',
            channel: 'ws',
            direction: 'outbound',
            status: 'brokered',
            rawBody: '(ARCHITECT #2): DECISION: Keep coordinator deterministic',
            brokeredAtMs: 1000,
          },
          {
            messageId: 'm-old-2',
            sessionId: 'session-old-2',
            senderRole: 'oracle',
            targetRole: 'architect',
            channel: 'ws',
            direction: 'outbound',
            status: 'brokered',
            rawBody: '(ORACLE #3): FINDING: Trigger delivery had no loss',
            brokeredAtMs: 2000,
          },
          {
            messageId: 'm-old-3',
            sessionId: 'session-old-2',
            senderRole: 'architect',
            targetRole: 'builder',
            channel: 'ws',
            direction: 'outbound',
            status: 'brokered',
            rawBody: '(ARCHITECT #4): ACTION: This should not be in cross-session carry',
            brokeredAtMs: 2100,
          },
        ];
      },
      queryClaims: () => ({ ok: true, claims: [] }),
    });

    expect(result.ok).toBe(true);
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0].sessionId).toBe('session-current');
    expect(queryCalls[1].sessionId).toBeUndefined();

    const content = fs.readFileSync(outputPath, 'utf8');
    const digestSection = content
      .split('## Decision Digest')[1]
      .split('## Cross-Session Decisions')[0];
    const crossSessionSection = content
      .split('## Cross-Session Decisions')[1]
      .split('## Tagged Signals')[0];

    expect(digestSection).toContain('| session-old-1 |');
    expect(digestSection).toContain('| session-old-2 |');
    expect(digestSection).toContain('DECISION: Keep coordinator deterministic');
    expect(digestSection).toContain('FINDING: Trigger delivery had no loss');
    expect(digestSection).not.toContain('ACTION');

    expect(crossSessionSection).toContain('| session-old-1 | DECISION |');
    expect(crossSessionSection).toContain('| session-old-2 | FINDING |');
    expect(crossSessionSection).not.toContain('ACTION');
  });

  test('Decision Digest is grouped by session and capped to last 10 sessions', async () => {
    const outputPath = path.join(tempDir, 'handoffs', 'session.md');
    const crossRows = Array.from({ length: 12 }, (_, index) => ({
      messageId: `m-${index}`,
      sessionId: `session-${index}`,
      senderRole: 'architect',
      targetRole: 'builder',
      channel: 'ws',
      direction: 'outbound',
      status: 'brokered',
      rawBody: `(ARCHITECT #${index + 1}): DECISION: Decision ${index}`,
      brokeredAtMs: 1000 + index,
    }));
    crossRows.push({
      messageId: 'm-task-ignore',
      sessionId: 'session-11',
      senderRole: 'builder',
      targetRole: 'architect',
      channel: 'ws',
      direction: 'outbound',
      status: 'brokered',
      rawBody: '(BUILDER #77): TASK: Should not appear in digest highlights',
      brokeredAtMs: 3000,
    });

    const result = await materializeSessionHandoff({
      rows: [],
      crossSessionRows: crossRows,
      queryClaims: () => ({ ok: true, claims: [] }),
      outputPath,
      legacyMirrorPath: false,
      sessionId: 'session-current',
      nowMs: 10_000,
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf8');
    const digestSection = content
      .split('## Decision Digest')[1]
      .split('## Cross-Session Decisions')[0];

    const sessionRows = digestSection
      .split('\n')
      .filter((line) => line.startsWith('| session-'));

    expect(sessionRows.length).toBe(10);
    expect(digestSection).toContain('| session-11 |');
    expect(digestSection).toContain('| session-2 |');
    expect(digestSection).not.toContain('| session-1 |');
    expect(digestSection).not.toContain('| session-0 |');
    expect(digestSection).not.toContain('TASK: Should not appear in digest highlights');
  });

  test('materializeSessionHandoff excludes Eunbyeol side-profile rows from main and keeps them available to that window', async () => {
    const mainOutputPath = path.join(tempDir, 'handoffs', 'main-session.md');
    const emptyMainOutputPath = path.join(tempDir, 'handoffs', 'empty-main-session.md');
    const eunbyeolOutputPath = path.join(tempDir, 'handoffs-eunbyeol', 'session.md');
    const mainRow = {
      messageId: 'm-main-task',
      sessionId: 'app-session-329',
      senderRole: 'architect',
      targetRole: 'builder',
      channel: 'ws',
      direction: 'outbound',
      status: 'brokered',
      rawBody: '(ARCHITECT #1): TASK: Main runtime guard',
      brokeredAtMs: 2000,
      metadata: { windowKey: 'main', profile: 'main' },
    };
    const eunbyeolRow = {
      messageId: 'm-eunbyeol-task',
      sessionId: 'app-session-329:eunbyeol',
      senderRole: 'user',
      targetRole: 'architect',
      channel: 'telegram',
      direction: 'inbound',
      status: 'brokered',
      rawBody: '(USER #1): TASK: 한국어 Eunbyeol case message',
      brokeredAtMs: 1000,
      metadata: {
        chatId: '8754356993',
        windowKey: 'eunbyeol',
        profile: 'eunbyeol',
        sessionScopeId: 'app-session-329:eunbyeol',
      },
    };

    const main = await materializeSessionHandoff({
      rows: [mainRow, eunbyeolRow],
      crossSessionRows: [mainRow, eunbyeolRow],
      outputPath: mainOutputPath,
      legacyMirrorPath: false,
      sessionId: 'app-session-329',
      queryClaims: () => ({ ok: true, claims: [] }),
      nowMs: 3000,
    });
    const emptyMain = await materializeSessionHandoff({
      rows: [],
      crossSessionRows: [eunbyeolRow],
      outputPath: emptyMainOutputPath,
      legacyMirrorPath: false,
      sessionId: 'app-session-329',
      queryClaims: () => ({ ok: true, claims: [] }),
      nowMs: 3000,
    });
    const eunbyeol = await materializeSessionHandoff({
      rows: [mainRow, eunbyeolRow],
      crossSessionRows: [mainRow, eunbyeolRow],
      outputPath: eunbyeolOutputPath,
      legacyMirrorPath: false,
      sessionId: 'app-session-329',
      windowKey: 'eunbyeol',
      queryClaims: () => ({ ok: true, claims: [] }),
      nowMs: 3000,
    });

    expect(main.ok).toBe(true);
    const mainContent = fs.readFileSync(mainOutputPath, 'utf8');
    expect(mainContent).toContain('Main runtime guard');
    expect(mainContent).not.toContain('Eunbyeol case message');
    expect(mainContent).not.toContain('m-eunbyeol-task');

    expect(emptyMain.ok).toBe(true);
    expect(emptyMain.skipped).toBe(true);
    expect(emptyMain.reason).toBe('no_meaningful_content');
    expect(fs.existsSync(emptyMainOutputPath)).toBe(false);

    expect(eunbyeol.ok).toBe(true);
    const eunbyeolContent = fs.readFileSync(eunbyeolOutputPath, 'utf8');
    expect(eunbyeolContent).toContain('Eunbyeol case message');
    expect(eunbyeolContent).not.toContain('Main runtime guard');
  });

  test('removeLegacyPaneHandoffFiles deletes legacy files', () => {
    const handoffsDir = path.join(tempDir, 'handoffs');
    fs.mkdirSync(handoffsDir, { recursive: true });
    fs.writeFileSync(path.join(handoffsDir, '1.md'), 'a', 'utf8');
    fs.writeFileSync(path.join(handoffsDir, '2.md'), 'b', 'utf8');
    fs.writeFileSync(path.join(handoffsDir, '3.md'), 'c', 'utf8');

    const result = removeLegacyPaneHandoffFiles({
      roots: [handoffsDir],
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toHaveLength(3);
    expect(fs.existsSync(path.join(handoffsDir, '1.md'))).toBe(false);
    expect(fs.existsSync(path.join(handoffsDir, '2.md'))).toBe(false);
    expect(fs.existsSync(path.join(handoffsDir, '3.md'))).toBe(false);
  });
});
