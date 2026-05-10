'use strict';

const {
  DEFAULT_PROMPTS,
  PROOF_NOTE,
  SCHEMA,
  decisionFromExitCode,
  parseEnvelope,
  pickReplyText,
  pickReplySource,
  pickGates,
  runVerification,
} = require('../scripts/hm-mira-lab-verify');

const { normalizeCommand } = require('../scripts/hm-app');

describe('hm-mira-lab-verify', () => {
  test('decisionFromExitCode maps prompt-cli exit codes to surface decisions', () => {
    expect(decisionFromExitCode(0)).toBe('pass');
    expect(decisionFromExitCode(3)).toBe('fail');
    expect(decisionFromExitCode(4)).toBe('blocked');
    expect(decisionFromExitCode(1)).toBe('error');
    expect(decisionFromExitCode(-1)).toBe('error');
  });

  test('parseEnvelope tolerates info lines printed before the JSON envelope', () => {
    const stdout = [
      'hm-mira-lab-prompt: writing transcript turn pair',
      'hm-mira-lab-prompt: writing audit row',
      JSON.stringify({ reply: { text: 'hi', source: 'mira_text_model_attachment_v1' }, gates: ['ok'] }),
    ].join('\n');
    const envelope = parseEnvelope(stdout);
    expect(envelope).toEqual(expect.objectContaining({
      reply: { text: 'hi', source: 'mira_text_model_attachment_v1' },
      gates: ['ok'],
    }));
  });

  test('pickReplyText / pickReplySource / pickGates read both flat and nested envelopes', () => {
    const envelope = {
      reply: { text: 'still here', source: 'mira_text_model_attachment_v1' },
      gates: ['attachment_contract_pass'],
    };
    expect(pickReplyText(envelope)).toBe('still here');
    expect(pickReplySource(envelope)).toBe('mira_text_model_attachment_v1');
    expect(pickGates(envelope)).toEqual(['attachment_contract_pass']);

    const nested = { decision: { reply: { text: 'concrete', source: 'fallback' } }, audit: { gates: ['x'] } };
    expect(pickReplyText(nested)).toBe('concrete');
    expect(pickReplySource(nested)).toBe('fallback');
    expect(pickGates(nested)).toEqual(['x']);
  });

  test('runVerification skips window open when requested and aggregates four prompt probes', async () => {
    const spawnAppOpen = jest.fn();
    const spawnPromptCli = jest.fn(({ prompt }) => Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        reply: { text: `reply for ${prompt}`, source: 'mira_text_model_attachment_v1' },
        gates: ['attachment_contract_pass'],
      }),
      stderr: '',
    }));

    const result = await runVerification({
      skipWindowOpen: true,
      sessionId: 'verify-test',
      spawnAppOpen,
      spawnPromptCli,
    });

    expect(spawnAppOpen).not.toHaveBeenCalled();
    expect(spawnPromptCli).toHaveBeenCalledTimes(DEFAULT_PROMPTS.length);
    expect(result.schema).toBe(SCHEMA);
    expect(result.session_id).toBe('verify-test');
    expect(result.renderer_window_open).toEqual(expect.objectContaining({
      attempted: false,
      reason: 'skipped_by_caller',
    }));
    expect(result.proof_classification).toEqual({
      renderer_proof_via_ipc: false,
      fresh_process_proxy_proof: true,
      note: PROOF_NOTE,
    });
    expect(result.prompts).toHaveLength(DEFAULT_PROMPTS.length);
    expect(result.prompts.every((entry) => entry.decision === 'pass')).toBe(true);
    expect(result.all_pass).toBe(true);
  });

  test('runVerification reports a failed prompt and clears all_pass when any decision is not pass', async () => {
    const stdouts = [
      JSON.stringify({ reply: { text: 'ok', source: 'm' } }),
      JSON.stringify({ reply: { text: 'bad shape', source: 'm' }, gates: ['violation:visible_posture_label'] }),
      JSON.stringify({ reply: { text: 'ok', source: 'm' } }),
      JSON.stringify({ reply: { text: 'ok', source: 'm' } }),
    ];
    const codes = [0, 3, 0, 0];
    let call = 0;
    const spawnPromptCli = jest.fn(() => {
      const i = call;
      call += 1;
      return Promise.resolve({ code: codes[i], stdout: stdouts[i], stderr: '' });
    });

    const result = await runVerification({
      skipWindowOpen: true,
      spawnPromptCli,
      sessionId: 'verify-mixed',
    });

    expect(result.prompts.map((p) => p.decision)).toEqual(['pass', 'fail', 'pass', 'pass']);
    expect(result.prompts[1].gates).toEqual(['violation:visible_posture_label']);
    expect(result.all_pass).toBe(false);
  });

  test('runVerification surfaces window-open results from the app-control call', async () => {
    const spawnAppOpen = jest.fn(() => Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ success: true, action: 'open-mira-lab', status: 'opened', windowKey: 'mira-lab' }),
      stderr: '',
    }));
    const spawnPromptCli = jest.fn(() => Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ reply: { text: 'reply', source: 'm' } }),
      stderr: '',
    }));

    const result = await runVerification({
      sessionId: 'verify-window',
      spawnAppOpen,
      spawnPromptCli,
    });

    expect(spawnAppOpen).toHaveBeenCalledTimes(1);
    expect(result.renderer_window_open).toEqual(expect.objectContaining({
      attempted: true,
      ok: true,
      status: 'opened',
    }));
    expect(result.proof_classification.renderer_proof_via_ipc).toBe(false);
  });

  test('hm-app normalizeCommand routes Mira Lab aliases to open-mira-lab', () => {
    expect(normalizeCommand('open-mira-lab')).toBe('open-mira-lab');
    expect(normalizeCommand('mira-lab')).toBe('open-mira-lab');
    expect(normalizeCommand('open-mira')).toBe('open-mira-lab');
    expect(normalizeCommand('mira-lab-open')).toBe('open-mira-lab');
  });
});
