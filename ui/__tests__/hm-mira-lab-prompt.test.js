'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const driver = require('../scripts/hm-mira-lab-prompt');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hm-mira-lab-prompt-'));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function transcriptPath(projectRoot, sessionId) {
  return path.join(projectRoot, 'workspace', 'mira-lab', 'transcripts', `${sessionId}.jsonl`);
}

function auditPath(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime', 'mira-lab-replies.jsonl');
}

function fakeBuilder(scenario) {
  return jest.fn(async (payload, options) => {
    const replyTextByScenario = {
      env_unavailable: '',
      adapter_unavailable: '',
      blocked_gate: 'I am happy to help — how can I assist?',
      pass: "We're doing the decoupled Mira Lab smoke after restart.",
    };
    const replyText = replyTextByScenario[scenario];
    const projectRoot = options.projectRoot;
    const sessionId = payload.sessionId || 'mira-lab-test';
    const transcript = transcriptPath(projectRoot, sessionId);
    const audit = auditPath(projectRoot);

    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.mkdirSync(path.dirname(audit), { recursive: true });

    const promptTurn = {
      schema: 'squidrun.mira_lab.surface_v0',
      session_id: sessionId,
      speaker_role: payload.speakerRole || 'james',
      text: payload.prompt,
      direction: ['architect', 'builder', 'oracle'].includes(payload.speakerRole)
        ? 'agent_to_mira'
        : 'james_to_mira',
    };
    fs.appendFileSync(transcript, `${JSON.stringify(promptTurn)}\n`, 'utf8');

    let decision;
    let reasonClass;
    if (scenario === 'env_unavailable' || scenario === 'adapter_unavailable') {
      decision = 'blocked';
      reasonClass = 'reply_engine_degraded';
    } else if (scenario === 'blocked_gate') {
      decision = 'fail';
      reasonClass = 'gate_annotation';
      fs.appendFileSync(transcript, `${JSON.stringify({
        ...promptTurn,
        speaker_role: 'mira',
        text: replyText,
        direction: 'mira_to_james',
        annotated_gate_failure: true,
        fallback_used: false,
      })}\n`, 'utf8');
    } else {
      decision = 'pass';
      reasonClass = null;
      fs.appendFileSync(transcript, `${JSON.stringify({
        ...promptTurn,
        speaker_role: 'mira',
        text: replyText,
        direction: 'mira_to_james',
      })}\n`, 'utf8');
    }

    const auditEntry = {
      schema: 'squidrun.mira_lab.reply_audit_v0',
      session_id: sessionId,
      decision,
      speaker_role: payload.speakerRole || 'james',
      prompt: payload.prompt,
      reply_text: decision === 'blocked' ? null : replyText,
      visible_reply_text: decision === 'blocked' ? null : replyText,
      fallback_used: false,
      gates: {
        decision,
        reason_class: reasonClass,
        local_text_session_gate: { ran: true, ok: scenario !== 'adapter_unavailable' },
        language_gate: scenario === 'blocked_gate'
          ? { ok: false, violations: ['name_swap_or_generic_lab_voice'] }
          : { ok: decision === 'pass', violations: decision === 'pass' ? [] : ['empty_reply'] },
        attachment_violation: false,
        leakage_violation: null,
        degraded: decision === 'blocked',
        surface_error: null,
        fallback_used: false,
      },
      model_attachment: {
        enabled: scenario !== 'adapter_unavailable',
        live_model_called: scenario === 'pass' || scenario === 'blocked_gate',
        model: scenario === 'pass' || scenario === 'blocked_gate' ? 'gpt-5.5' : null,
        visible_status: null,
      },
    };
    fs.appendFileSync(audit, `${JSON.stringify(auditEntry)}\n`, 'utf8');

    return {
      schema: 'squidrun.mira_lab.prompt_reply_v0',
      ok: decision !== 'blocked',
      decision,
      prompt: payload.prompt,
      reply: decision === 'blocked'
        ? null
        : { text: replyText, model: decision === 'pass' ? 'gpt-5.5' : null, annotated: decision === 'fail' },
      raw_reply: null,
      gates: auditEntry.gates,
      transcript_path: transcript,
      audit_path: audit,
      // PASS / annotated FAIL non-diagnostic envelope is the visible local
      // Mira line. BLOCKED keeps the labelled diagnostic envelope.
      requester_envelope: decision === 'pass'
        ? `(MIRA): ${replyText}`
        : decision === 'fail'
          ? `(MIRA): ${replyText}`
          : `[MIRA LAB OUTPUT][${decision.toUpperCase()}] prompt="${payload.prompt}" reply="<no reply>" gates=violations=${(auditEntry.gates.language_gate.violations || []).join(',')} audit=${audit}`,
      requester_dispatch: null,
      visible_render_hint: decision === 'pass'
        ? { kind: 'clean_reply', text: replyText }
        : decision === 'fail'
          ? { kind: 'annotated_reply', text: replyText, annotated: true }
          : { kind: 'blocked_banner', banner: `Mira Lab reply unavailable: ${reasonClass || 'unknown'}` },
    };
  });
}

