'use strict';

/* global beforeAll, describe, expect, test */

const { execFileSync } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const { evaluateMiraVisibleReply } = require('../modules/mira-core/mira-language-rules-v0');
const { visibleReplyLeakageViolation } = require('../modules/mira-core/local-text-session-v0');

describe('New Mira runtime turn visible reply parity', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const runtimeTsconfig = path.join(repoRoot, 'mira', 'runtime', 'tsconfig.json');
  const tscBin = path.join(repoRoot, 'ui', 'node_modules', 'typescript', 'bin', 'tsc');
  const compiledTurnPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'turn.js');
  const compiledTurnUrl = pathToFileURL(compiledTurnPath).href;

  beforeAll(() => {
    execFileSync(process.execPath, [
      tscBin,
      '-p',
      runtimeTsconfig,
    ], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  });

  function runRuntimeSnippet(source) {
    return JSON.parse(execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      source,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        MIRA_STATE_ROOT: '',
        OPENAI_API_KEY: '',
        MIRA_RUNTIME_OPENAI_API_KEY: '',
        MIRA_RUNTIME_MODEL_PROVIDER: '',
      },
    }));
  }

  test.each([
    ['I understand. The local turn is ready.', 'preamble'],
    ['Here is the local runtime answer.', 'preamble'],
    ['To be clear, the runtime has this handled.', 'assistant_shape'],
    ['If you want, I can keep going from here.', 'assistant_shape'],
  ])('matches the current Mira language gate for %s', (text, expectedViolation) => {
    const currentGate = evaluateMiraVisibleReply(text);
    const runtimeGate = runRuntimeSnippet(`
      import { evaluateRuntimeVisibleReply } from ${JSON.stringify(compiledTurnUrl)};
      console.log(JSON.stringify(evaluateRuntimeVisibleReply(${JSON.stringify(text)})));
    `);

    expect(currentGate.ok).toBe(false);
    expect(currentGate.violations).toContain(expectedViolation);
    expect(runtimeGate).toEqual(expect.objectContaining({
      ok: false,
      checked: true,
      held: true,
      source: 'mira_runtime_visible_reply_gate_v0',
    }));
    expect(runtimeGate.violations).toContain(expectedViolation);
  });

  test('holds backstage proof labels without leaking diagnostics into visible content', () => {
    const leakyText = 'The validation fixture and proof scaffolding show the mira.runtime_turn protocol is safe.';
    const result = runRuntimeSnippet(`
      import { applyRuntimeVisibleReplyGate } from ${JSON.stringify(compiledTurnUrl)};
      console.log(JSON.stringify(applyRuntimeVisibleReplyGate(${JSON.stringify(leakyText)})));
    `);

    expect(visibleReplyLeakageViolation(leakyText)).toBe('visible_rule_recitation');
    expect(result.gate).toEqual(expect.objectContaining({
      ok: false,
      held: true,
    }));
    expect(result.gate.violations).toContain('backstage_label');
    expect(result.content).not.toContain('validation fixture');
    expect(result.content).not.toContain('proof scaffolding');
    expect(result.content).not.toContain('mira.runtime_turn');
    expect(result.content).not.toContain('backstage_label');
    expect(evaluateMiraVisibleReply(result.content).ok).toBe(true);
    expect(visibleReplyLeakageViolation(result.content)).toBe(null);
  });

  test('keeps deterministic New Mira turn text gated without model, route, send, or runtime server', () => {
    const result = runRuntimeSnippet(`
      import { runRuntimeTurn } from ${JSON.stringify(compiledTurnUrl)};
      const result = await runRuntimeTurn({
        text: 'who are you',
        sessionId: 'app-session-parity',
        useModel: false,
      });
      console.log(JSON.stringify(result));
    `);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_turn.v0',
      runtimeExecutes: false,
      modelInvoked: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
    }));
    expect(result.model).toEqual(expect.objectContaining({
      requested: false,
      toolsEnabled: false,
      sendsEnabled: false,
      store: false,
    }));
    expect(result.response).toEqual({
      role: 'mira',
      content: 'Mira.',
    });
    expect(result.visibleReplyGate).toEqual({
      ok: true,
      checked: true,
      held: false,
      violations: [],
      source: 'mira_runtime_visible_reply_gate_v0',
    });
    expect(evaluateMiraVisibleReply(result.response.content).ok).toBe(true);
    expect(visibleReplyLeakageViolation(result.response.content)).toBe(null);
  });
});
