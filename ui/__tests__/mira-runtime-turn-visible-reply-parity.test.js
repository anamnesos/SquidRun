'use strict';

/* global beforeAll, describe, expect, test */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
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
  const compiledTurnJournalPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'turn-journal.js');
  const compiledTurnJournalUrl = pathToFileURL(compiledTurnJournalPath).href;

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

  function runRuntimeSnippet(source, env = {}) {
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
        ...env,
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
    expect(result.audit).toEqual(expect.objectContaining({
      schema: 'mira.runtime_held_reply_audit.v0',
      checked: true,
      held: true,
      reason: 'visible_reply_gate_violation',
      gateSource: 'mira_runtime_visible_reply_gate_v0',
      visibleContentReplaced: true,
      journalStoresHeldReply: true,
      journalStoresRejectedText: false,
      diagnosticsVisible: false,
      externalSend: false,
      toolsExecuted: false,
    }));
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
    expect(result.heldReplyAudit).toEqual({
      schema: 'mira.runtime_held_reply_audit.v0',
      checked: true,
      held: false,
      reason: null,
      gateSource: 'mira_runtime_visible_reply_gate_v0',
      violationCount: 0,
      visibleContentReplaced: false,
      journalStoresHeldReply: false,
      journalStoresRejectedText: false,
      diagnosticsVisible: false,
      externalSend: false,
      toolsExecuted: false,
    });
    expect(evaluateMiraVisibleReply(result.response.content).ok).toBe(true);
    expect(visibleReplyLeakageViolation(result.response.content)).toBe(null);
  });

  test('records held reply audit metadata in the runtime journal without rejected generated text', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-held-audit-'));
    const rejectedGeneratedText = 'The validation fixture and proof scaffolding show the route owner protocol.';

    try {
      const result = runRuntimeSnippet(`
        import { applyRuntimeVisibleReplyGate } from ${JSON.stringify(compiledTurnUrl)};
        import { appendRuntimeTurnJournal, listRuntimeTurnJournal } from ${JSON.stringify(compiledTurnJournalUrl)};

        const held = applyRuntimeVisibleReplyGate(${JSON.stringify(rejectedGeneratedText)});
        const response = {
          input: {
            text: 'safe local prompt',
            sessionId: 'app-session-held-audit',
          },
          modelInvoked: false,
          model: {
            requested: false,
            provider: null,
            model: null,
            responseId: null,
            toolsEnabled: false,
            sendsEnabled: false,
            store: false,
          },
          voiceLab: null,
          response: {
            role: 'mira',
            content: held.content,
          },
          visibleReplyGate: held.gate,
          heldReplyAudit: held.audit,
          state: {
            stateRootReady: true,
            continuityLoaded: false,
            liveDataImported: false,
            acceptanceContinuityLoaded: false,
            acceptanceDocumentCount: 0,
            normalizedCoreLoaded: false,
            normalizedCoreDocumentCount: 0,
          },
        };
        const journal = appendRuntimeTurnJournal({
          turnInput: {
            text: 'safe local prompt',
            sessionId: 'app-session-held-audit',
          },
          startedAt: Date.now(),
          response,
          now: new Date('2026-05-20T00:00:00.000Z'),
        });
        const listed = listRuntimeTurnJournal({ limit: 1 });
        console.log(JSON.stringify({ held, journal, listed }));
      `, { MIRA_STATE_ROOT: stateRoot });

      expect(result.held.gate).toEqual(expect.objectContaining({
        ok: false,
        held: true,
      }));
      expect(result.held.gate.violations).toContain('backstage_label');
      expect(result.held.content).not.toContain('validation fixture');
      expect(result.held.content).not.toContain('proof scaffolding');
      expect(result.held.content).not.toContain('route owner protocol');

      expect(result.journal).toEqual(expect.objectContaining({
        ok: true,
        written: true,
        reason: null,
      }));
      const record = result.journal.record;
      expect(record).toEqual(expect.objectContaining({
        schema: 'mira.runtime_turn_journal.v0',
        outcome: 'ok',
        prompt: 'safe local prompt',
        session_id: 'app-session-held-audit',
        model_invoked: false,
        external_send: false,
        tools_executed: false,
      }));
      expect(record.response).toEqual({
        role: 'mira',
        content: result.held.content,
      });
      expect(record.visible_reply_gate).toEqual(expect.objectContaining({
        checked: true,
        held: true,
        source: 'mira_runtime_visible_reply_gate_v0',
      }));
      expect(record.visible_reply_gate.violations).toContain('backstage_label');
      expect(record.held_reply_audit).toEqual(expect.objectContaining({
        schema: 'mira.runtime_held_reply_audit.v0',
        checked: true,
        held: true,
        reason: 'visible_reply_gate_violation',
        violationCount: result.held.gate.violations.length,
        visibleContentReplaced: true,
        journalStoresHeldReply: true,
        journalStoresRejectedText: false,
        diagnosticsVisible: false,
        externalSend: false,
        toolsExecuted: false,
      }));
      expect(result.listed).toEqual(expect.objectContaining({
        ok: true,
        protocol: 'mira.runtime_turn_journal_list.v0',
        count: 1,
        external_send: false,
        tools_executed: false,
      }));
      expect(result.listed.records[0].id).toBe(record.id);

      const serializedRecord = JSON.stringify(record);
      expect(serializedRecord).not.toContain('validation fixture');
      expect(serializedRecord).not.toContain('proof scaffolding');
      expect(serializedRecord).not.toContain('route owner protocol');
      expect(evaluateMiraVisibleReply(record.response.content).ok).toBe(true);
      expect(visibleReplyLeakageViolation(record.response.content)).toBe(null);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
