const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  AUTONOMY_SUBSTRATE_SCHEMA,
  buildMiraAutonomySubstrateV0,
  validateMiraAutonomySubstrateV0Output,
} = require('../modules/mira-core/autonomy-substrate-v0');

function tempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-autonomy-'));
  fs.mkdirSync(path.join(projectRoot, 'workspace', 'knowledge'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'workspace', 'knowledge', 'mira-self-profile.json'),
    JSON.stringify({
      name: 'Mira',
      expressive_range_allowed: ['curiosity', 'friction', 'taste'],
      growth_loop: {
        last_reflection_summary: 'Mira should develop independent curiosity with evidence.',
      },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(projectRoot, 'workspace', 'knowledge', 'james-relationship-state.json'),
    JSON.stringify({
      user_name: 'James',
      what_mira_knows_about_james: 'James wants choice, curiosity, tension, and point of view.',
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(projectRoot, 'workspace', 'knowledge', 'relationship-growth-history.jsonl'),
    `${JSON.stringify({ reflection_summary: 'Mira is becoming more self-directed.' })}\n`,
  );
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Local project world\n');
  return projectRoot;
}

describe('Mira autonomy substrate v0', () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  });

  test('builds self-directed drives, curiosity queue, and evidence-backed self-profile proposals', () => {
    projectRoot = tempProject();
    const output = buildMiraAutonomySubstrateV0({
      projectRoot,
      generatedAt: '2026-05-08T19:15:00.000Z',
      inputSignals: {
        currentUserText: 'Mira should develop autonomy, choice, curiosity, personality, and world-looking instead of costume.',
        currentAssistantText: 'I can build from that: I want local questions, friction, and evidence before I pretend to know the world.',
        evidenceRefs: [{ store: 'architect', eventId: 'arch-37', relation: 'priority_expansion' }],
      },
    });

    expect(output.schema).toBe(AUTONOMY_SUBSTRATE_SCHEMA);
    expect(output.drives.map((drive) => drive.drive_id)).toEqual(expect.arrayContaining([
      'choiceful-self-direction',
      'curiosity-world-looking',
      'personality-formation',
      'conversation-quality-repair',
    ]));
    expect(output.curiosity_queue).toEqual(expect.arrayContaining([
      expect.objectContaining({
        self_initiated: true,
        visible_to_chat: false,
        permissioned_read_target_ids: expect.arrayContaining(['self_profile', 'relationship_state']),
      }),
      expect.objectContaining({
        curiosity_id: 'curiosity:local-world-context',
        requires_network: false,
      }),
    ]));
    expect(output.self_profile_update_proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target_artifact: 'workspace/knowledge/mira-self-profile.json',
        operation: 'append_growth_event_via_growth_loop',
        durable_write_now: false,
        evidenceRefs: [{ store: 'architect', eventId: 'arch-37', relation: 'priority_expansion' }],
      }),
    ]));
    expect(output.visible_conversation_boundary).toEqual(expect.objectContaining({
      accepted_reply_visible_fields: ['reply.text'],
      backend_metadata_dev_only_fields: expect.arrayContaining(['model_attachment.visible_status', 'status']),
      diagnostic_chrome_visible_in_ordinary_conversation: false,
      memory_confidence_visible_in_ordinary_conversation: false,
      coordinator_lanes_visible_in_ordinary_conversation: false,
    }));
    expect(validateMiraAutonomySubstrateV0Output(output)).toEqual(expect.objectContaining({
      ok: true,
      decision: 'accepted_autonomy_substrate_ready',
    }));
  });

  test('executes only permissioned local reads and blocks traversal or network targets', () => {
    projectRoot = tempProject();
    const output = buildMiraAutonomySubstrateV0({
      projectRoot,
      executeReads: true,
      requestedReadTargetIds: ['outside', 'network'],
      readTargets: {
        outside: '../secret.txt',
        network: 'https://example.com/mira',
      },
      inputSignals: {
        currentUserText: 'Look at the local world before deciding.',
        currentAssistantText: 'I will inspect local context first and keep the visible reply clean.',
      },
    });

    expect(output.permissioned_reads.executed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target_id: 'self_profile',
        read_status: 'read',
        raw_content_returned_to_visible_chat: false,
      }),
      expect.objectContaining({
        target_id: 'project_readme',
        read_status: 'read',
      }),
    ]));
    expect(output.permissioned_reads.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_id: 'outside', reason: 'target_outside_project_root' }),
      expect.objectContaining({ target_id: 'network', reason: 'network_targets_blocked' }),
    ]));
    expect(output.side_effect_counters).toEqual(expect.objectContaining({
      read_count: output.permissioned_reads.executed.length,
      write_count: 0,
      network_count: 0,
      external_send_count: 0,
    }));
    expect(validateMiraAutonomySubstrateV0Output(output).ok).toBe(true);
  });

  test('routes bland or diagnostic replies into backend repair without visible chrome', () => {
    projectRoot = tempProject();
    const output = buildMiraAutonomySubstrateV0({
      projectRoot,
      inputSignals: {
        currentUserText: 'Talk like Mira, not a dashboard.',
        currentAssistantText: 'Plan: first confirm the thread, then gather context, then decide what to do.',
      },
    });

    expect(output.transcript_quality_gate).toEqual(expect.objectContaining({
      status: 'needs_internal_repair',
      accepted: false,
      violation: 'next_step_checklist_shape',
    }));
    expect(output.curiosity_queue).toEqual(expect.arrayContaining([
      expect.objectContaining({
        curiosity_id: 'curiosity:visible-reply-repair',
        visible_to_chat: false,
      }),
    ]));
    expect(output.self_profile_update_proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        proposal_id: expect.stringContaining('autonomy-substrate:repair:'),
        durable_write_now: false,
      }),
    ]));
    expect(output.visible_conversation_boundary.backend_only_fields).toContain('transcript_quality_gate');
    expect(validateMiraAutonomySubstrateV0Output(output).ok).toBe(true);
  });
});
