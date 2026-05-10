'use strict';

const {
  DEFAULT_PROMPTS,
  PROOF_NOTE,
  SCHEMA,
  WINDOWS_LIBUV_TEARDOWN_EXIT_CODE,
  classifyBootstrap,
  decisionFromEnvelope,
  decisionFromExitCode,
  isWindowsTeardownAssertion,
  parseEnvelope,
  pickGates,
  pickReasonClass,
  pickReplyText,
  pickReplySource,
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

  test('decisionFromEnvelope is authoritative when present, normalises case, ignores junk values', () => {
    expect(decisionFromEnvelope({ decision: 'pass' })).toBe('pass');
    expect(decisionFromEnvelope({ decision: 'BLOCKED' })).toBe('blocked');
    expect(decisionFromEnvelope({ decision: '  fail  ' })).toBe('fail');
    expect(decisionFromEnvelope({ decision: 'banana' })).toBe(null);
    expect(decisionFromEnvelope({})).toBe(null);
    expect(decisionFromEnvelope(null)).toBe(null);
  });

  test('isWindowsTeardownAssertion detects the libuv async.c assertion by exit code or stderr', () => {
    expect(isWindowsTeardownAssertion(WINDOWS_LIBUV_TEARDOWN_EXIT_CODE, '')).toBe(true);
    expect(isWindowsTeardownAssertion(0, 'Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\\\win\\\\async.c, line 76')).toBe(true);
    expect(isWindowsTeardownAssertion(1, 'random failure')).toBe(false);
    expect(isWindowsTeardownAssertion(0, '')).toBe(false);
  });

  test('runVerification trusts envelope decision over a Windows libuv teardown exit code', async () => {
    const goodEnvelope = JSON.stringify({
      decision: 'pass',
      reply: { text: 'Got it.', source: 'mira_text_model_attachment_v1' },
      gates: { reason_class: null },
    });
    const spawnPromptCli = jest.fn(() => Promise.resolve({
      code: WINDOWS_LIBUV_TEARDOWN_EXIT_CODE,
      stdout: goodEnvelope,
      stderr: 'Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\\\win\\\\async.c, line 76',
    }));

    const result = await runVerification({
      skipWindowOpen: true,
      spawnPromptCli,
      sessionId: 'verify-windows-teardown',
    });

    expect(result.prompts.every((entry) => entry.decision === 'pass')).toBe(true);
    expect(result.prompts.every((entry) => entry.decision_source === 'envelope')).toBe(true);
    expect(result.prompts.every((entry) => entry.windows_libuv_teardown_observed === true)).toBe(true);
    expect(result.all_pass).toBe(true);
  });

  test('runVerification surfaces a blocked-empty-reply envelope as a real acceptance failure', async () => {
    const blockedEnvelope = JSON.stringify({
      decision: 'blocked',
      reply: { text: null, source: null },
      gates: { reason_class: 'reply_engine_degraded', language_gate: 'empty_reply' },
    });
    const okEnvelope = JSON.stringify({
      decision: 'pass',
      reply: { text: 'fine', source: 'mira_text_model_attachment_v1' },
    });
    const stdouts = [okEnvelope, okEnvelope, okEnvelope, blockedEnvelope];
    const codes = [0, 0, 0, 4];
    let call = 0;
    const spawnPromptCli = jest.fn(() => {
      const i = call;
      call += 1;
      return Promise.resolve({ code: codes[i], stdout: stdouts[i], stderr: '' });
    });

    const result = await runVerification({
      skipWindowOpen: true,
      spawnPromptCli,
      sessionId: 'verify-blocked',
    });

    const blocked = result.prompts.find((entry) => entry.decision === 'blocked');
    expect(blocked).toBeDefined();
    expect(blocked.visible_reply).toBeNull();
    expect(blocked.reason_class).toBe('reply_engine_degraded');
    expect(blocked.gates).toEqual(expect.objectContaining({
      reason_class: 'reply_engine_degraded',
      language_gate: 'empty_reply',
    }));
    expect(result.all_pass).toBe(false);
  });

  test('classifyBootstrap maps unknown_action to action_not_loaded_in_running_main and sets a clear note', async () => {
    expect(classifyBootstrap({ attempted: false })).toBe('not_attempted');
    expect(classifyBootstrap({ attempted: true, ok: true })).toBe('ready');
    expect(classifyBootstrap({ attempted: true, ok: false, reason: 'unknown_action' }))
      .toBe('action_not_loaded_in_running_main');
    expect(classifyBootstrap({ attempted: true, ok: false, reason: 'app_control_exit_1' }))
      .toBe('app_control_unreachable');
    expect(classifyBootstrap({ attempted: true, ok: false, reason: 'open_window_failed' }))
      .toBe('open_failed');

    const spawnAppOpen = jest.fn(() => Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ success: false, action: 'open-mira-lab', reason: 'unknown_action' }),
      stderr: '',
    }));
    const spawnPromptCli = jest.fn(() => Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ decision: 'pass', reply: { text: 'ok', source: 'm' } }),
      stderr: '',
    }));

    const result = await runVerification({
      sessionId: 'verify-bootstrap',
      spawnAppOpen,
      spawnPromptCli,
    });

    expect(result.bootstrap_status).toBe('action_not_loaded_in_running_main');
    expect(result.bootstrap_note).toMatch(/one-time bootstrap limitation/i);
    expect(result.proof_classification.renderer_proof_via_ipc).toBe(false);
  });

  test('pickReasonClass walks flat and nested envelope shapes', () => {
    expect(pickReasonClass({ gates: { reason_class: 'language_gate' } })).toBe('language_gate');
    expect(pickReasonClass({ decision: { gates: { reason_class: 'engine' } } })).toBe('engine');
    expect(pickReasonClass({})).toBe(null);
  });

  test('runVerification persists a bootstrap state file derived from the result', async () => {
    const writeBootstrapState = jest.fn(() => ({ ok: true }));
    const spawnAppOpen = jest.fn(() => Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ success: true, action: 'open-mira-lab', status: 'opened', windowKey: 'mira-lab' }),
      stderr: '',
    }));
    const spawnPromptCli = jest.fn(() => Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ decision: 'pass', reply: { text: 'ok', source: 'm' } }),
      stderr: '',
    }));

    const result = await runVerification({
      sessionId: 'verify-state-write',
      spawnAppOpen,
      spawnPromptCli,
      writeBootstrapState,
    });

    expect(writeBootstrapState).toHaveBeenCalledTimes(1);
    const [derivedState] = writeBootstrapState.mock.calls[0];
    expect(derivedState).toEqual(expect.objectContaining({
      bootstrap_status: 'ready',
      prompt_path_status: 'complete',
    }));
    expect(derivedState.last_run.all_pass).toBe(true);
    expect(derivedState.last_run.renderer_window_open_ok).toBe(true);
    expect(result.bootstrap_status).toBe('ready');
  });

  test('runVerification keeps bootstrap_status non-ready when prompt-path fails even if window-open succeeded', async () => {
    const writeBootstrapState = jest.fn(() => ({ ok: true }));
    const spawnAppOpen = jest.fn(() => Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ success: true, action: 'open-mira-lab', status: 'opened' }),
      stderr: '',
    }));
    const stdouts = [
      JSON.stringify({ decision: 'pass', reply: { text: 'ok' } }),
      JSON.stringify({ decision: 'blocked', reply: { text: null }, gates: { reason_class: 'reply_engine_degraded' } }),
      JSON.stringify({ decision: 'pass', reply: { text: 'ok' } }),
      JSON.stringify({ decision: 'pass', reply: { text: 'ok' } }),
    ];
    const codes = [0, 4, 0, 0];
    let call = 0;
    const spawnPromptCli = jest.fn(() => {
      const i = call;
      call += 1;
      return Promise.resolve({ code: codes[i], stdout: stdouts[i], stderr: '' });
    });

    const result = await runVerification({
      sessionId: 'verify-mixed',
      spawnAppOpen,
      spawnPromptCli,
      writeBootstrapState,
    });

    expect(result.bootstrap_status).not.toBe('ready');
    expect(result.all_pass).toBe(false);
    const [derivedState] = writeBootstrapState.mock.calls[0];
    expect(derivedState.prompt_path_status).toBe('incomplete');
  });

  test('runVerification can opt out of state persistence with persistState:false', async () => {
    const writeBootstrapState = jest.fn(() => ({ ok: true }));
    const spawnPromptCli = jest.fn(() => Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ decision: 'pass', reply: { text: 'ok' } }),
      stderr: '',
    }));
    await runVerification({
      sessionId: 'verify-no-persist',
      skipWindowOpen: true,
      spawnPromptCli,
      writeBootstrapState,
      persistState: false,
    });
    expect(writeBootstrapState).not.toHaveBeenCalled();
  });
});
