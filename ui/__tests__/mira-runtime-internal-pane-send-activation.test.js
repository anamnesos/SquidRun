'use strict';

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { compileMiraRuntime } = require('./helpers/mira-runtime-build');

describe('Mira Mission Control internal pane send activation seam', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const compiledServerPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'server.js');
  const compiledRoutePreviewPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'mission-control-route-preview.js');
  const compiledRoutePreviewUrl = pathToFileURL(compiledRoutePreviewPath).href;
  const activationPhrase = 'ACTIVATE_INTERNAL_PANE_SEND_CURRENT_SESSION';
  let serverProcess;
  let baseUrl;
  let tempStateRoot;

  beforeAll(() => {
    compileMiraRuntime(repoRoot);
  });

  afterEach(async () => {
    if (serverProcess) {
      const closing = new Promise((resolve) => {
        serverProcess.once('close', resolve);
      });
      serverProcess.kill();
      let timeoutId;
      const timeout = new Promise((resolve) => {
        timeoutId = setTimeout(resolve, 1000);
      });
      await Promise.race([closing, timeout]);
      clearTimeout(timeoutId);
      serverProcess.stdout?.destroy();
      serverProcess.stderr?.destroy();
      serverProcess.removeAllListeners();
      serverProcess = null;
      baseUrl = null;
    }
    if (tempStateRoot) {
      fs.rmSync(tempStateRoot, { recursive: true, force: true });
      tempStateRoot = null;
    }
  });

  function startServer(extraEnv = {}) {
    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, [compiledServerPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          MIRA_RUNTIME_PORT: '0',
          MIRA_AUTONOMY_LOOP: 'off',
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stderr = '';
      const timeout = setTimeout(() => {
        reject(new Error(`runtime server did not start. stderr=${stderr}`));
      }, 5000);

      serverProcess.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      serverProcess.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      serverProcess.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (!match) return;
        clearTimeout(timeout);
        baseUrl = `http://127.0.0.1:${match[1]}`;
        resolve(baseUrl);
      });
    });
  }

  function runRuntimeSnippet(source) {
    return JSON.parse(execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      source,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    }));
  }

  function sha256Text(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  function liveGateToken(id) {
    return `mission-send-live-gate-${crypto.createHash('sha256')
      .update(`mira.mission_control_internal_send_live_activation_gate_contract.v0:${id}`)
      .digest('base64url')
      .slice(0, 18)}`;
  }

  function writeLiveGateContract(overrides = {}) {
    const id = overrides.id || 'mission-send-live-gate-fixture';
    const targetRole = overrides.targetRole || 'builder';
    const targetPaneId = overrides.targetPaneId || '2';
    const content = overrides.content || '(MIRA #1): exact internal pane send body';
    const bodySha256 = sha256Text(content);
    const adapterPacketSha256 = sha256Text(JSON.stringify({
      protocol: 'mira.hm_send_adapter.v0',
      target: { role: targetRole, pane_id: targetPaneId },
      body: { content },
    }));
    const record = {
      protocol: 'mira.mission_control_internal_send_live_activation_gate_contract.v0',
      id,
      status: 'live_activation_gate_hard_stop',
      createdAt: '2026-05-22T00:00:00.000Z',
      sourceInternalSendActivationImplementationReadinessId: 'mission-send-activation-implementation-fixture',
      sourceInternalSendActivationImplementationReadinessToken: 'mission-send-activation-ready-fixture',
      sourceInternalSendActivationDecisionAuditId: 'mission-send-activation-audit-fixture',
      sourceInternalSendActivationDecisionAuditToken: 'mission-send-activation-audit-fixture',
      sourceInternalSendActivationRequestId: 'mission-send-activation-request-fixture',
      sourceInternalSendActivationRequestToken: 'mission-send-activation-request-fixture',
      sourceInternalSendActivationDesignId: 'mission-send-activation-design-fixture',
      sourceInternalSendActivationDesignToken: 'mission-send-activation-design-fixture',
      sourceInternalSendDryRunId: 'mission-send-dry-run-fixture',
      sourceInternalSendDryRunToken: 'mission-send-dry-run-fixture',
      sourceDispatchReadinessId: 'mission-dispatch-readiness-fixture',
      sourceDispatchReadinessToken: 'mission-dispatch-readiness-fixture',
      sourceDeliveryPreviewId: 'mission-delivery-preview-fixture',
      sourceDeliveryPreviewToken: 'mission-delivery-preview-fixture',
      sourceRecommendationId: 'mission-follow-through-fixture',
      sourceContinuationId: 'mission-owned-work-continuation-fixture',
      sourceRequestId: 'mission-route-request-fixture',
      sourcePreviewId: 'mission-route-preview-fixture',
      targetRole,
      targetPaneId,
      targetLabel: `${targetRole} pane ${targetPaneId}`,
      purpose: 'mocked internal pane send proof',
      content,
      contentPreview: content,
      missionAnswerPreview: 'Project/lane: squidrun / architect#20. JAMES ACTION: NONE.',
      bodySha256,
      adapterPacketSha256,
      hardStop: {
        protocol: 'mira.mission_control_internal_send_live_activation_hard_stop.v0',
        contractOnly: true,
        liveActivationAllowed: false,
        liveHmSendExecutionAllowed: false,
        realSendAllowed: false,
        implementationEnabled: false,
        separateActivationLaneRequired: true,
        jamesSetupRequiredBeforeLiveSend: true,
      },
      jamesRequirements: [],
      setupRequirements: [],
      rollbackRequirements: [],
      audit: {
        reviewStatus: 'live_activation_gate_contract_ready',
        contractOnly: true,
        hardStop: true,
        manualExecutionRequired: true,
        sourceImplementationReadinessChecksumMatched: true,
        notSent: true,
        commandStored: false,
        sendPerformed: false,
        runtimeExecutes: false,
        externalSend: false,
        telegramSend: false,
        routeFlip: false,
        providerInvoked: false,
        accountOrTokenAccess: false,
        liveHmSend: false,
      },
      manualExecutionRequired: true,
      reviewRequired: true,
      internalOnly: true,
      reviewableOwnedWork: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    };
    const dir = path.join(tempStateRoot, 'mission-control', 'internal-send-live-activation-gate-contracts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return {
      record,
      token: liveGateToken(id),
    };
  }

  function activationPayload(fixture, overrides = {}) {
    const currentSessionId = overrides.currentSessionId || 'app-session-378';
    const requestedByRole = overrides.requestedByRole || 'builder';
    const activationReason = overrides.activationReason || 'current-session internal pane send proof';
    const targetRole = overrides.targetRole || fixture.record.targetRole;
    const targetPaneId = overrides.targetPaneId || fixture.record.targetPaneId;
    const content = Object.prototype.hasOwnProperty.call(overrides, 'content')
      ? overrides.content
      : fixture.record.content;
    const bodySha256 = overrides.bodySha256 || fixture.record.bodySha256;
    const adapterPacketSha256 = overrides.adapterPacketSha256 || fixture.record.adapterPacketSha256;
    const confirmationSha256 = sha256Text([
      currentSessionId,
      requestedByRole,
      activationPhrase,
      activationReason,
      fixture.token,
      targetRole,
      targetPaneId,
      bodySha256,
      adapterPacketSha256,
    ].join('\n'));
    return {
      internalSendLiveActivationGateContractToken: fixture.token,
      targetRole,
      targetPaneId,
      content,
      bodySha256,
      adapterPacketSha256,
      currentSessionActivation: true,
      activationPhrase,
      currentSessionId,
      requestedByRole,
      activationReason,
      confirmationSha256,
      ...overrides.extra,
    };
  }

  function countAttemptFiles() {
    const dir = path.join(tempStateRoot, 'mission-control', 'internal-pane-send-activation-attempts');
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((file) => file.endsWith('.json')).length;
  }

  test('POST endpoint writes an audited no-send attempt by default', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-internal-pane-send-endpoint-'));
    await startServer({ MIRA_STATE_ROOT: tempStateRoot });
    const fixture = writeLiveGateContract();

    const response = await fetch(`${baseUrl}/mission-control/internal-pane-send-activation-attempts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(activationPayload(fixture)),
    });
    const payload = await response.json();
    const listResponse = await fetch(`${baseUrl}/mission-control/internal-pane-send-activation-attempts?includeInternal=1`);
    const listPayload = await listResponse.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_pane_send_activation_attempt_write.v0',
      created: true,
      adapterCalled: false,
      sendPerformed: false,
      relativePath: expect.stringMatching(/^mission-control\/internal-pane-send-activation-attempts\/mission-pane-send-attempt-.*\.json$/),
      commandStored: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    }));
    expect(payload.attempt).toEqual(expect.objectContaining({
      status: 'adapter_not_configured',
      sourceLiveActivationGateContractToken: fixture.token,
      targetRole: 'builder',
      targetPaneId: '2',
      content: fixture.record.content,
      bodySha256: fixture.record.bodySha256,
      adapterPacketSha256: fixture.record.adapterPacketSha256,
      sendPerformed: false,
      runtimeExecutes: false,
      liveHmSend: false,
    }));
    expect(payload.attempt.preActivationAudit).toEqual(expect.objectContaining({
      status: 'validated_before_adapter_call',
      sourceArtifactValidated: true,
      targetRoleMatched: true,
      targetPaneMatched: true,
      bodyChecksumMatched: true,
      adapterPacketChecksumMatched: true,
      currentSessionActivationInputMatched: true,
      noFallbackRequired: true,
    }));
    expect(payload.attempt.postAttemptAudit).toEqual(expect.objectContaining({
      status: 'adapter_not_configured',
      recordedAfterAdapterAttempt: true,
      adapterCalled: false,
      outcome: 'not_configured',
      noFallback: true,
    }));
    expect(payload.attempt.adapterRequest).toEqual(expect.objectContaining({
      targetRole: 'builder',
      targetPaneId: '2',
      content: fixture.record.content,
      noFallback: true,
      channel: 'hm-send',
      transport: 'ui/scripts/hm-send.js',
    }));
    expect(payload.attempt).not.toHaveProperty('command');
    expect(payload.attempt).not.toHaveProperty('args');
    expect(fs.existsSync(payload.absolutePath)).toBe(true);
    expect(listResponse.status).toBe(200);
    expect(listPayload).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.mission_control_internal_pane_send_activation_attempt_list.v0',
      attemptCount: 1,
      sendPerformed: false,
      runtimeExecutes: false,
      liveHmSend: false,
    }));
  });

  test('direct writer calls the mocked adapter only after validation and records success/failure outcomes', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-internal-pane-send-mock-'));
    const fixture = writeLiveGateContract();
    const successInput = activationPayload(fixture);
    const success = runRuntimeSnippet(`
      import { createMissionControlInternalPaneSendActivationAttempt } from ${JSON.stringify(compiledRoutePreviewUrl)};
      const calls = [];
      const result = createMissionControlInternalPaneSendActivationAttempt(
        ${JSON.stringify(successInput)},
        { MIRA_STATE_ROOT: ${JSON.stringify(tempStateRoot)} },
        { hmSendAdapter: (request) => {
          calls.push(request);
          return {
            ok: true,
            status: 'hm_send_completed',
            exitCode: 0,
            stdout: 'Delivered to builder',
            stderr: '',
            signal: null
          };
        } }
      );
      console.log(JSON.stringify({ result, calls }));
    `);

    expect(success.calls).toHaveLength(1);
    expect(success.calls[0]).toEqual(expect.objectContaining({
      protocol: 'mira.mission_control_internal_pane_send_activation_adapter_request.v0',
      sourceLiveActivationGateContractToken: fixture.token,
      targetRole: 'builder',
      targetPaneId: '2',
      content: fixture.record.content,
      bodySha256: fixture.record.bodySha256,
      adapterPacketSha256: fixture.record.adapterPacketSha256,
      noFallback: true,
    }));
    expect(success.result.attempt.postAttemptAudit).toEqual(expect.objectContaining({
      status: 'adapter_call_succeeded',
      recordedAfterAdapterAttempt: true,
      adapterCalled: true,
      outcome: 'success',
      exitCode: 0,
      stdoutPreview: 'Delivered to builder',
      noFallback: true,
    }));
    expect(success.result.attempt.sendPerformed).toBe(true);
    expect(success.result.attempt.runtimeExecutes).toBe(true);
    expect(success.result.attempt.liveHmSend).toBe(true);

    const failureInput = activationPayload(fixture, { activationReason: 'current-session internal pane send failure proof' });
    const failure = runRuntimeSnippet(`
      import { createMissionControlInternalPaneSendActivationAttempt } from ${JSON.stringify(compiledRoutePreviewUrl)};
      const calls = [];
      const result = createMissionControlInternalPaneSendActivationAttempt(
        ${JSON.stringify(failureInput)},
        { MIRA_STATE_ROOT: ${JSON.stringify(tempStateRoot)} },
        { hmSendAdapter: (request) => {
          calls.push(request);
          return {
            ok: false,
            status: 'hm_send_failed',
            exitCode: 1,
            stdout: '',
            stderr: 'hm-send refused',
            signal: null,
            error: 'hm-send refused'
          };
        } }
      );
      console.log(JSON.stringify({ result, calls }));
    `);

    expect(failure.calls).toHaveLength(1);
    expect(failure.result.attempt.postAttemptAudit).toEqual(expect.objectContaining({
      status: 'adapter_call_failed',
      recordedAfterAdapterAttempt: true,
      adapterCalled: true,
      outcome: 'failure',
      exitCode: 1,
      stderrPreview: 'hm-send refused',
      error: 'hm-send refused',
      noFallback: true,
    }));
    expect(failure.result.attempt.sendPerformed).toBe(false);
    expect(failure.result.attempt.runtimeExecutes).toBe(true);
    expect(failure.result.attempt.liveHmSend).toBe(true);
  });

  test.each([
    ['architect', '1'],
    ['builder', '2'],
    ['oracle', '3'],
  ])('accepts exact %s live-gate artifacts with no default adapter call', (targetRole, targetPaneId) => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), `mira-internal-pane-send-${targetRole}-`));
    const fixture = writeLiveGateContract({
      id: `mission-send-live-gate-${targetRole}-fixture`,
      targetRole,
      targetPaneId,
      content: `(MIRA #1): exact internal pane send body for ${targetRole}`,
    });
    const result = runRuntimeSnippet(`
      import { createMissionControlInternalPaneSendActivationAttempt } from ${JSON.stringify(compiledRoutePreviewUrl)};
      const output = createMissionControlInternalPaneSendActivationAttempt(
        ${JSON.stringify(activationPayload(fixture))},
        { MIRA_STATE_ROOT: ${JSON.stringify(tempStateRoot)} }
      );
      console.log(JSON.stringify(output));
    `);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      adapterCalled: false,
      sendPerformed: false,
      runtimeExecutes: false,
      liveHmSend: false,
    }));
    expect(result.attempt).toEqual(expect.objectContaining({
      targetRole,
      targetPaneId,
      status: 'adapter_not_configured',
      sourceLiveActivationGateContractToken: fixture.token,
      bodySha256: fixture.record.bodySha256,
      adapterPacketSha256: fixture.record.adapterPacketSha256,
    }));
  });

  test('refuses target drift, checksum drift, command injection, fallback, and external targets before adapter call', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-internal-pane-send-refuse-'));
    const fixture = writeLiveGateContract();
    const cases = [
      [activationPayload(fixture, { targetRole: 'telegram' }), 'mission_control_internal_pane_send_activation_attempt_external_target_refused'],
      [activationPayload(fixture, { targetRole: 'user' }), 'mission_control_internal_pane_send_activation_attempt_external_target_refused'],
      [activationPayload(fixture, { targetRole: 'external' }), 'mission_control_internal_pane_send_activation_attempt_external_target_refused'],
      [activationPayload(fixture, { targetRole: '@device' }), 'mission_control_internal_pane_send_activation_attempt_external_target_refused'],
      [activationPayload(fixture, { targetRole: 'mira' }), 'mission_control_internal_pane_send_activation_attempt_external_target_refused'],
      [activationPayload(fixture, { targetRole: '1' }), 'mission_control_internal_pane_send_activation_attempt_invalid_pane_target'],
      [activationPayload(fixture, { targetRole: 'oracle' }), 'mission_control_internal_pane_send_activation_attempt_target_mismatch'],
      [activationPayload(fixture, { targetPaneId: '3' }), 'mission_control_internal_pane_send_activation_attempt_target_mismatch'],
      [activationPayload(fixture, { content: '(MIRA #1): rewritten body' }), 'mission_control_internal_pane_send_activation_attempt_body_mismatch'],
      [activationPayload(fixture, { bodySha256: 'bad-body-sha256' }), 'mission_control_internal_pane_send_activation_attempt_body_checksum_mismatch'],
      [activationPayload(fixture, { adapterPacketSha256: 'bad-adapter-sha256' }), 'mission_control_internal_pane_send_activation_attempt_adapter_checksum_mismatch'],
      [{ ...activationPayload(fixture), currentSessionActivation: false }, 'mission_control_internal_pane_send_activation_attempt_current_session_activation_required'],
      [{ ...activationPayload(fixture), activationPhrase: 'SEND_NOW' }, 'mission_control_internal_pane_send_activation_attempt_phrase_required'],
      [(() => {
        const payload = activationPayload(fixture);
        delete payload.confirmationSha256;
        return payload;
      })(), 'mission_control_internal_pane_send_activation_attempt_confirmation_required'],
      [activationPayload(fixture, { extra: { confirmationSha256: 'bad-confirmation-sha256' } }), 'mission_control_internal_pane_send_activation_attempt_confirmation_mismatch'],
      [activationPayload(fixture, { extra: { command: 'hm-send builder' } }), 'mission_control_internal_pane_send_activation_attempt_command_not_allowed'],
      [activationPayload(fixture, { extra: { args: ['hm-send', 'builder'] } }), 'mission_control_internal_pane_send_activation_attempt_command_not_allowed'],
      [activationPayload(fixture, { extra: { fallback: 'telegram' } }), 'mission_control_internal_pane_send_activation_attempt_command_not_allowed'],
      [activationPayload(fixture, { extra: { tradingTarget: true } }), 'mission_control_internal_pane_send_activation_attempt_has_forbidden_effect'],
    ];

    for (const [input, code] of cases) {
      const result = runRuntimeSnippet(`
        import { createMissionControlInternalPaneSendActivationAttempt } from ${JSON.stringify(compiledRoutePreviewUrl)};
        const calls = [];
        try {
          createMissionControlInternalPaneSendActivationAttempt(
            ${JSON.stringify(input)},
            { MIRA_STATE_ROOT: ${JSON.stringify(tempStateRoot)} },
            { hmSendAdapter: (request) => {
              calls.push(request);
              return { ok: true, status: 'hm_send_completed', exitCode: 0 };
            } }
          );
          console.log(JSON.stringify({ ok: true, calls }));
        } catch (error) {
          console.log(JSON.stringify({ ok: false, code: error.code, message: error.message, calls }));
        }
      `);
      expect(result).toEqual(expect.objectContaining({
        ok: false,
        code,
        calls: [],
      }));
      expect(countAttemptFiles()).toBe(0);
    }
  });

  test('revalidates an existing attempt against the current artifact and activation input before reuse', async () => {
    tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-internal-pane-send-drift-'));
    const fixture = writeLiveGateContract();
    const input = activationPayload(fixture);
    const first = runRuntimeSnippet(`
      import { createMissionControlInternalPaneSendActivationAttempt } from ${JSON.stringify(compiledRoutePreviewUrl)};
      const result = createMissionControlInternalPaneSendActivationAttempt(
        ${JSON.stringify(input)},
        { MIRA_STATE_ROOT: ${JSON.stringify(tempStateRoot)} }
      );
      console.log(JSON.stringify(result));
    `);
    const stored = JSON.parse(fs.readFileSync(first.absolutePath, 'utf8'));
    fs.writeFileSync(first.absolutePath, `${JSON.stringify({
      ...stored,
      bodySha256: 'bad-existing-body-sha256',
    }, null, 2)}\n`, 'utf8');
    const result = runRuntimeSnippet(`
      import { createMissionControlInternalPaneSendActivationAttempt } from ${JSON.stringify(compiledRoutePreviewUrl)};
      const calls = [];
      try {
        createMissionControlInternalPaneSendActivationAttempt(
          ${JSON.stringify(input)},
          { MIRA_STATE_ROOT: ${JSON.stringify(tempStateRoot)} },
          { hmSendAdapter: (request) => {
            calls.push(request);
            return { ok: true, status: 'hm_send_completed', exitCode: 0 };
          } }
        );
        console.log(JSON.stringify({ ok: true, calls }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, code: error.code, message: error.message, calls }));
      }
    `);

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      code: 'mission_control_internal_pane_send_activation_attempt_existing_record_mismatch',
      calls: [],
    }));
    expect(countAttemptFiles()).toBe(1);
  });
});