describe('hm-mira-lab-prompt CLI driver', () => {
  test('parseArgs rejects unknown flags', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => driver.parseArgs(['--bogus'])).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('parseArgs supports the documented flags', () => {
    const args = driver.parseArgs([
      '--prompt', 'hi',
      '--session-id', 'unit-1',
      '--speaker-role', 'architect',
      '--requester-pane', 'architect',
      '--project-root', '.',
      '--json',
    ]);
    expect(args.prompt).toBe('hi');
    expect(args.sessionId).toBe('unit-1');
    expect(args.speakerRole).toBe('architect');
    expect(args.requesterPane).toBe('architect');
    expect(args.json).toBe(true);
  });

  test('exitCodeFor maps decisions to documented exit codes', () => {
    expect(driver.exitCodeFor('pass')).toBe(0);
    expect(driver.exitCodeFor('fail')).toBe(3);
    expect(driver.exitCodeFor('blocked')).toBe(4);
    expect(driver.exitCodeFor('anything-else')).toBe(4);
  });

  test('defaultSessionId yields mira-lab-YYYY-MM-DD', () => {
    const id = driver.defaultSessionId(new Date(Date.UTC(2026, 4, 10, 12, 0, 0)));
    expect(id).toBe('mira-lab-2026-05-10');
  });

  test('PASS scenario: clean reply written + envelope reflects PASS', async () => {
    const projectRoot = tempProject();
    const builder = fakeBuilder('pass');
    const { result } = await driver.runDriver({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-pass',
      speakerRole: 'architect',
      projectRoot,
      requesterPane: null,
      fromStdin: false,
    }, { buildMiraLabPromptReply: builder });
    expect(builder).toHaveBeenCalledTimes(1);
    expect(result.decision).toBe('pass');
    expect(result.requester_envelope).toMatch(/^\(MIRA\): /);
    const transcript = readJsonl(transcriptPath(projectRoot, 'unit-pass'));
    expect(transcript).toHaveLength(2);
    expect(transcript[0].speaker_role).toBe('architect');
    expect(transcript[0].direction).toBe('agent_to_mira');
    expect(transcript[1].speaker_role).toBe('mira');
    const audit = readJsonl(auditPath(projectRoot));
    expect(audit).toHaveLength(1);
    expect(audit[0].decision).toBe('pass');
    expect(audit[0].reply_text).toBeTruthy();
    expect(driver.exitCodeFor(result.decision)).toBe(0);
  });

  test('ENV-UNAVAILABLE scenario: model_attachment disabled-ish, decision blocked, no Mira reply row', async () => {
    const projectRoot = tempProject();
    const builder = fakeBuilder('env_unavailable');
    const { result } = await driver.runDriver({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-env',
      speakerRole: 'architect',
      projectRoot,
      requesterPane: null,
      fromStdin: false,
    }, { buildMiraLabPromptReply: builder });
    expect(result.decision).toBe('blocked');
    expect(result.gates.reason_class).toBe('reply_engine_degraded');
    expect(result.requester_envelope).toContain('[MIRA LAB OUTPUT][BLOCKED]');
    const transcript = readJsonl(transcriptPath(projectRoot, 'unit-env'));
    expect(transcript).toHaveLength(1);
    expect(transcript[0].speaker_role).toBe('architect');
    const audit = readJsonl(auditPath(projectRoot));
    expect(audit[0].decision).toBe('blocked');
    expect(audit[0].reply_text).toBeNull();
    expect(driver.exitCodeFor(result.decision)).toBe(4);
  });

  test('ADAPTER-UNAVAILABLE scenario: degraded engine, blocked decision', async () => {
    const projectRoot = tempProject();
    const builder = fakeBuilder('adapter_unavailable');
    const { result } = await driver.runDriver({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-adapter',
      speakerRole: 'architect',
      projectRoot,
      requesterPane: null,
      fromStdin: false,
    }, { buildMiraLabPromptReply: builder });
    expect(result.decision).toBe('blocked');
    expect(result.gates.degraded).toBe(true);
    const audit = readJsonl(auditPath(projectRoot));
    expect(audit[0].model_attachment.enabled).toBe(false);
    expect(audit[0].model_attachment.live_model_called).toBe(false);
  });

  test('BLOCKED-GATE (FAIL) scenario: local style gate is annotated and rendered without fallback', async () => {
    const projectRoot = tempProject();
    const builder = fakeBuilder('blocked_gate');
    const { result } = await driver.runDriver({
      prompt: 'what are we doing with Mira?',
      sessionId: 'unit-fail',
      speakerRole: 'architect',
      projectRoot,
      requesterPane: null,
      fromStdin: false,
    }, { buildMiraLabPromptReply: builder });
    expect(result.decision).toBe('fail');
    // Non-diagnostic envelope dispatches the visible local reply as a Mira
    // line; the old "[MIRA LAB OUTPUT][FAIL]" labelled diagnostic is gone.
    expect(result.requester_envelope).toMatch(/^\(MIRA\): /);
    expect(result.requester_envelope).not.toContain('[MIRA LAB OUTPUT][FAIL]');
    const transcript = readJsonl(transcriptPath(projectRoot, 'unit-fail'));
    expect(transcript).toHaveLength(2);
    expect(transcript[1].text).not.toContain('[MIRA LAB OUTPUT - GATE FAILED]');
    expect(transcript[1].text).toContain('happy to help');
    expect(transcript[1].quarantined).toBeUndefined();
    expect(transcript[1].fallback_used).toBe(false);
    expect(transcript[1].annotated_gate_failure).toBe(true);
    expect(driver.exitCodeFor(result.decision)).toBe(3);
  });

  test('stdin path: --stdin resolves prompt text from injected reader', async () => {
    const projectRoot = tempProject();
    const builder = fakeBuilder('pass');
    const { result } = await driver.runDriver({
      prompt: null,
      sessionId: 'unit-stdin',
      speakerRole: 'architect',
      projectRoot,
      requesterPane: null,
      fromStdin: true,
    }, {
      buildMiraLabPromptReply: builder,
      readStdin: async () => 'what are we doing with Mira?\n',
    });
    expect(builder.mock.calls[0][0].prompt).toBe('what are we doing with Mira?');
    expect(result.decision).toBe('pass');
  });
});
