'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const driver = require('../scripts/hm-mira-self-direction');
const {
  replyAuditPath,
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
});
