'use strict';

const {
  DEFAULT_MIRA_LIVE_SESSION_ID,
  MIRA_LIVE_PROMPT_REPLY_CHANNEL,
  buildMiraLivePromptPayload,
  classifyMiraLiveResult,
  normalizeMiraLiveSessionId,
  sendMiraLivePrompt,
} = require('../modules/mira-live-entrypoint');

describe('Mira live entrypoint', () => {
  test('builds the command-bar payload for the gated Mira Lab reply channel', () => {
    expect(normalizeMiraLiveSessionId('Session 369')).toBe('app-session-369');
    expect(normalizeMiraLiveSessionId('  app-session-369:mira-lab  ')).toBe('app-session-369:mira-lab');
    expect(normalizeMiraLiveSessionId('not a session')).toBe(DEFAULT_MIRA_LIVE_SESSION_ID);

    expect(buildMiraLivePromptPayload({
      prompt: 'what are we doing with Mira?',
      sessionId: 'Session 369',
      source: 'telegram-mira-live',
    })).toEqual({
      sessionId: 'app-session-369',
      prompt: 'what are we doing with Mira?',
      speakerRole: 'james',
      requesterPane: null,
      source: 'telegram-mira-live',
    });
  });

  test('sends command-bar text through mira:lab-prompt-reply and returns the visible reply', async () => {
    const invoke = jest.fn().mockResolvedValue({
      decision: 'pass',
      visible_render_hint: {
        kind: 'clean_reply',
        text: 'Mira is on the live path now.',
      },
    });

    const result = await sendMiraLivePrompt({
      prompt: 'status',
      sessionId: 'Session 369',
    }, { invoke });

    expect(invoke).toHaveBeenCalledWith(MIRA_LIVE_PROMPT_REPLY_CHANNEL, {
      sessionId: 'app-session-369',
      prompt: 'status',
      speakerRole: 'james',
      requesterPane: null,
      source: 'main-command-bar-mira-live',
    });
    expect(result.ok).toBe(true);
    expect(result.state).toBe('ready');
    expect(result.message).toBe('Mira is on the live path now.');
  });

  test('keeps blocked gate diagnostics out of the main command-bar surface', () => {
    const result = classifyMiraLiveResult({
      decision: 'blocked',
      language_gate: {
        ok: false,
        violations: ['preamble'],
        reason_class: 'gate_annotation',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.state).toBe('held');
    expect(result.message).toBe('Mira held that reply. Open Mira Lab for diagnostics.');
    expect(result.message).not.toMatch(/preamble|reason_class|gate_annotation/i);
  });

  test('reports unavailable when the prompt channel cannot be invoked', async () => {
    const result = await sendMiraLivePrompt({
      prompt: 'hello',
      sessionId: 'Session 369',
    }, {
      invoke: jest.fn().mockRejectedValue(new Error('ipc unavailable')),
    });

    expect(result.ok).toBe(false);
    expect(result.state).toBe('unavailable');
    expect(result.message).toBe('Mira is unavailable. Open Mira Lab for diagnostics.');
  });
});
