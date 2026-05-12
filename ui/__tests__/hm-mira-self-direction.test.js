'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const driver = require('../scripts/hm-mira-self-direction');
const {
  MIRA_CURIOSITY_ITEM_SCHEMA,
  curiosityBurstsPath,
  curiosityItemsPath,
  miraDirectRoutesPath,
  readOnlyCodeModeRunsPath,
  replyAuditPath,
  selfDirectionOutcomePath,
  selfDirectionReviewAuditPath,
  selfDirectionQueuePath,
} = require('../modules/mira-lab-surface');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hm-mira-self-direction-'));
}

function appendJsonl(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('hm-mira-self-direction CLI harness', () => {
  test('create/list/review loop uses deterministic Mira fixture and applies nothing', async () => {
    const projectRoot = tempProject();

    const create = await driver.run([
      'create',
      '--fixture',
      '--session-id', 'cli-self-direction',
      '--project-root', projectRoot,
      '--json',
    ]);
    expect(create.result.decision).toBe('staged');
    expect(create.result.generation.source).toBe('proxy_mira_origin_payload');
    expect(create.result.applied).toBe(false);
    expect(create.result.consequence_controls.external_send_performed).toBe(false);
    expect(create.result.consequence_controls.autonomous_apply_performed).toBe(false);

    const list = await driver.run([
      'list',
      '--project-root', projectRoot,
      '--json',
    ]);
    expect(list.result.count).toBe(1);
    expect(list.result.proposals[0].proposal_id).toBe(create.result.proposal_id);

    const review = await driver.run([
      'review',
      '--proposal-id', create.result.proposal_id,
      '--action', 'routed',
      '--route', 'builder,oracle',
      '--note', 'route internally',
      '--project-root', projectRoot,
      '--no-dispatch',
      '--json',
    ]);
    expect(review.result.decision).toBe('routed');
    expect(review.result.applied).toBe(false);
    expect(review.result.external_send_performed).toBe(false);
    expect(review.result.proposal.route_targets).toEqual(['builder', 'oracle']);

    const pending = await driver.run(['list', '--project-root', projectRoot, '--json']);
    expect(pending.result.count).toBe(0);
    const all = await driver.run(['list', '--status', 'all', '--project-root', projectRoot, '--json']);
    expect(all.result.count).toBe(1);
    expect(all.result.proposals[0].review_status).toBe('routed');
  });

  test('stdin create stages caller-provided Mira proposal JSON without James permission step', async () => {
    const projectRoot = tempProject();
    const proposal = {
      voice_text: 'I want to catch the moment I start flattering instead of disagreeing.',
      target_areas: ['friction', 'tests'],
      desired_change: 'Add one review item when a Mira reply agrees without evidence under pressure.',
      proposed_experiment: 'Run three pressure prompts and route any agreement-without-evidence item to Architect.',
      success_metric: 'The review item can be accepted or rejected internally without asking James.',
    };

    const result = await driver.run([
      'create',
      '--stdin',
      '--project-root', projectRoot,
      '--json',
    ], {
      readStdin: () => JSON.stringify(proposal),
    });

    expect(result.result.decision).toBe('staged');
    expect(result.result.proposal.voice_text).toBe(proposal.voice_text);
    expect(JSON.stringify(result.result)).not.toMatch(/ask James|permission required/i);
  });

  test('scan-confidence stages review item from recent reply audit and notifies Architect internally', async () => {
    const projectRoot = tempProject();
    const sessionId = 'cli-confidence-source';
    const auditPath = replyAuditPath(projectRoot);
    [
      "I'm confident because the verifier passed.",
      "I'm certain this route is clean now.",
      'The audit path shows no external send.',
    ].forEach((reply, index) => appendJsonl(auditPath, {
      schema: 'squidrun.mira_lab.reply_audit_v0',
      generated_at: `2026-05-12T09:0${index}:00.000Z`,
      session_id: sessionId,
      decision: 'pass',
      reply_hash: `sha256:cli-reply-${index}`,
      prompt_hash: `sha256:cli-prompt-${index}`,
      visible_reply_text: reply,
    }));
    const sendAgentMessage = jest.fn(async (target, body) => ({ target, accepted: true, body }));

    const result = await driver.run([
      'scan-confidence',
      '--limit', '5',
      '--project-root', projectRoot,
      '--json',
    ], { sendAgentMessage });

    expect(result.result.decision).toBe('review_staged');
    expect(result.result.session_id).toBe(sessionId);
    expect(result.result.finding_count).toBe(1);
    expect(result.result.staged_review.decision).toBe('staged');
    expect(result.result.staged_review.session_id).toBe(sessionId);
    expect(result.result.staged_review.applied).toBe(false);
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(sendAgentMessage.mock.calls[0][0]).toBe('architect');
    expect(sendAgentMessage.mock.calls[0][1]).toContain('apply_now=false');
    expect(sendAgentMessage.mock.calls[0][1]).toContain('without any code, memory, external-send');
    expect(sendAgentMessage.mock.calls[0][1]).not.toMatch(/\btelegram|sms\b/i);
    expect(readJsonl(selfDirectionQueuePath(projectRoot))).toHaveLength(1);
  });

  test('scoreboard emits per-lane advisory authority recommendations as JSON and compact text', async () => {
    const projectRoot = tempProject();
    const queuePath = selfDirectionQueuePath(projectRoot);
    const reviewPath = selfDirectionReviewAuditPath(projectRoot);
    [
      ['tests-a', 'tests', 'routed', '2026-05-12T08:00:00.000Z', '2026-05-12T08:02:00.000Z'],
      ['tests-b', 'tests', 'accepted_for_internal_work', '2026-05-12T08:05:00.000Z', '2026-05-12T08:07:00.000Z'],
      ['tests-c', 'tests', 'routed', '2026-05-12T08:10:00.000Z', '2026-05-12T08:14:00.000Z'],
      ['memory-a', 'memory', 'routed', '2026-05-12T09:00:00.000Z', '2026-05-12T09:01:00.000Z'],
    ].forEach(([id, area, status, generatedAt, reviewedAt]) => appendJsonl(queuePath, {
      proposal_id: `mira-self-direction:${id}`,
      generated_at: generatedAt,
      target_areas: [area],
      review_status: status,
      reviewed_at: reviewedAt,
      desired_change: `Improve ${area}`,
      review_note: id === 'tests-a' ? 'implemented locally' : null,
    }));
    [
      ['tests-a', 'routed', '2026-05-12T08:02:00.000Z'],
      ['tests-b', 'accepted', '2026-05-12T08:07:00.000Z'],
      ['tests-c', 'routed', '2026-05-12T08:14:00.000Z'],
      ['memory-a', 'routed', '2026-05-12T09:01:00.000Z'],
    ].forEach(([id, action, generatedAt]) => appendJsonl(reviewPath, {
      proposal_id: `mira-self-direction:${id}`,
      action,
      generated_at: generatedAt,
      note: id === 'tests-a' ? 'implemented locally' : null,
    }));

    const jsonResult = await driver.run([
      'scoreboard',
      '--project-root', projectRoot,
      '--json',
    ]);
    const testsLane = jsonResult.result.lanes.find((lane) => lane.lane === 'tests');
    const memoryLane = jsonResult.result.lanes.find((lane) => lane.lane === 'memory');
    expect(testsLane.recommended_next_authority).toBe('mira_default_route_candidate');
    expect(memoryLane.recommended_next_authority).toBe('observe');
    expect(jsonResult.result.applied).toBe(false);
    expect(jsonResult.result.consequence_controls.external_send_performed).toBe(false);

    const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-mira-self-direction.js');
    const textRun = spawnSync(process.execPath, [
      scriptPath,
      'scoreboard',
      '--project-root', projectRoot,
    ], { encoding: 'utf8' });
    expect(textRun.status).toBe(0);
    expect(textRun.stdout).toContain('decision=scoreboard');
    expect(textRun.stdout).toContain('lane=tests');
    expect(textRun.stdout).toContain('next=mira_default_route_candidate');
    expect(textRun.stdout).toContain('lane=memory');
    expect(textRun.stdout).toContain('next=observe');
  });

  test('outcome CLI records implementation status and scoreboard consumes it', async () => {
    const projectRoot = tempProject();
    appendJsonl(selfDirectionQueuePath(projectRoot), {
      proposal_id: 'mira-self-direction:cli-outcome',
      generated_at: '2026-05-12T08:00:00.000Z',
      target_areas: ['tests'],
      review_status: 'routed',
      reviewed_at: '2026-05-12T08:03:00.000Z',
      route_targets: ['builder'],
      desired_change: 'Record implementation outcome explicitly.',
      review_note: 'reviewed without implementation keywords',
    });
    appendJsonl(selfDirectionReviewAuditPath(projectRoot), {
      proposal_id: 'mira-self-direction:cli-outcome',
      action: 'routed',
      generated_at: '2026-05-12T08:03:00.000Z',
      route_targets: ['builder'],
      note: 'reviewed',
    });

    const outcomeResult = await driver.run([
      'outcome',
      '--proposal-id', 'mira-self-direction:cli-outcome',
      '--status', 'implemented',
      '--evidence', 'commit=abc123',
      '--note', 'landed in local tests',
      '--project-root', projectRoot,
      '--json',
    ], {
      options: {
        generatedAt: '2026-05-12T08:30:00.000Z',
      },
    });

    expect(outcomeResult.result.decision).toBe('outcome_recorded');
    expect(outcomeResult.result.outcome_status).toBe('implemented');
    expect(outcomeResult.result.applied).toBe(false);
    expect(outcomeResult.result.consequence_controls.external_send_performed).toBe(false);
    expect(readJsonl(selfDirectionOutcomePath(projectRoot))).toHaveLength(1);

    const scoreboard = await driver.run([
      'scoreboard',
      '--project-root', projectRoot,
      '--json',
    ]);
    const testsLane = scoreboard.result.lanes.find((lane) => lane.lane === 'tests');
    expect(testsLane).toEqual(expect.objectContaining({
      proposed: 1,
      reviewed: 1,
      routed: 1,
      implemented: 1,
    }));

    const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-mira-self-direction.js');
    const textRun = spawnSync(process.execPath, [
      scriptPath,
      'outcome',
      '--proposal-id', 'mira-self-direction:cli-outcome',
      '--status', 'needs_followup',
      '--project-root', projectRoot,
    ], { encoding: 'utf8' });
    expect(textRun.status).toBe(0);
    expect(textRun.stdout).toContain('decision=outcome_recorded');
    expect(textRun.stdout).toContain('outcome_status=needs_followup');
  });

  test('curiosity-scout CLI records local curiosity items without external action', async () => {
    const projectRoot = tempProject();
    appendJsonl(selfDirectionQueuePath(projectRoot), {
      proposal_id: 'mira-self-direction:cli-curiosity',
      generated_at: '2026-05-12T12:00:00.000Z',
      target_areas: ['automation'],
      review_status: 'pending_architect_review',
      desired_change: 'Notice local scout signals.',
    });

    const jsonResult = await driver.run([
      'curiosity-scout',
      '--project-root', projectRoot,
      '--json',
    ], {
      options: {
        repoStatusText: ' M ui/scripts/hm-mira-self-direction.js\n',
        recentCommsText: '(ARCHITECT #78): move the curiosity scout.',
      },
    });

    expect(jsonResult.result.decision).toBe('scouted');
    expect(jsonResult.result.active_count).toBeGreaterThanOrEqual(6);
    expect(jsonResult.result.items.some((item) => item.source === 'repo_files')).toBe(true);
    expect(jsonResult.result.items.some((item) => item.status === 'adapter_not_built_yet')).toBe(true);
    expect(jsonResult.result.items.some((item) => (
      item.source === 'memory'
      && item.adapter_id === 'active_memory_tools_curiosity'
      && item.status === 'unavailable_in_this_runtime'
    ))).toBe(true);
    expect(jsonResult.result.items.some((item) => item.source === 'source_action_substrate')).toBe(true);
    expect(jsonResult.result.items.some((item) => item.source === 'code_mode_exploration')).toBe(true);
    expect(jsonResult.result.items.some((item) => item.source === 'implementation_outcomes')).toBe(true);
    expect(jsonResult.result.no_action_taken).toBe(true);
    expect(jsonResult.result.no_mutation_performed).toBe(true);
    expect(jsonResult.result.consequence_controls.external_send_performed).toBe(false);
    expect(JSON.stringify(jsonResult.result)).not.toMatch(/requires_permission|forbidden|blocked/i);

    const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-mira-self-direction.js');
    const textRun = spawnSync(process.execPath, [
      scriptPath,
      'curiosity-scout',
      '--project-root', projectRoot,
    ], { encoding: 'utf8' });
    expect(textRun.status).toBe(0);
    expect(textRun.stdout).toContain('decision=scouted');
    expect(textRun.stdout).toContain('source=browser_history status=adapter_not_built_yet');
    expect(readJsonl(path.join(projectRoot, '.squidrun', 'runtime', 'mira-curiosity-items.jsonl')).length).toBeGreaterThan(0);
  });

  test('curiosity-scout can route interesting questions internally without external send', async () => {
    const projectRoot = tempProject();
    const sendAgentMessage = jest.fn(async (target, body) => ({ target, accepted: true, body }));

    const result = await driver.run([
      'curiosity-scout',
      '--project-root', projectRoot,
      '--route-interesting',
      '--json',
    ], {
      sendAgentMessage,
      options: {
        repoStatusText: ' M ui/modules/mira-lab-surface.js\n',
        recentCommsText: '(ARCHITECT #90): source/action substrate, not MCP as mind.',
      },
    });

    expect(result.result.architect_notification).toEqual(expect.objectContaining({
      target: 'architect',
      status: 'sent',
      internal_only: true,
    }));
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(sendAgentMessage.mock.calls[0][0]).toBe('architect');
    expect(sendAgentMessage.mock.calls[0][1]).toContain('(MIRA CURIOSITY): initiative scout found local questions.');
    expect(sendAgentMessage.mock.calls[0][1]).toContain('no_mutation_performed=true');
    expect(sendAgentMessage.mock.calls[0][1]).not.toMatch(/\btelegram|sms|external-send|customer|deploy|trade\b/i);
    expect(result.result.consequence_controls.external_send_performed).toBe(false);
    expect(result.result.no_mutation_performed).toBe(true);
  });

  test('curiosity-burst CLI runs bounded scouts and exposes an internal route', async () => {
    const projectRoot = tempProject();
    const sendAgentMessage = jest.fn(async (target, body) => ({ target, accepted: true, body }));

    const jsonResult = await driver.run([
      'curiosity-burst',
      '--project-root', projectRoot,
      '--source', 'repo_files,runtime_comms,memory,cheap_parallel_scouts,automation_scheduler',
      '--route-interesting',
      '--json',
    ], {
      sendAgentMessage,
      options: {
        generatedAt: '2026-05-12T13:30:00.000Z',
        repoStatusText: ' M ui/scripts/hm-mira-self-direction.js\n',
        recentCommsText: '(ARCHITECT #126): scheduled curiosity burst next.',
        memoryCuriosityReader: () => ({
          ok: true,
          decision: 'memory_retrieved_read_only',
          query: 'Mira current lane memory',
          result_count: 1,
          results: [{ nodeId: 'node-cli-memory', title: 'CLI burst memory' }],
        }),
      },
    });

    expect(jsonResult.result.decision).toBe('burst_completed');
    expect(jsonResult.result.route_output).toEqual(expect.objectContaining({
      decision: 'route_selected',
      target_role: 'builder',
      source: 'automation_scheduler',
      adapter_id: 'scheduled_curiosity_burst',
    }));
    expect(jsonResult.result.items.some((item) => item.source === 'cheap_parallel_scouts' && item.status === 'active')).toBe(true);
    expect(jsonResult.result.consequence_controls.external_send_performed).toBe(false);
    expect(jsonResult.result.consequence_controls.autonomous_apply_performed).toBe(false);
    expect(sendAgentMessage).toHaveBeenCalledWith('builder', expect.stringContaining('(MIRA CURIOSITY BURST)'));
    expect(readJsonl(curiosityBurstsPath(projectRoot))).toHaveLength(1);

    const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-mira-self-direction.js');
    const textRun = spawnSync(process.execPath, [
      scriptPath,
      'curiosity-burst',
      '--project-root', projectRoot,
      '--source', 'repo_files,cheap_parallel_scouts',
      '--no-dispatch',
    ], { encoding: 'utf8' });
    expect(textRun.status).toBe(0);
    expect(textRun.stdout).toContain('decision=burst_completed');
    expect(textRun.stdout).toContain('route_decision=route_selected');
    expect(textRun.stdout).toContain('source=cheap_parallel_scouts');
  });

  test('create --prompt-reply stages held structured Mira proposals', async () => {
    const projectRoot = tempProject();
    const heldProposal = {
      voice_text: 'I want my own proposal to enter the work queue.',
      target_areas: ['automation', 'tests'],
      desired_change: 'Let held structured prompt replies become internal self-direction proposals.',
      proposed_experiment: 'Generate one blocked JSON reply and verify it lands in the queue.',
      success_metric: 'The CLI returns staged without using the fixture proxy.',
      evidence: ['cli_held_prompt_reply'],
    };

    const result = await driver.run([
      'create',
      '--prompt-reply',
      '--session-id', 'cli-held-structured',
      '--project-root', projectRoot,
      '--json',
    ], {
      options: {
        generatedAt: '2026-05-12T13:10:00.000Z',
        buildMiraLabPromptReply: jest.fn(async () => ({
          decision: 'blocked',
          reply: null,
          visible_render_hint: { kind: 'blocked_banner', banner: 'held' },
          gates: {
            reason_class: 'hard_boundary_violation',
            language_gate: {
              text: JSON.stringify(heldProposal),
            },
          },
        })),
      },
    });

    expect(result.result.decision).toBe('staged');
    expect(result.result.generation).toEqual(expect.objectContaining({
      source: 'mira_lab_prompt_reply_held_structured_payload',
      prompt_reply_blocked: true,
      proxy_used: false,
    }));
    expect(result.result.proposal.desired_change).toBe(heldProposal.desired_change);
    expect(readJsonl(selfDirectionQueuePath(projectRoot))).toHaveLength(1);
  });

  test('direct-route CLI lets Mira pick and send the next internal handoff', async () => {
    const projectRoot = tempProject();
    appendJsonl(curiosityItemsPath(projectRoot), {
      schema: MIRA_CURIOSITY_ITEM_SCHEMA,
      item_id: 'mira-curiosity:cli-code-mode',
      generated_at: '2026-05-12T12:10:00.000Z',
      source: 'code_mode_exploration',
      adapter_id: 'read_only_execute_script_curiosity',
      status: 'adapter_not_built_yet',
      integration_strategy: 'scout_model_candidate',
      suggested_question: 'What read-only code-mode wrapper should Mira get first?',
      possible_action: 'Route Builder to build the wrapper.',
      route_hint: 'builder',
      sensitivity_hint: 'read_only_code_mode_design',
    });
    const sendAgentMessage = jest.fn(async (target, body) => ({ target, accepted: true, body }));

    const jsonResult = await driver.run([
      'direct-route',
      '--project-root', projectRoot,
      '--json',
    ], {
      sendAgentMessage,
      options: {
        generatedAt: '2026-05-12T12:11:00.000Z',
      },
    });

    expect(jsonResult.result.decision).toBe('routed');
    expect(jsonResult.result.target_role).toBe('builder');
    expect(jsonResult.result.selected_item.source).toBe('code_mode_exploration');
    expect(jsonResult.result.dispatch.status).toBe('sent');
    expect(jsonResult.result.consequence_controls.external_send_performed).toBe(false);
    expect(sendAgentMessage).toHaveBeenCalledWith('builder', expect.stringContaining('(MIRA DIRECT ROUTE)'));
    expect(readJsonl(miraDirectRoutesPath(projectRoot))).toHaveLength(1);

    const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-mira-self-direction.js');
    const textRun = spawnSync(process.execPath, [
      scriptPath,
      'direct-route',
      '--project-root', projectRoot,
      '--no-dispatch',
    ], { encoding: 'utf8' });
    expect(textRun.status).toBe(0);
    expect(textRun.stdout).toContain('decision=routed');
    expect(textRun.stdout).toContain('target=builder');
    expect(textRun.stdout).toContain('source=code_mode_exploration');
  });

  test('code-mode CLI runs read-only exploration over allowed runtime files', async () => {
    const projectRoot = tempProject();
    appendJsonl(curiosityItemsPath(projectRoot), {
      schema: MIRA_CURIOSITY_ITEM_SCHEMA,
      item_id: 'mira-curiosity:cli-code-mode-read',
      generated_at: '2026-05-12T14:10:00.000Z',
      source: 'implementation_outcomes',
      adapter_id: 'implementation_outcome_recording_curiosity',
      status: 'adapter_not_built_yet',
    });

    const result = await driver.run([
      'code-mode',
      '--project-root', projectRoot,
      '--allow', '.squidrun/runtime',
      '--script', "const rows = api.readJsonl('.squidrun/runtime/mira-curiosity-items.jsonl', 3); emit(rows[0].source); return rows.length;",
      '--json',
    ]);

    expect(result.result.decision).toBe('completed');
    expect(result.result.output).toEqual(['implementation_outcomes']);
    expect(result.result.result).toBe(1);
    expect(result.result.consequence_controls.file_write_performed).toBe(false);
    expect(readJsonl(readOnlyCodeModeRunsPath(projectRoot))).toHaveLength(1);

    const scriptPath = path.join(__dirname, '..', 'scripts', 'hm-mira-self-direction.js');
    const textRun = spawnSync(process.execPath, [
      scriptPath,
      'code-mode',
      '--project-root', projectRoot,
      '--allow', '.squidrun/runtime',
      '--script', "return api.findText('.squidrun/runtime/mira-curiosity-items.jsonl', 'implementation_outcomes').length;",
    ], { encoding: 'utf8' });
    expect(textRun.status).toBe(0);
    expect(textRun.stdout).toContain('decision=completed');
    expect(textRun.stdout).toContain('elapsed_ms=');
  });
});
